# skills

Skills for writing skills. Install from the `c-energie` catalog: `skills@c-energie`. It needs
nothing else — no context repo, no Notion, no Slack — and is useful in any repo that wants a
skill of the kinds it knows.

| Skill | What it does |
| --- | --- |
| `author-setup-skill` | Interview an author about a setup they want automated, scaffold the setup skill (`SKILL.md` + a stdlib Python step script, plus the step-0 `setup-observer` if wanted) from the answers, then smoke-test and audit it |

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

The generated script is **Python**, not Node like this marketplace's own scripts: it runs in the
user's repo through `uv run --no-project --python 3.12`, which needs no system Python, and the
setups it drives are Python projects. `scaffold.mjs` itself is Node because it runs here.

## Layout

```
plugins/skills/
  scripts/scaffold.mjs                 spec JSON -> SKILL.md draft + step-script skeleton (+ observer)
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

- **In a target repo's `.claude/skills/`** — `scaffold.mjs` copies it in and writes the only
  per-repo part, `observer.toml`, from the interview. A repo that already has one is left alone
  and checked for drift from the master.
- **In another plugin's `skills/`** — `project-workspace` ships it as a live skill beside its
  own `observer.toml`, and `check-plugin.mjs` errors if that copy drifts.

Either way it is run as `"${CLAUDE_SKILL_DIR}/observe.py" --root "${CLAUDE_PROJECT_DIR}"`, so the
same two files work wherever they sit.
