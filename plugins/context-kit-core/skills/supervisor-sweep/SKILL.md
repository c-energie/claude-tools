---
name: supervisor-sweep
description: Distil the lessons that role assistants have recorded across every included project into a supervisor thread — the cross-project layer's periodic synthesis, reading only each repo's LESSONS.md and citing the entry ids it consumes. Triggers like "run the supervisor sweep", "sweep the software developer lessons", "what have my assistants learned across projects", "is there anything to distil".
disable-model-invocation: true
---

# Sweep the assistants' lessons into a supervisor thread

The cross-project layer's synthesis step. Lessons accumulate in each project's
`assistants/[role]/LESSONS.md`; this reads them across every source and writes **one supervisor
thread** capturing what they add up to.

> **Writes to this repo and is the step where cross-project judgement happens — run only when
> asked.** `disable-model-invocation: true`.

## 1. This runs only where supervisors are declared

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --writable)"
node "${CLAUDE_PLUGIN_ROOT}/scripts/assistants.mjs" roster "$ROOT"
```

No `supervisors` block means this is a project repo, not the cross-project layer. Say so and
stop — a project has no business distilling other projects.

## 2. What may be read, and nothing else

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/assistants.mjs" unswept "$ROOT" --role "[role]"
```

Sources are this repo plus every entry in `include`, and the **only** file read in each is
`assistants/[role]/LESSONS.md`. Not their threads, not their `memory.md`, not their meetings.

That restriction is the leak control, and it is structural rather than reviewed: sanitising
already happened in the session that wrote each lesson, where the author knew what was
sensitive. A sweep that reads project detail would be re-deciding that question with less
information and more haste. **Do not widen the read** — not to "add context", not to resolve an
ambiguous lesson. An unclear lesson stays unclear and is left for its own project to restate.

`unswept` lists what has not yet been distilled: every lesson id minus every id already
declared consumed by a supervisor thread. Absent clones are reported, never fetched. A repo
reported absent contributed nothing — say so, rather than letting silence read as "no lessons".

## 3. Is there enough to sweep?

`supervisors/[role]/memory.md` front-matter carries the current threshold and one line of
reasoning. Fewer unswept lessons than that means say so and stop; distilling two lessons into
doctrine manufactures confidence that the evidence does not support.

The threshold self-tunes: after a sweep, write the next one back with its reason
(`"9 lessons in, 2 worth keeping — raising 5 to 7"`), clamped to 2–20. A `threshold` set
explicitly in `context.json` wins outright over the tuned value.

## 4. Propose, then apply

Show the user what you would write, alongside the lessons feeding it, before writing anything.

Look for what **repeats across sources** — the same shape of problem in two projects is worth
more than a sharp observation in one. Merge overlaps into a single claim; contradictions
between projects are findings in their own right, not something to average away.

Then write **one thread** in this repo's flat `threads/`:

```markdown
---
title: [what this sweep concluded]
supervisor: [role]
consumed: a1b2c3, d4e5f6
---
```

**`consumed:` is the ledger.** There is no state file — an id listed here is distilled, and one
that is not stays in the next sweep's `unswept` list. So it must be **declared, not implied**:
mentioning an id in the body consumes nothing, deliberately, because a thread saying "left for
next time" would otherwise mark it done. List an id only if this thread genuinely distils it.

Filename: `YYYY-MM-DD-supervisor-[role]-topic.md`.

## 5. Commit

Stage the thread. Ask before pushing.

**Never write into an included repo.** Their clones are writable on disk and only this rule
stops it. Anything bound for a project leaves via `handoff/`, and that is `supervisor-distil`'s
job, not this one.

**Not this skill:** turning supervisor threads into doctrine and sending it to the projects is
`supervisor-distil`; recording a lesson in a project is `assistant-lesson`; ordinary thread
curation is `curate-context`.
