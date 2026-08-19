---
name: supervisor-distil
description: Promote settled supervisor threads into a role's durable cross-project doctrine, then queue a handoff item for each project so the doctrine reaches that repo's assistant. The less frequent half of the supervisor cycle. Triggers like "distil the supervisor threads", "update the software developer doctrine", "promote what the supervisor has learned", "send the doctrine to the projects".
disable-model-invocation: true
---

# Distil supervisor threads into doctrine

`supervisor-sweep` runs often and produces threads. This runs **rarely** and turns those threads
into `supervisors/[role]/memory.md` — the durable, cross-project layer for a role — then queues
that doctrine for each project.

> **Rewrites durable doctrine and queues items for other repos — run only when asked.**
> `disable-model-invocation: true`.

## 1. Read the supervisor's threads

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --writable)"
node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" today
```

Every thread carrying `supervisor: [role]` in front-matter, plus the current
`supervisors/[role]/memory.md`. Only threads that have actually **settled** get promoted;
recent ones are still working notes.

## 2. The bar: publishable into ANY child repo

Doctrine is copied down into every project that has this assistant — including repos other
people read. So the standard for a line entering `supervisors/[role]/memory.md` is:

**would this be fine appearing, verbatim, in the most public of those repos?**

If not, it does not belong in supervisor memory at all — not in a filtered form, not marked
internal. A supervisor's memory is by definition project-agnostic; a line that fails this test
has smuggled a project in, and the fix is to abstract it further or drop it.

There is no second sanitiser on the way down, deliberately. One bar, applied here, is a rule
that can be checked; two bars would mean deciding per target, every time, correctly.

## 3. Propose the update

Show the proposed `memory.md` next to the threads it came from, and get confirmation.

- **Condense, do not accumulate.** This file is copied into every child; it must stay small
  enough to read. Merge related claims; supersede rather than append.
- **Keep it faithful.** Do not sharpen a hedged conclusion into a confident one.
- Record what changed since the last distillation, so a reader can see movement.
- Update the front-matter `_Distilled:_` date, and carry the sweep threshold forward.

## 4. Queue a handoff item per project

For each repo declaring this assistant, write **one file** in `handoff/`, per
`handoff/README.md`: front-matter naming the target repo and the kind, body carrying the exact
`DOCTRINE.md` content to be written there. Add a line to `handoff/INDEX.md` — target, kind,
date — since that index and the session-start count are the only reminder these items exist.

Include a provenance stamp in the body, so a child can tell how old its doctrine is and whether
a change is a reversal or a rewording:

```markdown
_Distilled 2026-08-19 from supervisors/[role]/memory.md_
```

**Nothing here writes into a project repo.** Included repos are read-only from this layer,
whatever the clone on disk permits. The item is drained by hand, in that project's own session,
where the write is legitimate and a human sees the content land. `DOCTRINE.md` is replaced
whole — it is a copy, not a place to think — and is never hand-edited afterwards.

The lag is real and worth stating: doctrine reaches a project only when someone drains the
handoff there. If that is not happening, the queue is visible here rather than lost.

## 5. Commit

Stage `supervisors/[role]/`, the handoff items and `handoff/INDEX.md`. Ask before pushing.

**Not this skill:** gathering lessons into supervisor threads is `supervisor-sweep`; recording a
lesson in a project is `assistant-lesson`; adopting an assistant is `assistant`.
