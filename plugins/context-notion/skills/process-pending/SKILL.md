---
name: process-pending
description: Transfer the queue in the context repo's pending/ folder into the project's Notion databases — actions, decisions, open questions and more written by people without a Notion connection — then file what was transferred under pending/done/. Triggers like "process the pending queue", "transfer the pending items to notion", "what's waiting in pending", "drain the inbox".
disable-model-invocation: true
---

# Process the pending queue into Notion

Drains the context repo's **`pending/`** into the project's Notion databases, then files the
processed entries under `pending/done/`. **Read `notion-config` first.**

> **Writes live Notion rows and rewrites shared files — run only when asked.** Excluded from
> automatic invocation (`disable-model-invocation: true`).

Requires the Notion (MCP) connection and a project with `state.backend = "notion"` — and
**has no fallback**: transferring rows *is* the job. If the connection fails or returns
nothing (the guest gap), stop and say a workspace member has to run this. Leave the queue
exactly as it is — a drained queue with nothing in Notion loses the entries outright.

## 1. Read the queue

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --writable)"
node "${CLAUDE_PLUGIN_ROOT}/scripts/pending-parse.mjs" "$ROOT" --json
```

The script owns the format, aliases and validation — don't re-derive them from the markdown.
Each entry: `type`, `title`, `fields`, `ownerResolved` (roster-matched IDs), `file`, `line`,
plus:

- **`errors`** — would create a broken row. **Do not transfer**; leave in the queue and
  report with `file:line`. Never "correct" a date by guessing.
- **`warnings`** — transfer, but surface it. An unresolved owner is the one to watch.

Nothing waiting is a good outcome — say so and stop.

## 2. Map each type to a database

`context.json`'s `databases` + `schemas` decide where each entry type can go: `action` →
`actions`, `decision` → `decisionLog`, `open-question` → `openQuestions`; `stakeholder` /
`project` only if the project defines databases for them. **An entry whose type has no
database in this project is held back**, reported as such — the fix is a line in
`context.json`, not a guessed destination.

For stakeholders/projects (the two that collide): query the target for existing names first,
including acronyms/aliases, and propose updating rather than duplicating.

## 3. Present the batch and get confirmation

Grouped by target database: creates, updates, held back (and why), unresolved owners. **Get
an explicit yes before writing** — there is no delete tool on this connection.

## 4. Create the rows

Per the sibling skills' rules (`add-action`, `log-decision`, `add-open-question`) and the
schema: title is the title only; `ownerResolved` IDs for person fields (empty → omit);
every date as `start` + `is_datetime` = `0`; `notes` lands in the row's notes/description
property rather than being dropped. The create's parent id comes from `pageParents.<key>`,
never `databases.<key>` — the two-ids rule, and the missing-`pageParents` runtime fallback,
in `notion-config` apply here unchanged. Batch per database; keep the returned URLs.

## 5. Drain the queue

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pending-parse.mjs" "$ROOT" --drain results.json
```

`results.json` = `[{"file": "pending/actions.md", "line": 20, "notionUrl": "https://…"}]` —
exactly as step 1 reported them, **only entries actually created**. The script moves each to
`pending/done/YYYY-MM-DD-processed.md` with its URL. If it reports a line mismatch, someone
pushed underneath you: re-run step 1, drain with fresh numbers. Never hand-edit the queue
files to do this — the failure mode is an untransferred entry vanishing in a rewrite.

## 6. Commit, then ask before pushing

Show `git -C "$ROOT" status --short pending/`, **get an explicit yes**, then add `pending/`,
commit (`pending: transfer to Notion (YYYY-MM-DD)`), push. Push fails on credentials →
report the commit and tell the user to push themselves.

## 7. Report

Per database: created, updated, held back (with `file:line` and reason), owners that didn't
resolve — a recurring unresolved name means it's missing from `context.json`'s
`state.notion.people`, a one-line fix worth naming. If rows landed name-only and the project
has enrichment skills, point at them.

**Not this skill:** writing a new entry into the queue is `add-pending`. A single row when
Notion is reachable goes straight in via the direct skills.