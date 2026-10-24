# CLAUDE.md

## What this repo is

The **Slack delivery layer** plugin (`context-slack`) in the c-energie context architecture:
core = context-kit-core (repo machinery), middle = context-notion (Notion) and this (Slack),
project = each workspace's `.claude/workspace.json` (or a legacy context repo's `context.json`). Nothing project-specific belongs here — no channel,
no member ID, no workspace name. A skill that needs one reads `connections.slack`, the
`defaults.slackChannels` purpose map (falling back to `defaults.slackChannel`) or the roster's
`slackMemberId`; `skills/slack-config/SKILL.md` is the contract and the file to update when it
grows. **The plugin defines the purpose keys, never the channels** — a project may declare keys
this plugin has never heard of, and an unknown key is not a config error.

Lives at `plugins/context-slack` **inside the context-kit repo** (`c-energie/claude-tools`), whose
`marketplace.json` lists it with a relative source. There is no marketplace.json here, and the
version lives in `plugin.json` only.

## Commands

```bash
# Lint and bump live in context-kit-core only — dev-time tools no skill invokes, so they need
# no copy here. Run them from the marketplace root, naming this plugin's directory:
node ../context-kit-core/scripts/check-plugin.mjs .          # lint; run before any commit
node ../context-kit-core/scripts/bump-version.mjs . patch    # writes plugin.json only
CONTEXT_CONFIG=path/to/context.json node scripts/person-digest.mjs digest.json --today 2026-08-07
node scripts/slack-sections.mjs                              # canonical headings + icons; --json
CONTEXT_CONFIG=path/to/context.json node scripts/pending-parse.mjs "$ROOT" --slack
```

## Invariants

- **Every skill here is `disable-model-invocation: true`, without exception.** A Slack message is
  visible to other people the instant it lands and cannot be recalled, so the gate is a blanket
  block rather than a per-skill judgement. A new skill that posts inherits the same rule.
- **People resolve from `state.notion.people` — never a user search, never "the logged-in user".**
  In the account owner's own session those coincide; in a colleague's they don't, and the message
  goes to the sender. A member ID also only works in the workspace it came from.
- **A user ID passed as `channel_id` is a DM.** That is how the direct route works, and how a
  private nudge becomes a channel post if the wrong ID is used.
- **Only the declared `connections.slack` connection** — several may be visible on one machine.
- **No connector ⇒ show the text and say it was NOT sent.** Never report a message as posted, and
  never treat a missing connector as failure of the underlying job.
- **`context-repo.sh`, `dates.mjs`, `bash-bin.mjs`, `workspace.mjs`, `lib.mjs`, `pending-parse.mjs`
  and `layout.mjs` are COPIES** — plugins cannot reference each other's `${CLAUDE_PLUGIN_ROOT}`.
  Fix the original first, then copy here; the origin goes by *layer*, so the four generic ones
  (`context-repo.sh`, `dates.mjs`, `bash-bin.mjs`, `workspace.mjs`) come from context-kit-core and
  the three Notion-coupled ones (`lib.mjs`, `pending-parse.mjs`, `layout.mjs`) from context-notion. `pending-parse.mjs` owns the pending
  entry format; a drifted copy breaks the single-definition rule — and `check-plugin.mjs` now
  errors on drift, comparing below each copy's header banner.
- **The queue and the mirror are where `layout.mjs` says** — `.context/pending/` and
  `.context/notion/` in a workspace, `pending/` and `notion/` in a legacy context repo — and config
  is the nearest `.claude/workspace.json` before any context repo (`CONTEXT_CONFIG` still wins).
  A skill here never types one of those paths: notify-pending reads the queue context-notion
  wrote, and its "not pushed yet" check runs against `$ROOT`, the repo that queue is committed to,
  scoped to the queue — a workspace repo's branch is ahead for threads and memory too.
- **Never spawn bare `bash`** — go through `bashBin()` from `scripts/bash-bin.mjs`. On Windows the
  `bash` on PATH is WSL's `System32\bash.exe`, which has its own filesystem and `$HOME` and so
  cannot see either this script or the clone the resolver prints back.
- **`person-digest.mjs` owns the digest's fixed rules** — grouping, the due-date cut-off, mention
  rendering, the 5000-char split — so it reads identically every week. The project's name reaches
  it via `--title`; the script never reads `context.json` itself.
- **`slack-sections.mjs` owns every section heading and icon**, and both posting skills read them
  from it rather than typing them out. A heading typed into a SKILL.md is the bug this file
  prevents: the roundup lost its icons between 3 and 11 Aug 2026 that way. Never add a heading to
  a skill — add it here, and say whether it is shared with the digest or roundup-only.
- Version in `plugin.json` only; no angle brackets in front-matter values; `*.sh` stay LF.
