#!/usr/bin/env node
// *** COPY of context-notion/scripts/layout.mjs — that one OWNS where the queue, the mirror and
// the meetings folder live. *** notify-pending's queue and person-slack-digest's mirror fallback
// read the same paths context-notion writes, so they must come from the same table; a fix lands
// in context-notion's copy FIRST, then here. check-plugin.mjs errors on drift.
//
// Where this layer's files live under a resolved root — the meetings folder, the offline queue
// and the Notion mirror — in a workspace and in a legacy context repo.
//
//   node layout.mjs <root>             # one `key=path` line each, absolute
//   node layout.mjs <root> pending     # just that path (kind|config|meetings|pending|done|mirror|templates|taxonomy)
//   node layout.mjs <root> --json      # everything, plus the root-relative forms under `rel`
//
// <root> is what workspace.mjs printed (`ROOT="$(node workspace.mjs --writable)"`); this script
// never resolves one itself, so a skill and the scripts it runs cannot be pointed at two homes.
//
//                 workspace (ADR 0002)       context repo (legacy)
//   config        .claude/workspace.json     context.json
//   meetings      docs/meetings/             meetings/
//   pending       .context/pending/          pending/
//   done          .context/pending/done/     pending/done/
//   mirror        .context/notion/           notion/
//   templates     templates/                 templates/
//   taxonomy      taxonomy.yml               taxonomy.yml
//
// WHY ONE TABLE, HERE. Before workspaces every skill typed `pending/` and `notion/` and every
// script joined them onto the root itself. With two layouts that is a dozen places to choose
// between them, and the first one that guessed wrong would write the queue into a directory
// process-pending never reads — the entry is committed, nothing errors, and the thing it asked
// for never reaches Notion. So the choice is made once, by this file, and the scripts and
// skills ask it.
//
// WHAT DECIDES THE KIND. The root is a workspace when the nearest `.claude/workspace.json` at or
// above it is a valid one AT the root itself — findWorkspace(), the resolver's own walk, never a
// folder or repo name. A malformed one there makes it a context repo, which is what the
// resolver fell back to; a workspace found only ABOVE the root (a legacy clone checked out
// inside some workspace) does not make the clone one.
//
// `templates/` and `taxonomy.yml` stay at the root in both: they are the repo's own house rules,
// and the workspace layout moved machine state and docs, not those.
//
// Origin: context-notion — the queue and the mirror are Notion-coupled. context-slack carries a
// copy (notify-pending and the digest's mirror fallback read the same paths); fix this one first.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWorkspace, WORKSPACE_FILE } from './workspace.mjs';

const REL = {
  workspace: {
    config: WORKSPACE_FILE,
    meetings: join('docs', 'meetings'),
    pending: join('.context', 'pending'),
    done: join('.context', 'pending', 'done'),
    mirror: join('.context', 'notion'),
  },
  'context-repo': {
    config: 'context.json',
    meetings: 'meetings',
    pending: 'pending',
    done: join('pending', 'done'),
    mirror: 'notion',
  },
};

/** The layout under `root`. -> { root, kind: 'workspace'|'context-repo', rel: {…}, …absolute paths }
 *  `rel` uses `/` on every platform: it is written into files and messages (`.context/pending/actions.md`),
 *  which must read the same whoever ran the script. */
export function layout(root) {
  const abs = resolve(root);
  const kind = findWorkspace(abs)?.root === abs ? 'workspace' : 'context-repo';
  const rel = { ...REL[kind], templates: 'templates', taxonomy: 'taxonomy.yml' };
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
