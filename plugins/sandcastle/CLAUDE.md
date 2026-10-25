# CLAUDE.md

## What this plugin is

The **Sandcastle harness authoring** layer, `plugins/sandcastle` inside
`c-energie/claude-tools`. Three skills. The first two are the whole of the per-project half of
a harness install; the third gets a backlog ready for the engine's epic mode:

- **`sandcastle-install`** — getting a workspace wired and verified: which kind of root this is,
  the member table, the prompt sets, the env, the Dockerfile, and the token-free proof that it
  works. Everything before the image build is free, and this is the order it has to happen in.
- **`sandcastle-prompts`** — the five prompts a harness install cannot ship (implementer,
  per-issue reviewer, group reviewer, revision, planner), written from the consuming project's own
  governing documents.
- **`sandcastle-epic-prep`** — the issues an `--epic` run will plan from: which dependencies are
  native links (obeyed) and which are only text (listed, ignored), whether any parent reaches them,
  whether their repos are members. Its audit is `scripts/epic-audit.mjs`; the writes are a plan the
  user approves.

None depends on another being run, and each says so in its `Not this skill:` line.

It is deliberately **outside the context stack**. It reads no `workspace.json` state, needs no
context plugin, and is useful in any workspace that has installed `@c-energie/sandcastle-harness`. Filing it
under `context-kit-core` because both are "tooling" would put facts about a placeholder contract
and three output blocks into the layer whose whole rule is that it knows nothing but generic
context machinery. Same test as `devhub` and `diagrams`: same people, new topic, new plugin.

## Where the truth lives

**`c-energie/sandcastle-harness` owns the contract; this plugin only teaches it.** Every rule in
`references/contract.md` is a restatement of what `src/sandbox.mts` renders (`promptArgsFor`,
`argsUsedIn`), what each pass in `src/run.mts` adds to that map, what `src/plan.mts` parses
(`extractTaggedBlock`), the revision loop's rules in `src/revision.mts`, and what the peer
`@ai-hero/sandcastle` does with a placeholder nobody supplied (fails the pass). It names the
harness and peer versions it was checked against; re-check on every harness minor.

- **When the harness changes, this plugin is downstream.** A new placeholder, a renamed block, a
  changed verdict word — update `references/contract.md` from the engine's own code, then bump.
  Never the other way round: a skill describing a placeholder the engine does not pass produces a
  prompt with a literal `{{TYPO}}` in the middle of it, and a skill describing a block the engine
  does not extract produces a run whose review verdict is never read.
- **`scripts/epic-audit.mjs` ports the engine's `textLinksIn`** (`src/epic.mts`), so "text only"
  in the audit means exactly what the planner lists as an unconfirmed link. It names the harness
  version it was checked against. When the engine changes that function, or the phrases it
  reads, or `EPIC_LABEL`, change the port in the same release.
- **The check is a `--dry-run`, not prose here.** It prints the resolved prompt paths and the
  rendered `promptArgs`, which is the only thing that proves a prompt's placeholders are real and
  that no path fell back to the harness's stub.
- The harness's own stubs under `stubs/` are the structural reference. If they and
  `references/contract.md` disagree, the engine is right and both are stale.

## Invariants

- **The skills auto-trigger, and that is safe because none writes outside the session without
  being asked to.** `sandcastle-install` and `sandcastle-prompts` edit files in the workspace the
  user is standing in: no commit, no push, no message to anybody. `sandcastle-epic-prep` does
  write to issue trackers (links, sub-issues, issues, bodies), so it carries an explicit gate
  instead: its audit is read-only, and nothing is written until the user approves one numbered
  plan. Any edit that lets a write happen before that approval needs `disable-model-invocation`
  instead.

- **Native links are the fix; plan-file acceptance is not.** The epic's plan file can accept a
  text link, but only on one machine and one plan. `sandcastle-epic-prep` exists to put the order
  into GitHub, where every run and every reader sees it.

- **Source-first, and the coverage is stated** (`sandcastle-prompts`). The skill's value is entirely in step 3 — the
  inventory. It exists because one workspace's prompts were drafted from the workspace `CLAUDE.md`
  alone and missed the member's own `.sandcastle/CODING_STANDARDS.md`; the agent then produced
  work correct against the rules it had and wrong against the rules that existed, and the
  reviewer, reading the same prompts, approved it. Any edit that makes the inventory optional, or
  lets a draft come before it, removes the reason the skill is here.

- **Never summarise a standards document away.** A long one is referenced **by path, as required
  reading**, and only the rules a reader would not think to look for are carried into the prompt.
  A paraphrase is a second copy that drifts, which is the same mistake the harness extraction
  fixed one layer down.

- **Five prompts, five jobs, and the group reviewer is not the reviewer with a wider diff.** It is
  the only pass that runs the suite over the finished branch, which is the only state anybody will
  merge. A skill revision that lets the two collapse into variations of one document wastes a
  container per group and finds the same things twice. Likewise the revision brief is not the
  implementer's with findings appended: that one says "implement the issue", and a revision round
  must not re-open the design.

- **Every prompt the engine resolves is covered.** The skill once named four and a fifth
  (`revision`, optional in the config) shipped on the generic stub in every workspace that used
  it. When the harness adds a pass, this skill and `references/contract.md` gain it in the same
  release.

- **An existing prompt is repaired, not replaced.** A prompt somebody has tuned over several runs
  is worth more than a fresh draft. Read it first; add what the inventory shows is missing.

- **Nothing project-specific in this plugin.** No member name, no repository, no standards
  document's contents. The skill goes and reads them at run time; what it knows is where to look.

- **Say what was not found.** A prompt with a confident sentence invented to fill a gap is worse
  than a prompt with the gap named, because nothing downstream questions it.
