---
name: notion-discover
description: Discover a project's Notion workspace into its workspace.json state block — enumerate the databases the project's declared Notion connection can see, capture their IDs and exact property schemas, map them to the actions/decisionLog/openQuestions keys, and write state.notion with the user's confirmation. Triggers like "fill in the notion state block", "fill in the workspace.json state block", "discover my notion workspace", "wire up notion for this project", "set up the notion databases", "map my notion databases".
---

# Discover a Notion workspace into the project's config

Turns a project's `"state": null` into a working `state.notion` block — the one step between
"connector wired up" and "the Notion skills work here". **Read `notion-config` first**; this
skill writes the very contract that file defines.

## 1. Resolve the project and its connection

Resolve the config as `notion-config` §1 does — on a laptop:

```bash
ROOT="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs")"
CONFIG="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/layout.mjs" "$ROOT" config)"
```

`$CONFIG` is the workspace's `.claude/workspace.json` (the uploaded copy + GitHub connector in a
sandbox). Read it. `connections.notion` names the ONLY Notion connection to use — if it is
missing, or that server's tools are absent from this session, stop and point the user at
context-kit-core's `setup-connectors` rather than using another project's connection. No
workspace at all: point them at project-workspace's `setup-project-workspace`.

## 2. Enumerate what the connection can see

Search/list databases through the declared connection. **Zero results has a specific
meaning:** a token-based integration only sees pages explicitly shared with it — tell the
user to open the workspace's top-level page(s) → `•••` → Connections → add the integration,
then re-run. Don't diagnose it as an empty workspace.

## 3. Capture each database faithfully

For each database: **both its ids** — the data source id (→ `databases`) and, from
`parent.database_id` in the same data source response, the database id (→ `pageParents`;
page creates need it — see `notion-config` on the two ids) — its title property's name, and
every property as `"Name": "type — options/notes"`:

- **Reproduce property names EXACTLY** — odd spellings, capitalisation, trailing spaces.
  "Fixing" a name here writes the trap into config and every skill inherits it silently.
- List select/status options verbatim, and note the sensible default where one is obvious.
- Note date properties as `date — YYYY-MM-DD (shape per notion-config)`. Name no tool's wire
  form here: the flattened and REST tools want different shapes, and a line written for one
  is copied into every new project and breaks every write through the other.

## 4. Propose the mapping — the judgement step

Map databases to the keys the skills look for — `actions`, `decisionLog`, `openQuestions` —
by purpose, not name (a database called "Tasks" is probably `actions`). Extra databases get
their own descriptive keys. **Show the user the complete proposed `state.notion` block**
(`databases`, `pageParents` — keyed identically, one data source id and one database id per
database — schemas, `people` — from the connection's user listing where available, else
just the user with their Notion user ID — and `defaults` with `dueSoonDays: 7`), including
which databases you could NOT map, **and get an explicit yes before writing anything.**

## 5. Write it back — `state.backend` and `state.notion` only, gated

This skill owns two keys of the config: `state.backend` (set to `"notion"`) and `state.notion`.
**Nothing else** — other `state.*` blocks belong to the plugins that read them, `connections`
to `setup-connectors`, and in a workspace `schema` / `name` / `repo` / `members` to
`project-workspace`. Replacing `state` wholesale, as this step once did, erases a sibling block
in a commit titled as a Notion change.

- **Laptop:** save the agreed block (the value of `state.notion`, not the whole `state`) to a
  file, then plan and write it with the script, which merges it into `state` and leaves every
  other byte of the file alone:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/notion-state.mjs" "$CONFIG" notion-block.json          # plan
  node "${CLAUDE_PLUGIN_ROOT}/scripts/notion-state.mjs" "$CONFIG" notion-block.json --write
  ```

  It refuses (exit 1, nothing written) a file that does not parse or a `state` that is not an
  object — report that, never hand-edit around it. Show `git -C "$ROOT" diff`, commit
  (`config: discover Notion state block`) and **ask before the push**.
- **Sandbox (Cowork):** read the whole file, change only `state.backend` and `state.notion`
  (every other key of `state` and of the file kept exactly), and write the whole file back —
  never rebuild it from memory. The connector write is an immediate commit to the default branch —
  the ask-before-writing above IS the gate; say it is already live once done.

## 6. Verify and hand over

Reload `$CONFIG` and confirm it parses and the block is present (on a laptop,
`node "${CLAUDE_PLUGIN_ROOT}/scripts/pending-parse.mjs" "$ROOT"` loading without a
"declares no Notion backend" note proves the scripts see it). Then tell the user what just
became available: `add-action`, `log-decision`, `add-open-question`, `query-decisions`,
`update-action` now work in this project, against these databases.

**Not this skill:** wiring the connector itself (config files, tokens) is context-kit-core's
`setup-connectors`; making a folder a workspace is project-workspace's `setup-project-workspace`; day-to-day reads and writes are the skills this unlocks.
