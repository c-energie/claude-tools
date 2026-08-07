---
name: sync-notion-mirror
description: Refresh the read-only mirror of the project's Notion databases into its context repo (notion/) so teammates without a working Notion connection can still read the actions, open questions, decision log and whatever else the project mirrors. Triggers like "sync the notion mirror", "refresh the notion export", "update the mirror", "how stale is the notion mirror".
disable-model-invocation: true
---

# Sync the Notion mirror into the context repo

Pulls the project's Notion databases and regenerates the context repo's `notion/` — the
committed, read-only copy that teammates without the Notion connector can read. **Read
`notion-config` first**; every ID, schema and person below comes from the project's
`context.json`.

**Why this exists:** the Notion connector only works fully for a workspace **member**. A
**guest**'s queries return empty results rather than errors, so their sessions see nothing at
all. The mirror is what they read instead — and what the other skills fall back to.

> **Commits to a shared repo — run only when asked.** Excluded from automatic invocation
> (`disable-model-invocation: true`). `weekly-review` offers it; that is the normal way it runs.

Requires the Notion connection this project declares — and unlike the skills that *read* Notion,
**this one has no fallback**: it is what writes the mirror. If the connection fails or returns
nothing, stop and say a member has to run it. Never regenerate the mirror from a partial read;
that replaces good rows with an empty file.

## 1. Find the context checkout

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --writable)"
```

Stop if it exits non-zero — say so rather than writing somewhere else. Today's date:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" today`.

`cat "$ROOT/notion/_synced.json"` tells you when this last ran, per database. If it ran today
and nothing has changed in Notion, say so and stop — a no-op commit is noise.

## 2. Pull the databases

The keys and IDs are in `context.json`'s `state.notion.databases`; the property names are in
`schemas`. Read them there, don't retype them. Query each with the project's Notion connection,
and **page until you have every row**: a truncated result set doesn't look truncated once it's
rendered, it just looks like rows were deleted.

The mirror is a **working view, not a full export** — mirror what a reader without Notion would
need to answer a question. Sensible defaults, unless the project says otherwise:

| Database | Include |
|---|---|
| `actions` | open work only — exclude done rows, and exclude `Watching` rows |
| `openQuestions` | unresolved only — exclude closed |
| `decisionLog` | everything (it is the record; nothing ages out) |
| anything else the project declares | everything, unless it has an obvious "closed" state |

`Watching` rows are excluded deliberately: they are `check-watchlist`'s reminders, and their
date means *next check*, not deadline — mirrored alongside real actions they read as a pile of
overdue work.

**The decision log needs a second pass.** Its rationale is usually **not a property** — it lives
in the page *body*, under a `## Why` / `## Context` heading or a `**Why:**` line. So after the
query, fetch each decision page and condense its body into the `rationale` field. Skipping this
produces a mirror of decisions with no reasons in it, which is the half that matters: the log
exists to answer *why*, and `query-decisions` promises the mirror can answer that. Some pages
are genuinely blank — leave `rationale` out for those rather than inventing one.

## 3. Build the export JSON

Write one file (a scratch path, **not** inside the repo), keyed by the same database keys
`context.json` uses. The renderer's header comment carries the full field list; the three
contract keys have purpose-built layouts:

```json
{
  "actions":       [{"task": "...", "owner": "user://...", "due": "YYYY-MM-DD",
                     "status": "...", "workstream": ["..."], "url": "https://notion.so/..."}],
  "openQuestions": [{"question": "...", "type": "...", "status": "...", "chasing": "user://...",
                     "opened": "YYYY-MM-DD", "url": "..."}],
  "decisionLog":   [{"decision": "...", "decided": "YYYY-MM-DD", "owner": "user://...",
                     "rationale": "...", "revisit": "...", "url": "..."}]
}
```

Any **other** database the project declares renders as a generic table — pass it as rows, or
with presentation, which is worth doing when the field order matters:

```json
{ "stakeholders": { "title": "Stakeholders & companies", "titleKey": "name",
                    "note": "one line shown under the count",
                    "columns": ["org", "priority", "owner"],
                    "rows": [{"name": "...", "url": "..."}] } }
```

- **`url` is the Notion page URL** and matters more than it looks: it is the only way a reader of
  the mirror gets from a clipped summary back to the real row.
- Person fields can stay as raw `user://` IDs — the renderer resolves them through the roster.
- **Copy values across; don't summarise them.** A rewritten description is a second version of a
  fact that then disagrees with Notion. The renderer does the clipping.
- Follow `schemas` exactly as you map, trailing spaces and odd spellings included.

**Only include a database you actually queried.** One left out of the JSON is left untouched on
disk and carried forward in `_synced.json` with its own date — that is how a partial sync stays
safe, so don't write `"actions": []` to mean "didn't fetch". An empty array means "Notion has no
open actions" and blanks the file.

## 4. Render

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mirror-render.mjs" "$ROOT" export.json
```

Writes `notion/*.md`, `notion/*.json` and `notion/_synced.json`. Formatting, sort order, grouping
and clipping all live in the script so that two syncs with no Notion changes produce **no diff** —
don't hand-edit its output to make it read better, or every future sync fights your edit.
`--dry-run` shows what it would write; `--today YYYY-MM-DD` pins the stamp.

Read its report: rows skipped for a missing title, and any owner that came out as "Unknown owner"
(an ID not in `state.notion.people`) are real problems in Notion or in the roster, worth
mentioning to the user.

## 5. Show the diff, then ask before committing

```bash
git -C "$ROOT" diff --stat notion/
```

**Show it and get an explicit yes before committing.** The interesting part is what *changed in
Notion since the last sync* — summarise that in a line or two (rows added, decisions logged,
actions closed), because it is the most useful thing to come out of this run. A diff touching
every line means the renderer changed, not Notion; check that before committing.

```bash
git -C "$ROOT" add notion/ && git -C "$ROOT" commit -m "notion: sync mirror (YYYY-MM-DD)" && git -C "$ROOT" push
```

If the push fails on credentials, report the commit and tell the user which checkout to push
from — `$ROOT` is printed by the resolver.

**Not this skill:** transferring the queue in `pending/` *into* Notion is `process-pending` (the
other direction). Enriching sparse rows is `tidy-stakeholders` / `tidy-projects`. Condensing
`memory.md` and the threads is context-kit-core's `curate-context`.
