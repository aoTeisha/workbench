---
name: setup
description: First run of Workbench on a machine - publishes this person's own board artifact, adds the workbench-host helper to the Claude desktop app, and writes their board settings. Use on "/setup", "set up workbench", or when `node host/db.mjs get machine/artifact` finds no board yet.
---

# Workbench setup

Run from the cloned repo, in a Claude Code session in the **Claude desktop app** (Windows or macOS), signed in to the
claude.ai account the board should belong to. Each person gets their own board: their own artifact, database,
connectors and cards. Nothing is shared with whoever they cloned it from.

Say what each step does before it runs. Stop and tell the user when a check fails; never work around one.

## 1. Check the machine

Run and report in one line each:
- `node -e "console.log(process.platform, process.version)"`: `win32` or `darwin`, Node 22 or newer.
- `claude --version`: the Claude Code CLI is installed (card sessions and the night check run it).
- `git --version`.
- `node host/db.mjs get machine/artifact`: if it already has a `url`, this machine has a board. Ask whether to
  update that board (publish to the same `url`) or start a new one; never publish a second board silently.

## 2. Connectors

The board reads mail and calendar from **Microsoft 365**, Slack from **Slack**, and Jira from **Atlassian MCP**:
claude.ai connectors under exactly those names (Settings > Connectors). Check which of them this session has
(their tools show in your tool list). List the missing ones and how to add them. Missing ones are not a blocker:
that widget says "Add … in claude.ai Settings → Connectors" until it is connected.

## 3. Publish the board

1. Load the `artifact-capabilities` skill (the Artifact tool needs it before `capabilities` is passed).
2. Read `artifact/workbench.html` in full (the Artifact tool publishes only files the session has read) and
   `artifact/capabilities.json`.
3. Publish with the Artifact tool: `file_path` `artifact/workbench.html`, `capabilities` = the JSON object in
   `artifact/capabilities.json`, `icon` "board", `title` "Workbench", plus `url` when updating an existing board.
   The page is finished: publish it as it is, no edits.
4. Save the URL on this machine: write `{"url": "<the artifact url>"}` to a temp JSON file, then
   `node host/db.mjs set machine/artifact --file <that file>`.

## 4. Board settings (`config/board`)

Ask these with AskUserQuestion, one dialog:
- Work week: Monday to Friday (`weekStart: 1`) or Sunday to Thursday (`weekStart: 0`).
- Jira views besides "Mine" (optional): project keys, and per project whether to show its open sprint or all open
  issues. Each becomes `{ key: "<lowercase key>", label: "<KEY>", jql }`, with jql
  `project = <KEY> AND sprint in openSprints() AND statusCategory != Done ORDER BY statusCategory DESC, updated DESC`
  or `project = <KEY> AND statusCategory != Done ORDER BY statusCategory DESC, updated DESC`.
- Slack app links (optional): the workspace id `T…`. It shows in the address bar of Slack in a browser
  (`app.slack.com/client/T…/…`). Without it, Slack items open in the browser.

Write the doc with `ArtifactData` `set`: `url` the board, collection `config`, doc id `board`,
data `{ weekStart, slackTeam, jiraViews }` (leave out what the user skipped). Change it the same way later.
Nobody's identity goes here: the page asks each connector who is viewing.

## 5. The helper (cards, sessions, night shift)

1. Path of node: `node -p process.execPath`. Path of the helper: the absolute path of `host/server.mjs` in this clone.
2. The desktop app's config file: Windows `%APPDATA%\Claude\claude_desktop_config.json`, macOS
   `~/Library/Application Support/Claude/claude_desktop_config.json` (the app's Settings > Developer > Edit Config
   opens the same file). Read it, then add under `mcpServers` (keep everything else as it is):
   `"workbench-host": { "command": "<node path>", "args": ["<server.mjs path>"] }`.
3. Tell the user to quit the desktop app fully (Windows: tray icon > Quit; macOS: Cmd+Q) and reopen it. The helper
   starts with the app; a changed `host/server.mjs` or `host/card.mjs` needs the same restart.
4. Card sessions run with `claude --bg` in each project's folder, which needs a folder Claude Code trusts: ask the
   user to run `claude` once in each project folder they will put on the board and accept the trust prompt.
5. Optional: a separate Claude login for card sessions, `node host/accounts.mjs add workbench` (else they use this
   machine's normal Claude Code login). `node host/accounts.mjs status` shows them.
6. `node host/scan-folders.mjs --save` fills the folder list the New project form offers.

## 6. Check it works

Ask the user to open the board URL in the desktop app (not a browser tab: cards need the app). Expect:
- the bar shows today's meetings and the usage meter (the meter means the helper answered);
- the widgets fill, or name the connector to add;
- Projects is empty and `+ Project` offers folders from step 5.6.

On macOS, also ask them to try once: Keep awake on in the cog menu (`caffeinate` runs: `pgrep caffeinate`), and Open
session on a card in Doing (Terminal opens on the card's session). Report anything that fails with its exact message.

End with the board URL and one line on what is not set up (missing connectors, skipped settings).
