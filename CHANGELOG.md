# Changelog

# Changelog

# Changelog

## 0.4.7 (2026-05-05)

- Add Marketplace screenshots: streaming chat, setup wizard, sidebar panels.
- Add MIT LICENSE file.
- Add an AcpClient smoke test suite (runs against a fake ACP server, no Hermes install required) and a GitHub Actions workflow that runs lint + tests on every push and PR.

## 0.4.6 (2026-05-05)

- Fix blank assistant reply after VS Code reload: validate the resumed sessionId returned by Hermes and fall back to a fresh session when the previous one is gone.
- Setup wizard: probe `~/.local/bin/hermes` and other common install locations when the binary is not on PATH (typical when VS Code is launched from the dock); persist the working absolute path to `hermes-chat.hermesPath`.
- Setup wizard: clearer guidance and a one-click reload-window action when Hermes still cannot be located after install.

## 0.3.0 (2026-04-26)

- Improve Marketplace positioning with clearer AI agent description, search keywords, and README feature matrix.
- Document local Hermes CLI prerequisites, ACP requirement, and Hermes-owned configuration paths.
- Add configurable ACP request timeout, request cleanup, safer Webview CSP, and asynchronous usage storage.

## 0.2.0 (2026-04-19)

- **Switched to ACP protocol** — uses `hermes acp` for bidirectional streaming
- **Streaming output** — see Hermes's response as it's generated
- **Tool execution visualization** — watch tool calls run in real-time with input/output
- **Token usage tracking** — input/output/cached tokens shown per response
- **Memory panel** — view USER.md / MEMORY.md / SOUL.md content in sidebar
- **Skills panel** — browse all installed Hermes skills by category
- **Cron Jobs panel** — see scheduled jobs with status and next run time
- **Cancel button** — stop a running query mid-flight
- **Thinking display** — shows reasoning/thought chunks separately

## 0.1.0 (2026-04-19)

- Initial release
- Sidebar chat panel with markdown rendering
- Session persistence across messages
- Automatic file and selection context injection
- New session command
- Status bar indicator
