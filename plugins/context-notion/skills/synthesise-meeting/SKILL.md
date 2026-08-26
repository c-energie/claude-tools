---
name: synthesise-meeting
description: Synthesise a meeting into the context repo's meetings/ folder from its Notion page and its transcript, then log the core decisions, actions and open questions to the project's Notion databases; can also run as a sweep to catch up every past meeting missing a summary, optionally bounded by a scope word such as today, yesterday, this week or last week. Triggers like "synthesise the weekly sync", "write up the stakeholder meeting", "summarise Monday's working session", "catch up any meetings missing a summary", "synthesise last week's meetings", "write up this week's meetings".
---

# Synthesise a meeting

Turns a meeting into a `meetings/` writeup in the project's context repo and logs its decisions /
actions / open questions to Notion. **Read `notion-config` first** — the meetings database, the
roster and every property name come from the project's `context.json`.

Needs the project's Notion connection, and its file-storage connector (Google Drive or
equivalent) for meetings that were recorded. **Not every meeting is recorded, and that's normal**
— see step 2.

## There are two sources, and neither is guaranteed to be present

A meeting leaves traces in up to two places:

- the **Notion meeting page** — often just an agenda, because the notes field only gets filled in
  when someone remembers during the meeting;
- a **transcript** (`.vtt`) in the project's file storage — the full record, when the meeting was
  recorded and a transcript was actually produced.

**Either one alone is enough to write up.** There doesn't need to be both — a transcript with a
blank Notion page, or solid Notion notes with no transcript, are both normal, complete inputs.
Only the combination of an empty page *and* no transcript found means there is nothing yet to
synthesise.

**A blank Notion page is not evidence that there is nothing to write up.** This is the failure
this skill exists to prevent, and it has happened: a meeting page was completely empty and was
nearly reported as "nothing to synthesise" while a 99 KB transcript of that very conversation sat
in Drive. **Always check both before concluding a meeting cannot be written up.**

**This skill cannot fall back to the `notion/` mirror.** Meeting pages exist only in Notion. If
the connection fails or returns nothing (a workspace guest gets empty results, not an error),
**stop and say the connection is needed.** Don't write up a meeting from memory or from a
`threads/` file and present it as the synthesis. Decisions and actions that came out of the
meeting can still be captured with `add-pending`.

## 1. Identify the meeting(s), and check each isn't already done

The user names it however they like — a type ("the weekly sync"), a date ("Monday's"), a name, an
attendee — when they mean a **single** meeting. Find the matching page in `databases.meetings`. If
the project declares no meetings database, say which key is missing rather than searching for one.

- Search by type / name / topic, then fetch the chosen page.
- Default to the **most recent** match; if ambiguous, confirm the date with the user.
- Note the page's **name**, **date** and **URL** (the URL is needed for the relations below).

**Or there's no single meeting to point at — the ask is general.** "Catch up the meetings",
"synthesise anything missing a summary", "which meetings haven't been written up" all mean run
this as a **sweep** instead of a single lookup — as does a bare **scope word** (`today`,
`yesterday`, `this week`, `last week`), which bounds the sweep rather than naming one meeting:

1. Query `databases.meetings` for pages dated **on or before today** — excluding future
   placeholders (see the date check below) and page templates.
2. **Bound the sweep.** If the ask carried a **scope word**, resolve it with `dates.mjs range`
   (below) and treat the result as a **hard** window. With no scope, default to roughly the
   **last two months** of past meetings rather than the whole database's history, and widen only
   if the user asks for further back. **Either way, say which window you used** — a sweep that
   doesn't name its window can't be told from one that found nothing.
3. Apply the **duplicate check** below to every candidate; drop anything that already has a
   `## Summary`.
4. For each survivor, work out whether there's anything to synthesise from: non-trivial content
   on the Notion page (more than a bare agenda/template scaffold), and/or — per step 2 — a
   transcript found in its ±3 day window. A meeting with **neither** goes on a separate skip list
   with a reason; don't drop it silently, and don't invent content to fill it.
