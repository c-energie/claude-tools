# CLAUDE.md

## What this plugin is

`context-notes` — the **note-triage layer**. It reads the notes a person captured in their
project's Notion **Mind Palace**, decides where each one belongs, and writes it there after
approval. One skill, `triage-notes`, and one script, `scripts/triage-notes.mjs`.

It is its own plugin rather than a skill inside a neighbour, because it sits across two layers
and belongs to neither: it reads Notion (which is `context-notion`'s subject) and it writes
threads and handoff items (which is `context-kit-core`'s). Folding it into either would give that
plugin knowledge of the other's layer.

**Which Mind Palace, and which organisations, come from the project's own
`state.notes` — in the workspace's `.claude/workspace.json`, or a legacy context repo's
`context.json` — and there is no default.** See the invariants below; that is the one rule here
that cannot be relaxed.

**Which root.** `[checkout]`, when given, is used exactly as given. Omitted, it is found by
`workspace.mjs`'s `resolveWorkspace()`, as context-notion has done since #53: the nearest
`.claude/workspace.json` at or above the working directory, then the legacy `context-repo.sh`
route. At a root, a `workspace.json` wins over a `context.json` beside it, and a malformed one is
reported as `unconfigured` rather than passed over — falling through would read a different
block because of a typo. The root's own repository ("is this target me", for thread parking and
handoff draining) is `workspace.json`'s `repo` or `context.json`'s `contextRepo`, read by
`loadConfig` from the file it loaded. Until #82 this plugin knew only `context.json`, so after #58
moved the last real block into a workspace.json, every run reported `unresolved`.

## Commands

```bash
node scripts/triage-notes.mjs config "$ROOT"                       # load + validate, offline
node scripts/triage-notes.mjs config                               # ...resolving the root itself
node scripts/triage-notes.mjs config "$ROOT" --json
node scripts/triage-notes.mjs resolve "$ROOT" --repos repos.json --topics "dev-hub,IP"
node scripts/triage-notes.mjs select  --pages pages.json                # new notes per topic, offline
node scripts/triage-notes.mjs propose "$ROOT" --batch b.json --classify   # table + shortlist, writes nothing
node scripts/triage-notes.mjs github  "$ROOT" --batch evaluated.json      # plan gh issue create, runs nothing
node scripts/triage-notes.mjs notion  "$ROOT" --batch evaluated.json      # format context-notion skill args
node scripts/triage-notes.mjs threads "$ROOT" --batch evaluated.json      # assemble save-thread material
node scripts/triage-notes.mjs handoff "$ROOT"                             # the queue: drain-now vs list-only
node --test scripts/triage-notes.test.mjs                          # from the plugin directory
node ../context-kit-core/scripts/check-plugin.mjs .                # before any commit
```

## The `state.notes` block

```json
"state": {
  "notes": {
    "mindPalace": { "dataSource": "collection://[id]", "database": "[bare id]" },
    "organisations": [
      { "owner": "c-energie", "visibility": "personal" },
      { "owner": "acme-co",   "visibility": "shared" }
    ],
    "sensitiveTerms": ["salary", "non-disclosure"]
  }
}
```

`_`-prefixed keys anywhere in it are comments and are skipped, not rejected — the convention
`_stakeholdersNote` and `_slackChannelsNote` already set in the same file. The first real block
lived in `net-flex/context`; since #58 the live one is in `corson94/workspace-gh`'s
`.claude/workspace.json`, and it is worth reading before changing anything here. In a workspace,
`state.notes` is this plugin's own key — written by hand today, and by any future writer only as a
block-scale edit that leaves every other key byte-identical (ADR 0002).

## Invariants (all load-bearing)

- **There is no default configuration, and there never may be.** A workspace or context repo
  with no `state.notes` is *unconfigured*. It must not fall back to another project's block: a fallback
  is precisely how one org's notes end up proposed as issues in another org's repository. Same
  rule, same reason, as `state.diagrams.repo`.
- **Four outcomes, and they stay four**: `configured`, `unconfigured`, `opted-out`, `unresolved`.
  A caller distinguishes them by `status` and never by parsing a message. Conflating opt-out with
  unconfigured gets an opt-out "helpfully" fixed by someone configuring it; conflating unresolved
  with unconfigured sends someone to edit a config file that nothing is reading. The opt-out
  vocabulary is the existing one — `none`/`off`/`false`/`no`/`-`/`disabled`.
- **There is deliberately NO topic map.** A topic resolves to a repository when its name equals a
  repository name **character for character** in one of the declared organisations, and to a
  thread in the resolved workspace (or context repo) otherwise. No aliases, no prefix or suffix
  matching, no fuzzy matching. A map can name a repository that no longer exists; an exact match cannot. The
  consequence is real and accepted: `claude` resolves to a *thread* because the repository is
  `claude-tools`, and the fix is renaming the Notion topic, not loosening the match.
- **Three resolution outcomes, all valid**: `repo`, `thread`, and `ambiguous`. `ambiguous` — a
  name matching in more than one declared organisation — resolves to **neither** and shortlists,
  because the organisations differ in visibility and picking one would cross that boundary on a
  guess. `secret-roster` exists in both `c-energie` and `net-flex`, so this is live, not
  hypothetical.
- **`repo` and `thread` are distinguishable STATES, not a value and its absence.** The routing
  test needs to know to skip its issue branch; inferring that from a null would make "no
  repository" and "not looked up" the same answer.
- **Visibility is a property of the ORGANISATION, never of a repository.** One flag per
  organisation means there is no per-repository flag to keep in step with reality, and nothing
  that can disagree with itself.
- **The repository list is passed in, never fetched by the script.** Listing repositories is the
  model's job at the start of a run; matching is this script's, offline and testable. The list
  carries the time it was gathered, so "resolved to a thread" and "resolved to a thread because
  the list was stale" stay distinguishable.
- **The routing test is prose (the model judges); the shortlist is code (the script decides),**
  and the shortlist runs AFTER classification and OVERRIDES it. That split is the point: a note
  that must not be routed automatically cannot be caught by asking the model how confident it
  feels, because that is a second opinion from the source that already committed to an answer.
  The five triggers are RULES, not a score — no confidence number is requested, stored or
  thresholded, and there is no threshold to tune. The bias runs one way, toward the shortlist.
- **`why` is required on every proposed row.** A table showing only the verdict hides the
  reasoning, and the reasoning is where routing goes wrong: the destination often looks right
  while the reason for it is wrong, and only a reviewer who can see the reason catches it.
- **The issue branch is gated on the topic's resolution.** A topic that resolved to `thread` or
  `ambiguous` skips step one entirely, so the six-destination test is a five-destination test for
  most topics. Without the gate, a note under a repository-less topic gets argued into an issue
  with nowhere to go.
- **A GitHub issue is the one write whose history cannot be rewritten.** An issue body in a
  shared repository is visible to the team, so a note routed to the wrong repository is a
  disclosure rather than an inconvenience. Three guards follow from that and none is optional:
  reachability is checked once per distinct destination repository BEFORE approval and shortlists
  by REPOSITORY NAME (a fine-grained token lists repositories explicitly, so a too-narrow one
  fails per repository and would otherwise read as a classifier problem); a shared destination is
  never written directly from a personal session; and a row whose repository cannot be named is
  refused rather than opened on a guess.
- **The script formats, the model executes.** `gh issue create` is planned here and run by the
  model, one command per row in table order, so a partial failure is attributable and the marker
  can advance per note. `--body-file` and never `--body`: note text is arbitrary user prose, and
  shell quoting of arbitrary prose is a bug waiting for the first backtick.
- **`state.notes.projects` is OPTIONAL and keyed by REPOSITORY, not by topic.** It carries a board
  name only, so it is not the topic map returning by another door: it cannot decide where a note
  goes, only which board an issue lands on once exact matching has already chosen the repository.
  Absent omits `--project` and says the board was skipped, which is not an error.
- **THIS PLUGIN HOLDS NO NOTION PROPERTY NAMES, and a test asserts it.** Three destinations are
  Notion rows, and `context-notion` already owns each database's traps — the trailing space in
  the open questions `Type ` property, the `Watching` status on actions, data source id versus
  database id. Triage formats arguments and the model calls `context-notion:add-action`,
  `:add-open-question` or `:log-decision`. A second implementation would drift and the schema
  would be asserted in three places. If one of those skills needs a new parameter, that is a
  change to `context-notion`, made and versioned there.
- **Nothing is invented to fill a gap.** An action without an identifiable owner or a date is
  refused, not defaulted: a guessed owner assigns somebody work they never agreed to, and a
  substituted deadline is a commitment nobody made. A decision with no rationale gets an EMPTY
  one — a log that acquires reasoning nobody gave is worse than one with a gap in it.
- **The Notion connector returns EMPTY RESULTS, not errors, for a workspace guest.** So its
  presence is checked explicitly and named on failure, never inferred from a result, and a write
  that cannot reach Notion is queued with `context-notion:add-pending` rather than dropped —
  keeping its old marker, so a queued item is not also re-proposed.
- **THIS PLUGIN HOLDS NO THREAD FRONT-MATTER KNOWLEDGE EITHER, and a test asserts it.** Writing
  a thread is not creating a markdown file: front matter from a template, `topics:` that must
  exist in `taxonomy.yml`, a `YYYY-MM-DD-` filename the session-start hook can find, and an index
  that stays in step. `context-kit-core:save-thread` owns all of it. Nothing triage produces ever
  becomes a front-matter VALUE — an angle bracket there is read as a tag and the field is dropped
  silently, which is one of the marketplace's documented silent failures.
- **Triage introduces no new vocabulary.** Thread status stays `active | settled | archived`. A
  `status: seed` and a `target:` field were considered for an undeveloped thread and dropped: a
  Mind Palace topic page already IS that, with a rolling summary maintained for free. `dropped`
  was rejected too — triage routes notes and does not manage thread lifecycle, so the value would
  have had no writer.
- **A tag not in `taxonomy.yml` shortlists; it is never invented inline.** An alias resolves to
  its canonical tag, because rejecting one would orphan the rename aliases exist to allow. Adding
  a tag is a pull request, and that friction is the point.
- **A thread bound for another repository is PARKED, never written.** A thread file is a commit
  into that repository, and it goes through that project's own session — which is where
  `taxonomy.yml` validation lives. That boundary is what keeps the validation meaningful.
- **`handoff/` means output bound for a context repo SOMEBODY ELSE OWNS**, and nothing else. You
  cannot hand off to yourself, so an item whose target this session can write is drained rather
  than parked. Personal targets drain automatically; SHARED ones are listed and left, which is
  where the gate belongs. Visibility is read from the same `organisations` flag the shortlist
  rules use, so the two can never disagree.
- **The carried-over section is ALWAYS rendered, with a count, even when it is zero.** A run that
  writes something it did not show is the failure this prevents, and an omitted section makes
  "nothing was carried over" indistinguishable from "not printed". The backlog count is reported
  at the start of every run, including zero, so an empty queue is something seen not assumed.
- **An item moves to `handoff/done/` only after its write SUCCEEDS.** A failure leaves it exactly
  where it was and the run continues; a half-drained queue is recovered by re-running.
- **Handoff contract changes are ADDITIVE.** `kind` gained `issue`; `repo:` is required for that
  kind and optional otherwise, so items written in the older four-kind format still parse.
- **NEVER commit a real handoff item as a test fixture.** Everything under `plugins/` travels
  with every clone that installs the plugin, and each machine's plugin cache is another copy, so
  a real item would move one person's and one org's content into another org's shipped artefact.
  Real items need no rescuing either: they are committed in their own repo and `git show` recovers
  them after a drain. Same rule, same reason, as keeping working notes out of a tool repo's own
  `.claude/threads/`. Fixtures are hand-written to match the shape.
- **`Last triaged` and `Shortlisted` are DATETIMES, not dates.** A run that fails half way is
  resumed by re-running, and only a timestamp separates notes already written from notes not yet
  reached; date granularity would re-propose everything written earlier the same day. Notion has
  no schema-level datetime flag, so the rule is enforced by the writer and stated in three
  places: the Notion property description, the `state.notes` block, and the skill. **Do not
  normalise them to match the date-only properties beside them.**
- **Naming a Mind Palace is not the same as being able to see it.** An MCP connection exists
  because of the host registry and the repo's own MCP scope, not because a config file names
  an id. A palace the session's connector cannot reach must be reported as a **connector**
  problem and the run stopped — an empty read is indistinguishable from an empty palace, and
  presenting it as "nothing to do" is the one failure that silently loses work.
- **Sensitive terms are matched case-insensitively as substrings**, so a short term is a trap
  rather than a caution. `nda` matches `standardising`, `standardised` and `foundation`; `IP`
  matches `equipment`, `recipient` and `description`; `bid` matches `forbidden`. Anything shorter
  than about four characters must be checked against `memory.md` and `glossary.md` before it goes
  in a repo's list. If the acronym gap ever matters, the fix is word-boundary matching for a
  marked subset — a change here, not in any repo's configuration.

## Mirrored logic

`collectNotes()` in `scripts/triage-notes.mjs` is a **port** of `collect_notes()` in
`c-energie/bots` (`src/notebots/notes/summarise.py`), not a reimplementation. Both files carry a
banner saying so, and `bots/CLAUDE.md` lists it alongside its other mirrored halves.

The two tools read the same Mind Palace pages for different reasons — this one decides where a
note should **go**, the summariser decides what it **means** — but they must agree on what a note
**is**: which block types count, that `created_time` is preferred with the dated `heading_2` as
the fallback, and that blocks under a "What this means" `heading_3` are the summariser’s own
output and never notes. If they drift, a bullet gets triaged into an issue that was never folded
in, or a summary gets triaged back into an issue. Change one, change the other.

## Copies

`scripts/context-repo.sh`, `scripts/dates.mjs`, `scripts/bash-bin.mjs` and `scripts/workspace.mjs`
are **deliberate copies** of the originals in `context-kit-core`: a skill can only reference
`${CLAUDE_PLUGIN_ROOT}/scripts/...` inside its own plugin. Fix the original first, then copy,
restoring only this copy's header banner. `check-plugin.mjs` compares below the banner and errors
on drift.

## Working on this plugin

Everything in the marketplace `CLAUDE.md` applies — the silent skill-authoring failures in
particular: directory name matching front-matter `name`, no angle brackets in any front-matter
value, `disable-model-invocation` or an explicit gate on anything that writes outside the
session, and `*.sh` staying LF. Check and bump this plugin on its own:

```bash
node ../context-kit-core/scripts/check-plugin.mjs .
node ../context-kit-core/scripts/bump-version.mjs . patch
```
