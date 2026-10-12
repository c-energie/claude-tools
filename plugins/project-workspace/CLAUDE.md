# CLAUDE.md

## What this plugin is

**The project-workspace setup skills**, `plugins/project-workspace` inside
`c-energie/claude-tools`, added 2026-10-11. Moved here from
`c-energie/project-workspace-template/.claude/skills/` so that a fix reaches workspaces already made
— a template copy is frozen at stamping, a plugin updates in place. Since 2026-10-12 the plugin
is the only way in: the user installs it, and `setup-project-workspace` writes the workspace
itself; `project-workspace-template` is retired. `analysis-template` and `writing-template`
still enable it through a committed `.claude/settings.json` with `autoUpdate: true`.

A project workspace holds several documents; each is a document repo with, optionally, its
analysis repo nested inside it (root `CONTEXT.md` has the terms; the shape is
`docs/adr/0001-project-workspace-nested-documents.md`).

Outside the context stack, like `devhub` and `skills`: it reads no `context.json`.

## Invariants

- **`setup_workspace.py` is the one place that knows `workspace.toml`.** Which document a skill
  acts on is its `find_document` / `describe` (the `document` step); `copy_analysis.py` imports
  them from beside it rather than reading the file. A new reader does the same. Nothing about a
  document's analysis repo is written to `workspace.toml` — `layout.toml` in the document repo,
  owned by writing-template's `setup-nested.sh`, says it — except the `extras` its venv syncs.
- **Nesting is `setup-nested.sh`'s job, not the plugin's.** `add-analysis` and `migrate` call
  the document repo's own copy; never reimplement it here. A change to nesting goes to
  writing-template first.
- **Scripts never locate the workspace from their own path.** They run from the plugin cache,
  so every SKILL.md passes `--root "${CLAUDE_PROJECT_DIR}"`, and without `--root` a script uses
  the nearest directory at or above the current one holding `workspace.toml`, else the current
  directory. A new script follows the same `default_root()` / `set_root()` pattern; a module
  constant derived from `ROOT` must be reassigned in `set_root()` or `--root` silently misses it.
- **Script paths in SKILL.md bodies are `${CLAUDE_SKILL_DIR}/...`**; one skill reaching another's
  script uses `${CLAUDE_SKILL_DIR}/../[skill]/...`. Never a repo-relative `.claude/skills/` path —
  the workspace no longer has one.
- **Skill names are written in full**, `/project-workspace:[skill]`, in skills, scripts' messages
  and `CLAUDE.workspace.md`.
- **`skills/setup-observer/SKILL.md` and `observe.py` are verbatim copies** of the master in
  `plugins/skills/assets/setup-observer/`. Edit the master, copy it here, bump both plugins;
  `check-plugin.mjs` errors on drift. Only `observer.toml` is this plugin's own.
- **`CLAUDE.workspace.md` is workspace text, not plugin text.** `init` writes it into the
  workspace, and only the documents table between its `<!-- documents ... -->` markers is ever
  rewritten after that; keep those markers intact.
- **The scripts are stdlib-only Python with LF endings**, run through
  `uv run --no-project --python 3.12`, every write routed through `write`/`run` so `--dry-run`
  covers it. Their tests are the check: run both suites (README.md, "Tests") before a bump.
- **No shared script copies** from context-kit-core: nothing here calls `context-repo.sh`,
  `dates.mjs` or `bash-bin.mjs`.
