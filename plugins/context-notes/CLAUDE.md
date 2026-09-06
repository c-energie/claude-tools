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
`context.json` — `state.notes` — and there is no default.** See the invariants below; that is the
one rule here that cannot be relaxed.

## Commands

```bash
node scripts/triage-notes.mjs config "$ROOT"                       # load + validate, offline
node scripts/triage-notes.mjs config "$ROOT" --json
node scripts/triage-notes.mjs resolve "$ROOT" --repos repos.json --topics "dev-hub,IP"
node scripts/triage-notes.mjs select  --pages pages.json                # new notes per topic, offline
node scripts/triage-notes.mjs propose "$ROOT" --batch b.json --classify   # table + shortlist, writes nothing
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
      { "owner": "net-flex",  "visibility": "shared" }
    ],
    "sensitiveTerms": ["salary", "non-disclosure"]
  }
}
```

`_`-prefixed keys anywhere in it are comments and are skipped, not rejected — the convention
`_stakeholdersNote` and `_slackChannelsNote` already set in the same file. The first real block
lives in `net-flex/context`, and it is worth reading before changing anything here.

## Invariants (all load-bearing)

- **There is no default configuration, and there never may be.** A context repo with no
  `state.notes` is *unconfigured*. It must not fall back to another project's block: a fallback
  is precisely how one org's notes end up proposed as issues in another org's repository. Same
  rule, same reason, as `state.diagrams.repo`.
- **Four outcomes, and they stay four**: `configured`, `unconfigured`, `opted-out`, `unresolved`.
  A caller distinguishes them by `status` and never by parsing a message. Conflating opt-out with
  unconfigured gets an opt-out "helpfully" fixed by someone configuring it; conflating unresolved
  with unconfigured sends someone to edit a `context.json` that nothing is reading. The opt-out
  vocabulary is the existing one — `none`/`off`/`false`/`no`/`-`/`disabled`.
- **There is deliberately NO topic map.** A topic resolves to a repository when its name equals a
  repository name **character for character** in one of the declared organisations, and to a
  thread in the resolved context repo otherwise. No aliases, no prefix or suffix matching, no
  fuzzy matching. A map can name a repository that no longer exists; an exact match cannot. The
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
- **`Last triaged` and `Shortlisted` are DATETIMES, not dates.** A run that fails half way is
  resumed by re-running, and only a timestamp separates notes already written from notes not yet
  reached; date granularity would re-propose everything written earlier the same day. Notion has
  no schema-level datetime flag, so the rule is enforced by the writer and stated in three
  places: the Notion property description, the `state.notes` block, and the skill. **Do not
  normalise them to match the date-only properties beside them.**
- **Naming a Mind Palace is not the same as being able to see it.** An MCP connection exists
  because of the host registry and the repo's own MCP scope, not because a `context.json` names
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

`scripts/context-repo.sh`, `scripts/dates.mjs` and `scripts/bash-bin.mjs` are **deliberate
copies** of the originals in `context-kit-core`: a skill can only reference
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
