---
name: init-context
description: Create a NEW context repo for a project from the c-energie/context-template, then fill the placeholders, link the project and say what is left to do by hand. Triggers like "create a context repo for this project", "set up a new context repo", "stamp the template", "this project has no context repo yet".
---

# Create a project's context repo

The one first-run job that used to be a hand-run checklist in the template's README: stamp
`c-energie/context-template` into a real repo, fill its placeholders, put the clone where the
resolver looks (`~/.context/[owner]/[repo]`), and link the project to it.

It stamps no cross-project layer. ADR 0002 retired that: the personal layer is a workspace,
loaded through the user-level `~/.claude/CLAUDE.md`, and nothing in this plugin creates it.

## 1. Ask what the repo is called, then plan it

The repo name is an **argument, never a guess**. Deriving it from a git remote is exactly the
wrong-context failure the whole plugin exists to prevent. Ask, then run the plan — which
touches nothing:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/init-context.mjs" owner/project-context
```

It prints what it would create and where the clone would land. Useful options:
`--name "Project Name"` (what goes in `context.json` and the `memory.md` heading; otherwise
derived from the repo name), `--public`, and `--link .` to link the project directory in the
same run.

## 2. Show the plan and get an explicit yes before `--yes`

**Stop here and ask the user.** `--yes` creates repositories on GitHub and pushes to them —
outward-facing, visible immediately, and awkward to walk back. Show the plan output, confirm
the repo name and the private/public choice, and only then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/init-context.mjs" owner/project-context --link . --yes
```

Never fold `--yes` into the same command as the plan, and never run it on your own initiative.

What it then does: `gh repo create --template`, clone to `~/.context/[owner]/[repo]`
(retrying while GitHub populates the template), replace `{{PROJECT_NAME}}` / `{{OWNER_REPO}}` / `{{OWNER}}` / `{{DATE}}`
everywhere, run `context-doctor --fix` for the derivable config keys (the template's
`enabledPlugins` id among them), commit and push.

**It is idempotent, and adopts rather than overwrites.** A repo that already exists on GitHub
is cloned, not re-stamped; a clone already on disk is left untouched. So re-running it is
safe.

## 3. Report what is left by hand

The script prints these; relay them rather than doing them silently:

- **`memory.md` in the new repo is a skeleton.** Its headings are prompts, not rules. Offer to
  draft the first version from what this session already knows about the project.
- **Connectors** — a GitHub PAT whose resource owner is the repo's owner, plus any backend
  integration — are `setup-connectors`' job, driven by `context.json`'s `connections`.

If `gh` is missing or unauthenticated the script refuses before touching anything and says
which; the fallback is the manual route in the `c-energie/context-template` README.

**Not this skill:** pointing an *existing* context repo at a project is `context-setup` (or
`link-context.mjs` directly). Diagnosing a repo that is already linked is `context-doctor`.
Re-pulling one mid-session is `refresh-context`. Changing the plugins themselves is
`update-plugin`.
