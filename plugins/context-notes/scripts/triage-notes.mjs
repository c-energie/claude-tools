#!/usr/bin/env node
// The offline half of a note-triage run: what is this repo configured to do, and where does
// each topic route?
//
//   node triage-notes.mjs config "$ROOT"                       # load, validate, report
//   node triage-notes.mjs config "$ROOT" --json
//   node triage-notes.mjs resolve "$ROOT" --repos repos.json   # ...and route topics against it
//   node triage-notes.mjs resolve "$ROOT" --repos repos.json --topics "dev-hub,IP,claude"
//
// Reads `state.notes` from a context repo's context.json. Contacts nothing, reads no note, and
// writes nothing: every destination belongs to a later issue. Exit 0 = it ran, 1 = it refused
// (unconfigured / opted out / unresolved), 2 = it could not run at all.
//
// THERE IS NO DEFAULT CONFIGURATION, and that is the load-bearing decision. A context repo
// without `state.notes` is UNCONFIGURED, and must never fall back to another project's block —
// a fallback is exactly how one org's notes end up proposed as issues in another org's
// repository. For the same reason the four outcomes below stay four, never three:
//
//   configured    — a `state.notes` block that validates
//   unconfigured  — a context repo with no block. Says so loudly and names the file.
//   opted-out     — `notes` set to the opt-out sentinel. Exits silently; a repo that will never
//                   triage notes must not nag, and "helpfully" configuring an opt-out undoes a
//                   decision somebody made.
//   unresolved    — no context repo at all. Go and link the repo; editing a context.json that
//                   nothing is reading is wasted work.
//
// THERE IS DELIBERATELY NO TOPIC MAP. A topic resolves to a repository when its name equals a
// repository name CHARACTER FOR CHARACTER in one of the declared organisations, and to a thread
// in the resolved context repo otherwise. A map can name a repository that no longer exists; an
// exact match cannot. No aliases, no prefix or suffix matching, no fuzzy matching: `claude` does
// not become `claude-tools`, and a near-miss is never a hit.
//
// THE REPOSITORY LIST IS PASSED IN, never fetched here. Listing repositories is the model's job
// at the start of a run; matching them is this script's, offline and testable. The list carries
// the time it was gathered so that "resolved to a thread" and "resolved to a thread because the
// list was stale" stay distinguishable.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// In step with hooks/load-context.sh, context-repo.sh and context-kit-core's link-context.mjs.
export const OPTOUT = ['none', 'off', 'false', 'no', '-', 'disabled'];
export const VISIBILITIES = ['personal', 'shared'];

// How old a repository list may be before a `thread` outcome is worth attributing to staleness
// rather than to the topic. Not a refusal: a stale list still resolves, it is just reported.
export const REPOS_STALE_HOURS = 24;

// A `_`-prefixed key is a comment, the convention these files already use (`_stakeholdersNote`,
// `_slackChannelsNote`). Validation SKIPS them rather than rejecting unknown keys — otherwise the
// reasoning for a block could not live beside the block it explains.
const isComment = (k) => k.startsWith('_');
const realKeys = (o) => Object.keys(o).filter((k) => !isComment(k));

// ---------------------------------------------------------------- loading

const readJson = (file) => {
  const raw = readFileSync(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
};

/**
 * Load and validate `state.notes` from a context repo.
 *
 * @returns {{status:'configured'|'unconfigured'|'opted-out'|'unresolved', notes?:object,
 *            errors:string[], file:string|null, says:string, fix:string}}
 *
 * The four statuses are the result, not the wording: a caller distinguishes them by `status`
 * and never by parsing a message.
 */
export function loadConfig(root) {
  if (!root) {
    return {
      status: 'unresolved', errors: [], file: null,
      says: 'No context repo resolved for this session, so there is no configuration to read.',
      fix: 'Link this project to its context repo with context-setup, or create one with init-context. Do not edit a context.json until you know which one is being read.',
    };
  }
  const file = join(root, 'context.json');
  if (!existsSync(file)) {
    return {
      status: 'unresolved', errors: [], file,
      says: `A checkout resolved at ${root}, but it has no context.json — it is not a context repo.`,
      fix: 'Run context-doctor against it.',
    };
  }

  let ctx;
  try { ctx = readJson(file); }
  catch (e) {
    return { status: 'unconfigured', errors: [`context.json is not valid JSON (${e.message})`], file,
      says: `${file} does not parse, so nothing could be read from it.`,
      fix: 'Fix the JSON, then re-run.' };
  }

  const state = ctx.state;
  const raw = state && typeof state === 'object' && !Array.isArray(state) ? state.notes : undefined;

  // The opt-out sentinel, spelled the same way it is everywhere else. Silent by design.
  if (typeof raw === 'string' && OPTOUT.includes(raw.trim().toLowerCase())) {
    return { status: 'opted-out', errors: [], file,
      says: `This repo has opted out of note triage (state.notes is "${raw}").`,
      fix: 'Nothing to do. That is a decision, not a gap — do not "fix" it by writing a block.' };
  }

  if (raw === undefined || raw === null) {
    return { status: 'unconfigured', errors: [], file,
      says: `${file} has no state.notes block, so this repo is not configured for note triage.`,
      fix: `Add a "notes" block under "state" in ${file}: a mindPalace (dataSource + database), an ordered organisations list of {owner, visibility}, and sensitiveTerms. There is no default and none will be inferred — falling back to another project's block is how one org's notes end up as issues in another org's repository.` };
  }

  const errors = validate(raw);
  if (errors.length) {
    return { status: 'unconfigured', errors, file,
      says: `${file} has a state.notes block, but it does not validate.`,
      fix: 'Fix each fault named above. Each names the key it is about, so a bad organisation entry is caught here rather than surfacing three steps later as a mysterious thread routing.' };
  }

  return { status: 'configured', notes: raw, errors: [], file,
    says: `Configured from ${file}.`, fix: '' };
}

/**
 * Every fault in a `state.notes` block, each naming the key it is about. Returns [] when valid.
 * Deliberately exhaustive rather than fail-fast: fixing one fault per run is four runs.
 */
export function validate(notes) {
  const errors = [];
  if (typeof notes !== 'object' || notes === null || Array.isArray(notes)) {
    return ['state.notes is not an object'];
  }

  // -- mindPalace
  const mp = notes.mindPalace;
  if (mp === undefined) errors.push('state.notes.mindPalace is missing — triage has no palace to read');
  else if (typeof mp !== 'object' || mp === null || Array.isArray(mp)) errors.push('state.notes.mindPalace is not an object');
  else {
    // dataSource and database are NOT interchangeable, which is why they are separate keys.
    // The collection:// prefix on dataSource is the existing safeguard (state.notion.databases
    // carries it too) against the one mistake that returns a 404 blaming sharing permissions.
    if (typeof mp.dataSource !== 'string' || !mp.dataSource) {
      errors.push('state.notes.mindPalace.dataSource is missing — it is the DATA SOURCE id used for reads, prefixed collection://');
    } else if (!mp.dataSource.startsWith('collection://')) {
      errors.push(`state.notes.mindPalace.dataSource "${mp.dataSource}" does not start with collection:// — that prefix marks it as a data source id, matching state.notion.databases. A database id here reads as "could not find database / share with your integration", which names the wrong cause entirely.`);
    }
    if (typeof mp.database !== 'string' || !mp.database) {
      errors.push('state.notes.mindPalace.database is missing — it is the bare DATABASE id used for writes, matching state.notion.pageParents');
    } else if (mp.database.startsWith('collection://')) {
      errors.push(`state.notes.mindPalace.database "${mp.database}" carries the collection:// prefix, but a write needs a bare database id. These are not interchangeable.`);
    }
  }

  // -- organisations
  const orgs = notes.organisations;
  if (orgs === undefined) errors.push('state.notes.organisations is missing — there is nothing to match a topic name against');
  else if (!Array.isArray(orgs)) errors.push('state.notes.organisations is not an array — it is ordered, so the order is part of the configuration');
  else if (!orgs.length) errors.push('state.notes.organisations is empty — every topic would resolve to a thread');
  else {
    const seen = new Set();
    orgs.forEach((o, i) => {
      const at = `state.notes.organisations[${i}]`;
      if (typeof o !== 'object' || o === null || Array.isArray(o)) { errors.push(`${at} is not an object`); return; }
      if (typeof o.owner !== 'string' || !o.owner) errors.push(`${at} is missing "owner"`);
      else if (seen.has(o.owner)) errors.push(`${at} declares owner "${o.owner}" twice`);
      else seen.add(o.owner);
      // Visibility is a property of the ORGANISATION, never of a repository: one flag per org
      // means there is no per-repository flag to keep in step with reality.
      if (o.visibility === undefined) {
        errors.push(`${at}${o.owner ? ` ("${o.owner}")` : ''} is missing "visibility" — it must say ${VISIBILITIES.join(' or ')}, and is deliberately not defaulted`);
      } else if (!VISIBILITIES.includes(o.visibility)) {
        errors.push(`${at}${o.owner ? ` ("${o.owner}")` : ''} declares visibility ${JSON.stringify(o.visibility)}, which is not ${VISIBILITIES.join(' or ')}. It is NOT treated as shared by default — a guessed visibility is indistinguishable from a chosen one.`);
      }
      for (const k of realKeys(o)) {
        if (!['owner', 'visibility'].includes(k)) errors.push(`${at} has an unexpected key "${k}"`);
      }
    });
  }

  // -- sensitiveTerms
  const st = notes.sensitiveTerms;
  if (st === undefined) errors.push('state.notes.sensitiveTerms is missing — use [] to say deliberately none');
  else if (!Array.isArray(st)) errors.push('state.notes.sensitiveTerms is not an array of strings');
  else st.forEach((t, i) => {
    if (typeof t !== 'string' || !t) errors.push(`state.notes.sensitiveTerms[${i}] is not a non-empty string`);
  });

  // -- projects (OPTIONAL). Keyed by REPOSITORY and carrying a board name only, so it is not the
  // topic map returning by another door: it cannot decide where a note GOES, only which board an
  // issue lands on once exact matching has already decided the repository. Absent is normal — not
  // every repository has a board, and a missing one omits --project rather than failing.
  const projects = notes.projects;
  if (projects !== undefined) {
    if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) {
      errors.push('state.notes.projects is not an object of "owner/repo" to project name');
    } else {
      for (const [repo, board] of Object.entries(projects).filter(([k]) => !isComment(k))) {
        if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) errors.push(`state.notes.projects key "${repo}" is not an owner/repo name`);
        if (typeof board !== 'string' && typeof board !== 'number') errors.push(`state.notes.projects["${repo}"] is not a project name or number`);
      }
    }
  }

  for (const k of realKeys(notes)) {
    if (!['mindPalace', 'organisations', 'sensitiveTerms', 'projects'].includes(k)) {
      errors.push(`state.notes has an unexpected key "${k}" — prefix it with _ if it is a comment`);
    }
  }
  return errors;
}

