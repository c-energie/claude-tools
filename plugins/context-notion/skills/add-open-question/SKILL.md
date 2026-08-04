---
name: add-open-question
description: Add one or more open questions to the project's Notion open-questions database (which database comes from the context repo's context.json). Use when an unresolved question or uncertainty should be tracked — triggers like "add an open question", "log these open questions", "capture what's unresolved".
---

# Add an open question

Records unresolved questions as rows in the project's **open-questions** database. Requires
the Notion (MCP) connection. **Read `notion-config` first** — config resolution, guest gap,
fallback ladder.

## Target

The **open-questions** database from the project's `context.json`: create via
`API-post-page` with parent `{type: "database_id", database_id: pageParents.openQuestions}`
— never `databases.openQuestions`, the read-side data source id (the misleading "not
shared" 404; see `notion-config` on the two ids). A `notion-create-pages`-style tool
instead takes `databases.openQuestions` as its `data_source_id` parent (one call for
several questions). `pageParents` missing → resolve per `notion-config`, write, then offer
to add it. No `openQuestions` key → say so and stop.

## Properties

`schemas.openQuestions` is authoritative — **including any oddly named property; trailing
spaces in property names exist and must be reproduced, never trimmed.** Universally:

- The **title is the question itself**, phrased as a question. Ownership, status, category go
  in their properties.
- Owners from the roster only; omit when unknown.
- Any date property: `start` + `is_datetime` = `0`.
- Select/status values from the schema's listed options.

## Steps

1. Confirm the question wording — a good row is a question a stranger could pick up.
2. Create the page(s); report URL(s).

**Write fails or no Notion?** `add-pending`, never a retry loop, never dropped.

**Not this skill:** a settled conclusion is `log-decision`; a task with an owner is
`add-action`.