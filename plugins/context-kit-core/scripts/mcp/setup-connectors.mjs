#!/usr/bin/env node
// Set up this project's MCP connections: one named connection per provider, each backed by a
// credential scoped to just this project's repos or workspace.
//
//   node setup-connectors.mjs                 declare what's missing, then provision it
//   node setup-connectors.mjs --check         diagnose only, change nothing
//   node setup-connectors.mjs --add slack     also declare a provider not yet in the block
//   node setup-connectors.mjs --context <path/to/context.json>
//
// The `connections` block in the project's context.json is the source of truth — e.g.
//   { "github": "github-acme", "notion": "notion-acme" }
// It names which MCP server serves each provider HERE, which is what stops a machine holding
// several projects' connections from writing through the wrong one. If the block is missing,
// this script proposes names and writes it.
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

function has(cmd) {
  const probe = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', `${cmd} --version`], { encoding: 'utf8', windowsHide: true })
    : spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

// Windows editors and PowerShell routinely write JSON with a UTF-8 BOM, which JSON.parse
// rejects — strip it before parsing anything user-editable.
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

// Git Bash, never WSL's System32\bash.exe — WSL has its own filesystem and $HOME, so the
// resolver would clone somewhere this script can never see. `bash` is often not on PATH
// under PowerShell at all, so probe the Git for Windows install locations directly.
function bashBin() {
  if (process.platform !== 'win32') return 'bash';
  for (const c of [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ]) if (existsSync(c)) return c;
  const w = spawnSync('where.exe', ['bash'], { encoding: 'utf8', windowsHide: true });
  return (w.stdout ?? '').split(/\r?\n/).filter(Boolean).find((p) => !/system32/i.test(p)) ?? null;
}

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
  const out = spawnSync(bash, [resolver.replace(/\\/g, '/'), '--no-pull'],
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
  const extraProvider = at('--add');

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
      if (connections[p]) { ok(`${p}: ${connections[p]} (already declared)`); continue; }
      const suggested = `${p}-${slug}`;
      connections[p] = rl
        ? ((await rl.question(`  Name for the ${p} connection [${suggested}]: `)).trim() || suggested)
        : suggested;
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
    for (const [provider, server] of Object.entries(connections)) {
      if (existing.has(server)) ok(`${provider} → ${server} (configured)`);
      else { warn(`${provider} → ${server} (NOT configured)`); missing.push([provider, server]); }
    }

    // Same-provider connections belonging to other projects: not an error, but worth naming.
    const declared = new Set(Object.values(connections));
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
