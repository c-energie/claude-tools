// Tests for triage-notes.mjs. Node standard library only — no package.json, no dependency.
//
//   node --test plugins/context-notes/scripts/triage-notes.test.mjs
//
// Everything here is pure and offline: no Notion, no git, no network. The functions under test
// are the ones that decide where a note could go, and they are worth testing precisely because
// getting them wrong routes one org's notes into another org's repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadConfig, validate, palaceIds, resolveTopic, resolveTopics, sensitiveHits,
  OPTOUT, REPOS_STALE_HOURS,
  collectNotes, selectNotes, sweep, parseNotionDatetime,
  evaluateBatch, renderTable, renderShortlist, renderPlan, shortlistTriggers, DESTINATIONS,
  issueBody, planIssue, planIssues, applyReachability, destinationRepos, TITLE_MAX,
  planNotionRow, planNotionRows, provenance, NOTION_DESTINATIONS,
  parseTaxonomy, checkTags, planThread, planThreads, THREAD_STATUSES,
  parseHandoffItem, classifyHandoff, readHandoffQueue, renderCarriedOver, HANDOFF_KINDS,
} from './triage-notes.mjs';

// ---------------------------------------------------------------- fixtures

const ORGS = [
  { owner: 'c-energie', visibility: 'personal' },
  { owner: 'acme-co', visibility: 'shared' },
];

const NOTES = {
  _comment: 'a comment key, which must be skipped rather than rejected',
  mindPalace: {
    _comment: 'a nested comment key, which must also be skipped',
    dataSource: 'collection://11111111-2222-4333-8444-555555555555',
    database: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  },
  _mindPalaceNote: 'another comment key',
  organisations: ORGS,
  // A short, generic sensitive-terms list.
  sensitiveTerms: ['salary', 'non-disclosure', 'cap table', 'investor', 'moat'],
};

// The repositories that actually exist, as of the list this was written against.
const REPOS = [
  { owner: 'c-energie', name: 'claude-tools' },
  { owner: 'c-energie', name: 'dev-hub' },
  { owner: 'c-energie', name: 'doc-writer' },
  { owner: 'c-energie', name: 'secret-roster' },
  { owner: 'acme-co', name: 'news-watch' },
  { owner: 'acme-co', name: 'website' },
  { owner: 'acme-co', name: 'context' },
  { owner: 'acme-co', name: 'secret-roster' },
  { owner: 'acme-co', name: 'dev-hub-catalogue' },
  { owner: 'somebody-else', name: 'dev-hub' },   // undeclared org: must never be matched
];

const repoList = (gatheredAt) => ({ gatheredAt, repos: REPOS });

