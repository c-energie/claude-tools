#!/usr/bin/env node
// Set up this project's MCP connections: a named connection per provider (or several, keyed by
// resource owner), each backed by a credential scoped to just this project's repos or workspace.
//
//   node setup-connectors.mjs                 declare what's missing, then provision it
//   node setup-connectors.mjs --check         diagnose only, change nothing
//   node setup-connectors.mjs --add slack     also declare a provider not yet in the block
//   node setup-connectors.mjs --add github:c-energie   declare a SECOND github connection,
//                                             the one serving that resource owner
//   node setup-connectors.mjs --context <path/to/context.json>
//
// The `connections` block in the project's context.json is the source of truth — e.g.
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
// The runtime is copied out of the plugin into ~/.mcp/ before use, so the paths written into
// the Claude configs survive a plugin update, reinstall or marketplace re-sync.
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bashBin, bashPath } from '../bash-bin.mjs';
import { homedir } from 'node:os';

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

// Explicit path, then the declared repo's managed clone in ~/.context, then the resolver
// (which can create that clone), then the working directory. Never guess a context repo —
// if none of these produce one, say precisely why and stop.
function findContext(explicit) {
  if (explicit) {
    let p = resolve(expandHome(explicit));
    if (!existsSync(p)) return { path: null, hint: `--context ${explicit} does not exist` };
    // Accept either the file itself or the directory holding it.
    if (!p.endsWith('.json')) p = join(p, 'context.json');
    return existsSync(p)
      ? { path: p }
      : { path: null, hint: `--context ${explicit} holds no context.json` };
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
// directory holding it. Context repos are often "<project>-context", so drop that suffix.
function projectSlug(contextFile, cfg) {
  const raw = cfg.project ?? cfg.name ?? cfg.slug ?? basename(dirname(contextFile));
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-context$/, '')
    .replace(/^-+|-+$/g, '') || 'project';
}

// ---------------------------------------------------------------- machine state

function claudeConfigPaths() {
  const home = homedir();
  const desktop = process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
    : process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Claude', 'claude_desktop_config.json');
  return [join(home, '.claude.json'), desktop];
}

function configuredServers() {
  const names = new Set();
  for (const p of claudeConfigPaths()) {
    if (!existsSync(p)) continue;
    try {
      for (const k of Object.keys(readJson(p).mcpServers ?? {})) names.add(k);
    } catch { /* a config we cannot parse is not evidence of absence */ }
  }
  return names;
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

  const { path: contextFile, hint } = findContext(at('--context'));
  if (!contextFile) {
    bad(hint ?? 'No context.json found.');
    console.log('\n  Context repos are cloned to ~/.context/<owner>/<repo>, named by the');
    console.log("  PROJECT_CONTEXT_REPO env var or the project's .claude/settings.json.");
    console.log('  Pass --context <path> to override, or see the context-setup skill.\n');
    return 1;
  }
  ok(`context: ${contextFile}`);

  let cfg;
  try { cfg = readJson(contextFile); }
  catch (e) { bad(`could not parse ${contextFile}: ${e.message}`); return 1; }

  const slug = projectSlug(contextFile, cfg);
  const connections = { ...(cfg.connections ?? {}) };
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
      // bootstrap read), and the project slug is a project name, not a GitHub owner.
      const homeOwner = (typeof cfg.contextRepo === 'string' && cfg.contextRepo.includes('/'))
        ? cfg.contextRepo.split('/')[0]
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
    if (JSON.stringify(connections) !== JSON.stringify(cfg.connections ?? {})) {
      if (checkOnly) {
        warn('connections block would change — re-run without --check to write it');
      } else {
        cfg.connections = connections;
        copyFileSync(contextFile, `${contextFile}.bak-connections`);
        writeFileSync(contextFile, JSON.stringify(cfg, null, 2));
        ok(`wrote connections to ${contextFile} (backup: .bak-connections)`);
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
