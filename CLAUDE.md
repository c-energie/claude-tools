# CLAUDE.md

## What this repo is

The c-energie **marketplace repo**, holding the context plugins as subdirectories:
`plugins/context-kit-core` (core layer), `plugins/context-notion` (Notion middle layer) and
`plugins/context-slack` (Slack delivery layer, added 2026-08-07). The root carries only
`.claude-plugin/marketplace.json`, `.gitattributes` and this file — every plugin file, script
and invariant lives inside its plugin directory, each with its own `CLAUDE.md`. The first two
moved here from repo-root / standalone-repo layouts on 2026-08-02 so that one repo fetch
delivers everything (Cowork cannot fetch a second private repo, and its installer did not
surface a root-sourced plugin).

## Working on this repo

- **Check and bump per plugin, from the plugin's own directory:**
  `node plugins/<name>/scripts/check-plugin.mjs plugins/<name>` before any commit, and
  `node plugins/<name>/scripts/bump-version.mjs plugins/<name> patch|minor|major` once per
  release. Versions live in each plugin's `plugin.json` only — never in a `marketplace.json`
  `plugins[]` entry, where they silently override.
- **`marketplace.json` names every plugin with a relative source** (`./plugins/<name>`). Keep
  it to source / category / tags; hand-verify it after edits (no root-level linter).
- **Some scripts exist as deliberate copies** — plugins cannot reach into each other's install
  directories. `context-repo.sh` is in all three; `lib.mjs`, `dates.mjs` and `pending-parse.mjs`
  are also in context-slack. **Fix the original first, then copy:** `context-repo.sh` originates
  in context-kit-core, the rest in context-notion (which owns the pending entry format).
- **`update-plugin` (context-kit-core) is the route for changing any of this** — it resolves the
  writable checkout, picks the right plugin, checks and bumps per plugin, and asks before pushing.
- `*.sh` stay LF (root `.gitattributes`); no angle brackets in any front-matter value; hooks
  exit 0 on every path.
