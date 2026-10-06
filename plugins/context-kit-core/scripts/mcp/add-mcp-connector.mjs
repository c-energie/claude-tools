#!/usr/bin/env node
// Add a named, credential-scoped MCP server to both Claude configs on this machine, so one
// machine can hold several workspace- or repo-scoped connections side by side (e.g.
// "notion-acme" + "notion-beta", "github-acme" + "github-beta") — the name is
// <provider>-<project> and the project half is always supplied by the caller.
//
//   node add-mcp-connector.mjs --notion notion-acme
//   node add-mcp-connector.mjs --github github-acme --toolsets repos,issues --readonly
//   node add-mcp-connector.mjs --github github-acme --binary /path/to/github-mcp-server.exe
//   node add-mcp-connector.mjs notion-personal            (provider defaults to notion)
//
// Credentials:
//   --notion  a Notion INTERNAL INTEGRATION secret ("ntn_..."), created at
//             notion.so/profile/integrations in the target workspace. The pages/databases must
//             be shared with that integration (page ••• menu → Connections) or reads come back
//             empty — sharing is separate from the token.
//   --github  a fine-grained PAT ("github_pat_...") scoped to just the repos this connection
//             should see, from github.com/settings/personal-access-tokens. Classic tokens
//             ("ghp_...") work but cannot be limited per-repo, which defeats the point.
//
// The token comes from a hidden prompt, CONTEXT_NEW_TOKEN in the env, or piped stdin — never a
// command-line argument. It is NOT written into the Claude configs: it goes into the OS
// credential store (Windows DPAPI / macOS Keychain / libsecret) and is read back at server
// start by mcp-launch.mjs. See secret-store.mjs.
//
// Writes the HOST config (with a backup), after verifying the token:
//   - AppData/Roaming/Claude/claude_desktop_config.json   (desktop chat app AND Cowork — a
//     Cowork sandbox does not run these servers, the host runs them and bridges them in)
// It does NOT write ~/.claude.json. That is Claude Code's user scope, where one server loads
// in every session on the machine; Claude Code is given the server per repo instead, and the
// exact command to do that is printed at the end.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPaths, storeSecret, secretLocation, PLATFORM } from './secret-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(HERE, 'mcp-launch.mjs');
const CONFIGS = configPaths();

// The globally installed Notion server's entry point, or null. Through a shell so the npm.cmd
// shim resolves on Windows; one string, not argv, which Node now deprecates with shell: true.
function globalNotionCli() {
  const out = spawnSync('npm root -g', { encoding: 'utf8', shell: true });
  if (out.status !== 0 || !out.stdout) return null;
  const cli = join(out.stdout.trim(), '@notionhq', 'notion-mcp-server', 'bin', 'cli.mjs');
  return existsSync(cli) ? cli : null;
}

// ---------------------------------------------------------------- providers