5. **Show both lists — what will be synthesised, and what's being skipped and why — and get a yes
   before writing anything.** A sweep touches several Notion pages and databases in one pass; the
   user should see the scope before any of it happens.
6. Once confirmed, work through the synthesise list **one meeting at a time**, running steps 2–7
   in full for each, in date order. Keep every meeting's writeup and logged items separate — never
   merge two meetings into one entry, even if they're thin.
7. Finish with the roll-up described in step 7.

### Scoping the sweep

`today`, `yesterday`, `this week` and `last week` are the words people actually use for this.
**Never work the dates out by hand** — a hand-counted week is wrong about as often as it's right,
and the error is invisible in the output, because a window that silently started on the wrong day
still returns meetings:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" range last-week
# {"scope":"last-week","from":"2026-08-17","to":"2026-08-21"}
```

It takes the spaced or hyphenated spelling, and `--from YYYY-MM-DD` to pin the run. The rules it
encodes, each of which changes what you report back:

- **A week is Monday to Friday.** `this week` runs Monday to today, capped at Friday; `last week`
  is the previous Monday to the previous Friday. Sunday belongs to the week that began the Monday
  before it, so `last week` read on a Sunday is the week before the one just ending.
- **Weekend dates fall inside no week scope.** That's deliberate, but it means a Saturday meeting
  is unreachable by `this week` or `last week`. If the database holds one just outside the window,
  **name it and say it fell outside the scope** rather than dropping it silently — "no meetings
  that week" and "one I couldn't see" read identically otherwise.
- **An explicit scope is a hard bound. Never widen it.** If nothing falls inside, say the window
  was empty and stop. Only the two-month default widens, and only when asked. A scoped run that
  quietly reaches further back answers a question the user didn't ask.
- **A scope relaxes nothing else.** The date check, the page templates, the duplicates and the
  already-has-a-`## Summary` guard all still apply inside the window.
- **The clock is worth one sanity check.** `dates.mjs` reads the machine's date; if the backend's
  own timestamps disagree with it, say so rather than picking one silently — a day's drift turns a
  past meeting into a "future placeholder" and drops it from the sweep unnoticed.

**Check the date property, not just the ordering.** A meetings database holds *future* meetings —
recurring syncs are created with their agenda days ahead. A meeting dated later than today has not
happened: say so rather than writing up an agenda as though it were an outcome. Skip the
database's **page templates**, which list as pages but are not meetings, and watch for **duplicate
pages for one slot** — a real state worth reporting.

**Cross-reference before doing any work: has this meeting already been synthesised?** Fetch the
page's content, not just its properties, and look for an existing `## Summary` section (written
back in step 5). If one is already there — or the decisions / actions / open questions this
meeting would produce are already present in their Notion databases with this meeting's relation
set — this meeting is already done. Report that plainly and **stop** (or, in a sweep, drop it from
the list and move on): don't re-run steps 2–6, and don't re-log the same items a second time. This
guard matters most on an unattended or scheduled run, where there's no one to notice a duplicate
before it lands in Notion.

If the user explicitly asks to redo a meeting that already has a summary (a transcript arrived
late, the first pass was thin), that's a deliberate exception: say the existing Summary is being
treated as stale and will be overwritten, and proceed.

## 2. Find the transcript

Do this **for every meeting**, including — especially — ones whose Notion page looks empty.

Where they live: the folder the project declares (`state.notion.defaults.transcriptFolderId`, if
it has one), through the file connector named in `connections`. Search by **date-prefixed title**
as well as by folder, so a transcript filed elsewhere is still found.

Matching rules, each of which exists because the obvious approach fails:

- **Search a window of ±3 days around the meeting date, never the exact date.** The transcript is
  named for when it was *recorded or uploaded*, which is often not the meeting's date. Real
  example: a meeting dated the 28th whose transcript is `2026-07-29-Bid-change.vtt`. An exact-date
  match finds nothing.
- **Do not rely on the title naming the meeting.** When the title is unhelpful, read the opening
  of the transcript and match on **who is speaking and what they discuss**.
