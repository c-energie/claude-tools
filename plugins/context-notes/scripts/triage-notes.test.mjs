// Tests for triage-notes.mjs. Node standard library only — no package.json, no dependency.
//
//   node --test plugins/context-notes/scripts/triage-notes.test.mjs
//
// Everything here is pure and offline: no Notion, no git, no network. The functions under test
// are the ones that decide where a note could go, and they are worth testing precisely because
// getting them wrong routes one org's notes into another org's repository.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadConfig, validate, palaceIds, resolveTopic, resolveTopics, sensitiveHits,
  OPTOUT, REPOS_STALE_HOURS,
} from './triage-notes.mjs';

// ---------------------------------------------------------------- fixtures

const ORGS = [
  { owner: 'c-energie', visibility: 'personal' },
  { owner: 'net-flex', visibility: 'shared' },
];

const NOTES = {
  _comment: 'a comment key, which must be skipped rather than rejected',
  mindPalace: {
    _comment: 'a nested comment key, which must also be skipped',
    dataSource: 'collection://6dbf62e9-4462-82fc-b00d-07ee4d4eb085',
    database: '0f9f62e9-4462-837a-8ff4-011c0a692148',
  },
  _mindPalaceNote: 'another comment key',
  organisations: ORGS,
  sensitiveTerms: ['salary', 'non-disclosure', 'cap table'],
};

// The repositories that actually exist, as of the list this was written against.
const REPOS = [
  { owner: 'c-energie', name: 'claude-tools' },
  { owner: 'c-energie', name: 'dev-hub' },
  { owner: 'c-energie', name: 'doc-writer' },
  { owner: 'c-energie', name: 'secret-roster' },
  { owner: 'net-flex', name: 'news-watch' },
  { owner: 'net-flex', name: 'website' },
  { owner: 'net-flex', name: 'context' },
  { owner: 'net-flex', name: 'secret-roster' },
  { owner: 'net-flex', name: 'dev-hub-catalogue' },
  { owner: 'somebody-else', name: 'dev-hub' },   // undeclared org: must never be matched
];

const repoList = (gatheredAt) => ({ gatheredAt, repos: REPOS });

let tmp;
const repoWith = (state) => {
  tmp ??= mkdtempSync(join(tmpdir(), 'triage-notes-'));
  const dir = mkdtempSync(join(tmp, 'repo-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'context.json'),
    JSON.stringify({ project: 'Test', contextRepo: 'net-flex/context', state }, null, 2));
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
  assert.equal(ids.dataSource, '6dbf62e9-4462-82fc-b00d-07ee4d4eb085');
  assert.equal(ids.database, '0f9f62e9-4462-837a-8ff4-011c0a692148');
});

// ---------------------------------------------------------------- topic resolution

test('a topic equal to a repository name resolves to repo, with owner and visibility', () => {
  const r = resolveTopic('news-watch', REPOS, ORGS);
  assert.equal(r.outcome, 'repo');
  assert.equal(r.repo, 'net-flex/news-watch');
  assert.equal(r.owner, 'net-flex');
  assert.equal(r.visibility, 'shared');       // from the ORGANISATION, not the repository
});

test('visibility follows the organisation, so a personal org gives a personal destination', () => {
  assert.equal(resolveTopic('dev-hub', REPOS, ORGS).visibility, 'personal');
});

test('a topic matching nothing resolves to a thread and names the context repo', () => {
  const r = resolveTopic('general', REPOS, ORGS, { contextRepo: 'net-flex/context' });
  assert.equal(r.outcome, 'thread');
  assert.equal(r.thread, 'net-flex/context');
  assert.equal(r.repo, null);
});

test('repo and thread are distinguishable states, not a value and its absence', () => {
  const a = resolveTopic('website', REPOS, ORGS);
  const b = resolveTopic('nothing-like-this', REPOS, ORGS);
  assert.notEqual(a.outcome, b.outcome);
  assert.ok('outcome' in b, 'a thread outcome still carries an explicit outcome');
});

test('matching is exact: claude does not become claude-tools', () => {
  const r = resolveTopic('claude', REPOS, ORGS, { contextRepo: 'net-flex/context' });
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
  const r = resolveTopic('Website', REPOS, ORGS, { contextRepo: 'net-flex/context' });
  assert.equal(r.outcome, 'thread', 'a case difference is not a match');
  assert.deepEqual(r.caseOnly, ['net-flex/website'], 'and the near-miss is named');
});

test('a name matching in two declared organisations is ambiguous and names both', () => {
  const r = resolveTopic('secret-roster', REPOS, ORGS);
  assert.equal(r.outcome, 'ambiguous');
  assert.equal(r.repo, null, 'ambiguous resolves to NEITHER');
  assert.deepEqual(r.candidates.map((c) => c.repo).sort(), ['c-energie/secret-roster', 'net-flex/secret-roster']);
  assert.deepEqual(r.candidates.map((c) => c.visibility).sort(), ['personal', 'shared']);
});

// ---------------------------------------------------------------- freshness

test('a stale repository list still resolves, and the staleness is carried into the result', () => {
  const now = '2026-09-06T12:00:00Z';
  const old = '2026-09-01T12:00:00Z';                       // 120h, well past the threshold
  const out = resolveTopics(['general'], repoList(old), NOTES, { contextRepo: 'net-flex/context', now });
  assert.equal(out.repoList.stale, true);
  assert.ok(out.repoList.ageHours > REPOS_STALE_HOURS);
  assert.equal(out.topics[0].outcome, 'thread', 'it still resolves');
  assert.match(out.topics[0].staleListCaveat, /may be a thread only because a repository was missed/);
});

test('a fresh list attributes nothing, so a thread outcome is about the topic', () => {
  const out = resolveTopics(['general'], repoList('2026-09-06T11:00:00Z'), NOTES,
    { contextRepo: 'net-flex/context', now: '2026-09-06T12:00:00Z' });
  assert.equal(out.repoList.stale, false);
  assert.equal(out.topics[0].staleListCaveat, undefined);
});

test('the nine live FlexSense topics route as the spec says they do', () => {
  const topics = ['dev-hub', 'news-watch', 'website', 'general', 'notion', 'test', 'claude', 'IP', 'tool-platform'];
  const out = resolveTopics(topics, repoList('2026-09-06T11:00:00Z'), NOTES,
    { contextRepo: 'net-flex/context', now: '2026-09-06T12:00:00Z' });
  const by = Object.fromEntries(out.topics.map((t) => [t.topic, t.repo ?? t.outcome]));
  assert.deepEqual(by, {
    'dev-hub': 'c-energie/dev-hub',
    'news-watch': 'net-flex/news-watch',
    'website': 'net-flex/website',
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
  // `standardised` and `foundation`, all ordinary FlexSense vocabulary. Left in, it would have
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
