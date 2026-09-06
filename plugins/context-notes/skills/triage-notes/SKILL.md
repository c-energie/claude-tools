---
name: triage-notes
description: Triage the notes captured in this project's Notion Mind Palace — read what is new since the last run, decide where each note belongs, and write it there after approval. Triggers like "triage my notes", "process the mind palace", "what have I captured", "clear my notes", "run note triage", "empty the mind palace".
disable-model-invocation: true
---

# Triage the Mind Palace

Reads the notes captured in this project's Notion **Mind Palace**, works out where each one
belongs, and — once a person has approved the batch — writes it there.

`disable-model-invocation: true`: it writes outside the session, into Notion, GitHub and a
context repo. It runs when a person types it and at no other time.

**At this stage the skill can load and report a configuration, and nothing else.** Reading notes,
classifying them and every destination are added by the issues that follow. Build order and
status: `c-energie/claude-tools#10`.

## 1. Resolve the repo

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --no-pull)"
```

## 2. Load the configuration

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/triage-notes.mjs" config "$ROOT"
```

Four outcomes. **Report the one you got, in its own terms — never flatten two into one**, because
the fixes are different and one of them is "do nothing":

| status | what is true | what to do |
| --- | --- | --- |
| `configured` | A `state.notes` block that validates. | Carry on. |
| `unconfigured` | This context repo has no `state.notes`, or it does not validate. | Say so loudly, name `context.json`, and list every fault the script reported. |
| `opted-out` | `state.notes` is `none` (or `off`/`false`/`no`/`-`/`disabled`). | **Stop, quietly.** That is a decision. Do not offer to write a block. |
| `unresolved` | No context repo resolved at all. | Send them to `context-setup` or `init-context`. Do not edit a `context.json` — nothing is reading it. |

**There is no default and you must not invent one.** Do not read another project's `state.notes`,
do not infer a Mind Palace from a Notion search, and do not carry a configuration over from an
earlier session. A fallback here is how one org's notes end up proposed as issues in another
org's repository.

## 3. Check the connector before believing an empty result

`state.notes` naming a Mind Palace is **not** the same as this session being able to see it. An
MCP connection exists because of the host registry and this repo's own MCP scope, not because a
`context.json` names an id.

So: if the declared data source cannot be reached, **report it as a connector problem and stop.**
An empty read from a palace you cannot see is indistinguishable from a palace with nothing in it,
and reporting "nothing to triage" when the truth is "I could not look" is the one failure that
silently loses work.

## 4. Route topics against the repositories that exist

List the project's repositories yourself — that is the model's half of this — and hand the names
to the script, which matches them offline:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/triage-notes.mjs" resolve "$ROOT" \
  --repos repos.json --topics "dev-hub,news-watch,claude"
```

`repos.json` is `{"gatheredAt": "[ISO timestamp]", "repos": [{"owner": "...", "name": "..."}]}`.
Include the timestamp: a topic that resolved to a thread because the list was stale is a
different fact from one that has no repository, and the script can only say so if you tell it
when you looked.

**Matching is exact, and that is the design.** A topic routes to a repository only when its name
equals a repository name character for character in one of the declared organisations. There is
no topic map to maintain and no fuzzy matching, so nothing can drift from the repositories that
actually exist. Three consequences to report rather than paper over:

- **`thread` is a normal outcome, not a failure.** A topic with no repository of that exact name
  belongs in the context repo's threads.
- **A near-miss is not a hit.** `claude` does not become `claude-tools`. The script names the
  near-miss when it differs only by case; the fix is renaming the Notion topic, never loosening
  the match here.
- **`ambiguous` resolves to neither and shortlists.** A name matching in two declared
  organisations cannot be picked between: they differ in visibility, and guessing crosses that
  boundary.

## 5. Select what is new

Fetch each topic page's block children — one MCP call per page, and this is your step — then hand
them to the script, which does the selecting offline:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/triage-notes.mjs" select --pages pages.json
```

`pages.json` is `[{"topic": "...", "lastTriaged": "[ISO]|null", "settled": false, "children": [...]}]`.

**Read every topic's marker once, at the start of the run.** Re-reading mid-run would let the set
of notes under consideration shift while the user is reading the table.

**Sweep settled topics too.** A note typed against a settled topic is still a note; skipping it
would lose work with nothing to show it had happened.

What the script guarantees, and why you should not second-guess it:

