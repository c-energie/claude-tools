# CLAUDE.md

## What this plugin is

**Skills for writing skills**, `plugins/skills` inside `c-energie/claude-tools`, added
2026-10-06. One skill so far: `author-setup-skill`, which scaffolds and audits interactive setup
skills to the recipe in its `references/recipe.md`.

Outside the context stack, like `devhub`: it reads no `context.json` and the skills it writes
live in any repo. A new authoring skill for another *kind* of skill belongs here; a skill that
only edits this marketplace's plugins is `update-plugin`'s job, in context-kit-core.

## Where the truth lives

- **The recipe is a copy of a context thread.** It was distilled in
  `corson94/second-brain` `threads/2026-10-06-setup-skill-authoring-lessons.md`; once shipped,
  `references/recipe.md` is the version that matters. A new lesson goes here first; the skill
  cites lessons by number (**L*n***), so renumbering means updating `SKILL.md` too.
- **The worked examples are `c-energie/doc-workspace-template`'s `.claude/skills/`.** The recipe
  names them; it does not copy them.
- **`assets/setup-observer/` is the master of the step-0 observer.** `scaffold.mjs` copies its
  `SKILL.md` and `observe.py` *verbatim* into each target repo, beside an `observer.toml` it
  writes from the spec — the one per-repo file (owner table, env vars, state files, extra
  tools). It is copied rather than run from here because a setup skill's users may not have
  this plugin. Keep both master files free of anything project-specific, or every copy
  inherits it. Moved here from `doc-workspace-template` on 2026-10-06; that repo's own copy
  predates `observer.toml` and is now downstream — re-sync it from here.
- `assets/` sits outside `skills/` on purpose: only `skills/[name]/SKILL.md` registers as a
  plugin skill, so the observer's `SKILL.md` is inert here and live only once copied.
- **`scaffold.mjs` and `SKILL.md` must agree** on the spec keys and on what the skeleton
  contains. Change one, check the other: `scaffold.mjs --example` piped into a scratch
  `--out` is the test, then `--help` on the generated script.

## Invariants

- **Auto-invocable, writes only to the target repo, never commits on its own** — step 7 asks
  before the commit and separately before the push.
- **`scaffold.mjs` never overwrites.** Its output is hand-edited from the first minute; a re-run
  that clobbered it would destroy the author's work. Exit 2 on an existing skill file; an
  existing `setup-observer/` is left untouched and only drift-checked against the master.
- **Generated front-matter carries no angle brackets** — `scaffold.mjs` rejects them in `does`
  and `trigger`, which become the generated `description`.
- **The generated script is stdlib-only Python with LF endings**, every write routed through
  `write`/`run` so `--dry-run` covers it, `write` confined to the repo root, and unimplemented
  steps exit 4 rather than 0 — a stub
  must never pass for a done step.
- No shared script copies: nothing here calls `context-repo.sh`, `dates.mjs` or `bash-bin.mjs`.
