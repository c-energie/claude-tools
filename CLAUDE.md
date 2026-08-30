# CLAUDE.md

## What this repo is

The c-energie **marketplace repo**, holding the context plugins as subdirectories:
`plugins/context-kit-core` (core layer), `plugins/context-notion` (Notion middle layer) and
`plugins/context-slack` (Slack delivery layer, added 2026-08-07). The root carries only
`.claude-plugin/marketplace.json`, `.gitattributes`, an optional `justfile` and this file —
every plugin file, script and invariant lives inside its plugin directory, each with its own
`CLAUDE.md`. The `justfile` is convenience only: `just` is not installed by default and
Cowork sandboxes cannot install it, so nothing may ever depend on a recipe, and a recipe that
grows logic of its own belongs in a `scripts/*.mjs` where `check-plugin.mjs` can see it.
The first two moved here from repo-root / standalone-repo layouts on 2026-08-02 so that one fetch
delivers everything (Cowork cannot fetch a second private repo, and its installer did not
surface a root-sourced plugin).

## Working on this repo

- **Check and bump per plugin.** Both tools live in **context-kit-core only** — they are
  dev-time, no skill invokes them, and they take the target plugin's directory as an argument,
  so a copy per plugin bought nothing and drifted:
  `node plugins/context-kit-core/scripts/check-plugin.mjs plugins/<name>` before any commit, and
  `node plugins/context-kit-core/scripts/bump-version.mjs plugins/<name> patch|minor|major` once
  per release. Versions live in each plugin's `plugin.json` only — never in a `marketplace.json`
  `plugins[]` entry, where they silently override.
- **`marketplace.json` names every plugin with a relative source** (`./plugins/<name>`). Keep
  it to source / category / tags; hand-verify it after edits (no root-level linter).
- **Some scripts exist as deliberate copies** — a skill can only reference
  `${CLAUDE_PLUGIN_ROOT}/scripts/...` inside its **own** plugin, so anything a skill calls at
  runtime must sit there. `context-repo.sh`, `dates.mjs` and `bash-bin.mjs` are in all three;
  `lib.mjs` and
  `pending-parse.mjs` are in context-notion and context-slack. **Fix the original first, then
  copy** — and the original is decided by *layer, not by who uses it most*: `context-repo.sh`,
  `dates.mjs` and `bash-bin.mjs` originate in **context-kit-core**, because all three are generic
  (dates.mjs is pure UTC arithmetic; bash-bin.mjs is a Windows platform fact — pick Git Bash, never
  WSL's `System32\bash.exe`, which cannot see the paths or the `$HOME` these scripts assume; core's
  own skills call both). `lib.mjs` and `pending-parse.mjs` originate in
  **context-notion**, which is the only layer entitled to know about `state.notion`, Notion user
  IDs and the queue format. `check-plugin.mjs` verifies this and errors on drift, comparing
  below each copy's header banner — the one part meant to differ. A tool that is *not* called by
  a skill does not need copying: `check-plugin.mjs` and `bump-version.mjs` live in
  context-kit-core alone, and had drifted while they were duplicated.
- **`update-plugin` (context-kit-core) is the route for changing any of this** — it resolves the
  writable checkout, picks the right plugin, checks and bumps per plugin, and asks before pushing.
- `*.sh` stay LF (root `.gitattributes`); no angle brackets in any front-matter value; hooks
  exit 0 on every path.