const PROVIDERS = {
  notion: {
    envVar: 'NOTION_TOKEN',
    hint: 'ntn_...',
    label: 'Notion internal integration secret',

    async verify(token) {
      const res = await fetch('https://api.notion.com/v1/users/me', {
        headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' },
      });
      if (!res.ok) return { ok: false, status: res.status };
      const me = await res.json();
      return {
        ok: true,
        lines: [
          `integration "${me.name ?? 'unnamed'}", workspace "${me.bot?.workspace_name ?? 'n/a'}"`,
          'Check that workspace is the one you intend — a token from the wrong workspace verifies just as happily.',
        ],
      };
    },

    build() {
      // Prefer a global install: `npx -y` re-resolves the package against the registry on every
      // start, and on Windows that cold start (~60s with three servers launching together)
      // overruns the desktop app's 60s initialize timeout — the connector then never appears,
      // logged only as "Couldn't start ... Request timed out". The installed cli.mjs answers in
      // a few seconds. Trade-off: it no longer self-updates (`npm i -g` to refresh).
      const cli = globalNotionCli();
      if (cli) return { command: process.execPath, args: [cli] };
      return { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] };
    },

    afterNotes: [
      'Remember: share the target pages/databases with the integration in Notion, or reads come back empty.',
    ],
  },

  github: {
    envVar: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    hint: 'github_pat_... or ghp_...',
    label: 'GitHub personal access token',

    async verify(token) {
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'add-mcp-connector',
      };
      const res = await fetch('https://api.github.com/user', { headers });
      if (!res.ok) return { ok: false, status: res.status };
      const me = await res.json();

      const lines = [`authenticated as "${me.login}"`];
      const scopes = res.headers.get('x-oauth-scopes');
      if (scopes) {
        lines.push(`classic token, scopes: ${scopes || '(none)'} — cannot be limited per-repo`);
      } else if (token.startsWith('github_pat_')) {
        lines.push('fine-grained token');
      }

      // Best-effort. Note GitHub does not enforce fine-grained scope on *listing*: a token
      // limited to specific repos can still enumerate others, while real reads/writes stay
      // restricted. So flag private repos with write access — those are the ones that would
      // indicate a genuinely over-broad token — and treat public entries as noise.
      try {
        const r = await fetch('https://api.github.com/user/repos?per_page=100', { headers });
        if (r.ok) {
          const repos = await r.json();
          if (!repos.length) {
            lines.push('lists 0 repos — check the token is scoped to something');
          } else {
            const notable = repos.filter((x) => x.private);
            lines.push(`lists ${repos.length} repo(s); ${notable.length} private:`);
            for (const x of notable.slice(0, 10)) {
              lines.push(`    ${x.full_name}${x.permissions?.push ? ' (write)' : ' (read)'}`);
            }
            if (notable.length > 10) lines.push('    ...');
            lines.push('  Listing is not scope-enforced by GitHub — verify real access with:');
            lines.push('    curl -H "Authorization: Bearer <token>" https://api.github.com/repos/OWNER/REPO');
            lines.push('  A private repo that should be out of scope must return 404, not 200.');
          }
        }
      } catch {
        lines.push('(could not list repositories — informational only)');
      }
      return { ok: true, lines };
    },

    build(opts) {
      if (opts.binary) {
        // Native executable from github.com/github/github-mcp-server/releases. No Docker
        // daemon, faster start, token still passed via env rather than argv.
        const args = ['stdio'];
        if (opts.toolsets) args.push('--toolsets', opts.toolsets);
        if (opts.readonly) args.push('--read-only');
        return { command: opts.binary, args };
      }
      if (opts.remote) {
        // Bridges stdio to GitHub's hosted server. Gains the remote-only tools, but the token
        // lands on the child's command line — see the ${SECRET} note in mcp-launch.mjs.
        return {
          command: 'npx',
          args: [
            '-y', 'mcp-remote', 'https://api.githubcopilot.com/mcp/',
            '--header', 'Authorization: Bearer ${SECRET}',
          ],
        };
      }
      const args = ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN'];
      if (opts.toolsets) args.push('-e', `GITHUB_TOOLSETS=${opts.toolsets}`);
      if (opts.readonly) args.push('-e', 'GITHUB_READ_ONLY=1');
      args.push('ghcr.io/github/github-mcp-server');
      return { command: 'docker', args };
    },

    preflight(opts) {
      if (opts.remote) return null;
      if (opts.binary) {
        if (!existsSync(opts.binary)) {
          return `No executable at ${opts.binary}.\n` +
            'Download github-mcp-server_Windows_x86_64.zip from\n' +
            '  https://github.com/github/github-mcp-server/releases\n' +
            'and point --binary at the extracted .exe.';
        }
        return null;
      }
      // cmd /c rather than shell:true — same PATHEXT resolution, without Node's DEP0190
      // warning about unescaped args.
      const out = PLATFORM === 'win32'
        ? spawnSync('cmd', ['/c', 'docker --version'], { encoding: 'utf8', windowsHide: true })
        : spawnSync('docker', ['--version'], { encoding: 'utf8' });
      if (out.status !== 0) {
        return 'Docker does not appear to be available (docker --version failed).\n' +
          'Options:\n' +
          '  --binary <path>  use the native github-mcp-server.exe (recommended, no daemon)\n' +
          '  --remote         bridge to the hosted server via mcp-remote\n' +
          '  or start Docker Desktop and retry.';
      }
      return null;
    },

    afterNotes: [
      'If using Docker, Docker Desktop must be running or Claude shows the server as failed.',
      'Narrow the token at github.com/settings/personal-access-tokens if it reaches more repos than you intended.',
    ],
  },
};

// ---------------------------------------------------------------- helpers

function hiddenPrompt(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const chunks = [];
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('data', function onData(ch) {
      const s = ch.toString('utf8');
      for (const c of s) {
        if (c === '\r' || c === '\n' || c === '\u0004') {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(chunks.join(''));
          return;
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') chunks.pop();
        else chunks.push(c);
      }
    });
  });
}

