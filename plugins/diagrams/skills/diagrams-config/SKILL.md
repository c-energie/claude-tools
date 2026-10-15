---
name: diagrams-config
description: How the diagrams skills find a project's diagram store — the DIAGRAMS_STORE / .diagrams.json / context.json ladder, the org-boundary check, why there is deliberately no default store, the append-only index.jsonl schema, and the taxonomy's absent/empty/present rule. Background knowledge for save-diagram and browse-diagrams; not a task to run.
user-invocable: false
---

# The project's diagram store

Every skill in this plugin is generic. Which store, which vocabulary, which org — all of it
comes from the **project's context repo** and from the **store repo itself**, at runtime. This
file is the one place that procedure lives.

## 1. Resolve the store

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram-store.mjs" where
```

That prints the store repo, its checkout, the org, the project, **which rung named it**, and the
org-boundary result. The store is named in the first of:

| # | Where | Needs context-kit? |
|---|---|---|
| 1 | `DIAGRAMS_STORE=owner/repo` (with `DIAGRAMS_CROSS_ORG=1` to declare a cross-org store) | no |
| 2 | `.diagrams.json` at the root of the repo being worked in | no |
| 3 | the project's `context.json`, `state.diagrams` | yes — a context repo |

The context.json rung is found via `context-repo.sh`, or `CONTEXT_CONFIG` when you already hold
the path. `.diagrams.json` and `state.diagrams` take the same block:

```json
{ "repo": "acme-co/diagrams", "project": "Acme" }
```

- **`repo`** — `owner/repo` of the store. Required.
- **`project`** — `.diagrams.json` only (context.json has its own); else the repo directory name.
- **`dir`** — optional explicit checkout path. Otherwise `~/[owner]/[repo]`, its
  own root — deliberately not `~/.context`, which is reserved for context repos. A store is a
  separate repo with its own access, and a separate root keeps context-repo tooling (the
  session-start hook, `context-repo.sh`) from ever resolving a store by accident.
- **`org`** — optional override for the `org` recorded on each row. Defaults to
  the store repo's owner, which is right almost always.

## 2. There is no default store, and that is the design

A project that names no store on any rung **fails, listing the three places**. Do not fall back
to another store, do not pick "the one that exists on this machine". The error may *suggest*
`[origin owner]/diagrams`; that is a question for the user, never an answer.

**The org boundary is enforced on every resolve.** The work's org is the current repo's origin
owner, else the context repo's owner. A store in another org is refused unless the block says
`"crossOrg": true` (or `DIAGRAMS_CROSS_ORG=1` beside `DIAGRAMS_STORE`) — the record that someone
decided it, for a personal fork or one person owning both orgs. Set it only on the user's word.
`boundary unchecked` from `where` means nothing to compare against; say so when reporting.

The stores are per-org because they are a **permission boundary** — read on the plugin catalog
covers skill code and nothing a plugin reaches. A default would mean an unconfigured net-flex
project writing into the c-energie store: the boundary breached by the very tool built to hold
it, silently, and discovered when someone reads a diagram they should not have. The one-line fix
is cheap; the silent wrong write is not recoverable, because by then it is in the history.

Same rule as `PROJECT_CONTEXT_REPO` in the core layer, for the same reason: *configured*,
*unconfigured* and *opted out* must stay three distinguishable states.

## 3. `index.jsonl` — the schema, and why it is append-only

One JSON object per line, fields in the order `scripts/diagram-store.mjs` declares:

`id · date · org · project · title · type · tags · format · path · source_conversation · status · text`

- **Append-only.** Two people saving at the same moment produce two lines and conflict on
  nothing. A JSON array has a closing bracket, and a closing bracket is a merge conflict on every
  concurrent write. Never rewrite the file to tidy it.
- **`text` is lifted out of the SVG** — the labels drawn inside the picture. That is the search
  people actually use: a box reading "settlement window" is remembered long after the tag it was
  given. Tags are the filter; the drawn words are the index.
- **`org` is recorded on the row, not inferred at read time**, because the gallery may be showing
  rows from more than one store and each must still say where it came from.
- **`source_conversation`** answers "where did this come from" months later. It is free text — a
  session date, a thread filename, a URL. Null is allowed and is reported as a gap, not hidden.
- **One module owns all of this.** `scripts/diagram-store.mjs` is imported by both the writer and
  the reader, so a field cannot be added to one side only.

## 4. `taxonomy.json` — absent, empty and populated differ

The vocabulary lives in the **store**, not in this plugin: the plugin knows the shape, the store
knows the values. A tag list shipped in a plugin would be the same layering error as a hard-coded
database ID.

| State | Meaning | `save-diagram` |
| --- | --- | --- |
| **no file** | nobody has agreed a vocabulary yet | records as given, **says so every time** |
| **`[]`** | considered, deliberately open | anything, silently |
| **non-empty** | closed | rejects the unlisted, names the near misses |

Absent must not block — a store should not be unusable until a meeting happens. But it is never
silent, because silence is how `architecture` / `arch` / `system-diagram` become three tags and
filtering by any one of them finds a third of the store.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram-store.mjs" taxonomy       # what is in force
node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram-store.mjs" tags-in-use    # what has accumulated
```

`tags-in-use` is what turns "agree a vocabulary" from an open question into a decision with data
in front of it. Reach for it when someone asks what the tag list should be.

## 5. Which route writes the store

The same split the core layer draws for the context repo, and for the same reason — see
`context-kit-core`'s `context-access`:

- **Claude Code on a laptop** — `save-diagram.mjs` writes the file, appends the index and commits
  locally. It **never pushes**; the skill asks first.
- **Cowork / cloud sandboxes** — no git and no shell, so the GitHub API over MCP, through the
  connection the project's `connections` declares for the store's owner. Two rules from
  `context-access` bind hardest here: a write **is** an immediate commit to the default branch,
  so ask before it; and **appending means read the whole file, append, write it back whole** —
  reconstructing `index.jsonl` from memory truncates every row you forgot, and on this path no
  diff would show you.

Say which route produced the answer. An API read and a git read have different provenance.

**Not this skill:** the context repo's own configuration is `context-kit-core`'s `context-setup`;
reaching that repo over the API is its `context-access`. This file is only about the diagram store.