- **Blocks under a "What this means" heading are never notes.** That is the summariser's own
  output, and triaging it would turn a summary back into an issue. The selection logic is a port
  of `collect_notes` in `c-energie/bots` for exactly this reason — two tools reading one page and
  disagreeing about what a note is would be a permanent source of confusion.
- **A duplicate bullet on one page is one note.** Typed twice does not mean two issues. Identical
  text under *two different topics* deliberately stays two rows: that is the cross-cutting case
  you are meant to notice and merge.
- **Nothing new short circuits the run.** If the sweep finds nothing, say so and stop — naming
  how many topics were swept. An empty table with no explanation leaves someone unable to tell
  "nothing to do" from "it did not work".

## 6. Route each note — the six-destination test

This is **the only judgement step in a run**, and it is a fixed ordered test, not open-ended
thinking. Work down it and **stop at the first destination that fits**. A note is never argued
into two places at once, and two runs over the same note reach the same answer.

1. It closes when a pull request merges **and the repository can be named** → **`issue`**
2. It is a commitment by a **named person with a date**, and is not code → **`action`**
3. It is an **unanswered question** → **`open-question`**
4. It **changed how the team operates** → **`decision`**
5. It is **reasoning a future reader needs** → **`thread`**
6. Otherwise → **`bin`**

**Step 1 is gated on the topic's resolution.** A topic that resolved to `thread` or `ambiguous`
has no repository, so **skip step 1 entirely** and start at step 2. For most topics this is
therefore a five-destination test. This is what stops a note under a repository-less topic being
argued into an issue that has nowhere to go, and the script refuses a row that ignores it.

**`bin` means no derived artefact.** The note keeps living on its topic page, which is where it
was always going to live. Triage never deletes or edits a captured note, so binning is safe
rather than destructive — and it is what stops a note being left unaccounted for at the end.

**Exactly one destination per note.** A note carrying both rationale and a commitment gets one
row. That is a known limitation, stated here so it reads as one rather than as a bug.

Every row needs `id`, `topic`, `note`, `destination`, `target` and **`why`**. `why` is required
and the script refuses a row without it: a table showing only the verdict hides the reasoning,
and the reasoning is exactly where routing goes wrong — the destination often looks right while
the reason for it is wrong, and that is the case a reviewer can only catch if it is on screen.

## 7. Propose the batch

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/triage-notes.mjs" propose "$ROOT" \
  --batch batch.json --repos repos.json --classify --expand
```

The script evaluates the shortlist, renders the table and refuses unreviewable rows. It **writes
nothing** — the whole routing test, the shortlist and the amendment loop can be exercised against
the real Mind Palace with no possibility of a bad write. `--classify` is the read-only mode: it
prints the table and offers no approval.

**The shortlist is code, and it overrides your classification.** Five triggers, and they
accumulate — a note hitting several appears once with every reason named:

| trigger | why it is not yours to decide |
| --- | --- |
| the topic resolved `ambiguous` | the organisations differ in visibility; picking one crosses that boundary on a guess |
| an `issue` whose repository cannot be named | a vague note must not land in whichever repository seemed closest |
| a `sensitiveTerms` hit | policy set in config, so the check cannot be reasoned around |
| a destination in a `shared` organisation | work somebody else owns always gets a second look |
| it would otherwise be written directly | the bias runs one way, toward the shortlist |

**These are rules, not a score.** Do not report a confidence number, do not ask for one, and do
not argue a row off the shortlist — a second opinion from the source that already committed to an
answer is not a second opinion. If a shortlisted row is genuinely fine, that is the user's call
to make, not yours to pre-empt.

Shortlisted notes are kept out of the table and counted as "still undecided (n)", expandable on
request. They are stamped with a `Shortlisted` datetime so they do not resurface every run, and
**the user is not made to decide them before the run ends** — hesitation must not be converted
into a bad routing. Report the count every run: a count that only grows is evidence the routing
test is wrong, not evidence the user is behind.

## 8. Amend, then approve once

The user corrects rows **in plain language**. Apply the corrections to the batch JSON yourself and
re-render only what changed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/triage-notes.mjs" propose "$ROOT" --batch batch.json --repos repos.json --only 3,7
```

Re-printing the whole batch after a one-row correction is how a reviewer stops reading it.

**No proposal file is written.** The batch lives in the conversation: a file would add a write, a
read and a stale-copy failure mode to something small enough to read on screen.

**One approval covers the batch** — twelve notes is one decision. On approval, print the plan back
with `--approve` so what was agreed is on the record before anything is written.

## 9. Write the GitHub issues

