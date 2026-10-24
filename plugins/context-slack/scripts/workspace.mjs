#!/usr/bin/env node
// The workspace resolver — the nearest `.claude/workspace.json`, else the context repo through
// context-repo.sh. See the original for the file's schema, its key owners and every rule.
//
// *** COPY of context-kit-core/scripts/workspace.mjs — keep the two byte-identical below this
// banner. *** Plugins cannot reach into each other's install directories, so the copy is
// deliberate. A fix lands in context-kit-core's copy FIRST, then here; check-plugin.mjs errors
// on drift. It needs bash-bin.mjs and context-repo.sh beside it, which this plugin ships.
//
//   node workspace.mjs [--no-pull] [--writable] [--json] [--no-fallback]
//
// stdout is the root only; stderr names the route (route=workspace | route=context-repo).
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
