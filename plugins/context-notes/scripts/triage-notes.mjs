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

import { readFileSync, existsSync } from 'node:fs';
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

  for (const k of realKeys(notes)) {
    if (!['mindPalace', 'organisations', 'sensitiveTerms'].includes(k)) {
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

/** Which sensitive terms a piece of text hits. Case-insensitive SUBSTRING matching. */
export function sensitiveHits(text, terms) {
  const hay = String(text ?? '').toLowerCase();
  return (terms ?? []).filter((t) => hay.includes(String(t).toLowerCase()));
}

// ---------------------------------------------------------------- CLI

const die = (m) => { console.error(`triage-notes.mjs: ${m}`); process.exit(2); };
const VALUED = ['repos', 'topics', 'now'];
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

  die(`unknown command ${JSON.stringify(cmd)}`);
}

if (process.argv[1] && process.argv[1].endsWith('triage-notes.mjs')) main(process.argv.slice(2));
