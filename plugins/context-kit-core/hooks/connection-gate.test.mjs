// Tests for the PreToolUse connection gate, and for setup-connectors.mjs's write into a
// workspace — the two ends of one policy, so they are tested against the same fixtures. Node
// standard library only — no package.json, no dependency.
//
//   node --test plugins/context-kit-core/hooks/connection-gate.test.mjs
//
// The seam is the hook itself: a PreToolUse payload on stdin, a pinned environment, and an
// assertion on what comes back — a deny on stdout, or silence with (or without) a reason on
// stderr. That is the whole of what a session does with this script. HOME is a scratch dir
// because the Cowork route searches $HOME/mnt; a test inheriting the real HOME would pass or fail
// by what the machine running it holds. Nothing here
// touches the network: the gate never does, and setup-connectors is run non-interactively, which
// stops it before anything is provisioned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const GATE = join(here, 'connection-gate.mjs');
const SETUP = join(here, '..', 'scripts', 'mcp', 'setup-connectors.mjs');
const REPO = 'c-energie/fixture-context';

const tmps = [];
const scratch = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'ck-gate-')));
  tmps.push(d);
  return d;
};
test.after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

const deep = (...parts) => { const d = join(...parts); mkdirSync(d, { recursive: true }); return d; };
const workspace = (dir, body) => {
  deep(dir, '.claude');
  writeFileSync(join(dir, '.claude', 'workspace.json'),
    typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
  return dir;
};
// A member repo nested in the workspace, with a .git of its own — the walk must not stop there.
const member = (root, name = 'member') => {
  const dir = deep(root, 'members', name);
  deep(dir, '.git');
  return dir;
};
// A retired context checkout holding a context.json — the route deleted in #60, kept as a fixture
// to prove nothing reads it any more.
const legacy = (home, connections) => {
  const clone = deep(home, 'clone');
  writeFileSync(join(clone, 'context.json'),
    JSON.stringify({ contextRepo: REPO, ...(connections === undefined ? {} : { connections }) }, null, 2));
  return clone;
};

// Built from scratch rather than spread over process.env, so a developer with
// PROJECT_CONTEXT_REPO exported in their own shell does not configure every case below.
const gate = ({ cwd, home, tool, input, env = {} }) => {
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ tool_name: tool, cwd, ...(input ? { tool_input: input } : {}) }),
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_PROJECT_DIR: cwd, ...env },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `the gate must exit 0 on every path: ${r.stderr}`);
  const denied = r.stdout.trim()
    ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny'
    : false;
  // The deny reason, parsed — stdout is JSON, so its quotes arrive escaped.
  const reason = denied ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : '';
  return { denied, reason, stdout: r.stdout, stderr: r.stderr };
};

// ---------------------------------------------------------------- the gate: workspace route

test('a member nested inside a workspace is gated by the workspace connections', () => {
  const home = scratch();
  const root = workspace(deep(home, 'ws'), { schema: 1, name: 'acme', repo: 'acme/ws', connections: { github: 'github-acme' } });
  const cwd = member(root);
  assert.equal(gate({ cwd, home, tool: 'mcp__github-acme__get_issue' }).denied, false);
  const other = gate({ cwd, home, tool: 'mcp__github-other__get_issue' });
  assert.equal(other.denied, true);
  assert.match(other.stdout, /github-acme/);
  assert.match(other.stdout, /workspace\.json/, 'the deny must name the file to change');
});

test('a context repo the member still declares changes nothing in a workspace', () => {
  const home = scratch();
  const clone = legacy(home, { github: 'github-legacy' });
  const root = workspace(deep(home, 'ws'), { schema: 1, name: 'acme', connections: { github: 'github-acme' } });
  const cwd = member(root);
  const env = { PROJECT_CONTEXT_REPO: REPO, PROJECT_CONTEXT_DIR: clone };
  assert.equal(gate({ cwd, home, env, tool: 'mcp__github-legacy__x' }).denied, true);
  assert.equal(gate({ cwd, home, env, tool: 'mcp__github-acme__x' }).denied, false);
});