let tmp;
const repoWith = (state) => {
  tmp ??= mkdtempSync(join(tmpdir(), 'triage-notes-'));
  const dir = mkdtempSync(join(tmp, 'repo-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'context.json'),
    JSON.stringify({ project: 'Test', contextRepo: 'acme-co/context', state }, null, 2));
  return dir;
};

test.after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the four outcomes

test('a valid block loads and reports as configured', () => {
  const r = loadConfig(repoWith({ notes: NOTES }));
  assert.equal(r.status, 'configured');
  assert.deepEqual(r.errors, []);
  assert.equal(r.notes.organisations.length, 2);
});

test('the four outcomes are distinguishable by status, not by wording', () => {
  const configured = loadConfig(repoWith({ notes: NOTES })).status;
  const unconfigured = loadConfig(repoWith({ notion: {} })).status;
  const optedOut = loadConfig(repoWith({ notes: 'none' })).status;
  const unresolved = loadConfig(null).status;
  assert.deepEqual(
    [configured, unconfigured, optedOut, unresolved],
    ['configured', 'unconfigured', 'opted-out', 'unresolved'],
  );
  assert.equal(new Set([configured, unconfigured, optedOut, unresolved]).size, 4);
});

test('an unconfigured repo names the file it wants edited', () => {
  const dir = repoWith({});
  const r = loadConfig(dir);
  assert.equal(r.status, 'unconfigured');
  assert.match(r.says, /context\.json/);
  assert.match(r.fix, /no default/i);
});

test('every opt-out spelling is recognised, and none of them is an error', () => {
  for (const word of OPTOUT) {
    const r = loadConfig(repoWith({ notes: word }));
    assert.equal(r.status, 'opted-out', `"${word}" should opt out`);
    assert.deepEqual(r.errors, []);
  }
  // Case-insensitively, like every other reader of this sentinel.
  assert.equal(loadConfig(repoWith({ notes: 'NONE' })).status, 'opted-out');
});

test('no context repo is unresolved, not unconfigured — the fixes are different', () => {
  const r = loadConfig(null);
  assert.equal(r.status, 'unresolved');
  assert.match(r.fix, /context-setup|init-context/);
});

// ---------------------------------------------------------------- validation

test('comment keys are skipped, not rejected — including inside mindPalace', () => {
  assert.deepEqual(validate(NOTES), []);
});

test('an organisations entry missing owner or visibility names the entry and the key', () => {
  const e1 = validate({ ...NOTES, organisations: [{ visibility: 'personal' }] });
  assert.ok(e1.some((e) => e.includes('organisations[0]') && e.includes('owner')), e1.join('\n'));

  const e2 = validate({ ...NOTES, organisations: [{ owner: 'c-energie' }] });
  assert.ok(e2.some((e) => e.includes('organisations[0]') && e.includes('c-energie') && e.includes('visibility')), e2.join('\n'));
});

test('a visibility outside personal|shared is an error, not a default of shared', () => {
  const errs = validate({ ...NOTES, organisations: [{ owner: 'x', visibility: 'public' }] });
  assert.ok(errs.some((e) => e.includes('"public"') && e.includes('not personal or shared')), errs.join('\n'));
  assert.ok(errs.some((e) => /not treated as shared by default/i.test(e)), errs.join('\n'));
});

test('the collection:// prefix is required on dataSource and refused on database', () => {
  const bare = validate({ ...NOTES, mindPalace: { dataSource: 'abc', database: 'def' } });
  assert.ok(bare.some((e) => e.includes('dataSource') && e.includes('collection://')), bare.join('\n'));

  const prefixed = validate({ ...NOTES, mindPalace: { dataSource: 'collection://abc', database: 'collection://def' } });
  assert.ok(prefixed.some((e) => e.includes('database') && e.includes('bare database id')), prefixed.join('\n'));
});

test('validation is exhaustive rather than fail-fast', () => {
  const errs = validate({ organisations: 'nope' });
  assert.ok(errs.length >= 3, `expected several faults at once, got ${errs.length}: ${errs.join(' | ')}`);
});

test('palaceIds strips the prefix from dataSource and leaves database bare', () => {
  const ids = palaceIds(NOTES);
  assert.equal(ids.dataSource, '11111111-2222-4333-8444-555555555555');
  assert.equal(ids.database, '66666666-7777-4888-8999-aaaaaaaaaaaa');
});

// ---------------------------------------------------------------- topic resolution

test('a topic equal to a repository name resolves to repo, with owner and visibility', () => {
  const r = resolveTopic('news-watch', REPOS, ORGS);
  assert.equal(r.outcome, 'repo');
  assert.equal(r.repo, 'acme-co/news-watch');
  assert.equal(r.owner, 'acme-co');
  assert.equal(r.visibility, 'shared');       // from the ORGANISATION, not the repository
});

test('visibility follows the organisation, so a personal org gives a personal destination', () => {
  assert.equal(resolveTopic('dev-hub', REPOS, ORGS).visibility, 'personal');
});

test('a topic matching nothing resolves to a thread and names the context repo', () => {
  const r = resolveTopic('general', REPOS, ORGS, { contextRepo: 'acme-co/context' });
  assert.equal(r.outcome, 'thread');
  assert.equal(r.thread, 'acme-co/context');
  assert.equal(r.repo, null);
});

test('repo and thread are distinguishable states, not a value and its absence', () => {
  const a = resolveTopic('website', REPOS, ORGS);
  const b = resolveTopic('nothing-like-this', REPOS, ORGS);
  assert.notEqual(a.outcome, b.outcome);
  assert.ok('outcome' in b, 'a thread outcome still carries an explicit outcome');
});

test('matching is exact: claude does not become claude-tools', () => {
  const r = resolveTopic('claude', REPOS, ORGS, { contextRepo: 'acme-co/context' });
  assert.equal(r.outcome, 'thread');
});

test('matching is exact: dev-hub matches dev-hub alone, not dev-hub-catalogue', () => {
  const r = resolveTopic('dev-hub', REPOS, ORGS);
  assert.equal(r.outcome, 'repo');
  assert.equal(r.repo, 'c-energie/dev-hub');
});

test('an undeclared organisation is never matched, however exact the name', () => {
  // somebody-else/dev-hub exists in the list but its org is not declared, so the only hit is
  // c-energie/dev-hub — this must NOT read as ambiguous.
  const r = resolveTopic('dev-hub', REPOS, ORGS);
  assert.equal(r.outcome, 'repo');
  assert.equal(r.owner, 'c-energie');
});

test('case is reported explicitly, never silently matched and never silently missed', () => {
  const r = resolveTopic('Website', REPOS, ORGS, { contextRepo: 'acme-co/context' });
  assert.equal(r.outcome, 'thread', 'a case difference is not a match');
  assert.deepEqual(r.caseOnly, ['acme-co/website'], 'and the near-miss is named');
});

test('a name matching in two declared organisations is ambiguous and names both', () => {
  const r = resolveTopic('secret-roster', REPOS, ORGS);
  assert.equal(r.outcome, 'ambiguous');
  assert.equal(r.repo, null, 'ambiguous resolves to NEITHER');
  assert.deepEqual(r.candidates.map((c) => c.repo).sort(), ['acme-co/secret-roster', 'c-energie/secret-roster']);
  assert.deepEqual(r.candidates.map((c) => c.visibility).sort(), ['personal', 'shared']);
});

// ---------------------------------------------------------------- freshness

test('a stale repository list still resolves, and the staleness is carried into the result', () => {
  const now = '2026-09-06T12:00:00Z';
  const old = '2026-09-01T12:00:00Z';                       // 120h, well past the threshold
  const out = resolveTopics(['general'], repoList(old), NOTES, { contextRepo: 'acme-co/context', now });
  assert.equal(out.repoList.stale, true);
  assert.ok(out.repoList.ageHours > REPOS_STALE_HOURS);
  assert.equal(out.topics[0].outcome, 'thread', 'it still resolves');
  assert.match(out.topics[0].staleListCaveat, /may be a thread only because a repository was missed/);
});

test('a fresh list attributes nothing, so a thread outcome is about the topic', () => {
  const out = resolveTopics(['general'], repoList('2026-09-06T11:00:00Z'), NOTES,
    { contextRepo: 'acme-co/context', now: '2026-09-06T12:00:00Z' });
  assert.equal(out.repoList.stale, false);
  assert.equal(out.topics[0].staleListCaveat, undefined);
});

test('the nine example topics route as the spec says they do', () => {
  const topics = ['dev-hub', 'news-watch', 'website', 'general', 'notion', 'test', 'claude', 'IP', 'tool-platform'];
  const out = resolveTopics(topics, repoList('2026-09-06T11:00:00Z'), NOTES,
    { contextRepo: 'acme-co/context', now: '2026-09-06T12:00:00Z' });
  const by = Object.fromEntries(out.topics.map((t) => [t.topic, t.repo ?? t.outcome]));
  assert.deepEqual(by, {
    'dev-hub': 'c-energie/dev-hub',
    'news-watch': 'acme-co/news-watch',
    'website': 'acme-co/website',
    // The remaining six have no repository of that exact name, so they are threads.
    // `claude` is a thread because the repository is `claude-tools`; the fix is renaming the
    // Notion topic, not loosening the match. `IP` is a thread rather than a shortlist, which is
    // the honest answer for a topic with no repository.
    'general': 'thread', 'notion': 'thread', 'test': 'thread',
    'claude': 'thread', 'IP': 'thread', 'tool-platform': 'thread',
  });
});

// ---------------------------------------------------------------- sensitive terms

test('sensitive term matching is case-insensitive', () => {
  assert.deepEqual(sensitiveHits('Discussed SALARY bands', ['salary']), ['salary']);
  assert.deepEqual(sensitiveHits('nothing here', ['salary']), []);
});

test('a multi-word term matches across the space it contains', () => {
  assert.deepEqual(sensitiveHits('sent the cap table over', ['cap table']), ['cap table']);
});

test('a short term matching inside a longer unrelated word is the SPECIFIED behaviour, not a bug', () => {
  // This is why `nda` was rejected from the real list: as a substring it hits `standardising`,
  // `standardised` and `foundation`, all ordinary project vocabulary. Left in, it would have
  // shortlisted most of the corpus and made the shortlist the table rather than the exception.
  // The rule is substring matching, so this asserts the trap rather than pretending it is fixed.
  assert.deepEqual(sensitiveHits('we are standardising the foundation', ['nda']), ['nda']);
  assert.deepEqual(sensitiveHits('the equipment recipient description', ['ip']), ['ip']);
  assert.deepEqual(sensitiveHits('that is forbidden', ['bid']), ['bid']);
  // The spelled-out replacements do not have the problem.
  assert.deepEqual(sensitiveHits('we are standardising the foundation', ['non-disclosure']), []);
});

test('no terms means no hits, and an empty list is not an error', () => {
  assert.deepEqual(sensitiveHits('anything at all', []), []);
  assert.deepEqual(validate({ ...NOTES, sensitiveTerms: [] }), []);
});

// ---------------------------------------------------------------- note selection
//
// Fixtures are Mind Palace page shapes: dated `heading_2` sections with note blocks under them,
// and a `heading_3` starting "What this means" introducing the summariser's own output. A
// fixture that stops matching after a Notion API change is RE-CAPTURED, never edited to pass.

const rt = (text) => [{ plain_text: text }];
const heading = (date) => ({ type: 'heading_2', heading_2: { rich_text: rt(date) } });
const delta = (text = 'What this means') => ({ type: 'heading_3', heading_3: { rich_text: rt(text) } });
const bullet = (text, created) => ({
  type: 'bulleted_list_item', created_time: created,
  bulleted_list_item: { rich_text: rt(text) },
});
const para = (text, created) => ({ type: 'paragraph', created_time: created, paragraph: { rich_text: rt(text) } });

const MARKER = '2026-09-03T12:00:00.000Z';

test('a note newer than the marker is selected and an older one is not', () => {
  const page = [heading('2026-09-03'), bullet('older', '2026-09-03T09:00:00.000Z'), bullet('newer', '2026-09-03T15:00:00.000Z')];
  assert.deepEqual(collectNotes(page, new Date(MARKER)).map((n) => n.text), ['newer']);
});

test('a note at exactly the marker instant is already seen — the marker is a watermark', () => {
  const page = [heading('2026-09-03'), bullet('exactly at the marker', MARKER), bullet('one ms later', '2026-09-03T12:00:00.001Z')];
  assert.deepEqual(
    collectNotes(page, new Date(MARKER)).map((n) => n.text),
    ['one ms later'],
    'strictly greater than, so the boundary note is not re-proposed',
  );
});

test('two notes on the SAME DAY either side of the marker are separated — why this is a datetime', () => {
  // A date-only marker cannot do this, and this is exactly the mid-batch resume case: the run
  // wrote the 09:00 note, failed, and must not re-propose it when re-run the same afternoon.
  const page = [heading('2026-09-03'), bullet('written before the failure', '2026-09-03T09:00:00.000Z'), bullet('not yet reached', '2026-09-03T14:00:00.000Z')];
  assert.deepEqual(collectNotes(page, new Date(MARKER)).map((n) => n.text), ['not yet reached']);
  // The same page under a date-granularity marker would yield both, which is the bug.
  assert.equal(collectNotes(page, new Date('2026-09-03T00:00:00.000Z')).length, 2,
    'demonstrating what a date marker would have done');
});

test('a block with no created_time is dated from the heading above it', () => {
  const page = [heading('2026-09-05'), bullet('undated but under a newer heading', undefined)];
  const notes = collectNotes(page, new Date(MARKER));
  assert.deepEqual(notes.map((n) => n.text), ['undated but under a newer heading']);
  assert.equal(notes[0].date, '2026-09-05');
  assert.equal(notes[0].createdTime, null);
});

test('an undated block under a heading at or before the marker date is excluded', () => {
  assert.deepEqual(collectNotes([heading('2026-09-01'), bullet('old and undated', undefined)], new Date(MARKER)), []);
  // "At" as well as before: the heading-date comparison is <=, matching the exact one.
  assert.deepEqual(collectNotes([heading('2026-09-03'), bullet('same day, undated', undefined)], new Date(MARKER)), []);
});

test('the heading fallback over-selects at day granularity rather than losing a note to a timezone edge', () => {
  // 23:30 UTC on the marker day would be "tomorrow" in some zones. With no created_time the only
  // honest comparison is by date, and the rule prefers proposing twice to losing one.
  assert.equal(collectNotes([heading('2026-09-04'), bullet('the day after the marker, undated', undefined)], new Date(MARKER)).length, 1);
});

test('blocks under What this means are never notes — the summariser output is not triaged', () => {
  const page = [
    heading('2026-09-05'), bullet('a real note', '2026-09-05T10:00:00.000Z'),
    delta(), bullet('summary output', '2026-09-05T10:05:00.000Z'), para('more summary', '2026-09-05T10:05:00.000Z'),
  ];
  assert.deepEqual(collectNotes(page, new Date(MARKER)).map((n) => n.text), ['a real note']);
});

test('a later dated heading REOPENS the note section beneath a summary', () => {
  const page = [
    heading('2026-09-04'), bullet('note one', '2026-09-04T10:00:00.000Z'),
    delta(), bullet('summary output', '2026-09-04T10:05:00.000Z'),
    heading('2026-09-05'), bullet('note two, typed after the summary', '2026-09-05T09:00:00.000Z'),
  ];
  assert.deepEqual(collectNotes(page, new Date(MARKER)).map((n) => n.text),
    ['note one', 'note two, typed after the summary']);
});

test('a heading_3 that is not What this means does not close the note section', () => {
  const page = [heading('2026-09-05'), delta('Some other heading'), bullet('still a note', '2026-09-05T10:00:00.000Z')];
  assert.deepEqual(collectNotes(page, new Date(MARKER)).map((n) => n.text), ['still a note']);
});

test('non-note block types between notes do not break heading tracking', () => {
  const page = [
    heading('2026-09-05'),
    { type: 'divider', divider: {} },
    { type: 'image', image: {} },
    { type: 'to_do', created_time: '2026-09-05T10:00:00.000Z', to_do: { rich_text: rt('a to-do is not a note') } },
    bullet('after the noise', undefined),
  ];
  const notes = collectNotes(page, new Date(MARKER));
  assert.deepEqual(notes.map((n) => n.text), ['after the noise']);
  assert.equal(notes[0].date, '2026-09-05', 'the heading is still tracked across the non-note blocks');
});

test('all three note-bearing block types are notes, and only those three', () => {
  const page = [
    heading('2026-09-05'),
    bullet('bulleted', '2026-09-05T10:00:00.000Z'),
    { type: 'numbered_list_item', created_time: '2026-09-05T10:01:00.000Z', numbered_list_item: { rich_text: rt('numbered') } },
    para('paragraph', '2026-09-05T10:02:00.000Z'),
    { type: 'quote', created_time: '2026-09-05T10:03:00.000Z', quote: { rich_text: rt('quoted') } },
  ];
  assert.deepEqual(collectNotes(page, new Date(MARKER)).map((n) => n.text), ['bulleted', 'numbered', 'paragraph']);
});

test('an empty block is not a note', () => {
  const page = [heading('2026-09-05'), bullet('   ', '2026-09-05T10:00:00.000Z'), bullet('real', '2026-09-05T10:01:00.000Z')];
  assert.deepEqual(collectNotes(page, new Date(MARKER)).map((n) => n.text), ['real']);
});

test('a never-triaged topic (marker null) yields every note on the page', () => {
  const page = [heading('2026-01-01'), bullet('ancient', '2026-01-01T10:00:00.000Z'), bullet('undated', undefined)];
  assert.equal(collectNotes(page, null).length, 2);
});

// ---------------------------------------------------------------- dedup and the sweep

test('identical text repeated in one page collapses to one row, keeping the earlier', () => {
  const page = [
    heading('2026-09-05'),
    bullet('Ask Sam about the grant bid', '2026-09-05T09:00:00.000Z'),
    bullet('ask   sam  about the GRANT bid', '2026-09-05T11:00:00.000Z'),   // the same note, retyped
  ];
  const s = selectNotes('general', page, MARKER);
  assert.equal(s.notes.length, 1, 'a bullet typed twice must not become two issues');
  assert.equal(s.notes[0].createdTime, '2026-09-05T09:00:00.000Z', 'the earlier occurrence is when it was said');
  assert.equal(s.duplicatesCollapsed, 1);
});

test('identical text under two topics stays two rows — that is the cross-cutting case', () => {
  const page = () => [heading('2026-09-05'), bullet('the same thought', '2026-09-05T09:00:00.000Z')];
  const a = selectNotes('IP', page(), MARKER);
  const b = selectNotes('website', page(), MARKER);
  assert.equal(a.notes.length + b.notes.length, 2,
    'collapsing across pages would hide the merge the classifier exists to notice');
});

test('a Settled topic is swept like any other', () => {
  const page = [heading('2026-09-05'), bullet('typed against a settled topic', '2026-09-05T10:00:00.000Z')];
  const s = selectNotes('closed-topic', page, MARKER, { settled: true });
  assert.equal(s.settled, true);
  assert.deepEqual(s.notes.map((n) => n.text), ['typed against a settled topic'],
    'silently ignoring it would lose work with nothing to show it happened');
});

test('a page with no new notes yields an empty result rather than an error', () => {
  const s = selectNotes('quiet', [heading('2026-09-01'), bullet('old', '2026-09-01T10:00:00.000Z')], MARKER);
  assert.deepEqual(s.notes, []);
  assert.equal(s.lastTriaged, MARKER);
});

test('a whole run of empty results reports nothing new, and says what it swept', () => {
  const quiet = [heading('2026-09-01'), bullet('old', '2026-09-01T10:00:00.000Z')];
  const out = sweep([
    selectNotes('a', quiet, MARKER),
    selectNotes('b', quiet, MARKER, { settled: true }),
    selectNotes('c', [], MARKER),
  ]);
  assert.equal(out.nothingNew, true);
  assert.equal(out.newNotes, 0);
  assert.equal(out.topicsSwept, 3, 'a silent no-op must be distinguishable from a run that did not happen');
  assert.equal(out.settledSwept, 1);
});

test('a run with anything new does not short circuit', () => {
  const out = sweep([
    selectNotes('a', [heading('2026-09-05'), bullet('new', '2026-09-05T10:00:00.000Z')], MARKER),
    selectNotes('b', [], MARKER),
  ]);
  assert.equal(out.nothingNew, false);
  assert.equal(out.newNotes, 1);
});

// ---------------------------------------------------------------- the mirrored port
//
// This fixture is the page shape the summariser's own Python tests use. It is here so that a
// divergence between collect_notes() in c-energie/bots and collectNotes() here shows up as a
// failing assertion rather than as a difference nobody looks at.

test('the summariser page shape yields the same notes here as it does in Python', () => {
  const page = [
    heading('2026-08-01'),
    bullet('first note', '2026-08-01T09:00:00.000Z'),
    bullet('second note', '2026-08-01T09:05:00.000Z'),
    delta(),
    para('a previously written summary', '2026-08-01T10:00:00.000Z'),
    heading('2026-08-02'),
    bullet('third note', '2026-08-02T09:00:00.000Z'),
  ];
  // Whole page: three notes, the summary excluded, each heading carried onto its notes.
  assert.deepEqual(collectNotes(page, null), [
    { date: '2026-08-01', text: 'first note', createdTime: '2026-08-01T09:00:00.000Z' },
    { date: '2026-08-01', text: 'second note', createdTime: '2026-08-01T09:05:00.000Z' },
    { date: '2026-08-02', text: 'third note', createdTime: '2026-08-02T09:00:00.000Z' },
  ]);
  // Since the first note: the other two, in page order.
  assert.deepEqual(
    collectNotes(page, new Date('2026-08-01T09:00:00.000Z')).map((n) => n.text),
    ['second note', 'third note'],
  );
});

test('parseNotionDatetime falls back to the leading date, and returns null for nonsense', () => {
  assert.equal(parseNotionDatetime('2026-09-05T10:00:00.000Z').toISOString(), '2026-09-05T10:00:00.000Z');
  assert.equal(parseNotionDatetime('2026-09-05').toISOString(), '2026-09-05T00:00:00.000Z');
  assert.equal(parseNotionDatetime(null), null);
  assert.equal(parseNotionDatetime('not a date at all'), null);
});

// ---------------------------------------------------------------- the shortlist and the table
//
// Everything under test here is the SCRIPT's half — rule evaluation and rendering. The
// classification itself is judgement, and is exercised by running the skill with --classify
// against the real Mind Palace, which is safe precisely because nothing writes.

const RES = (topic, outcome, extra = {}) => ({ topic, outcome, repo: null, thread: null, visibility: null, candidates: [], ...extra });
const RES_REPO = (topic, repo, visibility) => RES(topic, 'repo', { repo, visibility, owner: repo.split('/')[0] });
const RES_THREAD = (topic) => RES(topic, 'thread', { thread: 'acme-co/context' });
const RES_AMBIG = (topic) => RES(topic, 'ambiguous', {
  candidates: [
    { repo: 'c-energie/secret-roster', owner: 'c-energie', visibility: 'personal' },
    { repo: 'acme-co/secret-roster', owner: 'acme-co', visibility: 'shared' },
  ],
});

// A row that fires NOTHING, so each trigger below can be shown firing on its own.
const CLEAN = {
  id: '1', topic: 'dev-hub', note: 'Add a --dry-run flag to the catalogue writer',
  destination: 'issue', target: 'c-energie/dev-hub', why: 'closes when the PR merges, and the repository is named',
};
const CLEAN_RES = [RES_REPO('dev-hub', 'c-energie/dev-hub', 'personal')];

test('the clean control row fires no shortlist trigger at all', () => {
  const b = evaluateBatch([CLEAN], CLEAN_RES, NOTES);
  assert.deepEqual(b.errors, []);
  assert.equal(b.shortlist.length, 0);
  assert.equal(b.table.length, 1);
});

test('trigger 1 of 5: an ambiguous topic resolution shortlists on its own', () => {
  const row = { ...CLEAN, topic: 'secret-roster', destination: 'thread', target: null, why: 'reasoning a later reader needs' };
  const b = evaluateBatch([row], [RES_AMBIG('secret-roster')], NOTES);
  assert.deepEqual(b.rows[0].triggers, ['ambiguousTopic']);
  assert.equal(b.table.length, 0);
});

test('an ambiguous topic names both organisations and never targets either', () => {
  const row = { ...CLEAN, topic: 'secret-roster', destination: 'thread', target: null, why: 'reasoning a later reader needs' };
  const b = evaluateBatch([row], [RES_AMBIG('secret-roster')], NOTES);
  const expanded = renderShortlist(b);
  assert.match(expanded, /c-energie\/secret-roster \(personal\)/);
  assert.match(expanded, /acme-co\/secret-roster \(shared\)/);
  assert.equal(b.rows[0].target, null, 'resolves to NEITHER, so nothing is targeted');
  assert.equal(renderTable(b).includes('secret-roster'), false, 'and it is absent from the main table');
});

test('trigger 2 of 5: an issue whose repository cannot be named shortlists on its own', () => {
  const row = { ...CLEAN, topic: 'dev-hub', destination: 'issue', target: null, why: 'sounds like code work' };
  // Target is null and the topic resolves to a repo, so the fallback fills it — force the
  // unnameable case with a topic that resolves to nothing at all.
  const b = evaluateBatch([{ ...row, topic: 'unknown-topic' }], [], NOTES);
  assert.deepEqual(b.rows[0].triggers, ['unnameableRepo']);
  assert.match(renderShortlist(b), /whichever repository seemed closest/);
});

test('trigger 3 of 5: a sensitiveTerms hit shortlists on its own', () => {
  const row = { ...CLEAN, note: 'Check the cap table before Thursday' };
  const b = evaluateBatch([row], CLEAN_RES, NOTES);
  assert.deepEqual(b.rows[0].triggers, ['sensitiveTerm']);
});

test('a sensitiveTerms hit beats a clean classification — the check cannot be reasoned around', () => {
  // The topic resolves cleanly to a repository and the classification is confident and correct.
  // The term still wins, because it is a policy set in config and not a judgement made at run time.
  const row = { ...CLEAN, note: 'Add a --dry-run flag; also the salary review is due' };
  const b = evaluateBatch([row], CLEAN_RES, NOTES);
  assert.equal(b.rows[0].shortlisted, true);
  assert.deepEqual(b.rows[0].triggers, ['sensitiveTerm']);
  assert.equal(b.table.length, 0, 'a clean classification does not rescue it');
});

test('trigger 4 of 5: a shared destination shortlists, and the same row under personal does not', () => {
  const shared = evaluateBatch(
    [{ ...CLEAN, topic: 'website', target: 'acme-co/website', why: 'closes when the PR merges' }],
    [RES_REPO('website', 'acme-co/website', 'shared')], NOTES);
  assert.deepEqual(shared.rows[0].triggers, ['sharedDestination']);

  const personal = evaluateBatch([CLEAN], CLEAN_RES, NOTES);
  assert.deepEqual(personal.rows[0].triggers, [], 'the identical shape under a personal org is not shortlisted');
});

test('trigger 5 of 5: a note that would be written directly shortlists on its own', () => {
  const b = evaluateBatch([{ ...CLEAN, wouldWriteDirectly: true }], CLEAN_RES, NOTES);
  assert.deepEqual(b.rows[0].triggers, ['wouldWriteDirectly']);
});

test('a note hitting two triggers appears ONCE with both reasons named', () => {
  const row = { ...CLEAN, topic: 'website', target: 'acme-co/website', note: 'ship the investor page' };
  const b = evaluateBatch([row], [RES_REPO('website', 'acme-co/website', 'shared')], NOTES);
  assert.equal(b.shortlist.length, 1, 'once, not twice');
  assert.deepEqual(b.rows[0].triggers.sort(), ['sensitiveTerm', 'sharedDestination']);
  assert.equal(b.rows[0].shortlistReasons.length, 2, 'half a reason is not why it stopped');
});

test('the triggers are rules, not a score — nothing carries a confidence number', () => {
  const b = evaluateBatch([CLEAN], CLEAN_RES, NOTES);
  const json = JSON.stringify(b);
  assert.equal(/confidence|score|threshold/i.test(json), false,
    'a threshold that feels tunable and is not would be worse than no number at all');
});

// ---------------------------------------------------------------- the gated issue branch

test('a topic resolving to thread produces no issue row anywhere in the batch', () => {
  const row = { ...CLEAN, topic: 'IP', target: null, destination: 'issue', why: 'reads like code work' };
  const b = evaluateBatch([row], [RES_THREAD('IP')], NOTES);
  assert.ok(b.errors.some((e) => /resolved to thread/.test(e)),
    'the issue branch does not apply, and saying so is better than routing it nowhere');
  assert.equal(b.rows.filter((r) => r.destination === 'issue' && !r.shortlisted).length, 0);
});

test('under a thread topic the test starts at the action branch instead', () => {
  const row = { id: '1', topic: 'IP', note: 'Jamie to send the pricing argument by Friday', destination: 'action', target: null, why: 'a dated commitment by a named person, and not code' };
  const b = evaluateBatch([row], [RES_THREAD('IP')], NOTES);
  assert.deepEqual(b.errors, []);
  assert.equal(b.table.length, 1);
  assert.equal(b.table[0].destination, 'action');
});

// ---------------------------------------------------------------- rendering

test('rendering refuses a row with an empty or missing why', () => {
  const empty = evaluateBatch([{ ...CLEAN, why: '   ' }], CLEAN_RES, NOTES);
  assert.ok(empty.errors.some((e) => /"why" is empty/.test(e)));
  const missing = evaluateBatch([{ ...CLEAN, why: undefined }], CLEAN_RES, NOTES);
  assert.ok(missing.errors.some((e) => /"why" is empty/.test(e)));
  assert.match(renderTable(missing), /REFUSED/);
});

test('rendering refuses a destination outside the six', () => {
  const b = evaluateBatch([{ ...CLEAN, destination: 'slack' }], CLEAN_RES, NOTES);
  assert.ok(b.errors.some((e) => /not one of/.test(e)));
});

test('every row carries topic, note, destination, target and why', () => {
  const out = renderTable(evaluateBatch([CLEAN], CLEAN_RES, NOTES));
  for (const h of ['topic', 'note', 'destination', 'target', 'why']) assert.match(out, new RegExp(h));
  assert.match(out, /dev-hub/);
  assert.match(out, /closes when the PR merges/);
});

test('an overrule renders BOTH the resolved value and the overrule, and states its reason', () => {
  const row = { ...CLEAN, target: 'c-energie/doc-writer', why: 'the note names doc-writer explicitly, not the topic repo' };
  const b = evaluateBatch([row], CLEAN_RES, NOTES);
  assert.equal(b.rows[0].overruled, true);
  const out = renderTable(b);
  assert.match(out, /c-energie\/dev-hub -> c-energie\/doc-writer/, 'an overrule is a visible claim');
  assert.match(out, /OVERRULED/);
  assert.match(out, /names doc-writer explicitly/);
});

test('shortlisted rows are absent from the table and counted in the undecided line', () => {
  const b = evaluateBatch([CLEAN, { ...CLEAN, id: '2', note: 'the cap table needs updating' }], CLEAN_RES, NOTES);
  const out = renderTable(b);
  assert.equal(out.includes('cap table'), false, 'the table stays the thing that gets read');
  assert.match(out, /still undecided \(1\)/);
  assert.match(renderShortlist(b), /cap table/, 'and the expanded form lists it with its reasons');
});

test('the expanded shortlist says it need not be decided now, and why the count matters', () => {
  const b = evaluateBatch([{ ...CLEAN, note: 'the cap table needs updating' }], CLEAN_RES, NOTES);
  const out = renderShortlist(b);
  assert.match(out, /Shortlisted datetime/, 'so it does not resurface every run');
  assert.match(out, /NOT asked to decide/, 'hesitation must not be converted into a bad routing');
  assert.match(out, /only grows/, 'a growing count is evidence the routing test is wrong');
});

test('an amendment re-renders that row only, and the rest of the batch is untouched', () => {
  const rows = [CLEAN, { ...CLEAN, id: '2', topic: 'news-watch', note: 'second note', target: null }, { ...CLEAN, id: '3', note: 'third note' }];
  const res = [...CLEAN_RES, RES_THREAD('news-watch')];
  const before = evaluateBatch(rows, res, NOTES);

  const amended = rows.map((r) => (r.id === '3' ? { ...r, destination: 'thread', target: null, why: 'reasoning a later reader needs, after all' } : r));
  const after = evaluateBatch(amended, res, NOTES);

  const only = renderTable(after, { only: ['3'] });
  assert.match(only, /third note/);
  assert.equal(only.includes('Add a --dry-run flag to the catalogue writer\n'), false);

  // Everything not amended came out identical.
  const strip = (b) => b.rows.filter((r) => r.id !== '3').map((r) => JSON.stringify(r));
  assert.deepEqual(strip(after), strip(before));
});

test('the whole sweep is ONE table with topic as a column, so a cross-cutting note is visible', () => {
  const rows = [
    { id: '1', topic: 'dev-hub', note: 'the catalogue needs a dry run', destination: 'issue', target: 'c-energie/dev-hub', why: 'closes on merge' },
    { id: '2', topic: 'notion', note: 'the catalogue needs a dry run', destination: 'thread', target: null, why: 'reasoning a later reader needs' },
  ];
  const out = renderTable(evaluateBatch(rows, [...CLEAN_RES, RES_THREAD('notion')], NOTES));
  assert.equal((out.match(/the catalogue needs a dry run/g) ?? []).length, 2,
    'three bullets under three topics have to be seeable as one issue');
});

test('the approved plan groups by destination and is printed before anything is written', () => {
  const rows = [
    CLEAN,
    { id: '2', topic: 'IP', note: 'Jamie to write it up by Friday', destination: 'action', target: null, why: 'a dated commitment by a named person' },
    { id: '3', topic: 'IP', note: 'why the pricing model is the moat', destination: 'thread', target: null, why: 'reasoning a later reader needs' },
  ];
  const b = evaluateBatch(rows, [...CLEAN_RES, RES_THREAD('IP')], NOTES);
  const plan = renderPlan(b);
  assert.match(plan, /APPROVED PLAN/);
  assert.match(plan, /issue \(1\)/);
  assert.match(plan, /action \(1\)/);
  // `moat` is a sensitive term, so row 3 shortlisted rather than reaching the plan.
  assert.match(plan, /1 shortlisted/);
});

test('exactly one destination per note — a row is one row', () => {
  const b = evaluateBatch([CLEAN], CLEAN_RES, NOTES);
  assert.equal(b.rows.length, 1);
  assert.equal(typeof b.rows[0].destination, 'string', 'not a list: the table stays flat and there is no partial-failure story');
});

// ---------------------------------------------------------------- GitHub issue creation
//
// The testable surface is the COMMAND PLAN and the BODY, not the execution: `gh` is invoked by
// the model, and shelling out to GitHub in a unit test would make the suite depend on a network
// and a credential.

const PROJECTS = { 'c-energie/dev-hub': 'dev-hub board' };

const ISSUE_ROW = {
  id: '1', topic: 'dev-hub', note: 'Add a --dry-run flag to the catalogue writer',
  destination: 'issue', target: 'c-energie/dev-hub', visibility: 'personal',
  title: 'Add a --dry-run flag to the catalogue writer',
  why: 'closes when a pull request merges, and the repository is named',
  capturedAt: '2026-09-05', topicUrl: 'https://notion.so/topic-dev-hub',
};

test('the body renders the note VERBATIM, with no escaping damage', () => {
  // Backticks, a line break and a quotation mark: the three things a --body shell argument
  // mangles, which is why the plan uses --body-file.
  const note = 'Use `--dry-run` before it "ships".\nSecond line, with a $VARIABLE and a \\backslash.';
  const body = issueBody({ note, topic: 'dev-hub', capturedAt: '2026-09-05', topicUrl: 'https://notion.so/x' });
  assert.ok(body.startsWith(note), 'the user\'s own phrasing, not a paraphrase of it');
  assert.match(body, /\$VARIABLE/);
  assert.match(body, /\\backslash/);
  assert.match(body, /`--dry-run`/);
});

test('the provenance line names the topic, the capture date and the topic page link', () => {
  const body = issueBody({ note: 'x', topic: 'dev-hub', capturedAt: '2026-09-05', topicUrl: 'https://notion.so/topic-dev-hub' });
  assert.match(body, /dev-hub/);
  assert.match(body, /2026-09-05/);
  assert.match(body, /https:\/\/notion\.so\/topic-dev-hub/);
  assert.match(body, /still lives on its topic page/, 'triage never deletes or edits a captured note');
});

test('a missing capture date says so rather than inventing one', () => {
  assert.match(issueBody({ note: 'x', topic: 't' }), /an unrecorded date/);
});

test('an empty or whitespace-only title is rejected before a command is planned', () => {
  for (const title of ['', '   ', undefined]) {
    const p = planIssue({ ...ISSUE_ROW, title }, { projects: PROJECTS });
    assert.equal(p.ok, false, `title ${JSON.stringify(title)} should be rejected`);
    assert.match(p.reason, /title is empty/);
  }
});

test('a title longer than the limit is rejected — it is a title, not the note', () => {
  const p = planIssue({ ...ISSUE_ROW, title: 'x'.repeat(TITLE_MAX + 1) }, { projects: PROJECTS });
  assert.equal(p.ok, false);
  assert.match(p.reason, /characters \(max/);
});

test('the planned command carries --project when the repository has one', () => {
  const p = planIssue(ISSUE_ROW, { projects: PROJECTS });
  assert.equal(p.ok, true);
  assert.deepEqual(p.argv.slice(0, 6), ['issue', 'create', '--repo', 'c-energie/dev-hub', '--title', ISSUE_ROW.title]);
  assert.ok(p.argv.includes('--project'));
  assert.equal(p.argv[p.argv.indexOf('--project') + 1], 'dev-hub board');
  assert.equal(p.projectSkipped, null);
  assert.ok(p.argv.includes('--body-file'), 'a body FILE, because note text is arbitrary prose');
});

test('a repository with no project creates the issue anyway and states the skip', () => {
  const p = planIssue({ ...ISSUE_ROW, target: 'c-energie/doc-writer' }, { projects: PROJECTS });
  assert.equal(p.ok, true, 'a missing board must not block the write');
  assert.equal(p.argv.includes('--project'), false);
  assert.match(p.projectSkipped, /no project configured/);
});

test('a shared destination NEVER produces a create command', () => {
  const p = planIssue({ ...ISSUE_ROW, target: 'acme-co/website', visibility: 'shared' }, { projects: PROJECTS });
  assert.equal(p.ok, false);
  assert.equal(p.shortlist, true);
  assert.match(p.reason, /flagged shared/);
  assert.match(p.reason, /handoff/, 'shortlist or handoff, never a direct write from a personal session');
});

test('a row whose repository cannot be named never reaches a command', () => {
  const p = planIssue({ ...ISSUE_ROW, target: null }, { projects: PROJECTS });
  assert.equal(p.ok, false);
  assert.equal(p.shortlist, true);
  assert.match(p.reason, /no issue is opened on a guess/);
});

test('an unreachable repository shortlists BY NAME, so the credential to widen is obvious', () => {
  const p = planIssue(ISSUE_ROW, { projects: PROJECTS, unreachable: ['c-energie/dev-hub'] });
  assert.equal(p.ok, false);
  assert.match(p.reason, /c-energie\/dev-hub could not be reached/);
  assert.match(p.reason, /widen the token that covers c-energie/);
});

test('an unreachable repository moves ALL its rows to the shortlist and leaves others alone', () => {
  const rows = [
    ISSUE_ROW,
    { ...ISSUE_ROW, id: '2', note: 'another dev-hub note' },
    { ...ISSUE_ROW, id: '3', topic: 'doc-writer', target: 'c-energie/doc-writer', note: 'a doc-writer note' },
  ];
  const res = [
    RES_REPO('dev-hub', 'c-energie/dev-hub', 'personal'),
    RES_REPO('doc-writer', 'c-energie/doc-writer', 'personal'),
  ];
  const batch = applyReachability(evaluateBatch(rows, res, NOTES), ['c-energie/dev-hub']);
  assert.deepEqual(batch.shortlist.map((r) => r.id).sort(), ['1', '2']);
  assert.deepEqual(batch.table.map((r) => r.id), ['3'], 'one bad repository does not abandon the batch');
  assert.ok(batch.shortlist[0].shortlistReasons.some((r) => /does not list it/.test(r)));
});

test('reachability is checked once per DISTINCT destination repository', () => {
  const rows = [
    ISSUE_ROW,
    { ...ISSUE_ROW, id: '2', note: 'another dev-hub note' },
    { ...ISSUE_ROW, id: '3', topic: 'doc-writer', target: 'c-energie/doc-writer', note: 'a doc-writer note' },
  ];
  const res = [RES_REPO('dev-hub', 'c-energie/dev-hub', 'personal'), RES_REPO('doc-writer', 'c-energie/doc-writer', 'personal')];
  assert.deepEqual(destinationRepos(evaluateBatch(rows, res, NOTES)), ['c-energie/dev-hub', 'c-energie/doc-writer']);
});

test('the plan is one command per row, in table order, so a failure is attributable', () => {
  const rows = [
    { ...ISSUE_ROW, id: 'a' },
    { ...ISSUE_ROW, id: 'b', note: 'second note', title: 'Second' },
    { id: 'c', topic: 'IP', note: 'reasoning', destination: 'thread', target: null, why: 'a future reader needs it' },
  ];
  const res = [RES_REPO('dev-hub', 'c-energie/dev-hub', 'personal'), RES_THREAD('IP')];
  const { plans } = planIssues(evaluateBatch(rows, res, NOTES), { projects: PROJECTS });
  assert.deepEqual(plans.map((p) => p.id), ['a', 'b'], 'one per issue row, in order; non-issue rows are not planned here');
});

test('a non-issue row is never planned as one', () => {
  const p = planIssue({ ...ISSUE_ROW, destination: 'action' }, { projects: PROJECTS });
  assert.equal(p.ok, false);
  assert.match(p.reason, /not issue/);
});

test('the optional projects map validates, and is keyed by repository not by topic', () => {
  assert.deepEqual(validate({ ...NOTES, projects: { 'c-energie/dev-hub': 'Board', 'acme-co/website': 3 } }), []);
  const bad = validate({ ...NOTES, projects: { 'dev-hub': 'Board' } });
  assert.ok(bad.some((e) => /is not an owner\/repo name/.test(e)),
    'keyed by repository, so it cannot decide where a note goes — only which board an issue lands on');
  assert.ok(validate({ ...NOTES, projects: [] }).some((e) => /not an object/.test(e)));
  assert.deepEqual(validate({ ...NOTES }), [], 'and it is optional: absent is normal');
});

// ---------------------------------------------------------------- Notion rows
//
// What is testable here is ARGUMENT FORMATTING and the FALLBACK DECISION. The Notion write itself
// is another skill's behaviour and is covered by that skill — which is the whole point: this file
// holds no Notion property names, so a schema change is a one-file change in context-notion.

const PROV = { capturedAt: '2026-09-05', topicUrl: 'https://notion.so/topic-IP' };

const ACTION_ROW = {
  id: '1', topic: 'IP', destination: 'action',
  note: 'Send the pricing-model argument to Sam',
  owner: 'Jamie Corson', due: '2026-09-11', why: 'a dated commitment by a named person', ...PROV,
};
const QUESTION_ROW = {
  id: '2', topic: 'notion', destination: 'open-question',
  note: 'Do we still need the people relation on the meetings database?',
  why: 'an unanswered question', ...PROV,
};
const DECISION_ROW = {
  id: '3', topic: 'general', destination: 'decision',
  note: 'We now write meeting summaries before the actions, not after',
  decision: 'Meeting summaries are written before the actions, not after',
  rationale: 'the actions were being written from memory rather than from the summary',
  why: 'it changed how the team operates', ...PROV,
};

test('this file holds NO Notion property names — that is the design, so assert it', () => {
  const src = readFileSync(new URL('./triage-notes.mjs', import.meta.url), 'utf8');
  // The traps that live in context-notion and must not be re-implemented here.
  for (const trap of ['Type ', 'Watching', 'Not started', 'pageParents', 'data_source_id']) {
    assert.equal(src.includes(`'${trap}'`), false, `"${trap}" must not be a value in this file`);
  }
});

test('an action carries the note, the owner and the due date exactly as the row held them', () => {
  const p = planNotionRow(ACTION_ROW);
  assert.equal(p.ok, true);
  assert.equal(p.skill, 'context-notion:add-action');
  assert.equal(p.args.task, ACTION_ROW.note);
  assert.equal(p.args.owner, 'Jamie Corson');
  assert.equal(p.args.due, '2026-09-11');
});

test('an action with no owner is refused rather than written with a guessed one', () => {
  const p = planNotionRow({ ...ACTION_ROW, owner: undefined });
  assert.equal(p.ok, false);
  assert.equal(p.shortlist, true);
  assert.match(p.reason, /assigns somebody work they never agreed to/);
});

test('an action with no date is refused rather than given a substituted deadline', () => {
  const p = planNotionRow({ ...ACTION_ROW, due: null });
  assert.equal(p.ok, false);
  assert.match(p.reason, /a commitment nobody made/);
});

test('an open question carries a question-shaped title', () => {
  const p = planNotionRow(QUESTION_ROW);
  assert.equal(p.ok, true);
  assert.equal(p.skill, 'context-notion:add-open-question');
  assert.match(p.args.question, /\?$/);
});

test('a row whose text is not a question is rejected before an argument set is built', () => {
  const p = planNotionRow({ ...QUESTION_ROW, note: 'The people relation may not be needed' });
  assert.equal(p.ok, false);
  assert.equal(p.args, undefined, 'no argument set is built at all');
  assert.match(p.reason, /title property is a question/);
});

test('a decision carries a statement DISTINCT from the topic', () => {
  const p = planNotionRow(DECISION_ROW);
  assert.equal(p.ok, true);
  assert.equal(p.skill, 'context-notion:log-decision');
  assert.notEqual(p.args.decision, DECISION_ROW.topic);
  assert.match(p.args.decision, /before the actions/);
});

test('a decision that is only the topic name is refused — the log has to be readable', () => {
  const bare = planNotionRow({ ...DECISION_ROW, decision: 'general' });
  assert.equal(bare.ok, false);
  assert.match(bare.reason, /just the topic name/);
  const none = planNotionRow({ ...DECISION_ROW, decision: null });
  assert.equal(none.ok, false);
  assert.match(none.reason, /without opening every row/);
});

test('a decision with no rationale gets an EMPTY one, never an invented one', () => {
  const p = planNotionRow({ ...DECISION_ROW, rationale: undefined });
  assert.equal(p.ok, true, 'a gap does not block the row');
  assert.equal(p.args.rationale, '', 'a log that acquires reasoning nobody gave is worse than one with a gap');
});

test('every argument set carries provenance: topic, capture date and link', () => {
  for (const row of [ACTION_ROW, QUESTION_ROW, DECISION_ROW]) {
    const p = planNotionRow(row);
    assert.match(p.args.notes, new RegExp(row.topic));
    assert.match(p.args.notes, /2026-09-05/);
    assert.match(p.args.notes, /https:\/\/notion\.so\/topic-IP/);
  }
});

test('text needing shell quoting passes through unaltered — arguments go to a skill, not a shell', () => {
  const nasty = 'Ask "Sam" about $BUDGET & the `pricing`; 100% of it\nsecond line';
  const p = planNotionRow({ ...ACTION_ROW, note: nasty });
  assert.equal(p.args.task, nasty, 'no escaping, no mangling — nothing here builds a command line');
});

// ---------------------------------------------------------------- the add-pending fallback

test('with the connector unavailable each destination queues instead of writing', () => {
  const rows = [ACTION_ROW, QUESTION_ROW, DECISION_ROW];
  const res = [RES_THREAD('IP'), RES_THREAD('notion'), RES_THREAD('general')];
  const batch = evaluateBatch(rows, res, NOTES);
  const out = planNotionRows(batch, { connectorAvailable: false });

  assert.equal(out.writes.length, 0, 'nothing is written');
  assert.equal(out.queued.length, 3, 'and nothing is dropped');
  assert.deepEqual(out.queued.map((q) => q.queuedAs).sort(), ['action', 'decision', 'open-question']);
  for (const q of out.queued) {
    assert.equal(q.skill, 'context-notion:add-pending');
    assert.equal(q.drain, 'context-notion:process-pending', 'the summary has to name what drains it');
  }
});

test('with the connector available the same batch writes and queues nothing', () => {
  const batch = evaluateBatch([ACTION_ROW, QUESTION_ROW, DECISION_ROW],
    [RES_THREAD('IP'), RES_THREAD('notion'), RES_THREAD('general')], NOTES);
  const out = planNotionRows(batch, { connectorAvailable: true });
  assert.equal(out.writes.length, 3);
  assert.equal(out.queued.length, 0);
});

test('a non-Notion row is never planned as one', () => {
  const p = planNotionRow({ id: '9', topic: 'dev-hub', destination: 'issue', note: 'x' });
  assert.equal(p.ok, false);
  assert.match(p.reason, /not a Notion row/);
});

test('a shortlisted row never reaches the Notion planner', () => {
  // `salary` is a sensitiveTerms entry, so this shortlists in #13 before it gets here.
  const batch = evaluateBatch([{ ...ACTION_ROW, note: 'Ask about the salary review' }], [RES_THREAD('IP')], NOTES);
  const out = planNotionRows(batch, { connectorAvailable: true });
  assert.equal(out.writes.length, 0);
  assert.equal(out.queued.length, 0);
});

// ---------------------------------------------------------------- threads
//
// The testable surface is MATERIAL and ARGUMENT construction plus the taxonomy and boundary
// checks — not the file write, which belongs to save-thread and is covered there.

const TAXONOMY = parseTaxonomy(`
version: 1

topics:
  platform:
    description: The platform as a whole.
  ip:
    description: Intellectual property and what protects it.
  supplier:
    description: Component suppliers.

aliases:
  suppliers: supplier
  component-supplier: supplier
`);

const THREAD_ROW = {
  id: '1', topic: 'IP', destination: 'thread',
  note: 'The window is not a moat; what would make it one is the pricing model.',
  why: 'reasoning a future reader needs', capturedAt: '2026-09-05',
  topicUrl: 'https://notion.so/topic-IP',
  threadTitle: 'Why the window is not a moat', topics: ['ip'],
};

test('the taxonomy parser reads the tags and the aliases and nothing else', () => {
  assert.deepEqual([...TAXONOMY.topics].sort(), ['ip', 'platform', 'supplier']);
  assert.equal(TAXONOMY.aliases.get('suppliers'), 'supplier');
  assert.equal(TAXONOMY.topics.has('version'), false, 'a top-level key is not a topic');
  assert.equal(TAXONOMY.topics.has('description'), false, 'nor is a nested one');
});

// Opt-in: set TRIAGE_REAL_TAXONOMY to a context repo's taxonomy.yml to run it.
test('it parses a real taxonomy.yml, not just a fixture', { skip: !process.env.TRIAGE_REAL_TAXONOMY }, () => {
  const real = parseTaxonomy(readFileSync(process.env.TRIAGE_REAL_TAXONOMY, 'utf8'));
  assert.ok(real.topics.size > 0, `expected a populated vocabulary, got ${real.topics.size}`);
  assert.equal(real.topics.has('version'), false, 'a top-level key is not a topic');
});

test('a tag present in the taxonomy passes', () => {
  const p = planThread({ title: 'x', topics: ['ip'], rows: [THREAD_ROW] }, { taxonomy: TAXONOMY, resolvedRepo: 'acme-co/context' });
  assert.equal(p.ok, true);
  assert.deepEqual(p.topics, ['ip']);
});

test('an alias resolves to its canonical tag rather than being rejected', () => {
  const p = planThread({ title: 'x', topics: ['suppliers'], rows: [THREAD_ROW] }, { taxonomy: TAXONOMY, resolvedRepo: 'acme-co/context' });
  assert.equal(p.ok, true);
  assert.deepEqual(p.topics, ['supplier'], 'rejecting an alias would orphan the rename aliases exist to allow');
});

test('a tag absent from the taxonomy SHORTLISTS and names the tag — it is never invented', () => {
  const p = planThread({ title: 'x', topics: ['pricing-model'], rows: [THREAD_ROW] },
    { taxonomy: TAXONOMY, resolvedRepo: 'acme-co/context' });
  assert.equal(p.shortlist, true);
  assert.equal(p.ok, undefined, 'no save is planned');
  assert.deepEqual(p.missingTags, ['pricing-model']);
  assert.match(p.reason, /pull request/, 'the user adds the tag; triage does not');
});

test('a singleton exempt from front matter passes without a tag', () => {
  const p = planThread({ title: 'x', topics: [], rows: [THREAD_ROW] },
    { taxonomy: TAXONOMY, resolvedRepo: 'acme-co/context', singletonExempt: true });
  assert.equal(p.ok, true);
});

test('no tag at all, and not exempt, shortlists rather than saving untagged', () => {
  const p = planThread({ title: 'x', topics: [], rows: [THREAD_ROW] }, { taxonomy: TAXONOMY, resolvedRepo: 'acme-co/context' });
  assert.equal(p.shortlist, true);
});

test('a status outside active|settled|archived is rejected — triage adds no vocabulary', () => {
  for (const status of ['seed', 'dropped', 'open']) {
    const p = planThread({ title: 'x', topics: ['ip'], status, rows: [THREAD_ROW] },
      { taxonomy: TAXONOMY, resolvedRepo: 'acme-co/context' });
    assert.equal(p.ok, false, `${status} should be rejected`);
    assert.match(p.reason, /not one of active \| settled \| archived/);
  }
  for (const status of THREAD_STATUSES) {
    assert.equal(planThread({ title: 'x', topics: ['ip'], status, rows: [THREAD_ROW] },
      { taxonomy: TAXONOMY, resolvedRepo: 'acme-co/context' }).ok, true);
  }
});

test('a thread bound for another context repo is PARKED, never saved', () => {
  const p = planThread({ title: 'x', topics: ['ip'], targetRepo: 'example-user/thesis-context', rows: [THREAD_ROW] },
    { taxonomy: TAXONOMY, resolvedRepo: 'acme-co/context' });
  assert.equal(p.park, true);
  assert.equal(p.ok, undefined);
  assert.equal(p.target, 'example-user/thesis-context', 'and the target is named, so something waiting is visible');
  assert.match(p.reason, /that project's own session/);
  assert.match(p.reason, /taxonomy\.yml validation/, 'which is the reason the boundary exists');
});

test('the assembled body carries every contributing note VERBATIM plus provenance', () => {
  const rows = [
    THREAD_ROW,
    { ...THREAD_ROW, id: '2', topic: 'website', note: 'The deploy preview is part of the same argument.' },
  ];
  const p = planThread({ title: 'One argument', topics: ['ip'], rows }, { taxonomy: TAXONOMY, resolvedRepo: 'acme-co/context' });
  assert.equal(p.ok, true);
  for (const r of rows) assert.ok(p.body.includes(r.note), 'the user\'s phrasing survives');
  assert.match(p.body, /Mind Palace/);
  assert.match(p.body, /2026-09-05/);
  assert.match(p.body, /https:\/\/notion\.so\/topic-IP/);
});

test('several rows sharing a thread produce ONE save and mark each row separately', () => {
  const rows = [
    { ...THREAD_ROW, id: '1', topic: 'IP', thread: 'moat', note: 'first strand' },
    { ...THREAD_ROW, id: '2', topic: 'website', thread: 'moat', note: 'second strand' },
    { ...THREAD_ROW, id: '3', topic: 'general', thread: 'moat', note: 'third strand' },
  ];
  const batch = evaluateBatch(rows, [RES_THREAD('IP'), RES_THREAD('website'), RES_THREAD('general')], NOTES);
  const out = planThreads(batch, { taxonomy: TAXONOMY, resolvedRepo: 'acme-co/context' });
  assert.equal(out.saves.length, 1, 'one thread, not one per bullet');
  assert.deepEqual(out.saves[0].rowIds, ['1', '2', '3'], 'each contributing note is marked individually');
  for (const s of ['first strand', 'second strand', 'third strand']) assert.ok(out.saves[0].body.includes(s));
});

test('rows under different threads stay separate — a thread is not a dumping ground', () => {
  const rows = [
    { ...THREAD_ROW, id: '1', thread: 'moat', note: 'a' },
    { ...THREAD_ROW, id: '2', topic: 'notion', thread: 'meetings', note: 'b' },
  ];
  const batch = evaluateBatch(rows, [RES_THREAD('IP'), RES_THREAD('notion')], NOTES);
  const out = planThreads(batch, { taxonomy: TAXONOMY, resolvedRepo: 'acme-co/context' });
  assert.equal(out.saves.length, 2);
});

test('an ANGLE BRACKET in a note reaches the body and never a front-matter value', () => {
  // The skill ingester reads an angle bracket in a front-matter value as a tag and drops the
  // field SILENTLY — one of the marketplace's documented silent failures. Worth its own test
  // rather than being folded into "special characters".
  const note = 'Replace <placeholder> with the real id before <shipping>';
  const p = planThread({ title: 'x', topics: ['ip'], rows: [{ ...THREAD_ROW, note }] },
    { taxonomy: TAXONOMY, resolvedRepo: 'acme-co/context' });
  assert.equal(p.ok, true);
  assert.ok(p.body.includes(note), 'body text is fine and must not be mangled');
  // Nothing this plugin produces is a front-matter value: it has no front-matter knowledge at all.
  for (const v of [p.title, p.status, ...p.topics]) {
    assert.equal(/[<>]/.test(String(v)), false, `${JSON.stringify(v)} would be dropped silently by the ingester`);
  }
});

test('YAML-significant characters in a note are carried without corrupting anything', () => {
  const note = '- leading dash\nkey: value\n  indented: more\n"quoted"  #hash  |pipe  >fold';
  const p = planThread({ title: 'x', topics: ['ip'], rows: [{ ...THREAD_ROW, note }] },
    { taxonomy: TAXONOMY, resolvedRepo: 'acme-co/context' });
  assert.ok(p.body.includes(note));
});

test('this plugin holds no thread front-matter knowledge — that is the design, so assert it', () => {
  const src = readFileSync(new URL('./triage-notes.mjs', import.meta.url), 'utf8');
  for (const field of ['gist:', 'audience:', 'notion_ids', 'issue_ids', 'front-matter:']) {
    assert.equal(src.includes(`'${field}'`), false, `"${field}" belongs to save-thread, not here`);
  }
});

test('a thread with no contributing notes is refused rather than saved empty', () => {
  const p = planThread({ title: 'x', topics: ['ip'], rows: [] }, { taxonomy: TAXONOMY, resolvedRepo: 'acme-co/context' });
  assert.equal(p.ok, false);
  assert.match(p.reason, /no contributing notes/);
});

// ---------------------------------------------------------------- the handoff queue
//
// FIXTURES ARE HAND-WRITTEN TO MATCH THE SHAPE, NEVER COPIES OF REAL ITEMS. This is a rule, not a
// preference. Everything under plugins/ travels with every clone that installs the plugin, and
// the plugin cache on each of those machines is another copy — so a real item committed here
// would move one person's and one org's content into another org's shipped artefact. Real items
// also need no rescuing: they are committed in their own repo, and `git show` recovers any of
// them after a drain. Same rule, same reason, as keeping working notes out of a tool repo's own
// .claude/threads/.

const ORGS_H = [
  { owner: 'example-user', visibility: 'personal' },
  { owner: 'c-energie', visibility: 'personal' },
  { owner: 'acme-co', visibility: 'shared' },
];

const item = (fm, body = 'The item itself, with enough context that the receiving session needs nothing from here.') =>
  `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}\n`;

test('kind: issue with a repo field parses', () => {
  const p = parseHandoffItem(item({
    title: 'Add a dry-run flag', project: 'acme-co/context', kind: 'issue',
    repo: 'acme-co/website', date: '2026-09-05',
  }), '2026-09-05-dry-run.md');
  assert.equal(p.ok, true, p.errors.join('; '));
  assert.equal(p.kind, 'issue');
  assert.equal(p.repo, 'acme-co/website');
});

test('kind: issue WITHOUT a repo field is rejected, naming the missing field', () => {
  const p = parseHandoffItem(item({ title: 'x', project: 'acme-co/context', kind: 'issue', date: '2026-09-05' }), 'x.md');
  assert.equal(p.ok, false);
  assert.ok(p.errors.some((e) => /requires a "repo" field/.test(e)));
  assert.ok(p.errors.some((e) => /not inferred from the text/.test(e)));
});

test('an item in the OLD four-kind format with no repo: parses unchanged', () => {
  // The compatibility case: repurposing the contract must not strand items already in a queue.
  for (const kind of ['action', 'decision', 'open-question', 'thread-seed']) {
    const p = parseHandoffItem(item({
      title: 'A pre-existing item', project: 'example-user/thesis-context', kind, date: '2026-08-20',
    }), '2026-08-20-something.md');
    assert.equal(p.ok, true, `${kind}: ${p.errors.join('; ')}`);
    assert.equal(p.repo, null, 'absent repo: is normal for these kinds');
    assert.equal(p.date, '2026-08-20');
  }
});

test('the date falls back to the filename when front-matter omits it', () => {
  const p = parseHandoffItem(item({ title: 'x', project: 'example-user/thesis-context', kind: 'action' }), '2026-08-13-topic.md');
  assert.equal(p.date, '2026-08-13');
});

test('an unknown kind, a missing project and a bad repo name are each named', () => {
  const p = parseHandoffItem(item({ title: 'x', kind: 'slack-message', repo: 'not-an-owner-repo' }), 'x.md');
  assert.equal(p.ok, false);
  assert.ok(p.errors.some((e) => /kind "slack-message" is not one of/.test(e)));
  assert.ok(p.errors.some((e) => /no "project"/.test(e)));
  assert.ok(p.errors.some((e) => /repo "not-an-owner-repo" is not an owner\/repo name/.test(e)));
});

test('an angle bracket in a front-matter value is reported — the ingester drops it silently', () => {
  const p = parseHandoffItem(item({ title: 'Replace <placeholder>', project: 'example-user/thesis-context', kind: 'action' }), 'x.md');
  assert.equal(p.ok, false);
  assert.ok(p.errors.some((e) => /angle bracket/.test(e) && /silently/.test(e)));
});

test('a file with no front-matter block is rejected rather than half-read', () => {
  assert.equal(parseHandoffItem('just some prose', 'x.md').ok, false);
});

// ---------------------------------------------------------------- drain vs list

const parsed = (fm) => parseHandoffItem(item(fm), '2026-09-05-x.md');

test('an item bound for a PERSONAL context repo drains automatically', () => {
  const c = classifyHandoff(parsed({ title: 'x', project: 'example-user/thesis-context', kind: 'action' }),
    { organisations: ORGS_H, selfRepo: 'example-user/second-brain' });
  assert.equal(c.action, 'drain');
  assert.equal(c.visibility, 'personal');
  assert.match(c.reason, /gating you on your own approval/);
});

test('the SAME item bound for a SHARED context repo is listed and left', () => {
  const c = classifyHandoff(parsed({ title: 'x', project: 'acme-co/context', kind: 'action' }),
    { organisations: ORGS_H, selfRepo: 'example-user/second-brain' });
  assert.equal(c.action, 'list');
  assert.equal(c.visibility, 'shared');
  assert.match(c.reason, /the gate sits exactly here/);
});

test('an item targeting THIS repo is written — you cannot hand off to yourself', () => {
  const c = classifyHandoff(parsed({ title: 'x', project: 'example-user/second-brain', kind: 'action' }),
    { organisations: ORGS_H, selfRepo: 'example-user/second-brain' });
  assert.equal(c.action, 'drain');
  assert.match(c.reason, /cannot hand off to yourself/);
});

test('an item whose target repo cannot be resolved is LISTED, never defaulted', () => {
  const c = classifyHandoff(parsed({ title: 'x', project: 'some-other-org/context', kind: 'action' }),
    { organisations: ORGS_H, selfRepo: 'example-user/second-brain' });
  assert.equal(c.action, 'list');
  assert.match(c.reason, /cannot be resolved/);
  assert.match(c.reason, /must not land somewhere arbitrary/);
});

test('an item whose repo: is unreachable is listed with that reason', () => {
  const c = classifyHandoff(
    parsed({ title: 'x', project: 'example-user/thesis-context', kind: 'issue', repo: 'example-user/private-thing' }),
    { organisations: ORGS_H, selfRepo: 'example-user/second-brain', unreachable: ['example-user/private-thing'] });
  assert.equal(c.action, 'list');
  assert.match(c.reason, /credential problem, not a routing one/);
});

test('an unparseable item is listed with its parse errors, never drained', () => {
  const c = classifyHandoff(parseHandoffItem('no front matter', 'x.md'), { organisations: ORGS_H });
  assert.equal(c.action, 'list');
  assert.match(c.reason, /does not parse/);
});

test('visibility comes from the SAME organisations flag the shortlist rules use', () => {
  // Read the same way from the same place, so the two can never disagree about an owner.
  const shared = classifyHandoff(parsed({ title: 'x', project: 'acme-co/context', kind: 'action' }),
    { organisations: NOTES.organisations, selfRepo: 'example-user/second-brain' });
  assert.equal(shared.visibility, 'shared');
  const personal = classifyHandoff(parsed({ title: 'x', project: 'c-energie/dev-hub', kind: 'action' }),
    { organisations: NOTES.organisations, selfRepo: 'example-user/second-brain' });
  assert.equal(personal.visibility, 'personal');
});

// ---------------------------------------------------------------- the queue and the section

const queueDir = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-'));
  for (const [name, fm] of Object.entries(files)) writeFileSync(join(dir, name), item(fm));
  writeFileSync(join(dir, 'README.md'), '# handoff\n');
  writeFileSync(join(dir, 'INDEX.md'), '# index\n');
  return dir;
};

test('README.md and INDEX.md are not items', () => {
  const dir = queueDir({ '2026-09-05-a.md': { title: 'a', project: 'example-user/thesis-context', kind: 'action' } });
  const q = readHandoffQueue(dir, { organisations: ORGS_H, selfRepo: 'example-user/second-brain' });
  assert.equal(q.total, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('a queue splits into drain-now and list-only', () => {
  const dir = queueDir({
    '2026-09-01-mine.md': { title: 'mine', project: 'example-user/thesis-context', kind: 'action' },
    '2026-09-02-theirs.md': { title: 'theirs', project: 'acme-co/context', kind: 'decision' },
    '2026-09-03-issue.md': { title: 'an issue', project: 'example-user/thesis-context', kind: 'issue', repo: 'example-user/sim-data' },
  });
  const q = readHandoffQueue(dir, { organisations: ORGS_H, selfRepo: 'example-user/second-brain' });
  assert.equal(q.total, 3);
  assert.deepEqual(q.drain.map((i) => i.title).sort(), ['an issue', 'mine']);
  assert.deepEqual(q.list.map((i) => i.title), ['theirs']);
  rmSync(dir, { recursive: true, force: true });
});

test('the carried-over section renders WITH A COUNT when items were drained', () => {
  const dir = queueDir({ '2026-09-01-mine.md': { title: 'mine', project: 'example-user/thesis-context', kind: 'action' } });
  const out = renderCarriedOver(readHandoffQueue(dir, { organisations: ORGS_H, selfRepo: 'example-user/second-brain' }));
  assert.match(out, /carried over \(1\)/);
  assert.match(out, /mine/);
  rmSync(dir, { recursive: true, force: true });
});

test('it renders with a ZERO count rather than being omitted', () => {
  // An omitted section makes "nothing was carried over" indistinguishable from "not printed".
  const dir = queueDir({ '2026-09-02-theirs.md': { title: 'theirs', project: 'acme-co/context', kind: 'action' } });
  const q = readHandoffQueue(dir, { organisations: ORGS_H, selfRepo: 'example-user/second-brain' });
  const out = renderCarriedOver(q);
  assert.match(out, /carried over \(0\)/);
  assert.match(out, /\(nothing\)/);
  rmSync(dir, { recursive: true, force: true });
});

test('an empty queue still renders a zero section and a zero backlog', () => {
  const dir = queueDir({});
  const out = renderCarriedOver(readHandoffQueue(dir, { organisations: ORGS_H }));
  assert.match(out, /carried over \(0\)/);
  assert.match(out, /backlog: 0 item\(s\)/, 'an empty queue should be something seen, not assumed');
  rmSync(dir, { recursive: true, force: true });
});

test('shared items are listed EVERY run, so a stalled one stays visible', () => {
  const dir = queueDir({ '2026-08-20-old.md': { title: 'an old shared item', project: 'acme-co/context', kind: 'action' } });
  const out = renderCarriedOver(readHandoffQueue(dir, { organisations: ORGS_H, selfRepo: 'example-user/second-brain' }));
  assert.match(out, /waiting for a person \(1\)/);
  assert.match(out, /an old shared item/);
  rmSync(dir, { recursive: true, force: true });
});

test('a repo with no handoff/ directory reports zero rather than erroring', () => {
  const q = readHandoffQueue(join(tmpdir(), 'definitely-not-a-queue-dir-xyz'), { organisations: ORGS_H });
  assert.equal(q.applicable, false);
  assert.equal(q.total, 0);
  assert.match(renderCarriedOver(q), /carried over \(0\)/);
});

test('re-running over a half-drained queue produces no duplicate work', () => {
  const dir = queueDir({
    '2026-09-01-one.md': { title: 'one', project: 'example-user/thesis-context', kind: 'action' },
    '2026-09-02-two.md': { title: 'two', project: 'example-user/thesis-context', kind: 'action' },
  });
  const opts = { organisations: ORGS_H, selfRepo: 'example-user/second-brain' };
  assert.equal(readHandoffQueue(dir, opts).drain.length, 2);

  // "one" was written, so it moved to done/. "two" failed, so it stayed exactly where it was.
  rmSync(join(dir, '2026-09-01-one.md'));
  const second = readHandoffQueue(dir, opts);
  assert.deepEqual(second.drain.map((i) => i.title), ['two'],
    'only the item whose write did not succeed comes round again');
  rmSync(dir, { recursive: true, force: true });
});
