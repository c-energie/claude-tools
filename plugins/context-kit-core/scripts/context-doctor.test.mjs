// Tests for context-doctor.mjs and context-status.mjs in a workspace (ADR 0002, #52), and that a
// legacy context repo is still checked as before. Node standard library only, no network.
//
//   node --test plugins/context-kit-core/scripts/context-doctor.test.mjs
//
// HOME is a scratch dir, so neither the developer's ~/.claude/settings.json (whose autoload flag
// the doctor reports) nor their native memory leaks into a result. The one network call the
// doctor makes — `gh repo view`, for visibility — is answered by a fake `gh` put first on PATH,
// so the public-repo warning is tested without a token or a repo. POSIX only: the fake is a
// shell script, and os.homedir() follows HOME only there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync } from 'node:fs';
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

function run(script, args, { cwd, gh = null } = {}) {
  const home = scratch();
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

test('retired keys are not checked in a workspace', { skip: !posix }, () => {
  const root = healthy();
  editWs(root, (c) => ({ ...c, include: ['not a repo'], teaching: { x: {} }, template: {} }));
  put(root, 'handoff/2026-01-01-old.md', '---\nkind: issue\n---\n');
  assert.deepEqual(doctor(root).findings, []);
});

test('--fix never writes workspace.json', { skip: !posix }, () => {
  const root = healthy();
  editWs(root, (c) => ({ ...c, members: 'oops' }));
  const before = readFileSync(join(root, '.claude', 'workspace.json'), 'utf8');
  const out = doctor(root, {}, '--fix');
  assert.deepEqual(out.applied, []);
  assert.equal(readFileSync(join(root, '.claude', 'workspace.json'), 'utf8'), before);
});

test('a legacy context repo is still checked as before', { skip: !posix }, () => {
  const root = scratch();
  put(root, 'context.json', JSON.stringify({ contextRepo: 'acme/context', template: { version: '1' } }));
  put(root, 'memory.md', '# Memory\n');
  const out = doctor(root);
  assert.equal(out.mode, 'context-repo');
  assert.equal(out.workspace, null);
  assert.ok(checks(out).includes('warn:marker'), checks(out));
});

// #54: the checks for the cross-project layer are gone, not merely skipped in a workspace. A
// legacy repo still carrying that data is judged on everything else, and gets no finding for it.
test('a legacy context repo still carrying retired keys gets no finding for them', { skip: !posix }, () => {
  const root = scratch();
  put(root, 'context.json', JSON.stringify({
    contextRepo: 'acme/context', template: { version: '1' },
    include: ['not a repo'], teaching: { x: {} }, assistants: { editor: {} }, supervisors: { editor: {} },
  }));
  put(root, 'memory.md', '# Memory\n');
  put(root, 'handoff/2026-01-01-old.md', '---\nkind: issue\n---\n');
  const out = doctor(root);
  assert.equal(out.mode, 'context-repo');
  assert.deepEqual(checks(out).filter((c) => /include|teaching|handoff/.test(c)), []);
  assert.equal(out.includes, undefined, 'no includes report in --json');
  assert.equal(run(DOCTOR, [root, '--include']).status, 2, '--include is an unknown option now');
});

test('a context repo is a root of its own, even below a workspace', { skip: !posix }, () => {
  const root = healthy();
  const ctx = join(root, 'ctx');
  put(ctx, 'context.json', JSON.stringify({ contextRepo: 'acme/context' }));
  assert.equal(doctor(ctx).mode, 'context-repo');
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

test('status on a legacy context repo is unchanged', { skip: !posix }, () => {
  const root = scratch();
  put(root, 'context.json', JSON.stringify({ contextRepo: 'acme/context' }));
  put(root, 'threads/2026-10-01-a-thread.md', THREAD);
  put(root, 'pending/2026-10-20-entry.md', 'queued\n');
  const out = JSON.parse(status(root).stdout);
  assert.equal(out.kind, 'project context repo');
  assert.equal(out.queues.reconcile.carrying, 1);
  assert.equal(out.queues.pending.count, 1);
});

// #54: with the cross-project queues gone, a legacy repo that still declares supervisors is an
// ordinary project repo, counts only its own queues, and can be told every queue is clear.
test('status on a legacy repo still declaring retired keys: only the surviving queues', { skip: !posix }, () => {
  const root = scratch();
  put(root, 'context.json', JSON.stringify({
    contextRepo: 'acme/context', include: ['acme/other'], supervisors: { editor: {} }, assistants: { editor: {} },
  }));
  put(root, 'handoff/2026-01-01-old.md', '---\nproject: acme/other\n---\n');
  const r = status(root);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.kind, 'project context repo');
  assert.deepEqual(Object.keys(out.queues), ['threads', 'reconcile', 'pending', 'memory']);
  assert.equal(out.declared, undefined);
  assert.deepEqual(out.actions, []);
  assert.match(run(STATUS, [root, '--no-memory', '--today', '2026-10-24']).stdout, /every queue is clear/);
});