**Read this section before opening anything.** An issue body in a shared repository is visible to
the team and its history cannot be rewritten. A note routed to the wrong repository is not an
inconvenience, it is a disclosure.

### Before approval: check you can reach each repository

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/triage-notes.mjs" github "$ROOT" --batch evaluated.json --body-dir "$(mktemp -d)"
```

It prints one `gh repo view` probe per **distinct** destination repository. Run them **before the
batch is approved** — a token scoped too narrowly discovered half way through a batch is how a run
ends up half-written. Re-run with `--unreachable "owner/repo,…"` for any that fail; those rows
shortlist, and **the reason names the repository**, because a fine-grained token lists
repositories explicitly and so fails per repository rather than per organisation. Without the
name, a too-narrow credential reads as a classifier problem.

### Then run the planned commands, one at a time

The script plans each `gh issue create` and writes each body to a file. **You run them.** One
command per row, in table order, so a partial failure is attributable to a specific row.

- **`--body-file`, never `--body`.** Note text is arbitrary user prose; shell quoting of arbitrary
  prose is a bug waiting for the first backtick.
- **The body carries the note verbatim** plus a provenance line — topic, capture date, link back
  to the Mind Palace page. The template is the script's, so every issue triage opens has the same
  shape.
- **The title is yours**: a short statement of the work, so the issue list stays readable. Not the
  raw bullet. The script rejects an empty one.
- **`--project` is omitted when the repository has none**, and the run says the project was
  skipped. Not an error — not every repository has a board.

### After each creation

**Advance `Last triaged` immediately**, with the note's own timestamp. A re-run after a failure
must not open the same issue twice.

**A failed creation is non-fatal.** The note keeps its old marker so it is proposed again next
run, the failure is named in the run summary with the repository and the `gh` error, and the batch
**continues** — one bad repository does not abandon it.

**Report every created issue's URL back**, so what was just written can be opened.

### What never gets written here

A row whose repository could not be named, and a row whose destination is in an organisation
flagged `shared`. Both shortlist — the shared one goes to `handoff/` with `kind: issue` and a
`repo:` field once that contract lands. A personal session does not write into work somebody else
owns.

## 10. Write the Notion rows — through the existing skills

**Triage does not write Notion rows.** Three destinations are Notion rows, and each database
already has a skill that writes it and owns its property traps: the trailing space in the open
questions `Type ` property, the `Watching` status on actions that means a reminder rather than a
task, and the data source id versus database id distinction whose error blames sharing
permissions. A second implementation of those would drift, and the schema would then be asserted
in three places.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/triage-notes.mjs" notion "$ROOT" --batch evaluated.json
```

The script formats the arguments; **you call the skill**:

| destination | skill |
| --- | --- |
| `action` | `context-notion:add-action` |
| `open-question` | `context-notion:add-open-question` |
| `decision` | `context-notion:log-decision` |

Those skills read the **resolved** repo's `state.notion`, which is what stops a run in one project
writing into another project's databases — a stronger guarantee than anything this plugin could
enforce itself. Do not pass database ids; do not call the Notion API directly.

**Never invent an owner, a date or a rationale.** An action carries the person and the deadline
the user actually wrote, or the script refuses it: a guessed owner assigns somebody work they
never agreed to, and a substituted deadline is a commitment nobody made. A decision with no
rationale gets an **empty** one — a log that acquires reasoning nobody gave is worse than one with
a gap in it.

An open question must be **phrased as a question**: that database's title property is a question,
so a statement reads wrong in it. A decision needs a **statement of what was decided**, not the
topic name, or the log cannot be read without opening every row.

### Check the connector first, and queue rather than drop

**The Notion connector returns empty results, not errors, for a workspace guest.** So a write that
silently goes nowhere looks exactly like a quiet run. Check the connector is present at the start
and **name it** if it is not — never infer its absence from an empty result.

If it is unavailable, re-run with `--no-connector`: every row is queued with
`context-notion:add-pending` into the context repo's `pending/` folder rather than dropped. Report
the queued items in the run summary and name **`context-notion:process-pending`** as the drain.
Queued notes keep their **old** marker, so a queued item is not also re-proposed next run.

### After each row

Marker immediately after success; a failure keeps its old marker, is named in the run summary, and
the batch continues.

If one of these skills needs a new parameter, that is a change to **`context-notion`**, made and
versioned there — not worked around here.

## 11. Write the threads — through save-thread

