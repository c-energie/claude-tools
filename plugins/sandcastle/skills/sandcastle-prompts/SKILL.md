---
name: sandcastle-prompts
description: "Write or repair a project's Sandcastle harness prompts — the implementer, reviewer, group-reviewer and planner briefs in .sandcastle/ — by interviewing that project's own governing documents rather than guessing: its CLAUDE.md, its CODING_STANDARDS.md, its test and lint configuration, its CI. Use when a workspace has just installed @c-energie/sandcastle-harness, when npx sandcastle-init has left generic stubs in place, when a run warns that it is using the harness's GENERIC stub for a prompt, when a new member or prompt set needs a brief, when an agent's work was correct against the rules it was given and wrong against the rules that exist, or when asked to write, fix, review or audit the sandcastle prompts."
---

# sandcastle-prompts

The Sandcastle harness runs an agent against a repository and reviews what it did. Four prompts
decide what the agent is told: the implementer's brief, the per-issue reviewer's, the
whole-branch reviewer's, and the planner's. The harness ships generic stubs for all four so a
fresh install can be smoke-tested; **they know nothing about any project** and it warns, loudly,
every time it falls back to one.

This skill writes the real ones. It is the judgement half of a harness install, and it is the
half that has already gone wrong: the first draft of one workspace's prompts was written from the
*workspace* `CLAUDE.md` alone and missed most of that member's own
`.sandcastle/CODING_STANDARDS.md`. The agent then produced work that was correct against the
rules it had been given and wrong against the rules that existed — which is the worst shape a
failure can take here, because a reviewer reading the same prompts approves it.

So the method is source-first and the coverage is checked. Do not write a prompt before step 3
is done.

---

## 1. Find the install, and read it

The prompts are named by the workspace's config, not by convention, and there may be more than
one set.

```bash
cat sandcastle.config.mts
```

Take from it:

- **every prompt set**, its name, and the four paths it names. A member table with two sets means
  two implementers, two reviewers and two group reviewers — eight files plus one planner. Do not
  assume one.
- **which members use which set**, and *why they differ*. That difference is the single most
  useful fact available: the config's own comment usually says it (a Python package against a
  LaTeX tree; a package against a directory of shell tooling), and it tells you what each set
  must and must not talk about.
- `ws`, `mount`, `python` and each member's `importName`, which are what the `{{PLACEHOLDER}}`s
  will carry.
- `testCommand` and `generatedPaths` if set — the project has already stated its test command
  somewhere the harness reads, and a prompt that names a different one is a prompt that
  contradicts the smoke test.

If there is no `sandcastle.config.mts`, this is not a harness install. Say so, and point at
`npx sandcastle-init`.

If a prompt file already exists, **read it before writing anything.** A prompt somebody has
tuned over several runs is worth more than a fresh draft, and the job is then a repair: find what
it is missing against step 3's inventory and add that, keeping everything else.

---

## 2. Understand what each prompt is FOR

Four briefs, four different jobs. Writing them as four variations of one document is the most
common way to waste three of them.

| Prompt | Job | What it must NOT be |
| --- | --- | --- |
| implementer | Do this one issue, in this repository, to this project's standards. | A restatement of the issue. The issue is read by the agent at run time. |
| per-issue reviewer | **The gate.** Was this issue actually implemented, is it correct, does it follow the standards. An approval here says it is safe for the next issue to build on. | A style review. And never a re-read of the whole branch — that is the next one's job. |
| group reviewer | The four faults invisible from inside one issue: a later issue undoing an earlier one, the same helper built twice, scaffolding nobody removed, and the suite at the tip. | The per-issue review with a wider diff. That costs a container and finds the same things again. |
| planner | Which open issues to work, in what order, and **which belong on one branch**. Reads issue bodies; touches no files. | A judgement about code. It has not seen any. |

The group reviewer's is the one most often written as a duplicate, and the one whose distinct
value is highest: it is the only pass that ever runs the suite over the finished branch, which is
the only state anybody will merge.

---

## 3. Inventory the sources — the step this skill exists for

Gather, **per prompt set**, before drafting. For each member using that set:

```bash
# The workspace's rules — necessary and NOT sufficient. This is what got read alone last time.
cat CLAUDE.md

# The member's OWN rules. Check all of these; the one that was missed lived in .sandcastle/.
ls -a <member>/
cat <member>/CLAUDE.md          2>/dev/null
cat <member>/AGENTS.md          2>/dev/null
cat <member>/CODING_STANDARDS.md 2>/dev/null
cat <member>/.sandcastle/CODING_STANDARDS.md 2>/dev/null
cat <member>/CONTRIBUTING.md    2>/dev/null
cat <member>/docs/CONTEXT.md    2>/dev/null
find <member> -maxdepth 2 -iname '*standard*' -o -maxdepth 2 -iname '*convention*' \
  -o -maxdepth 2 -iname 'AGENTS.md' -o -maxdepth 2 -iname 'CLAUDE.md' 2>/dev/null
```

Then the things that state rules without calling them rules, and which a prose document usually
omits because they are already enforced:

