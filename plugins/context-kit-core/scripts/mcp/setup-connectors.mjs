#!/usr/bin/env node
// Set up this project's MCP connections: a named connection per provider (or several, keyed by
// resource owner), each backed by a credential scoped to just this project's repos or workspace.
//
//   node setup-connectors.mjs                 declare what's missing, then provision it
//   node setup-connectors.mjs --check         diagnose only, change nothing
//   node setup-connectors.mjs --add slack     also declare a provider not yet in the block
//   node setup-connectors.mjs --add github:c-energie   declare a SECOND github connection,
//                                             the one serving that resource owner
//   node setup-connectors.mjs --context <path/to/context.json or workspace.json>
//
// The `connections` block in the nearest `.claude/workspace.json` (ADR 0002) — or, for a project
// not yet migrated to a workspace, its context repo's context.json — is the source of truth, e.g.
//   { "github": "github-acme", "notion": "notion-acme" }
// It names which MCP server serves each provider HERE, which is what stops a machine holding
// several projects' connections from writing through the wrong one. If the block is missing,
// this script proposes names and writes it.
//
// A PROVIDER MAY NAME MORE THAN ONE CONNECTION, as a map of resource owner -> connection:
//   { "github": { "acme": "github-acme", "acme-labs": "github-acme-labs" } }
// because a fine-grained GitHub PAT has a single resource owner — a project spanning two owners
// needs two tokens, so two connectors, and before this there was nowhere to say so. The owner
// key is the point: it says which connector reaches which repositories, so a caller picks
// deterministically instead of discovering the answer as a 404 that reads like "no such repo".
// The plain string stays valid and unchanged; a bare array is tolerated but says nothing about
// which is which, so context-doctor nudges it toward the map. hooks/connection-gate.mjs enforces
// exactly this shape — the two must stay in step, or the gate denies what this writes.
//
// ABSENT and EMPTY are different, and never conflated — the same distinction the repo-name
// resolvers draw between *unconfigured* and *opted out*. No `connections` key means nobody has
// decided yet, so this offers to write one. `"connections": {}` is a decision already taken —
// this project declares none, deliberately — so it is reported and left alone, and `--check`
// exits 0 rather than 1. A cross-project layer that must never hold a workspace credential is
// exactly the repo that writes `{}` and means it; treating that as an omission nags forever and
// invites someone to "fix" it. `--add [provider]` is how a deliberate none is reopened.
//
// IN A WORKSPACE, `connections` IS THE ONLY KEY THIS WRITES. workspace.json has one writing owner
// per top-level key (see workspace.mjs) and this script owns `connections`, so the edit goes
// through json-block.mjs's top-level upsert: every other byte survives, and a `connections` nested
// inside `state` or a member entry cannot be mistaken for the root one — which the raw-text
// search the context.json path still uses could not promise. A malformed nearest workspace.json
// is REFUSED rather than stepped past: the resolver falls back to the context repo for loading,
// but a writer that did the same would edit a file that is no longer this directory's policy.
//
// The runtime is copied out of the plugin into ~/.mcp/ before use, so the paths written into
// the Claude configs survive a plugin update, reinstall or marketplace re-sync.
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bashBin, bashPath } from '../bash-bin.mjs';
import { homedir } from 'node:os';
import { configPaths, detectConfigPaths } from './secret-store.mjs';
import { findWorkspace, WORKSPACE_FILE } from '../workspace.mjs';
import { upsertBlockInFile } from '../json-block.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(homedir(), '.mcp');
const RUNTIME_FILES = ['secret-store.mjs', 'mcp-launch.mjs', 'add-mcp-connector.mjs'];

// Providers this tooling knows how to provision. Adding one here also needs a matching entry
// in add-mcp-connector.mjs's PROVIDERS map.
const PROVIDERS = {
  github: {
    credential: 'a FINE-GRAINED token at github.com/settings/personal-access-tokens, scoped to\nonly the repositories this project should reach. Classic tokens cannot be limited\nper repository and defeat the purpose.',
  },
  notion: {
    credential: "an INTERNAL INTEGRATION at notion.so/profile/integrations, created in THIS\nproject's workspace. Afterwards share the relevant pages with it (••• → Connections)\nor reads come back empty even though the token verifies.",
  },
};

