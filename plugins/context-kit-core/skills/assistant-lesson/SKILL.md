---
name: assistant-lesson
description: Record a transferable lesson from this project into an assistant's LESSONS.md — abstracted at write time so it carries no project, client, person or figure, because this is the only file a cross-project supervisor is allowed to read. Triggers like "log that as a lesson", "that is worth remembering across projects", "add a lesson for the software developer assistant", "capture this for the supervisor".
disable-model-invocation: true
---

# Record a transferable lesson

`assistants/[role]/LESSONS.md` is the **one file that crosses a repo boundary**. A supervisor
in the cross-project layer reads it and nothing else — never a thread, never `memory.md`.

That is the whole safety design. Sanitising happens **here**, in the session that knows what is
sensitive, rather than later in a sweep that would be guessing. If a lesson cannot be written
without naming the project, it does not go in this file.

> **Writes a file other repos will read — run only when asked.**
> `disable-model-invocation: true`.

## 1. Find the repo and the role

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --writable)"
node "${CLAUDE_PLUGIN_ROOT}/scripts/assistants.mjs" resolve "$ROOT" --role "[role]"
```

The lesson goes in the **current** repo — the project that learned it. Never write a lesson
into another project's repo, including from the cross-project layer: included repos are
read-only, without exception.

**`LESSONS.md` is a file convention, not a skill output.** It is a dated, id-stamped markdown
file, and any session in any repo can append to it by hand — which is deliberate, because a
repo that does not run context-kit still needs to be able to contribute. This skill is the
convenient path, not the required one.

## 2. Write it abstract, and check it as you write

A lesson is a claim that would still be true and still be useful in a **different project**.

Strip, without exception: project and product names, organisations, clients, people, figures,
dates tied to events, repository and file paths, anything identifying. Not because they are
secret, but because a supervisor's output is copied down into *other* repos — including ones
other people read.

| Not a lesson | A lesson |
| --- | --- |
| The staging secret for the ingest API expired again before Thursday's release | Rotating a shared secret before a release is worth automating; the manual step is skipped under time pressure |
| Client X went quiet for six weeks after the pilot proposal | A pilot proposal with no scheduled follow-up reads as an ending, not an offer |

Watch for the leak that survives redaction: "the client who pulled out in Q3" names nobody and
still identifies exactly one situation. If the sentence only makes sense to someone who knows
the project, it is not abstract yet.

**Never source a lesson from `DOCTRINE.md`.** That file is doctrine the supervisor already
distilled and sent back down. Restating it would send the supervisor's own conclusion back up
as though it were fresh evidence from this project, and it would arrive alongside the same
echo from every other repo — three confirmations of a thing nobody independently observed. A
lesson comes from this project's own work: its threads, its memory, what just happened.

## 3. Mint the id and append

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/assistants.mjs" lesson-id --text "[the one-line summary]"
node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" today
```

Append — never rewrite the file:

```markdown
## 2026-08-19 · a1b2c3 — One-line summary, the claim itself
Two or three lines of substance: what makes it true, and when it applies.
```

The id is content-addressed, so it is stable across the file being reordered or re-indented,
and it is how a supervisor records that this lesson has been distilled. **The ids are
load-bearing: never renumber, never remove one, never rewrite an existing entry.** Editing an
entry changes nothing about consumption — an already-consumed id stays consumed — so a genuine
correction is a *new* entry that supersedes the old one in its text.

Check the id is not already present (`assistants.mjs lessons "$ROOT" --role [role]`). A repeat
means the same lesson is already recorded — say so rather than adding a duplicate.

## 4. Commit

Stage only `assistants/[role]/LESSONS.md`. Ask before pushing; report the entry id.

**Not this skill:** adopting the assistant is `assistant`; ordinary working notes are
`save-thread`; distilling lessons across projects is `supervisor-sweep`.
