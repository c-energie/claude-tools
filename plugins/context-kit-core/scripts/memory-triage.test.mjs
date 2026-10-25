// Tests for memory-triage.mjs's choice of destination: a workspace's docs/memory.md, the only
// one since context repos were retired (#60). Node standard library only.
//
//   node --test plugins/context-kit-core/scripts/memory-triage.test.mjs
//
// HOME is a scratch dir holding a fake ~/.claude/projects store, so the scan never reads the
// developer's own native memory (os.homedir() follows HOME on POSIX). Skipped on Windows, where
// it does not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'memory-triage.mjs');
const posix = process.platform !== 'win32';

const tmps = [];
const scratch = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ck-triage-')));
  tmps.push(d);
  return d;
};
test.after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const deep = (...parts) => { const d = join(...parts); mkdirSync(d, { recursive: true }); return d; };

// One native memory entry of `type`, in the store the harness would key on `dir`.
function store(home, dir, type) {
  const key = resolve(dir).replace(/[:\\/.]/g, '-');
  const mem = deep(home, '.claude', 'projects', key, 'memory');
  writeFileSync(join(mem, 'fact.md'),
    `---\nname: a-fact\ndescription: something learned\nmetadata:\n  type: ${type}\n---\n\nThe fact.\n`);
}

const scan = (home, root, dir) => spawnSync(process.execPath,
  [SCRIPT, 'scan', root, '--dir', dir, '--json', '--today', '2026-10-23'],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });

test('a workspace root: project facts go to docs/memory.md, from a member too', { skip: !posix }, () => {
  const home = scratch();
  const root = scratch();
  deep(root, '.claude');
  writeFileSync(join(root, '.claude', 'workspace.json'), JSON.stringify({ schema: 1 }));
  const member = deep(root, 'app');
  store(home, member, 'project');

  const r = scan(home, root, member);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.layer, 'workspace');
  assert.equal(out.memory, 'docs/memory.md');
  assert.match(out.mode, /^project/);
  assert.equal(out.candidates.length, 1);
  assert.match(out.candidates[0].suggestion, /the workspace's docs\/memory\.md/);
});

test('a retired context repo is refused, naming the retirement', () => {
  const root = scratch();
  writeFileSync(join(root, 'context.json'), '{}');
  const r = scan(scratch(), root, scratch());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /context repos are retired \(ADR 0002, #60\)/);
});

// #54: the cross-project mode is gone. A workspace that still declares `include` reads only its
// own store, like any other, and a personal entry is a finding rather than a promotion.
test('a workspace still declaring include: one store, and personal entries are not promotable', { skip: !posix }, () => {
  const home = scratch();
  const root = scratch();
  deep(root, '.claude');
  writeFileSync(join(root, '.claude', 'workspace.json'), JSON.stringify({ schema: 1, include: ['x/y'] }));
  const cwd = scratch();
  store(home, cwd, 'user');
  store(home, scratch(), 'user');   // another directory's store, which must not be read

  const out = JSON.parse(scan(home, root, cwd).stdout);
  assert.match(out.mode, /^project/);
  assert.equal(out.storesRead, 1);
  assert.equal(out.candidates.length, 1);
  assert.match(out.candidates[0].suggestion, /^personal — NOT promotable from here/);
});

test('a malformed workspace.json is fatal, not a reason to look for context.json', () => {
  const root = scratch();
  deep(root, '.claude');
  writeFileSync(join(root, '.claude', 'workspace.json'), '{ nope');
  writeFileSync(join(root, 'context.json'), '{}');
  const r = scan(scratch(), root, root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /malformed/);
});

test('no workspace.json: refused, saying it is not a workspace', () => {
  const r = scan(scratch(), scratch(), scratch());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a workspace/);
  assert.doesNotMatch(r.stderr, /context repo/);
});
