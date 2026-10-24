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

- **`setup_workspace.py` is the one place that knows `.claude/workspace.json`'s `members`**
  (and the only reader of `workspace.toml`, which only `migrate` reads). Which document a skill
  acts on is its `find_document` / `describe` (the `document` step); `copy_analysis.py` imports
  them, and `default_root`, from beside it rather than reading the file. A new reader does the
  same.
- **This plugin owns `schema`, `name`, `repo` and `members` in `workspace.json` and writes no
  other key** (ADR 0002: `connections` is setup-connectors', each `state.*` its plugin's).
  `write_state` edits at block scale, porting `json-block.mjs`'s guarantee: only the value span
  of an owned key that changed is replaced, so every other block keeps its bytes, its CRLF and
  its BOM. Unknown keys — top level and inside member entries — are carried through every write,
  because a member's dict is edited in place, never rebuilt. Never `json.dump` the whole file.
- **A member is `dir`, `repo`, `kind` (`code` | `document` | `analysis`)** plus kind-specific
  fields: a document's `name` and `extras` (its nested analysis venv's, as `sync` passes them);
  an analysis member's `documents`, the document dirs it feeds, relative to the root (`[]` is
  no-document mode, #41). A **workspace analysis** (#41, an analysis member inside no
  document's dir: `workspace_analyses`) also carries its venv's `extras`, since it has no
  document to hold them; only `attach-analysis` / `detach-analysis` change its `documents`,
  and only to name `kind: "document"` members. A nested analysis is recorded as a member
  (`dir: "<doc>/<analysis>"`, `documents: ["<doc>"]`) so the workspace can be restored from
  `members` alone, but **where it lives is still `layout.toml`'s to say** — owned by
  writing-template's `setup-nested.sh`; `describe` reads it from there.
- **`adopt` infers a member's `kind` from content, never from a name** (ADR 0002): a
  `layout.toml`, `Sections/` or root `.tex` file is a document, analysis-template's
  `doc_analysis` package beside a `pyproject.toml` an analysis repo, anything else code. It
  proposes and writes nothing until `--yes`, because the inference can be wrong; `--kind`
  corrects it. It refuses a root that already lists `members`. The schema-1 shape it can find
  (#33) goes through `migrate_schema_1` itself (`migrate_adopted`), never a second nesting
  path, so #34's stop for a load-bearing root `pyproject.toml` holds there too.
- **`restore` clones only what is missing and never touches a present member**; a nested
  analysis repo is restored through its document's `setup-nested.sh` (add-analysis's
  restore), never cloned directly; a workspace analysis is cloned and then synced with its
  recorded extras (`restore_workspace_checkout`, shared with `add-analysis --workspace`).
- **The root `.gitignore` block is an allowlist** (`write_document_block`): `/*/`, then
  `!/<dir>/` for `ROOT_OWN_DIRS` and any folder the root already tracks files in, then every
  top-level member. A new folder a workspace owns by convention goes into `ROOT_OWN_DIRS`, or
  git ignores it without a word.
- **No dual-writing.** While `workspace.toml` is the only manifest (no `workspace.json`, or one
  without `members`), every step but `check` and `migrate` refuses in one line naming
  `migrate` (`MIGRATE_FIRST`). Nothing writes both files.
- **Nesting is `setup-nested.sh`'s job, not the plugin's.** `add-analysis` and `migrate` call
  the document repo's own copy; never reimplement it here. A change to nesting goes to
  writing-template first.
- **Scripts never locate the workspace from their own path.** They run from the plugin cache,
  so every SKILL.md passes `--root "${CLAUDE_PROJECT_DIR}"`, and without `--root` a script uses
  `default_root()`: the nearest directory at or above the current one holding
  `.claude/workspace.json` (or, until migrated, `workspace.toml`; the nearer wins), else the
  current directory. A new script follows the same `default_root()` / `set_root()` pattern; a
  module constant derived from `ROOT` must be reassigned in `set_root()` or `--root` silently
  misses it.
- **`find_workspace()` is a Python PORT of context-kit-core's `findWorkspace()`
  (`scripts/workspace.mjs`, #47), not a copy**: a skill can only call scripts in its own plugin,
  and `check-plugin.mjs`'s drift rule cannot compare Python with Node. Same rules — nearest
  wins, levels never merge, the walk does not stop at a member's `.git`, and a malformed
  nearest file (a directory of that name included) stops the walk and is reported with its
  path and parse error, never skipped past to an outer workspace. `FindsTheRoot` in
  `test_setup_workspace.py` mirrors `workspace.test.mjs`'s cases: **change one walk, change the
  other, and extend both test files.** Unlike the resolver there is no context-repo fallback:
  a malformed file stops the step.
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
  rewritten after that; keep those markers intact. The Analyses table (#41) lives inside the
  same markers, so a workspace made before it gains the table without a second block.
- **The scripts are stdlib-only Python with LF endings**, run through
  `uv run --no-project --python 3.12`, every write routed through `write`/`run` so `--dry-run`
  covers it. Their tests are the check: run both suites (README.md, "Tests") before a bump.
- **No shared script copies** from context-kit-core: nothing here calls `context-repo.sh`,
  `dates.mjs` or `bash-bin.mjs`.
