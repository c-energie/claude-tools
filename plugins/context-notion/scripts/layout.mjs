#!/usr/bin/env node
// Where this layer's files live under a resolved root — the meetings folder, the offline queue
// and the Notion mirror — in a workspace (ADR 0002).
//
//   node layout.mjs <root>             # one `key=path` line each, absolute
//   node layout.mjs <root> pending     # just that path (kind|config|meetings|pending|done|mirror|templates|taxonomy)
//   node layout.mjs <root> --json      # everything, plus the root-relative forms under `rel`
//
// <root> is what workspace.mjs printed (`ROOT="$(node workspace.mjs)"`); this script
// never resolves one itself, so a skill and the scripts it runs cannot be pointed at two homes.
//
//   config        .claude/workspace.json
//   meetings      docs/meetings/
//   pending       .context/pending/
//   done          .context/pending/done/
//   mirror        .context/notion/
//   templates     templates/
//   taxonomy      taxonomy.yml
//
// WHY ONE TABLE, HERE. Before workspaces every skill typed `pending/` and `notion/` and every
// script joined them onto the root itself, and the first one that guessed wrong would write the
// queue into a directory process-pending never reads — the entry is committed, nothing errors,
// and the thing it asked for never reaches Notion. So the paths are named once, by this file,
// and the scripts and skills ask it.
//
// THERE IS ONE LAYOUT. The context-repo layout (context.json, meetings/, pending/, notion/ at the
// root) was deleted with the context-repo route (#60). `kind` says whether the root IS a
// workspace: 'workspace' when the nearest `.claude/workspace.json` at or above it is a valid one
// AT the root itself (findWorkspace(), the resolver's own walk, never a folder or repo name),
// else null — a malformed file there, or a workspace found only ABOVE the root, does not make
// the root one. The paths are the workspace's either way; a caller about to WRITE checks `kind`.
//
// `templates/` and `taxonomy.yml` stay at the root: they are the repo's own house rules, and the
// workspace layout moved machine state and docs, not those.
//
// Origin: context-notion — the queue and the mirror are Notion-coupled. context-slack carries a
// copy (notify-pending and the digest's mirror fallback read the same paths); fix this one first.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWorkspace, WORKSPACE_FILE } from './workspace.mjs';

const REL = {
  config: WORKSPACE_FILE,
  meetings: join('docs', 'meetings'),
  pending: join('.context', 'pending'),
  done: join('.context', 'pending', 'done'),
  mirror: join('.context', 'notion'),
};

/** The layout under `root`. -> { root, kind: 'workspace'|null, rel: {…}, …absolute paths }
 *  `rel` uses `/` on every platform: it is written into files and messages (`.context/pending/actions.md`),
 *  which must read the same whoever ran the script. */
export function layout(root) {
  const abs = resolve(root);
  const kind = findWorkspace(abs)?.root === abs ? 'workspace' : null;
  const rel = { ...REL, templates: 'templates', taxonomy: 'taxonomy.yml' };
  for (const k of Object.keys(rel)) rel[k] = rel[k].split('\\').join('/');
  const out = { root: abs, kind, rel };
  for (const [k, v] of Object.entries(rel)) out[k] = join(abs, v);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--'));
  const key = args.filter((a) => !a.startsWith('--'))[1];
  if (!root) { console.error('layout.mjs: needs the root (from workspace.mjs)'); process.exit(2); }
  const l = layout(root);
  if (args.includes('--json')) console.log(JSON.stringify(l, null, 2));
  else if (key) {
    if (!(key in l) || key === 'rel') { console.error(`layout.mjs: unknown key ${key}`); process.exit(2); }
    console.log(l[key]);
  } else {
    for (const k of ['kind', 'config', ...Object.keys(l.rel).filter((k) => k !== 'config')]) console.log(`${k}=${l[k]}`);
  }
}
