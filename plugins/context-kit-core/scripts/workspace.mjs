#!/usr/bin/env node
// Find the workspace a session is in: the nearest `.claude/workspace.json` at or above the
// working directory. Falls back to the context-repo route (context-repo.sh) while unmigrated
// projects still exist — ADR 0002's transition; a later ticket deletes the fallback.
//
//   node workspace.mjs                 # print the workspace root on stdout, the route on stderr
//   node workspace.mjs --no-pull       # ...passed to the fallback only (the workspace route
//   node workspace.mjs --writable      #    does no network at all, so has nothing to skip)
//   node workspace.mjs --json          # {root, route, file} on stdout instead of the bare path
//   node workspace.mjs --no-fallback   # the workspace route only: never run context-repo.sh
//
// stdout is the absolute root and nothing else, so `ROOT="$(node workspace.mjs)"` works as it
// does for context-repo.sh. stderr always carries one `workspace.mjs: route=...` line saying
// which route answered — during the transition "which home did this session load?" is the
// first question anyone debugging it asks, and silence would make the two routes look alike.
// Exit 1 when neither route resolves, with the reason on stderr; callers decide whether that is
// fatal, exactly as they already do for context-repo.sh. Never prompts, never throws.
//
// --no-fallback is for a caller that only wants to know WHETHER this is a workspace — the
// session-start hook, which runs its own legacy loader when it is not. Without it, asking that
// question outside a workspace runs context-repo.sh, which may clone a context repo just to
// answer "no".
//
// THE FILE — `.claude/workspace.json`, schema 1 (ADR 0002):
//
//   { "schema": 1, "name": "...", "repo": "owner/repo",
//     "members": [ { "dir": "...", "repo": "owner/repo", "kind": "code" | "document" | "analysis", ... } ],
//     "connections": { ... },
//     "state": { "notion": { ... }, ... } }
//
// Each top-level key has ONE writing owner: schema / name / repo / members — project-workspace;
// connections — setup-connectors; each state.* block — the plugin that reads it. A writer edits
// only its own key (json-block.mjs's block-scale edit) and preserves every key it does not know,
// at the top level AND inside member entries: a member carries kind-specific fields (a
// document's extras; an analysis member's `documents`, a list of document dirs) that only
// project-workspace defines, and a reader that dropped them would erase them on its next write.
// So this resolver validates nothing beyond "a JSON object": it locates the root, it does not
// judge the contents, and anything stricter here would reject files it has no authority over.
//
// WHY THESE RULES
//   - What a directory IS is decided by this file, never by its folder or repo name. A name is
//     a guess; context repos tended to all be called "context", and guessing from a name is how
//     the wrong context gets loaded — the failure this whole plugin exists to prevent.
//   - Nearest wins, and levels never merge. A workspace is the unit; merging an outer one into
//     an inner one would make the inner file's meaning depend on wherever it was checked out.
//   - The walk does NOT stop at a `.git`, unlike diagrams' findRepoFile(): a workspace wraps its
//     members as nested clones, so a session in a member is inside a .git that is not the
//     workspace. Stopping there is exactly how the old resolver cloned a second copy of a
//     context that was already on disk above it.
//   - A malformed nearest file is REPORTED (path + parse error) and the walk stops there, going
//     to the fallback — it never skips past to an outer workspace. Skipping would silently load
//     a different workspace's context because of a typo in this one.
//   - A schema other than 1 is reported but still resolves: where the root is does not depend on
//     what the file says, and refusing would break every session the day a schema 2 ships.
//
// `workspace-root.sh` is this resolver's bash TWIN for hooks, not a copy — the drift rule
// cannot compare them, so workspace.test.mjs runs both against the same fixtures. Change both.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bashBin } from './bash-bin.mjs';

export const WORKSPACE_FILE = join('.claude', 'workspace.json');
export const SCHEMA = 1;

const here = dirname(fileURLToPath(import.meta.url));

/** The nearest `.claude/workspace.json` at or above `start`.
 *  -> null when there is none all the way to the filesystem root;
 *  -> { root, file, config } when it parses as a JSON object;
 *  -> { root: null, file, error } when the nearest one does not — the walk stops there. */
