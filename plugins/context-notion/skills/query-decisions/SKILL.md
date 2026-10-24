---
name: query-decisions
description: Read and interrogate the project's Notion decision log — what was decided on a topic, what's been decided recently, what looks superseded or contradictory, and what's flagged to revisit. Triggers like "what did we decide about X", "show me recent decisions", "have we already decided this", "anything due to revisit".
---

# Query the decision log

Read-only over the project's **decision log**. **Read `notion-config` first** — config
resolution, guest gap, fallback ladder.

## Source

`databases.decisionLog` from the project's config (`notion-config` §1), queried via the Notion connection.
**An empty result is never "no decisions"** — it is also what a workspace guest sees. Fall
back to the project's Notion mirror if it has one (which folder: `notion-config` §4), and label the answer with
its `syncedOn` date; no mirror and no rows → say the read may be the guest gap.

## Shapes this answers

- **"What did we decide about X?"** — match against titles *and* the notes/rationale
  property; the topic word is often only in the why. Quote the decision, its date, owners,
  and its stated rationale — not just the title.
- **"Recent decisions"** — sort by the schema's date property, newest first, with a one-line
  why each.
- **"Have we already decided this?"** — before a new `log-decision`, look for the same topic
  decided differently; surface both rows rather than silently preferring one.
- **"Anything due to revisit?"** — if the schema has a revisit/review property, list rows
  whose date has passed (compute today with `dates.mjs`, not by hand).

## Rules

- Always state the route: live Notion, or mirror + `syncedOn` date.
- Superseded or contradictory pairs: report them; changing rows is not this skill's job —
  offer `log-decision` to record a superseding decision.

**Not this skill:** writing a decision is `log-decision`.