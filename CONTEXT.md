# CONTEXT.md

The domain glossary for `c-energie/claude-tools`. Terms only: what a word means here, where the
thing it names lives, and who reads it. Decisions live in `docs/adr/`; how a thing is built lives
in the plugin that builds it.

Use these words as written. Where the glossary marks a term as ambiguous, say which sense you
mean rather than reaching for a synonym.

## lesson

**Ambiguous. Two unrelated senses, both in daily use.** Always qualify which one is meant.

### lesson (teaching sense)

A numbered, self-contained HTML document produced inside a [teaching workspace](#teaching-workspace)
by the `teach` skill. It teaches one step of a topic, cites its sources, and is read once by the
person learning. Lives in `lessons/` inside its workspace, alongside `reference/`,
`learning-records/` and `assets/`.

Read by: whoever is learning the topic, and — where the workspace's `audience` says so — anyone
else with access to the [context repo](#context-repo) holding it.

**A supervisor may not read this.** Teaching lessons are raw topic material, unsanitised, and
carry whatever project detail the topic happened to involve.

### lesson (assistant sense)

An entry in an [assistant](#assistant)'s `LESSONS.md` — a claim about *how work should be done*,
authored by a human and sanitised at the moment it is written, so that it is true and useful in a
project other than the one it came from. Lives at `assistants/[role]/LESSONS.md` in a context
repo. Entries are append-only and carry a load-bearing six-character id; a correction is a new
entry that supersedes the old one in its text.

Read by: the assistant itself, anyone with repo access, and — uniquely — a
[supervisor](#supervisor).

**This is the only file a supervisor may read.** Not a thread, not `memory.md`, and not a
teaching lesson.

### Telling them apart

| | teaching sense | assistant sense |
| --- | --- | --- |
| Is about | a topic being learned | how work should be done |
| Written by | the `teach` skill | a human, sanitised at write time |
| Lives in | `teaching/[slug]/lessons/*.html` | `assistants/[role]/LESSONS.md` |
| Lifetime | read once | durable, append-only |
| A supervisor may read it | no | yes — and only this |

The two are never promoted into one another automatically. A person may decide that something
learned in a teaching workspace is also a lesson in the assistant sense, and write it as one by
hand; nothing does that on their behalf.

## teaching workspace

A directory inside a context repo that the `teach` skill owns outright: one topic, one mission,
and the artefacts that accumulate as that topic is learned — `lessons/`, `reference/`,
`learning-records/`, `assets/` and a `NOTES.md`. Workspaces sit under a fixed `teaching/` parent,
one directory per topic, and are **declared** in the repo's `context.json` rather than discovered
on disk, each declaration naming its mission path and its `audience`.

It behaves unlike anything else in a context repo: it is written by a skill from another
marketplace, it is the only place where the word "lesson" carries the teaching sense, and the
fixed `teaching/` parent is what keeps its `lessons/` from ever colliding with an assistant's
`LESSONS.md`.

Which repo a workspace lives in decides who can read it: one in a shared project context repo is
reviewable by that project's people, one in a personal cross-project repo is not.

## learning record

The record of what actually happened in a teaching session — what was covered, what landed, what
did not — kept in `learning-records/` inside a teaching workspace. Working notes about a person's
progress, not material about the topic and not a claim about how work should be done. It is never
promoted to an assistant's `LESSONS.md`.

## audience

Who a piece of writing was meant for: `working`, `team` or `external`. The same three values are
used by a thread's `audience:` front-matter and by a teaching workspace's declaration.

**Absent is absent, not a default.** A thing that declares no audience has not been classified;
it has not been classified as `working`.

## context repo

The per-project (or per-person) repository holding a project's durable context — `memory.md`,
`glossary.md`, `threads/`, and the `context.json` that declares what the repo is and what it
connects to. Resolved by the session it belongs to, never guessed. On a laptop, the managed
clones live under `~/.context/[owner]/[repo]`; `docs/context-root.md` is the canonical account.

## assistant

A declared role within a context repo — a software developer, a financial assistant — with its
own persona, its own durable memory, its own `LESSONS.md` and a doctrine copied down from a
supervisor. One directory per role under `assistants/[role]/`, and declared in `context.json`: a
folder someone happened to create is not an assistant.

## supervisor

The cross-project layer that reads assistants' `LESSONS.md` files and distils what it finds into
doctrine sent back down to each of them. Its reading is deliberately confined to that one file
per assistant, which is what makes leak control structural rather than reviewed.

## marketplace / catalog / plugin

The **marketplace** is this repository: a permission boundary — read access to it is
all-or-nothing across everything it holds. The **catalog** is what the marketplace declares
itself as, and is named for the GitHub *org* rather than the repo, so identifiers read
`context-kit-core@c-energie`. A **plugin** is a topic boundary inside it, one subdirectory under
`plugins/`, with its own version, its own `CLAUDE.md` and its own skills.

A separate org gets a separate catalog; the same people plus a new topic gets a new plugin here.
Not every plugin in this catalog is part of the context stack.
