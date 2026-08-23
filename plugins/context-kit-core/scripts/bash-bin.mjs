// Which bash to spawn — the question every script that shells out to context-repo.sh has to
// answer on Windows, and the one they each answered by spawning bare `bash`.
//
// On Windows `bash` on PATH is normally C:\Windows\System32\bash.exe: the WSL launcher. It is
// a real executable, so spawn reports no error — but WSL has its own filesystem and its own
// $HOME, so a Windows path arrives as an unfindable name and the script exits 127 with
//
//     /bin/bash: C:/Users/…/context-repo.sh: No such file or directory
//
// A caller that only inspects `error` reads that as a clean run; one that inspects `status`
// blames the context repo for not resolving and refuses to write a setting that was correct.
// Neither names the real cause, which is why the choice lives in one place instead of four.
//
// Git Bash is the only bash that shares the filesystem and $HOME these scripts assume — the
// resolver clones into ~/.context and prints the path back for Node to read, which only works
// if both processes mean the same ~.
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
