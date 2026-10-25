# diagrams

Diagrams Claude draws are worth keeping, and a chat log is not where they keep. This plugin puts
them in a **per-org git store** — source committed as text, one append-only index line each — and
reads them back through a single self-contained HTML gallery.

Works on its own or alongside `context-kit-core` (same catalog): a repo can name its store in a
`.diagrams.json`, and a workspace can name it in its `.claude/workspace.json` instead. It needs no Notion and no Slack.

## The three parts, and why they are one plugin

| Part | What it does |
| --- | --- |
| `save-diagram` (skill + `scripts/save-diagram.mjs`) | writes the source, appends the index line, commits locally, never pushes |
| `setup-diagram-store` (skill + `scripts/setup-diagram-store.mjs`) | first run: create or adopt the private store, stamp it, name it in `.diagrams.json`, prove a save and a gallery build |
| `browse-diagrams` (skill + `scripts/gallery-build.mjs`) | answers "have we drawn this before" from the index; builds the gallery when someone wants pictures |
| the vocabulary guard (`taxonomy.json`, in the **store**) | rejects a tag outside the agreed list, naming the near misses |

They ship together because they share one schema. `scripts/diagram-store.mjs` **is** that
schema — the field list, the store resolution, the taxonomy rule, the SVG text extraction — and
both the writer and the reader import it. Split across plugins, the writer and the reader would
agree only by convention, and would stop agreeing the first time a field was added; the symptom
is a gallery quietly missing rows, which nobody notices because it still renders.

## The contract: where the store is named

First match wins:

| # | Where | Needs |
|---|---|---|
| 1 | `DIAGRAMS_STORE=owner/repo` (with `DIAGRAMS_CROSS_ORG=1` to declare a cross-org store) | no |
| 2 | `.diagrams.json` at the root of the repo being worked in | no |
| 3 | the nearest `.claude/workspace.json` (ADR 0002) — `state.diagrams` | a workspace |

`.diagrams.json` and `state.diagrams` take the same block:

```json
{ "repo": "acme-co/diagrams", "project": "Acme" }
```

- **`repo`** — `owner/repo` of the store. Checked out at `~/[owner]/[repo]` unless `dir` (or
  `DIAGRAM_STORE_DIR`) says otherwise.
- **`org`** — optional; overrides the `org` recorded on each row, which otherwise is the store
  repo's owner.
- **`project`** — `.diagrams.json` only; a workspace uses its own `name`. Falls back to the repo
  directory's name.
- **`crossOrg`** — `true` only when the store deliberately belongs to another org than the work
  (a personal fork, one person owning both orgs). Without it that is refused — see below.

So the plugin runs with or without a workspace: a repo can carry its own `.diagrams.json`, and
a workspace's `state.diagrams` is the third rung, not a requirement.

**There is deliberately no default store.** A project that names none gets an error listing the
three places — suggesting `[origin owner]/diagrams` when the repo has a GitHub origin, never
assuming it.

**The org boundary is checked on every resolve.** The work's org is the current repo's origin
owner, else the workspace `repo`'s owner. A store owned by anyone else is refused unless `crossOrg`
records the decision; with nothing to compare against, `where` reports the boundary `unchecked`. The stores are per-org because they are a *permission* boundary — read on this plugin
catalog covers skill code and nothing a plugin reaches — and a default would mean an unconfigured
project writing into another org's store: the boundary breached by the tool built to hold it,
silently, and unrecoverable once it is in the history.

## The store

```
index.jsonl               one JSON record per diagram, APPEND-ONLY
taxonomy.json             the agreed vocabulary (absent = not yet agreed)
diagrams/<year>/*.svg     the source, committed as text
diagrams/<year>/*.png     optional rasters — build output, never the artifact
gallery.html              built, gitignored
```

`setup-diagram-store` does all of this. By hand, stamp the house files (and an empty
`index.jsonl`) into a fresh checkout:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram-store.mjs" init [checkout]
node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram-store.mjs" init [checkout] --taxonomy   # once agreed
```

### Why source and not pixels

SVG and HTML diff, grep and restyle. A PNG is a raster of a decision, not the decision — welcome
*beside* the source as build output, never instead of it. The gallery lazy-loads a `.png` sitting
next to a source file and never inlines one, because base64-inlining a handful of screenshots
takes the single file from tens of kilobytes to tens of megabytes.

### Why JSONL and not JSON

A JSON array has a closing bracket, and a closing bracket is a merge conflict on every concurrent
write. One line per diagram, appended, and two people saving at the same moment conflict on
nothing. A malformed line is reported and skipped rather than making the whole store unreadable.

### Why the drawn text is in the index

`text` holds the labels lifted out of the SVG. That is the search people actually use: a box
reading "settlement window" is remembered long after the tag it was given. Tags are the filter;
the drawn words are the index.

### `taxonomy.json` — absent, empty and populated differ

The vocabulary lives in the **store**, agreed by the people who use it, never in this plugin — a
tag list shipped in a plugin would be the same layering error as a hard-coded database ID.

| State | Meaning | `save-diagram` |
| --- | --- | --- |
| **no file** | nobody has agreed a vocabulary yet | records as given, **says so every time** |
| **`[]`** | considered, deliberately open | anything, silently |
| **non-empty** | closed | rejects the unlisted, names the near misses |

Absent must not block — a store should not be unusable until a meeting happens — but it is never
silent either, because silence is how `architecture` / `arch` / `system-diagram` become three tags
and filtering by any one of them finds a third of the store.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram-store.mjs" tags-in-use   # the data that conversation needs
```

## The gallery

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gallery-build.mjs"                      # this project's store
node "${CLAUDE_PLUGIN_ROOT}/scripts/gallery-build.mjs" [store] [store]      # several, for someone holding both grants
```

One HTML file, opened over `file://`, with search across titles, tags and drawn text and facets
for org / type / tag / status. Self-contained is not only convenience: a `file://` page cannot
`fetch()` a sibling `index.jsonl` at all, so a gallery built the other way works from a dev server
and shows an empty grid the moment someone double-clicks it.

**Multi-store is local convenience and must stay one.** There is no deployed instance and no plan
for one. A deployed gallery would be single-store with its own access policy in front of it,
because merging two stores in the viewing layer re-breaches exactly the boundary the per-org split
was drawn to hold. That constraint is written into `gallery-build.mjs`'s own header, not only here.

## Layout

```
plugins/diagrams/
  skills/
    setup-diagram-store/ first run — asks before every commit, push and repo create
    setup-observer/     step 0 of setup; verbatim copy of skills@c-energie's master + observer.toml
    save-diagram/       capture — disable-model-invocation, asks before any push
    browse-diagrams/    find and build
    diagrams-config/    the contract (reference only, not user-invocable)
  scripts/
    diagram-store.mjs   THE SCHEMA — store resolution, fields, taxonomy, text extraction
    save-diagram.mjs    write + append + local commit
    setup-diagram-store.mjs  the setup steps: check, store, stamp, push-store, config, commit-config, push-config, prove
    gallery-build.mjs   N stores in, one self-contained HTML out
    dates.mjs           copy of context-kit-core's — see the marketplace CLAUDE.md
    workspace.mjs       copy of context-kit-core's
  assets/store/         the files `diagram-store.mjs init` stamps into a new store
```
