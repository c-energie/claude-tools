# The prompt contract

What the harness renders into a prompt, and what it parses back out. Both halves fail in ways that
are not obvious, which is why they are written down rather than inferred from a stub.

Upstream: `c-energie/sandcastle-harness` — `src/sandbox.mts` (`promptArgsFor`, `argsUsedIn`,
`memberWorkDir`), `src/run.mts` (each pass's argument map, and the two `extractTaggedBlock`
calls for the reviewers), `src/plan.mts` (the planner's two blocks), `src/revision.mts` (the
revision loop and its commit prefix), and the peer `@ai-hero/sandcastle`'s `substitutePromptArgs`.
Checked against harness **v2.4.0** and peer **0.12.0**. If this file and that code disagree, the
code is right and this file is stale.

---

## The five prompts

| Prompt | Config key | Default path when unset | When it runs |
| --- | --- | --- | --- |
| implementer | `promptSets.<set>.prompt` | — (required) | Once per issue. |
| per-issue reviewer | `promptSets.<set>.review` | — (required) | After each issue that committed something. |
| group reviewer | `promptSets.<set>.groupReview` | — (required) | Once per branch, only when the group holds **2+ issues**. |
| revision | `promptSets.<set>.revision` | `.sandcastle/revision-prompt.md` | When a reviewer — either one — returns `changes-requested` and the loop has a round left. |
| planner | `planPrompt` (one per workspace) | `.sandcastle/plan-prompt.md` | Once per backlog run. Not per prompt set: planning does not vary by member. |

A path that does not exist falls back to the harness's stub under `stubs/` and prints
`WARNING  Using the harness's GENERIC stub` at startup. `--strict-prompts` makes that an error.
`revision` is **optional in the type, not in practice**: leaving it out is how every workspace
written before the revision loop existed ends up running revisions off the generic stub. One
`revision` file per set is fine; a set may also leave it unset and share the workspace default.

---

## Placeholders

`{{NAME}}`, replaced before the prompt reaches the agent. The pattern is
`/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/` — inner spaces count.

The harness passes **only the ones a given prompt file actually writes** (`argsUsedIn` scans for the
literal `{{NAME}}`), because Sandcastle warns once per argument passed and never referenced.

**In a prompt FILE, a placeholder with no value fails the pass.** Sandcastle 0.12 refuses with
`Prompt argument "{{X}}" has no matching value in promptArgs` — after the image is built and the
container started, so it costs a run to find out. Three ways to hit it:

- **A typo.** `{{MEMEBER}}` is a reference to an argument nobody supplies.
- **A placeholder the pass does not get.** `{{ISSUE_LIST}}` in a revision prompt, `{{BRANCH}}` in
  the planner. Check the tables below per prompt, not per workspace.
- **`{{PYTHON}}` for a member whose `python` resolves to null.** The harness *omits* it rather than
  supplying a wrong path. Its own startup warning says the placeholder "will render UNREPLACED";
  under peer 0.12 it does not render at all, the pass fails. **This includes mentioning
  `{{PYTHON}}` in prose** — "the harness's `{{PYTHON}}` points at nothing here" is a reference. In
  a workspace with no shared interpreter, the string must not appear in any prompt file.

So a prompt must never contain a literal `{{...}}` that is not one of its own arguments — not in
an example, not in a code block, not in a sentence about placeholders.

(An *inline* `--prompt` is rendered by the harness instead, which leaves an unknown placeholder as
written. That is the only place a typo survives as visible text.)

### Every pass except the planner

