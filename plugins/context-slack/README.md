# context-slack

The **Slack delivery layer** for [context-kit](https://github.com/c-energie/context-kit): the
skills that take what a project already tracks and put it in front of people on Slack — a
per-person "who's got what" digest to a channel, and a direct nudge about the pending queue.

Install **alongside context-kit** (same marketplace); `person-slack-digest` also needs
**context-notion**, since its data comes from the project's Notion databases. Nothing in this
plugin names a channel, a person or a workspace: all of that comes from the context repo's
`context.json`.

## The contract: what it reads from `context.json`

```json
{
  "connections": { "slack": "claude_ai_Slack" },
  "state": {
    "notion": {
      "people": [
        { "name": "Ada", "notionUserId": "…", "slackMemberId": "U0123ABC" }
      ],
      "defaults": { "slackChannel": "#standup" }
    }
  }
}
```

- **`connections.slack`** — the MCP server serving *this project's* workspace. A machine can hold
  several; the skills use only the declared one, and ask rather than guess when there is no
  declaration. Posting through another project's connection puts a message in a stranger's
  workspace, and it cannot be unsent.
- **`defaults.slackChannel`** — the default channel for team-wide posts.
- **`people[].slackMemberId`** — the roster's member IDs. Resolved **here, never from a user
  search or from "the logged-in user"**: in the account owner's own session those coincide, in a
  colleague's they don't, and the message goes to the sender instead. `null` renders a plain name
  rather than an `@`-mention, which is correct behaviour, not a bug.

The Slack keys sit inside the same roster the Notion layer uses, so a project that already ran
`notion-discover` only has to add `slackMemberId`s and a channel.

## Skills

| Skill | What it does |
| --- | --- |
| `slack-config` | _(hidden)_ The contract above, the person-resolution traps, and the posting rules |
| `person-slack-digest` | 🔒 Per-person digest of actions, watches, questions and relationships → a channel |
| `notify-pending` | 🔒 DM whoever drains the `pending/` queue that items are waiting |

🔒 = `disable-model-invocation: true`. **Every skill here is blocked from self-triggering**, with
no exceptions: a Slack message is visible to other people the instant it lands and cannot be
recalled. They run when the user names them, or when context-notion's `weekly-review` offers them
and the user accepts.

## Scripts

```bash
node scripts/person-digest.mjs digest.json --title "Project"   # --json, --today YYYY-MM-DD
node scripts/pending-parse.mjs "$ROOT" --slack --added-by ada  # the queue message
node ../context-kit-core/scripts/check-plugin.mjs .            # lint — run before any commit
node ../context-kit-core/scripts/bump-version.mjs . patch
```

`person-digest.mjs` owns the digest's fixed rules — grouping by owner, the overdue / due-this-week
cut-off, `@`-mention rendering, the 5000-character split — so the digest reads the same every week
and nobody's row is quietly dropped.

**Deliberate copies.** `context-repo.sh`, `dates.mjs`, `bash-bin.mjs`, `lib.mjs` and
`pending-parse.mjs` are copies: plugins cannot reach into each other's install directories. The
generic three originate in context-kit-core and the two Notion-coupled ones (`lib.mjs`,
`pending-parse.mjs`) in context-notion — **fix there first, then copy here.** `pending-parse.mjs` in particular *defines* the pending entry format; a drifted copy
means a queue that reads differently depending on which plugin looked at it.

## Roadmap

Genuinely Slack-native work has no home yet: digesting a thread into a context thread, capturing a
channel decision into the decision log, reading a channel for what a project missed. Those would
justify this plugin on their own; today both skills are Notion-sourced.
