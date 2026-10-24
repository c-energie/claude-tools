---
name: update-action
description: Update existing rows in the project's Notion actions database — mark done, change status, re-date, reassign, or run a triage pass over what's open and overdue. Triggers like "mark that action done", "push that to Friday", "what's overdue", "close these out", "reassign this".
---

# Update actions / triage what's open

Changes existing rows in the project's **actions** database, and runs the triage view over
them. Requires the Notion (MCP) connection. **Read `notion-config` first.**

## Find the row(s)

Query `databases.actions` (from the config) and match on the title. Ambiguous match →
show the candidates and ask; never update a guessed row. **Empty result ≠ no actions** —
guest gap; check the mirror before concluding, but note the mirror can't be *updated* — an
edit needs live Notion, so a guest's edit becomes an `add-pending` note instead.

## Update

`schemas.actions` names the properties. Universal rules as ever: status values from the
schema's options; dates computed via `dates.mjs` and shaped per tool as `notion-config`
states; owners from the roster only. Update, then report what changed with the page URL.

## Triage ("what's overdue", "what's due this week")

Extract the open rows to JSON — `task` (the title text), `owner` (array of Notion user IDs),
`due`, `status`, optional `url` — and run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/triage.mjs" rows.json --today YYYY-MM-DD
```

The script owns the buckets — what "overdue" and "due soon" mean is its one definition
(`dueSoonDays` from the project's config) — don't re-derive them in prose. `--by-owner`
groups per person. Present its output, then offer the obvious next steps (mark done,
re-date) as updates.

**Write fails or no Notion?** Queue the change as a note via `add-pending` rather than
losing it.

**Not this skill:** a brand-new action is `add-action`.