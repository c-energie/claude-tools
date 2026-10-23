---
name: sandcastle-epic-prep
description: "Get a set of issues, across one or more repositories, ready for a Sandcastle --epic run: audit which dependencies are native blocked-by links and which are only written in issue text, find a parent the epic can start from, check every repository is a member, catch label and brief contradictions, then propose the missing links, parent and edits as one numbered plan and apply it only on approval. Use when asked whether issues are linked properly for an epic, are there missing blocking links, can I run sandcastle epic on these, turn these issues into an epic, do I need a parent issue, prepare an epic, or before a first --epic --plan-only."
---

# sandcastle-epic-prep

`--epic` plans from **GitHub's own links and nothing else**: native sub-issues and native
blocked-by links, followed in both directions from one or more parent issues, across members and
owners. A dependency written in issue text, such as "Blocked by #47", is listed in the plan as
**unconfirmed** and obeyed by nothing. A dependency written in prose that names no issue, such as
"blocked by the implementation tickets above", is not even listed. So a backlog that *reads* as
well ordered can plan as a flat pile of ready tasks, and the agent then starts work whose
prerequisite is still open.

This skill closes that gap before any tokens are spent. It is the step **before**
`--plan-only`. The plan file can accept text links one at a time, but every one accepted there
lives only on one machine. A native link fixes it for every run and every reader.

**Writes are gated.** Steps 1–4 read only. Step 5 changes other people's issue trackers, so it
waits for an explicit yes to a numbered plan, and a yes covers that plan only. That gate is why
this skill may auto-trigger.

---

## 1. Name the scope

You need:

- **the repositories** (`owner/repo`, one or more), and
- **the workspace's `sandcastle.config.mts`**. That is the root the epic will run from, and its
  member table decides which issues the epic can work at all.

If the user named issues rather than repos, take their repos. If there is a tracker issue,
add the repos of its sub-issues too.

