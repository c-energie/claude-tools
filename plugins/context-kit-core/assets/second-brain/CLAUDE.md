# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The **cross-project context layer** — a context repo like any other (stamped from
`c-energie/context-template`, loaded by the [context-kit](https://github.com/c-energie/claude-tools)
plugin), except that its `context.json` carries an `include` list, so sessions here also load
the memory, glossary and thread index of every included project. There is no application code,
no build and no tests: the content is markdown and one JSON config, committed with plain git.

Its jobs, in order: **cross-pollination** (insights between projects) and the **personal
layer** (facts about you that are bigger than any one project). It is not a task dashboard and
not a front door that replaces working in a project's own session.

## The rules that make it safe

- **Included projects are read-only.** Their clones sit alongside this one under `~/.context/`
  and may be read freely for depth (full threads, meetings, mirrors), but nothing here writes
  into them — no commits, no structured-state backend, no pending entries.
- **Project-bound output goes in `handoff/`** — one file per item, front-matter naming the
  target repo and kind (see `handoff/README.md`), drained by hand in that project's session,
  then moved to `handoff/done/`.
- **The `include` list is the whole universe.** Explicit, committed, one level (an included
  repo's own `include` is ignored), never discovered from the filesystem. Entries are
  `owner/repo` names only — the contract is route-agnostic, so a sandbox route reading repos
  over the GitHub API honours the same list.
- **Backend connections are declared here or not at all.** If a project of yours uses Notion or
  Slack, deny its scoped connectors in `.claude/settings.json`. A session here that appears to
  hold a project's connector anyway is a configuration bug — do not use it.

## Layout

Standard context-template layout — `memory.md` (durable layer; update its `_Last reviewed:_`
date when revising), `glossary.md`, `threads/` (`YYYY-MM-DD-short-topic.md`, YAML front-matter
with at least `title:`, **no angle brackets in front-matter values**), `meetings/`, `pending/`
— plus `handoff/`, which is unique to this repo.

Cross-project insights are threads *here*, not in either project, until one project clearly
owns the conclusion — then a handoff item carries it over.

## Caveat

When this repo's notes about a project disagree with that project's own context repo, the
project's repo wins. This layer holds what is about you or *between* projects, nothing that a
project already records.
