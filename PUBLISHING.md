# Publishing checklist

Both packages build to valid, installable artifacts locally. Publishing itself
is a manual owner step (needs npm + PyPI accounts and 2FA) — it is intentionally
NOT automated here.

## npm (`grok-loop-kit`)

Verified locally:
- `npm run typecheck` — clean (`strict: true`)
- `npm run build` — CJS + ESM + `.d.ts`
- `npm test` — 11/11
- `npm pack --dry-run` — 18 files, dist + README + LICENSE + CHANGELOG only

To publish:
```bash
npm run build
npm publish --access public       # requires: npm login, 2FA
```
Notes:
- LangChain is an **optional peer** — consumers only need it for `grok-loop-kit/langgraph`.
- `exports` map ships both `.` and `./langgraph` with types for CJS and ESM.

## PyPI (`grok-loop-kit`)

Verified locally:
- `python -m build` — produces `grok_loop_kit-0.1.0-py3-none-any.whl` + `.tar.gz`
- fresh-venv install of the wheel imports `GrokLoopClient` + `AsyncGrokLoopClient`
- `python test_loop.py` — 11/11
- ships `py.typed`

To publish:
```bash
cd python
python -m build
python -m twine upload dist/*      # requires: PyPI token
```
Note: the npm and PyPI names are both `grok-loop-kit`; confirm availability before release.

## Live verification (done at 1.0 with the owner's key)
- `node scripts/hardtest-live.mjs` — 7/7 (needle retention through 4 real compactions,
  savings vs control, live tool round-trip, live streaming).
- `node scripts/langgraph-live.mjs` — real `createReactAgent` tool loop against Grok.
- Both names available on npm + PyPI (checked 2026-07-24).

## Before release
- [ ] Re-run the live tests with a funded key if code changed since (spends a few cents).
- [ ] Tag the release (`v1.0.0`) and confirm CHANGELOG.
- [ ] First distribution post: a before/after showing agent context flatlining
      across 20 turns instead of growing linearly; tag the xAI dev account.
