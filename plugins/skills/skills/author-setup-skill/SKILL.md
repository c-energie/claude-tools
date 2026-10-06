---
name: author-setup-skill
description: Author a new interactive setup skill — one that walks a user through creating repos from templates, installing tools and wiring them together — by interviewing the author, scaffolding SKILL.md plus a stdlib step script with --dry-run and a state file, then auditing both. Use when writing a setup or onboarding skill, or rebuilding an existing one to the setup-skill recipe.
---

# Author a setup skill

You are writing a **setup skill** for someone else's repo: the skill does the interview and the
judgement, a script beside it does the mechanics. The recipe behind every step here is
[`references/recipe.md`](references/recipe.md) — fifteen lessons, each cited below as **L*n***.
**Read it in full before step 1**; the interview only makes sense once you know what the
answers feed.

## 1. Interview the author

The author is the person maintaining the setup, not its eventual user. Ask a few questions at a
time and write the answers into a **spec** — a JSON file in a scratch directory outside the
target repo. `node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" --example` prints a complete spec
to start from; its keys are the checklist (any other key is rejected):

| Spec key | Ask |
|---|---|
| `skill`, `script`, `title` | Name of the skill (`setup-…`, a slug), its script (`setup_….py`) and heading |
| `does`, `trigger` | What it sets up, and the observable condition that means it hasn't been yet (a missing state file beats "the user asks") |
| `stateFile` | The `.toml` file the setup writes once and later skills read instead of re-asking (L2) |
| `tools` | Every tool `check` must find |
| `questions[]` | `{ask, default, why}` — what the *user* will be asked (L4). Visibility is always one (L3) |
| `modes` | `{question, rows: [{answer, mode, effect}]}` — where an answer changes the path (L4); a step taking `--mode` gets the modes as its choices |
| `steps[]` | Each mechanical step, in order: `{name, does, args: ["--flag", …], done, outward}` — `done` is what must be TRUE afterwards (L7); `outward: true` for anything visible beyond this machine (repo create, push, visibility change) |
| `invariants[]` | `{rule, step}` — every rule that must never break, and the step whose code enforces it (L6) |
| `proof` | `{step, does, cwds: […], done}` — the step that runs the real pipeline end to end, from two or more working directories (L8) |
| `observer` | `false`, or `{owners, envVars, secretVars, stateFiles, tools}` — settled in step 2 |
| `neighbours` | The skills that own the adjacent jobs, for the "Not this skill" line |

Probe the two answers authors under-give: **every** outward-facing step (each needs the
paste-safe user-run fallback, L12) and **every** invariant (an invariant without an enforcing
step is a wish). Templates involved? Ask whether each ships an `init.py` and what it reads on
stdin (L3).

Read the finished spec back as a table and get an explicit yes. Done when the user has
confirmed the spec as shown.

## 2. Settle step 0 — the observer

L10: every setup skill starts by invoking `/setup-observer`, which watches the run and files
what the guide got wrong. This plugin holds its master copy; step 3 copies it into the repo
(the setup's own users may not have this plugin, so the repo must carry it). Ask the author
whether to include it, then look for `.claude/skills/setup-observer/` in the target repo:

- **Absent, included** — fill the spec's `observer` object: `owners` (`{repo, covers}` per
  repo a deviation could be filed on — the repo holding these skills, each template), plus any
  `envVars` / `secretVars` already-set-before-setup would matter for, and `stateFiles` if more
  than `stateFile`. Step 3 writes these into the repo's `observer.toml` and gitignores `.setup/`.
- **Present** — step 3 leaves it alone and reports drift from the master. Add a row to its
  `observer.toml` `[[owners]]` for any repo the new skill touches that it lacks.
- **Declined** — `"observer": false`; the generated SKILL.md then has no step 0.

Done when the spec's `observer` is settled with the author.

## 3. Scaffold

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" --spec <spec.json> --out <repo>/.claude/skills/<skill> --dry-run
node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" --spec <spec.json> --out <repo>/.claude/skills/<skill>
```

It validates the spec (exit 1 lists every problem — fix the spec and re-run), refuses to
overwrite an existing `SKILL.md` or script (exit 2), prints how many `TODO(author)` markers
each file carries, and installs or drift-checks the observer per step 2. Done when it exits 0
and every file it lists exists.

## 4. Fill in

Work through every `TODO(author)` marker with the author:

- **The script** — implement each `cmd_<step>` so it reuses what exists and raises `Refused`
  rather than overwriting (L1); route every write through `write`/`run` so `--dry-run` covers
  it (`write` also refuses anything outside the repo root unless given `root=`); implement each
  `GUARDRAIL` comment as a refusal in code (L6); have the last step call `save_state`, or the
  skill keeps re-triggering on the missing state file (L2); fill `INSTALL` per platform and bake
  in the platform traps (L11). Templates are filled by feeding their `init.py` on stdin
  (L3).
- **The SKILL.md** — the end-state tree; the refusal each guardrail prints; which mode to
  recommend when the user is unsure; any third-party UI steps, written in exactly one place
  (L9); for each outward step, the exact command the user runs if auto mode blocks it (L12).

Done when `grep -rn "TODO(author)" <repo>/.claude/skills/<skill> <repo>/.claude/skills/setup-observer`
prints nothing.

## 5. Smoke-test in a scratch workspace

L13. The script finds its root from its own location (`ROOT` is three levels above it), so
run it from a copy: copy the skill directory to `<scratch>/.claude/skills/<skill>/` in a
throwaway directory — never a real project — and run that copy. Run `check`, every step with
`--dry-run`, then every step for real against throwaway targets, then each step a **second**
time. Then attack each guardrail: tamper with what it protects, aim a destination outside the
target, and confirm the step refuses. Finish with the proof step from every listed directory.

Done when every step exits 0 twice in a row, every guardrail has been seen refusing, and the
proof passes from every directory. If the project has a real test bed for acceptance, name it
to the author as the next run.

## 6. Audit

1. **writing-for-agents** (L14): invoke the `writing-for-agents` skill where installed, and
   apply it to the new `SKILL.md` — front-loaded description, one trigger per branch, positive instructions,
   prohibitions only as hard guardrails paired with their target, one source of truth per fact.
2. **Fresh-agent review** (L15): dispatch a subagent with no context from this session. Give it
   the two file paths and this brief: *for every command the SKILL.md tells the agent to run,
   check it against the script's actual `--help` and code; then hunt for completion criteria
   already true on arrival, cleanup that deletes something a later step needs, any path by
   which a step can write into what an invariant protects, and steps that are not safe to
   re-run. Report each with file and line.*

Done when every finding is fixed — re-run step 5 for any script change — or dismissed to the
author with a reason.

## 7. Commit

Show `git status` in the target repo and propose the commit (the new skill directory, plus
`setup-observer/` and `.gitignore` if step 3 added them). Ask before committing, and separately before pushing.

**Not this skill:** a skill that ships in a c-energie plugin goes through `update-plugin`;
general skill packaging is `skill-creator`; running a setup and reporting where its guide went
wrong is `setup-observer`.