```bash
cat <member>/pyproject.toml <member>/package.json 2>/dev/null   # test runner, lint, typecheck, extras
ls <member>/.github/workflows/ 2>/dev/null && cat <member>/.github/workflows/*.y*ml
cat <member>/Makefile <member>/justfile <member>/noxfile.py <member>/tox.ini 2>/dev/null
cat <member>/.pre-commit-config.yaml 2>/dev/null
cat <member>/.editorconfig <member>/ruff.toml <member>/.eslintrc* 2>/dev/null
```

And the code itself, for the conventions no document states: read two or three real modules and
one real test. How this project names things, how densely it comments, how it structures a
module, what a test looks like. A prompt that describes a style the codebase does not have
produces work a reviewer then objects to.

**The coverage gate.** Before drafting, write out — in your reply, not in the prompt — one line
per source you found and per source you looked for and did not. Then for each source found, name
which prompt carries its content. A source with no prompt against it is the failure this skill
exists to prevent; either carry it or say why it does not belong in a prompt.

If a member has a standards document you cannot fully honour in a prompt because it is long, do
not summarise it away: have the prompt tell the agent to **read it by path, as required reading,
before changing code**, and carry only the rules that a reader would not think to look for.

---

## 4. Write them

Match the harness's stubs in structure — they carry the contracts — and replace every generic
section with this project's answers. The contracts are not stylistic: the engine parses the
output and renders the placeholders, and getting either wrong fails a run in a way that is not
obvious. **Read `references/contract.md` before writing.** It has the placeholder list per
prompt and the three output blocks the engine extracts.

What each prompt must actually say, concretely, and where the generic versions are worth nothing:

**Implementer**
- The test command, verbatim, and what "the suite passes" means here — including a known
  pre-existing failure if there is one, because an agent that finds one and stops has wasted a run.
- The lint, format and typecheck commands, and whether each gates.
- The project's own standards document, **by path**, as required reading.
- What must never be touched: generated files, vendored trees, data directories, a lock file.
- How this project writes comments, names things, and structures a module — from the code, not
  from a document.
- What a commit looks like here.
- That it must not push, must not open a pull request, and must not merge. The harness does all
  three from the host.

**Per-issue reviewer**
- The standards document by path again, as required reading *before* reviewing. A reviewer with
  no standards to review against approves everything that compiles.
- Whether the suite must pass at this commit, and the command.
- The patterns this project insists on and the ones it forbids.
- What is out of scope — style a formatter already owns, for instance. A reviewer objecting to
  something a hook would have fixed wastes the gate.
- That small fixes may be committed, prefixed `review fix:`, and that anything larger is a
  finding rather than a fix.

**Group reviewer**
- The suite command again, plus what running it whole involves here: how long it takes, what a
  known failure looks like, whether it should be targeted. A reviewer that does not know will
  either skip it or time out, **and both read as an approval**.
- The four cross-issue faults, in this project's terms.
- That the per-issue verdicts it is shown are provenance, not approval: each was formed against a
  tree the issues after it then changed.

**Planner**
- How to read this project's backlog: which labels mean what, how an epic is expressed, whether
  there is a milestone or project board that matters.
- What makes two issues belong on one branch **here**.
- **What cannot be done in a sandbox.** Specific, and it matters more than anything else in this
  prompt: an issue queued against it burns a container to discover it. Look at the image and the
  config — data that is deliberately not baked in, a GPU, a cluster, a licensed tool, a
  credential the sandbox is not given, anything whose only verification is a human looking at a
  rendered output.

Write in the second person, imperative, and concrete. Every sentence that could be in any
project's prompt is a sentence carrying no information; the stubs already say those.

---

## 5. Prove it

```bash
npm run sandcastle -- --member <member> --issue <n> --dry-run
```

The dry run prints the resolved prompt paths and the rendered `promptArgs`. Check:

- **no path resolves into `node_modules`.** That means the file is missing and the harness fell
  back to its stub — it warns, and the warning is the thing to act on.
- **no `WARNING  Using the harness's GENERIC stub`** for any set. Repeat with a member from each
  set: a second set's prompts are only resolved when a member using it is named.
- every placeholder the prompt writes appears in `promptArgs`. One that does not is a typo, and
  it reaches the agent as a literal `{{TYPO}}`.
- `npx tsc -p .sandcastle/tsconfig.json` still passes, if the config was touched.

Then read the rendered prompt as the agent will see it, once, end to end. A prompt that
contradicts itself between two sections is common and invisible in a diff.

---

## 6. Report

Say which files were written or repaired, which sources each one draws on, and — explicitly —
**anything you looked for and did not find.** A project with no standards document is a fine
answer; a project with one that nobody noticed is the failure. Name any rule you found and
deliberately left out, and why.

If a prompt still needs a human's judgement — a test suite whose behaviour you could not
determine without running it, a rule whose scope was ambiguous — say so rather than inventing a
confident sentence. A confidently wrong prompt is worse than a gap, because nothing downstream
questions it.

---

**Not this skill:** changing the harness *engine* — the runner, the planner's parsing, the config
seam, a pin strategy — is a change to `c-energie/sandcastle-harness` and belongs in that
repository. Writing a repo's `devhub.toml` is `devhub-feature`. Writing up work into a project's
context repo is `save-thread`.
