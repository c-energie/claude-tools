// Tests for the CONTEXT_KIT_AUTOLOAD gate at the top of load-context.sh. Node standard library
// only — no package.json, no dependency.
//
//   node --test plugins/context-kit-core/hooks/load-context.test.mjs
//
// The seam is the hook itself: run it with a pinned environment and assert on stdout. That is
// the whole of what a session does with this script, so there is nothing below it worth testing
// separately — and it needs no session, no network and no clone, which is the rule for anything
// runnable here.
//
// Offline is achieved rather than assumed. The fixture "clone" is a `git init` with no remote,
// pinned with PROJECT_CONTEXT_DIR, so the resolver finds a checkout on disk and never clones;
// its `git pull` then fails locally in milliseconds, which puts a STALE banner on the loaded
// payload. That is deliberate and irrelevant to these assertions: every one of them asks
// whether the hook loaded or stayed silent, never whether the pull worked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'load-context.sh');
const MEMORY_MARK = 'FIXTURE MEMORY LINE';

const tmps = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'ck-autoload-'));
  tmps.push(d);
  return d;
};
test.after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

// A project directory plus, unless `configured` is false, a context checkout for it to resolve.
// HOME is pinned to the scratch directory precisely because the hook globs `$HOME/mnt/...` and
// falls back to a bounded find there: a test that inherited the real HOME would pass or fail
// according to what the machine running it happens to have mounted.
const fixture = ({ repo = 'c-energie/fixture-context' } = {}) => {
  const base = scratch();
  const proj = join(base, 'project');
  const clone = join(base, 'clone');
  mkdirSync(proj);
  mkdirSync(clone);
  writeFileSync(join(clone, 'memory.md'), `# Memory\n\n- ${MEMORY_MARK}\n`);
  writeFileSync(join(clone, 'context.json'), JSON.stringify({ contextRepo: repo }, null, 2));
  // No commit and no identity config: the resolver only looks for .git/, and a commit would
  // make this test depend on a git user.name being set wherever it runs.
  const git = spawnSync('git', ['init', '-q', clone], { encoding: 'utf8' });
  assert.equal(git.status, 0, `git init failed: ${git.stderr}`);
  return { home: base, proj, clone };
};

// `env` is built from scratch rather than spread over process.env, so a developer who has
// PROJECT_CONTEXT_REPO exported in their own shell — which is most of the people who would run
// this — does not silently configure every case below.
const run = ({ fix, autoload, repo = 'c-energie/fixture-context', args = [] }) => {
  const env = {
    PATH: process.env.PATH,
    HOME: fix.home,
    TMPDIR: fix.home,
    CLAUDE_PROJECT_DIR: fix.proj,
    PROJECT_CONTEXT_DIR: fix.clone,
    // Not inherited: an inherited proxy port is how the hook decides it is in a sandbox, and
    // that would buy every unconfigured case the ~10s mount-timing retry.
  };
  if (autoload !== undefined) env.CONTEXT_KIT_AUTOLOAD = autoload;
  if (repo !== null) env.PROJECT_CONTEXT_REPO = repo;
  const r = spawnSync('bash', [HOOK, ...args], { cwd: fix.proj, env, encoding: 'utf8' });
  assert.equal(r.status, 0, `the hook must always exit 0; got ${r.status} — ${r.stderr}`);
  return r.stdout;
};

// In session mode the payload is wrapped in the hook JSON envelope; --refresh is plain text.
// Both are searched the same way here: what matters is whether the context reached stdout.
const loaded = (out) => out.includes(MEMORY_MARK);

test('unset: today\'s behaviour, unchanged — a configured project loads', () => {
  assert.ok(loaded(run({ fix: fixture() })));
});

test('off: a configured project loads nothing, silently, exit 0', () => {
  assert.equal(run({ fix: fixture(), autoload: 'off' }), '');
});

test('off: an unconfigured project gets no unconfigured warning either', () => {
  const fix = fixture();
  // The control first: without the flag this is the loud path, so the assertion below is
  // testing the gate rather than a fixture that was never going to say anything.
  const control = run({ fix, repo: null });
  assert.match(control, /No context repo was configured/);
  assert.equal(run({ fix, repo: null, autoload: 'off' }), '');
});

test('off: a project that has opted out is silent, as it already was', () => {
  assert.equal(run({ fix: fixture(), repo: 'none', autoload: 'off' }), '');
});

test('on: a project`s own opt-out still vetoes — local can always be more restrictive', () => {
  assert.equal(run({ fix: fixture(), repo: 'none', autoload: 'on' }), '');
});

test('on: a configured project loads', () => {
  assert.ok(loaded(run({ fix: fixture(), autoload: 'on' })));
});

test('an unrecognised value fails open — silence is never a typo', () => {
  assert.ok(loaded(run({ fix: fixture(), autoload: 'banana' })));
});

test('off is case-insensitive, like every other spelling of off here', () => {
  assert.equal(run({ fix: fixture(), autoload: 'OFF' }), '');
});

test('--refresh is exempt: off means not automatically, not never', () => {
  assert.ok(loaded(run({ fix: fixture(), autoload: 'off', args: ['--refresh'] })));
});

test('--refresh still reports a project-level opt-out, flag or no flag', () => {
  // The two switches answer different questions, so they answer --refresh differently: `none`
  // means there IS no repo (say so), off means not automatically (load it).
  const out = run({ fix: fixture(), repo: 'none', autoload: 'off', args: ['--refresh'] });
  assert.match(out, /opted out of a shared context repo/);
});
