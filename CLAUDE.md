# CLAUDE.md

## What this repo is

`c-energie/claude-tools` — the c-energie **marketplace repo**, holding every plugin as a
subdirectory: `plugins/context-kit-core` (core layer), `plugins/context-notion` (Notion middle
layer), `plugins/context-slack` (Slack delivery layer, added 2026-08-07), `plugins/diagrams`
(the diagram store) and `plugins/devhub` (dev-hub manifest authoring) — the last two added
2026-08-31 — and `plugins/skills` (skill authoring, added 2026-10-06), and `plugins/project-workspace`
(document-workspace setup skills, moved here from `doc-workspace-template` on 2026-10-11). **Not every plugin here is part of the context stack**: `devhub` reads no
`workspace.json` and serves any repo at all. The catalog is the org's tooling, not one system's. The root carries only
`.claude-plugin/marketplace.json`, `.gitattributes`, an optional `justfile` and this file —
every plugin file, script and invariant lives inside its plugin directory, each with its own
`CLAUDE.md`.

**Repo name and catalog name differ on purpose.** The repo is `claude-tools`; the catalog it
declares is `name: "c-energie"`, so identifiers read `context-kit-core@c-energie`. The catalog is
named for the **org** because that is what it is — a marketplace is a permission boundary (read
on this repo, all-or-nothing across its plugins), while a plugin is a topic boundary that costs
nothing to add. Hence the rule in README.md: *a separate GitHub org gets a separate catalog; the
same people plus a new topic gets a new plugin here.* Both names were `context-kit` until
2026-08-31; the catalog `version` went to `1.0.0` to mark that the old identifiers are dead. A
stale `X@context-kit` in some repo's `enabledPlugins` is **silently ignored**, not reported, so
it presents as a plugin that failed to load — `context-doctor` carries the retired name and
flags it.

Context repos and their clone root `~/.context` are retired (ADR 0002; the last route removed
in #60, and `~/.context` archived and deleted on 2026-10-25). A project's context lives in its
workspace, found by the nearest `.claude/workspace.json`.

The `justfile` is convenience only: `just` is not installed by default and
Cowork sandboxes cannot install it, so nothing may ever depend on a recipe, and a recipe that
grows logic of its own belongs in a `scripts/*.mjs` where `check-plugin.mjs` can see it.
The first two plugins moved here from repo-root / standalone-repo layouts on 2026-08-02 so that
one fetch delivers everything (Cowork cannot fetch a second private repo, and its installer did not
surface a root-sourced plugin).

## Working on this repo

- **Check and bump per plugin.** Both tools live in **context-kit-core only** — they are
  dev-time, no skill invokes them, and they take the target plugin's directory as an argument,
  so a copy per plugin bought nothing and drifted:
  `node plugins/context-kit-core/scripts/check-plugin.mjs plugins/<name>` before any commit, and
  `node plugins/context-kit-core/scripts/bump-version.mjs plugins/<name> patch|minor|major` once
  per release. Versions live in each plugin's `plugin.json` only — never in a `marketplace.json`
  `plugins[]` entry, where they silently override. Every error `check-plugin.mjs` catches is a
  **silent** failure — the plugin installs cleanly and the skill simply never appears — so exit 1
  means fix before committing. **Pull before bumping**: two sessions bumping the same plugin
  produce two commits claiming one version, and only one of them ships.
- **`marketplace.json` names every plugin with a relative source** (`./plugins/<name>`). Keep
  it to source / category / tags; hand-verify it after edits (no root-level linter).
- **Some scripts exist as deliberate copies** — a skill can only reference
  `${CLAUDE_PLUGIN_ROOT}/scripts/...` inside its **own** plugin, so anything a skill calls at
  runtime must sit there. `dates.mjs` and `workspace.mjs` (core's) are in
  the plugins that call them; `lib.mjs`, `pending-parse.mjs` and `layout.mjs` (context-notion's)
  are in context-notion and context-slack; `json-block.mjs` (core's) is in context-notion.
  `COPIES` in `check-plugin.mjs` is the full list. **Fix the original first, then
  copy** — and the original is decided by *layer, not by who uses it most*: `dates.mjs` and the
  workspace resolver originate in **context-kit-core**, because they are generic (dates.mjs is
  pure UTC arithmetic; finding the nearest `.claude/workspace.json` knows no backend). `lib.mjs`, `pending-parse.mjs` and `layout.mjs` originate in
  **context-notion**, which is the only layer entitled to know about `state.notion`, Notion user
  IDs, the queue format and where the queue and the mirror live. `check-plugin.mjs` verifies this and errors on drift, comparing
  below each copy's header banner — the one part meant to differ. A tool that is *not* called by
  a skill does not need copying: `check-plugin.mjs` and `bump-version.mjs` live in
  context-kit-core alone, and had drifted while they were duplicated.
- **`update-plugin` (context-kit-core) is the route for changing any of this** — it resolves the
  writable checkout, picks the right plugin, checks and bumps per plugin, and asks before pushing.
- **`plugin-repo.sh` only ever considers `$cwd`**, never its subdirectories, so a session started
  anywhere that is not itself the marketplace resolves to the managed clone instead. That is how a
  second, drifting checkout came about before 2026-08-11.

### Skill authoring rules that fail silently if broken

Each one installs cleanly and then simply does not work, which is why they are written down
rather than left to be noticed.

- Directory name and front-matter `name` **must match**.
- **No angle brackets in any front-matter value** — the ingester reads them as a tag and drops the
  field. Use `[placeholder]` or `{placeholder}`; body text is fine.
- `description` is what makes a skill auto-trigger: what it does *plus* natural trigger phrases,
  one line. End the body with a **"Not this skill:"** line routing to the neighbours that own the
  adjacent jobs.
- Anything that **writes outside the session** (git push, Slack post, a commit to a shared store)
  is `disable-model-invocation: true` or carries an explicit ask-before-push gate.
- `user-invocable: false` for reference-only skills (`context-access`, `notion-config`,
  `slack-config`, `diagrams-config`) — background knowledge, not a task to run.
- Reference scripts by full `${CLAUDE_PLUGIN_ROOT}/…` paths, within the skill's **own** plugin.
- Anything that must come out identically every time (date maths, buckets, mirror rendering,
  index schemas) belongs in a `scripts/*.mjs`, not in prose.
- `*.sh` stay LF (root `.gitattributes`, checked by the linter); hooks exit 0 on every path.

## Agent skills

### Issue tracker

GitHub Issues on `c-energie/claude-tools`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, label string = role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
