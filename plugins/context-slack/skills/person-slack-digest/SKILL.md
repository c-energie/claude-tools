---
name: person-slack-digest
description: Build a per-person digest from the project's Notion workspace (each person's actions, watch reminders, open questions they are chasing, and relationships they own) and post it to Slack as one message with a section per person. Triggers like "send the person digest to Slack", "post everyone's actions to Slack", "who's got what — send it to the team channel".
disable-model-invocation: true
---

# Per-person digest → Slack

Pulls everything tied to each person on the roster out of Notion and posts a single Slack message
with **one section per person**. **Read `slack-config` first** — the connection, the channel and
the member IDs all come from the project's `context.json`.

> **Posts to a shared channel — run only when asked.** Excluded from automatic invocation
> (`disable-model-invocation: true`); it runs when the user asks for it by name, or when a weekly
> runner offers it and they accept.

**Requires:** the project's **Notion** connection (read) **and** its **Slack** connection. If the
Slack tools are missing, build the message, show it, and say plainly that it wasn't sent.

**If Notion can't be reached** — the queries fail, or return nothing because the user is a
workspace guest — **build the digest from the context repo's `notion/` mirror instead**
(`actions.json`, `open-questions.json`, and whatever else the project mirrors). It is read-only
work, so it still produces a real digest — but **say in the message that it came from the mirror
and give its `syncedOn` date**, because recipients will otherwise read it as this morning's state.
Watch items are excluded from the mirror, so the 👀 bucket will be empty: say so rather than
letting it imply nothing is being watched.

## 1. Pull the data (read-only)

Three queries against the databases the project declares in `state.notion.databases` — property
names from `schemas`:

- **`actions`** — everything not done, **including `Watching` rows** (they become the 👀 bucket):
  title, status, owner, due date, url.
- **`openQuestions`** — everything not closed: question, status, who's chasing, url.
- **`stakeholders`** — only rows that have both an owner and a pending next action: name, owner,
  next action, engagement stage, last contacted, url. Skip this one entirely if the project
  declares no such database — the digest simply has no 🤝 bucket.

## 2. Build the message with the script — don't format it by hand

Grouping by owner, the overdue / due-this-week cut-off, `@`-mention rendering and the 5000-character
split are fixed rules. They live in `person-digest.mjs` so the digest comes out identical every
week and nobody's row is quietly dropped.

Write the result sets to one JSON file, then run it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/person-digest.mjs" digest.json --title "[project name]"
```

```json
{
  "actions":      [{ "url": "", "task": "", "status": "", "owner": ["user://uuid"], "due": "YYYY-MM-DD" }],
  "questions":    [{ "url": "", "question": "", "status": "", "chasing": ["user://uuid"] }],
  "stakeholders": [{ "url": "", "name": "", "owner": ["user://uuid"], "nextAction": "", "stage": "", "lastContacted": "YYYY-MM-DD" }]
}
```

Transcribe the query results into that shape exactly — `null` for anything absent. The script
filters done / closed / no-next-action rows, buckets each person into ⏰ overdue-or-due-this-week,
✅ other open, 👀 watching (flagging any whose next check is due), ❓ questions and 🤝
relationships, adds an **Unassigned** section, and drops empty buckets and empty people. Output is
standard Markdown — what the Slack send tools expect, *not* Slack mrkdwn. Messages are separated by
a `---MESSAGE---` line; post each separately.

`--title` puts the project's name in the header (take it from `context.json`); omit it and the
header is just "who's got what". `--today YYYY-MM-DD` only to reproduce a past run.

**Your judgement, not the script's:** whether a bucket needs a human sentence of context, whether
an odd-looking row should be checked before it goes out to the team, and whether the digest is
worth sending at all this week.

## 3. Post it

1. **Channel** — `defaults.slackChannel` from the project's config; resolve its ID and pass it as
   `channel_id`. To preview by DM, pass a **user ID** as `channel_id` instead.
2. If the user hasn't seen the text, show it first — or send it as a draft where that exists.
3. Report what was posted and where, with the returned message link.

## Notes

- **Read-only on Notion.** This skill never edits a row.
- Watch items are surfaced here but **rolled or converted by `check-watchlist`** — don't act on
  them from this skill.
- If someone appears as "Unknown owner", their Notion ID is missing from `state.notion.people`;
  if they appear by plain name rather than an `@`-mention, it's their `slackMemberId` that's
  missing. Both are one-line fixes to `context.json` worth mentioning.

**Not this skill:** nudging one person about the pending queue is `notify-pending`. Triaging the
actions themselves is context-notion's `update-action`.