**Triage never writes a thread file.** Writing one is not "create a markdown file": it carries
front matter from a template, its `topics:` must already exist in `taxonomy.yml`, its filename
must be dated `YYYY-MM-DD-` and end `.md` or the session-start hook will not find it, and the
index has to stay in step. `context-kit-core:save-thread` owns all of that.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/triage-notes.mjs" threads "$ROOT" --batch evaluated.json
```

The script assembles the material and checks the boundaries; **you call `save-thread`**.

**Several notes may be one thread.** The batch is flat across topics precisely so three bullets
under three topics can be recognised as one piece of reasoning — set the same `thread` key on each
row. One topic of reasoning per file, though: a thread is not a dumping ground. Each contributing
note is marked individually once the thread saves.

**Tags come from `taxonomy.yml` only.** An alias resolves to its canonical tag. A tag that does not
exist **shortlists**, naming the tag: adding one is a pull request, and that friction is the point
— without it a vocabulary grows three spellings of one idea, each silently returning a third of
the results. Do not invent a tag inline to get a note routed.

**No new vocabulary enters through this route.** Status is `active`, `settled` or `archived`. A
`seed` status and a `target:` field were considered and dropped: a Mind Palace topic page already
is that, with a rolling summary maintained for free.

**A thread bound for another context repo is parked, never written.** A thread file is a commit
into that repository, and it goes through that project's own session — which is where
`taxonomy.yml` validation lives. It becomes a `handoff/` item; report it with the target named, so
the user knows something is waiting.

The note's own words go into the **body**, with a provenance line. Nothing triage produces ever
becomes a front-matter value — an angle bracket there is read as a tag and the field is dropped
**silently**, which is one of the marketplace's documented silent failures.

If `save-thread`, the template, `taxonomy.yml` or the status enum needs changing, that is a change
to **`context-kit-core`**, made there.

## 12. Drain the handoff queue — first, before selection

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/triage-notes.mjs" handoff "$ROOT"
```

**Run this at the start, before selection**, so carried-over work and newly proposed work are
approved together in one table.

`handoff/` means **output bound for a context repo somebody else owns**. That is the whole of it.
You cannot hand off to yourself, so an item whose target this session can write is drained rather
than parked — parking one would gate the user on their own approval.

| target | what happens |
| --- | --- |
| this repo itself | written — you cannot hand off to yourself |
| an org flagged `personal` | **drained automatically** |
| an org flagged `shared` | **listed and left.** The gate sits exactly where another person's repository is |
| an org that resolves to nothing | listed with that reason, never guessed at |
| an unreachable repository | listed — a credential problem, not a routing one |

Visibility is read from the **same** `organisations` flag the shortlist rules use, so the two can
never disagree.

**Report the backlog count at the start of every run, including zero.** An empty queue should be
something the user saw, not something they assumed.

**Always show the carried-over section, even when it is empty.** A run that writes something it
did not show is the failure this prevents, and an omitted section makes "nothing was carried over"
indistinguishable from "not printed". Shared items are listed **every** run, so a stalled one stays
visible rather than being forgotten.

**Move an item to `handoff/done/` only after its write succeeds.** A failed write leaves the item
exactly where it was, is named in the run summary, and **the run continues** — one broken item does
not block a batch, and a half-drained queue is recovered by re-running.

Triage's own shared-target output is parked in `handoff/` in this same format — one queue, not two.
`kind` is `action | decision | open-question | thread-seed | issue`, and **`repo:` is required for
`kind: issue`** (an issue's destination is recorded, never inferred from the prose) and optional
otherwise, which is what keeps older items parsing unchanged.

## 13. The two datetime markers

`Last triaged` and `Shortlisted` on each topic row are **datetimes, not dates**, and must stay
that way. A run that fails half way is resumed by re-running it, and only a timestamp separates
notes already written from notes not yet reached — date granularity would re-propose everything
written earlier the same day. Notion has no schema-level datetime flag, so this is enforced by
whoever writes the value. Never normalise these to match the date-only properties beside them.

## Writing

Nothing is written without approval, and nothing is pushed unasked. Every destination arrives in
a later issue; until then this skill reports and stops.

---

Not this skill: `context-notion:add-action` and `context-notion:log-decision` are the right tools
for a *single* item you already know the destination of — this one is for a batch whose
destinations have to be worked out. `context-kit-core:save-thread` writes one thread from the
current session's work. `context-notion:add-pending` is the fallback when Notion cannot be
reached at all. `context-doctor` is what to run when the configuration itself looks wrong.
