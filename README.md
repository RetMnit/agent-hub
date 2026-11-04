# Agent Hub

A Claude Code plugin that delegates tasks to two other local agents as subagents:

- **DSH** (DeepSeek Harness): desktop mode runs the session in DSH Desktop, where you can watch it; headless mode runs it in a hidden DSH host.
- **Codex**: runs `codex exec` in the background; progress shows on the card. A thread opens in the Codex app only when you ask, since the app then holds it against resumes until it quits.

Each Claude session has its own settings per backend, saved once in the side pane before the first task. Old DSH sessions and Codex threads can be resumed with their original settings. A side pane in Claude Code (desktop app and terminal) shows the configuration form and one live card per subagent, and the session is woken when a task ends unread.

## Layout

| Path | What |
| --- | --- |
| `hooks/` | The Claude Code mod: tools for the model, the side pane, polling and wake-up |
| `daemon/` | A local Node service (`127.0.0.1`, token auth): per-session settings, job ownership, what the model has read; it drives both backends through the shared bridges |
| `skills/agent-hub/` | Usage rules for the model |
| `test/` | Daemon tests with fake bridges; no model is called |

State lives in `~/.claude/agent-hub` (not `%LOCALAPPDATA%`, of which the packaged desktop app sees a private copy): settings and a mirror of each session's jobs, so cards stay after a DSH Host has gone. Ended jobs are kept 30 days, at most 200 per session.

## Requirements

- Windows, Node.js 22+ on `PATH`.
- Codex: [codex-bridge](https://github.com/RetMnit/codex-bridge) installed (`node setup.mjs` in its folder), which runs `codex exec` for any agent.
- DSH: [dsh-bridge](https://github.com/RetMnit/dsh-bridge) installed (`node setup.mjs`, then restart DSH Desktop), the DSH bundle all local agents share.

Agent Hub loads each bridge's client from its `install.json` and calls itself `agent-hub`, so its jobs stay apart from other agents'.

## Install

```bash
claude plugin marketplace add RetMnit/agent-hub
claude plugin install agent-hub@agent-hub-tools
```

Updates: `claude plugin marketplace update agent-hub-tools`, then `claude plugin update agent-hub@agent-hub-tools`, then start a new session. The first call of a session on a newer plugin replaces an older running hub.

For development, add the local checkout as the marketplace instead (`claude plugin marketplace add "<path to this folder>"`); the plugin is then read from the folder itself, and edits apply to new sessions.

## Development

```bash
node --test test/*.test.mjs
```

The mod is type-checked against the `claude-code` declarations and checked with `claude plugin validate .`.

## Known limits

- Watching never starts a DSH Host: while one is not running, its cards say so and keep their last state.
- `/subagents` is registered when the session starts, so the desktop app's prompt box neither suggests it nor recognizes it ("not a command here"); typed in full it still runs. Asking Claude to open the subagent pane does the same.
- The Codex app will not load a thread that `codex exec` is still writing (it reports it as open in another app), so live progress is shown in the Claude pane only. Once the app has a thread open it keeps it until it quits (switching threads or leaving it idle does not release it), and resuming it here is refused meanwhile. The app also files the thread under a project by folder; two Codex projects with the same root cannot be told apart.
