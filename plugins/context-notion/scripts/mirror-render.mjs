#!/usr/bin/env node
// Render a project's Notion mirror into its context repo — the read-only slice of Notion that
// people without a working Notion connection (workspace guests, whose queries return empty
// rather than erroring) can still read.
//
//   node mirror-render.mjs <context-root> <export.json> [--today YYYY-MM-DD] [--dry-run]
//
// The point of doing this in a script rather than in prose: the mirror is regenerated in full
// on every sync, so its formatting must be byte-identical between runs. Anything that renders
// differently the second time shows up as a diff, and then every sync commit looks like a
// change when nothing in Notion moved. Sorting, truncation and column order all live here.
//
// <export.json> is what the skill pulled out of Notion, keyed by the SAME database keys the
// project's context.json uses (`state.notion.databases`). Two shapes per key:
//
//   { "actions": [ {…row}, … ] }                        // rows only
//   { "stakeholders": { "title": "Stakeholders & companies",   // …or with presentation
//                       "titleKey": "name",
//                       "note": "one line shown under the count",
//                       "columns": ["name", "org", "priority"],
//                       "rows": [ {…}, … ] } }
//
// Three keys have purpose-built layouts, because their shape is part of this plugin's contract:
//
//   actions        [{task, owner, due, status, url, …}]        — grouped by owner
//   openQuestions  [{question, type, status, chasing, opened, url}] — table
//   decisionLog    [{decision, decided, owner, rationale, revisit, url}] — prose, newest first
//
// ANY other key renders as a generic table: the title column first, then `columns` if given,
// else every other field that appears in the rows (sorted, so it is stable), then a link. That
// is what lets a project mirror databases this plugin has never heard of.
//
// Every key is optional except the row's title — a row without one is skipped and reported.
// Person fields accept a Notion user ID, a `user://` URI, an array of either, or a plain name;
// IDs resolve through the project's roster (`state.notion.people`).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, person, bareId, readInput, today } from './lib.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) =>
  !a.startsWith('--') && args[i - 1] !== '--today');

const root = positional[0];
const input = positional[1];
if (!root) {
  console.error('mirror-render.mjs: needs the context repo root, then the export JSON');
  process.exit(2);
}
if (!existsSync(join(root, 'memory.md'))) {
  console.error(`mirror-render.mjs: ${root} does not look like a context repo (no memory.md)`);
  process.exit(2);
}

const stamp = opt('--today') ?? today();
const dryRun = flag('--dry-run');
const data = readInput(input);
const skipped = [];

// ------------------------------------------------------------------ formatting helpers

/** Table cells are single-line: a pipe or a newline in free text otherwise breaks the row. */
const cell = (v) => String(v ?? '')
  .replace(/\r?\n+/g, ' ')
  .replace(/\|/g, '\\|')
  .replace(/\s+/g, ' ')
  .trim();

/** Long free text is clipped — the mirror is an index, not a copy. The link has the full text.
 *  An empty cell renders as an em dash, so "nobody has filled this in" is visible rather than
 *  looking like a rendering glitch. */
const clip = (v, n = 180) => {
  const s = cell(v);
  if (!s) return '—';
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};

const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

/** A person field may arrive as an ID, a `user://` URI, an array, or a bare name. */
const names = (v) => list(v)
  .map((x) => {
    const bare = bareId(x);
    if (/^[0-9a-f]{8}-/i.test(bare)) return person(bare).name;
    return cell(x);
  })
  .filter(Boolean);

const owners = (v) => names(v).join(', ') || '—';

const link = (url, label = 'open') => (url ? `[${label}](${cell(url)})` : '');

const dash = (v) => cell(v) || '—';

/** Any scalar or array, rendered for a table cell — resolving anything that looks like a
 *  Notion user ID through the roster, whatever the field is called. */
const value = (v) => (Array.isArray(v) ? names(v).join(', ') : names(v).join(', ')) || '—';

const table = (headers, rows) => {
  if (!rows.length) return '_None._\n';
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n') + '\n';
};

/** Deterministic ordering: primary key, then the Notion URL as a tie-break so equal titles
 *  never swap places between runs. */
const by = (keyFn) => (a, b) => {
  const ka = String(keyFn(a) ?? '');
  const kb = String(keyFn(b) ?? '');
  return ka.localeCompare(kb) || String(a.url ?? '').localeCompare(String(b.url ?? ''));
};

/** Undated rows sort last, not first — an empty string would beat every real date. */
const dueKey = (r) => (r.due ? `A${r.due}` : 'Z');

/** JSON.stringify emits keys in insertion order, which varies with how the export was built. */
const sortKeys = (row) => Object.fromEntries(
  Object.keys(row).sort().map((k) => [k, row[k]]),
);

/** `relatedProjects` → `related-projects`, `decisionLog` → `decision-log`. */
const slugOf = (key) => key
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  .replace(/[\s_]+/g, '-')
  .toLowerCase();

/** `relatedProjects` → `Related projects` — only used when the export names no title. */
const titleOf = (key) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