/** The bare Notion ids, prefix stripped. The prefix is a marker for humans, not part of the id. */
export function palaceIds(notes) {
  const mp = notes.mindPalace ?? {};
  return {
    dataSource: String(mp.dataSource ?? '').replace(/^collection:\/\//, ''),
    database: String(mp.database ?? ''),
  };
}

// ---------------------------------------------------------------- topic resolution

/**
 * Route one topic name against a supplied repository list.
 *
 * @param topic  the Mind Palace topic name, used verbatim
 * @param repos  [{owner, name}] — gathered by the caller, never fetched here
 * @returns {{topic, outcome:'repo'|'thread'|'ambiguous', repo, owner, visibility, candidates, caseOnly}}
 *
 * `repo` and `thread` are both valid, expected outcomes, and they are distinguishable STATES
 * rather than a value and its absence — the routing test needs to know to skip its issue branch,
 * and inferring that from a null would make "no repository" and "not looked up" the same thing.
 */
export function resolveTopic(topic, repos, orgs, { contextRepo = null } = {}) {
  const owners = new Map(orgs.map((o) => [o.owner, o.visibility]));
  const declared = repos.filter((r) => owners.has(r.owner));

  const hits = declared.filter((r) => r.name === topic);   // EXACT. Not lowercased, not trimmed.

  // Case is not a hiding place. A topic differing from a repository name only by case is
  // reported explicitly, because silently matching it would make routing case-insensitive by
  // accident, and silently missing it would look identical to having no repository at all.
  const caseOnly = declared
    .filter((r) => r.name !== topic && r.name.toLowerCase() === topic.toLowerCase())
    .map((r) => `${r.owner}/${r.name}`);

  if (hits.length === 1) {
    const r = hits[0];
    return {
      topic, outcome: 'repo', repo: `${r.owner}/${r.name}`, owner: r.owner,
      visibility: owners.get(r.owner), candidates: [], caseOnly,
    };
  }
  if (hits.length > 1) {
    // Ambiguous resolves to NEITHER and shortlists. The organisations differ in visibility, so
    // picking one would cross that boundary on a guess. `secret-roster` exists in both
    // c-energie and net-flex today, so this is live rather than hypothetical.
    return {
      topic, outcome: 'ambiguous', repo: null, owner: null, visibility: null,
      candidates: hits.map((r) => ({ repo: `${r.owner}/${r.name}`, owner: r.owner, visibility: owners.get(r.owner) })),
      caseOnly,
    };
  }
  return {
    topic, outcome: 'thread', repo: null, owner: null, visibility: null,
    thread: contextRepo, candidates: [], caseOnly,
  };
}

/** Resolve a list of topics, carrying the repository list's freshness into every result. */
export function resolveTopics(topics, repoList, notes, { contextRepo = null, now = null } = {}) {
  const repos = repoList?.repos ?? [];
  const gatheredAt = repoList?.gatheredAt ?? null;
  const ageHours = (gatheredAt && now)
    ? (Date.parse(now) - Date.parse(gatheredAt)) / 3600000
    : null;
  const stale = ageHours === null ? null : ageHours > REPOS_STALE_HOURS;

  return {
    repoList: { count: repos.length, gatheredAt, ageHours, stale },
    topics: topics.map((t) => {
      const r = resolveTopic(t, repos, notes.organisations, { contextRepo });
      // Attribution, not a different outcome. A thread from a stale list may be a thread only
      // because the list missed a repository, and that is worth saying where it is true.
      if (r.outcome === 'thread' && stale) {
        r.staleListCaveat = `the repository list was gathered ${Math.round(ageHours)}h ago (threshold ${REPOS_STALE_HOURS}h), so this may be a thread only because a repository was missed`;
      }
      return r;
    }),
  };
}

// ---------------------------------------------------------------- note selection
//
// *** MIRRORED LOGIC — collect_notes() in c-energie/bots
//     src/notebots/notes/summarise.py. Keep the two in step. ***
//
// The summariser already has a definition of what counts as a note on a Mind Palace topic page,
// and two tools reading the same page while disagreeing about that would be a permanent source
// of confusion — a bullet triaged into an issue that the summariser never folded in, or a
// summary triaged back into an issue. So this is a PORT, not a reimplementation: the loop keeps
// the Python's structure and its order of tests so that the two read the same, and a change to
// either is known to require a change to the other. `bots/CLAUDE.md` lists its half.
//
// The page structure the Worker writes and the summariser reads: dated `heading_2` sections with
// note blocks under them, and a `heading_3` starting "What this means" introducing the
// summariser's OWN output.

export const HEADING_BLOCK = 'heading_2';
export const DELTA_HEADING_BLOCK = 'heading_3';
export const DELTA_HEADING_PREFIX = 'What this means';
export const NOTE_BLOCKS = ['bulleted_list_item', 'numbered_list_item', 'paragraph'];

const plainText = (rich) => (rich ?? []).map((r) => String(r?.plain_text ?? '')).join('');
export const blockText = (block) => plainText((block?.[String(block?.type)] ?? {}).rich_text).trim();
const isDeltaHeading = (block) => block?.type === DELTA_HEADING_BLOCK
  && blockText(block).startsWith(DELTA_HEADING_PREFIX);

/** Notion's ISO-8601, falling back to the leading date. Returns a Date, or null. */
export function parseNotionDatetime(value) {
  if (!value) return null;
  const t = Date.parse(String(value));
  if (!Number.isNaN(t)) return new Date(t);
  const d = Date.parse(String(value).slice(0, 10));
  return Number.isNaN(d) ? null : new Date(d);
}
const dayOf = (d) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * The notes on a page that are newer than the marker, in page order.
 *
 * @param children  a page's block_children, as Notion returns them
 * @param since     the topic's `Last triaged` value, or null for "never triaged"
 *
 * Dating prefers each block's own `created_time`, which is exact. Where Notion has none it falls
 * back to the dated `heading_2` the block sits under, comparing DATES ONLY — deliberately
 * over-selecting at day granularity rather than dropping a note to a timezone edge, since a note
 * proposed twice costs a line and a note lost costs the note.
 *
 * Comparison is STRICTLY GREATER THAN. A note at exactly the marker instant is already seen,
 * which makes the marker a watermark rather than a range boundary and removes the off-by-one
 * when a half-finished run is resumed.
 */
export function collectNotes(children, since) {
  const notes = [];
  let currentDate = '';
  let inDelta = false;
  const sinceDate = dayOf(since);

  for (const block of children ?? []) {
    const kind = block?.type;
    if (kind === HEADING_BLOCK) {
      // A dated heading also REOPENS the note section: a "What this means" block ends where the
      // next dated heading begins, so notes typed after a summary are notes again.
      currentDate = blockText(block);
      inDelta = false;
      continue;
    }
    if (isDeltaHeading(block)) { inDelta = true; continue; }
    if (inDelta || !NOTE_BLOCKS.includes(kind)) continue;

    const text = blockText(block);
    if (!text) continue;

    const created = parseNotionDatetime(block?.created_time);
    if (since !== null && since !== undefined) {
      if (created !== null) {
        if (created.getTime() <= since.getTime()) continue;
      } else if (sinceDate !== null) {
        const blockDate = dayOf(parseNotionDatetime(currentDate));
        if (blockDate === null || blockDate <= sinceDate) continue;
      }
    }
    notes.push({ date: currentDate, text, createdTime: created ? created.toISOString() : null });
  }
  return notes;
}

/** Whitespace-collapsed, case-folded — the key duplicate detection compares on. */
const normaliseNote = (text) => String(text).replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The new notes on one topic page, deduplicated WITHIN the page.
 *
 * A bullet typed twice on one page is one note and must not become two issues; the earliest
 * occurrence is kept, because that is when it was actually said. Identical text under two
 * different topics deliberately stays TWO rows — that is the cross-cutting case the flat batch
 * exists to let the classifier notice and merge, and collapsing it here would hide it.
 *
 * Pure: it takes blocks and a marker and returns rows. Fetching the blocks is one MCP call per
 * page and is the model's step, which is also what keeps this testable with no connector.
 */
export function selectNotes(topic, children, lastTriaged, { settled = false } = {}) {
  const since = typeof lastTriaged === 'string' ? parseNotionDatetime(lastTriaged) : (lastTriaged ?? null);
  const all = collectNotes(children, since);

  const seen = new Map();
  let duplicates = 0;
  for (const n of all) {
    const key = normaliseNote(n.text);
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.set(key, n);
  }

  return {
    topic,
    // Settled topics are SWEPT, not skipped. A note typed against a settled topic is still a
    // note, and silently ignoring it would lose work with nothing to show it had happened.
    settled,
    lastTriaged: since ? since.toISOString() : null,
    notes: [...seen.values()],
    duplicatesCollapsed: duplicates,
  };
}

/**
 * Roll up a whole run's per-topic selections.
 *
 * "Nothing new" short circuits before classification and reports how many topics were swept, so
 * that a genuine no-op is distinguishable from a run that never happened. An empty table with no
 * explanation leaves someone wondering which of the two they are looking at.
 */
export function sweep(selections) {
  const total = selections.reduce((n, s) => n + s.notes.length, 0);
  return {
    topicsSwept: selections.length,
    settledSwept: selections.filter((s) => s.settled).length,
    newNotes: total,
    nothingNew: total === 0,
    selections,
  };
}

// ---------------------------------------------------------------- the shortlist and the table
//
// THE ROUTING TEST IS PROSE IN THE SKILL, evaluated by the model, in a fixed order, stopping at
// the first destination that fits. It is the only judgement step in a run. THE SHORTLIST IS CODE,
// evaluated here, and it runs AFTER classification and OVERRIDES it.
//
// That split is the point. A note that must not be routed automatically — an ambiguous topic, an
// unnameable repository, a sensitive term, a destination somebody else owns — cannot be caught by
// asking the model how confident it feels, because that is a second opinion from the source that
// already committed to an answer. So the triggers are RULES, not a score: no confidence number is
// requested, stored or thresholded, and there is no threshold to tune. The bias runs one way,
// toward the shortlist, never toward a direct write.

// In the order the skill states them. `bin` means no derived artefact: the note keeps living on
// its topic page, which is where it was always going to live. Triage never deletes or edits a
// captured note, so binning is safe rather than destructive.
export const DESTINATIONS = ['issue', 'action', 'open-question', 'decision', 'thread', 'bin'];

export const SHORTLIST_REASONS = {
  ambiguousTopic: 'the topic name matches a repository in more than one declared organisation, and they differ in visibility — picking one would cross that boundary on a guess',
  unnameableRepo: 'classified as an issue but no repository could be named — a vague note must not land in whichever repository seemed closest',
  sensitiveTerm: 'the note text hits a sensitiveTerms entry, which forces the shortlist however confidently it was classified',
  sharedDestination: 'the destination is in an organisation flagged shared, so work somebody else owns gets a second look',
  wouldWriteDirectly: 'it would otherwise have been written directly without a second look',
};

/**
 * Which shortlist triggers a classified row fires. Triggers ACCUMULATE — a note hitting several
 * appears once with every reason named, because half a reason is not why it stopped.
 *
 * @param row       {topic, note, destination, target, why}
 * @param topicRes  the topic's resolution from resolveTopic()
 * @param notes     the validated state.notes block
 */
export function shortlistTriggers(row, topicRes, notes) {
  const fired = [];

  if (topicRes?.outcome === 'ambiguous') fired.push('ambiguousTopic');

  // An issue with nowhere to go. Only checked on the issue branch: every other destination is
  // named by the topic's own context repo and cannot be unnameable.
  if (row.destination === 'issue' && !row.target) fired.push('unnameableRepo');

  if (sensitiveHits(row.note, notes?.sensitiveTerms).length) fired.push('sensitiveTerm');

  // Visibility is the ORGANISATION's, so this is read off the resolution rather than off the
  // target string — there is no per-repository flag that could disagree with it.
  const visibility = row.visibility ?? topicRes?.visibility ?? null;
  if (visibility === 'shared') fired.push('sharedDestination');

  if (row.wouldWriteDirectly) fired.push('wouldWriteDirectly');

  return fired;
}

/**
 * Evaluate a whole classified batch: attach triggers, split shortlisted from the table, and
 * refuse a row that cannot be reviewed.
 *
 * `why` is REQUIRED. A table showing only topic, note and destination hides the reason, which is
 * exactly where routing goes wrong — the destination often looks right while the reason for it is
 * wrong, and that is the case a reviewer can only catch if the reason is on screen. So a row
 * without one is not proposed at all.
 */
export function evaluateBatch(rows, resolutions, notes) {
  const byTopic = new Map((resolutions ?? []).map((r) => [r.topic, r]));
  const errors = [];
  const evaluated = [];

  rows.forEach((row, i) => {
    const at = `row ${i + 1} (${row.topic ?? 'no topic'})`;
    if (!row.destination || !DESTINATIONS.includes(row.destination)) {
      errors.push(`${at}: destination ${JSON.stringify(row.destination ?? null)} is not one of ${DESTINATIONS.join(', ')}`);
    }
    if (typeof row.why !== 'string' || !row.why.trim()) {
      errors.push(`${at}: "why" is empty — a row cannot be proposed without a stated reason, because the reason is the part a reviewer can actually check`);
    }
    const res = byTopic.get(row.topic) ?? null;

    // The issue branch is GATED ON THE TOPIC'S RESOLUTION. A topic that resolved to a thread has
    // no repository, so the test starts at "is this a dated commitment by a named person" and the
    // six-destination test is really a five-destination one. A note under such a topic must never
    // be argued into an issue with nowhere to go.
    if (row.destination === 'issue' && res && res.outcome !== 'repo') {
      errors.push(`${at}: classified as an issue, but topic "${row.topic}" resolved to ${res.outcome}, so the issue branch does not apply to it. Re-run the test starting at the action branch.`);
    }

    const target = row.target ?? (res?.outcome === 'repo' ? res.repo : null);
    const resolvedTarget = res?.outcome === 'repo' ? res.repo
      : res?.outcome === 'thread' ? (res.thread ?? null)
      : null;
    const triggers = shortlistTriggers({ ...row, target }, res, notes);

    evaluated.push({
      ...row,
      target,
      resolvedTarget,
      // An overrule is a VISIBLE CLAIM: the resolved value and the overrule are shown together,
      // so a reviewer can see that a claim was made rather than infer it from a value they would
      // have had to already know.
      overruled: Boolean(target && resolvedTarget && target !== resolvedTarget),
      topicOutcome: res?.outcome ?? null,
      triggers,
      shortlisted: triggers.length > 0,
      shortlistReasons: triggers.map((t) => SHORTLIST_REASONS[t]),
      candidates: res?.outcome === 'ambiguous' ? res.candidates : undefined,
    });
  });

  return {
    errors,
    rows: evaluated,
    table: evaluated.filter((r) => !r.shortlisted),
    shortlist: evaluated.filter((r) => r.shortlisted),
  };
}

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

/**
 * One table for the WHOLE SWEEP with topic as a column, so three bullets under three topics can
 * be seen as one issue. Rendering lives here rather than in a prompt so that the column set, the
 * ordering and the required `why` are enforced in one place.
 */
export function renderTable(batch, { only = null, width = 52 } = {}) {
  const lines = [];
  if (batch.errors.length) {
    lines.push('REFUSED — these rows cannot be proposed:');
    for (const e of batch.errors) lines.push(`  ! ${e}`);
    lines.push('');
  }

  // An amendment re-prints ONLY the changed rows: re-reading the whole batch to find one
  // correction is how a reviewer stops reading it.
  const shown = only ? batch.table.filter((r) => only.includes(r.id)) : batch.table;

  if (!shown.length) lines.push(only ? '(no matching rows)' : '(nothing to propose — every row is shortlisted)');
  else {
    const col = (r) => [
      r.topic,
      clip(r.note, width),
      r.destination,
      r.overruled ? `${r.resolvedTarget ?? '(none)'} -> ${r.target}` : (r.target ?? '—'),
      clip(r.why, width + 20),
    ];
    const head = ['topic', 'note', 'destination', 'target', 'why'];
    const rowsOut = shown.map(col);
    const w = head.map((h, i) => Math.max(h.length, ...rowsOut.map((r) => String(r[i]).length)));
    const line = (cells) => `  ${cells.map((c, i) => String(c).padEnd(w[i])).join('  ')}`.trimEnd();
    lines.push(line(head));
    lines.push(`  ${w.map((n) => '-'.repeat(n)).join('  ')}`);
    for (const r of rowsOut) lines.push(line(r));
    for (const r of shown.filter((x) => x.overruled)) {
      lines.push(`  ! ${r.topic}: the classifier OVERRULED the topic's resolved destination. Stated reason: ${r.why}`);
    }
  }

  // Shortlisted rows are kept OUT of the table and counted, so the table stays the thing that
  // gets read. Expandable on demand: available without being in the way.
  if (batch.shortlist.length) {
    lines.push('');
    lines.push(`  still undecided (${batch.shortlist.length}) — shortlisted, not routed. Ask to expand to see them.`);
  }
  return lines.join('\n');
}

/** The expanded shortlist: one entry per note with every reason it stopped. */
export function renderShortlist(batch) {
  if (!batch.shortlist.length) return '  nothing shortlisted.';
  const lines = [`  still undecided (${batch.shortlist.length}):`];
  for (const r of batch.shortlist) {
    lines.push(`\n  ${r.topic} — ${clip(r.note, 100)}`);
    lines.push(`    would have been: ${r.destination}${r.target ? ` -> ${r.target}` : ''}`);
    for (const reason of r.shortlistReasons) lines.push(`    - ${reason}`);
    if (r.candidates) lines.push(`      candidates: ${r.candidates.map((c) => `${c.repo} (${c.visibility})`).join(' and ')}`);
  }
  // Hesitation must not be converted into a bad routing, so nothing here has to be decided now.
  lines.push('\n  These are stamped with a Shortlisted datetime and left. You are NOT asked to decide');
  lines.push('  them before the run ends — and the count is reported every run, because a count that');
  lines.push('  only grows is evidence the routing test is wrong rather than evidence you are behind.');
  return lines.join('\n');
}

/** The approved batch, printed back as the plan the write issues consume. */
export function renderPlan(batch) {
  const lines = [`  APPROVED PLAN — ${batch.table.length} write(s), ${batch.shortlist.length} shortlisted`];
  const byDest = new Map();
  for (const r of batch.table) byDest.set(r.destination, [...(byDest.get(r.destination) ?? []), r]);
  for (const d of DESTINATIONS) {
    const rows = byDest.get(d);
    if (!rows?.length) continue;
    lines.push(`\n  ${d} (${rows.length}):`);
    for (const r of rows) lines.push(`    ${r.topic}: ${clip(r.note, 90)}${r.target ? `  -> ${r.target}` : ''}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- GitHub issues
//
// The first destination triage can actually write, and the one that has to be got right: an issue
// body in a shared repository is visible to the team and its history cannot be rewritten. A note
// routed to the wrong repository is not an inconvenience, it is a disclosure. Every guard below
// exists for that sentence.
//
// THE SCRIPT FORMATS, THE MODEL EXECUTES. This plans the exact `gh issue create` invocation and
// builds the body from a fixed template; the model runs it. Shelling out to GitHub from here
// would make the test suite depend on a network and a credential, and `gh` is already how the
// rest of this repo's tooling authenticates.

export const TITLE_MAX = 120;

/**
 * The issue body. A fixed template so that every issue triage opens has the same shape, rather
 * than one composed ad hoc per row.
 *
 * The note goes in VERBATIM — the user's own phrasing, not a paraphrase of it. It is written to a
 * body FILE rather than passed as `--body`, because note text is arbitrary user prose and shell
 * quoting of arbitrary prose is a bug waiting for the first backtick.
 */
export function issueBody({ note, topic, capturedAt, topicUrl }) {
  const lines = [String(note ?? '')];
  lines.push('');
  lines.push('---');
  // Provenance, so a reader can find where the idea came from rather than guessing.
  lines.push(`Captured as a note under **${topic}** in the Mind Palace on ${capturedAt ?? 'an unrecorded date'}`
    + `${topicUrl ? ` — ${topicUrl}` : ''}.`);
  lines.push('Opened by `triage-notes`. The note itself is unchanged and still lives on its topic page.');
  return `${lines.join('\n')}\n`;
}

/**
 * The `gh issue create` invocation for one approved row, as an argv array. Returns
 * `{ok: false, reason}` for a row that must not be written, rather than a command that would be.
 *
 * @param projects  {"owner/repo": "board name or number"} — optional, and absent is normal
 */
export function planIssue(row, { projects = {}, unreachable = [], bodyFile = null } = {}) {
  if (row.destination !== 'issue') return { ok: false, reason: `destination is ${row.destination}, not issue` };

  // A note whose repository cannot be named must never reach this step: no issue is opened on a
  // guess. #13 shortlists it; this refuses it again, because the cost of being wrong is a write.
  if (!row.target) return { ok: false, reason: 'no repository could be named — no issue is opened on a guess', shortlist: true };

  // Shared destinations are NEVER written directly from a personal session. They shortlist, or
  // park in handoff/ with kind: issue once that contract lands.
  if (row.visibility === 'shared') {
    return { ok: false, reason: `${row.target} is in an organisation flagged shared — another person sees it first, so this shortlists or goes to handoff/ rather than being written`, shortlist: true };
  }

  if (unreachable.includes(row.target)) {
    // Named by REPOSITORY, because fine-grained tokens carry an explicit repository list and so
    // fail per repository rather than per organisation. A token scoped too narrowly would
    // otherwise look like a classifier problem rather than a credential one.
    return { ok: false, reason: `${row.target} could not be reached with the current credential — widen the token that covers ${row.target.split('/')[0]}, or hand this off`, shortlist: true };
  }

  const title = String(row.title ?? '').trim();
  if (!title) return { ok: false, reason: 'the issue title is empty — the issue list has to stay readable, so a row needs a one-line statement of the work' };
  if (title.length > TITLE_MAX) return { ok: false, reason: `the issue title is ${title.length} characters (max ${TITLE_MAX}) — it is a title, not the note` };

  const project = projects[row.target] ?? null;
  const argv = ['issue', 'create', '--repo', row.target, '--title', title, '--body-file', bodyFile ?? `[body file for row ${row.id}]`];
  // A repository with no project creates the issue anyway and says so. Not every repository has
  // a board, and a missing one must not block the write.
  if (project) argv.push('--project', String(project));

  return {
    ok: true,
    id: row.id,
    repo: row.target,
    title,
    argv,
    project,
    projectSkipped: project ? null : `${row.target} has no project configured in state.notes.projects, so --project was omitted and the issue is not on a board`,
    body: issueBody({
      note: row.note, topic: row.topic,
      capturedAt: row.capturedAt ?? row.date ?? null, topicUrl: row.topicUrl ?? null,
    }),
  };
}

/**
 * One command per approved `issue` row, in TABLE ORDER, so that a partial failure is attributable
 * to a specific row rather than to "somewhere in the batch".
 */
export function planIssues(batch, opts = {}) {
  const plans = [];
  const refused = [];
  for (const row of batch.table) {
    if (row.destination !== 'issue') continue;
    const p = planIssue(row, opts);
    if (p.ok) plans.push(p); else refused.push({ id: row.id, topic: row.topic, ...p });
  }
  return { plans, refused };
}

/**
 * Move every row bound for an unreachable repository onto the shortlist, BEFORE the batch is
 * approved. Checked once per distinct destination repository: discovering a too-narrow token half
 * way through a batch is how a run ends up half-written.
 *
 * Rows for other repositories in the same batch are untouched — one bad repository does not
 * abandon the batch.
 */
export function applyReachability(batch, unreachable) {
  const bad = new Set(unreachable ?? []);
  const rows = batch.rows.map((r) => {
    if (r.destination !== 'issue' || !r.target || !bad.has(r.target)) return r;
    const reason = `${r.target} could not be reached with the current credential — the token covering ${r.target.split('/')[0]} does not list it`;
    return {
      ...r,
      triggers: [...r.triggers, 'unreachableRepo'],
      shortlistReasons: [...r.shortlistReasons, reason],
      shortlisted: true,
    };
  });
  return { ...batch, rows, table: rows.filter((r) => !r.shortlisted), shortlist: rows.filter((r) => r.shortlisted) };
}

/** The distinct destination repositories in a batch — what to check reachability against. */
export const destinationRepos = (batch) =>
  [...new Set(batch.rows.filter((r) => r.destination === 'issue' && r.target).map((r) => r.target))].sort();

// ---------------------------------------------------------------- Notion rows
//
// TRIAGE DOES NOT WRITE NOTION ROWS. Three of the six destinations are Notion rows, and each of
// those databases already has a skill that writes it, each owning its own property traps: the
// trailing space in the open questions `Type ` property, the `Watching` status on actions that
// means a reminder rather than a task, and the data source id / database id distinction whose
// error message blames sharing permissions. A second implementation of those traps would drift,
// and the Notion schema would then be asserted in three places instead of one.
//
// So this file holds NO NOTION PROPERTY NAMES AT ALL. It formats arguments; the model calls
// `context-notion:add-action`, `:add-open-question` or `:log-decision`. A schema change stays a
// one-file change in context-notion.
//
// Those skills read the RESOLVED repo's `state.notion`, which is what stops a run in one project
// writing into another project's databases — a stronger guarantee than anything this could
// enforce on its own.

export const NOTION_DESTINATIONS = {
  action: { skill: 'context-notion:add-action', pendingType: 'action' },
  'open-question': { skill: 'context-notion:add-open-question', pendingType: 'open-question' },
  decision: { skill: 'context-notion:log-decision', pendingType: 'decision' },
};

/** The provenance line every written row carries, so where the idea came from survives. */
export const provenance = ({ topic, capturedAt, topicUrl }) =>
  `From a note under "${topic}" in the Mind Palace, captured ${capturedAt ?? 'on an unrecorded date'}`
  + `${topicUrl ? ` — ${topicUrl}` : ''}.`;

const looksLikeQuestion = (s) => /\?\s*$/.test(String(s ?? '').trim());

/**
 * The arguments for one approved Notion row. Returns `{ok: false, reason}` rather than an
 * argument set with a hole in it.
 *
 * NOTHING IS INVENTED. An owner, a due date and a rationale are carried through from the note or
 * they are absent — never guessed. A note that routed to an action without an identifiable owner
 * has already been shortlisted; this refuses it again rather than assigning somebody work by
 * inference.
 */
export function planNotionRow(row) {
  const dest = NOTION_DESTINATIONS[row.destination];
  if (!dest) return { ok: false, reason: `destination ${row.destination} is not a Notion row` };

  const prov = provenance({ topic: row.topic, capturedAt: row.capturedAt ?? row.date ?? null, topicUrl: row.topicUrl ?? null });
  const base = { id: row.id, topic: row.topic, skill: dest.skill, pendingType: dest.pendingType, provenance: prov };

  if (row.destination === 'action') {
    // The person and the deadline the user actually wrote. Absent is a refusal, not a default:
    // nobody is assigned work by inference, and a substituted date is a commitment nobody made.
    if (!row.owner) return { ok: false, reason: 'the action has no identifiable owner — a guessed owner assigns somebody work they never agreed to', shortlist: true };
    if (!row.due) return { ok: false, reason: 'the action has no date — a substituted deadline is a commitment nobody made', shortlist: true };
    return { ...base, ok: true, args: { task: row.note, owner: row.owner, due: row.due, notes: prov } };
  }

  if (row.destination === 'open-question') {
    // The database's title property IS a question, so a title that is not one reads wrong in it.
    const q = row.question ?? row.note;
    if (!looksLikeQuestion(q)) {
      return { ok: false, reason: 'the open question is not phrased as a question — the database\'s title property is a question, so a statement reads wrong in it. Rephrase it, or route it elsewhere.' };
    }
    return { ...base, ok: true, args: { question: String(q).trim(), notes: prov } };
  }

  // decision
  const statement = row.decision ?? null;
  if (!statement || !String(statement).trim()) {
    return { ok: false, reason: 'the decision row has no statement of what was decided — the topic alone makes a log nobody can read without opening every row' };
  }
  if (String(statement).trim() === String(row.topic).trim()) {
    return { ok: false, reason: 'the decision statement is just the topic name — say what was decided' };
  }
  return {
    ...base, ok: true,
    args: {
      decision: String(statement).trim(),
      // Empty when the note gave none, NEVER filled. A decision log that acquires reasoning
      // nobody gave is worse than one with a gap in it.
      rationale: row.rationale ? String(row.rationale).trim() : '',
      notes: prov,
    },
  };
}

/**
 * Plan every Notion row in an approved batch.
 *
 * `connectorAvailable: false` turns each write into an `add-pending` item rather than dropping
 * it. That fallback already exists for exactly this case, and it matters here more than
 * elsewhere: the Notion connector returns EMPTY RESULTS rather than errors for a workspace guest,
 * so a write that silently goes nowhere looks exactly like a quiet run.
 */
export function planNotionRows(batch, { connectorAvailable = true } = {}) {
  const writes = [];
  const queued = [];
  const refused = [];
  for (const row of batch.table) {
    if (!NOTION_DESTINATIONS[row.destination]) continue;
    const p = planNotionRow(row);
    if (!p.ok) { refused.push({ id: row.id, topic: row.topic, ...p }); continue; }
    if (connectorAvailable) writes.push(p);
    else queued.push({ ...p, skill: 'context-notion:add-pending', queuedAs: p.pendingType, drain: 'context-notion:process-pending' });
  }
  return { writes, queued, refused, connectorAvailable };
}

/** Which sensitive terms a piece of text hits. Case-insensitive SUBSTRING matching. */
export function sensitiveHits(text, terms) {
  const hay = String(text ?? '').toLowerCase();
  return (terms ?? []).filter((t) => hay.includes(String(t).toLowerCase()));
}

// ---------------------------------------------------------------- CLI

const die = (m) => { console.error(`triage-notes.mjs: ${m}`); process.exit(2); };
const VALUED = ['repos', 'topics', 'now', 'pages', 'batch', 'only', 'unreachable', 'body-dir'];
const flagValue = (argv, name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')[0]));
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { if (!a.includes('=') && VALUED.includes(a.slice(2))) i++; continue; }
    positional.push(a);
  }
  const [cmd, root] = positional;
  const asJson = flags.has('json');

  if (!cmd) {
    console.error('usage: triage-notes.mjs config [checkout] [--json]');
    console.error('       triage-notes.mjs resolve [checkout] --repos [file.json] [--topics a,b,c] [--json] [--now ISO]');
  console.error('       triage-notes.mjs select  --pages [file.json] [--json]');
  console.error('       triage-notes.mjs propose [checkout] --batch [file.json] [--repos f] [--classify|--approve] [--expand] [--only ids]');
  console.error('       triage-notes.mjs github  [checkout] --batch [evaluated.json] [--body-dir d] [--unreachable owner/repo,...]');
  console.error('       triage-notes.mjs notion  [checkout] --batch [evaluated.json] [--no-connector]');
    process.exit(2);
  }

  const cfg = loadConfig(root);

  if (cmd === 'config') {
    if (asJson) console.log(JSON.stringify(cfg, null, 2));
    else {
      console.log(`triage-notes — ${cfg.status}`);
      console.log(`  ${cfg.says}`);
      for (const e of cfg.errors) console.log(`  ! ${e}`);
      if (cfg.fix) console.log(`  ${cfg.fix}`);
      if (cfg.status === 'configured') {
        const ids = palaceIds(cfg.notes);
        console.log(`\n  Mind Palace  data source ${ids.dataSource}`);
        console.log(`               database    ${ids.database}`);
        console.log(`  Organisations (in order):`);
        for (const o of cfg.notes.organisations) console.log(`    ${o.owner.padEnd(14)} ${o.visibility}`);
        console.log(`  Sensitive terms: ${cfg.notes.sensitiveTerms.length}`);
        // A configured block is not a working connector. An MCP connection exists because of the
        // host registry and this repo's own MCP scope, not because a context.json names an id —
        // and an empty read from a palace the connector cannot see is indistinguishable from an
        // empty palace, which is the one failure that silently reports "nothing to do".
        console.log(`\n  Naming a Mind Palace is not the same as being able to see it. If the`);
        console.log(`  session's Notion connector cannot reach ${ids.dataSource},`);
        console.log(`  report that as a CONNECTOR problem and stop — an empty read must never be`);
        console.log(`  presented as an empty Mind Palace.`);
      }
    }
    process.exit(cfg.status === 'configured' ? 0 : 1);
  }

  if (cmd === 'resolve') {
    if (cfg.status !== 'configured') {
      if (asJson) console.log(JSON.stringify(cfg, null, 2));
      else { console.error(`triage-notes — ${cfg.status}`); console.error(`  ${cfg.says}`); if (cfg.fix) console.error(`  ${cfg.fix}`); }
      process.exit(1);
    }
    const reposFile = flagValue(argv, 'repos');
    if (!reposFile) die('resolve needs --repos [file.json]: {"gatheredAt":"...","repos":[{"owner":"...","name":"..."}]}. The list is supplied, never fetched here.');
    if (!existsSync(reposFile)) die(`no such repository list: ${reposFile}`);
    let repoList;
    try { repoList = readJson(reposFile); }
    catch (e) { die(`${reposFile} is not valid JSON (${e.message})`); }

    const topicsArg = flagValue(argv, 'topics');
    if (!topicsArg) die('resolve needs --topics "a,b,c" — the Mind Palace topic names. Reading them from Notion belongs to a later issue.');
    const topics = topicsArg.split(',').map((t) => t.trim()).filter(Boolean);

    const ctxRepo = readJson(cfg.file).contextRepo ?? null;
    const now = flagValue(argv, 'now') ?? new Date().toISOString();
    const out = resolveTopics(topics, repoList, cfg.notes, { contextRepo: ctxRepo, now });

    if (asJson) { console.log(JSON.stringify(out, null, 2)); return; }
    console.log(`triage-notes — routing ${out.topics.length} topic(s)`);
    console.log(`  repository list: ${out.repoList.count} repo(s)`
      + (out.repoList.gatheredAt ? `, gathered ${out.repoList.gatheredAt}` : ', no gatheredAt declared')
      + (out.repoList.stale === true ? ` — STALE (older than ${REPOS_STALE_HOURS}h)` : ''));
    const w = Math.max(...out.topics.map((t) => t.topic.length));
    for (const t of out.topics) {
      const where = t.outcome === 'repo' ? `${t.repo}  (${t.visibility})`
        : t.outcome === 'ambiguous' ? `AMBIGUOUS — ${t.candidates.map((c) => `${c.repo} (${c.visibility})`).join(' and ')}`
        : `thread in ${t.thread ?? 'the resolved context repo'}`;
      console.log(`  ${t.topic.padEnd(w)}  ${t.outcome.padEnd(9)}  ${where}`);
      if (t.outcome === 'ambiguous') console.log(`  ${' '.repeat(w)}  resolves to NEITHER: the organisations differ in visibility, so picking one would cross that boundary on a guess. Shortlist it.`);
      if (t.caseOnly?.length) console.log(`  ${' '.repeat(w)}  ! differs only by case from ${t.caseOnly.join(', ')} — matching is exact, so this is NOT a match. Rename the topic if it was meant to be one.`);
      if (t.staleListCaveat) console.log(`  ${' '.repeat(w)}  ! ${t.staleListCaveat}`);
    }
    return;
  }

  if (cmd === 'select') {
    // Takes captured block JSON so it runs offline: the MCP fetch that produces it is one call
    // per page and is the model's step, not this script's.
    const pagesFile = flagValue(argv, 'pages');
    if (!pagesFile) die('select needs --pages [file.json]: [{"topic":"...","lastTriaged":"[ISO]|null","settled":false,"children":[...]}]. The block_children come from one MCP call per page — the model fetches them, this matches them.');
    if (!existsSync(pagesFile)) die(`no such pages file: ${pagesFile}`);
    let pages;
    try { pages = readJson(pagesFile); }
    catch (e) { die(`${pagesFile} is not valid JSON (${e.message})`); }
    if (!Array.isArray(pages)) die(`${pagesFile} must be an array of pages`);

    const out = sweep(pages.map((p) =>
      selectNotes(p.topic, p.children, p.lastTriaged ?? null, { settled: Boolean(p.settled) })));

    if (asJson) { console.log(JSON.stringify(out, null, 2)); return; }

    if (out.nothingNew) {
      // The short circuit. Says what was looked at, so "nothing to do" is never mistaken for
      // "nothing happened".
      console.log(`triage-notes — nothing new.`);
      console.log(`  Swept ${out.topicsSwept} topic(s)${out.settledSwept ? ` (${out.settledSwept} settled, swept anyway)` : ''} and found no notes past their Last triaged marker.`);
      console.log(`  Stop here: there is no batch to classify, and no marker to move.`);
      return;
    }
    console.log(`triage-notes — ${out.newNotes} new note(s) across ${out.topicsSwept} topic(s)`);
    for (const s of out.selections) {
      if (!s.notes.length) continue;
      console.log(`\n  ${s.topic}${s.settled ? '  (settled — swept anyway)' : ''}   since ${s.lastTriaged ?? 'never triaged'}`);
      for (const n of s.notes) console.log(`    [${n.date || 'undated'}] ${n.text}`);
      if (s.duplicatesCollapsed) console.log(`    (${s.duplicatesCollapsed} identical duplicate(s) on this page collapsed into the earliest)`);
    }
    console.log(`\n  The marker is written PER NOTE, immediately after that note's write succeeds,`);
    console.log(`  and carries the note's own timestamp — not the run's start time. A write that`);
    console.log(`  fails keeps its old marker, so the note is proposed again next run rather than`);
    console.log(`  lost, and resuming a half-finished run is just re-running this skill.`);
    return;
  }

  if (cmd === 'propose') {
    // Takes the model's classified rows and evaluates the script's half: the shortlist rules and
    // the table. WRITES NOTHING — the whole routing test, the shortlist and the amendment loop
    // can be exercised against the real Mind Palace with no possibility of a bad write.
    if (cfg.status !== 'configured') {
      console.error(`triage-notes — ${cfg.status}`);
      console.error(`  ${cfg.says}`); if (cfg.fix) console.error(`  ${cfg.fix}`);
      process.exit(1);
    }
    const batchFile = flagValue(argv, 'batch');
    if (!batchFile) die('propose needs --batch [file.json]: {"rows":[{"id":"1","topic":"...","note":"...","destination":"issue|action|open-question|decision|thread|bin","target":"owner/repo","why":"..."}]}');
    if (!existsSync(batchFile)) die(`no such batch: ${batchFile}`);
    let batchIn;
    try { batchIn = readJson(batchFile); }
    catch (e) { die(`${batchFile} is not valid JSON (${e.message})`); }
    const rows = (batchIn.rows ?? batchIn).map((r, i) => ({ id: r.id ?? String(i + 1), ...r }));

    // Topic resolutions come from the same matcher #11 uses, so the issue branch is gated on the
    // same answer the roster would give rather than on a second, drifting one.
    const reposFile = flagValue(argv, 'repos');
    let resolutions = batchIn.resolutions ?? [];
    if (reposFile) {
      if (!existsSync(reposFile)) die(`no such repository list: ${reposFile}`);
      const repoList = readJson(reposFile);
      const ctxRepo = readJson(cfg.file).contextRepo ?? null;
      const topics = [...new Set(rows.map((r) => r.topic))];
      resolutions = resolveTopics(topics, repoList, cfg.notes,
        { contextRepo: ctxRepo, now: flagValue(argv, 'now') ?? new Date().toISOString() }).topics;
    }

    const batch = evaluateBatch(rows, resolutions, cfg.notes);
    const onlyArg = flagValue(argv, 'only');
    const only = onlyArg ? onlyArg.split(',').map((s) => s.trim()).filter(Boolean) : null;

    if (asJson) { console.log(JSON.stringify(batch, null, 2)); process.exit(batch.errors.length ? 1 : 0); }

    console.log(`triage-notes — ${batch.table.length} proposed, ${batch.shortlist.length} shortlisted`);
    console.log(only ? `  (re-printing ${only.length} amended row(s) only — the rest of the batch is unchanged)\n` : '');
    console.log(renderTable(batch, { only }));
    if (flags.has('expand')) { console.log(''); console.log(renderShortlist(batch)); }

    if (batch.errors.length) { console.log('\n  Fix the refused rows above before approving.'); process.exit(1); }

    if (flags.has('classify')) {
      // The read-only mode: table, no approval offered, no plan. This is the acceptance check
      // against the live Mind Palace, and it is safe precisely because nothing writes.
      console.log('\n  --classify: read-only. No approval offered and nothing will be written.');
      return;
    }
    if (flags.has('approve')) {
      console.log('');
      console.log(renderPlan(batch));
      console.log('\n  Nothing is written by this command. The write issues consume this plan.');
      return;
    }
    console.log('\n  Correct any row in plain language — amending does not need a syntax. Re-run with');
    console.log('  --only [ids] after applying corrections to re-print just those rows.');
    console.log('  ONE approval covers the whole batch: twelve notes is one decision.');
    console.log('  Exactly one destination per note — a note carrying both rationale and a commitment');
    console.log('  gets one row, which is a known limitation and not a bug.');
    return;
  }

  if (cmd === 'github') {
    // Plans the `gh issue create` calls for an approved batch, and writes each body to a file so
    // the model can pass --body-file. It does NOT run gh: the model does, one command per row, so
    // a partial failure is attributable and the marker can be advanced per note.
    if (cfg.status !== 'configured') {
      console.error(`triage-notes — ${cfg.status}`); console.error(`  ${cfg.says}`); process.exit(1);
    }
    const batchFile = flagValue(argv, 'batch');
    if (!batchFile || !existsSync(batchFile)) die('github needs --batch [file.json] — the evaluated batch from `propose --json`');
    let batch;
    try { batch = readJson(batchFile); }
    catch (e) { die(`${batchFile} is not valid JSON (${e.message})`); }
    if (!batch.table) die(`${batchFile} does not look like an evaluated batch (no "table") — pipe \`propose --json\` into it`);

    const unreachableArg = flagValue(argv, 'unreachable');
    const unreachable = unreachableArg ? unreachableArg.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (unreachable.length) batch = applyReachability(batch, unreachable);

    const outDir = flagValue(argv, 'body-dir');
    const projects = cfg.notes.projects ?? {};
    const { plans, refused } = planIssues(batch, { projects, unreachable, bodyFile: null });

    // Bodies are written to files rather than inlined: note text is arbitrary user prose, and
    // shell quoting of arbitrary prose is a bug waiting for the first backtick.
    for (const p of plans) {
      if (outDir) {
        const f = join(outDir, `issue-${p.id}.md`);
        writeFileSync(f, p.body);
        p.bodyFile = f;
        p.argv[p.argv.indexOf('--body-file') + 1] = f;
      }
    }

    if (asJson) { console.log(JSON.stringify({ repos: destinationRepos(batch), plans, refused }, null, 2)); return; }

    const repos = destinationRepos(batch);
    console.log(`triage-notes — ${plans.length} issue(s) to create across ${repos.length} repo(s)`);
    console.log(`\n  CHECK REACHABILITY FIRST, once per repository, BEFORE approval:`);
    for (const r of repos) console.log(`    gh repo view ${r} --json name  >/dev/null`);
    console.log(`  Re-run with --unreachable "owner/repo,..." for any that fail. They shortlist by`);
    console.log(`  NAME, because a fine-grained token lists repositories explicitly, so a too-narrow`);
    console.log(`  token fails per repository — and would otherwise read as a classifier problem.`);

    if (plans.length) {
      console.log(`\n  Commands, in table order — run them one at a time and advance the marker after each:`);
      for (const p of plans) {
        console.log(`\n    # row ${p.id} -> ${p.repo}`);
        console.log(`    gh ${p.argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
        if (p.projectSkipped) console.log(`    # ${p.projectSkipped}`);
      }
    }
    if (refused.length) {
      console.log(`\n  Not written (${refused.length}):`);
      for (const r of refused) console.log(`    row ${r.id} (${r.topic}): ${r.reason}`);
    }
    console.log(`\n  Advance Last triaged IMMEDIATELY after each creation, with the note's own`);
    console.log(`  timestamp — a re-run after a failure must not open the same issue twice. A failed`);
    console.log(`  creation keeps its old marker, is named in the run summary with the repository and`);
    console.log(`  the gh error, and the batch CONTINUES: one bad repository does not abandon it.`);
    console.log(`  Report every created issue's URL back, so what was written can be opened.`);
    return;
  }

  if (cmd === 'notion') {
    if (cfg.status !== 'configured') {
      console.error(`triage-notes — ${cfg.status}`); console.error(`  ${cfg.says}`); process.exit(1);
    }
    const batchFile = flagValue(argv, 'batch');
    if (!batchFile || !existsSync(batchFile)) die('notion needs --batch [file.json] — the evaluated batch from `propose --json`');
    let batch;
    try { batch = readJson(batchFile); }
    catch (e) { die(`${batchFile} is not valid JSON (${e.message})`); }
    if (!batch.table) die(`${batchFile} does not look like an evaluated batch (no "table")`);

    // Explicit, never inferred from a result: a workspace guest gets EMPTY results rather than
    // errors, so "no rows came back" and "I could not look" are indistinguishable downstream.
    const connectorAvailable = !flags.has('no-connector');
    const out = planNotionRows(batch, { connectorAvailable });

    if (asJson) { console.log(JSON.stringify(out, null, 2)); return; }

    console.log(`triage-notes — ${out.writes.length} Notion row(s), ${out.queued.length} queued, ${out.refused.length} refused`);
    if (!connectorAvailable) {
      console.log(`\n  THE NOTION CONNECTOR IS UNAVAILABLE. Nothing is dropped: each row below is queued`);
      console.log(`  with context-notion:add-pending into the context repo's pending/ folder.`);
    }
    for (const p of [...out.writes, ...out.queued]) {
      console.log(`\n    row ${p.id} (${p.topic}) -> ${p.skill}${p.queuedAs ? `  [queued as ${p.queuedAs}]` : ''}`);
      for (const [k, v] of Object.entries(p.args)) {
        if (v === '') console.log(`      ${k}: (none given — deliberately empty, never filled)`);
        else console.log(`      ${k}: ${String(v).replace(/\n/g, '\n        ')}`);
      }
    }
    if (out.refused.length) {
      console.log(`\n  Not written (${out.refused.length}):`);
      for (const r of out.refused) console.log(`    row ${r.id} (${r.topic}): ${r.reason}`);
    }
    if (out.queued.length) {
      console.log(`\n  ${out.queued.length} item(s) queued. Drain them with context-notion:process-pending.`);
      console.log(`  Each keeps its OLD Last triaged marker, so a queued item is not also re-proposed.`);
    }
    console.log(`\n  These go through the context-notion skills, never through the Notion API from here:`);
    console.log(`  they own the property traps (the trailing space in the open questions "Type "`);
    console.log(`  property, the Watching status on actions, data source id vs database id), and a`);
    console.log(`  second implementation would drift. Database ids come from the RESOLVED repo's`);
    console.log(`  state.notion, which is what stops a run in one project writing into another's.`);
    console.log(`\n  Advance Last triaged immediately after each successful row. A failure keeps its old`);
    console.log(`  marker, is named in the run summary, and the batch continues.`);
    return;
  }

  die(`unknown command ${JSON.stringify(cmd)}`);
}

if (process.argv[1] && process.argv[1].endsWith('triage-notes.mjs')) main(process.argv.slice(2));
