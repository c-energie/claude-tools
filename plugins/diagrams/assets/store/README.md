# Diagram store

Diagrams captured out of Claude sessions by the **`diagrams` plugin** (`save-diagram`), and read
back by its gallery (`browse-diagrams`).

```
index.jsonl               one JSON record per diagram, APPEND-ONLY
taxonomy.json             the agreed vocabulary — see below
diagrams/<year>/*.svg     the source, committed as text
diagrams/<year>/*.png     optional rasters — build output, never the artifact
gallery.html              built, gitignored; rebuild rather than commit
```

## The rules that make this worth having

- **Source, not pixels.** SVG and HTML are committed because they diff, they grep, and they can
  be restyled. A PNG does none of that; it is a convenience beside the source, never instead of it.
- **`index.jsonl` is append-only.** One line per diagram, so two people saving at the same time
  conflict on nothing. A JSON array would have a closing bracket, and a closing bracket is a
  merge conflict on every concurrent write. Never rewrite the file to "tidy" it.
- **The searchable text is lifted out of the SVG.** People remember a box labelled "settlement
  window" long after forgetting which tag they gave the thing. The labels are the search; the
  tags are the filter.
- **This store is a permission boundary.** It is a per-org repo with its own access, named by
  each project's `context.json` (`state.diagrams.repo`) and never defaulted. Read on the plugin
  catalog is not read on this.

## `taxonomy.json`

The vocabulary, agreed by the people who use this store, living here rather than in the plugin:

```json
{ "types": ["architecture", "sequence"], "tags": ["data-flow"], "statuses": ["draft", "current", "superseded"] }
```

Absent, empty and populated all mean different things, and the guard treats them differently:

| State | Meaning | What `save-diagram` does |
| --- | --- | --- |
| **no file** | nobody has agreed a vocabulary yet | records tags as given and **says so** every time |
| **`[]` for a field** | considered, and deliberately open | anything goes, silently |
| **non-empty** | closed vocabulary | rejects anything unlisted, naming the near misses |

Absent does not block: a store should not be unusable until a meeting happens. But it is never
silent either, because silence is how `architecture` / `arch` / `system-diagram` become three
tags and filtering by any of them finds a third of the store.

When you are ready to agree one, start from what has accumulated:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram-store.mjs" tags-in-use
```

Add a new value in a commit of its own, so the vocabulary changing is visible in the log.
