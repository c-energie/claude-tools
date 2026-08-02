---
name: notion-discover
description: Discover a project's Notion workspace into its context.json state block — enumerate the databases the project's declared Notion connection can see, capture their IDs and exact property schemas, map them to the actions/decisionLog/openQuestions keys, and write state.notion with the user's confirmation. Triggers like "fill in the context.json state block", "discover my notion workspace", "wire up notion for this project", "set up the notion databases", "map my notion databases".
---

# Discover a Notion workspace into context.json

Turns a project's `"state": null` into a working `state.notion` block — the one step between
"connector wired up" and "the Notion skills work here". **Read `notion-config` first**; this
skill writes the very contract that file defines.

## 1. Resolve the project and its connection

Resolve the context repo (`context-repo.sh` on a laptop; the marker + GitHub connector in a
sandbox) and read `context.json`. `connections.notion` names the ONLY Notion connection to
use — if it is missing, or that server's tools are absent from this session, stop and point
the user at `context-setup` / the connector setup script rather than using another
project's connection.

## 2. Enumerate what the connection can see

Search/list databases through the declared connection. **Zero results has a specific
meaning:** a token-based integration only sees pages explicitly shared with it — tell the
user to open the workspace's top-level page(s) → `•••` → Connections → add the integration,
then re-run. Don't diagnose it as an empty workspace.

## 3. Capture each database faithfully

For each database: its ID, its title property's name, and every property as
`"Name": "type — options/notes"`:

- **Reproduce property names EXACTLY** — odd spellings, capitalisation, trailing spaces.
  "Fixing" a name here writes the trap into config and every skill inherits it silently.
- List select/status options verbatim, and note the sensible default where one is obvious.
- Note date properties as `date — YYYY-MM-DD with is_datetime 0`.

## 4. Propose the mapping — the judgement step

Map databases to the keys the skills look for — `actions`, `decisionLog`, `openQuestions` —
by purpose, not name (a database called "Tasks" is probably `actions`). Extra databases get
their own descriptive keys. **Show the user the complete proposed `state.notion` block**
(databases, schemas, `people` — from the connection's user listing where available, else
just the user with their Notion user ID — and `defaults` with `dueSoonDays: 7`), including
which databases you could NOT map, **and get an explicit yes before writing anything.**

## 5. Write it back — whole-file, gated

Read the current `context.json`, set `"state": { "backend": "notion", "notion": { … } }`,
and write the **whole file** back — never rebuild it from memory; the file also carries
`connections` and template metadata that must survive.

- **Laptop:** edit the checkout, show the diff, commit and push (`config: discover Notion
  state block`) — ask before the push.
- **Sandbox (Cowork):** the connector write is an immediate commit to the default branch —
  the ask-before-writing above IS the gate; say it is already live once done.

## 6. Verify and hand over

Reload `context.json` and confirm it parses and the block is present (on a laptop,
`node "${CLAUDE_PLUGIN_ROOT}/scripts/pending-parse.mjs" "$ROOT"` loading without a
"declares no Notion backend" note proves the scripts see it). Then tell the user what just
became available: `add-action`, `log-decision`, `add-open-question`, `query-decisions`,
`update-action` now work in this project, against these databases.

**Not this skill:** wiring the connector itself (config files, tokens) is `context-setup` /
the setup scripts; day-to-day reads and writes are the skills this unlocks.