const header = (title, count, note) => [
  '<!-- GENERATED by context-notion:sync-notion-mirror — do not edit by hand.',
  '     Notion is the source of truth; edits here are overwritten by the next sync.',
  '     To change something: change it in Notion, or add an entry to pending/. -->',
  '',
  `# ${title} — Notion mirror`,
  '',
  `_Synced from Notion on ${stamp} · ${count} row${count === 1 ? '' : 's'} · read-only._`,
  '',
  ...(note ? [note, ''] : []),
].join('\n');

// ------------------------------------------------------------------ export shape

/** Both accepted shapes, normalised: rows plus whatever presentation the export declared. */
const entry = (key) => {
  const raw = data[key];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return { rows: raw };
  return { ...raw, rows: list(raw.rows) };
};

const rowsOf = (key, titleKey) => {
  const out = [];
  for (const row of list(entry(key)?.rows)) {
    if (!cell(row?.[titleKey])) {
      skipped.push(`${key}: a row has no \`${titleKey}\` — skipped${row?.url ? ` (${row.url})` : ''}`);
      continue;
    }
    out.push(row);
  }
  return out;
};

/** Which field carries the row's title: what the export said, else a conventional name, else
 *  the first field of the first row. Guessing wrong is visible (every row gets skipped) rather
 *  than silent, which is why this may guess at all. */
const TITLE_KEYS = ['name', 'title', 'question', 'task', 'decision', 'label'];
const titleKeyOf = (key) => {
  const e = entry(key);
  if (e?.titleKey) return e.titleKey;
  const rows = list(e?.rows);
  const known = TITLE_KEYS.find((k) => rows.some((r) => cell(r?.[k])));
  return known ?? Object.keys(rows[0] ?? {})[0] ?? 'name';
};

// ------------------------------------------------------------------ per-database renderers

const renderActions = (key) => {
  const rows = rowsOf(key, 'task').sort((a, b) =>
    dueKey(a).localeCompare(dueKey(b)) || by((r) => r.task)(a, b));

  // Grouped by owner because the question this file answers is "what have I got?".
  const groups = new Map();
  for (const r of rows) {
    for (const name of (names(r.owner).length ? names(r.owner) : ['No owner'])) {
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(r);
    }
  }
  const ordered = [...groups.keys()].sort((a, b) =>
    (a === 'No owner') - (b === 'No owner') || a.localeCompare(b));

  const body = [
    header(entry(key)?.title ?? 'Actions', rows.length,
      entry(key)?.note
      ?? 'Open actions only (`Watching` rows are excluded — those are `check-watchlist`\'s, and '
      + 'their date means *next check*, not deadline). An action owned by two people is listed '
      + 'under both.'),
    ...ordered.flatMap((name) => [
      `## ${name}`,
      '',
      ...groups.get(name).map((r) => {
        const bits = [
          r.due ? `due ${cell(r.due)}` : 'no date',
          dash(r.status),
          ...list(r.workstream).map(cell).filter(Boolean),
        ];
        return `- ${cell(r.task)} — ${bits.join(' · ')}${r.url ? ` · ${link(r.url, 'notion')}` : ''}`;
      }),
      '',
    ]),
  ].join('\n');
  return { rows, body };
};

const renderQuestions = (key) => {
  const rows = rowsOf(key, 'question').sort(by((r) => r.question));
  const body = [
    header(entry(key)?.title ?? 'Open questions', rows.length,
      entry(key)?.note ?? 'Unresolved questions; closed ones excluded.'),
    table(
      ['Question', 'Type', 'Status', "Who's chasing", 'Opened', 'Link'],
      rows.map((r) => [
        cell(r.question),
        dash(r.type),
        dash(r.status),
        owners(r.chasing),
        dash(r.opened),
        link(r.url, 'notion'),
      ]),
    ),
  ].join('\n');
  return { rows, body };
};

const renderDecisions = (key) => {
  // Newest first — the opposite of everywhere else, because a decision log is read from the top.
  const rows = rowsOf(key, 'decision')
    .sort((a, b) => String(b.decided ?? '').localeCompare(String(a.decided ?? ''))
      || by((r) => r.decision)(a, b));

  const body = [
    header(entry(key)?.title ?? 'Decision log', rows.length,
      entry(key)?.note
      ?? 'Newest first. Prose rather than a table because the rationale is the load-bearing '
      + 'part. Where a summary in `memory.md` disagrees with this, Notion wins.'),
    ...rows.flatMap((r) => [
      `## ${cell(r.decision)}`,
      '',
      `- **Decided:** ${dash(r.decided)}${r.owner ? ` by ${owners(r.owner)}` : ''}`,
      ...(cell(r.rationale) ? [`- **Why:** ${clip(r.rationale, 600)}`] : []),
      ...(cell(r.revisit) ? [`- **Revisit:** ${clip(r.revisit, 300)}`] : []),
      ...(r.url ? [`- ${link(r.url, 'in Notion')}`] : []),
      '',
    ]),
  ].join('\n');
  return { rows, body };
};

