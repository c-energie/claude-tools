// Tests for where this plugin reads and writes inside a workspace (#53): layout.mjs's table, the
// config ladder in lib.mjs, the queue in pending-parse.mjs, the mirror in mirror-render.mjs and
// the state block notion-state.mjs writes. Node standard library only.
//
//   node --test plugins/context-notion/scripts/layout.test.mjs
//
// Offline by construction. The legacy route is exercised through CONTEXT_CONFIG, never through
// context-repo.sh — PROJECT_CONTEXT_REPO is pinned to `none` in every child so nothing can clone,
// and HOME points at an empty scratch directory so no machine's settings leak in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout } from './layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = (name) => join(here, name);

const tmps = [];
const scratch = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'cn-layout-')));
  tmps.push(d);
  return d;
};
test.after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const deep = (...parts) => { const d = join(...parts); mkdirSync(d, { recursive: true }); return d; };
const put = (path, text) => { deep(dirname(path)); writeFileSync(path, text); return path; };

const ROSTER = { backend: 'notion', notion: { databases: { actions: 'ds-1' }, people: [{ name: 'Sam', notionUserId: 'u-sam' }] } };

function workspace(state = ROSTER) {
  const root = scratch();
  put(join(root, '.claude', 'workspace.json'), `${JSON.stringify({ schema: 1, name: 'acme', repo: 'acme/workspace', members: [], state }, null, 2)}\n`);
  deep(root, 'member', 'src');
  return root;
}

function contextRepo() {
  const root = scratch();
  put(join(root, 'context.json'), `${JSON.stringify({ state: ROSTER })}\n`);
  put(join(root, 'memory.md'), '# memory\n');
  return root;
}

const run = (name, args, { cwd, env = {}, input } = {}) => spawnSync(process.execPath, [script(name), ...args], {
  cwd, input, encoding: 'utf8',
  env: { ...process.env, HOME: scratch(), PROJECT_CONTEXT_REPO: 'none', CLAUDE_PROJECT_DIR: '', CONTEXT_CONFIG: '', ...env },
});

const ACTION = '# Actions\n\n## Chase the supplier\n- owner: Sam\n- due: 2026-11-02\n';

test('layout: a workspace root gets docs/meetings, .context/pending and .context/notion', () => {
  const root = workspace();
  const l = layout(root);
  assert.equal(l.kind, 'workspace');
  assert.equal(l.config, join(root, '.claude', 'workspace.json'));
  assert.equal(l.meetings, join(root, 'docs', 'meetings'));
  assert.equal(l.pending, join(root, '.context', 'pending'));
  assert.equal(l.done, join(root, '.context', 'pending', 'done'));
  assert.equal(l.mirror, join(root, '.context', 'notion'));
  // House rules stay at the root in both layouts.
  assert.equal(l.templates, join(root, 'templates'));
  assert.equal(l.taxonomy, join(root, 'taxonomy.yml'));
  assert.equal(l.rel.pending, '.context/pending');
});

test('layout: a context repo keeps meetings/, pending/ and notion/', () => {
  const l = layout(contextRepo());
  assert.equal(l.kind, 'context-repo');
  assert.deepEqual([l.rel.config, l.rel.meetings, l.rel.pending, l.rel.done, l.rel.mirror],
    ['context.json', 'meetings', 'pending', 'pending/done', 'notion']);
});

test('layout: a workspace found only ABOVE the root does not make the root one', () => {
  const ws = workspace();
  const clone = deep(ws, 'legacy-context');
  assert.equal(layout(clone).kind, 'context-repo');
});

test('layout: a malformed workspace.json at the root is a context repo, as the resolver falls back', () => {
  const root = scratch();
  put(join(root, '.claude', 'workspace.json'), '{ not json');
  assert.equal(layout(root).kind, 'context-repo');
});

test('layout CLI: one key prints one absolute path', () => {
  const root = workspace();
  const r = run('layout.mjs', [root, 'pending']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), join(root, '.context', 'pending'));
  assert.equal(run('layout.mjs', [root, 'nonsense']).status, 2);
});

test('config ladder: from a member, the nearest workspace.json supplies the roster', () => {
  const root = workspace();
  put(join(root, '.context', 'pending', 'actions.md'), ACTION);
  const r = run('pending-parse.mjs', [root, '--json'], { cwd: join(root, 'member', 'src') });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].file, '.context/pending/actions.md');
  // Resolved through workspace.json's state.notion.people, so no "not on the roster" warning.
  assert.deepEqual(out.entries[0].ownerResolved.map((p) => p.notionUserId), ['u-sam']);
  assert.doesNotMatch(r.stderr, /declares no Notion backend/);
});

