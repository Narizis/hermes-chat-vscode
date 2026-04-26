# Changelog

## Unreleased

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
