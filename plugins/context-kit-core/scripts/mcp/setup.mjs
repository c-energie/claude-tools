#!/usr/bin/env node
// First-run setup for a project's MCP connectors. Checks this machine can support the
// scripts, then walks through adding each connection interactively.
//
// Nothing here names a project: connections are called <provider>-<project> and the project
// half is supplied by whoever runs it, so one core plugin serves every project.
//
//   node setup.mjs
//
// Safe to re-run: adding a connector that already exists replaces it.
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPaths, PLATFORM, secretLocation } from './secret-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ADDER = join(HERE, 'add-mcp-connector.mjs');

const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);

function has(cmd) {
  const probe = PLATFORM === 'win32'
    ? spawnSync('cmd', ['/c', `${cmd} --version`], { encoding: 'utf8', windowsHide: true })
    : spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

// ---------------------------------------------------------------- checks

function runChecks() {
  console.log('\nChecking this machine\n');
  let fatal = false;

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) ok(`Node ${process.versions.node}`);
  else { bad(`Node ${process.versions.node} — need 18 or newer (global fetch)`); fatal = true; }

  ok(`platform ${PLATFORM}, secrets go to ${secretLocation('<name>')}`);

  if (PLATFORM === 'linux' && !has('secret-tool')) {
    bad('secret-tool not found — install libsecret-tools (apt install libsecret-tools)');
    fatal = true;
  }

  const configs = configPaths();
  let foundConfig = false;
  for (const p of configs) {
    if (existsSync(p)) { ok(`config found: ${p}`); foundConfig = true; }
    else warn(`config missing: ${p}`);
  }
  if (!foundConfig) {
    bad('The host config does not exist. Open Claude Desktop once and re-run.');
    fatal = true;
  }

  const docker = has('docker');
  const binary = findBinary();
  if (binary) ok(`github-mcp-server binary: ${binary}`);
  else if (docker) ok('docker available (will be used for GitHub servers)');
  else {
    warn('No github-mcp-server binary and no docker.');
    warn('  Download the binary for your platform from:');
    warn('    https://github.com/github/github-mcp-server/releases');
    warn(`  and put it in ${join(HERE, 'bin')}`);
    warn('  GitHub connectors will fall back to --remote (token visible in process list).');
  }

  if (!has('npx')) warn('npx not found — Notion connectors need it');
  else ok('npx available');
  const npmRoot = spawnSync('npm root -g', { encoding: 'utf8', shell: true });
  if (npmRoot.status === 0 && existsSync(join(npmRoot.stdout.trim(), '@notionhq', 'notion-mcp-server', 'bin', 'cli.mjs'))) {
    ok('@notionhq/notion-mcp-server installed globally');
  } else {
    warn('@notionhq/notion-mcp-server not installed globally — Notion connectors will use npx -y,');
    warn('  whose cold start can overrun the desktop app\'s 60s timeout. Fix: npm i -g @notionhq/notion-mcp-server');
  }

  return { fatal, binary, docker };
}

function findBinary() {
  const names = PLATFORM === 'win32' ? ['github-mcp-server.exe'] : ['github-mcp-server'];
  for (const n of names) {
    const p = join(HERE, 'bin', n);
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------- connector flow

async function addConnector(rl, env) {
  const provider = (await rl.question('  Provider [github/notion] (blank to stop): ')).trim().toLowerCase();
  if (!provider) return false;
  if (provider !== 'github' && provider !== 'notion') {
    console.log('  Please answer github or notion.');
    return true;
  }

  // No default. The convention is <provider>-<project>, and the project half is the whole point
  // of the name — it is what lets a machine hold several same-provider connections scoped to
  // different workspaces, and what context.json's `connections` block matches against. This
  // used to default to one specific project's connector, which is a project fact in the core
  // plugin: accepting it by pressing enter silently wired every project to that one's name.
  let name = '';
  while (!name) {
    name = (await rl.question(`  Name, as ${provider}-[project] (e.g. ${provider}-acme): `)).trim();
    if (!name) console.log('  A name is required — it is how skills select this connection.');
  }

  const args = [ADDER, `--${provider}`, name];

  if (provider === 'github') {
    if (env.binary) args.push('--binary', env.binary);
    else if (!env.docker) args.push('--remote');

    const sets = (await rl.question('  Toolsets [repos,issues,pull_requests]: ')).trim()
      || 'repos,issues,pull_requests';
    args.push('--toolsets', sets);

    const ro = (await rl.question('  Read-only? [y/N]: ')).trim().toLowerCase();
    if (ro === 'y') args.push('--readonly');

    console.log('\n  Create a FINE-GRAINED token at github.com/settings/personal-access-tokens');
    console.log('  scoped to only the repos this connection should reach.');
  } else {
    console.log('\n  Create an INTERNAL INTEGRATION at notion.so/profile/integrations in the');
    console.log('  target workspace, then share the relevant pages with it (••• → Connections).');
  }

  console.log('');
  // stdio inherited so the hidden token prompt works normally.
  const out = spawnSync(process.execPath, args, { stdio: 'inherit' });
  console.log(out.status === 0 ? '\n  Added.\n' : '\n  That did not complete — see above.\n');
  return true;
}

// ---------------------------------------------------------------- main

async function main() {
  console.log('MCP connector setup');

  const env = runChecks();
  if (env.fatal) {
    console.log('\nFix the FAIL lines above, then re-run.\n');
    return 1;
  }

  if (!process.stdin.isTTY) {
    console.log('\nChecks passed. Run interactively to add connectors.\n');
    return 0;
  }

  console.log('\nAdd your connections. One per project, each with its own credential —');
  console.log('that separation is the whole point, so avoid one token covering everything.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (await addConnector(rl, env)) { /* until blank */ }
  } finally {
    rl.close();
  }

  console.log('\nDone. Fully quit and reopen Claude Desktop (tray icon → Quit, not just the window).');
  console.log('Claude Code picks the servers up on the next session.\n');
  console.log('To check a stored credential later:');
  console.log(`  node "${join(HERE, 'mcp-launch.mjs')}" <name> --print\n`);
  return 0;
}

process.exitCode = await main();
