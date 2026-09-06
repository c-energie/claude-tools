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

## 5. The two datetime markers

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