export function findWorkspace(start = process.cwd()) {
  let dir = resolve(start);
  for (;;) {
    const file = join(dir, WORKSPACE_FILE);
    if (existsSync(file)) {
      let config;
      try {
        config = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
      } catch (e) {
        return { root: null, file, error: String(e?.message ?? e).split('\n')[0] };
      }
      // An array or a bare string parses, but has no keys for any owner to write to.
      if (config === null || typeof config !== 'object' || Array.isArray(config)) {
        return { root: null, file, error: 'top level is not a JSON object' };
      }
      return { root: dir, file, config };
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** What a directory handed to a DIAGNOSTIC is — context-doctor and context-status, which are
 *  given a root rather than resolving one, and must check legacy context repos exactly as before
 *  while the fallback lasts (ADR 0002's transition).
 *  -> { kind: 'context-repo', root } when `start` itself holds context.json and no workspace.json.
 *     Tested FIRST, before any walk: a context repo is a root of its own, and walking up from one
 *     would judge it by whichever workspace happened to sit above its clone.
 *  -> { kind: 'workspace', root, file, config } — findWorkspace() from `start`, nearest wins;
 *  -> { kind: 'workspace', root, file, error } when that nearest file is malformed. `root` is the
 *     directory holding its .claude/, so a doctor can report the file rather than lose it;
 *  -> null when it is neither. Reads only; validates nothing beyond findWorkspace()'s own test. */
export function rootKind(start) {
  const dir = resolve(start);
  if (existsSync(join(dir, 'context.json')) && !existsSync(join(dir, WORKSPACE_FILE))) {
    return { kind: 'context-repo', root: dir };
  }
  const found = findWorkspace(dir);
  if (!found) return null;
  if (found.error) return { kind: 'workspace', root: dirname(dirname(found.file)), file: found.file, error: found.error };
  return { kind: 'workspace', ...found };
}

/** The legacy route, unchanged: context-repo.sh run from `cwd`. CLAUDE_PROJECT_DIR is pinned to
 *  `cwd` because the script prefers it over $PWD — inheriting a different one would make the
 *  two routes look from two different places. */
function legacyRoot(cwd, args, env) {
  const bash = bashBin();
  if (!bash) return { root: null, error: 'no Git Bash found to run context-repo.sh (see bash-bin.mjs)' };
  const r = spawnSync(bash, [join(here, 'context-repo.sh'), ...args], {
    cwd, env: { ...env, CLAUDE_PROJECT_DIR: cwd }, encoding: 'utf8', windowsHide: true,
  });
  const stderr = (r.stderr ?? '').trim();
  const root = r.status === 0 ? (r.stdout ?? '').trim().split('\n').pop() : '';
  if (root) return { root, stderr };
  return { root: null, stderr, error: r.error ? String(r.error.message) : `context-repo.sh exited ${r.status}` };
}

/** Resolve the workspace root. Never throws.
 *  -> { root, route: 'workspace' | 'context-repo' | null, file, messages[] }
 *  `messages` is everything worth putting on stderr, in order; the CLI prints them. */
export function resolveWorkspace({ cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd(), args = [], env = process.env, fallback = true } = {}) {
  const messages = [];
  const start = resolve(cwd);
  const found = findWorkspace(start);
  if (found?.root) {
    if (found.config.schema !== SCHEMA) {
      messages.push(`${found.file}: schema is ${JSON.stringify(found.config.schema)}, this resolver knows ${SCHEMA} — resolving the root anyway`);
    }
    messages.push(`route=workspace (${found.file})`);
    return { root: found.root, route: 'workspace', file: found.file, messages };
  }
  if (found?.error) messages.push(`${found.file}: malformed, ignored — ${found.error}`);
  if (!fallback) {
    messages.push(`route=none — ${found?.error ? 'the nearest .claude/workspace.json is malformed' : 'no .claude/workspace.json above the working directory'}, and --no-fallback skips the context repo`);
    return { root: null, route: null, file: found?.file ?? null, messages };
  }
  const legacy = legacyRoot(start, args, env);
  // context-repo.sh's own lines already name their source; they are relayed as written.
  if (legacy.stderr) messages.push(...legacy.stderr.split('\n'));
  if (legacy.root) {
    messages.push(`route=context-repo (${found?.error ? 'the nearest .claude/workspace.json is malformed' : 'no .claude/workspace.json above the working directory'})`);
    return { root: legacy.root, route: 'context-repo', file: null, messages };
  }
  messages.push(`route=none — no workspace, and the context-repo fallback did not resolve (${legacy.error})`);
  return { root: null, route: null, file: found?.file ?? null, messages };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const passThrough = [];
  let json = false, fallback = true;
  for (const a of process.argv.slice(2)) {
    if (a === '--json') json = true;
    else if (a === '--no-fallback') fallback = false;
    else if (a === '--no-pull' || a === '--writable') passThrough.push(a);
    else { console.error(`workspace.mjs: unknown option ${a}`); process.exit(2); }
  }
  const r = resolveWorkspace({ args: passThrough, fallback });
  for (const m of r.messages) console.error(m.startsWith('context-repo.sh: ') ? m : `workspace.mjs: ${m}`);
  if (json) console.log(JSON.stringify({ root: r.root, route: r.route, file: r.file }));
  else if (r.root) console.log(r.root);
  process.exit(r.root ? 0 : 1);
}
