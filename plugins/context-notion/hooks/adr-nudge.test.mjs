// Tests for the PostToolUse ADR nudge (#18). Node standard library only.
//
//   node --test plugins/context-notion/hooks/adr-nudge.test.mjs
//
// The seam is the hook itself, the way the harness drives it: a synthetic PostToolUse event on
// stdin, and an assertion on stdout — an additionalContext naming log-decision, or nothing — and
// on the exit status, which must be 0 on every path. No session, no real ADR write, no Notion.
// Each case gets its own temp dir (TMPDIR/TEMP/TMP), so the once-per-session record of one case
// cannot silence another, and the environment is built from scratch so a developer's own
// CONTEXT_CONFIG cannot configure every case below. Proving the hook fires inside a live session
// is not automated: that needs a session restart or `/hooks`, since plugin hooks load at start.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, 'adr-nudge.mjs');

const tmps = [];
const scratch = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'cn-adr-')));
  tmps.push(d);
  return d;
};
test.after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const NOTION = { backend: 'notion', notion: { databases: { decisionLog: 'collection://dl' }, pageParents: { decisionLog: 'db-dl' } } };

// Rest args, not a default parameter: an explicit `undefined` must mean "no state key", not NOTION.
const workspace = (...args) => {
  const state = args.length ? args[0] : NOTION;
  const root = scratch();
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
  writeFileSync(join(root, '.claude', 'workspace.json'), JSON.stringify({ schema: 1, name: 'fixture', ...(state === undefined ? {} : { state }) }, null, 2));
  return root;
};

const run = (stdin, { tmp = scratch(), env = {} } = {}) => spawnSync(process.execPath, [HOOK], {
  input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
  encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: scratch(), TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...env },
});

const event = (root, file, extra = {}) => ({
  session_id: 'sess-1', cwd: root, hook_event_name: 'PostToolUse',
  tool_name: 'Write', tool_input: { file_path: file }, tool_response: { type: 'create' }, ...extra,
});

const nudged = (r) => {
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(out.systemMessage, undefined, 'the model must get it, not only the user');
  assert.equal(out.decision, undefined, 'a nudge, never a block');
  return out.hookSpecificOutput.additionalContext;
};
const silent = (r) => {
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
};

test('a numbered ADR in the workspace nudges toward log-decision, naming the file', () => {
  const root = workspace();
  const text = nudged(run(event(root, join(root, 'docs', 'adr', '0003-pick-a-queue.md'))));
  assert.match(text, /log-decision/);
  assert.match(text, /0003-pick-a-queue\.md/);
  assert.match(text, /docs\/adr\/0003-pick-a-queue\.md/);
  assert.match(text, /add-pending/);
  assert.match(text, /ASK the user/);
});

test('a relative path resolves against the event cwd', () => {
  const root = workspace();
  assert.match(nudged(run(event(root, 'docs/adr/0001-x.md'))), /log-decision/);
});

test('an ADR in a member repo nested in the workspace still nudges', () => {
  const root = workspace();
  const member = join(root, 'code');
  mkdirSync(join(member, '.git'), { recursive: true });
  assert.match(nudged(run(event(member, join(member, 'docs', 'adr', '0001-x.md')))), /code\/docs\/adr\/0001-x\.md/);
});

test('an Edit says a row may already exist', () => {
  const root = workspace();
  const text = nudged(run(event(root, join(root, 'docs', 'adr', '0002-y.md'), { tool_name: 'Edit', tool_response: {} })));
  assert.match(text, /query-decisions/);
  assert.match(text, /duplicate/);
});

test('non-ADR files under docs/adr are silent', () => {
  const root = workspace();
  for (const name of ['.gitkeep', 'README.md', 'template.md', 'adr-0001.md']) {
    silent(run(event(root, join(root, 'docs', 'adr', name))));
  }
});

test('a numbered file outside docs/adr is silent', () => {
  const root = workspace();
  silent(run(event(root, join(root, 'docs', 'threads', '0001-x.md'))));
  silent(run(event(root, join(root, 'adr', '0001-x.md'))));
  silent(run(event(root, join(root, 'docs', 'adr', 'old', '0001-x.md'))));
});

test('a second event for the same ADR in one session is silent; another session is nudged', () => {
  const root = workspace();
  const tmp = scratch();
  const file = join(root, 'docs', 'adr', '0001-x.md');
  nudged(run(event(root, file), { tmp }));
  silent(run(event(root, file, { tool_name: 'Edit' }), { tmp }));
  nudged(run(event(root, join(root, 'docs', 'adr', '0002-y.md')), { tmp }));
  nudged(run(event(root, file, { session_id: 'sess-2' }), { tmp }));
});

test('malformed, empty or shapeless stdin is silent and exits 0', () => {
  silent(run(''));
  silent(run('{not json'));
  silent(run('null'));
  silent(run({ tool_name: 'Write' }));
  silent(run({ tool_name: 'Write', tool_input: { file_path: 42 } }));
});

test('no decision log configured is silent', () => {
  for (const state of [undefined, null, { backend: 'files' }, { backend: 'notion', notion: { databases: { actions: 'a' } } }]) {
    const root = workspace(state);
    silent(run(event(root, join(root, 'docs', 'adr', '0001-x.md'))));
  }
});

test('no workspace above the ADR is silent — the legacy context repo is never resolved', () => {
  const dir = scratch();
  silent(run(event(dir, join(dir, 'docs', 'adr', '0001-x.md')), { env: { PROJECT_CONTEXT_REPO: 'c-energie/nowhere' } }));
});

test('a malformed workspace.json is silent', () => {
  const root = workspace();
  writeFileSync(join(root, '.claude', 'workspace.json'), '{ broken');
  silent(run(event(root, join(root, 'docs', 'adr', '0001-x.md'))));
});

test('CONTEXT_CONFIG pins the config, as it does for the scripts', () => {
  const dir = scratch();
  const cfg = join(dir, 'pinned.json');
  writeFileSync(cfg, JSON.stringify({ state: NOTION }));
  assert.match(nudged(run(event(dir, join(dir, 'docs', 'adr', '0001-x.md')), { env: { CONTEXT_CONFIG: cfg } })), /log-decision/);
  writeFileSync(cfg, JSON.stringify({ state: null }));
  silent(run(event(dir, join(dir, 'docs', 'adr', '0001-x.md')), { env: { CONTEXT_CONFIG: cfg } }));
});

test('a Windows-style path is recognised', () => {
  const root = workspace();
  // On POSIX the backslashes are not separators, so this cannot reach the workspace; pin the
  // config instead, which is enough to show the predicate accepts it.
  const cfg = join(root, '.claude', 'workspace.json');
  assert.match(nudged(run(event(root, 'C:\\ws\\docs\\adr\\0001-x.md'), { env: { CONTEXT_CONFIG: cfg } })), /log-decision/);
});