test('config ladder: CONTEXT_CONFIG still wins over a workspace', () => {
  const root = workspace();
  put(join(root, '.context', 'pending', 'actions.md'), ACTION);
  const other = put(join(scratch(), 'context.json'), JSON.stringify({ state: null }));
  const r = run('pending-parse.mjs', [root, '--json'], { cwd: root, env: { CONTEXT_CONFIG: other } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /declares no Notion backend/);
});

test('config ladder: a malformed workspace.json is named, then the legacy route is tried', () => {
  const root = scratch();
  put(join(root, '.claude', 'workspace.json'), '{ not json');
  deep(root, 'pending');
  const r = run('pending-parse.mjs', [root], { cwd: root });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /workspace\.json: malformed/);
  assert.match(r.stderr, /Cannot load the project's config/);
});

test('queue: drain files entries under .context/pending/done in a workspace', () => {
  const root = workspace();
  put(join(root, '.context', 'pending', 'actions.md'), `${ACTION}\n## Second\n- owner: Sam\n`);
  const results = JSON.stringify([{ file: '.context/pending/actions.md', line: 3, notionUrl: 'https://notion.so/x' }]);
  const r = run('pending-parse.mjs', [root, '--drain', results, '--today', '2026-10-24'], { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  const done = join(root, '.context', 'pending', 'done', '2026-10-24-processed.md');
  assert.ok(existsSync(done));
  assert.match(readFileSync(done, 'utf8'), /Chase the supplier[\s\S]*notion: https:\/\/notion\.so\/x/);
  assert.doesNotMatch(readFileSync(join(root, '.context', 'pending', 'actions.md'), 'utf8'), /Chase the supplier/);
  assert.ok(!existsSync(join(root, 'pending')), 'nothing may be written to the legacy pending/');
});

test('queue: the Slack message names .context/pending/ in a workspace', () => {
  const root = workspace();
  put(join(root, '.context', 'pending', 'actions.md'), ACTION);
  const r = run('pending-parse.mjs', [root, '--slack', '--added-by', 'Ada'], { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /In the workspace → `\.context\/pending\/`/);
});

test('queue: a legacy context repo still reads and reports pending/', () => {
  const root = contextRepo();
  put(join(root, 'pending', 'actions.md'), ACTION);
  const r = run('pending-parse.mjs', [root, '--json'], { cwd: root, env: { CONTEXT_CONFIG: join(root, 'context.json') } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).entries[0].file, 'pending/actions.md');
});

test('mirror: renders into .context/notion in a workspace, with no memory.md needed', () => {
  const root = workspace();
  const exp = put(join(scratch(), 'export.json'), JSON.stringify({ actions: [{ task: 'T', owner: 'u-sam', status: 'Not started' }] }));
  const r = run('mirror-render.mjs', [root, exp, '--today', '2026-10-24'], { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  const synced = JSON.parse(readFileSync(join(root, '.context', 'notion', '_synced.json'), 'utf8'));
  assert.equal(synced.databases.actions.file, '.context/notion/actions.md');
  assert.match(readFileSync(join(root, '.context', 'notion', 'actions.md'), 'utf8'), /add an entry to \.context\/pending\//);
  assert.ok(!existsSync(join(root, 'notion')));
});

test('mirror: a legacy context repo is rendered byte-for-byte as before (notion/, pending/)', () => {
  const root = contextRepo();
  const exp = put(join(scratch(), 'export.json'), JSON.stringify({ actions: [] }));
  const r = run('mirror-render.mjs', [root, exp, '--today', '2026-10-24'], { cwd: root, env: { CONTEXT_CONFIG: join(root, 'context.json') } });
  assert.equal(r.status, 0, r.stderr);
  const synced = JSON.parse(readFileSync(join(root, 'notion', '_synced.json'), 'utf8'));
  assert.equal(synced.databases.actions.file, 'notion/actions.md');
  assert.equal(synced.source, "Notion — see the project's context.json state.notion");
  assert.match(readFileSync(join(root, 'notion', 'actions.md'), 'utf8'), /add an entry to pending\/\. -->/);
});

test('notion-state: writes state.backend and state.notion only, keeping every other key', () => {
  const root = workspace({ notes: { keep: true }, backend: null });
  const file = join(root, '.claude', 'workspace.json');
  const raw = readFileSync(file, 'utf8');
  const block = put(join(scratch(), 'block.json'), JSON.stringify({ databases: { actions: 'ds-9' } }));

  const plan = run('notion-state.mjs', [file, block]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /PLAN ONLY/);
  assert.equal(readFileSync(file, 'utf8'), raw, 'a plan writes nothing');

  const w = run('notion-state.mjs', [file, block, '--write']);
  assert.equal(w.status, 0, w.stderr);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(after), ['schema', 'name', 'repo', 'members', 'state']);
  assert.deepEqual(after.state, { notes: { keep: true }, backend: 'notion', notion: { databases: { actions: 'ds-9' } } });
  // Everything above `state` is byte-identical.
  assert.equal(readFileSync(file, 'utf8').split('"state"')[0], raw.split('"state"')[0]);

  // A second identical write is a no-op.
  const again = run('notion-state.mjs', [file, block, '--write']);
  assert.match(again.stdout, /no change/);
});

test('notion-state: a null state becomes the block; a non-object state is refused', () => {
  const root = workspace(null);
  const file = join(root, '.claude', 'workspace.json');
  const block = put(join(scratch(), 'block.json'), '{"databases":{}}');
  assert.equal(run('notion-state.mjs', [file, block, '--write']).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).state, { backend: 'notion', notion: { databases: {} } });

  const bad = workspace('oops');
  const badFile = join(bad, '.claude', 'workspace.json');
  const before = readFileSync(badFile, 'utf8');
  const r = run('notion-state.mjs', [badFile, block, '--write']);
  assert.equal(r.status, 1);
  assert.equal(readFileSync(badFile, 'utf8'), before);
});
