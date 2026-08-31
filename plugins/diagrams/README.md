# diagrams

Diagrams Claude draws are worth keeping, and a chat log is not where they keep. This plugin puts
them in a **per-org git store** — source committed as text, one append-only index line each — and
reads them back through a single self-contained HTML gallery.

Install alongside `context-kit-core` (same catalog); it uses the core layer's context-repo
resolver to find which store this project belongs to. It needs no Notion and no Slack.

## The three parts, and why they are one plugin

| Part | What it does |
| --- | --- |
| `save-diagram` (skill + `scripts/save-diagram.mjs`) | writes the source, appends the index line, commits locally, never pushes |
| `browse-diagrams` (skill + `scripts/gallery-build.mjs`) | answers "have we drawn this before" from the index; builds the gallery when someone wants pictures |
| the vocabulary guard (`taxonomy.json`, in the **store**) | rejects a tag outside the agreed list, naming the near misses |

They ship together because they share one schema. `scripts/diagram-store.mjs` **is** that
schema — the field list, the store resolution, the taxonomy rule, the SVG text extraction — and
both the writer and the reader import it. Split across plugins, the writer and the reader would
agree only by convention, and would stop agreeing the first time a field was added; the symptom
is a gallery quietly missing rows, which nobody notices because it still renders.

## The contract: what it reads from `context.json`

```json
{
  "project": "FlexSense",
  "state": {
    "diagrams": { "repo": "net-flex/diagrams" }
  }
}
```

- **`state.diagrams.repo`** — `owner/repo` of the store. Checked out at `~/.context/[owner]/[repo]`
  unless `state.diagrams.dir` says otherwise.
- **`state.diagrams.org`** — optional; overrides the `org` recorded on each row, which otherwise
  is the store repo's owner.

**There is deliberately no default store.** A project that declares none gets an error naming the
missing key. The stores are per-org because they are a *permission* boundary — read on this plugin
catalog covers skill code and nothing a plugin reaches — and a default would mean an unconfigured
project writing into another org's store: the boundary breached by the tool built to hold it,
silently, and unrecoverable once it is in the history. Same rule, for the same reason, as
`PROJECT_CONTEXT_REPO` having no default in the core layer.

## The store

```
index.jsonl               one JSON record per diagram, APPEND-ONLY
taxonomy.json             the agreed vocabulary (absent = not yet agreed)
diagrams/<year>/*.svg     the source, committed as text
diagrams/<year>/*.png     optional rasters — build output, never the artifact
gallery.html              built, gitignored
```

Stamp the house files into a fresh checkout:

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
    save-diagram/       capture — disable-model-invocation, asks before any push
    browse-diagrams/    find and build
    diagrams-config/    the contract (reference only, not user-invocable)
  scripts/
    diagram-store.mjs   THE SCHEMA — store resolution, fields, taxonomy, text extraction
    save-diagram.mjs    write + append + local commit
    gallery-build.mjs   N stores in, one self-contained HTML out
    context-repo.sh     copy of context-kit-core's — see the marketplace CLAUDE.md
    dates.mjs           copy of context-kit-core's
    bash-bin.mjs        copy of context-kit-core's
  assets/store/         the files `diagram-store.mjs init` stamps into a new store
```
