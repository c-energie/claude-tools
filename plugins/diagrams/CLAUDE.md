# CLAUDE.md

## What this plugin is

The **diagram store** layer, `plugins/diagrams` inside `c-energie/claude-tools`. It captures
diagrams a session drew into a per-org git store and reads them back through a built gallery.

It is a *topic* layer, not a backend layer: it needs no Notion and no Slack, and it knows only
the keys (`state.diagrams.repo`), never a store name, an org, or a tag. Added 2026-08-31, when a
new topic for the same people was the case that decided the catalog rule — a separate GitHub org
gets a separate catalog, the same people plus a new topic gets a new plugin here.

## Commands

```bash
node scripts/diagram-store.mjs where              # resolve this project's store
node scripts/diagram-store.mjs taxonomy           # the vocabulary in force
node scripts/diagram-store.mjs tags-in-use        # what has actually accumulated
node scripts/diagram-store.mjs init [dir]         # stamp the house files (--taxonomy for a starter)
node scripts/save-diagram.mjs pic.svg --title "…" --type architecture --dry-run
node scripts/gallery-build.mjs [store] [store] --out ~/Desktop/diagrams.html --today 2026-08-31
```

`DIAGRAMS_STORE=owner/repo` or `CONTEXT_CONFIG=path/to/context.json` pins the config, so every
script runs with no context repo. `node --test scripts/diagram-store.test.mjs` covers the resolver
offline (env, cwd, context and origin owner are injected). `--today` and `--date` pin dates so output can be
compared.

## Invariants (all load-bearing)

- **`diagram-store.mjs` is the schema, and both sides import it.** `save-diagram.mjs` writes
  `index.jsonl` through it and `gallery-build.mjs` reads through it. Never add a field to one
  side: a writer and a reader agreeing only by convention stop agreeing the first time the record
  changes, and the symptom is a gallery quietly missing rows while still rendering.
- **No default store, ever.** The store is named by `DIAGRAMS_STORE`, else the repo's
  `.diagrams.json`, else `context.json` `state.diagrams.repo` (`locateStore`); none is an
  **error listing all three** — never a fallback, never "the store that exists on this machine",
  never inferred from the origin owner (the error may *suggest* it). The ladder made context-kit
  optional (2026-10-15); it added no default. The stores are a
  permission boundary between orgs; a default means an unconfigured project writing into another
  org's store, silently, and it is in the history by the time anyone notices. Same shape as the
  core layer's rule for `PROJECT_CONTEXT_REPO`, and for the same reason: *configured*,
  *unconfigured* and *opted out* must stay three distinguishable outcomes.
- **The org boundary is checked on every resolve, not once at setup.** Home is the cwd repo's
  origin owner, else the context repo's owner; a store in another org throws unless the block
  carries `crossOrg: true` (`DIAGRAMS_CROSS_ORG=1` for the env rung). A config file travels
  between repos, so the check travels with the use. No home → `unchecked`, reported, not refused.
- **`index.jsonl` is append-only.** One line per diagram, so concurrent saves conflict on
  nothing — the closing bracket of a JSON array is a merge conflict on every write. A malformed
  line is reported and skipped, never fatal: one bad append must not make the store unreadable.
- **Source is committed; rasters are build output.** SVG and HTML only. A PNG is welcome beside
  the source and is lazy-linked by the gallery, never inlined (base64 takes the single file from
  tens of KB to tens of MB) and never accepted *instead of* source. `save-diagram.mjs` refuses
  any other extension and says why.
- **The vocabulary lives in the STORE, not here.** `taxonomy.json` at the store root. A tag list
  shipped in this plugin would be the same layering error as a hard-coded database ID. Absent /
  `[]` / non-empty mean *unagreed* / *deliberately open* / *closed*, and the guard treats all
  three differently — absent proceeds **loudly** rather than blocking, because a store should not
  be unusable until a meeting happens, and it must not be silent because silence is how
  `architecture` / `arch` / `system-diagram` become three tags.
- **The gallery is ONE self-contained file, opened over `file://`.** Not a preference: a
  `file://` page cannot `fetch()` a sibling `index.jsonl` — the browser blocks it as cross-origin
  to a null origin — so a "just load the JSON" gallery works from a dev server and shows an empty
  grid when double-clicked. Inlined SVG is sanitised (`<script>`, `on*=`) because the page is
  opened with local-file reach.
- **Multi-store is a LOCAL convenience.** Passing two stores is for a person holding both grants.
  There is no deployed instance and no plan for one; a deployed gallery is single-store with its
  own access policy, because merging stores in the viewing layer re-breaches the boundary the
  split exists to hold. The constraint is in `gallery-build.mjs`'s header as well as the docs —
  a `--serve` flag or a deploy step in that file is undoing a decision, not adding a feature.
- **`save-diagram` never pushes**, and is `disable-model-invocation: true`. The script commits
  locally; the skill asks before the push. Same gate as `save-thread`, same reason.
- **The searchable text is lifted from the source, by regex, deliberately.** `extractText()` is
  not an XML parse: the input is a file Claude just wrote, a dependency-free script cannot parse
  HTML properly anyway, and a missed label costs one search hit while a thrown parser costs the
  whole save.
- **`context-repo.sh`, `dates.mjs` and `bash-bin.mjs` are copies of context-kit-core's** — a
  skill can only reference `${CLAUDE_PLUGIN_ROOT}/scripts/…` inside its own plugin. Fix the
  original in **context-kit-core** first, then copy. `check-plugin.mjs` errors on drift.
- **Never spawn bare `bash` from a `.mjs`** — always `bashBin()`. See core's CLAUDE.md for why.
