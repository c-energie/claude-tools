#!/usr/bin/env node
// Provision the MCP connections a project declares, with one credential per connection.
//
//   node setup-connectors.mjs [--context <path/to/context.json>] [--check]
//
// Reads the `connections` block from the project's context.json — e.g.
//   { "github": "github-thesis", "notion": "notion-thesis" }
// — and makes sure a correspondingly-named, correctly-scoped MCP server exists on this
// machine. That block is the source of truth: it is what stops a machine holding several
// workspace-scoped connections from writing through the wrong one.
//
// The runtime (launcher + store + adder) is copied out of the plugin into ~/.mcp/ before use.
// The Claude configs reference that stable path, so a plugin update or reinstall cannot
// orphan every configured server.
//
// --check runs the diagnosis and stops without changing anything.
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(homedir(), '.mcp');
const RUNTIME_FILES = ['secret-store.mjs', 'mcp-launch.mjs', 'add-mcp-connector.mjs'];

const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);

function has(cmd) {
  const probe = process.platform === 'win32'
    ? spawnSync('cmd', ['/c', `${cmd} --version`], { encoding: 'utf8', windowsHide: true })
    : spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

// ---------------------------------------------------------------- context.json

// Explicit path, then the plugin's own resolver, then the working directory. Never guess a
// context repo — if none of these produce one, say so and stop.
function findContext(explicit) {
  if (explicit) {
    const p = resolve(explicit);
    return existsSync(p) ? p : null;
  }

  const resolver = join(HERE, '..', '..', 'scripts', 'context-repo.sh');
  if (existsSync(resolver)) {
    const out = spawnSync('bash', [resolver, '--no-pull'], { encoding: 'utf8' });
    if (out.status === 0) {
      const root = (out.stdout ?? '').trim();
      const p = join(root, 'context.json');
      if (root && existsSync(p)) return p;
    }
  }

  const local = resolve('context.json');
  return existsSync(local) ? local : null;
}

function readConnections(path) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { error: `could not parse ${path}: ${e.message}` };
  }
  const conns = cfg.connections;
  if (!conns || !Object.keys(conns).length) {
    return { error: `${path} declares no "connections" block` };
  }
  return { connections: conns };
}

// ---------------------------------------------------------------- runtime deploy

function deployRuntime() {
  mkdirSync(RUNTIME, { recursive: true });
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

// Which servers does Claude already know about? Read the configs the adder writes.
function configuredServers() {
  const names = new Set();
  const home = homedir();
  const paths = [
    join(home, '.claude.json'),
    process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Claude', 'claude_desktop_config.json'),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      for (const k of Object.keys(JSON.parse(readFileSync(p, 'utf8')).mcpServers ?? {})) names.add(k);
    } catch { /* a config we cannot parse is not evidence of absence */ }
  }
  return names;
}

// ---------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes('--check');
  const ctxFlag = argv.indexOf('--context');
  const ctxPath = ctxFlag >= 0 ? argv[ctxFlag + 1] : null;

  console.log('\nProject connections\n');

  const contextFile = findContext(ctxPath);
  if (!contextFile) {
    bad('No context.json found.');
    console.log('\n  Pass --context <path>, or run this from a project whose context repo is');
    console.log('  configured (see the context-setup skill).\n');
    return 1;
  }
  ok(`context: ${contextFile}`);

  const { connections, error } = readConnections(contextFile);
  if (error) {
    bad(error);
    console.log('\n  Add one, naming the MCP server each provider should use here:');
    console.log('    "connections": { "github": "github-myproject", "notion": "notion-myproject" }\n');
    return 1;
  }

  const existing = configuredServers();
  const missing = [];
  for (const [provider, server] of Object.entries(connections)) {
    if (existing.has(server)) ok(`${provider} → ${server} (configured)`);
    else { warn(`${provider} → ${server} (NOT configured)`); missing.push([provider, server]); }
  }

  // Same-provider connections belonging to other projects: not an error, but worth naming.
  const declared = new Set(Object.values(connections));
  for (const [provider] of Object.entries(connections)) {
    const others = [...existing].filter((n) => n.startsWith(provider) && !declared.has(n));
    if (others.length) warn(`other ${provider} connections present, off-limits here: ${others.join(', ')}`);
  }

  if (!missing.length) {
    console.log('\nAll declared connections are configured.\n');
    return 0;
  }
  if (checkOnly) {
    console.log(`\n${missing.length} connection(s) missing. Re-run without --check to add them.\n`);
    return 1;
  }

  // --- prerequisites, only now that we know something needs doing ---
  console.log('');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) { bad(`Node ${process.versions.node} — need 18+`); return 1; }

  let adder;
  try { adder = deployRuntime(); } catch (e) { bad(e.message); return 1; }
  ok(`runtime deployed to ${RUNTIME}`);

  const binary = findBinary();
  const docker = has('docker');
  const needsGithub = missing.some(([p]) => p === 'github');
  if (needsGithub) {
    if (binary) ok(`github-mcp-server: ${binary}`);
    else if (docker) ok('docker available');
    else {
      warn('No github-mcp-server binary and no docker — will fall back to --remote,');
      warn(`  which exposes the token in the process list. Better: download from`);
      warn('  https://github.com/github/github-mcp-server/releases');
      warn(`  into ${join(RUNTIME, 'bin')} and re-run.`);
    }
  }

  if (!process.stdin.isTTY) {
    console.log('\nRun interactively to add the missing connections.\n');
    return 1;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [provider, server] of missing) {
      console.log(`\n--- ${server} (${provider}) ---`);
      if (provider === 'github') {
        console.log('Create a FINE-GRAINED token at github.com/settings/personal-access-tokens,');
        console.log('scoped to only the repos this project should reach.');
      } else if (provider === 'notion') {
        console.log('Create an INTERNAL INTEGRATION at notion.so/profile/integrations in THIS');
        console.log("project's workspace, then share its pages with it (••• → Connections).");
      } else {
        warn(`No recipe for provider "${provider}" — skipping. Add one to add-mcp-connector.mjs.`);
        continue;
      }

      const go = (await rl.question('Set it up now? [Y/n]: ')).trim().toLowerCase();
      if (go === 'n') continue;

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
    rl.close();
  }

  console.log('\nFully quit and reopen Claude Desktop (tray icon → Quit, not just the window).');
  console.log('Claude Code picks the servers up on the next session.');
  console.log(`\nCheck a stored credential:  node "${join(RUNTIME, 'mcp-launch.mjs')}" <name> --print\n`);
  return 0;
}

process.exitCode = await main();
