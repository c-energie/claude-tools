# CONTEXT.md

The domain glossary for `c-energie/claude-tools`. Terms only: what a word means here, where the
thing it names lives, and who reads it. Decisions live in `docs/adr/`; how a thing is built lives
in the plugin that builds it.

Use these words as written. Where the glossary marks a term as ambiguous, say which sense you
mean rather than reaching for a synonym.

## lesson

A numbered, self-contained HTML document produced inside a [teaching workspace](#teaching-workspace)
by the `teach` skill. It teaches one step of a topic, cites its sources, and is read once by the
person learning. Lives in `lessons/` inside its teaching workspace, alongside `reference/`,
`learning-records/` and `assets/`.

Read by: whoever is learning the topic, and anyone else with access to the workspace holding it.

There used to be a second sense — an entry in a role assistant's `LESSONS.md`, distilled by a
supervisor. ADR 0002 retired assistants and supervisors, so "lesson" now means only this.

## teaching workspace

A `teaching/[slug]/` directory inside a [project workspace](#project-workspace) or any other
workspace, one per topic, that the `teach` skill (`/mattpocock-skills:teach`, from another
marketplace) owns outright: one topic, one mission, and the artefacts that accumulate as that
topic is learned — `lessons/`, `reference/`, `learning-records/`, `assets/` and a `NOTES.md`. It is
found by convention — the `teaching/` directory ADR 0002's layout names — and nothing in this
marketplace declares, lists or scaffolds one: you start `teach` in the directory.

Which workspace it lives in decides who can read it: anyone who clones that workspace's repo.

## learning record

The record of what actually happened in a teaching session — what was covered, what landed, what
did not — kept in `learning-records/` inside a teaching workspace. Working notes about a person's
progress, not material about the topic.

## audience

Who a piece of writing was meant for: `working`, `team` or `external`, declared in a thread's
`audience:` front-matter.

**Absent is absent, not a default.** A thing that declares no audience has not been classified;
it has not been classified as `working`.

## context repo

**Retired** (ADR 0002; the last route removed in #60, 2026-10-25). A separate per-project
repository that once held a project's durable context (`memory.md`, `glossary.md`, `threads/`,
`context.json`), cloned under `~/.context`. That context now lives in the project's
[project workspace](#project-workspace): `docs/memory.md`, `GLOSSARY.md`, `docs/threads/`, and
`.claude/workspace.json` in place of `context.json`. Use the term only for the history.
_Avoid_: for anything current

## marketplace / catalog / plugin

The **marketplace** is this repository: a permission boundary — read access to it is
all-or-nothing across everything it holds. The **catalog** is what the marketplace declares
itself as, and is named for the GitHub *org* rather than the repo, so identifiers read
`context-kit-core@c-energie`. A **plugin** is a topic boundary inside it, one subdirectory under
`plugins/`, with its own version, its own `CLAUDE.md` and its own skills.

A separate org gets a separate catalog; the same people plus a new topic gets a new plugin here.
Not every plugin in this catalog is part of the context stack.

## project workspace

A local folder holding one or more [documents](#document), each in its own repos, listed as
`members` of the `.claude/workspace.json` at its root (a `workspace.toml` before it is migrated);
made and extended by the `project-workspace` plugin's skills. It may be a git repo of its own —
tracking only `.claude/workspace.json`, `CLAUDE.md` and `.gitignore`, never a member — but need
not be. No Python lives at its root.

Not a [teaching workspace](#teaching-workspace): always say "project workspace" in full.
_Avoid_: doc workspace, shell (as a noun), monorepo

## document

One deliverable — a thesis, paper or report — inside a project workspace: one
[document repo](#document-repo) and, optionally, the [analysis repo](#analysis-repo) nested
inside it. Where a document's analysis lives is that document repo's `layout.toml`'s to say;
`workspace.json` records the analysis repo only as a member naming the document it feeds.
_Avoid_: project (a context repo's sense), writing project

## document repo

The LaTeX repo of one document, made from `c-energie/writing-template` or adopted from an
Overleaf project's GitHub sync; the host repo when it has an analysis repo.
_Avoid_: writing repo, LaTeX repo, thesis repo (`writing-template` and
`writing-hosts-analysis` keep the old word as fixed names)

## analysis repo

The Python repo, made from `c-energie/analysis-template`, whose notebooks generate one
document's figures and tables. Nested inside its document repo, with its own venv.
_Avoid_: code repo, companion repo