const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);

// A provider declares either one connection name, or a map of resource owner -> name. The map
// exists because a fine-grained GitHub PAT has a single resource owner: a project spanning two
// owners needs two tokens, so two connectors, and the owner key is what tells a caller which
// connector reaches which repositories. Kept in step with hooks/connection-gate.mjs, which
// enforces the same shape and must accept everything written here.
const names = (v) => {
  if (typeof v === 'string') return v ? [v] : [];
  if (Array.isArray(v)) return v.filter((n) => typeof n === 'string' && n);
  if (v && typeof v === 'object') return Object.values(v).filter((n) => typeof n === 'string' && n);
  return [];
};

// [owner, name] pairs for reporting. The string form has no owner to report, hence null.
const entriesOf = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.entries(v).filter(([, n]) => typeof n === 'string' && n);
  }
  return names(v).map((n) => [null, n]);
};

// "github" -> ['github', null]; "github:c-energie" -> ['github', 'c-energie'].
function splitAdd(arg) {
  const i = String(arg).indexOf(':');
  return i < 0 ? [String(arg), null] : [String(arg).slice(0, i), String(arg).slice(i + 1) || null];
}

// ---------------------------------------------------------------- writing context.json

// EDIT THE RAW TEXT, never a parsed-and-restringified object. A context repo's context.json is
// hand-written and hand-formatted — inline objects, a comment key above each block — and
// JSON.stringify(cfg, null, 2) reformats all of it: every inline object explodes into a block
// and the trailing newline is lost, so a two-line change lands as ninety and the real edit is
// unreviewable. This tool writes to a repo whose whole point is that its history reads. The
// diff IS the product. (Done wrong here until 2026-08-30; context-doctor.mjs got it right
// first and its replaceOnce() is the same idea.)

// Render a connections value in the prevailing inline style, dropping to one line per provider
// only when a single line would be unreadable.
function renderConnections(v, indent) {
  const inline = (o) => `{ ${Object.entries(o)
    .map(([k, x]) => `${JSON.stringify(k)}: ${typeof x === 'string' ? JSON.stringify(x) : inline(x)}`)
    .join(', ')} }`;
  const one = inline(v);
  if (one.length + indent.length <= 110) return one;
  const pad = `${indent}  `;
  return `{\n${Object.entries(v)
    .map(([k, x]) => `${pad}${JSON.stringify(k)}: ${typeof x === 'string' ? JSON.stringify(x) : inline(x)}`)
    .join(',\n')}\n${indent}}`;
}

// Span of the JSON value following "connections": in raw text. Brace-matched and string-aware,
// so a brace inside a value cannot end it early. Returns null when the key is absent or the
// value is not an object — callers must then say what they are about to do instead of guessing.
function connectionsSpan(raw) {
  const key = raw.search(/"connections"\s*:/);
  if (key < 0) return null;
  let i = raw.indexOf(':', key) + 1;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  if (raw[i] !== '{') return null;
  const start = i;
  let depth = 0, inStr = false, esc = false;
  for (; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { start, end: i + 1 };
  }
  return null;
}

