---
name: weekly-roundup
description: Post the week's roundup to the project's Slack channel — the watch-list, overdue and due actions, decisions due to revisit, housekeeping flags and the last meeting, gathered from a weekly-review run. Triggers like "post the weekly roundup", "send the weekly review to Slack", "put this week's summary in the channel", "share the weekly review with the team".
disable-model-invocation: true
---

# Weekly roundup → Slack

The **team-facing** write-up of a `weekly-review` run: one post, organised by category, telling
everyone what the week left behind. Run it after `weekly-review` has walked its list, so the
roundup reports what that run actually found. **Read `slack-config` first.**

This is not the same artefact as `person-slack-digest`, and both can go out in the same week.
The digest answers *"what is on my plate"* — grouped by person, actions only. The roundup answers
*"where is the project"* — grouped by category, and it carries the things no per-person view can
know: a stale mirror, a pending queue nobody drained, what the last meeting decided.

## 1. Resolve the channel

The purpose key is **`weeklyRoundup`**: `defaults.slackChannels.weeklyRoundup` →
`defaults.slackChannel` → ask. A project that splits its streams sends other things elsewhere, so
do not reach for whichever channel the config names first.

## 2. Get the section headings — do not type them from memory

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/slack-sections.mjs"
```

**Use the headings exactly as that prints them, icons included.** Five are shared with
`person-digest.mjs` and carry the same meaning in both, so the two posts read as one system;
three are the roundup's own. The header icon goes on the title line.

This is a script rather than a list in this file for a reason: the roundup carried a full icon set
on 29 July and 3 August 2026 and none at all by 11 August, because it was composed freehand every
week with nothing holding its format. **Never invent a section or an icon** — if the week produced
something none of them covers, put it under housekeeping rather than minting a heading.

Omit any section with nothing in it. A roundup of three sections is a fine roundup; padding one
with "nothing to report" lines is what makes people stop reading it.

## 3. Compose it

Header: the project's name, the week, and that it was automated. Then the sections in the order
the script prints them.

- **Lead with what is late or lands this week.** That is what the post is for.
- **Attribute every item to a person** by name, and give the date. An unowned item is worth
  flagging as unowned.
- **Flag, do not fix.** The roundup reports; the skills that own each item change it. If something
  looks superseded, duplicated or wrongly dated, say so and let a human call it — never
  quietly edit a row from here.
- **Housekeeping** is the catch-all for the run's own findings: a pending queue with entries, a
  mirror that has not synced, name-only stakeholder rows, meetings with no write-up.
- **Last meeting** is a short recap of decisions and direction, not a second set of minutes.
- Keep it **standard Markdown** — the send tools convert it. Not Slack mrkdwn.

## 4. Post it

Show the text first and get a yes — this goes to the whole team and cannot be recalled. Then send
it to the resolved channel and report back with the message link. No Slack connection? Show the
text, say plainly that it was **not sent**, and leave it for the user to paste.

**Not this skill:** the per-person "what is on my plate" digest is `person-slack-digest`; nudging
one person about the pending queue is `notify-pending`. Actually running the week's checks is
context-notion's `weekly-review`, which offers this skill at the end.
