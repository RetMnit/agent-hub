# Agent Hub — repository rules

- Usage rules for the model live in `skills/agent-hub/SKILL.md` and the tool descriptions in `hooks/register.tsx`; keep them in step and out of global or workspace CLAUDE.md files.
- The mod may only spell the engine as `$.noun.method(...)` at its call site, and `read`/`update` need an atom defined in the same file: helpers get the `Io` closures built in `session.start`, and the atoms stay in `register.tsx`.
- Run `node --test test/*.test.mjs` and `claude plugin validate .` before committing. Tests use fake bridges; never call a real model from tests.
- Running work belongs to the shared bridges in `Common/` (`dsh-bridge`, `codex-bridge`); `daemon/bridges.mjs` adapts them. A change a bridge needs is made there, for every caller, never worked around here.
- Bump `version` in `.claude-plugin/plugin.json` when the daemon changes, so `launch.mjs --upgrade` can replace an older running hub.
