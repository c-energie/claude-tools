#!/usr/bin/env node
// Bucket open Actions rows for a triage pass. Fixed, repeatable arithmetic —
// the model supplies the rows and the judgement, this decides what "overdue" means.
//
//   node triage.mjs rows.json
//   node triage.mjs rows.json --watching     # the watch board instead of live actions
//   node triage.mjs rows.json --by-owner
//   node triage.mjs rows.json --today 2026-07-27
//
// Input: JSON array of rows, each
//   { "url": "...", "task": "...", "status": "Not started",
//     "owner": ["user://<uuid>"], "due": "2026-07-31" }
// `due` and `owner` may be null/absent. Output: markdown, ready to show the user.

import { bucket, byDue, person, pretty, readInput, today } from './lib.mjs';

const VALUE_FLAGS = new Set(['--today']);
const argv = process.argv.slice(2);
const flags = new Set();
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) opts[a.slice(2)] = argv[++i];
  else if (a.startsWith('--')) flags.add(a.slice(2));
  else positional.push(a);
}
const flag = (n) => flags.has(n);

const now = opts.today ?? today();
const watchMode = flag('watching');
const rows = readInput(positional[0]);

const live = rows.filter((r) =>
  watchMode ? r.status === 'Watching' : r.status !== 'Watching' && r.status !== 'Done');

const HEADINGS = watchMode
  ? { checkDue: '👀 Due to check now', watching: '🔭 Watching (not due yet)' }
  : { overdue: '⏰ Overdue', soon: `📅 Due within 7 days`, undated: '📋 Open, no date', later: '🗓 Later' };

const label = (r) => {
  const who = (r.owner ?? []).map((o) => person(o).name).join(', ');
  const link = r.url ? `[${r.task}](${r.url})` : r.task;
  return `- ${link}${who ? ` — ${who}` : ''} — ${pretty(r.due)}${r.status && !watchMode ? ` — _${r.status}_` : ''}`;
};

const out = [`**Actions ${watchMode ? 'watch board' : 'triage'}** · ${now} · ${live.length} row(s)`, ''];

if (flag('by-owner')) {
  const owners = new Map();
  for (const r of live) {
    for (const key of (r.owner?.length ? r.owner.map((o) => person(o).name) : ['Unassigned'])) {
      owners.set(key, [...(owners.get(key) ?? []), r]);
    }
  }
  for (const [name, list] of [...owners].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push(`### ${name}`, ...list.sort(byDue).map(label), '');
  }
} else {
  for (const [key, heading] of Object.entries(HEADINGS)) {
    const list = live.filter((r) => bucket(r, now) === key).sort(byDue);
    if (list.length) out.push(`### ${heading} (${list.length})`, ...list.map(label), '');
  }
}

const stale = live.filter((r) => !r.due && !watchMode);
if (stale.length) out.push(`_${stale.length} undated row(s) — these are the ones that rot; offer to date or drop them._`);

console.log(out.join('\n'));