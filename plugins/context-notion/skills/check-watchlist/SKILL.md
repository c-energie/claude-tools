---
name: check-watchlist
description: Review the "watch until it opens" items in the project's Notion actions database (Status = Watching) — walk the ones due, roll their next-check date on, or convert one into a real action when the thing finally opens. Also adds new watch items. Triggers like "check the watchlist", "run my weekly watch review", "anything to look at this week", "remind me to check X weekly", "add a watch item".
---

# Watch-list (watch-until-it-opens reminders)

Some things aren't actionable yet — a funding round not open, an event not taking registrations,
a report not published. You don't want them cluttering the real to-do list, but you do want a
recurring nudge to re-check until they open. These live in the project's **actions** database as
**watch items**. This skill both adds them and reviews them. **Read `notion-config` first.**

**This skill cannot fall back to the `notion/` mirror.** The mirror deliberately excludes
`Watching` rows — they are reminders, not work, and listed beside real actions they read as a
pile of overdue tasks. So an empty or failed Notion query here means **stop and say the
connection is needed**; it does not mean the watch list is empty. Never answer "nothing to check
this week" from a connection that isn't working. New watch items can be queued with `add-pending`
(an action, with a note that it is a watch item) for someone to convert later.

**Never do date arithmetic in your head.** Every date below comes from the script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" today            # -> 2026-08-07
node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" add weekly       # today + 7d
node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" add fortnightly  # +14d  (also: monthly, quarterly, "[n]d")
```

## What a watch item is

A row in `databases.actions` with:

- **Status = `Watching`** — the marker, mutually exclusive with the live-task statuses, so watch
  items stay off the real to-do list. **`Watching` must be an option in `schemas.actions`'s status
  property**; if the project's schema has no such option, say so and offer either to use the
  project's nearest equivalent or to add the option in Notion — don't invent a status value.
- **Title** — phrased as a check, e.g. `Watch: [funding round] — is it open?`.
- **Due date** — reused as the **next-check date**.
- Page **body** holds the detail (template below), since an actions database rarely has a notes
  property.

Body template — write it on create, and append a line to the check log at each review:

```
**Watching** — recurring check until this opens; not yet actionable.
- **Source:** [url or where to look]
- **Cadence:** weekly            (or: fortnightly / monthly)
- **Watch until:** YYYY-MM-DD    (optional — flag to drop if still nothing by then)
- **Why:** [what opens, and what to do when it does]

**Check log**
- YYYY-MM-DD — created; next check YYYY-MM-DD
```

## Mode A — add a watch item

Triggers: "remind me to check X weekly", "add a watch item", "watch this round".

1. Gather: what to check, where (link), cadence (default **weekly**), optional watch-until, why.
2. Get the next-check date from `dates.mjs add [cadence]`.
3. Create the page in the actions database — `pageParents.actions` as the parent (see
   `notion-config` on the two ids) — with the status set to `Watching`, the title as
   `Watch: [thing]`, the due date property in the calling tool's date shape (`notion-config` —
   it differs per tool), and the body template. Owner from the roster only; unspecified → the
   user, or omit it.
4. Report the new page URL and the next-check date.

## Mode B — review (the default)

1. **Query the whole watch board** — due and not-yet-due together, so nothing stays hidden:
   every row in `databases.actions` whose status is `Watching`, sorted by the due date.
2. **Split due from not-due with the script**, rather than comparing dates by eye:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/triage.mjs" watch.json --watching
   ```

   `watch.json` is a JSON array of `{url, task, status, owner, due}`. The output is "👀 Due to
   check now" and "🔭 Watching (not due yet)", already sorted — show it as-is.
3. For each **due** watch: fetch the page and show its **Source** link, **Why**, **Watch until**
   and check log. The user looks at the source and says what they found.
4. Apply the outcome — update the properties, and append the check-log line to the body. Next
   check dates come from `dates.mjs add [its cadence]`:
   - **Still closed** → keep the status at `Watching`; set the due date to the new date; append
     `[today] — still closed; next check [date]`.
   - **Now open** → convert it to a real action: set the status to the project's "not started"
     option (that alone leaves the watch set), rename the title to the real action, set the due
     date to the real deadline, append `[today] — opened; converted to action`. Call this out in
     the report.
   - **Watch-until passed and still nothing** → flag it; ask whether to drop it (the project's
     "done" status) or keep rolling.
5. Report: what was rolled (with new dates), what converted, what was flagged or dropped.

## Notes

- In the project's own Notion views, hide `Watching` from the live to-do list and keep a separate
  view filtered to it as the watch board.
- `update-action`'s triage deliberately excludes `Watching` rows — this skill owns them.
- `weekly-review` is the runner that reminds you to run this each week.

**Not this skill:** ordinary actions — creating them is `add-action`, changing or triaging them is
`update-action`.
