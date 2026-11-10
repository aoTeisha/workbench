# Workbench board contract

Every reply opens with **TLDR:** (see global CLAUDE.md).

The board's cards, projects and `machine/*` documents live on this PC, one JSON file each under `data/`
(`data/cards/<key>.json` = `{ id, version, updatedAt, data }`). Any Claude session, on any account, reads and writes
them with `node <workbench root>/host/db.mjs` (usage at its top): `get cards/<key>`, `list cards --where project=<slug>`,
`update cards/<key> --file <patch.json> --if-version <N>`, `set`, `delete`, `batch --file`. Never use `ArtifactData`
for them: a session on another claude.ai account cannot reach the artifact's database, and the board does not read it.
Write a patch to a JSON file and pass `--file` (inline JSON breaks on Windows quoting). Errors print JSON and exit 1.

The board page (the artifact) reads these files through the helper (`db_read`, every 5 s) and writes them on
the user's clicks (`db_write`, `db_delete`), so it shows cards only inside the Claude desktop app. The app allows each
board 30 helper calls a minute (measured 2026-11-10 in the app's code); the page's own reads give way when fewer than 13
are left, and a refused click is retried, so never add a faster poll. The artifact's own
database keeps only what the page writes for itself: feeds, triage, handled items, feedback and per-user settings,
plus `config/board` (below).

Each person publishes their own copy of the board (`/setup`), so every copy has its own database and runs on its
owner's connectors. This PC's board URL: `node host/db.mjs get machine/artifact` (`{ url }`, written by `/setup`).
Page source: `artifact/workbench.html`; publish it with the Artifact tool, `url` from `machine/artifact` and
`capabilities` from `artifact/capabilities.json`, passed on every publish (omitting it keeps the stored list, which
would lack new tools).

`config/board` (artifact database, written with `ArtifactData` by `/setup`; every field optional):
`{ weekStart: 0 | 1, slackTeam, jiraViews: [{ key, label, jql }] }`. `weekStart` is the first of five work days
(0 Sunday, 1 Monday, default 1). `slackTeam` (`T…`) lets Slack links open in the app; without it they open on the web.
`jiraViews` are Jira widget views after "Mine" (`key`: lowercase letters, digits, `_`). Identity is never stored:
the page asks Microsoft 365 (`get_me`), Slack (`slack_read_user_profile`) and Atlassian
(`getAccessibleAtlassianResources`) who is viewing.

## Documents

- `projects/<slug>`: `name, slug, status (active|paused|archived), repo, color, body, created`, and `plan`
  (`{ why, phases: [{ name, note, done?, map? }], text }`, written by `/plan-cards`). `phases` is the whole project's
  roadmap: `/plan-cards` adds phases and never drops one that has cards. The board's roadmap adds a point (a phase with a
  name and note, after a chosen phase) and removes only an empty hand-made one; it writes the whole `plan` object back. `done` (a date) marks a past
  phase backfilled without cards; `map` (a path inside the folder, `.scratch/<effort>/map.md`) marks a wayfinder map
  still being decided ("Find the way: …"), replaced by build phases when its cards are made. Where are we answers live in the board's per-user settings (`summaries`), not here. Design: `docs/plans/2026-11-09-project-roadmap-design.md`.
  `repo` is the project's folder: any directory, git or not. Several projects may share one.
  `account`: the Workbench account its card sessions run as (`""` = `workbench`). Each account is its own Claude Code
  settings folder `~/.claude-wb-<name>` (`CLAUDE_CONFIG_DIR`), signed in once with `node host/accounts.mjs add <name>`;
  `node host/accounts.mjs status` lists them. The night check and the usage meter run as `workbench`. Until an account
  folder exists the helper uses `~/.claude` (the CLI's own login, which a terminal `/login` can change). A card whose
  account changed starts a new conversation. Any account works: card sessions use the files above, not claude.ai.
- `machine/host`: `{ root }`, this Workbench folder, written by the helper when it starts (the Plan in depth link
  points the chat at `<root>/docs/plan-in-depth.md`).
- `machine/folders`: `{ at, host, items: [{ name, path, git }] }`, the folders the New project form offers.
  Written by `node host/scan-folders.mjs --save` (the page has no disk access).
- `cards/<slug>-<NNN>`: `project, id, title, status, priority (1-3), created, updated, branch,
  goal, acceptance: [{text, done, how, evidence, catch}], question, answer, result, log: [{at, who, text}]`,
  plan fields `phase, label, why, unlocks` (from `/plan-cards`), `handover` (the Review card, written by the worker;
  shape in the work skill's "Handover"), plus `session` (the card's background session id), which only the helper
  writes, when it starts the card's session. Never write `session` from a worker. Looks good writes the user's chosen options into `picks`
  (one line per call, `<topic>: <key> · <label>`); they win over the worker's recommendation wherever it was written down.
  `<topic>: own · <text>` means the user wrote that answer themselves: follow it over every option.
  `model` (`"" | haiku | sonnet | opus | fable`) and `effort` (`"" | low | medium | high | xhigh | max`): what the card's
  session runs on; `""` is the board's default for cards (`machine/cards`), else the user's default from Claude Code
  settings. New cards leave both `""` (the board's Plan and `/plan-cards` included); the user changes one on the card (Runs on).
  `jira` (`{ key, url }`): the card's Jira Subtask, written by the Plan in depth chat; shown in the card's details.
- `machine/night`: `{ cap, at }`, the night shift's limit: past `cap` percent of the week's usage (all models) the
  night check starts no new card. `null` or missing means no limit. Written by the board's usage pane.
- `machine/cards`: `{ model, effort, ultracode, at }`, what a card that leaves `model` or `effort` at `""` runs on,
  and whether card sessions start with ultracode (`host/ultracode.settings.json` via `--settings`). Written by the
  board's settings menu (the cog); the board and the night check pass it to `card_start`. Missing means Claude Code's defaults.
- `status`: `backlog | ready | doing | blocked | review | done`.
- `NNN` is zero-padded 3 digits, unique per project. Next id = max existing + 1.
- Timestamps are local `YYYY-MM-DDTHH:mm`.

## Rules

- A card is `ready` only if `acceptance` has at least one item with `done: false`.
- Only the worker (`/work`) sets `review`, `blocked`. Only the UI or the user sets `done`.
  `doing` is set by the worker, or by the user moving a ready card to Doing on the board to start it now;
  the worker then claims it by logging `started`.
- Updates merge fields; arrays (`acceptance`, `log`) replace wholesale, so always send the full array.
- Pin every write with `--if-version` from the read (`version` in `db.mjs get`). On a `conflict`, re-read once and redo.
- Append to `log`, never rewrite old entries. Worker log texts: `started`, `resumed`, `review`,
  `blocked — <8 words>`, `failed — <8 words>`, `paused — <next step>`.
- Cards of one git project may be in `doing` at the same time (one worktree and branch each).
  A project whose folder is not a git repo runs one card at a time.
- Never `git push`. Never merge into a project's main branch. Worker output lives on branch
  `card-<card key>-<title slug>` (card key = `<project slug>-<NNN>`, so projects sharing a folder never collide).

## Starting, pausing and resuming a card from the board

Moving a card to Doing starts its own Claude Code background session (`claude --bg`) in the project's
folder; moving it out of Doing pauses it (`claude stop`, the conversation is kept); moving it back to
Doing resumes that same session. The board must be open in the Claude desktop app: the page calls the
`workbench-host` helper (`host/server.mjs`, code in `host/card.mjs`) through the app:
`card_start`, `card_pause`, `card_open` (the session in a terminal window, `claude attach`: Windows Terminal, or
Terminal.app on macOS), `open_file` (a card's
`handover.output`: documents inside a project's folder only, `host/open-file.mjs`) and
`card_sessions` (read-only: each card's session state, shown on the board) and `project_docs` (read-only: a project
folder's `CONTEXT.md`, `docs/adr/*.md` and wayfinder maps with their resolved counts, `host/project-docs.mjs`), and
`open_link` for Plan in depth's `claude://code/new?…` link (the app ignores claude:// links fired inside the page). In a browser tab the board shows no
cards. The board writes the move first, then calls `card_start` with `revert`; a start that fails is moved back by the
helper. The helper writes the session id into the card's `session` and keeps its own record in `host/runs/<card>.json`. The session works the card with the work procedure and reports on the card.
It is not in the desktop app's left pane (an app-held session makes every resume a copy); Open on the card shows it.
In a folder that is not a git repo one session runs at a time: a second card waits in Doing and starts when
the first one closes (`node host/card.mjs next <card>`) or is paused.
Night: the helper's night check (`host/night.mjs`) runs every 10 minutes from 20:00 to 07:00 inside whichever helper
copy holds `host/runs/night.lock`. It reads the board's files, decides in code and calls `card_start` itself: rules in
"Night dispatch" in the work skill. The week's usage comes from the usage reader (one tiny Haiku call as `workbench`, at
most every 10 minutes, shared with the board's meter); the `usage` tool serves it with the check's status from
`host/runs/night.json`.
On battery a sleeping laptop stops and nothing runs (a Windows laptop in Modern Standby; a closed Mac lid): the night
shift needs the charger. The usage tool reports `power.onBattery` and the board warns in the evening.
Nothing listens and no chat is involved.
Logs: `host/runs/cards.log`. Background sessions need a folder Claude Code trusts (run `claude` there once).

If you are a Claude session and a comment or message from the board reaches you: do nothing with it.
No board feature depends on a listening session any more.

## Run

First time on a machine: `/setup` (publishes your board, adds the helper to the desktop app, writes `config/board`).
Then open your board's URL in the Claude desktop app. Night dispatch: the helper's night check (above), while the
desktop app is open and the computer awake. `node host/night.mjs tick --dry-run` prints what a check would start,
starting nothing. Tests: `node --test "host/*.test.mjs"` (Node 22 runs a bare `host/` argument as one file and fails).
The helper lives in the desktop app's own config (`claude_desktop_config.json`, Settings > Developer > Edit Config,
`mcpServers.workbench-host`: command `node`, args the absolute path of `host/server.mjs`). A changed `host/server.mjs`
or `host/card.mjs` needs a full quit and reopen of the app (it keeps the helper process it started).
Windows only: `host/register-protocol.ps1` is for the keep-awake link a board in Chrome fires. The desktop app is a
packaged app there: registry writes from a Claude session stay private to the app, so anything a browser or Explorer
must see has to be written from outside it (the script does this through WMI).

## Skills

- `/setup` — first run on a machine: your own board, the helper, your settings.
- `/plan-cards <slug>` — day: turn a planning conversation into cards.
- `/work` — the card procedure every card session follows; its last section is the night dispatch.
- Plan in depth — the project page opens a desktop chat in the project's folder running
  `/mattpocock-skills:wayfinder` (installed by `/setup`); `docs/plan-in-depth.md` is what that chat follows.