/** Any database this plugin has no opinion about. Columns come from the export where it names
 *  them, else from the fields actually present — sorted, so two runs agree. */
const renderGeneric = (key) => {
  const titleKey = titleKeyOf(key);
  const rows = rowsOf(key, titleKey).sort(by((r) => r[titleKey]));
  const declared = list(entry(key)?.columns).map(cell).filter(Boolean);
  const found = [...new Set(rows.flatMap((r) => Object.keys(r)))]
    .filter((k) => k !== titleKey && k !== 'url')
    .sort();
  const columns = (declared.length ? declared : found).filter((k) => k !== titleKey && k !== 'url');
  const hasUrl = rows.some((r) => r.url);

  const body = [
    header(entry(key)?.title ?? titleOf(key), rows.length, entry(key)?.note),
    table(
      [titleOf(titleKey), ...columns.map(titleOf), ...(hasUrl ? ['Link'] : [])],
      rows.map((r) => [
        cell(r[titleKey]),
        ...columns.map((c) => clip(value(r[c]))),
        ...(hasUrl ? [link(r.url, 'notion')] : []),
      ]),
    ),
  ].join('\n');
  return { rows, body };
};

const RENDERERS = {
  actions: renderActions,
  openQuestions: renderQuestions,
  decisionLog: renderDecisions,
};

// ------------------------------------------------------------------ write

// Whatever the export carries, in a stable order: the contract keys first (so a project that
// mirrors all three always gets the same _synced.json), then the rest alphabetically.
const CONTRACT = ['actions', 'openQuestions', 'decisionLog'];
const keys = [
  ...CONTRACT.filter((k) => data[k] !== undefined),
  ...Object.keys(data).filter((k) => !CONTRACT.includes(k)).sort(),
];

const dir = join(root, 'notion');
if (!dryRun && !existsSync(dir)) mkdirSync(dir, { recursive: true });

// What the last sync recorded. A partial sync must not make _synced.json forget the databases
// it left on disk — a reader deciding whether the mirror answers their question needs every
// file listed, each with the date IT was last written, not the date of this run.
let previous = {};
try {
  previous = JSON.parse(readFileSync(join(dir, '_synced.json'), 'utf8')).databases ?? {};
} catch { /* no previous sync, or an unreadable one: start clean */ }

const synced = { syncedOn: stamp, source: "Notion — see the project's context.json state.notion", databases: {} };
const report = [];

if (!keys.length) {
  console.error('mirror-render.mjs: the export names no databases — nothing to render');
  process.exit(2);
}

for (const key of keys) {
  // A database absent from the export is left alone: a partial sync must not blank a file that
  // a previous full sync wrote. (That is why "didn't fetch" must be an absent key, never [].)
  const slug = slugOf(key);
  const { rows, body } = (RENDERERS[key] ?? renderGeneric)(key);
  const md = `${body.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  // Keys sorted so a JSON diff shows changed values, never reordered fields.
  const json = `${JSON.stringify({ syncedOn: stamp, database: key, rows: rows.map(sortKeys) }, null, 2)}\n`;

  synced.databases[key] = { file: `notion/${slug}.md`, rows: rows.length, syncedOn: stamp };
  report.push(`- \`notion/${slug}.md\` — ${rows.length} row${rows.length === 1 ? '' : 's'}`);

  if (!dryRun) {
    writeFileSync(join(dir, `${slug}.md`), md, 'utf8');
    writeFileSync(join(dir, `${slug}.json`), json, 'utf8');
  }
}

// Carry forward every database this export didn't cover, keeping the date it was actually
// last written. Sorted, so a re-sync of the same state produces no diff here either.
for (const key of Object.keys(previous).sort()) {
  if (synced.databases[key]) continue;
  synced.databases[key] = previous[key];
  report.push(`- \`${previous[key]?.file ?? `notion/${slugOf(key)}.md`}\` — not in this export, `
    + `left as it is${previous[key]?.syncedOn ? ` (synced ${previous[key].syncedOn})` : ''}`);
}

if (!dryRun) {
  writeFileSync(join(dir, '_synced.json'), `${JSON.stringify(synced, null, 2)}\n`, 'utf8');
}

console.log([
  `**Notion mirror** · ${dryRun ? 'dry run, nothing written' : `written to ${dir}`} · synced ${stamp}`,
  '',
  ...report,
  ...(skipped.length ? ['', '### ⚠️ Skipped rows', ...skipped.map((s) => `- ${s}`)] : []),
  '',
  config.people.length
    ? `Roster used for owner names: ${config.people.map((p) => p.name).join(', ')}. An ID that is not `
      + "in it renders as \"Unknown owner\" — add them to the context repo's `context.json` "
      + '(`state.notion.people`).'
    : "No roster in the project's `context.json` (`state.notion.people`) — every person ID renders "
      + 'as "Unknown owner" until one is added.',
  '',
  'Databases NOT in this export were left untouched on disk.',
].join('\n'));