// Round-trip via the launcher's --print mode: no child process, so nothing depends on cmd.exe
// quoting rules.
function verifyStoredSecret(name, expected) {
  const out = spawnSync(process.execPath, [LAUNCHER, name, '--print'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (out.error) return { ok: false, detail: out.error.message };
  if (out.status !== 0) return { ok: false, detail: (out.stderr ?? '').trim() || `exit ${out.status}` };
  const got = (out.stdout ?? '').trim();
  if (got !== expected) return { ok: false, detail: `decrypted ${got.length} chars, expected ${expected.length}` };
  return { ok: true };
}

function parseArgs(argv) {
  const opts = { provider: null, name: '', toolsets: '', readonly: false, remote: false, binary: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--notion' || a === '--github') opts.provider = a.slice(2);
    else if (a === '--readonly') opts.readonly = true;
    else if (a === '--remote') opts.remote = true;
    else if (a === '--toolsets') opts.toolsets = (argv[++i] ?? '').trim();
    else if (a.startsWith('--toolsets=')) opts.toolsets = a.slice('--toolsets='.length).trim();
    else if (a === '--binary') opts.binary = (argv[++i] ?? '').trim();
    else if (a.startsWith('--binary=')) opts.binary = a.slice('--binary='.length).trim();
    else if (!a.startsWith('-') && !opts.name) opts.name = a.trim();
  }
  return opts;
}

// ---------------------------------------------------------------- main

async function main() {
  if (!existsSync(LAUNCHER)) {
    console.error(`Launcher not found at ${LAUNCHER}.`);
    console.error('Put mcp-launch.mjs alongside this script before running it.');
    return 2;
  }

  const opts = parseArgs(process.argv.slice(2));

  // --- server name (not a secret: argv or a visible prompt) ---
  let name = opts.name;
  if (!name && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    name = (await rl.question('Server name, as [provider]-[project] (e.g. notion-acme): ')).trim();
    rl.close();
  }
  name = name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!name) { console.error('No server name provided; nothing changed.'); return 2; }

  // Infer the provider from the name when not given explicitly, so the old invocation still
  // works and "github-acme" does the obvious thing.
  const providerKey = opts.provider ?? (name.startsWith('github') ? 'github' : 'notion');
  const provider = PROVIDERS[providerKey];
  console.log(`Provider: ${providerKey} (server "${name}")`);

  if (provider.preflight) {
    const problem = provider.preflight(opts);
    if (problem) { console.error(problem); return 1; }
  }

  // --- token (secret: env, hidden prompt, or piped stdin) ---
  let token = (process.env.CONTEXT_NEW_TOKEN ?? '').trim();
  if (!token) {
    token = process.stdin.isTTY
      ? (await hiddenPrompt(`Paste the ${provider.label} for "${name}" (${provider.hint}, input hidden): `)).trim()
      : readFileSync(0, 'utf8').trim();
  }
  token = token.replace(/\x1b\[20[01]~/g, '').replace(/[^\x21-\x7e]/g, '');
  if (!token) { console.error('No token provided; nothing changed.'); return 2; }

  // --- verify with the provider before touching anything ---
  let result;
  try {
    result = await provider.verify(token);
  } catch (e) {
    console.error(`Could not verify the token: ${e.cause?.message ?? e.message}. Nothing changed.`);
    return 1;
  }
  if (!result.ok) {
    console.error(`${providerKey} rejected the token (HTTP ${result.status}). Nothing changed.`);
    return 1;
  }
  console.log('Token OK —');
  for (const line of result.lines) console.log(`  ${line}`);

  // --- store, then confirm it comes back out ---
  try {
    storeSecret(name, token);
  } catch (e) {
    console.error(`Could not store the token: ${e.message}. Nothing changed.`);
    return 1;
  }
  const check = verifyStoredSecret(name, token);
  if (!check.ok) {
    console.error(`Stored secret for "${name}" did not decrypt back correctly. Configs left untouched.`);
    console.error(`Reason: ${check.detail}`);
    console.error(`Location: ${secretLocation(name)}`);
    console.error('Check by hand with:');
    console.error(`  node "${LAUNCHER}" ${name} --print`);
    return 1;
  }
  console.log(`Token stored in ${secretLocation(name)}.`);

  if (opts.remote) {
    console.log('Note: --remote passes the token as a command-line argument to mcp-remote, so it');
    console.log('      is visible in the process list to anything running as you.');
  }

  // The config now holds a path, not a credential.
  const { command, args } = provider.build(opts);
  const entry = {
    command: process.execPath,
    args: [LAUNCHER, name, provider.envVar, command, ...args],
  };

  for (const path of CONFIGS) {
    if (!existsSync(path)) { console.error(`skip (missing): ${path}`); continue; }
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    const previous = cfg.mcpServers?.[name];
    if (previous) {
      console.log(`note: replacing existing "${name}" entry in ${path}`);
      if (previous.env && Object.keys(previous.env).length) {
        console.log('      (the old entry held a token inline — treat that token as exposed and rotate it)');
      }
    }
    copyFileSync(path, `${path}.bak-mcp`);
    cfg.mcpServers = cfg.mcpServers ?? {};
    cfg.mcpServers[name] = entry;
    writeFileSync(path, JSON.stringify(cfg, null, 2));
    console.log(`added "${name}" to ${path} (backup: .bak-mcp)`);
  }

  console.log('Now FULLY QUIT and reopen the Claude desktop app — that covers the chat app and Cowork.');
  console.log('Claude Code does NOT read that config. To give this server to ONE repo, run from that repo:');
  console.log(`  claude mcp add-json ${name} '${JSON.stringify(entry)}' -s local`);
  console.log('  (or commit the same entry as .mcp.json there). Adding it at -s user would load it');
  console.log('  in every Claude Code session on this machine, which is what per-repo scope avoids.');
  for (const note of provider.afterNotes) console.log(note);
  console.log('The .bak-mcp backups still contain any old inline tokens — delete them once this works.');
  return 0;
}

process.exitCode = await main();