## 2. Run the audit

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/epic-audit.mjs" --repos [owner/a],[owner/b] --config [path/to/sandcastle.config.mts]
```

It reads as your own `gh` login, the same way the epic reads its graph, and writes nothing. `--json` gives the
same data machine-readably. Its sections, and what each one means for the run:

| Section | What the epic will do |
| --- | --- |
| Not members | Drop every issue there, and **flag** everything they block, because waiting will not fix it |
| Parents | The only possible `--epic` arguments. None means there is nothing to start from |
| No parent reaches them | Invisible to every epic you could run today |
| Text only | Listed as unconfirmed; blocks nothing |
| Prose that names no issue | Not listed at all |
| Label problems | A missing `ready-for-agent` means **not promoted**: never worked, and its dependents held. A label the issue's own text argues against means an agent works something the text says a human must decide |
| Blockers outside members | Dependents flagged |
| Cycles | The whole plan is refused |

**Trust the script over a reading.** Two things it gets right and a person eyeballing the
backlog gets wrong:

- links are followed **both ways**, so an issue *blocking* something under the parent is in the
  epic without being a sub-issue. A second parent is often unnecessary;
- membership is the config's member table, not the folders on disk.

## 3. Read the bodies for what the script cannot decide

The script finds the candidates. Whether each is a real dependency, and which way it runs, is
judgement. Read every flagged issue's body **and its comments**, newest first:

- **Text links.** "Blocked by", "depends on" and "after" usually are dependencies.
  "Related", "companion to", "split from" and "see" usually are not. A "companion" pair often
  turns out to have one direction once you ask which one *reads* what the other *writes*. If the
  direction is unclear, it is not a link yet: say so and leave it out.
- **Prose dependencies.** Resolve "the implementation tickets above" to numbers from the
  tracker's own checklist. Read the checklist's wording too: "Migrations (in order)" is a
  **chain** (each blocked by the one before), not a fan-in onto every implementation ticket.
- **Who owns what.** When two issues both claim to add the same thing (a schema field, a file),
  the blocker is whichever one *owns the writer*. Readers block on the owner, not on whichever
  ticket mentioned it first. Getting this right often lets a whole chain start earlier.
- **Sequencing nobody wrote down.** A "retire" or "remove" ticket that edits the files the other
  tickets edit should go **last**, blocked by those tickets, or the run produces merge fights. Same
  for a ticket every other ticket stacks on: if it is very large, it is worth splitting first.
- **Superseded briefs.** A ticket can carry two or three briefs in its comments, with the newest
  marked as superseding. The label may be right while the body still says otherwise ("Why
  ready-for-human" left over from before the decision). An agent may obey the stale line.
- **Acceptance an agent cannot meet.** A criterion that needs a repo the sandbox has no token
  for, or that must not be written to, should be proved on a fixture copy, with the real check
  moved to the ticket a human runs.

When a ticket needs decisions only the owner can make, stop and grill it with the `grilling`
skill (rounds of numbered questions, each with a recommended answer) before planning links
around it. Do not guess the owner's answer into a link.

## 4. Propose one numbered plan, and ask

Show the user everything you would write, grouped by kind, before writing any of it:

1. **Native links to add**, as `child ← blocker`, each with the line of text or reasoning it
   comes from.
2. **Links to remove or repoint.** A link to the wrong owner (step 3) is removed, not left beside the right one.
3. **A parent**, if the audit found nobody to start from: reuse an existing tracker, or file a
   new one, with the issues as **native sub-issues** (they can span repos). A parent is never a
   task, so do not put `ready-for-agent` on it.
4. **Members to add**, which is a `sandcastle-install` job (member table, prompt set, image).
   Name it and route there; this skill does not write the config.
5. **Body and comment edits**, so text matches the native links. A "Blocked by #41" left in a body
   after the native link moved to #49 becomes an unconfirmed link contradicting a native one in
   every plan.
6. **Labels and briefs**: stale lines to fix, briefs to supersede, tickets to split.

Then stop, and ask. Mark what you recommend leaving out, and why.

## 5. Apply what was approved

Native blocked-by links take the blocker's numeric **database id**. That is not its `#number`
and not its `node_id`:

```bash
id=$(gh api repos/[owner]/[repo]/issues/[blocker] --jq .id)
gh api --method POST   repos/[owner]/[repo]/issues/[child]/dependencies/blocked_by -F issue_id=$id
gh api --method DELETE repos/[owner]/[repo]/issues/[child]/dependencies/blocked_by/$id
gh api --method POST   repos/[owner]/[repo]/issues/[parent]/sub_issues -F sub_issue_id=$id
```

The child's repo is the one in the URL, and the blocker can be in any repo. Report each write as
it lands (`OK child <- blocker` or the error's last line), and keep going past a failure rather
than leaving half a plan applied in silence.

- **Filing a new issue** (a parent, or the second half of a split) follows the user's triage
  rules: the triage skill, its disclaimer, one category label and one state label.
- **Editing a body**: fetch it to a file, change only the lines named in the plan, write it back
  with `--body-file`. Never retype a body from memory.
- Update a tracker's checklist when you add a sub-issue, so the human view matches the native one.

## 6. Verify

Re-run the audit. Every section you planned to empty should be empty, and the rest should be
explained. Then hand over:

```bash
npm run sandcastle -- --epic [owner/repo#parent] --plan-only
```

It costs no tokens. Its **held**, **flagged** and **not promoted** lists are the final word, and
anything in them you did not expect is a link this skill missed.

---

**Not this skill:** wiring a repository in as a member, or getting the image to build, is
`sandcastle-install`. Writing the implementer and reviewer briefs the epic's agents are given is
`sandcastle-prompts`. Running the epic, and anything about how the planner stages, stacks or
gates tasks, is the harness itself (`c-energie/sandcastle-harness`, README *Epic mode*). Deciding
what a ticket should *say* is the `triage` and `grilling` skills.
