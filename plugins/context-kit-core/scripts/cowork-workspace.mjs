#!/usr/bin/env node
// Find a workspace.json that was UPLOADED into a Cowork sandbox, and the write rules that apply
// to the workspace repo reached from there (ADR 0002, Cowork bullet; #61).
//
//   node cowork-workspace.mjs [project-dir]   # the uploaded workspace.json found, or why not (--json)
//
// WHY THIS EXISTS. A Cowork sandbox has no shell, no checkout and no env var: files arrive as an
// uploaded folder, and GitHub is a host-run MCP connector. So workspace.mjs's walk-up finds
// nothing there. The connection gate used to fall back to a context-project.json marker that
// the old session-start loader mirrored; ADR 0002 retired both, and #60 deleted them. Without
// this the gate would fail open in exactly the surface where a wrong connector is easiest to
// reach for. It looks where that marker search used to look, for the file that replaced it.
//
// ONLY FOR WHEN THE WALK-UP FOUND NOTHING. A workspace above the working directory is a
// checkout, and a checkout is always the better answer than a copy someone uploaded; callers
// ask findWorkspace() first and this second, never the other way round. It is not folded into
// findWorkspace() itself because that is the resolver save-thread, the doctor and four other
// plugins' copies use on a laptop, where a stray file under ~/mnt must never decide anything.
// It is core-only, not a COPIES entry: the gate is its one caller.
//
// WHERE IT LOOKS, in order — the layouts the retired marker search covered, then a
// bounded search of the mount areas, never the working tree:
//   /mnt/project/                            one Cowork / claude.ai layout
//   ~/mnt/.projects/[uuid]/docs/             the /sessions/... layout: attached project files
//   ~/mnt/uploads/                           ...and files uploaded into the session
//   [project]/../../.project-cache/[uuid]/docs/
//                                            the Windows desktop-app layout, where hooks run on
//                                            the HOST and the sandbox's ~/mnt does not exist
// At each, both `workspace.json` and `.claude/workspace.json`: uploads are believed to arrive
// flat (a folder upload may or may not keep a dot-directory), and the first real Cowork run is
// what settles it — the manual check on #61 records where it actually lands.
//
// WHAT COUNTS. `workspace.json` is a common name — Nx and old Angular workspaces use it — and a
// bounded search of /mnt will meet files nobody uploaded for this. So a candidate counts only if
// it parses as a JSON object with a `repo` of owner/name: that key is what the Cowork route
// needs (it is the target and picks the connector), and it is what tells our file from theirs.
// A candidate that fails is recorded with its reason and the search goes on — unlike the
// walk-up, which stops at a malformed file because there the nearest one IS the workspace;
// here nearness means nothing, and a broken stray must not hide the real upload.
//
// BOUNDED, because the gate runs this on every MCP call outside a workspace. Depth <= 5 below
// each mount root (as `find -maxdepth 5`), at most SCAN_LIMIT entries in all, symlinks never
// followed, `.git` / `node_modules` skipped, and under /mnt the WSL drive mounts (/mnt/c, ...)
// and /mnt/wsl* skipped: those are the whole Windows disk, slow to list, and full of unrelated
// workspace.json files. Never throws: an unreadable directory is skipped, not fatal.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAMES = ['workspace.json', join('.claude', 'workspace.json')];
const MAX_DEPTH = 5;
const SCAN_LIMIT = 5000;
const OWNER_REPO = /^[^/\s]+\/[^/\s]+$/;

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const subdirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { return []; }
};

/** Read one candidate. -> { file, config } when it is a usable uploaded workspace,
 *  -> { file, error } when it is not. */
function judge(file) {
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    return { file, error: String(e?.message ?? e).split('\n')[0] };
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { file, error: 'top level is not a JSON object' };
  }
  if (typeof config.repo !== 'string' || !OWNER_REPO.test(config.repo)) {
    return { file, error: 'no "repo": "owner/name" — not a workspace.json the Cowork route can use' };
  }
  return { file, config };
}

/** Every workspace.json at depth <= MAX_DEPTH below `root`, shallowest first (breadth-first,
 *  names sorted), so the result does not depend on readdir's order. */
