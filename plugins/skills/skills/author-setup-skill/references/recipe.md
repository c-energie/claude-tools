# The setup-skill recipe

Fifteen lessons for any interactive, step-through **setup skill** — a skill that walks a user
through creating repos from templates, installing tools and wiring things together. Each was
learned by getting it wrong once, building the five doc-workspace setup skills in
`c-energie/doc-workspace-template` (2026-10). Those skills are the worked examples:
`setup-doc-workspace` (interview, mode table, read-back, step script), `adapt-existing-analysis`
(guardrails in code, checkable criteria) and `setup-observer` (step 0). Read them; copy the
shape, not the specifics.

## Split the work

1. **The skill does the interview and the judgement; a script does the mechanics.** One
   stdlib-only Python script per skill, run with `uv run --no-project --python 3.12` so no system
   Python is needed. It has named steps; each step is **re-runnable** (reuses what exists,
   refuses rather than overwrites), takes `--dry-run`, and stops on the first failure with the
   fix in the message.
2. **A state file shared between skills.** Setup writes it once (`workspace.toml`); every later
   skill reads it instead of re-asking.
3. **Templates cannot fill themselves in.** GitHub's "Use this template" copies files verbatim,
   so each template ships a self-deleting `init.py` and the setup script feeds it the interview
   answers on stdin. A repo made from a template does not inherit its visibility — ask.

## The interview

4. **Collect everything before acting**: a few questions at a time, defaults in brackets, an
   answer → mode → effect table wherever answers change the path (`adapt` / `import` / `fresh`),
   then read the whole plan back as a table and get an explicit yes before the first
   outward-facing action (`gh repo create`).
5. **Ask before every commit and every push**, per repo.

## Guardrails in code, not prose

6. **A rule that must never break is enforced by a script**, so the skill only has to say "run X,
   it must print OK". `copy_analysis.py` never modifies the old repo: it hashes every source file
   at `plan`, refuses to copy if any changed, refuses destinations outside the target, and
   `verify` re-hashes and re-lists the source (ignored files included). Generators never
   overwrite; savers raise on an unfilled placeholder.
7. **Every step ends on a checkable criterion** — an exit code, "verify prints OK", a file at a
   path — never "when it looks right". Write what must be *true*, not that a file exists (a
   stale plan file also exists), and check the criterion is not already true on arrival.
8. **A proof step runs the real pipeline** — a figure actually lands in the document — from
   **more than one working directory**. A notebook started from the workspace root could not
   find its setup, and that survived because every proof ran from inside the analysis repo.

## What drifts underneath you

9. **Third-party UI instructions rot.** Overleaf moved GitHub sync from *Menu* to the left
   panel's *Integrations*. Keep each such instruction in exactly one place, so a fix is one edit.
10. **Step 0 of every setup skill invokes `/setup-observer`.** It records a machine baseline,
    logs each deviation from the guide with evidence gathered *outside* the guide, reconciles
    against failed commands captured by a skill-scoped `PostToolUseFailure` hook, and — with
    consent per item — files redacted issues or PRs on the owning repo.
11. **Platform traps to bake in**: `uv run pytest` fails on Windows (use `python -m pytest`); a
    new terminal is needed after installing a tool; hooks run in Git Bash on Windows; line
    endings drift (write with explicit `\n`).
12. **Auto mode can block outward-facing steps** (making a repo public was denied as "Create
    Public Surface", read-only follow-ups included). Every such step needs a fallback the user
    runs: short lines, no `\` continuations, JSON from a file rather than piped into a loop.

## Testing and auditing

13. **Two test layers**: throwaway scratch workspaces to smoke-test the script — including the
    guardrails: tamper with the source, aim a destination outside — and a real test bed for
    acceptance (for the doc workspace, a throwaway repo such as `your-user/test-doc`). Never a real project.
14. **Audit with `writing-for-agents`**: description front-loaded, one trigger per branch (the
    doc-workspace descriptions shrank ~45%); positive instructions, with prohibitions kept only
    as hard guardrails and paired with the target; one source of truth per fact.
15. **A fresh agent audits the skill against the script's actual CLI.** It found a `retrofit`
    command listing its own grafted line as legacy (so the skill would have deleted it), a
    cleanup step deleting the plan `verify` needed, an editable install that could write into
    the read-only source, and completion criteria already true on arrival.
