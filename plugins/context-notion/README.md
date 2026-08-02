# context-notion

The **Notion middle layer** for [context-kit](https://github.com/c-energie/context-kit):
generic Notion skills — actions, decisions, open questions, and the pending queue — driven
entirely by the *project's* configuration, so one install serves every Notion-backed project
(grid-flex and a thesis alike, each against its own workspace).

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

- **`databases`** — key → data-source ID. The keys `actions`, `decisionLog`, `openQuestions`
  are what the skills look for; extra databases (stakeholders, projects, …) are allowed and
  reachable by the pending queue if a schema names them.
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
| `add-pending` | Queue a row in the context repo's `pending/` when Notion is unreachable |
| `process-pending` | 🔒 Drain `pending/` into Notion (never self-triggers) |

## Scripts

```bash
node scripts/triage.mjs rows.json --today 2026-08-01     # due-date bucketing (--watching, --by-owner)
node scripts/pending-parse.mjs "$ROOT" --json            # parse/validate pending/; --drain results.json
node scripts/dates.mjs today                             # add weekly | add 3d | window 7 | age
node scripts/check-plugin.mjs .                          # repo lint — run before any commit
node scripts/bump-version.mjs . patch
```

`lib.mjs` holds the config load and the single definition of `bucket()` — what "overdue" /
"due soon" mean. `context-repo.sh` is a **copy of context-kit's** (plugins cannot reach into
each other's install directories) — keep the two in step.

## Port status (from net-flex/flexsense-plugin)

Ported and generalised: the actions/decisions/open-questions CRUD, the pending queue
(`pending-parse.mjs` intact — same entry format), `triage.mjs`, `bucket()`.

Not (yet) here: **`sync-notion-mirror` + `mirror-render.mjs`** — the mirror render must keep
its "unchanged Notion ⇒ no diff" property and needs a careful port, so FlexSense's version
remains the only one; mirror *reading* (the fallback in `notion-config`) already works against
any `notion/` directory regardless of what generated it. Also still in flexsense-plugin:
stakeholder/project capture + tidies, meeting synthesis, watch-list, weekly runner, Slack
digest — project-layer candidates, not generic.

**FlexSense migration path:** net-flex/context gains a `context.json` with `state.notion`
filled from flexsense-plugin's `scripts/flexsense.json`; the team then installs context-kit +
context-notion and the flexsense plugin shrinks to what's listed above. Until then, FlexSense
sessions keep using the flexsense plugin — don't run both against the same project.
