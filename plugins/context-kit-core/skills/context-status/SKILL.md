---
name: context-status
description: Report what is outstanding in a workspace or context repo — threads due for curation, thread outcomes never logged to a decision log or tracker, a pending queue, and native memory awaiting triage — each with the skill that clears it. Triggers like "what is outstanding", "what do I need to run", "what is queued up", "is anything waiting", "status of my context", "catch me up on the context system", "what has built up", "did those decisions ever get logged".
---

# What is outstanding

Counts every queue in a workspace or a context repo and names the skill that drains each one. It
is the standing answer to "what has built up while I was working" — and it is a **read**: it
writes nothing, queues nothing and pushes nothing.

The queues are real and they fill silently. Threads accumulate with nothing announcing that a
curation is due; a decision reached in a thread never reaches the decision log; `memory.md`'s
last-review date recedes. Every one of them is visible only if something goes and counts it.

## 1. Find the repo

```bash
ROOT="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" --no-pull)"
```

The nearest workspace, else (until the last context repo is migrated) the context repo. In a
workspace the queues are counted from their new homes — thread outcomes and curation in
`docs/threads/` against `docs/memory.md`, the pending queue in `.context/pending/`, native memory
as before. A context repo is counted at `threads/`, `memory.md` and `pending/`.

`--no-pull` deliberately: a status check should be instant and change nothing, and the
session-start hook already pulled this repo when the session opened. If the numbers matter
because someone has just pushed, run `refresh-context` first and then this.

If the resolver exits non-zero the problem is the link rather than the queues — route to
`context-setup`.

## 2. Count

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/context-status.mjs" "$ROOT"
```

Useful options: `--json` for the structured form, `--today YYYY-MM-DD` to pin the date,
`--no-memory` to skip the native-memory scan (the slow part, and the only one that reads outside
the repo).

The script composes `memory-triage.mjs` rather than re-counting what it already counts, so its
native-memory figure is the **same** figure a triage will act on. Anything it reports as absent —
an index that is not there, a review stamp that was never written — is reported as absent rather
than as zero.

## 3. Report it, leading with what to run

The script ends with a `WHAT TO RUN` block. **Lead with that**, then fill in only the queues
that have something in them. A recital of every section where most are empty buries the one
that is not.

Then add the judgement the script cannot:

- **Say which queue is the real one.** A curation that is one thread over the line can wait; a
  thread that reached a decision three weeks ago and never logged it is a decision that has not
  reached the people it governs.
- **"Never logged" is a question, not an accusation.** `THREAD OUTCOMES NEVER LOGGED` counts
  threads that reached a decision or named an action and carry no `notion_ids` / `issue_ids`
  link. It cannot tell whether the outcome was logged and simply never linked back. So offer
  the two ways to clear each one — log it now, or record `notion_ids: []` because there was
  nothing to log — and never assert that the work was skipped.

## 4. Offer, then wait

Every skill in the `WHAT TO RUN` block writes outside the session. **Offer to run one; do not
start.** Naming what you would do and waiting is the whole point — a status check that quietly
triggered a curation would have converted a read into a commit.

Every queue it reports lives in the root it was given, so an empty `WHAT TO RUN` is a real
all-clear.

## 5. If a queue looks wrong rather than full

A count that cannot be explained is usually configuration, not backlog — an index that was never
rebuilt, threads in a directory the layout does not expect. That is `context-doctor`'s job, and
it is the right next step when the numbers themselves look suspect.

**Not this skill:** health-checking the config behind these numbers is `context-doctor`; wiring
a project to its context repo is `context-setup`; re-pulling mid-session is `refresh-context`.
Actually draining the queues is `curate-context`, `memory-triage`, and (where the project uses
Notion) `process-pending`, `log-decision` and `add-action`.
