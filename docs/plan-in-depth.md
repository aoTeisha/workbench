# Plan in depth

The Workbench board's **Plan in depth** opened this chat in a project's folder and ran wayfinder (Matt Pocock's skills
plugin). This file is what Workbench adds around wayfinder. The user is here and answers in this chat.

- Workbench root: the folder that holds this file. Its `CLAUDE.md` has the document shapes.
- Board data: `node <root>/host/db.mjs` (`get`, `list cards --where project=<slug>`, `update <path> --file patch.json
  --if-version <N>`). Write each patch to a JSON file; pin every write with the version you read.

## 1. Before anything

1. If `/mattpocock-skills:wayfinder` did not run (unknown command), say: "Plan in depth needs Matt Pocock's skills.
   Run /setup in the Workbench folder, or in a terminal
   `claude plugin marketplace add https://github.com/mattpocock/skills.git` and then
   `claude plugin install mattpocock-skills@mattpocock -s user`; restart the app and press Plan in depth again." Then stop.
2. Read `projects/<slug>` and its cards. Plan from what exists: the goal (`body`), the plan (`plan.phases`,
   `plan.text`) and every card. Never plan a card that already exists.

## 2. The tracker

Local markdown, as in the plugin's `issue-tracker-local.md`: `.scratch/<effort>/map.md` and
`.scratch/<effort>/issues/NN-<slug>.md`, each issue with one `Type:` line and one `Status:` line (`open`, `claimed`,
`resolved`) near the top. The board counts `Status: resolved` to show "2 of 5 decided".

- Do not run `/setup-matt-pocock-skills` and do not write `docs/agents/`.
- In a git repo, add `.scratch/` to `.git/info/exclude` when it is not there (local only; never edit `.gitignore`).
- domain-modeling writes `CONTEXT.md` and `docs/adr/` in this folder; the board lists them as the project's
  knowledge. In a team repo, ask the user once before creating them.

## 3. A new map goes on the roadmap

Right after charting, add one phase to the project's plan (pinned update of `projects/<slug>`, the whole `plan`
object with every existing phase kept):

```json
{ "name": "Find the way: <effort, 1-3 words>", "note": "<the destination, one line>", "map": ".scratch/<effort>/map.md" }
```

At the end of `plan.phases` unless the user said where. Phase names stay unique in the project. A project with no plan
also gets `why` (one sentence, the user's words) and `text` (a `## <effort>` section holding the destination).

If wayfinder finds the way already clear (no map needed), say so and go to step 5 in this chat.

## 4. Continue (the link named a map)

Wayfinder works through that map: one decision per chat. When no open issue and nothing under "Not yet specified"
is left, offer to make the cards now (step 5).

## 5. Cards

Read `<root>/.claude/skills/plan-cards/SKILL.md` and do what it says (it is not a command in this folder). The map's
"Decisions so far" is the agreed plan. Its build phases replace the "Find the way" phase at the same place, so the
roadmap shows them where the map was.

## 6. Jira, once the cards exist

Ask once: "Create a Jira ticket for this, with a sub-ticket per card?" Only on yes:

1. Atlassian tools: `getAccessibleAtlassianResources` for the site, then ask which Jira project (`listJiraProjects`
   through `discover` when the user does not name one).
2. `listJiraProjectIssueTypesMetadata` for that project: the parent is `Task` (else `Story`); the sub-ticket type is
   the one with `subtask: true` (usually named `Subtask` on Jira Cloud).
3. Create the parent: summary = the effort's name, description = the destination and the new phases.
4. One sub-ticket per new card, parent = the parent's key: summary = the card's title, description = its goal and
   its acceptance as a checklist.
5. Write `jira: { "key": "<KEY>", "url": "https://<site>/browse/<KEY>" }` on each card (pinned update).

Nothing else in Jira: no transitions, assignees or comments. If a create fails, stop and say which cards have tickets.
