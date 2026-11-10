---
name: plan-cards
description: Turn a planning conversation into Workbench cards for a project, written to the board's data on this PC. Use after brainstorming, when the user says "make cards", "add to the board", "/plan-cards <slug>", or "new project <name>".
---

# plan-cards

The board's cards and projects are files on this PC. Read `CLAUDE.md` in the workbench root for the document shapes,
then read and write them with `node <workbench root>/host/db.mjs` (a JSON file passed with `--file`), never `ArtifactData`.

## New project (`--new <name> <repo-path>`)

1. slug = kebab-case of name. `db.mjs set projects/<slug>`:
   `{ name, slug, status: "active", repo, color: "", body, created: <today> }`.
   `body`: goal, stack, conventions, how to run tests. Ask one question at a time
   only for things the conversation did not already settle.

## The plan

Review cards show where a card sits in the plan, and the project page draws every phase as its roadmap, so write the
plan on the project (`db.mjs update projects/<slug>`, pinned with `--if-version`) whenever the conversation agreed or
changed one: `plan: { why, phases: [{ name, note, done?, map? }], text }`.
- `why`: one sentence, why the project exists, in the user's words. Keep the existing one unless the user changed it.
- `phases`: the whole project's roadmap in order. This conversation's stages are 2-6 new phases, each `name` 1-3 words
  ("Prepare", "Build cards", "First live trial"), unique across the project's phases (a repeat gets the effort's word:
  "Prepare sync").
- `text`: the agreed plan in full, as markdown. Workers check "this differs from the plan" against it.

A project that already has a plan keeps it. Read `plan` first, then:
- Add the new phases at the end, unless the user said where. Never remove or rename a phase that has cards, finished
  or not: their plan strip finds the phase by name.
- Add this effort to `text` as its own `## <effort>` section; leave the other sections as they are.
- A phase with `map` is a wayfinder map still being decided ("Find the way: …"). When this run turns that map into
  build phases, put them where the map phase was and drop the map phase.
- `done` (a date) only marks past phases written without cards; never set it on a phase you add here.

## Cards

When the cards build on a reviewed card (a design, an inventory), read its `picks`: the user's chosen options win over
what its doc recommends. A line `<topic>: own · <text>` is an answer they wrote themselves; follow it over every option.

For each piece of work agreed in the conversation:

1. One goal per card. Under ~3 hours of agent work. Split if bigger.
2. `acceptance`: 2–6 items `{ text, done: false }`, each checkable by running
   something or looking at one thing. "Works" is not acceptance.
3. Dependencies: name them in `goal` as "after #NNN". Give the dependency a lower
   (earlier) priority number or the same.
   Cards that together make one thing the user reads (a document, slide notes, a report) build ONE file: end each
   goal with `Output: docs/<YYYY-MM-DD>-<short-name>.md` (the same path on every one) and name the card's section.
   Never narrow a card's sources below what the job needs: counts and summaries of work done come from git history
   and Jira, not only from posts about it.
4. `status: "ready"` when acceptance exists and nothing is unknown. Anything with
   an open question becomes `"backlog"` with the question in `question` so it
   shows as a planning question, not a blocker.
5. `priority`: 1 = tonight, 2 = this week, 3 = whenever. Default 2.
6. Next id: `db.mjs list cards --where project=<slug>`, max `id` + 1.
   Doc id is `<slug>-<NNN>` (zero-padded 3 digits).
7. Write all cards in ONE `db.mjs batch --file <writes.json>`, a list of `{ "op": "set", "path": "cards/<key>", "data": … }`:
   `{ project, id, title, status, priority, created: <today>, updated: <now>,
      branch: "", goal, acceptance, question: "", answer: "", result: "",
      phase, label, why, unlocks, model, effort,
      log: [{ at: <now>, who: "you", text: "planned" }] }`.
   Timestamps are local `YYYY-MM-DDTHH:mm`.
   - `model` and `effort`: `""`, so the card runs on the default the user set on the board (Settings, "Cards run on").
     Write a model or effort only when the user named one for that card.
   - `phase`: the plan phase `name` this card belongs to.
   - `label`: 1-3 words naming the card in the plan strip ("Design", "Outside services").
   - `why`: one line, what the user asked for, in plain words ("A design doc for the weekly attacker, no code").
   - `unlocks`: optional, what accepting the card lets happen next ("the build cards get made"), else `""`.

Finish by printing a table: id, title, status, priority. Nothing else.
