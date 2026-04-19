# Hermes Agent Chat for VS Code

Chat with [Hermes Agent](https://github.com/hermes-agent/hermes) directly in VS Code. Hermes is an AI assistant with persistent memory, tool-calling, and session management.

## Features

- **Sidebar Chat Panel** — Talk to Hermes without leaving your editor
- **Session Persistence** — Hermes remembers your conversations across sessions
- **File Context** — Automatically includes the current file and selected code in your queries
- **Memory** — Hermes's built-in memory works seamlessly, remembering you across conversations

## Requirements

- [Hermes Agent](https://github.com/hermes-agent/hermes) installed and configured on your system
- Run `hermes doctor` to verify your setup

## Getting Started

1. Install this extension
2. Click the Hermes icon in the Activity Bar (sidebar)
3. Type a message and press Enter
4. Hermes responds with full agent capabilities

## Tips

- **Select code** in your editor before asking a question — the selection is automatically included as context
- **Shift+Enter** for multi-line messages
- Click the **+** button in the panel toolbar to start a new session
- Hermes remembers your preferences and past conversations through its built-in memory system

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `hermes-chat.hermesPath` | `hermes` | Path to the Hermes CLI executable |
| `hermes-chat.maxTurns` | `30` | Maximum tool-calling turns per query |
| `hermes-chat.timeout` | `180` | Query timeout in seconds |

## How It Works

This extension spawns Hermes as a CLI subprocess for each query. Your messages go through Hermes's full agent pipeline — including tool use, memory, and any configured MCP servers. The extension is a thin UI layer; all intelligence lives in Hermes.

## License

MIT
