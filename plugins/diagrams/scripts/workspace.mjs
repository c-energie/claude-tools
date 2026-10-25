#!/usr/bin/env node
// The workspace resolver — the nearest `.claude/workspace.json`, and nothing else (ADR 0002; the
// context-repo fallback was deleted in #60). See the original for the file's schema, its key
// owners and every rule.
//
// *** COPY of context-kit-core/scripts/workspace.mjs — keep the two byte-identical below this
// banner. *** Plugins cannot reach into each other's install directories, so the copy is
// deliberate. A fix lands in context-kit-core's copy FIRST, then here; check-plugin.mjs errors
// on drift. It needs nothing beside it.
//
//   node workspace.mjs [--json]     (--no-pull, --writable, --no-fallback: accepted, ignored)
//
// stdout is the root only; stderr names the route (route=workspace | route=none).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKSPACE_FILE = join('.claude', 'workspace.json');
export const SCHEMA = 1;

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
 *  given a root rather than resolving one.
 *  -> { kind: 'workspace', root, file, config } — findWorkspace() from `start`, nearest wins;
 *  -> { kind: 'workspace', root, file, error } when that nearest file is malformed. `root` is the
 *     directory holding its .claude/, so a doctor can report the file rather than lose it;
 *  -> null when there is none. A leftover context.json is not a kind any more (#60): a retired
 *     context repo is simply not a workspace. Reads only. */
export function rootKind(start) {
  const found = findWorkspace(resolve(start));
  if (!found) return null;
  if (found.error) return { kind: 'workspace', root: dirname(dirname(found.file)), file: found.file, error: found.error };
  return { kind: 'workspace', ...found };
}

/** Resolve the workspace root. Never throws.
 *  -> { root, route: 'workspace' | null, file, messages[] }
 *  `messages` is everything worth putting on stderr, in order; the CLI prints them. */
export function resolveWorkspace({ cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd() } = {}) {
  const messages = [];
  const found = findWorkspace(resolve(cwd));
  if (found?.root) {
    if (found.config.schema !== SCHEMA) {
      messages.push(`${found.file}: schema is ${JSON.stringify(found.config.schema)}, this resolver knows ${SCHEMA} — resolving the root anyway`);
    }
    messages.push(`route=workspace (${found.file})`);
    return { root: found.root, route: 'workspace', file: found.file, messages };
  }
  if (found?.error) {
    messages.push(`${found.file}: malformed, ignored — ${found.error}`);
    messages.push('route=none — the nearest .claude/workspace.json is malformed');
  } else {
    messages.push('route=none — no .claude/workspace.json above the working directory');
  }
  return { root: null, route: null, file: found?.file ?? null, messages };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let json = false;
  for (const a of process.argv.slice(2)) {
    if (a === '--json') json = true;
    else if (a === '--no-pull' || a === '--writable' || a === '--no-fallback') continue;
    else { console.error(`workspace.mjs: unknown option ${a}`); process.exit(2); }
  }
  const r = resolveWorkspace();
  for (const m of r.messages) console.error(`workspace.mjs: ${m}`);
  if (json) console.log(JSON.stringify({ root: r.root, route: r.route, file: r.file }));
  else if (r.root) console.log(r.root);
  process.exit(r.root ? 0 : 1);
}
