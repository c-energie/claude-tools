# CLAUDE.md

## What this repo is

The c-energie **marketplace repo**, holding both context plugins as subdirectories:
`plugins/context-kit` (core layer) and `plugins/context-notion` (Notion middle layer). The
root carries only `.claude-plugin/marketplace.json`, `.gitattributes` and this file — every
plugin file, script and invariant lives inside its plugin directory, each with its own
`CLAUDE.md`. Both plugins moved here from repo-root / standalone-repo layouts on 2026-08-02
so that one repo fetch delivers everything (Cowork cannot fetch a second private repo, and
its installer did not surface a root-sourced plugin).

## Working on this repo

- **Check and bump per plugin, from the plugin's own directory:**
  `node plugins/<name>/scripts/check-plugin.mjs plugins/<name>` before any commit, and
  `node plugins/<name>/scripts/bump-version.mjs plugins/<name> patch|minor|major` once per
  release. Versions live in each plugin's `plugin.json` only — never in a `marketplace.json`
  `plugins[]` entry, where they silently override.
- **`marketplace.json` names both plugins with relative sources** (`./plugins/<name>`). Keep
  it to source / category / tags; hand-verify it after edits (no root-level linter).
- **`scripts/context-repo.sh` exists in BOTH plugins** — plugins cannot reach into each
  other's install directories, so the copy is deliberate. A resolver fix lands in
  context-kit's copy first, then context-notion's.
- `*.sh` stay LF (root `.gitattributes`); no angle brackets in any front-matter value; hooks
  exit 0 on every path.
