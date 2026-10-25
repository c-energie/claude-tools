# CLAUDE.md

## What this plugin is

**Skills for writing skills**, `plugins/skills` inside `c-energie/claude-tools`, added
2026-10-06. One skill so far: `author-setup-skill`, which scaffolds and audits interactive setup
skills to the recipe in its `references/recipe.md`.

Outside the context stack, like `devhub`: it reads no `workspace.json` and the skills it writes
live in any repo. A new authoring skill for another *kind* of skill belongs here; a skill that
only edits this marketplace's plugins is `update-plugin`'s job, in context-kit-core.

## Where the truth lives

- **The recipe is a copy of a context thread.** It was distilled in
  `corson94/second-brain` `threads/2026-10-06-setup-skill-authoring-lessons.md`; once shipped,
  `references/recipe.md` is the version that matters. A new lesson goes here first; the skill
  cites lessons by number (**L*n***), so renumbering means updating `SKILL.md` too.
- **The worked examples are the `project-workspace` plugin's skills** (moved there from
  `c-energie/project-workspace-template`'s `.claude/skills/` on 2026-10-11). The recipe names them;
  it does not copy them.
- **`assets/setup-observer/` is the master of the step-0 observer**, and it stays here because
  any setup skill can use it, not only the doc-workspace ones. Its `SKILL.md` and `observe.py`
  are copied *verbatim* to two kinds of place: `scaffold.mjs` copies them into a target repo's
  `.claude/skills/` (or, with `--plugin`, a plugin's `skills/`) beside an `observer.toml` it
  writes from the spec; and every plugin that ships
  `skills/setup-observer/` carries them as a live skill beside its own `observer.toml`. The
  `observer.toml` is the one per-deployment file (owner table, env vars, state files, extra tools). Keep both master files
  free of anything project-specific, or every copy inherits it. **Location-independent**: the
  command is `"${CLAUDE_SKILL_DIR}/observe.py" --root "${CLAUDE_PROJECT_DIR}"`, and without
  `--root` the script falls back to three levels up when it sits in `.claude/skills/`, else the
  current directory. **A change here is copied to every plugin's `skills/setup-observer/` in the
  same commit** — `check-plugin.mjs` finds those copies itself (a plugin with that directory is
  bound; there is no list to edit), errors on drift or on a half-copied directory, and every
  plugin touched gets a bump.
- `assets/` sits outside `skills/` on purpose: only `skills/[name]/SKILL.md` registers as a
  plugin skill, so the observer's `SKILL.md` is inert here and live only once copied.
- **`scaffold.mjs` and `SKILL.md` must agree** on the spec keys and on what the skeleton
  contains. Change one, check the other: `scaffold.mjs --example` piped into a scratch
  `--out` is the test, then `--help` on the generated script — and again with `script` renamed
  to `.mjs`, and once with `--plugin` on a scratch plugin.

## Invariants

- **Auto-invocable, writes only to the target repo, never commits on its own** — step 7 asks
  before the commit and separately before the push.
- **`scaffold.mjs` never overwrites.** Its output is hand-edited from the first minute; a re-run
  that clobbered it would destroy the author's work. Exit 2 on an existing skill file; an
  existing `setup-observer/` is left untouched and only drift-checked against the master.
- **Generated front-matter carries no angle brackets** — `scaffold.mjs` rejects them in `does`,
  `trigger`, `title`, `stateFile` and `existingState.check`, all of which can reach the
  generated `description` (the derived trigger names the state file or the check command).
- **The generated script is dependency-free** (Python stdlib or node built-ins, picked by the
  script's extension), **LF endings**, every write routed through `write`/`run` so `--dry-run`
  covers it, `write` confined to `--root`, and unimplemented steps exit 4 rather than 0 — a stub
  must never pass for a done step. **The two skeletons keep one contract**: same steps, flags,
  OK/REFUSED/FAILED lines and exit codes from the same spec, so a change to one is made to the
  other (`--help` and `--dry-run` on a `.py` and a `.mjs` from one spec is the test). There is
  no TOML in the node skeleton, on purpose: node has no built-in parser, and the scaffold rejects
  a `.mjs` script owning a `.toml` state file rather than take a dependency.
- **`--root` is required in a plugin-shipped script**: it sits in the plugin's install
  directory, so its location says nothing about the project, and defaulting to the cwd would
  write into wherever the agent happened to be.
- No shared script copies: nothing here calls `workspace.mjs` or `dates.mjs`.
