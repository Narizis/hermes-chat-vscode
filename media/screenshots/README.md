# Screenshot capture guide

Drop PNGs here with these exact filenames so the README renders them:

| File | What to capture |
|------|-----------------|
| `chat-streaming.png` | Hermes sidebar mid-stream: visible agent text, one expanded tool call, token usage chips at the bottom. Use a real prompt like "explain this file" with the active editor showing some code. |
| `setup-wizard.png` | The Setup Wizard panel showing all three steps. Easiest reproduction: rename `~/.hermes` temporarily, then run `Hermes: Run Setup Wizard` from the command palette. |
| `panels.png` | Activity Bar with all five secondary views (Memory / Skills / Cron / Model / Token Usage) expanded at least one level. |

## Tips

- Use a clean VSCode window (no random files open) and a dark theme — the bubbles look much sharper.
- Crop to the sidebar + a bit of editor context, no need to capture the full screen.
- Keep file size under ~300 KB each (use `pngquant` or similar) so the marketplace listing loads fast.
- For an animated GIF, also drop one as `chat-streaming.gif` and update the README image to point at it.
