#!/usr/bin/env node
// Rebuild threads/INDEX.md from what is actually on disk. Date, title and path come from the
// filesystem — the model only supplies the two fields that need judgement (status, gist).
//
//   node thread-index.mjs <context-repo-root>                 # skeleton, gist left as TODO
//   node thread-index.mjs <root> --gists gists.json           # fill from {"<file>": {"status","gist"}}
//   node thread-index.mjs <root> --gists g.json --write       # write threads/INDEX.md
//
// Prints the index to stdout unless --write. Filenames are expected as YYYY-MM-DD-<topic>.md;
// anything else is still listed, just without a date.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flags = new Set();
const positional = [];
let gistsPath = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--gists') gistsPath = argv[++i];
  else if (argv[i].startsWith('--')) flags.add(argv[i].slice(2));
  else positional.push(argv[i]);
}
const root = positional[0];
if (!root) { console.error('thread-index.mjs: needs the context repo root'); process.exit(2); }
const gists = gistsPath ? JSON.parse(readFileSync(gistsPath, 'utf8')) : {};

const SKIP = new Set(['README.md', 'INDEX.md']);

function scan(dir, archived) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith('.md') && !SKIP.has(f))
    .sort()
    .map((f) => {
      const head = readFileSync(join(abs, f), 'utf8').split('\n').find((l) => l.trim()) ?? '';
      const meta = gists[f] ?? gists[`${dir}/${f}`] ?? {};
      return {
        date: /^(\d{4}-\d{2}-\d{2})/.exec(f)?.[1] ?? '—',
        topic: head.replace(/^#+\s*/, '').trim() || f.replace(/\.md$/, ''),
        status: meta.status ?? (archived ? 'archived' : 'TODO: active/settled?'),
        gist: meta.gist ?? 'TODO: one-line gist',
        path: `${dir}/${f}`,
      };
    });
}

const active = scan('threads', false);
const archived = scan('Archive/threads', true);
const line = (t) => `- ${t.date} · ${t.topic} · ${t.status} · ${t.gist} · \`${t.path}\``;

const out = [
  '# Thread index',
  '',
  `_Generated ${new Date().toISOString().slice(0, 10)} — one line per thread. Format: date · topic · status · gist · path._`,
  '',
  `## Active (${active.length})`,
  ...(active.length ? active.map(line) : ['- _none_']),
  '',
  `## Archived (${archived.length})`,
  ...(archived.length ? archived.map(line) : ['- _none_']),
  '',
].join('\n');

if (flags.has('write')) {
  writeFileSync(join(root, 'threads', 'INDEX.md'), out);
  console.error(`Wrote threads/INDEX.md — ${active.length} active, ${archived.length} archived.`);
} else {
  console.log(out);
}