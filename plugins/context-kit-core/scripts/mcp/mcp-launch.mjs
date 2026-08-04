#!/usr/bin/env node
// Launch an MCP server with its credential pulled from the OS secret store at start time, so
// no token is ever written into claude_desktop_config.json or ~/.claude.json.
//
//   node mcp-launch.mjs <secret-name> <ENV_VAR> <command> [args...]
//   node mcp-launch.mjs <secret-name> --print
//
// The secret exists only in this process tree's memory and is passed to the child as <ENV_VAR>.
// --print writes it to stdout and exits; used by the setup scripts to verify storage without
// spawning anything through a shell.
import { spawn } from 'node:child_process';
import { readSecret } from './secret-store.mjs';

const [secretName, envVar, command, ...args] = process.argv.slice(2);
const printOnly = envVar === '--print';

if (!secretName || !envVar || (!printOnly && !command)) {
  console.error('usage: node mcp-launch.mjs <secret-name> <ENV_VAR> <command> [args...]');
  console.error('       node mcp-launch.mjs <secret-name> --print');
  process.exit(2);
}

const result = readSecret(secretName);
if (!result.ok) {
  console.error(`Could not read the secret for "${secretName}": ${result.detail}`);
  console.error('Run: node add-mcp-connector.mjs <provider-flag> ' + secretName);
  process.exit(1);
}
const secret = result.secret;

if (printOnly) {
  process.stdout.write(secret);
  process.exit(0);
}

// Some servers take the credential as an argument rather than an env var (mcp-remote's
// --header). Any arg containing ${SECRET} gets it substituted here. That puts the token on the
// child's command line, where another process running as you could read it from the process
// list — prefer the env-var route wherever the server supports it.
let substitutions = 0;
const finalArgs = args.map((a) => {
  if (!a.includes('${SECRET}')) return a;
  substitutions++;
  return a.replaceAll('${SECRET}', secret);
});
if (substitutions) console.error(`[mcp-launch] substituted secret into ${substitutions} argument(s)`);

// On Windows a shell is needed so npx/npm shims (npx.cmd) resolve — spawn without one ignores
// PATHEXT, and Node refuses to exec .cmd files directly. The cost is that Node concatenates
// argv into a single command string without escaping, so cmd.exe re-splits anything containing
// a space: "Authorization: Bearer xyz" would arrive as three arguments. Quote those ourselves.
// Inside double quotes cmd treats the usual metacharacters literally, so wrapping is enough.
const useShell = process.platform === 'win32';
const needsQuoting = (s) => /[\s&|<>^()]/.test(s) && !(s.startsWith('"') && s.endsWith('"'));
const quote = (s) => (useShell && needsQuoting(s) ? `"${s.replaceAll('"', '\\"')}"` : s);

const child = spawn(quote(command), useShell ? finalArgs.map(quote) : finalArgs, {
  stdio: 'inherit',
  env: { ...process.env, [envVar]: secret },
  shell: useShell,
});

child.on('error', (e) => {
  console.error(`Could not start "${command}": ${e.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
