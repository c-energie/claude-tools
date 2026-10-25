# skills

Skills for writing skills. Install from the `c-energie` catalog: `skills@c-energie`. It needs
nothing else — no workspace, no Notion, no Slack — and is useful in any repo that wants a
skill of the kinds it knows.

| Skill | What it does |
| --- | --- |
| `author-setup-skill` | Interview an author about a setup they want automated, scaffold the setup skill (`SKILL.md` + a dependency-free Python or node step script, repo-local or plugin-shipped, plus the step-0 `setup-observer` if wanted) from the answers, then smoke-test and audit it |

## What `author-setup-skill` is actually for

A setup skill — one that walks a user through creating repos from templates, installing tools
and wiring them together — goes wrong in the same ways every time: the agent acts before the
interview is finished, a rule that must never break lives only in prose, a step is "done when it
looks right", the proof runs from one directory only. The five doc-workspace setup skills (now
the `project-workspace` plugin) learned fifteen lessons fixing exactly those, and
`references/recipe.md` is that recipe.

The skill applies it in order: interview into a JSON **spec**, `scaffold.mjs` turns the spec into
a draft whose every unanswered judgement is a `TODO(author)` marker, the author fills those in,
the result is smoke-tested in a scratch workspace (guardrails attacked, every step run twice) and
audited — `writing-for-agents`, then a fresh agent checking the SKILL.md against the script's
real CLI.

The generated script's extension picks its language. **Python** (`.py`, stdlib only) runs in the
user's repo through `uv run --no-project --python 3.12`, which needs no system Python, and suits
setups that drive Python projects. **Node** (`.mjs`, built-ins only) suits a node-only plugin,
where uv would be one more install for the script alone; it owns JSON state only, since node has
no built-in TOML. The two skeletons share one contract — same steps, flags, messages and exit
codes. `scaffold.mjs` itself is Node because it runs here.

A setup skill is either **repo-local** (`--out [repo]/.claude/skills/[skill]`, the script beside
its SKILL.md) or **plugin-shipped** (`--plugin [plugin dir]`: SKILL.md under `skills/`, the
script under `scripts/`, called with `--root "${CLAUDE_PROJECT_DIR}"`). Its state is either
**owned** (`stateFile`, a file it creates) or **joined** (`existingState`, a record other skills
already define that it fills in).

## Layout

```
plugins/skills/
  scripts/scaffold.mjs                 spec JSON -> SKILL.md draft + .py or .mjs step-script skeleton (+ observer)
  skills/author-setup-skill/
    SKILL.md
    references/recipe.md               the fifteen lessons
  assets/setup-observer/               master copy of the step-0 observer, copied into target repos
    SKILL.md                           verbatim; inert here (outside skills/)
    observe.py                         verbatim; reads the repo's own observer.toml
```

## The setup observer

Every setup skill starts by invoking `/setup-observer`: it baselines the machine, logs each place
the guide and reality disagree (failed commands caught by a skill-scoped `PostToolUseFailure`
hook), and with consent files redacted issues or PRs on the repo that owns each problem. The
master here is inert; it runs from one of two kinds of copy, both verbatim:

- **Beside the new skill** — a target repo's `.claude/skills/`, or with `--plugin` a plugin's
  `skills/` — `scaffold.mjs` copies it in and writes the only
  per-repo part, `observer.toml`, from the interview. A repo that already has one is left alone
  and checked for drift from the master.
- **In another plugin's `skills/`** — `project-workspace` and `diagrams` ship it as a live skill
  beside their own `observer.toml`, and `check-plugin.mjs` errors if a copy drifts.

Either way it is run as `"${CLAUDE_SKILL_DIR}/observe.py" --root "${CLAUDE_PROJECT_DIR}"`, so the
same two files work wherever they sit.
