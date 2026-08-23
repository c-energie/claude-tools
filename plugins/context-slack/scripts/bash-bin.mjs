// Which bash to spawn — see the original for the whole story.
//
// *** COPY of context-kit-core/scripts/bash-bin.mjs — keep the two byte-identical below this
// banner. *** Plugins cannot reach into each other's install directories, so the copy is
// deliberate. A fix lands in context-kit-core's copy FIRST, then here. (Same rule as
// context-repo.sh and dates.mjs, which live in all three plugins for the same reason.)
//
// In short: on Windows `bash` on PATH is WSL's System32ash.exe, which has its own filesystem
// and $HOME, so it exits 127 on a Windows path instead of failing in a way callers recognise.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Git Bash, never WSL's. CLAUDE_CODE_GIT_BASH_PATH is the client's own pointer at it and wins
// when set; otherwise probe the Git for Windows install locations directly, since `bash` is
// frequently not on PATH under PowerShell at all. `where.exe` is the last resort, with
// system32 filtered out of its results — that entry is the WSL launcher and never what we want.
//
// Returns null on Windows when no Git Bash can be found. That is a real state, not an error:
// callers decide whether their job can degrade (skip a check) or must stop (resolve a repo).
export function bashBin() {
  if (process.platform !== 'win32') return 'bash';
  const hinted = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (hinted && existsSync(hinted)) return hinted;
  for (const c of [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ]) if (existsSync(c)) return c;
  const w = spawnSync('where.exe', ['bash'], { encoding: 'utf8', windowsHide: true });
  return (w.stdout ?? '').split(/\r?\n/).filter(Boolean).find((p) => !/system32/i.test(p)) ?? null;
}

// What to say when bashBin() comes back null. One sentence naming the fix, so three callers
// do not invent three different phrasings of the same missing dependency.
export const NO_BASH = 'no Git Bash found — install Git for Windows, or set '
  + 'CLAUDE_CODE_GIT_BASH_PATH to its bash.exe';

// Git Bash reads a script path with backslashes as escape sequences, so every path handed to
// it is forward-slashed first. C:/Users/… is understood natively.
export const bashPath = (p) => p.replace(/\\/g, '/');
