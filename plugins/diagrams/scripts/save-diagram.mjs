#!/usr/bin/env node
// Capture one diagram into the project's per-org store: write the source, append the index
// line, and (unless told not to) commit. Never pushes — the skill asks first.
//
//   node save-diagram.mjs picture.svg --title "Settlement flow" --type architecture \
//        --tags data-flow,billing --source "session 2026-08-31 sizing call"
//
//   --dry-run          show exactly what would be written, touch nothing
//   --no-commit        write the files, leave them unstaged
//   --status draft     default: current
//   --date YYYY-MM-DD  default: today (pins output for testing)
//   --project NAME     default: the project's own context.json `project`
//   --force-tags       record tags the taxonomy rejects anyway, and say so in the report
//
// The schema, the store resolution and the vocabulary all come from diagram-store.mjs. This
// file is the procedure; that file is the agreement.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename, extname } from 'node:path';
import {
  resolveStore, readTaxonomy, checkVocabulary, appendIndex, serialise,
  extractText, placeFor, FIELDS,
} from './diagram-store.mjs';

const argv = process.argv.slice(2);
const die = (m) => { console.error(m); process.exit(2); };

// Options that take a value; everything else beginning with -- is a flag, and the one bare
// argument is the file. Parsed in one pass rather than by index-of, which mis-reads a value
// that happens to look like a filename.
const VALUED = new Set(['title', 'type', 'tags', 'source', 'status', 'date', 'project']);
const values = new Map();
const flags = new Set();
const bare = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (!a.startsWith('--')) { bare.push(a); continue; }
  const name = a.slice(2);
  if (!VALUED.has(name)) { flags.add(name); continue; }
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) die(`--${name} needs a value`);
  values.set(name, v);
  i += 1;
}
const opt = (name, fallback = null) => (values.has(name) ? values.get(name) : fallback);
const flag = (name) => flags.has(name);

const KNOWN_FLAGS = ['dry-run', 'no-commit', 'force-tags'];
for (const f of flags) if (!KNOWN_FLAGS.includes(f)) die(`unknown option --${f}`);
if (bare.length > 1) die(`expected one diagram file, got ${bare.length}: ${bare.join(', ')}`);

const source = bare[0];
if (!source) die('save-diagram.mjs: needs the diagram file (an .svg or .html Claude just wrote)');
if (!existsSync(source)) die(`no such file: ${source}`);

const ext = extname(source).toLowerCase();
const format = ext === '.svg' ? 'svg' : ext === '.html' || ext === '.htm' ? 'html' : null;
if (!format) {
  die(`${source} is ${ext || 'extensionless'} — the store holds SVG and HTML source only.\n`
    + 'A PNG is build output, not an artifact: it does not diff, does not grep, and cannot be '
    + 're-styled. Save the source and let the gallery render it.');
}

const dryRun = flag('dry-run');
const today = new Date().toISOString().slice(0, 10);
const date = opt('date', today);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) die(`--date must be YYYY-MM-DD, got ${date}`);

let store;
try {
  store = resolveStore({ mustExist: !dryRun });
} catch (e) {
  die(e.message);
}

const title = opt('title', basename(source, ext).replace(/[-_]+/g, ' '));
const type = opt('type', null);
const tags = (opt('tags', '') || '').split(',').map((t) => t.trim()).filter(Boolean);
const status = opt('status', 'current');
const sourceConversation = opt('source', null);
const project = opt('project', store.project);

// ---------------------------------------------------------------- the vocabulary guard
const taxonomy = readTaxonomy(store.dir);
const checks = {
  types: checkVocabulary(taxonomy, 'types', type ? [type] : []),
  tags: checkVocabulary(taxonomy, 'tags', tags),
  statuses: checkVocabulary(taxonomy, 'statuses', [status]),
};

const notes = [];
if (!taxonomy.present) {
  notes.push(`No taxonomy.json in ${store.repo} — the vocabulary has not been agreed yet, so `
    + 'nothing here was checked. Tags are recorded exactly as given; '
    + '`diagram-store.mjs tags-in-use` lists what has accumulated.');
}

const rejected = Object.entries(checks).filter(([, c]) => c.state === 'rejected');
if (rejected.length && !flag('force-tags')) {
  const lines = ['save-diagram.mjs: values outside the store\'s vocabulary.', ''];
  for (const [field, c] of rejected) {
    for (const u of c.unknown) {
      const s = c.suggestions[u];
      lines.push(`  ${field}: "${u}"${s ? ` — did you mean ${s.map((x) => `"${x}"`).join(', ')}?` : ''}`);
    }
  }
  lines.push('', `Allowed by ${taxonomy.path}:`);
  for (const [field, c] of rejected) lines.push(`  ${field}: ${taxonomy[field].join(', ')}`);
  lines.push('',
    'A vocabulary that anything may be added to is not one: `architecture` / `arch` /',
    '`system-diagram` as three tags means filtering by any of them finds a third of the store.',
    'Pick an existing value, or add the new one to taxonomy.json in a commit of its own so the',
    'change is visible. --force-tags records it anyway and says so.');
  die(lines.join('\n'));
}
for (const [field, c] of rejected) {
  notes.push(`FORCED: ${field} value(s) ${c.unknown.map((u) => `"${u}"`).join(', ')} are not in `
    + `${taxonomy.path}. Recorded anyway (--force-tags).`);
}

// ---------------------------------------------------------------- the record
const body = readFileSync(source, 'utf8');
const { rel, id } = placeFor(store.dir, { date, title, format });

const entry = {
  id,
  date,
  org: store.org,
  project,
  title,
  type,
  tags,
  format,
  path: rel,
  source_conversation: sourceConversation,
  status,
  text: extractText(body, format),
};

if (dryRun) {
  console.log(`store    ${store.repo}  (${store.dir})`);
  console.log(`write    ${rel}   ${body.length} bytes`);
  console.log(`append   index.jsonl`);
  console.log(serialise(entry));
  if (!sourceConversation) notes.push('No --source given: source_conversation is null, so this row cannot be traced back to where it came from.');
  if (!type) notes.push('No --type given: type is null.');
  for (const n of notes) console.log(`\nnote: ${n}`);
  console.log('\n(dry run — nothing written)');
  process.exit(0);
}

const abs = join(store.dir, rel);
mkdirSync(dirname(abs), { recursive: true });
writeFileSync(abs, body, 'utf8');
const indexFile = appendIndex(store.dir, entry);

console.log(`wrote    ${rel}`);
console.log(`appended ${basename(indexFile)}  (${FIELDS.length} fields)`);

// ---------------------------------------------------------------- commit, never push
if (!flag('no-commit')) {
  const git = (...a) => execFileSync('git', ['-C', store.dir, ...a], { encoding: 'utf8' });
  try {
    git('add', '--', rel, 'index.jsonl');
    git('commit', '-m', `diagram: ${title}`);
    console.log(`committed to ${store.repo} (local — NOT pushed)`);
  } catch (e) {
    console.error(`commit failed: ${String(e.stderr ?? e.message).trim().split('\n')[0]}`);
    console.error('The files are written and staged; commit by hand.');
  }
}

for (const n of notes) console.log(`\nnote: ${n}`);
if (!sourceConversation) {
  console.log('\nnote: no --source recorded. Six months on, "where did this come from" is the '
    + 'question the index cannot answer for this row.');
}