- **The `.vtt` extension may or may not be in the title.** Filter on the MIME type (`text/vtt`),
  not on the title's ending.
- **A near-date match is a candidate, not a fact.** If a transcript is plausible but not certain,
  say which file you matched and why, and let the user confirm before writing anything up from it.

**No transcript found is a normal, common outcome, not a blocker.** Plenty of meetings are never
recorded, or the recording never gets a transcript. If the connector is reachable but nothing
falls inside the ±3 day window, don't stop and don't wait for one to appear later — continue to
step 3 on the Notion notes alone, exactly as when the connector itself is unavailable (below).
The only time this is a real problem is when the Notion page is *also* empty; see step 1.

**Always convert the `.vtt` to plain text before reading it — never read the raw VTT.** Raw VTT is
~3x the words spoken (cue IDs, timestamps, markup), so an hour-long meeting overflows the
tool-result limit; the Drive read tool also backslash-escapes the markup, which defeats naive
parsing. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/vtt-to-text.mjs" [saved tool-result or .vtt] --out [txt path]
```

It handles both raw `.vtt` and a saved tool-result JSON (`{fileContent}`), strips the cue
machinery, merges consecutive same-speaker turns and writes `Speaker: words` at roughly a third of
the size — then read *that*, in chunks if long. The one-line summary names the speaker labels it
saw: **compare them against the expected attendees before trusting any attribution.** Fewer labels
than attendees means shared mics or collapsed diarisation (both have happened — four voices
collapsed into two labels; two people sharing a mic, folding their speech into other turns). Say
so in the writeup and attribute only where context makes the speaker clear.

If the file connector is unavailable, say so and continue from the Notion notes alone — but
**label the writeup as notes-only**, because a later reader otherwise cannot tell a thin meeting
from a thin record of a full one. Treat "connector unavailable" and "connector fine, nothing
found" the same way from here on: both mean notes-only, just say which one it was.

## 3. Synthesise

Concise markdown for a reader with **no prior context** (spell out acronyms once). Use whichever
sections apply — omit any with nothing in them: `## Summary`, `## Decisions`, `## Actions` (as
`Owner — task — due date`), `## Open questions`, `## Risks & blockers`, `## Notable discussion`.

**Do NOT invent content.** If the notes are thin, keep it thin. Not every meeting has decisions or
actions — a stakeholder meeting may be mostly summary and notable discussion.

**Working from a transcript changes what care is needed.** A `.vtt` is raw speech: people think
aloud, contradict themselves, and abandon half the ideas they raise. Treat a thing as decided only
where the conversation actually converged — an idea floated once and dropped is notable discussion
at most, and usually nothing. Attribute an action to someone only if they accepted it, not merely
because their name was said near it. Automatic transcription also mangles names and technical
terms, so check anything you are about to write down as a fact against the roster or the Notion
databases, and never quote at length: these are recordings of real people, and the writeup is a
synthesis, not a record of who said what.

**Classify carefully — this governs what gets logged in step 6:**

- **Decision** = a settled choice of *direction or approach*. Log only the **core, load-bearing**
  ones: something a colleague needs to know in order to act correctly, independent of the
  reasoning. Rationale and "why we chose X" belong in the writeup or a thread, not the log.
- **Action** = something someone will *do*, with an owner. **"Do X by next week" is an action, not
  a decision** — even if agreeing to it felt like one. Method details are usually part of an
  action, not a standalone decision.
- **Open question** = a genuine **core** unknown worth tracking and sharing. **Most meetings
  produce none — do not manufacture them.** An empty list is the normal result.

The writeup can hold the finer detail; Notion should hold only the core items.

## 4. Write to the context repo's meetings/ folder

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --writable)"
```

Write `meetings/YYYY-MM-DD-[slug].md` (date = the meeting's date; slug = a short kebab of the type
or name). **Follow the repo's own house rules** — read its `templates/` and `taxonomy.yml` where
they exist; they win over the defaults here. Typical front-matter:

```
---
id: 2026-07-27-weekly-sync
title: Weekly sync — 27 July 2026
type: meeting
status: settled
date: 2026-07-27
attendees: [handle]
topics: [funding]
notion_ids: ["paste the meeting page URL"]
transcript: "link to the transcript, or omit"
---

