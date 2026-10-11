# CLAUDE.md

## What this plugin is

**The document-workspace setup skills**, `plugins/project-workspace` inside
`c-energie/claude-tools`, added 2026-10-11. Moved here from
`c-energie/project-workspace-template/.claude/skills/` so that a fix reaches workspaces already made
from the template — a template copy is frozen at stamping, a plugin updates in place. All three
templates (`project-workspace-template`, `analysis-template`, `writing-template`) enable it through a
committed `.claude/settings.json` with `autoUpdate: true` on the `c-energie` marketplace entry.

Outside the context stack, like `devhub` and `skills`: it reads no `context.json`.

## Invariants

- **Scripts never locate the workspace from their own path.** They run from the plugin cache,
  so every SKILL.md passes `--root "${CLAUDE_PROJECT_DIR}"`, and without `--root` a script uses
  the nearest directory at or above the current one holding `workspace.toml`, else the current
  directory. A new script follows the same `default_root()` / `set_root()` pattern; a module
  constant derived from `ROOT` must be reassigned in `set_root()` or `--root` silently misses it.
- **Script paths in SKILL.md bodies are `${CLAUDE_SKILL_DIR}/...`**; one skill reaching another's
  script uses `${CLAUDE_SKILL_DIR}/../[skill]/...`. Never a repo-relative `.claude/skills/` path —
  the workspace no longer has one.
- **Skill names are written in full**, `/project-workspace:[skill]`, in skills, scripts' messages
  and `CLAUDE.writing-only.md`.
- **`skills/setup-observer/SKILL.md` and `observe.py` are verbatim copies** of the master in
  `plugins/skills/assets/setup-observer/`. Edit the master, copy it here, bump both plugins;
  `check-plugin.mjs` errors on drift. Only `observer.toml` is this plugin's own.
- **`CLAUDE.writing-only.md` is workspace text, not plugin text.** `setup_workspace.py root` puts
  it in place of the template's full-layout `CLAUDE.md`. Keep it in step with
  `project-workspace-template/CLAUDE.md` — the two describe the same shell in two layouts.
- **The scripts are stdlib-only Python with LF endings**, run through
  `uv run --no-project --python 3.12`, every write routed through `write`/`run` so `--dry-run`
  covers it. Their tests are the check: run both suites (README.md, "Tests") before a bump.
- **No shared script copies** from context-kit-core: nothing here calls `context-repo.sh`,
  `dates.mjs` or `bash-bin.mjs`.