test('absent connections in a workspace denies nothing, and says why', () => {
  const home = scratch();
  const root = workspace(deep(home, 'ws'), { schema: 1, name: 'acme' });
  const r = gate({ cwd: member(root), home, tool: 'mcp__github-anything__x' });
  assert.equal(r.denied, false);
  assert.match(r.stderr, /declares no connections/);
});

test('connections: {} in a workspace denies every provider connector', () => {
  const home = scratch();
  const root = workspace(deep(home, 'ws'), { schema: 1, name: 'acme', connections: {} });
  const cwd = member(root);
  for (const tool of ['mcp__github-acme__x', 'mcp__notion-acme__x', 'mcp__slack__x']) {
    const r = gate({ cwd, home, tool });
    assert.equal(r.denied, true, tool);
    assert.match(r.stdout, /deliberate/);
  }
  // ...but a server that resembles no provider is not the gate's to judge.
  assert.equal(gate({ cwd, home, tool: 'mcp__filesystem__read' }).denied, false);
});

test('an owner-keyed map in a workspace allows each declared connector and nothing else', () => {
  const home = scratch();
  const root = workspace(deep(home, 'ws'), {
    schema: 1, name: 'acme',
    connections: { github: { acme: 'github-acme', 'acme-labs': 'github-acme-labs' } },
  });
  const cwd = member(root);
  assert.equal(gate({ cwd, home, tool: 'mcp__github-acme__x' }).denied, false);
  assert.equal(gate({ cwd, home, tool: 'mcp__github-acme-labs__x' }).denied, false);
  const r = gate({ cwd, home, tool: 'mcp__github-other__x' });
  assert.equal(r.denied, true);
  assert.match(r.reason, /"github-acme" \(acme\) and "github-acme-labs" \(acme-labs\)/);
});

test('a malformed workspace.json fails open, naming the file', () => {
  const home = scratch();
  const root = workspace(deep(home, 'ws'), '{ "schema": 1, "connections": { "github": ');
  const r = gate({ cwd: member(root), home, tool: 'mcp__github-anything__x' });
  assert.equal(r.denied, false);
  assert.match(r.stderr, /workspace\.json is malformed/);
  assert.match(r.stderr, /could NOT be read/);
});

test('a malformed workspace.json is not skipped past to an outer workspace', () => {
  const home = scratch();
  const outer = workspace(deep(home, 'outer'), { schema: 1, name: 'outer', connections: {} });
  const inner = workspace(deep(outer, 'inner'), 'not json');
  assert.equal(gate({ cwd: member(inner), home, tool: 'mcp__github-anything__x' }).denied, false);
});

test('a malformed workspace.json fails open even with a context repo configured', () => {
  const home = scratch();
  const clone = legacy(home, { github: 'github-legacy' });
  const root = workspace(deep(home, 'ws'), 'not json');
  const env = { PROJECT_CONTEXT_REPO: REPO, PROJECT_CONTEXT_DIR: clone };
  const r = gate({ cwd: member(root), home, env, tool: 'mcp__github-other__x' });
  assert.equal(r.denied, false);
  assert.match(r.stderr, /malformed/);
});

test('connections that is not an object fails open rather than denying everything', () => {
  const home = scratch();
  for (const connections of ['github-acme', ['github-acme'], null]) {
    const root = workspace(deep(home, `ws-${JSON.stringify(connections).length}`), { schema: 1, connections });
    const r = gate({ cwd: root, home, tool: 'mcp__github-other__x' });
    assert.equal(r.denied, false, JSON.stringify(connections));
    assert.match(r.stderr, /not an object/);
  }
});

// ---------------------------------------------------------------- the gate: no workspace
// The context-repo route is gone (#60): a context.json policy, a marker and an opt-out are all
// configured below, and none of them is read.

test('with no workspace, a context repo\'s context.json policy is not read', () => {
  const home = scratch();
  const clone = legacy(home, { github: 'github-legacy' });
  const cwd = deep(home, 'project');
  const env = { PROJECT_CONTEXT_REPO: REPO, PROJECT_CONTEXT_DIR: clone };
  const r = gate({ cwd, home, env, tool: 'mcp__github-other__x' });
  assert.equal(r.denied, false);
  assert.match(r.stderr, /no connections policy found/);
});

