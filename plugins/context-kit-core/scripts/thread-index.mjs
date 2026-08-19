#!/usr/bin/env node
// Rebuild threads/INDEX.md from what is actually on disk. Date, title and path come from the
// file — the model only supplies the two fields that need judgement (status, gist).
//
//   node thread-index.mjs <context-repo-root>                 # skeleton, gist left as TODO
//   node thread-index.mjs <root> --gists gists.json           # fill from {"<file>": {"status","gist"}}
//   node thread-index.mjs <root> --gists g.json --write       # write threads/INDEX.md
//
// Prints the index to stdout unless --write. Filenames are expected as YYYY-MM-DD-<topic>.md;
// anything else is still listed, just without a date.
//
// The topic comes from the front-matter `title:`, then the first markdown heading, then the
// filename slug. Reading the first non-empty line instead — which was the original behaviour —
// yields the literal `---` fence for every file in a repo that uses front-matter, i.e. every
// file this is pointed at. Observed on a real curation pass, 2026-08-13.

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

// Split leading YAML front-matter from the body. Returns fm as an array of lines (null when the
// file has none, or when the block is never closed — an unterminated fence must not swallow the
// whole document).
function splitFrontMatter(text) {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i]?.trim() !== '---') return { fm: null, body: lines.slice(i) };
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === '---' || t === '...') return { fm: lines.slice(i + 1, j), body: lines.slice(j + 1) };
  }
  return { fm: null, body: lines.slice(i) };
}

// One top-level scalar out of the front-matter block. Indented lines are skipped so a nested
// key of the same name can't shadow the real one.
function fmScalar(fm, key) {
  if (!fm) return '';
  for (const line of fm) {
    if (/^\s/.test(line)) continue;
    const m = new RegExp(`^${key}\\s*:\\s*(.*)$`).exec(line);
    if (!m) continue;
    const v = m[1].trim();
    if (/^"(.*)"$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"').trim();
    if (/^'(.*)'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'").trim();
    return v;
  }
  return '';
}

function topicOf(text, filename) {
  const { fm, body } = splitFrontMatter(text);
  const title = fmScalar(fm, 'title');
  if (title) return title;
  const heading = body.find((l) => /^#{1,6}\s+\S/.test(l));
  if (heading) return heading.replace(/^#+\s*/, '').trim();
  return filename.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

function scan(dir, archived) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith('.md') && !SKIP.has(f))
    .sort()
    .map((f) => {
      const text = readFileSync(join(abs, f), 'utf8');
      const meta = gists[f] ?? gists[`${dir}/${f}`] ?? {};
      return {
        date: /^(\d{4}-\d{2}-\d{2})/.exec(f)?.[1] ?? '—',
        topic: topicOf(text, f),
        // An assistant's or supervisor's thread is otherwise indistinguishable from an ordinary
        // one here — tagging rather than nesting was chosen precisely so these stay in the same
        // flat directory. Surfacing the owner is what keeps the index navigable once a role
        // starts writing daily, and what lets a reader see which lines belong to a role rather
        // than to the project itself.
        owner: fmScalar(splitFrontMatter(text).fm, 'assistant')
          || fmScalar(splitFrontMatter(text).fm, 'supervisor') || null,
        kind: fmScalar(splitFrontMatter(text).fm, 'assistant') ? 'assistant'
          : (fmScalar(splitFrontMatter(text).fm, 'supervisor') ? 'supervisor' : null),
        status: meta.status ?? (archived ? 'archived' : 'TODO: active/settled?'),
        gist: meta.gist ?? 'TODO: one-line gist',
        path: `${dir}/${f}`,
      };
    });
}

const active = scan('threads', false);
const archived = scan('Archive/threads', true);
const line = (t) => `- ${t.date} · ${t.topic}${t.owner ? ` · ${t.kind}: ${t.owner}` : ''} · ${t.status} · ${t.gist} · \`${t.path}\``;

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