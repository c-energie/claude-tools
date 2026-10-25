// Tests for workspace-freshness.sh, the session-start hook: it loads nothing, and only warns
// when the workspace is behind its origin. Node standard library only — no
// package.json, no dependency.
//
//   node --test plugins/context-kit-core/hooks/workspace-freshness.test.mjs
//
// Offline is achieved rather than assumed: "origin" is a local bare repository, so every fetch
// below is a file copy, and the two failure cases use a remote that cannot exist (a missing
// path) and one that never answers (an `ext::` transport running `sleep`). Commits carry their
// identity in the environment, so nothing depends on a git user.name being set wherever this
// runs. HOME is a scratch dir, so nothing on the developer's machine can decide a case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'workspace-freshness.sh');
const MEMORY_MARK = 'FIXTURE MEMORY LINE';

const tmps = [];
// realpath: macOS's tmpdir is a symlink, and the hook reports the root the resolver walked to.
const scratch = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ck-fresh-')));
  tmps.push(d);
  return d;
};
test.after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const ID = {
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (repo, name) => {
  writeFileSync(join(repo, name), `${name}\n`);
  git(repo, 'add', name);
  git(repo, 'commit', '-q', '-m', name);
};

// A bare "origin", the workspace cloned from it (with .claude/workspace.json committed and its
// branch tracking origin), and a second clone standing in for a teammate who pushes.
const fixture = () => {
  const base = scratch();
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(base, 'seed');
  git(base, 'clone', '-q', origin, seed);
  git(seed, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(seed, '.claude'));
  writeFileSync(join(seed, '.claude', 'workspace.json'), JSON.stringify({ schema: 1, name: 'fixture' }));
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'workspace');
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  const ws = join(base, 'ws');
  git(base, 'clone', '-q', origin, ws);
  return { base, origin, seed, ws };
};
const teammatePushes = (fix, n) => {
  for (let i = 0; i < n; i++) commit(fix.seed, `upstream-${i}.txt`);
  git(fix.seed, 'push', '-q', 'origin', 'main');
};

// Built from scratch, not spread over process.env, so a developer's own CONTEXT_KIT_AUTOLOAD
// cannot decide a case. PROJECT_CONTEXT_REPO is deliberately SET, to a checkout the retired
// legacy loader would have printed (#60): an empty stdout then proves nothing reads it any more,
// rather than that there was nothing to load.
const run = ({ fix, cwd = fix.ws, env = {}, args = [] }) => {
  const clone = join(fix.base, 'legacy');
  mkdirSync(clone, { recursive: true });
  writeFileSync(join(clone, 'memory.md'), `# Memory\n\n- ${MEMORY_MARK}\n`);
  spawnSync('git', ['init', '-q', clone]);
  const started = Date.now();
  const r = spawnSync('bash', [HOOK, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: fix.base,
      TMPDIR: fix.base,
      CLAUDE_PROJECT_DIR: cwd,
      PROJECT_CONTEXT_REPO: 'c-energie/fixture-context',
      PROJECT_CONTEXT_DIR: clone,
      ...env,
    },
  });
  assert.equal(r.status, 0, `the hook must always exit 0; got ${r.status} — ${r.stderr}`);
  return { out: r.stdout, ms: Date.now() - started };
};
// The session-mode payload is the hook JSON envelope; the line is in both of its fields.
const note = (out) => {
  if (!out) return '';
  const j = JSON.parse(out);
  assert.equal(j.systemMessage, j.hookSpecificOutput.additionalContext, 'user and model get the same line');
  assert.ok(!j.systemMessage.includes('\n'), 'one line');
  return j.systemMessage;
};

test('up to date: no output at all — and no context repo is loaded', () => {
  const fix = fixture();
  assert.equal(run({ fix }).out, '');
});

