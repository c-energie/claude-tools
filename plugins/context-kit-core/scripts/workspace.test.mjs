// Tests for the workspace resolver — workspace.mjs and its bash twin workspace-root.sh, run
// against the SAME fixtures because the drift rule cannot compare a .sh with a .mjs, and two
// resolvers that disagree about which workspace a session is in would load two contexts.
// Node standard library only — no package.json, no dependency.
//
//   node --test plugins/context-kit-core/scripts/workspace.test.mjs
//
// Offline is achieved rather than assumed, as in hooks/load-context.test.mjs: the legacy
// fallback is pinned with PROJECT_CONTEXT_DIR to a `git init` with no remote and run with
// --no-pull, so context-repo.sh finds a checkout on disk and never touches the network. HOME is
// a scratch dir because context-repo.sh globs and searches `$HOME/mnt` for markers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWorkspace, resolveWorkspace } from './workspace.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MJS = join(here, 'workspace.mjs');
const SH = join(here, 'workspace-root.sh');
const REPO = 'c-energie/fixture-context';

const tmps = [];
// realpath: macOS's tmpdir is a symlink, and the resolvers report the path they walked.
const scratch = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ck-workspace-')));
  tmps.push(d);
  return d;
};
test.after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const workspace = (dir, body = { schema: 1, name: 'fixture', members: [] }) => {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'workspace.json'),
    typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  return dir;
};
const deep = (...parts) => { const d = join(...parts); mkdirSync(d, { recursive: true }); return d; };

// A legacy context checkout for the fallback to find. No commit and no identity config: the
// resolver only looks for .git/.
const legacyClone = (base) => {
  const clone = deep(base, 'clone');
  const git = spawnSync('git', ['init', '-q', clone], { encoding: 'utf8' });
  assert.equal(git.status, 0, `git init failed: ${git.stderr}`);
  return clone;
};

// Built from scratch rather than spread over process.env, so a developer with
// PROJECT_CONTEXT_REPO exported in their own shell does not configure every case below.
const envFor = (home, clone) => ({
  PATH: process.env.PATH,
  HOME: home,
  ...(clone ? { PROJECT_CONTEXT_REPO: REPO, PROJECT_CONTEXT_DIR: clone } : {}),
});

// Every case runs three ways — the API, the .mjs CLI and the bash twin — and they must agree.
const both = (cwd, env) => {
  const api = resolveWorkspace({ cwd, args: ['--no-pull'], env });
  const mjs = spawnSync(process.execPath, [MJS, '--no-pull', '--json'], { cwd, env, encoding: 'utf8' });
  const sh = spawnSync('bash', [SH, '--no-pull'], { cwd, env, encoding: 'utf8' });
  const cli = mjs.stdout.trim() ? JSON.parse(mjs.stdout) : {};
  assert.equal(cli.root, api.root, `CLI and API disagree: ${mjs.stderr}`);
  assert.equal(sh.stdout.trim() || null, api.root, `bash twin disagrees with workspace.mjs: ${sh.stderr}`);
  return { api, mjs, sh, cli };
};

test('three levels below a workspace.json, that root is returned', () => {
  const root = workspace(scratch());
  const cwd = deep(root, 'a', 'b', 'c');
  const { api, mjs, sh } = both(cwd, envFor(root));
  assert.equal(api.root, root);
  assert.equal(api.route, 'workspace');
  assert.match(mjs.stderr, /route=workspace/);
  assert.match(sh.stderr, /route=workspace/);
  assert.equal(mjs.status, 0);
  assert.equal(sh.status, 0);
});

test('the walk does not stop at a nested member clone\'s .git', () => {
  const root = workspace(scratch());
  const member = deep(root, 'thesis');
  assert.equal(spawnSync('git', ['init', '-q', member]).status, 0);
  const { api } = both(deep(member, 'chapters'), envFor(root));
  assert.equal(api.root, root);
});

