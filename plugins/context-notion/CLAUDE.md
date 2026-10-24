# CLAUDE.md

## What this repo is

The **Notion middle layer** plugin (`context-notion`) in the c-energie three-layer context
architecture: core = context-kit (repo machinery), middle = this (generic Notion skills),
project = each workspace's `.claude/workspace.json` (or a legacy context repo's `context.json`). Nothing project-specific belongs here — no
database IDs, no names, no property schemas. If a skill needs one, it reads the project's
`state.notion` block; the README defines that contract and is the file to update when the
contract grows.

Lives at `plugins/context-notion` **inside the context-kit repo** (`c-energie/claude-tools`),
whose marketplace.json lists it with a relative source — one repo fetch delivers both plugins,
which is what lets Cowork install it. There is no marketplace.json here, and versions live in
`plugin.json` only. The standalone `c-energie/context-notion` repo is archived history.

## Commands

```bash
# Lint and bump live in context-kit-core only — dev-time tools no skill invokes, so they need
# no copy here. Run them from the marketplace root, naming this plugin's directory:
node ../context-kit-core/scripts/check-plugin.mjs .          # lint; run before any commit
node ../context-kit-core/scripts/bump-version.mjs . patch    # writes plugin.json only
CONTEXT_CONFIG=path/to/context.json node scripts/triage.mjs rows.json --today 2026-08-01
node scripts/pending-parse.mjs "$ROOT" --json
CONTEXT_CONFIG=path/to/context.json node scripts/mirror-render.mjs "$ROOT" export.json --dry-run
```

`CONTEXT_CONFIG` pins the config for testing; without it `lib.mjs` reads the nearest
`.claude/workspace.json` (via `scripts/workspace.mjs`), and only when there is none resolves the
legacy context repo via `scripts/context-repo.sh` (which obeys `PROJECT_CONTEXT_REPO`).

```bash
node --test scripts/layout.test.mjs                    # workspace layout, config ladder, queue, mirror, state write; offline
node scripts/layout.mjs "$ROOT"                        # meetings / queue / mirror paths for this root
node scripts/notion-state.mjs "$CONFIG" block.json     # PLAN state.backend + state.notion; --write
```

## Invariants

- **`scripts/context-repo.sh`, `scripts/dates.mjs`, `scripts/bash-bin.mjs`,
  `scripts/workspace.mjs` and `scripts/json-block.mjs` are copies of context-kit-core's** —
  plugins cannot reference each other's `${CLAUDE_PLUGIN_ROOT}`, so these copies exist on
  purpose. A fix to any of them lands in context-kit-core first, then here. This plugin is the
  **origin** for `lib.mjs`, `pending-parse.mjs` and `layout.mjs`, which context-slack copies: fix
  those here first. `check-plugin.mjs` errors if any copy drifts, comparing below the header banner.
- **Never spawn bare `bash`** — go through `bashBin()` from `scripts/bash-bin.mjs`. On Windows the
  `bash` on PATH is WSL's `System32\bash.exe`, which has its own filesystem and `$HOME`: it exits
  127 on a Windows path, and a caller reading only `status` blames the context repo for a bash
  problem.
- **Inside a workspace, this plugin's files live in the workspace layout (ADR 0002, #53), and
  `layout.mjs` is the one table that says so**: meetings → `docs/meetings/`, the queue →
  `.context/pending/` (+ `done/`), the mirror → `.context/notion/`; a legacy context repo keeps
  `meetings/`, `pending/`, `notion/`. `templates/` and `taxonomy.yml` stay at the root in both.
  The kind is `findWorkspace()`'s answer AT the root `workspace.mjs` printed, never a name. No
  skill or script types one of those paths itself — a guess that picks the other layout commits
  a queue entry where `process-pending` never reads, and nothing errors. Config follows the same
  ladder: `CONTEXT_CONFIG`, then the nearest `workspace.json`, then the legacy route.
- **This plugin writes exactly two keys of a config: `state.backend` and `state.notion`**, and
  only through `notion-state.mjs` (block-scale, via the json-block copy). `state` itself is
  shared — each `state.*` belongs to the plugin reading it — and in a workspace the other
  top-level keys belong to project-workspace and setup-connectors. Replacing `state` wholesale
  was notion-discover's old behaviour and erased sibling blocks.
- **`pending-parse.mjs` owns the pending entry format** — the single definition, so
  queues stay interchangeable across plugin versions.
- **`mirror-render.mjs` owns the mirror folder, and its property is "unchanged Notion ⇒ no
  diff"** — all sorting, clipping and column order live in the script, the mirror is never
  hand-edited, and a database absent from an export is left on disk (and carried forward in
  `_synced.json` with its own date) rather than blanked.
- **Owners resolve from `state.notion.people`, never `notion-search`** — workspace guests are
  invisible to search and the failure is silent.
- **An empty Notion result is never evidence of absence** (guests get zero rows, not errors).
  Read skills fall back to the Notion mirror (`.context/notion/` in a workspace, `notion/`
  in a legacy context repo) labelled with its `syncedOn`;
  write skills fall back to `add-pending`.
- **Follow `schemas` exactly, including odd property names** (trailing spaces exist — never
  trim). A date's wire shape depends on the tool — flattened `notion-create-pages` keys vs the
  REST `API-post-page` body, which 400s on the flattened form's extra key — so `notion-config`
  §5 owns the one date rule, split by tool the way the two-ids rule is, and no other skill
  restates a single-tool form.
  Owners/dates/statuses go in properties, never in a title.
- **`databases` and `pageParents` hold different Notion IDs** — data source vs database — and are
  not interchangeable. A create handed a data source ID 404s claiming the database is not shared
  with the integration, which names the wrong cause entirely and sends you to the wrong fix.
- **Skills that write to the workspace or context repo ask before committing/pushing**; `process-pending`
  is `disable-model-invocation: true`.
- Version in `plugin.json` only; no angle brackets in front-matter values; `*.sh` stay LF.
