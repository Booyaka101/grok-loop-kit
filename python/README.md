# grok-loop-kit (Python)

Automatic Grok 4.5 context compaction for xAI Responses API agent loops.

```python
from grok_loop_kit import GrokLoopClient

client = GrokLoopClient(api_key, compact_every=8, compact_at_tokens=8000, model="grok-4.5")
res = client.send_message("hello")
print(res["_grokLoopKit"].totalCompactions)
```

Zero runtime dependencies (stdlib `urllib`). See the repository root README for the
full API and the Node/LangGraph packages.
