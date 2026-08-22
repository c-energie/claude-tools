---
name: context-status
description: Report what is outstanding across the context ladder — lessons waiting for a sweep, sweeps waiting to be distilled, handoff items nobody has drained, threads due for curation, a pending queue, and native memory awaiting triage — each with the skill that clears it. Triggers like "what is outstanding", "what do I need to run", "what is queued up", "is anything waiting", "status of my context", "catch me up on the context system", "what has built up".
---

# What is outstanding

Counts every queue in the context ladder and names the skill that drains each one. It is the
standing answer to "what has built up while I was working" — and it is a **read**: it writes
nothing, queues nothing and pushes nothing.

The queues are real and they fill silently. Lessons accumulate in `LESSONS.md` with nothing
announcing that a sweep is due; handoff items sit addressed to a repo nobody has opened;
`memory.md`'s last-review date recedes. Every one of them is visible only if something goes and
counts it.

## 1. Find the repo

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --no-pull)"
```

`--no-pull` deliberately: a status check should be instant and change nothing, and the
session-start hook already pulled this repo when the session opened. If the numbers matter
because someone has just pushed, run `refresh-context` first and then this.

If the resolver exits non-zero the problem is the link rather than the queues — route to
`context-setup`.

## 2. Count

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/context-status.mjs" "$ROOT"
```

Useful options: `--role [name]` to look at one role, `--json` for the structured form,
`--today YYYY-MM-DD` to pin the date, `--no-memory` to skip the native-memory scan (the slow
part, and the only one that reads outside the repo).

The script composes `assistants.mjs` and `memory-triage.mjs` rather than re-counting what they
already count, so its lesson figures are the **same** figures a sweep will act on. Anything it
reports as absent — a clone that is not on disk, a stamp that was never written — is reported
as absent rather than as zero.

## 3. Report it, leading with what to run

The script ends with a `WHAT TO RUN` block. **Lead with that**, then fill in only the queues
that have something in them. A recital of six sections where five are empty buries the one that
is not.

Then add the judgement the script cannot:

- **Say which queue is the real one.** Three ready sweeps and one stale handoff item are not
  equally urgent. A sweep that is one lesson over its threshold can wait; a handoff item that
  has been sitting for three weeks is a decision that has not reached the project it governs.
- **A threshold is a floor, not a schedule.** `ready` means there is enough evidence to distil,
  not that it must happen today. Distilling two lessons into doctrine manufactures confidence
  the evidence does not support — which is exactly why the threshold exists.
- **An absent clone contributed nothing.** If a source repo has no clone, its lessons were not
  counted, and the total is a floor rather than a figure. Say so; never let silence read as
  "that project had nothing to add".
- **`no threshold yet` means no sweep has ever run for that role.** The first sweep sets the
  bar. That is a starting state, not a misconfiguration.

## 4. Offer, then wait

Every skill in the `WHAT TO RUN` block writes outside the session, and every one of them is
`disable-model-invocation: true` for that reason. **Offer to run one; do not start.** Naming
what you would do and waiting is the whole point of the gate — a status check that quietly
triggered a sweep would have converted a read into six writes.

Draining a handoff item is the one that cannot be done from here at all: it has to happen in
the target project's own session, where the write is legitimate and a human watches it land.

## 5. From a project repo, say what you cannot see

Run in a project's context repo, this reports that repo's threads, slices, pending queue and
native memory — and it is **blind** to two queues that concern it: whether its lessons have been
swept, and whether handoff items are addressed to it. Both live in the cross-project layer, and
nothing in a project's config points upward.

The script says so rather than printing an all-clear it has no standing to give. Repeat that
when you report it, and offer to run the same check in the cross-project layer. Do **not** go
hunting the filesystem for a second brain: what a session reads has to be legible from committed
config, and guessing at a sibling repo is the discovery-by-filesystem this system forbids
everywhere else.

## 6. If a queue looks wrong rather than full

A count that cannot be explained is usually configuration, not backlog — a role declared in one
repo under a name another repo does not use, an `include` entry the hook silently dropped, an
index that was never rebuilt. That is `context-doctor`'s job, and it is the right next step when
the numbers themselves look suspect.

**Not this skill:** health-checking the config behind these numbers is `context-doctor`; wiring
a project to its context repo is `context-setup`; re-pulling mid-session is `refresh-context`.
Actually draining the queues is `supervisor-sweep`, `supervisor-distil`, `curate-context` and
`memory-triage`; adopting a role is `assistant`.
