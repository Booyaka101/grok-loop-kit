"""
LIVE smoke test against the real xAI API. THIS SPENDS MONEY (a few hundred
tokens, well under $0.01). Run it yourself with YOUR funded key:

    XAI_API_KEY=xai-...  python smoke_live.py

grok_loop_kit never runs this automatically.
"""

import os
import sys

from grok_loop_kit import GrokLoopClient

api_key = os.environ.get("XAI_API_KEY") or os.environ.get("GROK_API_KEY")
if not api_key:
    print("No XAI_API_KEY / GROK_API_KEY in env. Set one and re-run.", file=sys.stderr)
    print("(Grok grants no free credits — the key must belong to a funded team.)", file=sys.stderr)
    sys.exit(1)

client = GrokLoopClient(
    api_key,
    compact_every=4,
    model=os.environ.get("GROK_MODEL", "grok-4.5"),
    on_compact=lambda e: print(
        f"  · compaction #{e.totalCompactions} at turn {e.atTurn}, dropped {e.droppedMessageCount} msgs"
    ),
)

prompts = [
    "In one short sentence, name a color.",
    "Now name an animal, one sentence.",
    "A country, one sentence.",
    "A fruit, one sentence.",
    "A number between 1 and 10.",
    "A day of the week.",
    "A planet.",
    "A musical instrument.",
    "A sport.",
    "Summarize everything you have told me so far in one line.",
]

for i, p in enumerate(prompts, 1):
    res = client.send_message(p)
    msg = next((o for o in (res.output or []) if o.get("type") == "message"), None)
    text = (msg or {}).get("content", [{}])[0].get("text", "(no text)")
    print(f"turn {i}: {text.strip()[:80]}")

print("\n--- live smoke complete ---")
print("total compactions:", client.total_compactions)
print("estimated tokens saved:", client.estimated_tokens_saved)
print("transcript size now:", len(client.messages), "items")