function* scan(root, { atMnt, budget }) {
  let level = [root];
  for (let depth = 1; depth <= MAX_DEPTH && level.length; depth++) {
    const next = [];
    for (const dir of level) {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (--budget.left < 0) return;
        if (e.isFile() && e.name === 'workspace.json') yield join(dir, e.name);
        else if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules'
          && !(atMnt && dir === root && (/^[a-z]$/i.test(e.name) || e.name.startsWith('wsl')))) {
          next.push(join(dir, e.name));
        }
      }
    }
    level = next;
  }
}

/** The uploaded workspace.json, for when findWorkspace() found none.
 *  -> { file, config, rejected[] } for the first usable one;
 *  -> { file: null, rejected[], searched[] } when there is none — `rejected` names each candidate
 *     that was seen and refused, and why, so a caller failing open can say more than "nothing". */
export function findUploadedWorkspace({ project = process.cwd(), home = homedir(), mnt = '/mnt' } = {}) {
  const cache = resolve(project, '..', '..', '.project-cache');
  const dirs = [
    join(mnt, 'project'),
    ...subdirs(join(home, 'mnt', '.projects')).map((u) => join(home, 'mnt', '.projects', u, 'docs')),
    join(home, 'mnt', 'uploads'),
    ...subdirs(cache).map((u) => join(cache, u, 'docs')),
  ];
  const rejected = [];
  const seen = new Set();
  const consider = (file) => {
    if (seen.has(file) || !isFile(file)) return null;
    seen.add(file);
    const r = judge(file);
    if (r.config) return r;
    rejected.push(r);
    return null;
  };
  for (const d of dirs) {
    for (const n of NAMES) {
      const hit = consider(join(d, n));
      if (hit) return { ...hit, rejected };
    }
  }
  // Layouts drift. The search is shared across roots so the budget bounds the whole call.
  const roots = [join(home, 'mnt'), mnt, cache];
  const budget = { left: SCAN_LIMIT };
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of scan(root, { atMnt: root === mnt, budget })) {
      const hit = consider(file);
      if (hit) return { ...hit, rejected };
    }
  }
  return { file: null, rejected, searched: [...dirs, ...roots] };
}

// ------------------------------------------------------------------ the Cowork write rules
// Writes from Cowork reach the workspace's own `repo` only, and only under these paths. Every
// write over the API replaces a whole file, so a file rebuilt from a stale or partial read is
// truncated without a diff anyone sees; threads, meetings and the machine state under .context/
// are append-or-create and survive that, while the curated files — docs/memory.md, GLOSSARY.md,
// docs/adr/ — are exactly the ones a truncation would quietly destroy. They are curated from a
// laptop, where git shows the diff. ONE constant: the gate's deny reason quotes it, and the
// context-access skill states the same list.
export const COWORK_WRITE_ALLOWLIST = ['docs/threads/', 'docs/meetings/', '.context/'];

/** A repo path normalised for the allowlist, or null when it cannot be trusted: a leading `/`,
 *  a backslash, an empty segment or a `..` anywhere — `docs/threads/../memory.md` must not pass
 *  a prefix test it only appears to pass. `./` segments are dropped. */
export function normalisePath(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\')) return null;
  const parts = p.split('/').filter((s) => s !== '.');
  if (!parts.length || parts.some((s) => s === '' || s === '..')) return null;
  return parts.join('/');
}

/** Is this repo path one Cowork may write? Prefix match on the normalised path, which must name
 *  something inside the directory, not the directory itself. */
export function writeAllowed(p) {
  const n = normalisePath(p);
  return n !== null && COWORK_WRITE_ALLOWLIST.some((pre) => n.startsWith(pre) && n.length > pre.length);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const project = args.find((a) => !a.startsWith('--')) ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const r = findUploadedWorkspace({ project });
  for (const x of r.rejected) console.error(`cowork-workspace.mjs: skipped ${x.file} — ${x.error}`);
  if (json) console.log(JSON.stringify({ file: r.file, repo: r.config?.repo ?? null }));
  else if (r.file) console.log(r.file);
  else console.error('cowork-workspace.mjs: no uploaded workspace.json in the sandbox mount areas');
  process.exit(r.file ? 0 : 1);
}
