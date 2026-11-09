---
name: keep-awake
description: Turn keep awake (the PC must not sleep) on or off through the workbench-host helper. Use on "/keep-awake on|off|status".
---

# keep-awake

Tools (ToolSearch "select:mcp__workbench-host__keep_awake_start,mcp__workbench-host__keep_awake_stop,mcp__workbench-host__keep_awake_status").
If they are missing, say the helper isn't connected in this session and stop.

| argument | call |
|---|---|
| `on` (default) | `keep_awake_start` |
| `off` | `keep_awake_stop` |
| `status` | `keep_awake_status` |

Reply with one line: `TLDR: keep awake <on | off>.` It asks Windows not to sleep (no fake input, so the screen
still locks on the company's schedule). It stays on, also after the desktop app restarts, until `off`.
