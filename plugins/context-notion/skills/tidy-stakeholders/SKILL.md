---
name: tidy-stakeholders
description: Enrich and tidy the project's Notion stakeholders database. People drop in just a name; run this periodically to fill each row in from public sources and flag structural issues (missing types, duplicates, misfiled projects, contact details in the wrong field). Proposes a batch and asks before writing. Triggers like "tidy the stakeholders", "fill in the new stakeholders", "clean up the stakeholder db".
---

# Tidy the stakeholders database

Rows arrive with **just a name**. This skill walks those (or all) rows, **enriches each from
public sources**, and **flags the structural issues** below. It edits live Notion, so it
**proposes a batch and gets confirmation before writing**. Requires the project's Notion
connection and web access. **Read `notion-config` first.**

**Target:** `databases.stakeholders` (whichever key the project declares for its people and
organisations register). Its sibling register of external projects — `databases.relatedProjects`
where the project has one — is `tidy-projects`, and is where issue 5 below sends a row.

**Work from the live schema, not from memory.** Read `schemas.stakeholders` before the first
write, and follow the property names exactly, trailing spaces and odd spellings included. This
skill writes to nearly every field, so a guessed property name writes into nothing, silently.

## Enrich each sparse / name-only row

Look the entity up online — its own site, professional profiles, the companies register, the
relevant funder or regulator's pages, news — and propose values for the empty properties the
schema defines. Typically: what kind of entity it is (person vs organisation), its category, a
one-line factual "what they do", contact details, a link, and why the project tracks it.

- **Never invent.** Cite the source URL in the change summary. Leave a field blank when unsure
  rather than guessing.
- Don't overwrite a non-empty field unless it is clearly wrong — and say why when it is.

## Flag these structural issues (propose; some can't be auto-fixed — see below)

1. **Missing entity type** — the property that separates a person from an organisation. Note the
   trap in `list-people`: the category property is a *different* one that sounds similar.
2. **Missing category.**
3. **Duplicates** — acronym vs full name (`NGED` ↔ `National Grid Electricity Distribution`).
   Merging means **repointing every relation into the loser at the survivor first**, then deleting
   the loser. Prefer the full name and note the acronym alongside it.
4. **Contact details in the wrong field** — an email or a named person dumped in a free-text
   description. Move emails to the contact property; propose promoting a named person to their own
   individual row, linked by whatever relation the schema provides.
5. **A project misfiled as a stakeholder** — a funded project or consortium (it has a funder, a
   grant, member organisations) belongs in the project register, not here. Propose creating it
   there and flag this row for deletion.
6. **Orphaned relations** — links to deleted pages. Propose clearing what can't be repointed.
7. **Overlapping or redundant fields** — two properties expressing the same judgement (a
   priority *and* a relevance select, say). Note the redundancy rather than filling noise into
   both.

## Deletion limitation — IMPORTANT

The Notion connection exposes **no archive or delete tool** — only create, update and query. So
for **merges, misfiled rows and orphans: FLAG them for the user to delete in the Notion UI** — do
not claim to have deleted them. Enrichment and relation edits are ordinary property updates and
can be applied directly, after confirmation.

## Workflow

1. **Scope.** Default to rows that are name-only or missing the entity type; accept "tidy all", a
   specific list, "added since [date]", or the set of rows a `process-pending` run just created.
2. For each row in scope: fetch it, look it up online, and build a proposed change set plus issue
   flags.
3. **Present the batch and ask for confirmation** before writing.
4. Apply the approved edits. For deletions and merges, output a clear manual to-do list.
5. Report: what was filled and from which source, what was flagged, and what needs manual
   deletion.

**If Notion can't be reached** — the query fails, or returns nothing because the user is a
workspace guest — you can still **read the Notion mirror's `stakeholders.md`** (folder per `notion-config` §4) and
report which rows are sparse or look duplicated, as a snapshot with its `syncedOn` date. **You
cannot apply anything**: no enrichment, no relation edits. Hand the list to someone with a working
connection rather than describing changes as made.

**Not this skill:** the same job on the project register is `tidy-projects`. Reading the people out
is `list-people`. Rows arriving from the pending queue come via `process-pending`, which
can hand what it created straight to this skill — so "tidy the ones that just landed" is a valid
scope.
