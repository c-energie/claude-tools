---
name: weekly-review
description: The weekly runner — a maintained checklist of the recurring skills to run at the start or end of each week (outstanding-queue count, pending queue, watch-list review, action triage, decisions due to revisit, periodic tidy-ups, mirror sync). Run when the user says "weekly review", "start of week", "end of week", "what do I need to run this week", or "run my weekly skills".
---

# Weekly review — run these each week

Nothing here is scheduled, so the weekly cadence is manual: run this skill at the start or end of
each week. It walks the recurring skills and offers to run each. Requires the project's Notion
connection for most items. **Read `notion-config` first.**

Work through the list in order. For each item: say what it's for, and **offer to run it now**
(invoke the named skill); skip on the user's say-so. Get the date from
`node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" today`.

Several items write outside Notion — the shared context repo — and are `disable-model-invocation:
true`, so they never fire on their own. Offering them here, and the user saying yes, is exactly
how they are meant to run.

**Skip what the project doesn't have.** A project with no stakeholders database has no
`tidy-stakeholders` step; one with no mirror has no sync. Say what you skipped and why, rather
than reporting a full run.

## The weekly list

0. **`refresh-context`** (context-kit-core) — re-pull the context repo before anything else. Items
   1 and 8 read and write that checkout, and a session left open (or one whose start-of-session
   load warned it was stale) works from a copy that predates whatever was pushed this week. Cheap,
   read-only, and it says in a line if nothing changed. *Always run this, first.*
0b. **`context-status`** (context-kit-core) — count what has built up across the context ladder:
   lessons awaiting a sweep, sweeps awaiting distillation, undrained handoff items, curation lag,
   native memory. It writes nothing, and it is what makes the judgement calls below evidence-based
   rather than a feeling — item 10 especially, which otherwise gets skipped every week until the
   week it is a big job. Numbered `0b` rather than inserted as `1` so the cross-references in the
   items below keep pointing at what they mean. *Always run this, second.*
1. **`process-pending`** — transfer what was queued in the context repo's `pending/` folder into
   Notion. **First, deliberately:** workspace guests write to the queue instead of to Notion, so
   anything they logged this week is invisible to items 2–4 until this has run. Skip only if the
   queue is empty (the skill says so in a line). *Always run this.*
2. **`check-watchlist`** — review the "watch until it opens" items that are due; roll their
   next-check date on, or convert to a real action when something has opened. *Always run this.*
3. **`update-action` (the triage pass)** — walk everything open in the actions database: overdue,
   due soon, and open-but-undated. It excludes `Watching` rows (item 2 owns those) and batches the
   confirmed edits. *Always run this.*
4. **`query-decisions` (due to revisit)** — check the decision log for rows whose revisit trigger
   has now passed (a date, a milestone, a condition). Surface anything due or overdue and ask
   whether to log a superseding decision or add an action. Usually a quick no-op week to week.
5. **`tidy-stakeholders`** — only if name-only rows have been added since last time. Offer it;
   don't force it weekly. `process-pending` can run it over rows it just created, so a week where
   item 1 did the work needs nothing here.
6. **`tidy-projects`** — the same, for the external-projects register.
7. **`synthesise-meeting`** — catch up any meeting that happened and isn't written up yet. **Pass
   it a scope word** so the sweep matches when you are running this: `this week` at the end of a
   week, `last week` at the start of the next one. A scope is a hard window, so if the run
   straddles a weekend, check both rather than assuming one covered it.
8. **`sync-notion-mirror`** — refresh the read-only copy of the Notion databases in the context
   repo's `notion/`. **Run it after items 1–7**, since it is a snapshot of whatever they left
   behind. This is the only way teammates without the Notion connector see any of the week's
   changes, so a skipped week leaves them reading stale rows. *Always run this.*
9. **`person-slack-digest`** (context-slack) — post the per-person "who's got what" summary to the
   project's channel. **After item 8**, so it reflects the week's changes. Needs the context-slack
   plugin and the project's Slack connection; skip the line silently if either is absent. Offer
   it — it never posts unprompted.
9b. **`weekly-roundup`** (context-slack) — post the team-facing roundup of *this* run: what is
   late, what lands this week, decisions due to revisit, the housekeeping flags items 0b–8 turned
   up, and the last meeting. Same plugin and connection as item 9, same silent skip, same
   never-unprompted rule. **Both can go out in the same week** — the digest tells each person what
   is on their plate, the roundup tells the team where the project is. This one reports the
   findings of the run you have just done, so offer it last, and offer it even if item 9 was
   declined.
10. **`curate-context`** (context-kit-core) — only about monthly, or when `threads/` has grown
    unwieldy. Offer it if it hasn't run in a few weeks; skip most weeks. Item 0b prints the two
    numbers that decide it: threads since the last review, and whether `threads/INDEX.md` has
    fallen behind what is on disk.

## Keeping the list current

This checklist is the single source of truth for "what runs weekly". When a new recurring skill is
added, add a line here — a recurring skill missing from this list simply never runs. To change an
item's cadence, note it on the line (e.g. "monthly").

**Not this skill:** each item's actual work belongs to the skill named on its line; this one only
sequences them.