# [date] — [meeting name] synthesis

_Synthesised on [today] from the "[meeting name]" Notion note and its transcript. Edit freely._
```

Name the sources honestly in that line — "Notion note and its transcript", "transcript only, the
Notion page was empty", or "Notion notes only, no transcript found". It is the one place a later
reader can tell how complete the record behind the writeup was.

Front-matter rules:

- `id` = the filename without `.md`. Stable; never change it, even if the file is renamed.
- `status` = `settled` — a meeting writeup is finished when written.
- `topics` **must** already exist in the repo's `taxonomy.yml` where it has one. Use the closest
  existing tag and tell the user which one they might want to add — **never invent a tag inline.**
- `attendees` uses the same short handles as elsewhere in the repo. Omit external people; they
  belong in the stakeholders database.
- `notion_ids` links the repo → Notion in **one direction only**. Never hand-write the reverse
  link back into Notion.
- `transcript`: the view URL of the file found in step 2. Omit the key entirely rather than
  writing a placeholder. Raw transcripts stay in the file store — **never commit a `.vtt` to the
  context repo** (they hold third-party personal data that must stay deletable, and they crowd out
  synthesised notes in retrieval).
- Do **not** add `last_updated` or `author` — git already knows.
- **No angle brackets in any front-matter value**; use `[…]` or `{…}`.

Ask before committing and pushing, then report the path. In a sweep, this can be one ask covering
the whole batch (step 1.5) rather than one per file.

## 5. Write the summary back to the meeting page

The meeting note itself is usually just the agenda. Append the **summary** to the meeting page so
it lives with the note, not only in the repo, plus a one-line pointer to the `meetings/` file for
the full writeup. The decisions / actions / questions go to their own databases in step 6, not
duplicated here.

This step matters most for a meeting whose page was blank: it is what stops the next person
concluding the meeting was never recorded. It is also what step 1's duplicate check looks for on
the next run — an untitled or missing `## Summary` heading is read as "not yet synthesised", so
use that heading exactly.

## 6. Log to the Notion databases

Show the extracted **decisions / actions / open questions** and confirm the list (and owners)
before creating anything. Log **only the core items**, and skip anything already recorded. Set the
meeting relation on each, so items link back to this meeting.

**Fill the structured properties — never stuff owner, date or status into the title text.** The
title is the decision / task / question itself.

- **Decisions** → follow `log-decision` (`databases.decisionLog`), each with a short body
  (what was decided, and why).
- **Actions** → follow `add-action` (`databases.actions`), owner from the roster, due date as
  `start` + `is_datetime` = `0`.
- **Open questions** → follow `add-open-question` (`databases.openQuestions`).

Owners resolve from `state.notion.people` only — never from a workspace search, which is blind to
guests. Omit a person property rather than guessing.

## 7. Report

List the summary added to the meeting page, what was written to `meetings/` (including the topics
used and whether a transcript was linked), and the rows created, with URLs.

State **which sources the synthesis came from**, and name the transcript file if one was used. If
none was found, say so explicitly rather than silently omitting it: "no transcript for this date"
and "I didn't look" read identically in a writeup, and only one of them means the record is
complete.

If step 1's duplicate check stopped a single-meeting run early, report that instead: which
meeting, that it already had a Summary (or already-logged items), and that nothing was re-written.

**For a sweep**, open with **the window it covered and the scope word that produced it** ("last
week, 17–21 August"), then report each synthesised meeting exactly as above, and close with a
one-line roll-up: how many were synthesised, how many already had a summary, and how many were
skipped for lack of source material (name them, so the user can go find or record what's missing
rather than wondering whether the sweep just missed them). Name anything that fell just outside
the window too — see the scoping rules in step 1.

**Not this skill:** a session write-up that isn't a meeting is context-kit-core's `save-thread`.
