# Workbench

Plan with Claude by day, let Claude work alone by night. A board of cards per project: move a card to Doing and its own
Claude Code session starts working it in the project's folder; questions and finished work come back as cards you
decide on in the morning. Beside the board, a desk of what needs you from Outlook, Slack, Jira and your calendar,
scored by Claude.

The board is a claude.ai artifact. Each person publishes their own copy, so it runs on their own Claude account,
their own connectors and their own cards. Nothing is shared with whoever you cloned it from.

## Needs

- Windows or macOS, with the Claude desktop app (cards only work in the board opened inside the app).
- Claude Code CLI, Node 22 or newer, git.
- Optional claude.ai connectors (Settings > Connectors): **Microsoft 365** (mail, calendar), **Slack**,
  **Atlassian MCP** (Jira). A missing one just leaves its widget empty.

## Set up

```bash
git clone https://github.com/aoTeisha/workbench.git
```

Open the folder in the Claude desktop app's Code tab and run `/setup`. It publishes your board, adds the local helper
to the app, asks for your work week and Jira views, and checks that it works. Then open your board's link in the app.

## How it fits together

- `artifact/workbench.html`: the board page, one file. `artifact/capabilities.json`: what it may call.
- `host/`: the helper the app starts (`host/server.mjs`); it runs card sessions, the night shift and keep-awake, and
  stores cards in `data/` on your machine.
- `.claude/skills/`: `/setup`, `/plan-cards` (turn a plan into cards), `/work` (how a card session works a card).
- `CLAUDE.md`: the data contract every Claude session follows.

Tests: `node --test "host/*.test.mjs"`.

## Contributing

Open a pull request; `master` only changes through reviewed pull requests. MIT licensed.
