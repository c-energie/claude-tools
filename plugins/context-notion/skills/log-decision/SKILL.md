---
name: log-decision
description: Log a key decision to the project's Notion decision-log database (which database comes from the project's config, workspace.json or a legacy context.json). Use whenever a decision is reached that should be recorded — triggers like "log that to the decision log", "record this decision", "add a decision".
---

# Log a decision

Records a decision as a row in the project's **decision log**. Requires the Notion (MCP)
connection. **Read `notion-config` first** — config resolution, guest gap, fallback ladder.

## Target

The **decision log** from the project's config (`notion-config` §1): create via `API-post-page` with
parent `{type: "database_id", database_id: pageParents.decisionLog}` — never
`databases.decisionLog`, the read-side data source id (it draws the misleading "not shared"
404; see `notion-config` on the two ids). A `notion-create-pages`-style tool instead takes
`databases.decisionLog` as its `data_source_id` parent. `pageParents` missing → resolve per
`notion-config`, write, then offer to add it. No `decisionLog` key → say so and stop.

## Properties

`schemas.decisionLog` is authoritative. Universally:

- The **title is the decision itself**, stated as the outcome ("Register the company via ANNA
  Money"), not the topic ("company registration").
- **Capture the why**: rationale, alternatives considered, and anything superseded go in the
  schema's notes/rich-text property — a decision without its reasoning re-litigates itself in
  six months.
- The decision **date**, shaped per tool as `notion-config` states; owners from the roster.
- If the schema has a revisit/review property, ask whether this decision is provisional and
  set it — provisional decisions that look permanent are how stale rules survive.

## Steps

1. Confirm the decision wording and who made it, if ambiguous.
2. Check the log for an earlier decision on the same topic (`query-decisions`) — if one
   exists, say so and record this one as superseding it (per the schema's convention) rather
   than leaving two contradictory rows unmarked.
3. Create the page; report the URL.

**Write fails or no Notion?** `add-pending`.

**Not this skill:** reading the log is `query-decisions`; something still unresolved is
`add-open-question`.