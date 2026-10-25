// Tests for context-doctor.mjs and context-status.mjs in a workspace (ADR 0002, #52), and that a
// retired context repo is refused rather than checked (#60). Node standard library only, no
// network.
//
//   node --test plugins/context-kit-core/scripts/context-doctor.test.mjs
//
// HOME is a scratch dir, so neither the developer's ~/.claude/settings.json (whose autoload flag
// the doctor reports) nor their native memory leaks into a result. The one network call the
// doctor makes — `gh repo view`, for visibility — is answered by a fake `gh` put first on PATH,
// so the public-repo warning is tested without a token or a repo. POSIX only: the fake is a
// shell script, and os.homedir() follows HOME only there. The refusals run everywhere: they exit
// before HOME or gh is consulted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCTOR = join(HERE, 'context-doctor.mjs');
const STATUS = join(HERE, 'context-status.mjs');
const posix = process.platform !== 'win32';

const tmps = [];
const scratch = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ck-doctor-')));
  tmps.push(d);
  return d;
};
test.after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const put = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

// A `gh` that answers `repo view ... --jq .visibility` with `visibility`, or fails when null.
function fakeGh(visibility) {
  const bin = scratch();
  const body = visibility === null
    ? '#!/bin/sh\necho "gh: not logged in" >&2\nexit 4\n'
    : `#!/bin/sh\necho ${visibility}\n`;
  writeFileSync(join(bin, 'gh'), body);
  chmodSync(join(bin, 'gh'), 0o755);
  return bin;
}

