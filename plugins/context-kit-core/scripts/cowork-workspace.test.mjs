// Tests for cowork-workspace.mjs — finding an uploaded workspace.json in a Cowork sandbox's
// mount areas, and the write allowlist the gate applies there (#61). Node standard library only.
//
//   node --test plugins/context-kit-core/scripts/cowork-workspace.test.mjs
//
// Every layout is built in a scratch tree: HOME is a scratch dir, and `/mnt` is passed in as a
// scratch dir too, so no case depends on what the machine running it has mounted. The gate's own
// use of the real /mnt is covered by connection-gate.test.mjs through ~/mnt/uploads instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { findUploadedWorkspace, writeAllowed, normalisePath, COWORK_WRITE_ALLOWLIST } from './cowork-workspace.mjs';
import { findWorkspace } from './workspace.mjs';

const tmps = [];
const scratch = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ck-cowork-')));
  tmps.push(d);
  return d;
};
test.after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const deep = (...parts) => { const d = join(...parts); mkdirSync(d, { recursive: true }); return d; };
const put = (file, body = { schema: 1, name: 'acme', repo: 'acme/workspace' }) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
};
// A sandbox: HOME, a /mnt stand-in, and a working dir two levels below a .project-cache sibling,
// as on the Windows desktop app's host.
const sandbox = () => {
  const base = scratch();
  return { base, home: deep(base, 'home'), mnt: deep(base, 'mnt'), project: deep(base, 'session', 'outputs', 'work') };
};
const find = (s) => findUploadedWorkspace({ project: s.project, home: s.home, mnt: s.mnt });

// ---------------------------------------------------------------- each layout, flat and under .claude/

const LAYOUTS = {
  '/mnt/project': (s) => join(s.mnt, 'project'),
  '~/mnt/.projects/[uuid]/docs': (s) => join(s.home, 'mnt', '.projects', '0a1b-uuid', 'docs'),
  '~/mnt/uploads': (s) => join(s.home, 'mnt', 'uploads'),
  '.project-cache/[uuid]/docs': (s) => join(s.base, 'session', '.project-cache', '9f8e-uuid', 'docs'),
};
for (const [name, dir] of Object.entries(LAYOUTS)) {
  for (const rel of ['workspace.json', join('.claude', 'workspace.json')]) {
    test(`found in ${name}, as ${rel}`, () => {
      const s = sandbox();
      const file = put(join(dir(s), rel));
      const r = find(s);
      assert.equal(r.file, file);
      assert.equal(r.config.repo, 'acme/workspace');
    });
  }
}

test('a drifted layout is found by the bounded search of the mount areas', () => {
  const s = sandbox();
  const file = put(join(s.home, 'mnt', 'some', 'new', 'layout', 'workspace.json'));
  assert.equal(find(s).file, file);
});

test('the bounded search stops at depth 5', () => {
  const s = sandbox();
  put(join(s.mnt, 'a1', 'b', 'c', 'd', 'e', 'workspace.json'));            // depth 6
  assert.equal(find(s).file, null);
  const file = put(join(s.mnt, 'a2', 'b', 'c', 'd', 'workspace.json'));   // depth 5
  assert.equal(find(s).file, file);
});

test('the working tree is never searched', () => {
  const s = sandbox();
  put(join(s.project, 'workspace.json'));
  put(join(s.project, 'sub', 'workspace.json'));
  assert.equal(find(s).file, null);
});

test('WSL drive mounts under /mnt are not crawled', () => {
  const s = sandbox();
  put(join(s.mnt, 'c', 'Users', 'me', 'workspace.json'));
  put(join(s.mnt, 'wslg', 'workspace.json'));
  assert.equal(find(s).file, null);
});

test('a workspace.json that is not ours is skipped with a reason, and the search goes on', () => {
  const s = sandbox();
  const nx = put(join(s.mnt, 'project', 'workspace.json'), { version: 2, projects: {} });
  const broken = put(join(s.home, 'mnt', 'uploads', 'workspace.json'), '{ "repo": ');
  const real = put(join(s.home, 'mnt', 'uploads', '.claude', 'workspace.json'));
  const r = find(s);
  assert.equal(r.file, real);
  assert.deepEqual(r.rejected.map((x) => x.file), [nx, broken]);
  assert.match(r.rejected[0].error, /no "repo"/);
});

test('absence returns no file, and names where it looked', () => {
  const s = sandbox();
  const r = find(s);
  assert.equal(r.file, null);
  assert.ok(r.searched.includes(join(s.home, 'mnt', 'uploads')));
  assert.ok(r.searched.includes(join(s.mnt, 'project')));
});

test('the walk-up result is a different, earlier question: an upload never shadows it', () => {
  // The precedence lives in the gate (it asks findWorkspace() first, and this only when that
  // returns null); here, that both answer independently and the walk-up does not see uploads.
  const s = sandbox();
  put(join(s.home, 'mnt', 'uploads', 'workspace.json'), { repo: 'acme/uploaded' });
  const root = deep(s.base, 'checkout');
  put(join(root, '.claude', 'workspace.json'), { repo: 'acme/checkout' });
  assert.equal(findWorkspace(join(root)).config.repo, 'acme/checkout');
  assert.equal(findWorkspace(s.project), null);
});

// ---------------------------------------------------------------- the write allowlist

test('the allowlist is exactly the three context paths', () => {
  assert.deepEqual(COWORK_WRITE_ALLOWLIST, ['docs/threads/', 'docs/meetings/', '.context/']);
});

test('writeAllowed: context paths pass, curated and code paths do not', () => {
  for (const p of ['docs/threads/x.md', 'docs/meetings/2026-10-24.md', '.context/pending/y.json', './docs/threads/x.md']) {
    assert.equal(writeAllowed(p), true, p);
  }
  for (const p of ['docs/memory.md', 'GLOSSARY.md', 'docs/adr/0003-x.md', 'src/a.py', 'docs/threads/../memory.md',
    '/docs/threads/x.md', 'docs//threads/x.md', 'docs\\threads\\x.md', 'docs/threads/', 'docs/threads',
    'docs/threadsX/a.md', '', null, 42]) {
    assert.equal(writeAllowed(p), false, String(p));
  }
});

test('normalisePath refuses anything that could escape a prefix test', () => {
  assert.equal(normalisePath('docs/./threads/x.md'), 'docs/threads/x.md');
  assert.equal(normalisePath('docs/threads/../../x'), null);
  assert.equal(normalisePath('/etc/passwd'), null);
});
