// Tests for the store resolver in diagram-store.mjs. Node standard library only.
//
//   node --test plugins/diagrams/scripts/diagram-store.test.mjs
//
// Offline: env, cwd, the context repo and the origin owner are all injected, so nothing here
// runs git or the context resolver. These are the functions that decide which org's store a
// diagram lands in, which is why they are worth pinning down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveStore, findRepoFile, readConfigSoft, REPO_FILE } from './diagram-store.mjs';

// ---------------------------------------------------------------- fixtures

/** A throwaway repo root (with a .git dir) and a nested subdirectory to resolve from. */
function repo({ file = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'diagrams-'));
  mkdirSync(join(root, '.git'));
  const sub = join(root, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  if (file) writeFileSync(join(root, REPO_FILE), JSON.stringify(file));
  return { root, sub };
}

const noContext = () => ({ cfg: null, why: 'no context repo' });
const context = (json) => () => ({ cfg: { path: '/ctx/context.json', json }, why: null });
const owner = (o) => () => o;

const resolve = (opts) => resolveStore({
  mustExist: false, env: {}, context: noContext, owner: owner(null), ...opts,
});

// ---------------------------------------------------------------- the ladder

test('DIAGRAMS_STORE wins over a repo file and context.json', () => {
  const { sub } = repo({ file: { repo: 'acme/from-file' } });
  const s = resolve({
    cwd: sub, env: { DIAGRAMS_STORE: 'acme/from-env' },
    context: context({ state: { diagrams: { repo: 'acme/from-ctx' } } }),
  });
  assert.equal(s.repo, 'acme/from-env');
  assert.equal(s.source, 'env');
});

test('.diagrams.json is found from a subdirectory and wins over context.json', () => {
  const { sub, root } = repo({ file: { repo: 'acme/diagrams', project: 'Widget' } });
  const s = resolve({ cwd: sub, context: context({ state: { diagrams: { repo: 'acme/other' } } }) });
  assert.equal(s.repo, 'acme/diagrams');
  assert.equal(s.source, 'repo-file');
  assert.equal(s.configPath, join(root, REPO_FILE));
  assert.equal(s.project, 'Widget');
});

test('the walk stops at the first .git: an outer repo file never claims an inner repo', () => {
  const outer = repo({ file: { repo: 'acme/diagrams' } });
  const inner = join(outer.root, 'inner');
  mkdirSync(join(inner, '.git'), { recursive: true });
  assert.equal(findRepoFile(inner).json, null);
  assert.equal(findRepoFile(inner).root, inner);
});

test('context.json is used when nothing else names a store', () => {
  const { sub } = repo();
  const s = resolve({
    cwd: sub,
    context: context({ project: 'Proj', contextRepo: 'acme/ctx', state: { diagrams: { repo: 'acme/diagrams' } } }),
  });
  assert.equal(s.source, 'context.json');
  assert.equal(s.project, 'Proj');
});

test('nothing named is an error listing all three places — never a default', () => {
  const { sub } = repo();
  assert.throws(() => resolve({ cwd: sub, owner: owner('acme') }), (e) => {
    assert.match(e.message, /DIAGRAMS_STORE/);
    assert.match(e.message, /\.diagrams\.json/);
    assert.match(e.message, /state.*diagrams/);
    assert.match(e.message, /acme\/diagrams is the likely store/);
    return true;
  });
});

test('a context.json without state.diagrams still errors', () => {
  const { sub } = repo();
  assert.throws(() => resolve({ cwd: sub, context: context({ project: 'P', state: null }) }),
    /No diagram store is named/);
});

test('a malformed repo name is refused, naming where it came from', () => {
  const { sub } = repo({ file: { repo: 'not-a-slug' } });
  assert.throws(() => resolve({ cwd: sub }), /\.diagrams\.json names the store "not-a-slug"/);
});

test('project falls back to the repo directory name', () => {
  const { sub, root } = repo({ file: { repo: 'acme/diagrams' } });
  assert.equal(resolve({ cwd: sub }).project, root.split(/[\\/]/).pop());
});

// ---------------------------------------------------------------- the org boundary

test('a store in another org than the origin is refused', () => {
  const { sub } = repo({ file: { repo: 'other-org/diagrams' } });
  assert.throws(() => resolve({ cwd: sub, owner: owner('acme') }), /belongs to acme/);
});

