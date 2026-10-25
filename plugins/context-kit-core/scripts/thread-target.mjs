#!/usr/bin/env node
// Where does save-thread write? One JSON line on stdout, so the skill never works it out in
// prose — and two sessions in the same directory always get the same answer.
//
//   node thread-target.mjs          # {"route","root","dir","index","from","repo"} on stdout
//
// INSIDE A WORKSPACE (ADR 0002) — the nearest .claude/workspace.json, found by workspace.mjs's
// own findWorkspace() so this and the resolver can never disagree about which workspace a
// session is in:
//   {"route":"workspace","root":"/abs/ws","dir":"docs/threads","index":"docs/threads/INDEX.md",
//    "from":"app/src","repo":"acme/app"}
// There is no routing question here at all: the workspace is the one place context lives, and a
// member's .claude/threads/ is exactly the second home the ADR retires. (PROJECT_CONTEXT_THREADS,
// which once routed threads between a repo and its context repo, went with that route in #60.)
//
// `repo` is the member repo the session is standing in, for the thread's `repo:` front-matter,
// so docs/threads/ stays readable once several members write into it. It is null at the root and
// in any directory that is part of the workspace's own repo (a monorepo member), because there
// the thread came from the workspace itself. Answered, in order:
//   1. the deepest `members[]` entry whose `dir` contains the session — declared, so it wins.
//      A member whose `repo` IS the workspace's `repo` is a monorepo member: null.
//   2. otherwise the session's git toplevel, when it sits strictly INSIDE the root (a nested
//      clone nobody has declared yet), read from its `origin`. A toplevel at or above the root
//      is the workspace's own repo: null.
// A nested clone with no parseable origin gives `repo: null` and a stderr line saying so; the
// skill asks rather than leaving the provenance off unremarked.
//
// OUTSIDE A WORKSPACE — {"route":null, ...nulls}, still printed, with the reason and
// `route=none` on stderr, and exit 1: a thread has no home there, and the context-repo route that
// used to take it was deleted (#60). A malformed nearest workspace.json gives the same answer,
// reported, because workspace.mjs resolves nothing from one either; a thread routed differently
// from the context the session loaded is the disagreement the shared findWorkspace() exists to
// prevent — so never on to an outer workspace.
//
// Read-only, no network, never prompts. Exit 0 in a workspace, 1 outside one, 2 on an unknown
// option.
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWorkspace } from './workspace.mjs';

export const THREAD_DIR = 'docs/threads';

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

// Path segments of `p` under `root`, or null when `p` is not at or below it. '' (the root
// itself) is an empty list, never [''].
function segmentsUnder(root, p) {
  const rel = relative(real(root), real(p));
  if (rel === '') return [];
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep);
}

// owner/name out of the URL shapes GitHub hands out: git@github.com:o/n.git,
// https://github.com/o/n(.git), ssh://git@github.com/o/n. Anything else is null — a guess here
// would be written into a committed file.
export function repoFromUrl(url) {
  const m = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
};

/** Which member repo `start` is in, inside the workspace at `root` with parsed `config`.
 *  -> { repo, note } — repo null when the thread comes from the workspace's own repo. */
export function memberRepo(root, config, start) {
  const here = segmentsUnder(root, start);
  if (!here || here.length === 0) return { repo: null };
  const members = Array.isArray(config?.members) ? config.members : [];
  let best = null;
  let bestLen = -1;
  for (const m of members) {
    if (typeof m?.dir !== 'string' || !m.dir.trim()) continue;
    const parts = m.dir.split(/[\\/]+/).filter((s) => s && s !== '.');
    if (parts.length > here.length || parts.length <= bestLen) continue;
    if (parts.every((s, i) => s === here[i])) { best = m; bestLen = parts.length; }
  }
  if (best && typeof best.repo === 'string' && best.repo.trim()) {
    return { repo: best.repo === config.repo ? null : best.repo };
  }
  const top = git(start, 'rev-parse', '--show-toplevel');
  const under = top ? segmentsUnder(root, top) : null;
  if (!under || under.length === 0) return { repo: null };
  const repo = repoFromUrl(git(top, 'remote', 'get-url', 'origin'));
  if (repo) return { repo };
  return { repo: null, note: `${top} is a nested clone with no GitHub origin, so the thread's repo: cannot be read from it` };
}

/** Where a thread written from `cwd` goes. Never throws. */
export function threadTarget({ cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd() } = {}) {
  const messages = [];
  const start = resolve(cwd);
  const found = findWorkspace(start);
  if (found?.root) {
    const { repo, note } = memberRepo(found.root, found.config, start);
    if (note) messages.push(note);
    const from = segmentsUnder(found.root, start);
    return {
      route: 'workspace', root: found.root, dir: THREAD_DIR, index: `${THREAD_DIR}/INDEX.md`,
      from: from && from.length ? from.join('/') : null, repo, messages,
    };
  }
  messages.push(found?.error
    ? `${found.file}: malformed, ignored — ${found.error}`
    : 'no .claude/workspace.json at or above the working directory — a thread has no home here');
  return { route: null, root: null, dir: null, index: null, from: null, repo: null, messages };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const a of process.argv.slice(2)) {
    console.error(`thread-target.mjs: unknown option ${a}`);
    process.exit(2);
  }
  const { messages, ...t } = threadTarget();
  for (const m of messages) console.error(`thread-target.mjs: ${m}`);
  console.error(`thread-target.mjs: route=${t.route ?? 'none'}`);
  console.log(JSON.stringify(t));
  process.exit(t.route ? 0 : 1);
}
