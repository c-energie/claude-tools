---
name: capture-project
description: Capture an external project into the project's Notion register of tracked projects — from a URL or a name — cross-referencing public sources, checking for duplicates first, and linking the organisations involved back to the stakeholders database. Triggers like "add this project to Notion", "capture this trial", "log this funded project", "what's in related projects".
---

# Capture an external project into the register

Turns a URL or a name — usually pasted into a chat — into a row in the project's register of
**external projects it tracks**, enriched and linked, without inventing anything. Requires the
project's Notion connection and web access. **Read `notion-config` first.**

**Targets:** `databases.relatedProjects` (whichever key the project declares for that register)
and, as the target of its "organisations involved" relation, `databases.stakeholders`. If the
project declares no such register, say which key is missing from `context.json` rather than
picking a database by search.

**Confirm the schema before the first write of a session** — read `schemas.relatedProjects`, and
fetch the database itself if the config looks older than the workspace. Follow the property names
exactly; don't assume properties the schema doesn't show.

## Steps

1. **Check for a duplicate first — by querying, not from memory.** Pull the current names and
   check the new one against them, **including any acronym or alias**: a project is as likely to
   be filed under its acronym as its full title. If it's already there, show the existing row and
   offer to **update** it — a new phase, new partners, published results — rather than creating a
   second row. Staged programmes announce each phase separately; that is one row, updated.

2. **Research it.** Fetch the URL the user gave, then corroborate from the **primary** sources: the
   funder's or programme's own project page, the lead organisation's pages for it, a partner's
   page. Prefer those over a news write-up, which is the single most common source of a wrong award
   size. Pull out: what it actually does, lead and partner organisations, funder, award size, phase
   and dates, and what has been published.

3. **Draft the row** against the schema's properties. Typically:
   - **Name** — the official one. Note an acronym only if the project is commonly known by it.
   - **Description** — two or three factual sentences: the problem, the approach, the phase.
   - **Area of relevance** — a short phrase in the register's existing idiom (match the neighbours).
   - **Funder** / **award size** — only from a source that states them. **Leave blank if unstated**
     — a wrong award size is worse than an empty field.
   - **Link** — the canonical project page, not a news article.
   - **Why we track it** — how it bears on this project's own work: prior art, a competitor's
     approach, a route in via a partner, a template for a bid. Say plainly if it is genuinely close
     to what the project does — that is the point of tracking these, and it may be worth an
     `add-open-question` or a `log-decision` on positioning.

4. **Resolve the organisations-involved relation.** Match each named organisation to an existing
   stakeholders row. Beware acronym-vs-full-name duplicates (`NGED` ↔ `National Grid Electricity
   Distribution`) — link the survivor and flag the duplicate for `tidy-stakeholders`, which owns
   merges. For an organisation not yet there, create a **name-only row** (the normal intake
   pattern) and say you did. **Don't enrich it here** — that is `tidy-stakeholders`' job, and doing
   both invents two versions of the same rule.

5. **Present the draft and get confirmation before writing.** This edits live Notion and infers
   from the web.

6. **Create the page** — `pageParents.relatedProjects` as the parent (see `notion-config` on the
   two ids) — then report the URL, which organisations were linked, which were newly created as
   name-only rows, and the sources used.

## Rules

- **Never invent** a funder, award size, date or partner list. Cite a source URL per non-obvious
  field in the change summary; leave unknowns blank.
- **Projects only.** A consultancy, operator or vendor is a *stakeholder* — if the thing turns out
  not to be a funded project or trial, say so and offer to add it to the stakeholders database
  instead.
- The connection has **no delete tool**. A mis-created row must be removed by hand in the Notion
  UI — flag it, don't claim to have deleted anything. This is why step 5's confirmation is not
  optional.
- If it is something the project might bid into or partner on rather than just watch, offer
  `check-watchlist` (a watch item until the round opens) or `add-action`.
- **If Notion can't be reached** — the write fails, or the duplicate query comes back empty because
  the user is a workspace guest — **use `add-pending`** rather than retrying. A name and the URL is
  enough; `tidy-projects` researches it after transfer. Do step 1's duplicate check against the
  context repo's `notion/related-projects.md` mirror instead: an empty Notion query is **not** proof
  the project is new, and that is how duplicates get created in the first place.

**Not this skill:** enriching or de-duplicating rows already in the register is `tidy-projects`.
