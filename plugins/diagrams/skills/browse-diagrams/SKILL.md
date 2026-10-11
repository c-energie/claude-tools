---
name: browse-diagrams
description: Find a diagram in the project's store, or build the gallery — a single self-contained HTML page over one or more stores, searchable by tag and by the words drawn inside each picture. Triggers like "have we drawn this before", "show me our diagrams", "build the diagram gallery", "find that architecture diagram", "what diagrams do we have about billing".
---

# Browse the diagram store

Two jobs, and the first is usually the one worth doing:

1. **Answer the question from the index** — "have we drawn this before?" is a grep, not a build.
2. **Build the gallery** when someone wants to look at pictures rather than read an answer.

Read `diagrams-config` for the store contract and the index schema.

## 1. Answering from the index

`index.jsonl` is one JSON object per line and carries the **words drawn inside each diagram** in
its `text` field. That is the search that works: a box labelled "settlement window" is remembered
long after the tag it was given.

```bash
STORE="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram-store.mjs" where | awk '/^checkout/{print $2}')"
grep -i "settlement" "$STORE/index.jsonl"
node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram-store.mjs" tags-in-use
```

Report the `title`, `date`, `path` and `source_conversation` of what you find, and read the source
file itself if the user wants to know what is in it — it is text.

**A grep that finds nothing is not proof of absence.** It searches the labels and the tags of what
has been *saved*; a diagram nobody ran `save-diagram` on is not there. Say "nothing in the store
matches" rather than "we have never drawn this".

## 2. Building the gallery

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gallery-build.mjs"                       # this project's store
node "${CLAUDE_PLUGIN_ROOT}/scripts/gallery-build.mjs" --out ~/Desktop/diagrams.html
```

One **self-contained HTML file**: the index and every SVG inlined, search across titles, tags and
drawn text, and filter facets for org, type, tag and status. Open it straight from `file://` —
there is no server, and that is not only convenience: a `file://` page cannot `fetch()` a sibling
`index.jsonl` at all, so a gallery built the other way works from a dev server and shows an empty
grid when someone actually double-clicks it.

PNG rasters stay separate and lazy-loaded. Base64-inlining a handful takes the file from tens of
kilobytes to tens of megabytes.

## 3. Several stores at once

Someone holding read on more than one store can pass them all and get one page, with `org` as a
filter facet:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gallery-build.mjs" ~/c-energie/diagrams ~/acme-co/diagrams
```

**This is a local convenience and must stay one.** It is for a person who already holds both
grants and wants one place to look. There is no deployed instance and no plan for one; a deployed
gallery would be **single-store**, with its own access policy in front of it, because merging two
stores in the viewing layer re-breaches exactly the boundary the per-org split was drawn to hold.
The constraint is written into the build script's own header for whoever reads that next.

If the user asks to host or share the gallery, say this plainly rather than building it — and note
that the built file inlines every diagram, so sending it *is* sending the store.

## 4. What the build tells you

It reports its own gaps rather than hiding them, and they are worth passing on:

- a row whose source file is missing (listed without a preview — usually a file moved by hand)
- a store with no `taxonomy.json`, so its tags are unvalidated
- an unreadable line in `index.jsonl`

`gallery.html` is build output and is gitignored in a stamped store. Rebuild it; do not commit it.

**Not this skill:** capturing a new diagram is `save-diagram`. Setting a store up for a project
that has none is the `state.diagrams.repo` block described in `diagrams-config`.