| Placeholder | What it is |
| --- | --- |
| `{{MEMBER}}` | The member name, as `--member` takes it. |
| `{{REPO}}` | `owner/repo` on GitHub. What every `gh --repo` takes. **Not** the folder name, and already contains the owner — `myorg/{{REPO}}` renders `myorg/myorg/repo`. |
| `{{WS}}` | Where the image bakes the workspace — `/home/agent/ws` by default. |
| `{{MOUNT}}` | Where the live worktree is mounted — `/home/agent/workspace`. |
| `{{MEMBER_DIR}}` | Where the agent works. When the member declares an `importName` (the harness swaps its baked copy for a symlink to the mount) it is the baked path, `{{WS}}/[membersRoot/]{{MEMBER}}`; otherwise it **is** `{{MOUNT}}`. A prompt must not describe it as a symlink unconditionally. |
| `{{PYTHON}}` | The member's interpreter. **Omitted when it resolves to null** — see above. |
| `{{PINS}}` | What `--with` pinned for this run, in prose, or a sentence saying nothing is. Always supplied. |
| `{{SIBLINGS}}` | The same string as `{{PINS}}`, under its older name. Use `{{PINS}}` in new prompts. |
| `{{ISSUE}}` | The issue number. Empty in the group reviewer and its revision rounds. |
| `{{ISSUE_SCOPE}}` | The `--issues` scope as `#13, #17`, or a sentence saying none was set. Always supplied; meaningful to the planner only. |

Sandcastle itself also supplies `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}`. The harness's own
names (`{{BRANCH}}`, `{{BASE_BRANCH}}`) are the ones to use.

### Extra, for the per-issue reviewer

| Placeholder | What it is |
| --- | --- |
| `{{BRANCH}}`, `{{BASE_BRANCH}}` | The branch and what it forked from. |
| `{{COMMIT_RANGE}}` | `base..HEAD` (two dots). |
| `{{COMMITS}}` | Every sha of this issue's, revision rounds and review fixes included, space-separated. |

### Extra, for the group reviewer

| Placeholder | What it is |
| --- | --- |
| `{{BRANCH}}`, `{{BASE_BRANCH}}`, `{{COMMIT_RANGE}}`, `{{COMMITS}}` | As above, over the whole branch. |
| `{{ISSUE_LIST}}` | The issues on the branch, numbered, in the order they were worked. |
| `{{GROUP_WHY}}` | The planner's reason for putting them together. |
| `{{PER_ISSUE_REVIEWS}}` | Each per-issue verdict. **Provenance, not approval** — each was formed against a tree the issues after it then changed. Say so in the prompt. They do not change across revision rounds. |

`{{ISSUE}}` is empty here: the pass works over several issues, which `{{ISSUE_LIST}}` describes.

### Extra, for the revision agent

| Placeholder | What it is |
| --- | --- |
| `{{REVIEW_FINDINGS}}` | The objecting reviewer's verdict block, **verbatim**, rebuilt each round — round 2 gets round 1's re-review, not the original objection. |
| `{{BRANCH}}`, `{{BASE_BRANCH}}`, `{{COMMIT_RANGE}}`, `{{COMMITS}}` | As for the reviewer, against the branch as the last round left it. |

**One revision file serves both review points.** At the per-issue point `{{ISSUE}}` is the issue;
at the group point it is empty and the findings are about the whole branch. The revision agent does
**not** get `{{ISSUE_LIST}}`, `{{GROUP_WHY}}` or `{{PER_ISSUE_REVIEWS}}` at either point, so a
revision prompt that writes one fails every round. Write it so it reads correctly with `{{ISSUE}}`
empty: "if an issue number is given, read it" rather than an unconditional `gh issue view`.

### The planner

Gets the common map — so `{{MEMBER}}`, `{{REPO}}`, `{{PINS}}` and `{{ISSUE_SCOPE}}` are the useful
ones. It reads issues off GitHub and never touches the sandbox's filesystem, so the paths mean
nothing to it.

**Write `{{ISSUE_SCOPE}}` in the planner, literally.** An `--issues` run with a planner that never
writes the placeholder warns at startup, plans the whole backlog, and then has its queue
**refused** by `parsePlan` for straying outside the scope — a planning pass paid for nothing. Mention
of "ISSUE_SCOPE" in prose without the braces does not count. The harness's planner stub carries a
scope section to copy. In a scoped run the `ready-for-agent` label gate does not apply to the
scoped issues; in an unscoped one the engine refuses a queue naming an unlabelled issue.

---

## Output blocks

