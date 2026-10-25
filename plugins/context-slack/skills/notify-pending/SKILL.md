---
name: notify-pending
description: Tell whoever drains the project's pending queue, on Slack, that items are waiting in the pending queue (.context/pending/ in the workspace) — the manual fallback for when the routine notification didn't cover it. Triggers like "tell them there's stuff pending", "nudge about the pending queue", "let the owner know I've queued some items".
disable-model-invocation: true
---

# Notify that the pending queue has items

Posts a short Slack message summarising what is waiting in the project's pending queue —
`.context/pending/` in the workspace — for transfer into the project's backend. **Read `slack-config` first.**

**Routine notification is usually not this skill's job.** The repo holding the queue can carry a
GitHub Action that posts on any push touching it, whoever pushed and however the entry was written —
that covers the ordinary case better than an assistant can, because it fires on the push, the
moment the entry becomes visible. Check whether the repo has one before making this a habit.

**What's left for this skill** is the case the Action can't reach:

- the entries are committed but the push isn't happening for a while, and someone needs to know now;
- the notification didn't arrive (a missing webhook secret shows as a warning under the repo's
  Actions tab), and the queue would otherwise sit unread until the weekly review;
- someone wants the queue owner told directly, as a DM, rather than in the channel.

> **Posts to Slack — excluded from automatic invocation** (`disable-model-invocation: true`). It
> runs **only when the user asks for it by name.** `add-pending` does not call it. There is no
> standing authorisation: ask before sending, every time.

## 1. Build the message — don't compose it by hand

```bash
ROOT="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs")"
PENDING="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/layout.mjs" "$ROOT" pending)"
node "${CLAUDE_PLUGIN_ROOT}/scripts/pending-parse.mjs" "$ROOT" --slack --added-by [first name]
```

`workspace.mjs` finds the nearest `.claude/workspace.json` (stderr names
the `route=`); `layout.mjs` says where that root keeps the queue, and `pending-parse.mjs` reads
the same folder by itself — these are copies of context-notion's, so both plugins agree on it.

Prints the message and nothing else. It covers **everything currently in the queue**, not only
what this session added — that is deliberate: it is what the recipient has to act on, and it means
two notifications about the same queue read the same way. It also flags entries that won't
transfer as written, which is exactly the thing worth chasing.

`--added-by` is whoever is at the keyboard, so the recipient knows who to go back to. Omit it if
unclear rather than guessing.

**If the queue is empty, the script says so — then don't send anything.** A notification about
nothing trains people to ignore the next one.

## 2. Check whether it's actually visible yet

```bash
git -C "$ROOT" status -sb -- "$PENDING"
git -C "$ROOT" log --oneline '@{u}..' -- "$PENDING"
```

`$ROOT` is the repo the queue is committed to — the workspace repo in a workspace, the context
repo otherwise — so this is the repo to ask. The check is scoped to the queue on purpose: a
workspace repo also takes threads, memory and meetings, so its branch being `[ahead N]` says
nothing about the queue, and a clean queue behind unrelated local commits is not a reason to
tell anyone to push. If the log prints a commit, or status lists a queue file as modified or
untracked, the entries are **not pushed**, so the recipient cannot see them. If the log fails
because the branch has no upstream, nothing has been pushed at all — treat it the same way. This session may well have no credentials for that repo, so this is common rather
than exceptional.

- Append a line to the message: `_Not pushed yet — [name] still needs to run git push._`
- And tell the user, in your reply, that the push is the step that makes it real.

Never send a message implying the items are there to collect when they are still sitting in a
local commit.

## 3. Send it

**Who:** whoever owns draining the queue for this project — normally the person the user names,
otherwise ask. Take their **`slackMemberId` from the roster** (`state.notion.people`) and pass it
as `channel_id`: a user ID in that field sends a direct message. The roster rules and the
wrong-workspace / wrong-person traps are in `slack-config` — they are the whole risk in this skill.

This is a DM, not the team channel. The queue is one person's job to drain; the team channel
belongs to `person-slack-digest`.

**If the Slack connection isn't available** — likely for exactly the people this skill exists to
serve — **show the message text and say plainly that it was not sent**, so they can paste it or
message the person themselves. Don't treat a missing connector as a failure of the whole job: the
entries are safely queued either way, which is the part that mattered.

## 4. Report

Say what was sent, to whom, and the message link the tool returns. If it wasn't sent, say why in
one line and show the text.

**Not this skill:** the routine "something was queued" message is the queue repo's own GitHub
Action. The team-wide "who's got what" digest is `person-slack-digest`. Writing an entry into the
queue is context-notion's `add-pending`; transferring the queue into Notion is `process-pending`.