test('with no workspace, a context-project.json marker is not read', () => {
  const home = scratch();
  const cwd = deep(home, 'project');
  deep(cwd, '.claude');
  writeFileSync(join(cwd, '.claude', 'context-project.json'),
    JSON.stringify({ contextRepo: REPO, connections: { notion: 'notion-acme' } }));
  assert.equal(gate({ cwd, home, tool: 'mcp__notion-other__x' }).denied, false);
});

test('with nothing configured at all, the gate fails open with a reason', () => {
  const home = scratch();
  const r = gate({ cwd: deep(home, 'project'), home, tool: 'mcp__github-x__y' });
  assert.equal(r.denied, false);
  assert.match(r.stderr, /no connections policy found/);
});

test('a non-MCP tool is ignored silently', () => {
  const home = scratch();
  const root = workspace(deep(home, 'ws'), { schema: 1, connections: {} });
  const r = gate({ cwd: root, home, tool: 'Bash' });
  assert.equal(r.denied, false);
  assert.equal(r.stderr, '');
});

// ---------------------------------------------------------------- the gate: Cowork route (#61)
// A sandbox session: no workspace above the working dir, and the workspace.json uploaded to
// ~/mnt/uploads (flat, as uploads are believed to arrive). HOME is scratch, so this is the one
// mount layout a test can build without root; cowork-workspace.test.mjs covers the others.

const WS_REPO = 'acme/workspace';
const cowork = (connections, { at = 'workspace.json', extra = {} } = {}) => {
  const home = scratch();
  const file = join(deep(home, 'mnt', 'uploads', dirname(at)), 'workspace.json');
  writeFileSync(file, JSON.stringify({
    schema: 1, name: 'acme', repo: WS_REPO,
    members: [{ dir: 'members/code', repo: 'acme/code', kind: 'code' }],
    ...(connections === undefined ? {} : { connections }), ...extra,
  }));
  return { home, cwd: deep(home, 'sessions', 'outputs') };
};
const write = (path, repo = 'workspace', owner = 'acme') => ({ owner, repo, path, content: 'x', message: 'm', branch: 'main' });

test('Cowork: the uploaded workspace.json is found, flat or under .claude/, and gates connectors', () => {
  for (const at of ['workspace.json', join('.claude', 'workspace.json')]) {
    const { home, cwd } = cowork({ github: 'github-acme' }, { at });
    assert.equal(gate({ cwd, home, tool: 'mcp__github-acme__get_file_contents', input: { owner: 'acme', repo: 'workspace', path: 'README.md' } }).denied, false, at);
    const r = gate({ cwd, home, tool: 'mcp__github-other__get_file_contents' });
    assert.equal(r.denied, true, at);
  }
});

test('Cowork: a walk-up workspace wins over an uploaded one', () => {
  const { home } = cowork({ github: 'github-uploaded' });
  const root = workspace(deep(home, 'ws'), { schema: 1, name: 'acme', repo: WS_REPO, connections: { github: 'github-checkout' } });
  const cwd = member(root);
  assert.equal(gate({ cwd, home, tool: 'mcp__github-checkout__create_or_update_file', input: write('src/a.py') }).denied, false,
    'a checkout is the laptop route: no allowlist');
  assert.equal(gate({ cwd, home, tool: 'mcp__github-uploaded__x' }).denied, true);
});

test('Cowork: nothing found anywhere fails open, saying where it looked', () => {
  const home = scratch();
  const r = gate({ cwd: deep(home, 'sessions', 'outputs'), home, tool: 'mcp__github-acme__create_or_update_file', input: write('docs/memory.md') });
  assert.equal(r.denied, false);
  assert.match(r.stderr, /uploaded to the sandbox mount areas/);
});

