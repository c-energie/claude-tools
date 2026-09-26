# The prompt contract

What the harness renders into a prompt, and what it parses back out. Both halves fail in ways that
are not obvious, which is why they are written down rather than inferred from a stub.

Upstream: `c-energie/sandcastle-harness` — `src/sandbox.mts` (`promptArgsFor`, `argsUsedIn`) and
`src/plan.mts` (`extractTaggedBlock`). If this file and that code disagree, the code is right and
this file is stale.

---

## Placeholders

`{{NAME}}`, replaced before the prompt reaches the agent. The harness passes **only the ones a
given prompt actually mentions** — it scans the file's own text — because Sandcastle warns once per
argument that is passed and never referenced.

Two consequences:

- A placeholder you do not write is not an error. It is simply not supplied.
- A placeholder you **misspell** is not an error either. It is not recognised as a reference, so
  nothing is passed for it, and the agent receives a literal `{{TYPO}}` in the middle of its brief.
  This is the failure mode to check for in a dry run.

### Available to every prompt

| Placeholder | What it is |
| --- | --- |
| `{{MEMBER}}` | The member name, as `--member` takes it. |
| `{{REPO}}` | `owner/repo` on GitHub. What every `gh --repo` takes. **Not** the folder name. |
| `{{WS}}` | Where the image bakes the workspace — `/home/agent/ws` by default. **Run things here.** |
| `{{MOUNT}}` | Where the live worktree is mounted — `/home/agent/workspace`. Has no environment above it. |
| `{{PYTHON}}` | The interpreter inside the image. |
| `{{MEMBER_DIR}}` | `{{WS}}/src/{{MEMBER}}` — the member inside the baked workspace. A symlink to `{{MOUNT}}`. |
| `{{PINS}}` | What `--with` pinned for this run, in prose, or a sentence saying nothing is. |
| `{{SIBLINGS}}` | The same string as `{{PINS}}`, under its older name. Use `{{PINS}}` in new prompts. |
| `{{ISSUE}}` | The issue number. Empty in backlog planning, by definition. |

### Extra, for the per-issue reviewer

| `{{BRANCH}}` | `{{BASE_BRANCH}}` | `{{COMMITS}}` |
| --- | --- | --- |

### Extra, for the group reviewer

| Placeholder | What it is |
| --- | --- |
| `{{BRANCH}}`, `{{BASE_BRANCH}}` | The branch and what it forked from. |
| `{{COMMIT_RANGE}}` | `base...branch`. The whole branch, which is what this pass reviews. |
| `{{ISSUE_LIST}}` | The issues on the branch, numbered, in the order they were worked. |
| `{{GROUP_WHY}}` | The planner's reason for putting them together. |
| `{{PER_ISSUE_REVIEWS}}` | Each per-issue verdict. **Provenance, not approval** — each was formed against a tree the issues after it then changed. Say so in the prompt. |

The group reviewer deliberately does **not** get `{{ISSUE}}` or `{{COMMITS}}`: it works over
several issues and a whole branch, which `{{ISSUE_LIST}}` and `{{COMMIT_RANGE}}` describe, and a
single number and a flat list of shas do not.

### The planner

Gets `{{MEMBER}}`, `{{REPO}}` and `{{PINS}}` only. It reads issues off GitHub and never touches the
sandbox's filesystem, so the paths mean nothing to it. A planner prompt that writes `{{PYTHON}}`
gets it — the scan is of whatever file is in use — but it has nothing to do with it.

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
- anything else stops the rest of the group, and the pull request opens as a draft.

The lines after it are for a human and are never parsed. A reviewer that writes prose where the
word belongs reads as a rejection, which stops a branch nobody meant to stop.

### `<pr-summary>` — both reviewers

Two or three sentences. Becomes the pull request's description; the group reviewer's is the one of
record. Write it for somebody who has not read the issue.

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
```

One line per issue not queued. Three cases are worth naming in the prompt because the engine
renders them differently: an **epic** (its children were queued instead), an epic with **nothing
left in it** (the plan prints the `gh issue close` command), and anything that **cannot be done in
a sandbox**.

---

## Two rules that are not about parsing

**Never tell the agent to push, to open a pull request, or to merge.** The harness does all three
from the host, after a reviewer has read the work, so that the agent never holds the credentials
and the PR body is the runner's report rather than an agent's account of its own work. A prompt
that asks for it gets a run that either fails on a missing credential or opens a second PR.

**Say where to run things.** `{{MOUNT}}` is the live worktree and has no environment above it;
`{{WS}}` is the reconstructed workspace and does. An agent that `cd`s into the mount and runs the
suite gets import errors that look like a broken image.
