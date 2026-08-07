# context-notion

The **Notion middle layer** for [context-kit](https://github.com/c-energie/context-kit):
generic Notion skills — actions, decisions, open questions, and the pending queue — driven
entirely by the *project's* configuration, so one install serves every Notion-backed project
(a product repo and a thesis alike, each against its own workspace).

Install **alongside context-kit** (same marketplace). Nothing in this plugin names a specific
database or person: all of that comes from the context repo's `context.json`.

## The contract: `context.json` → `state.notion`

A project opts in by declaring, in its context repo's `context.json`:

```json
{
  "state": {
    "backend": "notion",
    "notion": {
      "databases": {
        "actions":       "collection://00000000-0000-0000-0000-000000000000",
        "decisionLog":   "collection://00000000-0000-0000-0000-000000000001",
        "openQuestions": "collection://00000000-0000-0000-0000-000000000002"
      },
      "pageParents": {
        "actions":       "00000000-0000-0000-0000-000000000100",
        "decisionLog":   "00000000-0000-0000-0000-000000000101",
        "openQuestions": "00000000-0000-0000-0000-000000000102"
      },
      "schemas": {
        "actions": {
          "title": "Task",
          "properties": {
            "Owner":    "person — resolve from people below, never notion-search",
            "Due date": "date — YYYY-MM-DD, set is_datetime 0",
            "Status":   "status: Not started | In progress | Done (default Not started)"
          }
        },
        "decisionLog": {
          "title": "Decision",
          "properties": {
            "Owner": "person",
            "Date":  "date — when decided",
            "Notes": "rich_text — rationale, alternatives considered"
          }
        },
        "openQuestions": {
          "title": "Question",
          "properties": { "Owner": "person", "Status": "status: Open | Answered" }
        }
      },
      "people": [
        { "name": "Jamie", "notionUserId": "…", "slackMemberId": null, "notionRole": "member" }
      ],
      "defaults": { "dueSoonDays": 7 }
    }
  }
}
```

- **`databases`** — key → **data source ID**, the *read-side* id: retrieving a schema
  (`API-retrieve-a-data-source`) and querying rows (`API-query-data-source`) take these. The
  keys `actions`, `decisionLog`, `openQuestions` are what the skills look for; extra
  databases (stakeholders, projects, …) are allowed and reachable by the pending queue if a
  schema names them.
- **`pageParents`** — key → **database ID**, keyed identically: creating a page
  (`API-post-page`) needs one as `parent.database_id`. Notion exposes two ids per database
  and they are NOT interchangeable — a create given a data source id fails with a 404
  claiming the database isn't shared with the integration, which names the wrong cause
  (sharing is fine; the id is the wrong kind). A config written before this map existed
  still works: the write skills resolve the database id at runtime and offer to add the map
  (see `notion-config`).
- **`schemas`** — per-database: the **title property's name**, then each property as
  `"Name": "type — notes/options"`. Free-form strings the skills read and follow **exactly,
  including any odd spelling or trailing space in a property name** (they exist; never trim).
- **`people`** — the roster. Owners are resolved HERE, never via `notion-search`: workspace
  *guests* are invisible to search, and the lookup failing silently is how rows lose owners.
  `notionUserId: null` for someone whose ID is unknown — the skills then omit the property,
  because a person field that is confidently wrong is worse than an empty one.
- **`defaults.dueSoonDays`** — what "due soon" means in triage.

The skills read this at runtime (via the context-kit resolver); the scripts read it the same
way, or from an explicit `CONTEXT_CONFIG=/path/to/context.json` (no bash/git needed then).
`"state": null` or a different backend → every skill here says so and stands down; structured
items can still be queued in the context repo's `pending/`.

## Skills

| Skill | What it does |
| --- | --- |
| `notion-config` | _(hidden)_ The contract above + the guest gap, property traps, fallback ladder |
| `add-action` | Add rows to the project's actions database |
| `add-open-question` | Add rows to the open-questions database |
| `log-decision` | Record a decision in the decision log |
| `query-decisions` | Read the decision log: by topic, recent, due-to-revisit |
| `update-action` | Close / re-date / reassign actions; triage what's open (via `triage.mjs`) |
| `notion-discover` | Discover a workspace into `context.json`'s `state.notion` — the setup step that unlocks the rest |
| `add-pending` | Queue a row in the context repo's `pending/` when Notion is unreachable |
| `process-pending` | 🔒 Drain `pending/` into Notion (never self-triggers) |
| `check-watchlist` | The watch-until-it-opens items in the actions database: review, roll on, or convert |
| `list-people` | Read the individuals out of the project's stakeholders database |
| `tidy-stakeholders` | Enrich sparse stakeholder rows from public sources; flag duplicates and misfilings |
| `tidy-projects` | The same for the register of external projects the project tracks |
| `capture-project` | Create a tracked-project row from a URL or a name: duplicate check, research, link the organisations |
| `synthesise-meeting` | Write a meeting up into the context repo's `meetings/`, then log its core items |
| `sync-notion-mirror` | 🔒 Regenerate the read-only `notion/` mirror (via `mirror-render.mjs`) |
| `weekly-review` | The recurring runner: which of the above to run each week, in order |

Only `actions`, `openQuestions` and `decisionLog` are contract keys. The rest of the table
works off whatever *other* database keys a project declares (`stakeholders`, `relatedProjects`,
`meetings`, …) — a project without one simply doesn't get that skill's job, and the skill says
which key is missing rather than hunting for a database by search.

## Scripts

```bash
node scripts/triage.mjs rows.json --today 2026-08-01     # due-date bucketing (--watching, --by-owner)
node scripts/pending-parse.mjs "$ROOT" --json            # parse/validate pending/; --drain results.json
node scripts/mirror-render.mjs "$ROOT" export.json       # render the notion/ mirror (--dry-run, --today)
node scripts/vtt-to-text.mjs meeting.vtt --out out.txt   # transcript → compact speaker-labelled text
node scripts/dates.mjs today                             # add weekly | add 3d | window 7 | age
node scripts/check-plugin.mjs .                          # repo lint — run before any commit
node scripts/bump-version.mjs . patch
```

`lib.mjs` holds the config load and the single definition of `bucket()` — what "overdue" /
"due soon" mean. `context-repo.sh` is a **copy of context-kit's** (plugins cannot reach into
each other's install directories) — keep the two in step.

`mirror-render.mjs` owns the `notion/` folder. Its defining property is **unchanged Notion ⇒
no diff**, so `git diff notion/` reads as a changelog — which is why the mirror is never
hand-edited. It renders `actions`, `openQuestions` and `decisionLog` with purpose-built
layouts and **any other database key as a generic table**, so a project can mirror databases
this plugin has never heard of.

## Roadmap

Slack delivery — the per-person digest and the pending-queue nudge — lives in its sibling
[`context-slack`](../context-slack/), which reads the same roster (`slackMemberId`) and the same
`defaults.slackChannel`. `weekly-review` offers the digest when that plugin is installed and
skips the line when it isn't.
