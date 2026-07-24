"""
Acceptance tests for the Python grok_loop_kit package. Mirrors the TS suite:
a 20-turn loop compacts exactly at turn 8 and turn 16, plus verbatim-compaction,
tool round-trip, retry, and hook coverage.

Uses an injected `poster` that mimics the mock server, so tests are hermetic.
"""

import asyncio

from grok_loop_kit import AsyncGrokLoopClient, GrokLoopClient
from grok_loop_kit.client import _RetryableHTTP


def make_stream_poster(input_tokens=120, output_tokens=40):
    """A stream_poster yielding SSE-style event dicts, like the mock's stream mode."""
    state = {"responses": 0}

    def stream_poster(base_url, path, body, api_key, headers=None, timeout=None):
        assert path == "/responses"
        state["responses"] += 1
        turn = state["responses"]
        text = f"streamed reply #{turn}"
        full = {
            "id": f"resp_{turn}", "object": "response", "status": "completed",
            "model": body["model"],
            "output": [{"type": "message", "role": "assistant",
                        "content": [{"type": "output_text", "text": text}]}],
            "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens,
                      "total_tokens": input_tokens + output_tokens},
        }
        for i in range(0, len(text), 6):
            yield {"type": "response.output_text.delta", "delta": text[i:i + 6]}
        yield {"type": "response.completed", "response": full}

    return stream_poster, state


