#!/usr/bin/env node
// Associate a project with its context repo — the one first-run step that used to be a
// hand-edited settings file.
//
//   node link-context.mjs corson94/thesis-context             # → .claude/settings.json (committed)
//   node link-context.mjs corson94/thesis-context --local     # → .claude/settings.local.json
//   node link-context.mjs <owner/repo> --project path/to/repo # target another checkout
//   node link-context.mjs <owner/repo> --force                # re-point a project already linked
//   node link-context.mjs <owner/repo> --no-verify            # skip the reachability check (offline)
//   node link-context.mjs <owner/repo> --load                 # print the context to stdout now
//   node link-context.mjs none                                # opt OUT: this project has no
//                                                             # context repo, hook goes silent
//
// The repo is an ARGUMENT, never a prompt: the same call then works from a terminal, from a
// `!` line in a session, and from a tool call — where stdin is closed and a prompt would hang
// on EOF. Nothing is inferred: deriving owner/repo from the project's git remote would be
// precisely the wrong-context failure this plugin exists to prevent, so a human names it.
//
// Verification runs BEFORE the write, so a typo fails without leaving a broken settings file
// behind. Settings are read at session start, so the write lands next session — `--load` is
// what makes the context live in the session running this.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bashBin, bashPath, NO_BASH } from './bash-bin.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPTIONS = ['local', 'force', 'no-verify', 'load'];
// The opt-out sentinel, in step with hooks/load-context.sh and scripts/context-repo.sh: a
// project that deliberately has no context repo, so the session-start hook stays silent
// instead of reporting it unconfigured every time. `none` is the spelling to document.
const OPTOUT = ['none', 'off', 'false', 'no', '-', 'disabled'];

const die = (m, code = 2) => { console.error(`link-context.mjs: ${m}`); process.exit(code); };
const say = (m) => console.error(m);           // stderr, so --load owns stdout
const bash = (rel) => join(PLUGIN_ROOT, rel).replace(/\\/g, '/');

// Only a shell expands `~`, and only unquoted: PowerShell passes it through verbatim to a
// native exe, and so does bash for "~/x". Without this, resolve() reads it as a directory
// literally named `~` under the cwd — which fails confusingly, or on a machine that has a
// stray `~` folder writes the settings file somewhere nobody will ever look.
function untilde(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  // `~user` needs a passwd lookup this has no business doing — say so rather than guess.
  if (p.startsWith('~')) die(`cannot expand ${p} — give the path in full, or use ~/ for your own home`);
  return p;
}

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flags = new Set();
const positional = [];
let projectArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project') projectArg = argv[++i];
  else if (a.startsWith('--')) flags.add(a.slice(2));
  else positional.push(a);
}
for (const f of flags) if (!OPTIONS.includes(f)) die(`unknown option --${f} (use ${OPTIONS.map((o) => `--${o}`).join(', ')})`);

if (!positional[0]) die('needs the context repo as owner/repo (or "none" to opt out), e.g. corson94/thesis-context');
const optOut = OPTOUT.includes(positional[0].trim().toLowerCase());
// Tolerate a pasted browser URL or a clone URL — the same repo, just wearing more clothes.
const repo = optOut ? 'none' : positional[0]
  .replace(/^(https:\/\/|git@)github\.com[/:]/, '')
  .replace(/\.git$/, '')
  .replace(/\/+$/, '');
if (!optOut && !/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(repo)) die(`not an owner/repo name: ${positional[0]}`);

const project = resolve(untilde(projectArg ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()));
if (!existsSync(project)) die(`no such directory: ${project}`);
const local = flags.has('local');
const file = join(project, '.claude', local ? 'settings.local.json' : 'settings.json');
const rel = relative(project, file).replace(/\\/g, '/');

// ---------------------------------------------------------------- read what is already there

