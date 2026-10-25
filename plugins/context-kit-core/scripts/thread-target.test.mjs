// Tests for where save-thread writes inside a workspace (thread-target.mjs) and for the index
// it regenerates there (thread-index.mjs --dir docs/threads). Node standard library only.
//
//   node --test plugins/context-kit-core/scripts/thread-target.test.mjs
//
// Offline by construction: every repo is a `git init` whose origin is a URL nobody fetches,
// because the script only ever READS `remote get-url`. HOME is not touched — neither script
// looks there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { threadTarget, repoFromUrl } from './thread-target.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TARGET = join(here, 'thread-target.mjs');
const INDEX = join(here, 'thread-index.mjs');

const tmps = [];
const scratch = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ck-thread-')));
  tmps.push(d);
  return d;
};
test.after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const deep = (...parts) => { const d = join(...parts); mkdirSync(d, { recursive: true }); return d; };
const gitInit = (dir, origin) => {
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
  if (origin) assert.equal(spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]).status, 0);
  return dir;
};
const workspace = (dir, body) => {
  deep(dir, '.claude');
  writeFileSync(join(dir, '.claude', 'workspace.json'), typeof body === 'string' ? body : JSON.stringify(body));
  return dir;
};

// The fixture: a workspace repo wrapping one declared member (app), one undeclared nested clone
// (tool), one monorepo member that is part of the workspace's own repo (docs-site), and a
// declared member whose clone has no origin at all (scratch).
function fixture() {
  const root = gitInit(scratch(), 'git@github.com:acme/workspace.git');
  workspace(root, {
    schema: 1, name: 'acme', repo: 'acme/workspace',
    members: [
      { dir: 'app', repo: 'acme/app', kind: 'code' },
      { dir: 'sites/docs-site', repo: 'acme/workspace', kind: 'document' },
      { dir: 'scratch', kind: 'analysis' },
    ],
  });
  gitInit(deep(root, 'app'), 'https://github.com/acme/app-from-origin.git');
  deep(root, 'app', 'src', 'deep');
  gitInit(deep(root, 'tool'), 'https://github.com/acme/tool');
  deep(root, 'sites', 'docs-site', 'pages');
  gitInit(deep(root, 'scratch'));
  return root;
}

test('repoFromUrl reads the GitHub URL shapes and refuses anything else', () => {
  assert.equal(repoFromUrl('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(repoFromUrl('https://github.com/acme/app'), 'acme/app');
  assert.equal(repoFromUrl('https://github.com/acme/app.git/'), 'acme/app');
  assert.equal(repoFromUrl('ssh://git@github.com/acme/app.git'), 'acme/app');
  assert.equal(repoFromUrl(''), null);
  assert.equal(repoFromUrl(null), null);
});

test('at the workspace root: docs/threads, and no repo to record', () => {
  const root = fixture();
  const t = threadTarget({ cwd: root });
  assert.equal(t.route, 'workspace');
  assert.equal(t.root, root);
  assert.equal(t.dir, 'docs/threads');
  assert.equal(t.index, 'docs/threads/INDEX.md');
  assert.equal(t.from, null);
  assert.equal(t.repo, null);
});

test('from deep inside a declared member: the workspace root, recording the DECLARED repo', () => {
  const root = fixture();
  const t = threadTarget({ cwd: join(root, 'app', 'src', 'deep') });
  assert.equal(t.route, 'workspace');
  assert.equal(t.root, root, 'never the member — its .claude/threads/ is the retired second home');
  assert.equal(t.from, 'app/src/deep');
  // members[] wins over the clone's own origin: it is the declared answer.
  assert.equal(t.repo, 'acme/app');
});

test('an undeclared nested clone: its origin', () => {
  const root = fixture();
  assert.equal(threadTarget({ cwd: join(root, 'tool') }).repo, 'acme/tool');
});

test('a monorepo member (repo is the workspace repo): nothing to record', () => {
  const root = fixture();
  const t = threadTarget({ cwd: join(root, 'sites', 'docs-site', 'pages') });
  assert.equal(t.repo, null);
  assert.equal(t.from, 'sites/docs-site/pages');
});

test('a plain subdirectory of the workspace repo: nothing to record', () => {
  const root = fixture();
  assert.equal(threadTarget({ cwd: deep(root, 'notes') }).repo, null);
});

test('a nested clone with no origin: null, and SAID so', () => {
  const root = fixture();
  const t = threadTarget({ cwd: join(root, 'scratch') });
  assert.equal(t.repo, null);
  assert.match(t.messages.join('\n'), /no GitHub origin/);
});

test('a member dir that is only a name prefix does not match', () => {
  const root = fixture();
  // "application" starts with "app" as a string, not as a path segment.
  gitInit(deep(root, 'application'), 'git@github.com:acme/application.git');
  assert.equal(threadTarget({ cwd: join(root, 'application') }).repo, 'acme/application');
});

// #60: there is no context-repo route to fall to. Outside a workspace a thread has no home.
test('no workspace: no route, everything null, and the reason said', () => {
  const t = threadTarget({ cwd: deep(scratch(), 'plain') });
  assert.equal(t.route, null);
  assert.equal(t.root, null);
  assert.equal(t.dir, null);
  assert.match(t.messages.join('\n'), /no \.claude[\\/]workspace\.json/);
});

test('a malformed nearest workspace.json: no route, reported — never the outer one', () => {
  const outer = workspace(scratch(), { schema: 1 });
  const inner = workspace(deep(outer, 'inner'), '{ not json');
  const t = threadTarget({ cwd: inner });
  assert.equal(t.route, null);
  assert.equal(t.root, null);
  assert.match(t.messages.join('\n'), /malformed/);
});

test('CLI outside a workspace: the JSON line still printed, route=none on stderr, exit 1', () => {
  const plain = deep(scratch(), 'plain');
  const r = spawnSync(process.execPath, [TARGET], {
    cwd: plain, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: plain },
  });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).route, null);
  assert.match(r.stderr, /route=none/);
});

