# Hermes Agent Chat for VS Code

The VS Code control center for [Hermes Agent](https://github.com/hermes-agent/hermes): streaming chat, tool calls, memory, skills, models, cron jobs, and token usage in one sidebar.

Hermes Agent Chat is built for developers who want the full Hermes agent loop inside the editor. It connects to Hermes through ACP, streams responses as they are generated, shows tool execution as it happens, and keeps useful agent state visible without leaving VS Code.

## Highlights

- **Streaming ACP chat** - Talk to Hermes Agent from the Activity Bar with live response updates.
- **Tool call visibility** - See tool names, status, input, and output while Hermes works.
- **Editor context** - Automatically includes the active file and selected code in your prompt.
- **Memory and skills browser** - Inspect Hermes memory files and installed skills from the sidebar.
- **Model controls** - View and switch configured providers and models from VS Code.
- **Cron and usage panels** - Monitor scheduled Hermes jobs and token usage over time.

## Features

| Capability | Included |
|------------|----------|
| Streaming Hermes Agent chat | Yes |
| ACP protocol support | Yes |
| Tool call visualization | Yes |
| Active file and selection context | Yes |
| Persistent session resume | Yes |
| Hermes memory panel | Yes |
| Skills browser | Yes |
| Cron job viewer | Yes |
| Model switcher | Yes |
| Token usage tracking | Yes |

## Requirements

- [Hermes Agent](https://github.com/hermes-agent/hermes) installed and configured on your system.
- Run `hermes doctor` before using the extension to verify your local Hermes setup.

## Before You Install

This extension does not bundle Hermes Agent. It is a VS Code frontend for a local Hermes CLI installation, so your machine must already be able to run Hermes from a terminal.

Verify these commands before opening the extension:

```bash
hermes doctor
hermes version
hermes acp
```

If `hermes` is not on your `PATH`, set `hermes-chat.hermesPath` in VS Code to the full path of the Hermes executable.

Hermes owns the agent runtime configuration. Model providers, API keys, tools, skills, MCP servers, and memory behavior are configured by Hermes itself, not inside this extension.

The sidebar reads local Hermes state when available:

| Extension view | Local Hermes data used |
|----------------|------------------------|
| Memory | `~/.hermes/memories/USER.md`, `~/.hermes/memories/MEMORY.md`, `~/.hermes/SOUL.md` |
| Skills | `~/.hermes/skills/` |
| Cron Jobs | `~/.hermes/cron/jobs.json` |
| Model | `~/.hermes/config.yaml` |
| Token Usage | `~/.hermes/usage/usage.jsonl` |

Missing files show empty states in the sidebar. They do not mean the extension is broken; they usually mean Hermes has not created that feature data yet.

## Getting Started

1. Install and configure Hermes Agent.
2. Run `hermes doctor` in a terminal.
3. Install this extension.
4. Click **Hermes Agent** in the Activity Bar.
5. Type a message and press Enter.

Hermes responds through the same agent pipeline you use from the CLI, including memory, tools, skills, and configured MCP servers.

## Tips

- Select code before asking a question to include that snippet as context.
- Use **Shift+Enter** for multi-line messages.
- Click the **+** button in the chat toolbar to start a new Hermes session.
- Open the Memory, Skills, Cron Jobs, Model, and Token Usage views to inspect Hermes state from the same sidebar.

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `hermes-chat.hermesPath` | `hermes` | Path to the Hermes CLI executable |
| `hermes-chat.timeout` | `180` | Query timeout in seconds |

## How It Works

This extension starts Hermes through `hermes acp` and communicates using JSON-RPC over ACP. Your messages go through Hermes's full agent pipeline, including tool use, memory, skills, cron jobs, and any configured MCP servers. The extension focuses on the VS Code experience; Hermes remains the agent runtime.

## Marketplace Positioning

Hermes Agent Chat is an AI and agent workflow extension. It is separate from telemetry frontends, spacecraft operations tools, and comment formatting extensions that may share the Hermes name.

## License

MIT
