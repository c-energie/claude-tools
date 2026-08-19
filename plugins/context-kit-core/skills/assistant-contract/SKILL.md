---
name: assistant-contract
description: The four-file contract behind role assistants — what PERSONA, memory.md, LESSONS.md and DOCTRINE.md each are, which one crosses a repo boundary and why the others must not. Background knowledge for the assistant and supervisor skills; not a task to run.
user-invocable: false
---

# The assistant four-file contract

Canonical. This lives in the **plugin**, not in `c-energie/context-template`, because the plugin
is the layer with a distribution mechanism: a marketplace update reaches every repo that enables
it, including repos that were never stamped from the template at all. A contract kept in the
template only ever reaches repos created after it changed.

## The four files

One directory per role, kebab-case, under `assistants/[role]/`:

| File | Direction | Written by | Rule |
| --- | --- | --- | --- |
| `PERSONA.md` | — | a human | How this assistant thinks: what it knows, how it argues, what it refuses. |
| `memory.md` | stays put | a human | Its durable, project-specific layer. Full detail. **Never leaves the repo.** |
| `LESSONS.md` | outbound ↑ | a human, abstracted at write time | The **only** file a supervisor may read. |
| `DOCTRINE.md` | inbound ↓ | machine | A copy of a supervisor's distilled memory. Never hand-edited. |

Roles are **declared** in `context.json`, never inferred from the filesystem:

```json
"assistants": { "software-dev": { "persona": "assistants/software-dev/PERSONA.md" } }
```

A folder someone happened to create is not an assistant — the same rule `include` follows, for
the same reason: what a session loads must be legible from committed config.

## Why LESSONS.md is a file convention, not a tool's output

It is plain markdown that any session, in any repo, running any tooling or none, can append to
by hand. That is deliberate. If writing a lesson required a skill, a repo running different
plugins would silently contribute nothing — and "no lessons yet" would be indistinguishable from
"no tooling here", which is the failure this system exists to prevent.

Entries are append-only:

```markdown
## 2026-08-19 · a1b2c3 — One-line summary, the claim itself
Two or three lines of substance: what makes it true, and when it applies.
```

The six-character id is a content hash of the summary, so it survives the file being reordered
or re-indented. **The ids are load-bearing:** a supervisor records what it has distilled by
citing them, so never renumber, remove or rewrite an entry. A correction is a *new* entry that
supersedes the old one in its text.

## Why sanitising happens at write time

A lesson must be true and useful in a **different project**. Strip project and product names,
organisations, clients, people, figures, paths.

> Not a lesson: *the staging secret for the ingest API expired again before Thursday's release*
> A lesson: *rotating a shared secret before a release is worth automating; the manual step is skipped under time pressure*

The author knows what is sensitive; a sweep reading it weeks later would be guessing. So the
supervisor is only ever permitted to read `LESSONS.md` — never a thread, never `memory.md`.
Leak control is structural rather than reviewed. Watch for the leak that survives redaction:
"the client who pulled out in Q3" names nobody and identifies exactly one situation.

## Why DOCTRINE.md may not seed a lesson

A supervisor distils lessons and sends the result back down as `DOCTRINE.md`. If a new lesson
could be drawn from it, the supervisor's own conclusion would return as fresh evidence — and
arrive from every project at once, reading as several independent confirmations of something
nobody independently observed. The hard file boundary is what closes that loop; a flag or a
convention inside one file would not.

## Threads

An assistant's working notes stay in the ordinary flat `threads/`, tagged `assistant: [role]`
and named `YYYY-MM-DD-asst-[role]-topic.md`. The filename form lets the session-start hook
exclude them from its newest-six list with one glob — otherwise a working assistant fills every
slot within a week and the repo's own threads stop being mentioned, silently.

Settled assistant threads promote into `assistants/[role]/memory.md`, not the root `memory.md`.

## The copy in the repo

`assistant` writes a short `assistants/README.md` when it first scaffolds a role. That copy
exists for **humans without this plugin** — a colleague who can read the repo but has no
context-kit installed still needs to know what these files are before appending a lesson. It is
a summary pointing here, not a second source of truth: when the two disagree, this file wins.

**Not this skill:** adopting a role is `assistant`; recording a lesson is `assistant-lesson`;
distilling across projects is `supervisor-sweep` and `supervisor-distil`.
