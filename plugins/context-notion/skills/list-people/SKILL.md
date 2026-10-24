---
name: list-people
description: List the people a project tracks, from its Notion stakeholders database — the individuals rather than the organisations — filtered by category, organisation or engagement stage. Triggers like "who are the people we're tracking", "list our stakeholders", "show the individuals", "who do we know at [org]".
---

# List the people the project tracks

Reads the project's **stakeholders** database and reports the individuals in it. Read-only —
edits belong to `tidy-stakeholders`. **Read `notion-config` first.**

**Which database:** `databases.stakeholders` in the project's config (`notion-config` §1; a project may name
this key differently — use whichever key its config declares for the people/organisation
register). If the project declares no such database, say which key is missing from the config
rather than hunting for a database by search.

> **Not the roster.** `state.notion.people` is the project's *team* — who can own an action. This
> skill is about the *tracked* people: contacts, stakeholders, counterparts. Say which one you
> answered with if there is any chance of confusion.

## The trap most of these databases carry

A stakeholders database usually holds **organisations and individuals in one table**, separated by
a property — and there is usually a *second*, similar-sounding property for the category
(competitor, academia, investor, network operator…). Read `schemas.stakeholders` and use the
property that actually distinguishes a person from an organisation; filtering on the category one
silently returns the wrong set. If the schema makes it ambiguous, say which two properties you're
choosing between and ask.

## Steps

1. Query the stakeholders data source, filtered to individuals per the property above. If the
   project's Notion has a ready-made "people" view, that view is the better route — it already
   encodes the filter.
2. Apply any extra filter the user asked for:
   - **By category** — the category multi-select (e.g. investor, academia).
   - **By organisation** — the relation to the org row, or the org's own "people" relation.
   - **Who to chase** — engagement stage, sorted by last-contacted or priority, where the schema
     has them.
3. Report concisely: **Name — what they do — category — engagement stage**, with the page URL.
   Summarise; don't dump every property unless asked.
4. If several rows are name-only or obviously stale, mention `tidy-stakeholders` rather than
   filling them in from here.

**If Notion can't be reached** — the query fails, or returns nothing because the user is a
workspace guest — **answer from the project's Notion mirror instead** (its `stakeholders.md`; folder and
procedure in `notion-config` §4), and say the answer is a snapshot with its `syncedOn` date. The
mirror splits organisations from individuals for you. This is the single most likely question to
be asked by someone whose connector doesn't work, and "we aren't tracking anyone" is the wrong
answer to give them.

**Not this skill:** enriching or de-duplicating those rows is `tidy-stakeholders`; the team roster
lives in the config, not in a database.
