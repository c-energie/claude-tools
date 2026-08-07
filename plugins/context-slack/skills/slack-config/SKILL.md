---
name: slack-config
description: How the context-slack skills find and use a project's Slack configuration — the context.json connections.slack and defaults.slackChannel contract, member IDs in the roster, and the rules that keep a message from going to the wrong workspace or the wrong person. Background knowledge for every skill in this plugin; not a task to run.
user-invocable: false
---

# The project's Slack configuration

Every skill in this plugin is generic: which connection, which channel and which people all come
from the **project's context repo**, at runtime. This skill is the one place that procedure lives.

## 1. Resolve the config

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --no-pull)"
```

Read `$ROOT/context.json`. No shell (Cowork)? Read it over the GitHub connector instead — the
route is context-kit-core's `context-access`, and which repo is `context-setup`'s ladder.

What this plugin reads:

- **`connections.slack`** — the MCP server that serves *this project's* workspace, e.g.
  `{ "slack": "claude_ai_Slack" }`. A machine can hold several Slack connections; **use only the
  one this project declares.** If several are visible and the project declares none, **ask — never
  guess.** Posting through another project's connection puts a message in a stranger's workspace,
  and it cannot be unsent.
- **`state.notion.defaults.slackChannel`** — the project's default channel for team-wide posts
  (e.g. `#standup`). Absent → ask which channel, and offer to add it to `context.json`.
- **`state.notion.people[].slackMemberId`** — the roster's Slack member IDs. **This is the only
  place to resolve a person.**

If a skill needs one of these and the project doesn't declare it, say which key is missing from
`context.json` — a one-line fix — rather than improvising.

## 2. Resolving people — the trap

- **Take member IDs from the roster, not from a user search, and never from "the current logged-in
  user".** In the account-owner's own session those coincide; in a colleague's they do not, and the
  message goes to the sender instead of the intended person.
- **A member ID only works in the workspace it came from.** Another workspace's ID fails with
  `channel_not_found` — when that happens, say so rather than retrying against a channel.
- `slackMemberId: null` → the digest renders their plain name instead of an `@`-mention. That is
  the correct behaviour, not a bug to work around.
- **A user ID passed as `channel_id` sends a direct message.** That is how the DM path works — and
  how a message meant for one person ends up in a channel if the wrong ID is used.

## 3. Posting rules

- **Nothing here posts unprompted.** Every skill in this plugin is
  `disable-model-invocation: true`: it runs when the user names it, or when a runner offers it and
  they accept. A Slack message is visible to other people the instant it lands and cannot be
  recalled — that is why the gate is a blanket block rather than a judgement call.
- **Show the text before sending** if the user hasn't already seen it, or use the draft tool where
  the connection has one.
- **No Slack connection?** Build the message, show it, and say plainly that it was **not sent**, so
  the user can paste it themselves. A missing connector is not a failure of the underlying job.
- **Standard Markdown, not Slack mrkdwn** — the MCP send tools take Markdown and convert it.
- Report the returned message link, so the user can find what was posted.

**Not this skill:** the Notion side of the same configuration — databases, schemas, the guest gap —
is context-notion's `notion-config`. Reaching the context repo itself is context-kit-core's
`context-access`.