let settings = {};
if (existsSync(file)) {
  const raw = readFileSync(file, 'utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;   // BOM, if an editor left one
  try {
    settings = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    die(`${rel} is not valid JSON (${e.message}) — fix it first; refusing to overwrite it`);
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    die(`${rel} is not a JSON object — refusing to overwrite it`);
  }
  if (settings.env !== undefined
      && (typeof settings.env !== 'object' || settings.env === null || Array.isArray(settings.env))) {
    die(`${rel} has an "env" key that is not an object — fix it first`);
  }
}

// An existing opt-out counts as already-set-to-none however it was spelled, so re-running
// with `none` is a no-op rather than a --force prompt.
const rawCurrent = settings.env?.PROJECT_CONTEXT_REPO;
const current = rawCurrent && OPTOUT.includes(rawCurrent.trim().toLowerCase()) ? 'none' : rawCurrent;
if (current && current !== repo && !flags.has('force')) {
  const target = optOut ? 'opt it out' : `re-point it to ${repo}`;
  die(`${rel} already points this project at ${current} — pass --force to ${target}`);
}

// ---------------------------------------------------------------- verify, then write

// Runs the real resolver with the candidate name in the environment, which is exactly what the
// SessionStart hook will do next session — so a pass here means the next session passes too.
// Side effect worth knowing about: it clones the repo to ~/.context/<owner>/<repo> if absent.
if (!optOut && !flags.has('no-verify')) {
  // bashBin() rather than `bash`: on Windows the PATH entry is WSL's launcher, which cannot
  // see this file and exits 127 — indistinguishable here from the repo failing to resolve, so
  // a bash problem used to be reported as a bad repo name and the write refused.
  const bin = bashBin();
  const probe = bin ? spawnSync(bin, [bash('scripts/context-repo.sh')], {
    encoding: 'utf8',
    env: { ...process.env, PROJECT_CONTEXT_REPO: repo, CLAUDE_PROJECT_DIR: project },
  }) : { error: { code: NO_BASH } };
  if (probe.error) {
    // No bash (stock Windows shell, no Git Bash) is a reason to skip the check, not to refuse
    // the write — the setting is still correct, and the hook will report on it next session.
    say(`  warn  could not run bash (${probe.error.code}) — skipped the reachability check`);
  } else if (probe.status !== 0) {
    say((probe.stderr || '').trim());
    die(`${repo} did not resolve (see above) — nothing written. Re-run with --no-verify to write it anyway.`, 1);
  } else {
    say(`  ok    ${repo} resolves — checkout at ${(probe.stdout || '').trim()}`);
  }
}

if (current === repo) {
  say(optOut
    ? `  ok    ${rel} already opts this project out of a context repo — left as is`
    : `  ok    ${rel} already links this project to ${repo} — left as is`);
} else {
  settings.env = { ...(settings.env ?? {}), PROJECT_CONTEXT_REPO: repo };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  say(`  ok    ${current ? 're-pointed' : 'wrote'} ${rel} → ${repo}`);
  if (optOut) say('        This project has no context repo: the session-start hook will load nothing and say nothing.');
}

// A committed settings.json under the common `/.claude/*` ignore rule reaches nobody else —
// silently, since the file is right there in the working tree.
if (!local) {
  const ignored = spawnSync('git', ['-C', project, 'check-ignore', '-q', file]);
  if (!ignored.error && ignored.status === 0) {
    say(`  warn  ${rel} is gitignored — nobody cloning this repo gets the link.`);
    say('        Add  !/.claude/settings.json  after the /.claude/* line in .gitignore.');
  }
}

// ---------------------------------------------------------------- load it now, optionally

if (optOut) {
  say('        Restart Claude Code here for the hook to go quiet; re-run with an owner/repo to undo.');
} else if (flags.has('load')) {
  const bin = bashBin();
  const load = bin ? spawnSync(bin, [bash('hooks/load-context.sh'), '--refresh'], {
    encoding: 'utf8',
    env: { ...process.env, PROJECT_CONTEXT_REPO: repo, CLAUDE_PROJECT_DIR: project },
  }) : { error: { code: NO_BASH } };
  if (load.error) say(`  warn  could not run the loader (${load.error.code}) — start a new session instead`);
  else process.stdout.write(load.stdout ?? '');
} else {
  say('        Settings are read at session start: restart Claude Code here, or re-run with --load.');
}