function has(cmd) {
  const probe = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', `${cmd} --version`], { encoding: 'utf8', windowsHide: true })
    : spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

// Windows editors and PowerShell routinely write JSON with a UTF-8 BOM, which JSON.parse
// rejects — strip it before parsing anything user-editable.
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

// ---------------------------------------------------------------- context.json

// Neither Node nor cmd/PowerShell expands a leading ~ in an argument, so do it here — people
// copy paths out of documentation and shell prompts where the tilde is conventional.
function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

// The managed clone lives at ~/.context/<owner>/<repo> — the same layout context-repo.sh
// uses, since it is what puts clones there. Owner included because context repos tend to
// all be named "context", and it is its own directory level so the layout mirrors GitHub's.
const cloneDir = (repo) => join(homedir(), '.context', ...repo.split('/'));

// Which context repo does this project declare? The env var, then the project's .claude
// settings files (local beats project, matching the client's own precedence). Parsed as
// real JSON — the value normally sits inside an "env" block.
function declaredRepo() {
  if (process.env.PROJECT_CONTEXT_REPO) return process.env.PROJECT_CONTEXT_REPO;
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  for (const f of ['settings.local.json', 'settings.json']) {
    const p = join(cwd, '.claude', f);
    if (!existsSync(p)) continue;
    try {
      const s = readJson(p);
      const v = s?.env?.PROJECT_CONTEXT_REPO ?? s?.PROJECT_CONTEXT_REPO;
      if (typeof v === 'string' && v) return v;
    } catch { /* an unparsable settings file names nothing */ }
  }
  return null;
}

// context-repo.sh runs under Git Bash, where $HOME is /c/Users/... — so on Windows it
// prints an MSYS path Node cannot stat. Map /c/... back to C:\... before use.
function nativePath(p) {
  const m = process.platform === 'win32' && /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? '/').replace(/\//g, '\\')}` : p;
}

// The plugin's resolver owns marker-file discovery, git credentials, and the first-time
// clone into ~/.context — anything beyond "the clone is already there".
function resolverContext() {
  const resolver = join(HERE, '..', '..', 'scripts', 'context-repo.sh');
  if (!existsSync(resolver)) return null;
  const bash = bashBin();
  if (!bash) return null;
  const out = spawnSync(bash, [bashPath(resolver), '--no-pull'],
    { encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) return null;
  const root = nativePath((out.stdout ?? '').trim());
  if (!root) return null;
  const p = join(root, 'context.json');
  return existsSync(p) ? p : null;
}

// A file is a workspace file by its place, `.claude/workspace.json`, never by its contents —
// the same rule the resolver uses to decide what a directory is.
const isWorkspaceFile = (p) => resolve(p).endsWith(sep + WORKSPACE_FILE);

// Explicit path, then the nearest workspace.json, then the declared repo's managed clone in
// ~/.context, then the resolver (which can create that clone), then the working directory. Never
// guess a context repo — if none of these produce one, say precisely why and stop.
// -> { path, workspace?: true } or { path: null, hint }
function findContext(explicit) {
  if (explicit) {
    let p = resolve(expandHome(explicit));
    if (!existsSync(p)) return { path: null, hint: `--context ${explicit} does not exist` };
    // Accept the file itself, or a directory holding a context.json or a .claude/workspace.json.
    if (!p.endsWith('.json')) {
      const ctx = join(p, 'context.json');
      p = existsSync(ctx) ? ctx : join(p, WORKSPACE_FILE);
    }
    return existsSync(p)
      ? { path: p, workspace: isWorkspaceFile(p) }
      : { path: null, hint: `--context ${explicit} holds no context.json or ${WORKSPACE_FILE}` };
  }

  // The workspace first, found by walking up — a member repo nested inside a workspace declares
  // no repo of its own, and the legacy routes below look only in the project dir itself.
  const ws = findWorkspace(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (ws?.root) return { path: ws.file, workspace: true };
  if (ws?.error) {
    return {
      path: null,
      hint: `${ws.file} is malformed (${ws.error}) — fix it first; editing the context repo's `
        + 'connections instead would change a policy this directory no longer uses',
    };
  }

  const repo = declaredRepo();
  if (repo) {
    const managed = join(cloneDir(repo), 'context.json');
    if (existsSync(managed)) return { path: managed };
    const cloned = resolverContext();
    if (cloned) return { path: cloned };
    return existsSync(cloneDir(repo))
      ? {
          path: null,
          hint: `${cloneDir(repo)} exists but holds no context.json — is ${repo} really a context repo?`,
        }
      : {
          path: null,
          hint: `this project declares PROJECT_CONTEXT_REPO=${repo}, but there is no clone at `
            + `${cloneDir(repo)} and cloning failed (offline, or no git credential — `
            + `try 'gh auth login' or CONTEXT_GIT_TOKEN)`,
        };
  }

  const found = resolverContext();
  if (found) return { path: found };

  const local = resolve('context.json');
  return { path: existsSync(local) ? local : null };
}

// A short project identifier for naming connections, from the file's own fields or the
// directory holding it. Context repos are often "<project>-context", so drop that suffix. A
// workspace has exactly one name field, `name`, and its directory is the one ABOVE .claude/ —
// basename(dirname(file)) would name every workspace ".claude".
function projectSlug(contextFile, cfg, workspace) {
  const raw = workspace
    ? (cfg.name ?? basename(dirname(dirname(contextFile))))
    : (cfg.project ?? cfg.name ?? cfg.slug ?? basename(dirname(contextFile)));
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-context$/, '')
    .replace(/^-+|-+$/g, '') || 'project';
}

// ---------------------------------------------------------------- machine state

// Registered on the HOST: the desktop config, which serves the desktop chat app and Cowork.
// Claude Code's user scope is read too, because a machine part-way through the move to
// per-repo scoping still has servers there.
function hostServers() {
  const names = new Set();
  for (const p of detectConfigPaths()) {
    if (!existsSync(p)) continue;
    try { for (const k of Object.keys(readJson(p).mcpServers ?? {})) names.add(k); }
    catch { /* a config we cannot parse is not evidence of absence */ }
  }
  return names;
}

// What CLAUDE CODE can actually see FROM THIS DIRECTORY, which is a different question: its
// user scope, a committed `.mcp.json` here (project scope), and this directory's own entry in
// ~/.claude.json (local scope). Registered on the host does not imply available to a session —
// that gap is the whole point of scoping servers per repo, and it has to be reported, not
// assumed either way.
function codeScopedServers() {
  const names = new Set();
  const add = (obj) => { for (const k of Object.keys(obj ?? {})) names.add(k); };
  const code = join(homedir(), '.claude.json');
  try { if (existsSync(code)) add(readJson(code).mcpServers); } catch { }
  try { if (existsSync('.mcp.json')) add(readJson('.mcp.json').mcpServers); } catch { }
  try {
    if (existsSync(code)) {
      const here = resolve(process.cwd());
      for (const [dir, entry] of Object.entries(readJson(code).projects ?? {})) {
        if (resolve(dir) === here) add(entry?.mcpServers);
      }
    }
  } catch { }
  return names;
}

// Configured AT ALL, anywhere — what "missing" means, and therefore what decides whether a
// second credential needs minting. Reporting a locally scoped connector as missing would send
// someone to provision one that already works.
function configuredServers() {
  return new Set([...hostServers(), ...codeScopedServers()]);
}

function deployRuntime() {
  mkdirSync(join(RUNTIME, 'bin'), { recursive: true });
  for (const f of RUNTIME_FILES) {
    const src = join(HERE, f);
    if (!existsSync(src)) throw new Error(`missing ${src} — plugin install looks incomplete`);
    copyFileSync(src, join(RUNTIME, f));
  }
  return join(RUNTIME, 'add-mcp-connector.mjs');
}

function findBinary() {
  const name = process.platform === 'win32' ? 'github-mcp-server.exe' : 'github-mcp-server';
  const p = join(RUNTIME, 'bin', name);
  return existsSync(p) ? p : null;
}

// ---------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  // --add github            declare github, if it is not declared at all
  // --add github:c-energie  declare a SECOND github connection, the one serving that owner.
  // The owner suffix is what makes a second connection expressible: a fine-grained PAT has one
  // resource owner, so reaching two owners needs two tokens and two connectors, and the owner
  // is the key that tells a caller which is which.
  const addArg = at('--add');
  const [extraProvider, extraOwner] = addArg ? splitAdd(addArg) : [null, null];

  console.log('\nProject connections\n');

  const { path: contextFile, hint, workspace } = findContext(at('--context'));
  if (!contextFile) {
    bad(hint ?? 'No workspace.json or context.json found.');
    console.log('\n  Context repos are cloned to ~/.context/<owner>/<repo>, named by the');
    console.log("  PROJECT_CONTEXT_REPO env var or the project's .claude/settings.json.");
    console.log('  Pass --context <path> to override, or see the context-setup skill.\n');
    return 1;
  }
  ok(`${workspace ? 'workspace' : 'context'}: ${contextFile}`);

  let cfg;
  try { cfg = readJson(contextFile); }
  catch (e) { bad(`could not parse ${contextFile}: ${e.message}`); return 1; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    bad(`${contextFile}: top level is not a JSON object`); return 1;
  }

  const slug = projectSlug(contextFile, cfg, workspace);
  // DEEP copy, and the original captured as text before anything touches it. A spread is
  // shallow, so once a provider's value is a map, `connections[p][owner] = name` mutates the
  // parsed cfg as well — and the change test below then compares the object with itself, finds
  // no difference, and writes nothing. `--add github:[owner]` against an existing map silently
  // did nothing until 2026-08-30. It only worked while every value was a string, because
  // assigning a string REPLACES it rather than mutating through the shared reference.
  const connectionsBefore = JSON.stringify(cfg.connections ?? {});
  const connections = JSON.parse(connectionsBefore);
  // Present but empty: a committed "this project declares none", not a gap to fill.
  const declaredNone = cfg.connections !== undefined && !Object.keys(cfg.connections).length;
  const interactive = process.stdin.isTTY && !checkOnly;
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  try {
    // --- declare, if there is nothing to work from ---
    const wanted = extraProvider ? [extraProvider] : [];
    if (!Object.keys(connections).length && !wanted.length) {
      if (declaredNone) {
        ok('"connections": {} — this project declares no connections, deliberately.');
        console.log('\n  Nothing to provision, and nothing wrong. Every skill that needs a');
        console.log('  connection stands down here rather than reaching for another project.');
        console.log('  To reopen the decision, name the provider: --add github\n');
        return 0;
      }
      warn('No "connections" block — nothing declared for this project yet.');
      if (!interactive) {
        console.log('\n  Add one naming the MCP server each provider should use here, e.g.');
        console.log(`    "connections": { "github": "github-${slug}" }`);
        console.log('  Or run this interactively to be walked through it.\n');
        return 1;
      }
      console.log(`\nLet's declare them. Project identifier: "${slug}"\n`);
      for (const p of Object.keys(PROVIDERS)) {
        const yes = (await rl.question(`  Use ${p} in this project? [y/N]: `)).trim().toLowerCase();
        if (yes === 'y') wanted.push(p);
      }
      if (!wanted.length) { console.log('\nNothing declared. Stopping.\n'); return 0; }
    }

    for (const p of wanted) {
      if (!PROVIDERS[p]) { warn(`No recipe for provider "${p}" — add one to add-mcp-connector.mjs.`); continue; }
      const existingNames = names(connections[p]);
      // Without an owner this is "is this provider declared at all", as before. With one it is
      // "is THIS owner declared" — otherwise a second connection could never be added, since the
      // provider is already present the moment the first one exists.
      if (!extraOwner && existingNames.length) {
        ok(`${p}: ${existingNames.join(', ')} (already declared)`); continue;
      }
      if (extraOwner && connections[p] && typeof connections[p] === 'object'
          && !Array.isArray(connections[p]) && connections[p][extraOwner]) {
        ok(`${p}: ${connections[p][extraOwner]} (already declared for ${extraOwner})`); continue;
      }
      // The owner of the context repo itself is the right default for the connection that was
      // already there: it is the owner every core skill actually needs (save-thread, the
      // bootstrap read), and the project slug is a project name, not a GitHub owner. In a
      // workspace that is the workspace's own `repo`.
      const homeRepo = workspace ? cfg.repo : cfg.contextRepo;
      const homeOwner = (typeof homeRepo === 'string' && homeRepo.includes('/'))
        ? homeRepo.split('/')[0]
        : slug;
      const suggested = extraOwner ? `${p}-${slug}-${extraOwner}` : `${p}-${slug}`;
      const chosen = rl
        ? ((await rl.question(`  Name for the ${p} connection${extraOwner ? ` serving ${extraOwner}` : ''} [${suggested}]: `)).trim() || suggested)
        : suggested;
      if (!extraOwner) { connections[p] = chosen; continue; }
      // Promote a string to the map form rather than overwriting it — the existing connection
      // keeps serving whatever it served, and losing it here would silently revoke access.
      if (typeof connections[p] === 'string' && connections[p]) {
        const owner = await (rl
          ? rl.question(`  Which owner does the existing "${connections[p]}" serve? [${homeOwner}]: `)
          : Promise.resolve(''));
        connections[p] = { [(owner || '').trim() || homeOwner]: connections[p] };
      } else if (!connections[p] || typeof connections[p] !== 'object' || Array.isArray(connections[p])) {
        connections[p] = {};
      }
      connections[p][extraOwner] = chosen;
    }

    // Persist the block if it changed.
    if (JSON.stringify(connections) !== connectionsBefore) {
      if (checkOnly) {
        warn('connections block would change — re-run without --check to write it');
      } else if (workspace) {
        // Backup first, as on the context.json path; upsertBlockInFile refuses (throws, having
        // written nothing) rather than corrupt a file it cannot edit safely.
        copyFileSync(contextFile, `${contextFile}.bak-connections`);
        try {
          upsertBlockInFile(contextFile, 'connections', connections);
        } catch (e) {
          bad(`could not write connections to ${contextFile}: ${e.message}`); return 1;
        }
        ok(`wrote connections to ${contextFile} (backup: .bak-connections)`);
        console.log('  Commit it — the workspace repo is what the rest of the team reads.');
      } else {
        const raw = readFileSync(contextFile, 'utf8');
        const span = connectionsSpan(raw);
        copyFileSync(contextFile, `${contextFile}.bak-connections`);
        if (span) {
          // Indent of the line the key sits on, so a multi-line render lines up with its
          // neighbours rather than announcing which tool wrote it.
          const lineStart = raw.lastIndexOf('\n', span.start) + 1;
          const indent = (raw.slice(lineStart).match(/^[ \t]*/) ?? [''])[0];
          writeFileSync(contextFile,
            raw.slice(0, span.start) + renderConnections(connections, indent) + raw.slice(span.end));
          ok(`wrote connections to ${contextFile} (backup: .bak-connections)`);
        } else {
          // No connections key yet, or one this cannot locate unambiguously. Restringifying is
          // the only option left, and it reformats the file — so say so rather than let a
          // reviewer discover ninety lines of churn in their next diff.
          cfg.connections = connections;
          writeFileSync(contextFile, `${JSON.stringify(cfg, null, 2)}\n`);
          ok(`wrote connections to ${contextFile} (backup: .bak-connections)`);
          warn('context.json had no "connections" block to edit in place, so the whole file was');
          warn('  reformatted. Check the diff: the connections change is the only intended one.');
        }
        console.log('  Commit it — the context repo is what the rest of the team reads.');
      }
    }

    // --- compare against what this machine actually has ---
    console.log('');
    const existing = configuredServers();
    const missing = [];
    for (const [provider, value] of Object.entries(connections)) {
      for (const [owner, server] of entriesOf(value)) {
        const label = `${provider}${owner ? ` (${owner})` : ''} → ${server}`;
        if (existing.has(server)) ok(`${label} (configured)`);
        else { warn(`${label} (NOT configured)`); missing.push([provider, server]); }
      }
    }

    // Same-provider connections belonging to other projects: not an error, but worth naming.
    // Flattened: without this every second connector a provider declares would be reported as
    // another project's and off-limits — precisely backwards.
    const declared = new Set(Object.values(connections).flatMap(names));
    for (const provider of Object.keys(connections)) {
      const others = [...existing].filter((n) => n.startsWith(provider) && !declared.has(n));
      if (others.length) warn(`other ${provider} connections on this machine, off-limits here: ${others.join(', ')}`);
    }

    // Registered on the host is not the same as reachable from here. The desktop config serves
    // the desktop app and Cowork; Claude Code takes its servers per repo, so a connection this
    // project declares still has to be exposed in this directory — once, by hand, because the
    // alternative is user scope, where every project pays for every other project's connectors.
    const visible = codeScopedServers();
    const unexposed = [...new Set(Object.values(connections).flatMap(names))]
      .filter((s) => existing.has(s) && !visible.has(s));
    if (unexposed.length) {
      console.log('');
      warn(`configured on this machine but NOT visible to Claude Code here: ${unexposed.join(', ')}`);
      console.log('  Cowork and the desktop app are unaffected — they read the host config.');
      console.log('  To expose one to Claude Code in this directory only, copy its entry from');
      console.log(`    ${configPaths()[0]}`);
      console.log('  and register it here:');
      for (const s of unexposed) console.log(`    claude mcp add-json ${s} '<the entry, as JSON>' -s local`);
    }

    if (!missing.length) { console.log('\nAll declared connections are configured.\n'); return 0; }
    if (checkOnly) { console.log(`\n${missing.length} missing. Re-run without --check to add them.\n`); return 1; }
    if (!interactive) { console.log('\nRun interactively to add the missing connections.\n'); return 1; }

    // --- prerequisites, only now that something needs doing ---
    console.log('');
    if (Number(process.versions.node.split('.')[0]) < 18) {
      bad(`Node ${process.versions.node} — need 18 or newer`); return 1;
    }
    let adder;
    try { adder = deployRuntime(); } catch (e) { bad(e.message); return 1; }
    ok(`runtime deployed to ${RUNTIME}`);

    const binary = findBinary();
    const docker = has('docker');
    if (missing.some(([p]) => p === 'github')) {
      if (binary) ok(`github-mcp-server: ${binary}`);
      else if (docker) ok('docker available');
      else {
        warn('No github-mcp-server binary and no docker — will fall back to --remote,');
        warn('  which puts the token in the process list. Better: download from');
        warn('  https://github.com/github/github-mcp-server/releases');
        warn(`  into ${join(RUNTIME, 'bin')} and re-run.`);
      }
    }

    // --- provision ---
    for (const [provider, server] of missing) {
      console.log(`\n--- ${server} (${provider}) ---`);
      console.log(`You will need ${PROVIDERS[provider].credential}`);
      if ((await rl.question('\nSet it up now? [Y/n]: ')).trim().toLowerCase() === 'n') continue;

      const args = [adder, `--${provider}`, server];
      if (provider === 'github') {
        if (binary) args.push('--binary', binary);
        else if (!docker) args.push('--remote');
        const sets = (await rl.question('Toolsets [repos,issues,pull_requests]: ')).trim()
          || 'repos,issues,pull_requests';
        args.push('--toolsets', sets);
        if ((await rl.question('Read-only? [y/N]: ')).trim().toLowerCase() === 'y') args.push('--readonly');
      }

      console.log('');
      const out = spawnSync(process.execPath, args, { stdio: 'inherit' });
      console.log(out.status === 0 ? `\n${server} added.` : `\n${server} did not complete — see above.`);
    }
  } finally {
    rl?.close();
  }

  console.log('\nFully quit and reopen Claude Desktop (tray icon → Quit, not just the window).');
  console.log('Claude Code picks the servers up on its next session.');
  console.log(`\nCheck a stored credential:  node "${join(RUNTIME, 'mcp-launch.mjs')}" <name> --print\n`);
  return 0;
}

process.exitCode = await main();
