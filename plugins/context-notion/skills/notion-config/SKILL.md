---
name: notion-config
description: How the context-notion skills find and use a project's Notion configuration — the context.json state.notion contract, the workspace-guest gap, the property traps, and the fallback ladder. Background knowledge for every skill in this plugin; not a task to run.
user-invocable: false
---

# The project's Notion configuration

Every skill in this plugin is generic: which databases, which properties, which people all
come from the **project's context repo**, at runtime. This skill is the one place that
procedure lives.

## 1. Resolve the config

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --no-pull)"
```

Read `$ROOT/context.json`. (No shell — Cowork? Read `context.json` from the context repo over
the GitHub MCP connector instead. Which repo: the `PROJECT_CONTEXT_REPO` env value in the
project's `.claude/settings.json` if that file is visible, else a one-line `.context-repo` /
`context-repo.txt` plain marker, or a `context-project.json` JSON marker whose `contextRepo` and `connections` keys name the repo AND the MCP connection per provider, in the working folder, `/mnt/project/`, or `~/mnt/.projects/*/docs/` — that marker, attached to
the Cowork project, is how a sandbox with no repo files and no env vars learns the name —
if none is found, say no context repo is configured — never guess one.)

- `state.backend` must be `"notion"`. If it is missing, `null`, or something else: **say this
  project declares no Notion backend and stop.** Don't guess a database. Structured items can
  still be queued with `add-pending` — the queue needs no backend.
- **`connections` (top level of context.json) gates which connectors serve this project** —
  e.g. `{ "github": "github-thesis", "notion": "notion-thesis" }`, naming MCP server
  namespaces (`mcp__notion-thesis__…` tools). A machine can hold several workspace-scoped
  connections; **use ONLY the one this project declares** for each provider. If several
  Notion connections are visible and the project declares none, **ask the user which — never
  guess**: writing through another project's connection puts rows in the wrong workspace.
- `state.notion.databases` — key → **data source ID**, the read-side id (schemas, queries).
  Skills name the key they need (`actions`, `decisionLog`, `openQuestions`); a project may
  define more.
- `state.notion.pageParents` — key → **database ID**, keyed like `databases`: the id a page
  create needs as `parent.database_id`. May be absent from older configs — see §2.
- `state.notion.schemas.<key>` — the title property's name, then each property as
  `"Name": "type — options/notes"`. **Follow it exactly, including odd spellings and trailing
  spaces in property names** — they exist in real workspaces and "fixing" them writes to a
  property that isn't there, silently.
- `state.notion.people` — the roster. **This is the only place to resolve a person.**
- `state.notion.defaults` — e.g. `dueSoonDays`.

If a skill needs a database key or schema the project doesn't define, say which key is missing
from `context.json` — a one-line fix — rather than improvising against a database found by
search.

## 2. The two Notion ids

Notion exposes **two ids per database**, and the API takes a different one per direction:

- **Reads** — retrieving a schema (`API-retrieve-a-data-source`) and querying rows
  (`API-query-data-source`) take the **data source id**: `databases.<key>`.
- **Page creates** — `API-post-page` takes the **database id** as `parent.database_id`:
  `pageParents.<key>`. (A `notion-create-pages`-style tool that takes a `data_source_id`
  parent instead wants `databases.<key>`, minus any `collection://` prefix.)

They are not interchangeable. A create given a data source id fails with
`404 object_not_found — Could not find database with ID: … Make sure the relevant pages and
databases are shared with your integration`. **That message names the wrong cause**: sharing
is fine, the id is the wrong kind. Never respond by re-sharing databases — check which map
the id came from.

**`pageParents` missing** (a `state.notion` written before the map existed): resolve at
runtime — retrieve the data source with `databases.<key>` and read `parent.database_id`
from the response — and proceed with the write. Then tell the user their `context.json`
predates `pageParents` and offer to add it (the ids just resolved, keyed like `databases`);
never rewrite `context.json` unasked.

## 3. The workspace-guest gap

The Notion connector only works fully for a workspace **member**. For a **guest**: reads
return *empty* (zero rows, no error) and writes fail, also silently. Therefore:

- **An empty result is never evidence of absence.** Before answering "there are none", check
  the fallback (below) or say the result may be the guest gap.
- **Never resolve people via `notion-search`** — guests are invisible to it, and the person
  property ends up silently empty. Use the roster; `notionUserId: null` → omit the property
  and say so. A person field that is confidently wrong is worse than an empty one.

## 4. Fallback ladder

- **Reads:** if Notion returns empty or fails, fall back to the context repo's `notion/`
  mirror if the repo has one — and **label the answer with its `syncedOn` date** (from
  `notion/_synced.json`). The mirror is a snapshot: Notion wins over it. No mirror either →
  say the read couldn't be done, not "there are none".
- **Writes:** if Notion can't be written, **don't retry and don't drop it — `add-pending`**
  queues it in the context repo for someone with access to transfer.
- State which route produced an answer (live Notion, mirror + date, or queued) — provenance
  differs and the user needs to know which they got.

## 5. Property traps (all workspaces)

- **The title is the title.** Owners, dates, statuses go in properties, never in the title
  text — "Adam — chase UKPN — 5 Aug" arrives as an unfilterable row.
- **Every date property needs both** `date:Name:start` (`YYYY-MM-DD`) **and**
  `date:Name:is_datetime` = `0`. Compute dates with
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs"` (`today`, `add 3d`, `add weekly`) — never
  work out "next Friday" by hand.
- **Use existing select/status options only** (the schema lists them) unless the user
  explicitly asks to add a new option.
- **There is no delete tool** on this connection. A wrong row must be removed by hand in the
  Notion UI — which is why write skills confirm before creating.