test('behind origin by N: one line stating N and the command, and nothing is pulled', () => {
  const fix = fixture();
  teammatePushes(fix, 3);
  const before = git(fix.ws, 'rev-parse', 'HEAD');
  const line = note(run({ fix }).out);
  assert.match(line, /3 commits behind origin\/main/);
  assert.match(line, /pull --ff-only/);
  // The tail, not the whole path: Git Bash spells the scratch dir its own way on Windows.
  assert.match(line, new RegExp(`${basename(fix.base)}[\\\\/]ws\\b`), 'names the workspace');
  assert.equal(git(fix.ws, 'rev-parse', 'HEAD'), before, 'a fetch, never a pull');
});

test('one commit behind is singular', () => {
  const fix = fixture();
  teammatePushes(fix, 1);
  assert.match(note(run({ fix }).out), /1 commit behind/);
});

test('from a subdirectory of the workspace, the workspace root is checked', () => {
  const fix = fixture();
  teammatePushes(fix, 2);
  const sub = join(fix.ws, 'docs', 'threads');
  mkdirSync(sub, { recursive: true });
  assert.match(note(run({ fix, cwd: sub }).out), /2 commits behind/);
});

test('diverged: one line with both counts and no single command pretended', () => {
  const fix = fixture();
  teammatePushes(fix, 2);
  commit(fix.ws, 'local.txt');
  const line = note(run({ fix }).out);
  assert.match(line, /diverged from origin\/main: 2 commits behind, 1 ahead/);
  assert.doesNotMatch(line, /--ff-only/);
});

test('ahead only: nothing to warn about', () => {
  const fix = fixture();
  commit(fix.ws, 'local.txt');
  assert.equal(run({ fix }).out, '');
});

test('no upstream (a branch never pushed): silent, and no fetch attempted', () => {
  const fix = fixture();
  git(fix.ws, 'checkout', '-q', '-b', 'local-only');
  // A remote that would fail loudly if it were contacted.
  git(fix.ws, 'remote', 'set-url', 'origin', join(fix.base, 'missing.git'));
  assert.equal(run({ fix }).out, '');
});

test('no network (an unreachable remote): one line saying the check could not run, exit 0', () => {
  const fix = fixture();
  git(fix.ws, 'remote', 'set-url', 'origin', join(fix.base, 'missing.git'));
  const line = note(run({ fix }).out);
  assert.match(line, /freshness check could not run/);
});

test('a remote that never answers is cut off at the cap', () => {
  const fix = fixture();
  // ext:: runs a command as the transport; `sleep` accepts the connection and never speaks.
  git(fix.ws, 'config', 'protocol.ext.allow', 'always');
  git(fix.ws, 'remote', 'set-url', 'origin', 'ext::sleep 30');
  const { out, ms } = run({ fix, env: { CONTEXT_KIT_FETCH_TIMEOUT: '1' } });
  assert.match(note(out), /could not run \(timed out after 1s\)/);
  assert.ok(ms < 8000, `returned within the cap (took ${ms}ms)`);
});

test('CONTEXT_KIT_AUTOLOAD=off silences it, even when behind', () => {
  const fix = fixture();
  teammatePushes(fix, 2);
  assert.equal(run({ fix, env: { CONTEXT_KIT_AUTOLOAD: 'off' } }).out, '');
});

test('a malformed workspace.json is not a workspace: silent, and no context repo is loaded', () => {
  const fix = fixture();
  teammatePushes(fix, 1);
  writeFileSync(join(fix.ws, '.claude', 'workspace.json'), '{ not json');
  assert.equal(run({ fix }).out, '');
});

test('outside any workspace: silent, even with a context repo configured', () => {
  const fix = fixture();
  const proj = join(fix.base, 'project');
  mkdirSync(proj);
  assert.equal(run({ fix, cwd: proj }).out, '');
});

test('--refresh, the retired loader\'s hand invocation, is ignored like any other argument', () => {
  const fix = fixture();
  teammatePushes(fix, 1);
  assert.match(note(run({ fix, args: ['--refresh'] }).out), /1 commit behind/);
});
