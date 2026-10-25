---
name: add-action
description: Add one or more action items to the project's Notion actions database (which database comes from the project's workspace.json). Use when a task/action with an owner (and optional due date) needs tracking — triggers like "add an action", "log these action items", "capture these to-dos".
---

# Add an action

Records action items as rows in the project's **actions** database. Requires the Notion (MCP)
connection. **Read `notion-config` first** — it defines how to resolve the project's config,
the guest gap, and the fallback ladder.

## Target

The **actions** database from the `state.notion` block of the project's config (`notion-config` §1). Which id
parents the create depends on the tool (see `notion-config` on the two ids):

- `API-post-page` → parent `{type: "database_id", database_id: pageParents.actions}` —
  never `databases.actions`, whose data source id draws the misleading "not shared" 404.
  No `pageParents` in the config → resolve per `notion-config`, write, then offer to add it.
- A `notion-create-pages`-style tool → parent
  `{type: "data_source_id", data_source_id: databases.actions}` (strip any `collection://`
  prefix).

Multiple actions go in **one** call where the tool takes an array of pages. No `actions`
key in the config → say so and stop; the fix is a line in the config.

## Properties

`schemas.actions` names the title property and the rest — follow it exactly. Universally:

- The **title is the action as an imperative** ("Draft the DNO one-pager") — never fold the
  owner or date into it; those go in their properties.
- **Owner-type properties**: user IDs from the roster (`state.notion.people`) — never
  `notion-search`. Unknown or `null` ID → omit the property and say so.
- **Date properties**: shaped per tool — the flattened and REST forms differ, and `notion-config`
  holds the one rule. Dates from `dates.mjs`, not head-math.
- **Status**: the schema's listed options only; use its stated default when the user didn't
  say.

## Steps

1. Confirm task list, owners and due dates if ambiguous.
2. Create the page(s) in one call/batch, parent per Target above.
3. Report the new page URL(s).

**If Notion can't be reached or the write fails** — don't retry, don't drop it: `add-pending`.

**Not this skill:** changing an existing row is `update-action`; an unresolved question is
`add-open-question`.