test('with two nested workspaces, the inner one wins from inside it — and nothing merges', () => {
  const outer = workspace(scratch(), { schema: 1, name: 'outer', connections: { github: 'x' } });
  const inner = workspace(deep(outer, 'projects', 'inner'), { schema: 1, name: 'inner' });
  const { api } = both(deep(inner, 'src'), envFor(outer));
  assert.equal(api.root, inner);
  const found = findWorkspace(deep(inner, 'src'));
  assert.equal(found.config.name, 'inner');
  assert.equal(found.config.connections, undefined, 'levels must never merge');
  // ...and from the outer workspace but outside the inner, the outer one.
  assert.equal(both(deep(outer, 'projects'), envFor(outer)).api.root, outer);
});

test('with no workspace above the cwd, the legacy context-repo result is returned', () => {
  const base = scratch();
  const clone = legacyClone(base);
  const cwd = deep(base, 'project');
  const { api, mjs, sh, cli } = both(cwd, envFor(base, clone));
  assert.equal(api.root, clone);
  assert.equal(api.route, 'context-repo');
  assert.equal(cli.route, 'context-repo');
  assert.match(mjs.stderr, /route=context-repo/);
  assert.match(sh.stderr, /route=context-repo/);
});

test('neither route resolving exits 1 with the reason, and does not throw', () => {
  const base = scratch();
  const { api, mjs, sh } = both(deep(base, 'project'), envFor(base));
  assert.equal(api.root, null);
  assert.equal(api.route, null);
  assert.equal(mjs.status, 1);
  assert.equal(sh.status, 1);
  assert.match(mjs.stderr, /no context repo configured/);
  assert.match(sh.stderr, /route=none/);
});

for (const [label, body] of [
  ['a parse error', '{ "schema": 1, "name": '],
  ['a top level that is not an object', '[1, 2]'],
]) {
  test(`a malformed workspace.json (${label}) is reported and the resolver falls back`, () => {
    const base = scratch();
    const clone = legacyClone(base);
    const root = workspace(deep(base, 'ws'), body);
    const file = join(root, '.claude', 'workspace.json');
    const { api, mjs, sh } = both(deep(root, 'sub'), envFor(base, clone));
    assert.equal(api.root, clone);
    assert.equal(api.route, 'context-repo');
    for (const err of [api.messages.join('\n'), mjs.stderr, sh.stderr]) {
      assert.ok(err.includes(file), `the malformed file's path is named: ${err}`);
      assert.match(err, /malformed/);
    }
  });
}

test('a malformed inner workspace never falls through to the outer one', () => {
  const base = scratch();
  const clone = legacyClone(base);
  const outer = workspace(deep(base, 'outer'));
  const inner = workspace(deep(outer, 'inner'), 'not json');
  const { api } = both(inner, envFor(base, clone));
  assert.equal(api.route, 'context-repo', 'skipping to the outer workspace would load the wrong context');
});

test('an unknown schema is reported but still resolves', () => {
  const root = workspace(scratch(), { schema: 2 });
  const { api, mjs, sh } = both(root, envFor(root));
  assert.equal(api.route, 'workspace');
  assert.match(mjs.stderr, /schema is 2/);
  assert.match(sh.stderr, /schema is 2/);
});

test('unknown keys, top level and inside members, reach the caller untouched', () => {
  const body = {
    schema: 1, name: 'w', repo: 'o/w', future: { x: 1 },
    members: [{ dir: 'analysis', repo: 'o/a', kind: 'analysis', documents: ['thesis'], extra: true }],
    state: { notion: { db: 'id' } },
  };
  const root = workspace(scratch(), body);
  assert.deepEqual(findWorkspace(root).config, body);
});

test('unknown options are refused with exit 2, as context-repo.sh does', () => {
  const root = workspace(scratch());
  const env = envFor(root);
  assert.equal(spawnSync(process.execPath, [MJS, '--bogus'], { cwd: root, env }).status, 2);
  assert.equal(spawnSync('bash', [SH, '--bogus'], { cwd: root, env }).status, 2);
});
