# CLAUDE.md

## What this plugin is

The **Sandcastle harness authoring** layer, `plugins/sandcastle` inside
`c-energie/claude-tools`. Two skills, and between them they are the whole of the per-project half
of a harness install:

- **`sandcastle-install`** — getting a workspace wired and verified: which kind of root this is,
  the member table, the prompt sets, the env, the Dockerfile, and the token-free proof that it
  works. Everything before the image build is free, and this is the order it has to happen in.
- **`sandcastle-prompts`** — the four prompts a harness install cannot ship (implementer,
  per-issue reviewer, group reviewer, planner), written from the consuming project's own
  governing documents.

Neither depends on the other being run, and each says so in its `Not this skill:` line.

It is deliberately **outside the context stack**. It reads no `context.json`, needs no context
repo, and is useful in any workspace that has installed `@c-energie/sandcastle-harness`. Filing it
under `context-kit-core` because both are "tooling" would put facts about a placeholder contract
and three output blocks into the layer whose whole rule is that it knows nothing but generic
context machinery. Same test as `devhub` and `diagrams`: same people, new topic, new plugin.

## Where the truth lives

**`c-energie/sandcastle-harness` owns the contract; this plugin only teaches it.** Every rule in
`references/contract.md` is a restatement of what `src/sandbox.mts` renders (`promptArgsFor`,
`argsUsedIn`) and what `src/plan.mts` parses (`extractTaggedBlock`), plus the three tag names
`run.mts` extracts.

- **When the harness changes, this plugin is downstream.** A new placeholder, a renamed block, a
  changed verdict word — update `references/contract.md` from the engine's own code, then bump.
  Never the other way round: a skill describing a placeholder the engine does not pass produces a
  prompt with a literal `{{TYPO}}` in the middle of it, and a skill describing a block the engine
  does not extract produces a run whose review verdict is never read.
- **The check is a `--dry-run`, not prose here.** It prints the resolved prompt paths and the
  rendered `promptArgs`, which is the only thing that proves a prompt's placeholders are real and
  that no path fell back to the harness's stub.
- The harness's own stubs under `stubs/` are the structural reference. If they and
  `references/contract.md` disagree, the engine is right and both are stale.

## Invariants

- **The skill auto-triggers, and that is safe because it writes nothing outside the session
  without being asked to.** It edits files in the workspace the user is standing in. There is no
  `disable-model-invocation` here: no commit, no push, no message to anybody.

- **Source-first, and the coverage is stated.** The skill's value is entirely in step 3 — the
  inventory. It exists because one workspace's prompts were drafted from the workspace `CLAUDE.md`
  alone and missed the member's own `.sandcastle/CODING_STANDARDS.md`; the agent then produced
  work correct against the rules it had and wrong against the rules that existed, and the
  reviewer, reading the same prompts, approved it. Any edit that makes the inventory optional, or
  lets a draft come before it, removes the reason the skill is here.

- **Never summarise a standards document away.** A long one is referenced **by path, as required
  reading**, and only the rules a reader would not think to look for are carried into the prompt.
  A paraphrase is a second copy that drifts, which is the same mistake the harness extraction
  fixed one layer down.

- **Four prompts, four jobs, and the group reviewer is not the reviewer with a wider diff.** It is
  the only pass that runs the suite over the finished branch, which is the only state anybody will
  merge. A skill revision that lets the two collapse into variations of one document wastes a
  container per group and finds the same things twice.

- **An existing prompt is repaired, not replaced.** A prompt somebody has tuned over several runs
  is worth more than a fresh draft. Read it first; add what the inventory shows is missing.

- **Nothing project-specific in this plugin.** No member name, no repository, no standards
  document's contents. The skill goes and reads them at run time; what it knows is where to look.

- **Say what was not found.** A prompt with a confident sentence invented to fill a gap is worse
  than a prompt with the gap named, because nothing downstream questions it.
