---
name: tidy-projects
description: Enrich and tidy the project's Notion register of external projects — the ones it tracks but doesn't run. Rows arrive as a bare name or a URL; run this periodically to fill each in from the funder's own sources, link the organisations involved back to the stakeholders database, and flag duplicates, dangling relations and rows that aren't really projects. Triggers like "tidy the projects", "fill in the new projects", "clean up related projects".
---

# Tidy the external-projects register

The sibling of `tidy-stakeholders`, for the other half of the pair. Rows arrive sparse — a name
from a conversation, a URL from a chat, a transferred pending-queue entry — and this skill walks
them, **enriches each from public sources** and **flags the structural issues** below. It edits
live Notion, so it **proposes a batch and gets confirmation before writing**. Requires the
project's Notion connection and web access. **Read `notion-config` first.**

**Targets:** `databases.relatedProjects` (whichever key the project declares for the register of
external projects it tracks) and, as the target of its "organisations involved" relation,
`databases.stakeholders`.

**Confirm the schema before the first write of a session** — read `schemas.relatedProjects`, and
fetch the database itself if the config looks older than the workspace. Don't assume properties
beyond what the schema shows.

## Enrich each sparse row

These are **other people's** projects. Go to the sources that actually state the facts, in this
order:

1. The **funder's or programme's own project page** — the register, portal or award listing.
2. The **lead organisation's** own pages for that project.
3. A partner's page.

A news write-up is a last resort and the single most common source of a wrong grant size — prefer
the funder's own page every time.

Propose values for the empty properties the schema defines. Typically: a description of two or
three factual sentences (the problem, the approach, the phase), the area it bears on, the funding
body, the grant size, the canonical link, and **why this project is tracked** — how it bears on
the project's own work (prior art, a competitor's approach, a route in via a partner, a template
for a bid).

- **Never invent.** Cite the source URL per non-obvious field in the change summary. **Leave a
  field blank when unsure** — a wrong grant size is worse than an empty one.
- Don't overwrite a non-empty field unless it is clearly wrong; if it is, say so and why.
- If a tracked project is genuinely close to what this project does, say so plainly — that is the
  point of tracking them, and it may be worth an `add-open-question` or a `log-decision` on
  positioning.

## Flag these structural issues

1. **Organisations-involved relation empty** while the description names organisations — resolve
   each to a stakeholders row and link it. For one that isn't there yet, create a **name-only
   row** (the normal intake pattern) and hand it to `tidy-stakeholders`; **don't enrich it here**.
2. **Dangling relations** — links to stakeholder pages that no longer exist, usually left behind
   by a `tidy-stakeholders` merge. Repoint to the surviving row; propose clearing what can't be
   resolved.
3. **Acronym-vs-full-name duplicates** — the same project filed twice. Prefer the full name with
   the acronym noted alongside, merge the fields into the survivor, flag the loser for deletion.
4. **Phase duplicates** — staged programmes (discovery → alpha → beta) announce each phase
   separately. That is **one row, updated** — new phase, new partners, published results — not a
   second row.
5. **Not a project** — a consultancy, operator, vendor or trade body filed here because it turned
   up in a project context. It is a *stakeholder*: propose moving it and flag this row for
   deletion. (The mirror image of `tidy-stakeholders`' issue 5.)
6. **Link missing, or pointing at a news article** rather than the canonical funder page.
7. **The "why we track it" field empty** — the one that justifies the row existing at all. An
   empty one means nobody can tell why it is in the database; propose a line, or ask whether to
   drop it.
8. **Inconsistent grant-size formatting** — `£1.2m`, `1,200,000`, `1.2 million`. Propose one idiom
   across the database; note which values you could not source at all.

## Deletion limitation — IMPORTANT

The Notion connection exposes **no archive or delete tool** — only create, update and query. For
**merges, misfiled rows and duplicates: FLAG them for the user to delete in the Notion UI.** Do
not claim to have deleted anything. Enrichment and relation edits are ordinary property updates
and can be applied directly, after confirmation.

## Workflow

1. **Scope.** Default to rows that are name-only or missing a description, funder or link. Accept
   "tidy all", a specific list, "added since [date]", or the set of rows a `process-pending` run
   just created.
2. For each row in scope: fetch it, research it, build a proposed change set and issue flags.
3. **Present the batch and ask for confirmation** before writing.
4. Apply the approved edits. For deletions and merges, output a clear manual to-do list.
5. Report: what was filled and from which source, what was flagged, what needs manual deletion,
   and any name-only stakeholder rows created along the way (so `tidy-stakeholders` picks them up).

**Adding a brand-new project row** from a URL or a name is `capture-project` — it owns the
research-and-create path, including the duplicate check. This skill starts from rows that already
exist.

**If Notion can't be reached** — the query fails, or returns nothing because the user is a
workspace guest — you can still **read the Notion mirror's `related-projects.md`** (folder per `notion-config` §4)
and report which rows are sparse, unlinked or duplicated, as a snapshot with its `syncedOn` date.
**You cannot apply anything.** Hand the list to someone with a working connection rather than
describing changes as made.

**Not this skill:** creating a row from a URL or a name is `capture-project`. Tidying the
*organisations* is `tidy-stakeholders`. Transferring queued entries from the pending queue is
`process-pending`.