The engine extracts these from the agent's stdout with `<tag>...</tag>`. **The last match wins**, so
an agent that quotes the example block back while narrating does not shadow its real answer. A
prompt must ask for the block explicitly and say that nothing follows it.

### `<review-verdict>` — both reviewers

```
<review-verdict>
approve
- what was checked, and what was found
- one line per finding
</review-verdict>
```

The **first line must be exactly one of** `approve`, `approve-with-fixes`, `changes-requested`.
The engine branches on that word:

- anything starting `approve` is an approval;
- `changes-requested` starts a revision round if the loop has one left (`--max-revisions`,
  default 1; `--no-revise` or `--no-review` set it to 0), and otherwise stops the rest of the
  group and the pull request opens as a draft;
- **no verdict at all** is a gap in the review, not a list of objections: no revision round runs.

The lines after the word are for a human, and — since the revision loop — **they are the revision
agent's whole brief** (`{{REVIEW_FINDINGS}}`). A reviewer prompt should therefore ask for findings
that are actionable on their own: file, what is wrong, what would make it right. A reviewer that
writes prose where the word belongs reads as a rejection.

### `<pr-summary>` — both reviewers

Two or three sentences. Becomes the pull request's description; the group reviewer's is the one of
record. Write it for somebody who has not read the issue.

### The revision agent — no block; a commit prefix

Nothing is parsed from the revision agent's reply. What the engine reads is its **commits**:

- **Every commit must be prefixed `revision:`** (case-insensitive). The PR title is never taken
  from a revision commit, because a branch must not be named after a fix to itself — just as it is
  never taken from a `review fix:` commit.
- **A round that commits nothing ends the loop** ("nothing-committed"), whatever the cap. A
  finding the agent cannot or will not address is answered in words and left uncommitted, not
  papered over with a commit it does not believe in.
- A **fresh** reviewer then reads the branch — never a resume of the one that objected. The reply
  is read by a human in the report, not by the next reviewer.
- It runs on the **implementer's** model, one iteration per round.
- At the group point it runs only for a group of 2+ issues.

### `<queue>` — the planner

```
<queue>
[
  {
    "branch": "short-slug",
    "title": "What this branch is for",
    "why": "Why these issues are together and why now",
    "issues": [
      { "issue": 13, "title": "...", "why": "..." }
    ]
  }
]
</queue>
```

One group is one branch, one pull request, and one to a few issues worked in array order, each on
top of the last. **Across groups there are no dependencies at all** — the invariant that keeps
every group forkable from the same base and mergeable in any order. Tell the planner that: a
planner that wants to express a cross-group dependency is describing a grouping it should have
made.

`branch` becomes the last component of `sandcastle/<member>/<branch>`. The engine sanitises it to
git's ref rules, so a space or a leading dash is tidied rather than fatal — but a slug a human
cannot recognise in a branch list is a slug nobody can review.

### `<excluded>` — the planner, optional

```
<excluded>
[
  { "issue": 9, "why": "Epic — queued #13 and #17 instead", "action": "" }
]
</excluded>
```

One line per issue not queued. Three cases are worth naming in the prompt because the engine
renders them differently: an **epic** (its children were queued instead), an epic with **nothing
left in it** (the plan prints the `gh issue close` command), and anything that **cannot be done in
a sandbox**.

---

## Two rules that are not about parsing

**Never tell the agent to push, to open a pull request, or to merge** — in any of the five. The
harness does all three from the host, after a reviewer has read the work, so that the agent never
holds the credentials and the PR body is the runner's report rather than an agent's account of its
own work. A prompt that asks for it gets a run that either fails on a missing credential or opens a
second PR.

**Say where to run things.** `{{MOUNT}}` is the live worktree. In a workspace with a shared
environment above the members (an editable install the harness swaps), the member must be driven
from `{{MEMBER_DIR}}` inside `{{WS}}`, and an agent that `cd`s into the mount gets import errors that
look like a broken image. In a clone root, `{{MEMBER_DIR}}` *is* the mount and each member resolves
its own environment (`uv run`, `npm`). The prompt has to say which of the two this workspace is.
