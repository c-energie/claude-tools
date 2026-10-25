#!/usr/bin/env node
// Find the workspace a session is in: the nearest `.claude/workspace.json` at or above the
// working directory (ADR 0002). There is no other route: the context-repo fallback that served
// unmigrated projects was deleted once the last one moved (#60).
//
//   node workspace.mjs                 # print the workspace root on stdout, the route on stderr
//   node workspace.mjs --json          # {root, route, file} on stdout instead of the bare path
//
// --no-pull, --writable and --no-fallback are accepted and ignored: they were the fallback's,
// and a caller written before #60 must not start failing on an unknown option.
//
// stdout is the absolute root and nothing else, so `ROOT="$(node workspace.mjs)"` works. stderr
// always carries one `workspace.mjs: route=...` line (`route=workspace` or `route=none`), so a
// session that resolved nothing says why rather than going quiet. Exit 1 when there is no
// workspace, with the reason on stderr; callers decide whether that is fatal. Never prompts,
// never throws, never touches the network.
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
//   - A malformed nearest file is REPORTED (path + parse error) and the walk stops there, resolving
//     nothing — it never skips past to an outer workspace. Skipping would silently load a
//     different workspace's context because of a typo in this one.
//   - A schema other than 1 is reported but still resolves: where the root is does not depend on
//     what the file says, and refusing would break every session the day a schema 2 ships.
//
// `workspace-root.sh` is this resolver's bash TWIN for hooks, not a copy — the drift rule
// cannot compare them, so workspace.test.mjs runs both against the same fixtures. Change both.
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