function run(script, args, { cwd, gh = null, home = scratch() } = {}) {
  const PATH = gh ? `${gh}:${process.env.PATH}` : process.env.PATH;
  return spawnSync(process.execPath, [script, ...args], {
    cwd: cwd ?? home, encoding: 'utf8', env: { PATH, HOME: home },
  });
}
const doctor = (root, opts = {}, ...extra) => {
  const r = run(DOCTOR, [...(root ? [root] : []), '--json', '--today', '2026-10-24', ...extra], opts);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const checks = (out) => out.findings.map((f) => `${f.level}:${f.check}`);

const THREAD = '---\ntitle: A thread\ndate: 2026-10-01\n---\n\n## Decisions\n\n- one\n';

// A workspace with nothing wrong in it: one cloned member, memory imported, an indexed thread.
function healthy() {
  const root = scratch();
  put(root, '.claude/workspace.json', JSON.stringify({
    schema: 1, name: 'ws', repo: 'acme/workspace',
    members: [{ dir: 'app', repo: 'acme/app', kind: 'code' }],
    connections: { github: { acme: 'github-acme' } },
  }, null, 2));
  mkdirSync(join(root, 'app'));
  put(root, 'CLAUDE.md', '# ws\n\n@docs/memory.md\n');
  put(root, 'docs/memory.md', '# Memory\n');
  put(root, 'docs/threads/2026-10-01-a-thread.md', THREAD);
  put(root, 'docs/threads/INDEX.md', '- 2026-10-01-a-thread.md — A thread\n');
  return root;
}
const editWs = (root, f) => {
  const file = join(root, '.claude', 'workspace.json');
  writeFileSync(file, JSON.stringify(f(JSON.parse(readFileSync(file, 'utf8'))), null, 2));
};

test('a healthy workspace reports clean', { skip: !posix }, () => {
  const out = doctor(healthy());
  assert.equal(out.mode, 'workspace');
  assert.deepEqual(out.findings, []);
  assert.deepEqual(out.workspace.members, [{ dir: 'app', repo: 'acme/app', kind: 'code', cloned: true }]);

  const r = run(DOCTOR, [healthy(), '--today', '2026-10-24']);
  assert.match(r.stdout, /ok {4}nothing to report/);
});

test('with no argument, the nearest workspace above the cwd is checked', { skip: !posix }, () => {
  const root = healthy();
  const out = doctor(null, { cwd: join(root, 'app') });
  assert.equal(out.root, root);
  assert.equal(out.mode, 'workspace');
});

test('a public workspace repo holding meetings is warned about; private is not', { skip: !posix }, () => {
  const root = healthy();
  put(root, 'docs/meetings/2026-10-02-kickoff.md', '# kickoff\n');

  const pub = doctor(root, { gh: fakeGh('PUBLIC') });
  assert.deepEqual(checks(pub), ['warn:visibility']);
  assert.match(pub.findings[0].message, /acme\/workspace is PUBLIC and holds docs\/meetings/);
  assert.equal(pub.workspace.visibility, 'PUBLIC');

  assert.deepEqual(doctor(root, { gh: fakeGh('PRIVATE') }).findings, []);
});

test('a visibility lookup that fails is a note saying it was NOT checked', { skip: !posix }, () => {
  const root = healthy();
  mkdirSync(join(root, '.context', 'pending'), { recursive: true });
  const out = doctor(root, { gh: fakeGh(null) });
  assert.deepEqual(checks(out), ['note:visibility']);
  assert.match(out.findings[0].message, /NOT checked/);
});

test('members: not cloned is a note; a bad entry is reported', { skip: !posix }, () => {
  const root = healthy();
  editWs(root, (c) => ({
    ...c,
    members: [...c.members, { dir: 'docs-repo', repo: 'acme/doc', kind: 'document' },
      { dir: 'x', kind: 'widget' }, 'nonsense'],
  }));
  mkdirSync(join(root, 'x'));
  const out = doctor(root);
  assert.deepEqual(checks(out).sort(), ['err:members', 'note:members', 'warn:members']);
  assert.match(out.findings.find((f) => f.level === 'note').message, /"docs-repo" is not cloned — gh repo clone acme\/doc docs-repo/);
});

test('a malformed workspace.json is an error, not an exit', { skip: !posix }, () => {
  const root = scratch();
  put(root, '.claude/workspace.json', '{ nope');
  const out = doctor(root);
  assert.equal(out.mode, 'workspace');
  assert.ok(checks(out).includes('err:workspace.json'));
});

test('the docs/ layout: a missing import, a missing index, a stale pending item', { skip: !posix }, () => {
  const root = healthy();
  put(root, 'CLAUDE.md', '# ws\n');
  rmSync(join(root, 'docs', 'threads', 'INDEX.md'));
  put(root, '.context/pending/2026-08-01-entry.md', 'queued\n');
  put(root, 'docs/threads/2026-10-02-bad.md', '---\ntitle: a <tag>\n---\n');
  const out = doctor(root, { gh: fakeGh('PRIVATE') });
  assert.deepEqual(checks(out).sort(), ['err:threads', 'warn:index', 'warn:memory', 'warn:pending']);
  assert.match(out.findings.find((f) => f.check === 'pending').message, /^\.context\/pending\/2026-08-01-entry\.md has been queued 84 days/);
});

// The personal layer (ADR 0002): ~/gh-orgs/docs/memory.md is imported by the user-level
// ~/.claude/CLAUDE.md so it loads everywhere, and its own CLAUDE.md deliberately does not.
test('memory imported from the user-level CLAUDE.md counts as imported', { skip: !posix }, () => {
  const home = scratch();
  const root = healthy();
  put(root, 'CLAUDE.md', '# ws\n');
  put(home, '.claude/CLAUDE.md', `- a rule\n\n@${root}/docs/memory.md\n`);
  assert.deepEqual(doctor(root, { home }).findings, []);

  // `~/` expands to HOME; an import of some other workspace's memory still leaves this one unread.
  const inHome = join(home, 'gh-orgs', 'ws');
  cpSync(root, inHome, { recursive: true });
  put(home, '.claude/CLAUDE.md', '@~/gh-orgs/ws/docs/memory.md\n');
  assert.deepEqual(doctor(inHome, { home }).findings, []);
  // A relative path is taken from ~/.claude/, not the doctor's cwd; trailing punctuation is prose.
  put(home, '.claude/CLAUDE.md', 'See (@../gh-orgs/ws/docs/memory.md).\n');
  assert.deepEqual(doctor(inHome, { home }).findings, []);
  put(home, '.claude/CLAUDE.md', '@docs/memory.md\n');
  assert.deepEqual(checks(doctor(inHome, { home, cwd: inHome })), ['warn:memory']);
  put(home, '.claude/CLAUDE.md', '@~/gh-orgs/other/docs/memory.md\n');
  assert.deepEqual(checks(doctor(inHome, { home })), ['warn:memory']);
});

test('retired keys are not checked in a workspace', { skip: !posix }, () => {
  const root = healthy();
  editWs(root, (c) => ({ ...c, include: ['not a repo'], teaching: { x: {} }, template: {} }));
  put(root, 'handoff/2026-01-01-old.md', '---\nkind: issue\n---\n');
  // A context.json and a marker left in a workspace by its migration are not read either.
  put(root, 'context.json', JSON.stringify({ contextRepo: 'acme/context', template: { version: '1' } }));
  put(root, '.claude/context-project.json', JSON.stringify({ contextRepo: 'acme/other' }));
  assert.deepEqual(doctor(root).findings, []);
  assert.equal(run(DOCTOR, [root, '--include']).status, 2, '--include is an unknown option now');
});

// #60: PROJECT_CONTEXT_REPO named a context repo; nothing reads it any more, so a settings file
// still carrying it is dead configuration worth one line, never a fix the doctor guesses at.
test('a workspace whose settings still set PROJECT_CONTEXT_REPO is told nothing reads it', { skip: !posix }, () => {
  const root = healthy();
  put(root, '.claude/settings.json', JSON.stringify({ env: { PROJECT_CONTEXT_REPO: 'acme/context' } }));
  const out = doctor(root, {}, '--fix');
  // note:plugins too: with a settings file present and no marketplace under the scratch HOME,
  // the plugin ids are reported as not verified.
  const settingsFindings = out.findings.filter((f) => f.check === 'settings');
  assert.deepEqual(settingsFindings.map((f) => f.level), ['warn']);
  assert.match(settingsFindings[0].message, /PROJECT_CONTEXT_REPO.*nothing reads it/);
  assert.deepEqual(out.applied, []);
});

test('--fix never writes workspace.json', { skip: !posix }, () => {
  const root = healthy();
  editWs(root, (c) => ({ ...c, members: 'oops' }));
  const before = readFileSync(join(root, '.claude', 'workspace.json'), 'utf8');
  const out = doctor(root, {}, '--fix');
  assert.deepEqual(out.applied, []);
  assert.equal(readFileSync(join(root, '.claude', 'workspace.json'), 'utf8'), before);
});

// #60: the context-repo mode is gone. A directory holding only context.json is not a workspace,
// and the doctor says it cannot run there — and why — rather than checking it the old way.
test('a retired context repo is refused, exit 2, naming the retirement', () => {
  const root = scratch();
  put(root, 'context.json', JSON.stringify({ contextRepo: 'acme/context', template: { version: '1' } }));
  put(root, 'memory.md', '# Memory\n');
  const r = run(DOCTOR, [root, '--json']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /context repos are retired \(ADR 0002, #60\)/);
});

test('a directory that is not a workspace is refused, exit 2, with or without an argument', () => {
  const root = scratch();
  for (const r of [run(DOCTOR, [root]), run(DOCTOR, [], { cwd: root })]) {
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no \.claude[\\/]workspace\.json at or above/);
    assert.doesNotMatch(r.stderr, /context repo/);
  }
});

test('a context.json below a workspace is judged as part of that workspace', { skip: !posix }, () => {
  const root = healthy();
  const ctx = join(root, 'ctx');
  put(ctx, 'context.json', JSON.stringify({ contextRepo: 'acme/context' }));
  const out = doctor(ctx);
  assert.equal(out.mode, 'workspace');
  assert.equal(out.root, root);
});

// ---------------------------------------------------------------- context-status

const status = (root, ...extra) => run(STATUS, [root, '--json', '--no-memory', '--today', '2026-10-24', ...extra]);

test('status in a workspace counts docs/threads and .context/pending', { skip: !posix }, () => {
  const root = healthy();
  put(root, '.context/pending/2026-10-20-entry.md', 'queued\n');
  const r = status(root);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.kind, 'workspace');
  assert.equal(out.repo, 'acme/workspace');
  assert.deepEqual(out.layout, { threads: 'docs/threads', pending: '.context/pending' });
  assert.equal(out.queues.reconcile.carrying, 1);
  assert.equal(out.queues.pending.count, 1);
  assert.equal(out.queues.threads.total, 1);
  assert.equal(out.queues.threads.index.behind, false);
  assert.match(out.actions.join('\n'), /drain the \.context\/pending\/ queue/);
});

test('status in a workspace: retired queues are not applicable, and the all-clear is given', { skip: !posix }, () => {
  const root = healthy();
  put(root, 'docs/threads/2026-10-01-a-thread.md', '---\ntitle: A thread\nnotion_ids: []\n---\n\n## Decisions\n');
  const r = run(STATUS, [root, '--no-memory', '--today', '2026-10-24']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WHAT TO RUN: nothing — every queue is clear\./);
  assert.doesNotMatch(r.stdout, /cross-project layer/);
  assert.equal(status(root, '--role', 'software-dev').status, 2, '--role is an unknown option');
});

test('status on a retired context repo is refused, exit 2, naming the retirement', () => {
  const root = scratch();
  put(root, 'context.json', JSON.stringify({ contextRepo: 'acme/context' }));
  put(root, 'threads/2026-10-01-a-thread.md', THREAD);
  const r = status(root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /context repos are retired \(ADR 0002, #60\)/);
});

test('status outside any workspace is refused, exit 2', () => {
  const r = status(scratch());
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no \.claude[\\/]workspace\.json at or above/);
});
