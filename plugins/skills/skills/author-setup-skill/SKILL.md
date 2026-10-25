---
name: author-setup-skill
description: Author a new interactive setup skill — one that walks a user through creating repos from templates, installing tools and wiring them together — by interviewing the author, scaffolding SKILL.md plus a dependency-free Python or node step script with --dry-run and --root, repo-local or shipped in a plugin, then auditing both. Use when writing a setup or onboarding skill, or rebuilding an existing one to the setup-skill recipe.
---

# Author a setup skill

You are writing a **setup skill**: the skill does the interview and the judgement, a step script
does the mechanics. It is either **repo-local** — in the repo it sets up, under
`.claude/skills/`, its script beside its SKILL.md — or **plugin-shipped** — in a plugin's
`skills/`, its script in the plugin's `scripts/`, setting up whichever project it is invoked in. The recipe behind every step here is
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
| `skill`, `script`, `title` | Name of the skill (`setup-…`, a slug), its script and heading. The script's extension picks the language: `setup_….py` is stdlib Python run through uv; `setup-….mjs` is node built-ins only — the natural choice in a node-only plugin. Nothing else is accepted |
| `does` | What it sets up — the front of the generated description |
| `trigger` | Optional. When omitted it is derived from the state: "`stateFile` is missing" or "`existingState.check` fails", the observable condition the recipe wants. Give one only to say it better |
| `stateFile` **or** `existingState` | Exactly one (L2). **Owned** state, `stateFile`: a file the setup creates and later skills read instead of re-asking — `.json` by default, `.toml` only if people hand-edit it, and never `.toml` for a node script (node has no built-in TOML). The skeleton gets `load_state`/`save_state` for it. **Joined** state, `existingState: {files, check}`: a record other skills already define (`.diagrams.json`, a `workspace.json` block) that this setup only fills in — `files` says where it lives, `check` is a command that fails until it is filled in. No state helpers: the schema is theirs |
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
what the guide got wrong. This plugin holds its master copy; step 3 copies it beside the new skill
(the setup's own users may not have this plugin, so the repo or plugin must carry it). Ask the author
whether to include it, then look for `setup-observer/` beside where the skill will go —
`<repo>/.claude/skills/`, or `<plugin>/skills/` (a plugin-shipped skill invokes it as
`/<plugin>:setup-observer`):

- **Absent, included** — fill the spec's `observer` object: `owners` (`{repo, covers}` per
  repo a deviation could be filed on — the repo holding these skills, each template), plus any
  `envVars` / `secretVars` already-set-before-setup would matter for, and `stateFiles` if more
  than the state files. Step 3 writes these into `observer.toml`; repo-local, it also adds `.setup/` to
  the repo's `.gitignore` (the observer's own baseline adds it to `.git/info/exclude` anywhere).
- **Present** — step 3 leaves it alone and reports drift from the master. Add a row to its
  `observer.toml` `[[owners]]` for any repo the new skill touches that it lacks.
- **Declined** — `"observer": false`; the generated SKILL.md then has no step 0.

Done when the spec's `observer` is settled with the author.

## 3. Scaffold

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" --spec <spec.json> --out <repo>/.claude/skills/<skill> --dry-run
node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold.mjs" --spec <spec.json> --out <repo>/.claude/skills/<skill>
```

For a plugin-shipped skill, `--plugin <plugin dir>` replaces `--out`: SKILL.md goes to
`<plugin>/skills/<skill>/`, the script to `<plugin>/scripts/`, the SKILL.md calls it there
through `CLAUDE_PLUGIN_ROOT` with `--root "${CLAUDE_PROJECT_DIR}"`, and no `.gitignore` is
touched. Every generated script takes `--root` (before the step): required in plugin mode,
where the script refuses without it; repo-local it defaults to the repo three levels above the
script.

It validates the spec (exit 1 lists every problem — fix the spec and re-run), refuses to
overwrite an existing `SKILL.md` or script (exit 2), prints how many `TODO(author)` markers
each file carries, and installs or drift-checks the observer per step 2. Done when it exits 0
and every file it lists exists.

## 4. Fill in

Work through every `TODO(author)` marker with the author:

- **The script** — implement each step function (`cmd_<step>` in Python, `cmd<Step>` in node)
  so it reuses what exists and refuses (`Refused`) rather than overwriting (L1); route every
  write through `write`/`run` so `--dry-run` covers it (`write` also refuses anything outside
  `--root` unless given another root); implement each `GUARDRAIL` comment as a refusal in code
  (L6); have the last step save the owned state (`save_state`/`saveState`) or fill in the joined
  record, or the skill keeps re-triggering (L2); fill `INSTALL` per platform and bake
  in the platform traps (L11). Templates are filled by feeding their `init.py` on stdin
  (L3).
- **The SKILL.md** — the end-state tree; the refusal each guardrail prints; which mode to
  recommend when the user is unsure; any third-party UI steps, written in exactly one place
  (L9); for each outward step, the exact command the user runs if auto mode blocks it (L12).

Done when `grep -rn "TODO(author)"` over the skill directory, the script and the
`setup-observer/` beside it prints nothing.

## 5. Smoke-test in a scratch workspace

L13. Aim the script at a throwaway directory — never a real project — with `--root <scratch>`
(a repo-local script would otherwise default to the repo it sits in). Run `check`, every step with
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

Show `git status` in the target repo and propose the commit (the new skill directory, the
script if it sits elsewhere, plus `setup-observer/` and `.gitignore` if step 3 added them). Ask
before committing, and separately before pushing. A c-energie plugin's skill goes through
`update-plugin` instead, which checks and bumps the plugin.

**Not this skill:** changing an existing c-energie plugin skill goes through `update-plugin`;
general skill packaging is `skill-creator`; running a setup and reporting where its guide went
wrong is `setup-observer`.
