---
name: work
description: Workbench card procedure. A card session (started when the user moves a card to Doing, or by the helper's night check) works ONE named card in a git worktree and lands it in review or blocked. The night check only picks cards and starts their sessions (see "Night dispatch"). Use on "/work" or "continue the board".
---

# work — one card per session

Read `CLAUDE.md` in the workbench root for the document shapes.
All board reads and writes go through `node <workbench root>/host/db.mjs` on this PC, whatever Claude account this
session runs as: `get cards/<key>` (prints `{ id, version, data }`), `list projects`, and for a write a patch in a JSON
file (Write tool, in the worktree's `.git`-ignored scratch or the system temp folder) passed as
`update cards/<key> --file <patch.json> --if-version <version>`. Never `ArtifactData`: the board does not read it.
Hard limits: one card per session, ~90 min, no `git push`, no merge to main, write code only inside the card's worktree,
and never publish an artifact (the Artifact tool): the live board changes only after the user accepts the card.

Two kinds of run use this file:
- **Card session**: a background session started for one named card (its prompt names it). Steps 0–6.
- **`/work` with no card named**: pick one card by the rules in "Night dispatch" and start it; never work it here.

A card session runs unattended: nobody reads its chat. Never end a turn with a question in chat or wait for
approval there, and skip skills that do (brainstorming, writing-plans and the like). A decision you cannot make
is a step 5 question on the card.

**Hand the folder on at every exit.** Whenever a card session stops, for any reason (step 1 refuses, the claim
fails, the user moved the card out, step 6), its last command is `node <workbench root>/host/card.mjs next <card key>`.
It starts the next card waiting for this folder, if any, and is harmless when none waits.

## 0. Refresh the folder list

Run `node host/scan-folders.mjs --save` in the workbench root: it writes `machine/folders`, which the board's New
project form picks from. A failed scan never blocks the card.

## 1. Pick

- **A card was named** (a card session, or `/work <card key>`): read that card and go to step 2 with it.
  Only a card in `doing` or `ready` is claimed: any other status means it was moved away before this session
  began, so print `TLDR: #<id> <title> is <status>, not started.` and stop. If another worker already holds it (last log line `started` or `resumed` by `worker`, less than
  3 hours old, and this session did not write it), print that and stop. A session that was resumed
  (its prompt says so) is that worker: it claims the card with `resumed` and continues from its own
  conversation and the card's log.
- **No card was named** (`/work` typed in a session): pick one card by the rules in "Night dispatch", start it with
  `mcp__workbench-host__card_start` (`{ card, folder, title, session, model, effort }` from the card and its project),
  print `TLDR: #<id> <title> → started|resumed|queued behind <behind>|already running.` and stop. Never work it in this
  session: the helper's queue and busy check only see card sessions it started.

## 2. Claim

Update the card with `db.mjs update`, pinned with `--if-version` from the read:
`{ status: "doing", updated: <now>, log: [...log, { at: <now>, who: "worker", text: "started" }] }`.
A card already in `doing` is claimed the same way, with only `updated` and the log line: `started`
for a new session, `resumed` for a resumed one. For a resumed card read its log and ticked
acceptance first and continue from the `paused — <next step>` note rather than starting over.
Arrays replace wholesale: always send the full new array. If the pinned write fails
(someone changed the card, or another session claimed it first), re-read once and retry;
if it fails again, stop.

Only in a desktop app session (not a background card session): put this session where the user looks for it.
Best effort: a failure here never blocks the card.
- `mcp__ccd_sidebar__list_groups`; if no group is named like the card's project (`projects/<slug>.name`),
  `mcp__ccd_sidebar__create_group` with that name. `mcp__ccd_sidebar__move_sessions` with
  `session_ids: ["self"]` into it.
- `mcp__ccd_session_mgmt__set_session_title` with `session_id: "self"`, title `<project name>: <card title>`.

## 3. Workspace

Read `projects/<slug>` for `repo` (the project's folder: any directory, git or not) and `body`. If it is a git repo:
`git -C <repo> worktree add .worktrees/<card key> -b card-<card key>-<slug-of-title> <default-branch>`.
The card key (`<project slug>-<NNN>`) keeps two projects that share one folder apart.
The project body wins where it names a base branch (for example `origin/development`) or a
worktree location (for example a `.scratch` folder beside the repo).
If the branch already exists, `worktree add` without `-b`; if the worktree folder already exists
(a resumed card), reuse it. Update the card with `branch`.
Not a git repo, or no folder → work in place and say so in the log. (The helper starts only one
session at a time in a folder that is not a git repo; other cards wait in Doing for it.)

## 4. Execute

Read the project body, the card, then the code it touches. If the goal names a card it comes after ("after #NNN",
or "after #<title>" from the board's Plan button), find that card in this project and read its `picks` too: the user's
chosen options win over anything its docs recommend. A line `<topic>: own · <text>` is an answer they wrote themselves;
follow it over every option.
A goal line `Output: <path>` (relative to the project folder) names the ONE file the task's cards build: write your
part into it, create it if missing, keep other cards' sections, and never start a second file for the same task.
A result the user reads with no Output line goes in one file in the project's `docs` folder. A count or summary of work
done is checked against git history and Jira, even when the goal names only posts; say in `unchecked` what any
source left out. Use
`superpowers:test-driven-development` for code. As each acceptance item passes,
update the card's `acceptance` array with `done: true` for that item. Commit in
the worktree as you go, normal commit messages.

Before each acceptance item and before closing, re-read the card. If its `status` is no longer `doing`,
The user moved it out on the board: stop at once, write nothing more to the card, and print
`TLDR: #<id> <title> → stopped by the user.` The branch and worktree stay for a later start.
(Usually the move pauses this session before it gets here: leaving Doing stops it.)

## 5. Decide — never stall

Pick the first that applies, then go to step 6:

- **All acceptance done** → `handover`, `result` and the acceptance notes (see "Handover"). Status `review`.
- **A decision cannot be made from card + project + code** → `question`: one
  specific question, then 2–3 lines `A) …`, `B) …`, `C) …` with one marked
  `(recommended)`, then a line starting `If unanswered: …`. Status `blocked`.
  Do not guess on anything hard to undo (schema, public API, deletes).
- **Same failure twice** → `question` with the exact error, what you tried, options.
  Status `blocked`; log line `worker: failed — <error in 8 words>`.
- **Out of time (~90 min)** → tick what passed, log `worker: paused — <next step>`,
  leave `doing` only if a clear next step exists; otherwise `blocked` with a
  question "continue or split?".

## Handover

The user reads a Review card cold, at 7am, between other things. The card shows `handover`; `result` sits folded
under Details. Write for someone who knows the project but not this session.

**Plain words.** No file paths, commit hashes, branch names, card keys, flags or tool names in `handover`
(they belong in `result`). Name a file by what it is ("the design doc", "the page map"), and say in a few words
what any term the plan does not use means. Each line ≤ 20 words.

Write `handover` on the card:

```json
{
  "v": 1,
  "headline": "≤ 12 words: what is now true",
  "output": "the full path of the one file the user should open; \"\" when the result is code on the branch",
  "shape": ["1-6 lines, ≤ 56 characters each: a small picture of the result", "!a line starting with ! is the surprise"],
  "calls": [{ "topic": "Workers", "pick": "B", "options": [
    { "key": "A", "label": "Haiku only", "cost": "cheapest; misses bugs that take several steps" },
    { "key": "B", "label": "Haiku attacks, Sonnet re-tries", "cost": "about twice A" } ] }],
  "chose": ["a decision you made yourself; the card shows it under The worker decided"],
  "unchecked": ["what you could not verify, and why it matters"],
  "later": [{ "title": "a backlog card title", "why": "one line" }]
}
```

- `output`: the board shows it first on the card, with Open. It is the only path allowed outside `result`.
- `headline`: the outcome, not the activity. "It works; the July page map matched only 10 of 40 tickets", not "Implemented scope".
- `shape`: a flow (`A → B → C`), a tree with counts, or a before/after. Not a file list.
- `calls` (0-4): only decisions the user must make, `topic` 1-3 words, 2-3 options each, `cost` = what it costs or
  risks, `pick` = your recommendation, exactly one option's `key`. Looks good saves their choices in `picks`; they can change
  one on the card or write their own (`<topic>: own · <text>`). A decision you made that they only need to know about goes
  in `chose` (0-4).
- `unchecked` (0-4): write `[]` when you checked everything; the card then says so.
- `later` (0-3): work you found that is not already a card or a step in the plan (`projects/<slug>.plan`).
  The card shows them under Extra work found; Looks good adds each one to Backlog unless the user unticks it.
- Saying you differ from the plan: check `projects/<slug>.plan.text` first.
- Each acceptance item gets `how` (`doc`, `run`, `test` or `look`), `evidence` (≤ 12 words: what shows it) and,
  only when it holds with a condition, `catch` (≤ 12 words). Keep `text` and `done` as they are.
- `result` (markdown, for Details): `## Notes` (what the user may want in full), `## How to check` (exact commands
  in fences), `## Branch` (branch, commit, base, not pushed).

A **question** keeps its A/B/C lines plain so the board can parse them: each option on one line, with its
consequence after a dash.

## 6. Close

Update the card with `db.mjs update` (pinned): `{ status, handover + result + acceptance | question, updated: <now>,
log: [...log, { at: <now>, who: "worker", text: "<review | blocked — … | failed — … | paused — …>" }] }`.
Then stop every background task this session started (dev servers, watchers, `sleep`s) and hand the folder on:
`node <workbench root>/host/card.mjs next <card key>` (one JSON line). Print `TLDR: #<id> <title> → <status>. <one line>`
and stop. Every card gets its own session; never pick up another card here.

## Night dispatch

The helper's night check (`host/night.mjs`, code, no Claude session) does this every 10 minutes from 20:00 to 07:00.
It reads the board with one tiny Haiku call, writes nothing to it, and only starts sessions; the card session does
the work. The same rules apply to `/work` with no card named.

1. Active projects only, cards that are not done. Sort the Doing cards into:
   - **Unclaimed**: the last log line is by `you` and is more than 10 minutes old (its session never
     started, or it waits for its folder).
   - **Stranded**: the last log line is `paused — …`, or `updated` is more than 3 hours old.
   - **Running**: everything else. Leave it alone.
2. Take the oldest `updated` unclaimed card, else the oldest stranded one, else the first Ready card by
   `priority` asc, then `created` asc. A Ready card with a `session` is one the user paused: resuming it is
   fine (cards they park go to Backlog).
3. A Ready card whose goal says "after #NNN" or "after #<title>" waits until that card is done.
4. Nothing starts when the week's usage (all models) is at or over `machine/night.cap`, or without a usage reading.
   At most 2 card sessions work at once; a session that ended within 30 minutes of its start waits.
5. `card_start` gets `{ card: <card key>, folder: <projects/<slug>.repo>, title: "<project name>: <card title>",
   session: <card.session>, model: <card.model>, effort: <card.effort> }`. An answer `waiting` or `already` means
   that card is handled: try the next candidate, at most 3 other attempts per check.

The check's status is in `host/runs/night.json` and `night.log`, and the board's usage pane shows it.
`node host/night.mjs tick --dry-run` prints what a check would start, starting nothing.