def make_mock_poster(input_tokens=120, output_tokens=40, compaction_array=False,
                     emit_tool_call=False, fail_first=0, scale=False,
                     emit_refusal=False, emit_reasoning=False):
    state = {"responses": 0, "compact": 0, "failed": 0, "to_fail": fail_first, "bodies": []}

    def poster(base_url, path, body, api_key, headers=None, timeout=None):
        assert api_key, "api_key forwarded"
        if state["to_fail"] > 0:
            state["to_fail"] -= 1
            state["failed"] += 1
            raise _RetryableHTTP(429, "0", "transient (mock)")

        if path == "/responses/compact":
            n = len(body["input"])
            state["compact"] += 1
            output = (
                [{"type": "compaction", "id": f"cmp_{state['compact']}",
                  "encrypted_content": f"enc({n})"}]
                if compaction_array
                else f"[COMPACTED: {n} turns condensed]"
            )
            return {
                "id": f"cmp_{state['compact']}",
                "object": "response.compaction",
                "model": body["model"],
                "output": output,
                # Doc semantics: input=pre-compaction tokens, output=compacted record.
                "usage": {"input_tokens": n * 50, "output_tokens": max(8, n // 2),
                          "dropped_message_count": n},
            }

        if path == "/responses":
            state["responses"] += 1
            state["bodies"].append(body)
            turn = state["responses"]
            last = body["input"][-1]
            if emit_tool_call and last.get("type") != "function_call_output":
                output = [{"type": "function_call", "id": f"fc_{turn}",
                           "call_id": f"call_{turn}", "name": "get_weather",
                           "arguments": '{"city":"Tokyo"}'}]
            elif emit_refusal:
                output = [{"type": "message", "role": "assistant",
                           "content": [{"type": "refusal", "refusal": "I cannot help with that."}]}]
            else:
                output = [{"type": "message", "role": "assistant",
                           "content": [{"type": "output_text", "text": f"reply #{turn}"}]}]
            if emit_reasoning:
                output = [{"type": "reasoning", "id": f"rs_{turn}", "summary": []}] + output
            in_tok = 60 * len(body["input"]) if scale else input_tokens
            out_tok = 30 if scale else output_tokens
            return {
                "id": f"resp_{turn}", "object": "response", "status": "completed",
                "model": body["model"], "output": output,
                "usage": {"input_tokens": in_tok, "output_tokens": out_tok,
                          "total_tokens": in_tok + out_tok},
            }
        raise AssertionError(f"unexpected path {path}")

    return poster, state


def test_20_turn_loop_compacts_at_8_and_16():
    poster, state = make_mock_poster()
    client = GrokLoopClient("test-key", poster=poster)
    compaction_after_turn = []
    for turn in range(1, 21):
        before = client.total_compactions
        res = client.send_message(f"user message {turn}")
        assert res["_grokLoopKit"].totalCompactions == client.total_compactions
        if client.total_compactions > before:
            compaction_after_turn.append(turn)
            assert len(client.messages) == 1
            assert res["_grokLoopKit"].turnsSinceCompact == 0
    assert compaction_after_turn == [8, 16], compaction_after_turn
    assert client.total_compactions == 2
    assert state["compact"] == 2
    assert state["responses"] == 20
    assert client.estimated_tokens_saved > 0
    print("OK: compacted at", compaction_after_turn)


def test_verbatim_compaction_items():
    poster, _ = make_mock_poster(compaction_array=True)
    client = GrokLoopClient("test-key", poster=poster)
    for i in range(1, 9):
        client.send_message(f"m{i}")
    assert client.messages == [
        {"type": "compaction", "id": "cmp_1", "encrypted_content": "enc(16)"}
    ], client.messages
    print("OK: verbatim compaction items")


def test_tool_round_trip():
    poster, _ = make_mock_poster(emit_tool_call=True)
    client = GrokLoopClient("test-key", poster=poster)
    tools = [{"type": "function", "function": {"name": "get_weather"}}]
    res = client.send_message("weather?", tools)
    calls = client.get_tool_calls(res.raw)
    assert len(calls) == 1 and calls[0]["name"] == "get_weather"
    assert any(m.get("type") == "function_call" for m in client.messages)
    client.send_tool_outputs([{"call_id": calls[0]["call_id"], "output": "18C sunny"}], tools)
    assert any(
        m.get("type") == "function_call_output" and m.get("output") == "18C sunny"
        for m in client.messages
    )
    assert client.turn_count == 2
    print("OK: tool round-trip")


def test_token_budget_triggers_compaction():
    # Context grows ~60 tokens/message; crosses a 250-token budget at turn 3.
    poster, _ = make_mock_poster(scale=True)
    client = GrokLoopClient("test-key", compact_at_tokens=250, poster=poster)
    client.send_message("t1")  # ~90 tok
    assert client.total_compactions == 0
    client.send_message("t2")  # ~210 tok
    assert client.total_compactions == 0
    client.send_message("t3")  # ~330 tok -> compact
    assert client.total_compactions == 1
    assert len(client.messages) == 1
    assert client.accumulated_tokens == 0
    print("OK: token budget path")


def test_retry_then_success():
    poster, state = make_mock_poster(fail_first=2)
    client = GrokLoopClient("test-key", retry_base_ms=1, poster=poster)
    res = client.send_message("hi")
    assert res.output
    assert state["failed"] == 2
    print("OK: retry then success")


def test_gives_up_after_max_retries():
    poster, _ = make_mock_poster(fail_first=5)
    client = GrokLoopClient("test-key", retry_base_ms=1, max_retries=1, poster=poster)
    try:
        client.send_message("hi")
        raise AssertionError("expected failure")
    except RuntimeError as e:
        assert "failed 429" in str(e)
    print("OK: gives up after max retries")


def test_on_compact_hook():
    events = []
    poster, _ = make_mock_poster()
    client = GrokLoopClient("test-key", on_compact=events.append, poster=poster)
    for i in range(1, 17):
        client.send_message(f"m{i}")
    assert len(events) == 2
    assert events[0].atTurn == 8 and events[1].atTurn == 16
    assert events[0].droppedMessageCount > 0
    print("OK: on_compact hook")


def test_stream_message():
    stream_poster, _ = make_stream_poster()
    client = GrokLoopClient("test-key", stream_poster=stream_poster)
    tokens = []
    res = client.stream_message("hi", on_token=tokens.append)
    joined = "".join(tokens)
    assert joined, "streamed some tokens"
    assert joined == res.output[0]["content"][0]["text"]
    assert client.turn_count == 1
    print("OK: sync stream_message")


def test_stream_compacts_on_schedule():
    stream_poster, _ = make_stream_poster()
    poster, _ = make_mock_poster()  # handles the /responses/compact call at turn 8
    client = GrokLoopClient("test-key", stream_poster=stream_poster, poster=poster)
    for i in range(1, 9):
        client.stream_message(f"m{i}")
    assert client.total_compactions == 1
    assert len(client.messages) == 1
    print("OK: streaming compacts on schedule")


def test_async_client():
    async def run():
        poster, state = make_mock_poster()
        client = AsyncGrokLoopClient("test-key", poster=poster)
        # Sequential turns; verify compaction cadence holds through the async facade.
        for i in range(1, 9):
            await client.send_message(f"m{i}")
        assert client.total_compactions == 1
        assert client.turn_count == 8
        assert len(client.messages) == 1

        # Async streaming.
        sp, _ = make_stream_poster()
        cp, _ = make_mock_poster()  # guard: never fall through to the real API
        sclient = AsyncGrokLoopClient("test-key", stream_poster=sp, poster=cp)
        tokens = []
        res = await sclient.stream_message("hi", on_token=tokens.append)
        assert "".join(tokens) == res.output[0]["content"][0]["text"]
        return True

    assert asyncio.run(run())
    print("OK: async client (send + stream)")


def test_refusal_surfaced():
    from grok_loop_kit import extract_assistant_text
    poster, _ = make_mock_poster(emit_refusal=True)
    client = GrokLoopClient("k", poster=poster)
    res = client.send_message("bad")
    assert extract_assistant_text(res.raw) == "I cannot help with that."
    print("OK: refusal surfaced")


def test_reasoning_preserved():
    poster, _ = make_mock_poster(emit_reasoning=True)
    client = GrokLoopClient("k", poster=poster)
    client.send_message("think")
    assert any(m.get("type") == "reasoning" for m in client.messages)
    print("OK: reasoning preserved")


def test_extra_body_merged():
    poster, state = make_mock_poster()
    client = GrokLoopClient("k", extra_body={"temperature": 0.3}, poster=poster)
    client.send_message("hi")
    assert state["bodies"][-1].get("temperature") == 0.3
    print("OK: extra_body merged")


def test_state_round_trip():
    poster, _ = make_mock_poster()
    client = GrokLoopClient("k", poster=poster)
    for i in range(5):
        client.send_message(f"m{i}")
    import json
    snapshot = json.loads(json.dumps(client.get_state()))

    poster2, _ = make_mock_poster()
    resumed = GrokLoopClient("k", poster=poster2)
    resumed.load_state(snapshot)
    assert resumed.turn_count == 5
    assert len(resumed.messages) == len(client.messages)
    resumed.send_message("m6")
    assert resumed.turn_count == 6
    print("OK: state round-trip")


def test_reset():
    poster, _ = make_mock_poster()
    client = GrokLoopClient("k", poster=poster)
    for i in range(3):
        client.send_message(f"m{i}")
    client.reset()
    assert client.turn_count == 0 and len(client.messages) == 0
    client.send_message("again")
    assert client.turn_count == 1
    print("OK: reset")


def test_import_surface():
    from grok_loop_kit import AsyncGrokLoopClient as AGLC  # noqa: F401
    from grok_loop_kit import GrokLoopClient as GLC  # noqa: F401
    assert GLC is GrokLoopClient and AGLC is AsyncGrokLoopClient
    print("OK: import surface")


if __name__ == "__main__":
    for fn in [
        test_import_surface,
        test_20_turn_loop_compacts_at_8_and_16,
        test_verbatim_compaction_items,
        test_tool_round_trip,
        test_token_budget_triggers_compaction,
        test_retry_then_success,
        test_gives_up_after_max_retries,
        test_on_compact_hook,
        test_stream_message,
        test_stream_compacts_on_schedule,
        test_async_client,
        test_refusal_surfaced,
        test_reasoning_preserved,
        test_extra_body_merged,
        test_state_round_trip,
        test_reset,
    ]:
        fn()
    print("\nAll Python acceptance tests passed.")