test('CLI: one JSON line on stdout, the route on stderr, CLAUDE_PROJECT_DIR honoured', () => {
  const root = fixture();
  const r = spawnSync(process.execPath, [TARGET], {
    cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: join(root, 'app') },
  });
  assert.equal(r.status, 0, r.stderr);
  const t = JSON.parse(r.stdout);
  assert.deepEqual(t, {
    route: 'workspace', root, dir: 'docs/threads', index: 'docs/threads/INDEX.md', from: 'app', repo: 'acme/app',
  });
  assert.match(r.stderr, /route=workspace/);
  assert.equal(spawnSync(process.execPath, [TARGET, '--bogus']).status, 2);
});

test('INDEX.md under docs/threads is regenerated with the new thread, and old gists carried', () => {
  const root = fixture();
  const threads = deep(root, 'docs', 'threads');
  writeFileSync(join(threads, '2026-10-01-old.md'), '---\ntitle: Old topic\n---\n\nbody\n');
  const first = spawnSync(process.execPath, [INDEX, root, '--dir', 'docs/threads',
    '--gists', writeGists({ '2026-10-01-old.md': { status: 'settled', gist: 'the old gist' } }), '--write'], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);

  writeFileSync(join(threads, '2026-10-23-new.md'),
    '---\ntitle: New topic\nrepo: acme/app\naudience: team\n---\n\nbody\n');
  const second = spawnSync(process.execPath, [INDEX, root, '--dir', 'docs/threads',
    '--gists', writeGists({ '2026-10-23-new.md': { status: 'active', gist: 'the new gist' } }), '--write'], { encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);

  const index = readFileSync(join(threads, 'INDEX.md'), 'utf8');
  assert.match(index, /## Active \(2\)/);
  assert.match(index, /New topic · audience: team · active · the new gist · `docs\/threads\/2026-10-23-new\.md`/);
  assert.match(index, /Old topic · settled · the old gist · `docs\/threads\/2026-10-01-old\.md`/);
  // No docs/Archive/threads exists, so no "Archived (0)" claiming one does.
  assert.doesNotMatch(index, /Archived/);
});

function writeGists(obj) {
  const f = join(scratch(), 'g.json');
  writeFileSync(f, JSON.stringify(obj));
  return f;
}