test('Cowork: writes under the allowlist pass, curated and code paths are denied naming it', () => {
  const { home, cwd } = cowork({ github: 'github-acme' });
  const tool = 'mcp__github-acme__create_or_update_file';
  for (const path of ['docs/threads/x.md', '.context/pending/y.json']) {
    const r = gate({ cwd, home, tool, input: write(path) });
    assert.equal(r.denied, false, `${path}: ${r.reason}`);
  }
  for (const path of ['docs/memory.md', 'GLOSSARY.md', 'src/a.py', 'docs/threads/../memory.md']) {
    const r = gate({ cwd, home, tool, input: write(path) });
    assert.equal(r.denied, true, path);
    assert.match(r.reason, /docs\/threads\/, docs\/meetings\/, \.context\//, path);
    assert.match(r.reason, /truncated/, 'the deny gives the why');
  }
  assert.equal(gate({ cwd, home, tool: 'mcp__github-acme__delete_file', input: write('docs/adr/0001.md') }).denied, true);
});

test('Cowork: push_files with one disallowed path is denied whole', () => {
  const { home, cwd } = cowork({ github: 'github-acme' });
  const input = { owner: 'acme', repo: 'workspace', branch: 'main', message: 'm',
    files: [{ path: 'docs/threads/a.md', content: 'x' }, { path: 'docs/memory.md', content: 'x' }] };
  const r = gate({ cwd, home, tool: 'mcp__github-acme__push_files', input });
  assert.equal(r.denied, true);
  assert.match(r.reason, /"docs\/memory\.md"/);
  assert.doesNotMatch(r.reason, /"docs\/threads\/a\.md"/, 'only the offending path is named');
  input.files.pop();
  assert.equal(gate({ cwd, home, tool: 'mcp__github-acme__push_files', input }).denied, false);
});

test('Cowork: a write to a member repo or any other repo is denied, reads are not', () => {
  const { home, cwd } = cowork({ github: 'github-acme' });
  for (const [owner, repo] of [['acme', 'code'], ['someone', 'else']]) {
    const r = gate({ cwd, home, tool: 'mcp__github-acme__create_or_update_file', input: write('docs/threads/x.md', repo, owner) });
    assert.equal(r.denied, true, `${owner}/${repo}`);
    assert.match(r.reason, /not this workspace's repo/);
  }
  for (const input of [{ owner: 'acme', repo: 'code', path: 'src/a.py' }, { owner: 'acme', repo: 'workspace', path: 'docs/memory.md' }]) {
    assert.equal(gate({ cwd, home, tool: 'mcp__github-acme__get_file_contents', input }).denied, false, JSON.stringify(input));
  }
  // A write with no repo named cannot be shown to target the workspace, so it is not allowed.
  assert.equal(gate({ cwd, home, tool: 'mcp__github-acme__create_or_update_file', input: { path: 'docs/threads/x.md' } }).denied, true);
});

test('Cowork: a github connector not named for the repo owner is denied, map case included', () => {
  // Plain string: only that one.
  let s = cowork({ github: 'github-acme' });
  assert.equal(gate({ ...s, tool: 'mcp__github-personal__get_file_contents' }).denied, true);
  // Owner-keyed map: the workspace repo owner's entry passes, the other declared one does not —
  // on a laptop both would.
  s = cowork({ github: { acme: 'github-acme', corson94: 'github-personal' } });
  assert.equal(gate({ ...s, tool: 'mcp__github-acme__get_file_contents' }).denied, false);
  const r = gate({ ...s, tool: 'mcp__github-personal__get_file_contents' });
  assert.equal(r.denied, true);
  assert.match(r.reason, /acme\/workspace's owner \(acme\)/);
  assert.match(r.reason, /Use github-acme/);
  // A map with no entry for the owner: no github connector at all.
  s = cowork({ github: { corson94: 'github-personal' } });
  const none = gate({ ...s, tool: 'mcp__github-personal__get_file_contents' });
  assert.equal(none.denied, true);
  assert.match(none.reason, /no github connection for acme\/workspace's owner/);
  // Other providers keep the ordinary rule.
  s = cowork({ github: 'github-acme', notion: 'notion-acme' });
  assert.equal(gate({ ...s, tool: 'mcp__notion-acme__query' }).denied, false);
  assert.equal(gate({ ...s, tool: 'mcp__notion-other__query' }).denied, true);
});

// ---------------------------------------------------------------- setup-connectors in a workspace

// Every file under a directory, relative — to prove which files a run created.
const tree = (dir, prefix = '') => existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
    ? tree(join(dir, e.name), `${prefix}${e.name}/`)
    : [`${prefix}${e.name}`]))
  : [];

const setup = ({ cwd, home, args }) => spawnSync(process.execPath, [SETUP, ...args], {
  cwd, input: '', encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: home, CLAUDE_PROJECT_DIR: cwd },
});

// Hand-formatted, with a decoy "connections" nested inside state that a raw text search would
// find first, and member fields only project-workspace knows about.
const WS_TEXT = `{
  "schema": 1,
  "name": "Acme Thesis",
  "repo": "acme/thesis-workspace",
  "members": [ { "dir": "members/code", "repo": "acme/code", "kind": "code", "extra": true } ],
  "state": { "notion": { "connections": { "keep": "me" } } },
  "connections": { "github": "github-acme" }
}
`;

test('setup-connectors in a member edits only connections in the nearest workspace.json', () => {
  const base = scratch();
  const home = deep(base, 'home');
  const root = deep(base, 'ws');
  workspace(root, WS_TEXT);
  const cwd = member(root, 'code');
  const before = tree(home);

  const r = setup({ cwd, home, args: ['--add', 'github:acme-labs'] });
  assert.match(r.stdout, /workspace: .*workspace\.json/, r.stdout + r.stderr);

  const file = join(root, '.claude', 'workspace.json');
  const after = readFileSync(file, 'utf8');
  const cfg = JSON.parse(after);
  // The existing string is promoted under the workspace repo's owner, not the project slug.
  assert.deepEqual(cfg.connections, { github: { acme: 'github-acme', 'acme-labs': 'github-acme-thesis-acme-labs' } });
  assert.deepEqual(cfg.state, { notion: { connections: { keep: 'me' } } });
  // Every line but the connections one is byte-identical.
  const a = WS_TEXT.split('\n'), b = after.split('\n');
  assert.equal(a.length, b.length);
  assert.deepEqual(b.filter((l, i) => l !== a[i]).length, 1);
  assert.match(b.find((l, i) => l !== a[i]), /^ {2}"connections": /);
  assert.equal(readFileSync(`${file}.bak-connections`, 'utf8'), WS_TEXT, 'the backup is the file as it was');
  // No registry file was written: neither the host config nor Claude Code's user scope.
  assert.deepEqual(tree(home), before);
});

test('setup-connectors inserts a missing connections block without touching the rest', () => {
  const base = scratch();
  const home = deep(base, 'home');
  const root = deep(base, 'ws');
  const text = WS_TEXT.replace(',\n  "connections": { "github": "github-acme" }', '');
  workspace(root, text);
  setup({ cwd: member(root), home, args: ['--add', 'github'] });
  const after = readFileSync(join(root, '.claude', 'workspace.json'), 'utf8');
  assert.deepEqual(JSON.parse(after).connections, { github: 'github-acme-thesis' });
  assert.ok(after.startsWith(text.slice(0, text.lastIndexOf('\n}'))), 'everything before the insert is untouched');
});

test('setup-connectors --check in a workspace with connections: {} reports a deliberate none', () => {
  const base = scratch();
  const root = workspace(deep(base, 'ws'), { schema: 1, name: 'acme', connections: {} });
  const r = setup({ cwd: member(root), home: deep(base, 'home'), args: ['--check'] });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /deliberately/);
});

test('setup-connectors refuses a malformed nearest workspace.json rather than edit another file', () => {
  const base = scratch();
  const home = deep(base, 'home');
  const clone = legacy(home, { github: 'github-legacy' });
  const root = workspace(deep(base, 'ws'), 'not json');
  const cwd = member(root);
  const r = spawnSync(process.execPath, [SETUP, '--add', 'github:other'], {
    cwd, input: '', encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_PROJECT_DIR: cwd, PROJECT_CONTEXT_REPO: REPO, PROJECT_CONTEXT_DIR: clone },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /malformed/);
  assert.equal(existsSync(join(clone, 'context.json.bak-connections')), false);
});

test('setup-connectors --context refuses a context.json, saying context repos are retired', () => {
  const base = scratch();
  const home = deep(base, 'home');
  const clone = legacy(home, {});
  const root = workspace(deep(base, 'ws'), { schema: 1, name: 'acme', connections: { github: 'x' } });
  const r = setup({ cwd: root, home, args: ['--check', '--context', join(clone, 'context.json')] });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /context repos are retired/);
});