test('crossOrg: true records a deliberate cross-org store', () => {
  const { sub } = repo({ file: { repo: 'other-org/diagrams', crossOrg: true } });
  assert.equal(resolve({ cwd: sub, owner: owner('acme') }).boundary, 'cross-org (declared)');
});

test('DIAGRAMS_CROSS_ORG=1 is the override for DIAGRAMS_STORE', () => {
  const { sub } = repo();
  const env = { DIAGRAMS_STORE: 'other-org/diagrams' };
  assert.throws(() => resolve({ cwd: sub, env, owner: owner('acme') }), /belongs to acme/);
  const s = resolve({ cwd: sub, env: { ...env, DIAGRAMS_CROSS_ORG: '1' }, owner: owner('acme') });
  assert.equal(s.boundary, 'cross-org (declared)');
});

test('owner comparison ignores case', () => {
  const { sub } = repo({ file: { repo: 'ACME/diagrams' } });
  assert.equal(resolve({ cwd: sub, owner: owner('acme') }).boundary, 'same-org');
});

test('with no origin, the context repo owner is the home', () => {
  const { sub } = repo();
  const ctx = context({ contextRepo: 'acme/ctx', state: { diagrams: { repo: 'other-org/diagrams' } } });
  assert.throws(() => resolve({ cwd: sub, context: ctx }), /belongs to acme/);
});

test('the env route also falls back to the context repo owner', () => {
  const { sub } = repo();
  const ctx = context({ contextRepo: 'acme/ctx', state: null });
  assert.throws(() => resolve({ cwd: sub, env: { DIAGRAMS_STORE: 'other-org/d' }, context: ctx }),
    /belongs to acme/);
});

test('no origin and no context repo: unchecked, reported rather than refused', () => {
  const { sub } = repo({ file: { repo: 'acme/diagrams' } });
  assert.equal(resolve({ cwd: sub }).boundary, 'unchecked');
});

// ---------------------------------------------------------------- the workspace (ADR 0002)

const workspace = (json) => () => ({ cfg: { path: '/ws/.claude/workspace.json', json }, why: null });

test('a workspace.json names the store like context.json, with its name as the project', () => {
  const { sub } = repo();
  const s = resolve({
    cwd: sub,
    context: workspace({ schema: 1, name: 'ws', repo: 'acme/ws', state: { diagrams: { repo: 'acme/diagrams' } } }),
  });
  assert.equal(s.repo, 'acme/diagrams');
  assert.equal(s.source, 'workspace.json');
  assert.equal(s.configPath, '/ws/.claude/workspace.json');
  assert.equal(s.project, 'ws');
});

test('with no origin, the workspace repo owner is the home', () => {
  const { sub } = repo();
  const ws = workspace({ schema: 1, name: 'ws', repo: 'acme/ws', state: { diagrams: { repo: 'other-org/diagrams' } } });
  assert.throws(() => resolve({ cwd: sub, context: ws }), /belongs to acme/);
  const env = { DIAGRAMS_STORE: 'other-org/d' };
  assert.throws(() => resolve({ cwd: sub, env, context: workspace({ schema: 1, repo: 'acme/ws' }) }), /belongs to acme/);
});

test('readConfigSoft finds the workspace.json above a member repo nested in it', () => {
  const ws = mkdtempSync(join(tmpdir(), 'diagrams-ws-'));
  mkdirSync(join(ws, '.claude'));
  const file = join(ws, '.claude', 'workspace.json');
  writeFileSync(file, JSON.stringify({ schema: 1, name: 'ws', state: { diagrams: { repo: 'acme/diagrams' } } }));
  const member = join(ws, 'member', 'src');
  mkdirSync(member, { recursive: true });
  mkdirSync(join(ws, 'member', '.git'));
  const saved = process.env.CONTEXT_CONFIG;
  delete process.env.CONTEXT_CONFIG;
  try {
    const { cfg } = readConfigSoft(member);
    assert.equal(cfg.path, file);
    assert.equal(cfg.json.state.diagrams.repo, 'acme/diagrams');
  } finally { if (saved !== undefined) process.env.CONTEXT_CONFIG = saved; }
});
