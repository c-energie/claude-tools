---
name: add-pending
description: Queue an action, decision, open question, stakeholder or project in the project's pending queue (.context/pending/ in a workspace, pending/ in a legacy context repo) when the Notion connection is unavailable — the fallback for workspace guests and offline sessions. Triggers like "add this to pending", "queue this for Notion", "log this, I have no Notion access", and any add-action / log-decision request that fails because Notion cannot be reached.
---

# Queue something for Notion

Writes an entry into the project's **pending queue** — `.context/pending/` in a workspace,
`pending/` in a legacy context repo — the inbox for sessions that can't reach Notion. Someone with a working connection transfers it later with `process-pending`.

**When to use this instead of the direct skill:** if Notion works, use the real skill — a
pending entry is a delay, not a destination. If a Notion write fails or returns nothing
(workspace *guests* fail silently — see `notion-config`), **don't retry and don't drop it —
come here.** If the user says "queue it" / "no Notion access", come here directly. Works even
when the project declares no Notion backend at all — the queue needs none.

**Writes to a shared repo, so it asks before committing** (step 4) and never pushes on its own.

## 1. Find the queue

```bash
ROOT="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" --writable)"
PENDING="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/layout.mjs" "$ROOT" pending)"
```

`workspace.mjs` finds the nearest `.claude/workspace.json` and falls back to the context repo
(stderr names the `route=`); `layout.mjs` says where that root keeps the queue. Use `$PENDING`
as given — never type `pending/` or `.context/pending/` yourself: a guess that picks the other
layout commits the entry where `process-pending` never looks. Stop if either exits non-zero —
say so rather than writing the entry somewhere else, which loses it. Dates via `node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs"` (`today`, `add 3d`, `add
weekly`) — never head-math.

**No shell?** (Cowork.) Write through the GitHub connector — in a workspace (a `.claude/workspace.json`
is visible) to the repo its `repo` key names, under `.context/pending/`; otherwise to the context
repo's `pending/`. Read the target file, append,
write the **whole file** back — never reconstruct it. There the write *is* the commit and the
push, so the ask-before-committing gate applies to the write itself, and "tell them to push"
becomes "it is already visible". Work the date out in prose and say you did.

## 2. Pick the file

| What it is | File |
|---|---|
| A task with an owner | `$PENDING/actions.md` |
| Something settled, and why | `$PENDING/decisions.md` |
| Something unresolved | `$PENDING/open-questions.md` |
| A person or an organisation | `$PENDING/stakeholders.md` |
| An external funded project or trial | `$PENDING/projects.md` |

Create the file if the repo doesn't have it yet. If it exists, read its top first — it may
list the fields that file accepts.

## 3. Append the entry

At the **bottom**, in the format `pending-parse.mjs` owns:

```
## Chase the supplier for the data extract
- owner: sam
- due: 2026-08-05
- notes: They said the Q3 dataset lands in August.
```

- **The `##` heading is the title and only the title** — no owner, date or status in it.
- **Dates are `YYYY-MM-DD`** — anything else is rejected at transfer rather than guessed at.
- **Owner names are the short names from the project's roster** (`state.notion.people` in
  the project's config — `.claude/workspace.json`, or a legacy `context.json`). Anyone else goes in `notes`.
- **Write what you know; don't research it.** Name-only entries are fine — enrichment happens
  after transfer.
- Never touch anything above the first `##`, never edit an entry that isn't yours.

Then check it parses — the same view `process-pending` gets:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pending-parse.mjs" "$ROOT"
```

Fix anything marked `❌` before committing; report `⚠️` and let the user decide.

## 4. Show it, ask, commit — then tell them to push

Show the entry, **get an explicit yes**, then:

```bash
git -C "$ROOT" add "$PENDING" && git -C "$ROOT" commit -m "pending: [what it is]"
```

Then **tell the user to push**, plainly: until they do, nobody can see the entry. If the
repo has a push-triggered notify Action, the push is also the
notification — don't message anyone yourself on top of it.

**Not this skill:** if Notion is reachable, `add-action` / `log-decision` /
`add-open-question` write the real row. Transferring the queue is `process-pending`. Working
notes go to `save-thread` (context-kit), not here — the queue is for structured rows only.