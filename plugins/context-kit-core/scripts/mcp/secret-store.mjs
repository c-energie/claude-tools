// Shared credential storage and config discovery for the MCP connector scripts.
//
// Secrets never live in the Claude config files. Each platform uses its native store:
//   Windows  DPAPI ciphertext in %LOCALAPPDATA%/mcp-secrets/<name>.dpapi (current user only)
//   macOS    Keychain, service "mcp-<name>"
//   Linux    libsecret via secret-tool, service "mcp-<name>"
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export const PLATFORM = platform();
const HOME = homedir();

// ---------------------------------------------------------------- config paths

// Both files Claude reads on this machine. Claude Code and Cowork sandboxes use ~/.claude.json;
// the desktop chat app uses a per-platform application support directory.
export function configPaths() {
  const desktop = {
    win32: join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json'),
    darwin: join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  }[PLATFORM] ?? join(process.env.XDG_CONFIG_HOME ?? join(HOME, '.config'), 'Claude', 'claude_desktop_config.json');

  return [join(HOME, '.claude.json'), desktop];
}

// ---------------------------------------------------------------- secret store

const WIN_SECRET_DIR = join(
  process.env.LOCALAPPDATA ?? join(HOME, 'AppData', 'Local'),
  'mcp-secrets',
);

export function secretLocation(name) {
  if (PLATFORM === 'win32') return join(WIN_SECRET_DIR, `${name}.dpapi`);
  if (PLATFORM === 'darwin') return `macOS Keychain, service "mcp-${name}"`;
  return `libsecret, service "mcp-${name}"`;
}

export function storeSecret(name, token) {
  if (PLATFORM === 'win32') {
    mkdirSync(WIN_SECRET_DIR, { recursive: true });
    // Plaintext reaches PowerShell through the child environment, never argv, so it stays out
    // of Task Manager's command line column and any PowerShell transcript.
    const out = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        'ConvertTo-SecureString -String $env:MCP_TMP_TOKEN -AsPlainText -Force | ConvertFrom-SecureString'],
      { env: { ...process.env, MCP_TMP_TOKEN: token }, encoding: 'utf8', windowsHide: true },
    );
    if (out.error) throw new Error(`could not run PowerShell: ${out.error.message}`);
    if (out.status !== 0) throw new Error(`DPAPI encryption failed: ${(out.stderr ?? '').trim()}`);
    const ciphertext = (out.stdout ?? '').trim();
    if (!ciphertext) throw new Error('DPAPI returned nothing');
    writeFileSync(join(WIN_SECRET_DIR, `${name}.dpapi`), ciphertext, { mode: 0o600 });
    return;
  }

  if (PLATFORM === 'darwin') {
    // -U replaces an existing item. security prompts twice for the password when -w has no
    // value, so feed it in on stdin rather than as an argument.
    const out = spawnSync(
      'security',
      ['add-generic-password', '-U', '-s', `mcp-${name}`, '-a', process.env.USER ?? 'mcp', '-w'],
      { input: `${token}\n${token}\n`, encoding: 'utf8' },
    );
    if (out.status !== 0) throw new Error(`Keychain write failed: ${(out.stderr ?? '').trim()}`);
    return;
  }

  const out = spawnSync(
    'secret-tool',
    ['store', '--label', `mcp-${name}`, 'service', `mcp-${name}`],
    { input: token, encoding: 'utf8' },
  );
  if (out.error) throw new Error('secret-tool not found — install libsecret-tools');
  if (out.status !== 0) throw new Error(`libsecret write failed: ${(out.stderr ?? '').trim()}`);
}

export function readSecret(name) {
  if (PLATFORM === 'win32') {
    const file = join(WIN_SECRET_DIR, `${name}.dpapi`);
    if (!existsSync(file)) return { ok: false, detail: `no stored secret at ${file}` };
    const out = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        '$s = Get-Content -Raw -LiteralPath $env:MCP_SECRET_FILE | ConvertTo-SecureString; ' +
        '[Runtime.InteropServices.Marshal]::PtrToStringAuto(' +
        '[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))'],
      { env: { ...process.env, MCP_SECRET_FILE: file }, encoding: 'utf8', windowsHide: true },
    );
    if (out.error) return { ok: false, detail: `could not run PowerShell: ${out.error.message}` };
    if (out.status !== 0) {
      return { ok: false, detail: (out.stderr ?? '').trim() || 'DPAPI decryption failed (different Windows user or machine?)' };
    }
    const secret = (out.stdout ?? '').replace(/\r?\n$/, '');
    return secret ? { ok: true, secret } : { ok: false, detail: 'decrypted value is empty' };
  }

  const [cmd, args] = PLATFORM === 'darwin'
    ? ['security', ['find-generic-password', '-w', '-s', `mcp-${name}`]]
    : ['secret-tool', ['lookup', 'service', `mcp-${name}`]];

  const out = spawnSync(cmd, args, { encoding: 'utf8' });
  if (out.error) return { ok: false, detail: `${cmd} not found` };
  if (out.status !== 0) return { ok: false, detail: `no stored secret named "mcp-${name}"` };
  const secret = (out.stdout ?? '').replace(/\r?\n$/, '');
  return secret ? { ok: true, secret } : { ok: false, detail: 'stored value is empty' };
}
