#!/usr/bin/env node
// Build the "who's got what" Slack digest from three Notion query result sets.
// Grouping, due-date bucketing, @mention rendering and the 5000-char split are all
// fixed rules — they live here so they come out identical every week.
//
//   node person-digest.mjs data.json            # -> message text, split by ---MESSAGE---
//   node person-digest.mjs data.json --json     # -> JSON array of message strings
//   node person-digest.mjs data.json --today 2026-07-27
//   node person-digest.mjs data.json --title "Project"   # names the project in the header
//
// Input JSON:
// {
//   "actions":      [{ "url","task","status","owner":["user://<uuid>"],"due":"YYYY-MM-DD" }],
//   "questions":    [{ "url","question","status","chasing":["user://<uuid>"] }],
//   "stakeholders": [{ "url","name","owner":["user://<uuid>"],"nextAction","stage","lastContacted" }]
// }

import { bucket, byDue, config, mention, person, pretty, readInput, today } from './lib.mjs';
import { SHARED } from './slack-sections.mjs';

const LIMIT = 5000;
const argv = process.argv.slice(2);
const opts = {};
const flags = new Set();
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--today') opts.today = argv[++i];
  else if (argv[i] === '--title') opts.title = argv[++i];
  else if (argv[i].startsWith('--')) flags.add(argv[i].slice(2));
  else positional.push(argv[i]);
}
const now = opts.today ?? today();
const data = readInput(positional[0]);

const UNASSIGNED = '__unassigned__';
const groups = new Map();
const slot = (id) => {
  const key = id ? person(id).notionUserId : UNASSIGNED;
  if (!groups.has(key)) groups.set(key, { overdue: [], open: [], watching: [], questions: [], relationships: [] });
  return groups.get(key);
};
const fan = (owners, fn) => (owners?.length ? owners : [null]).forEach((o) => fn(slot(o)));

for (const a of data.actions ?? []) {
  if (a.status === 'Done') continue;
  const b = bucket(a, now);
  const key = b === 'watching' || b === 'checkDue' ? 'watching' : (b === 'overdue' || b === 'soon' ? 'overdue' : 'open');
  fan(a.owner, (g) => g[key].push({ ...a, _bucket: b }));
}
for (const q of data.questions ?? []) {
  if (q.status === 'Closed') continue;
  fan(q.chasing, (g) => g.questions.push(q));
}
for (const s of data.stakeholders ?? []) {
  if (!s.nextAction) continue;
  fan(s.owner, (g) => g.relationships.push(s));
}

const link = (t, u) => (u ? `[${t}](${u})` : t);
// Headings come from slack-sections.mjs so the roundup and this digest cannot drift apart.
const SECTIONS = [
  ['overdue', SHARED.overdue, (r) => `- ⏰ ${link(r.task, r.url)} — due ${pretty(r.due)}`],
  ['open', SHARED.open, (r) => `- ${link(r.task, r.url)} — ${pretty(r.due)}`],
  ['watching', SHARED.watching,
    (r) => `- ${link(r.task, r.url)} — next check ${pretty(r.due)}${r._bucket === 'checkDue' ? ' **· due to check**' : ''}`],
  ['questions', SHARED.questions, (r) => `- ${link(r.question, r.url)}`],
  ['relationships', SHARED.relationships,
    (r) => `- ${link(r.name, r.url)} — ${r.nextAction}${r.stage ? ` (${r.stage}` : ''}${r.stage && r.lastContacted ? `, last contacted ${pretty(r.lastContacted)}` : ''}${r.stage ? ')' : ''}`],
];

const order = [...config.people.map((p) => p.notionUserId), ...[...groups.keys()]];
const seen = new Set();
const blocks = [];
for (const key of order) {
  if (seen.has(key) || key === UNASSIGNED || !groups.has(key)) continue;
  seen.add(key);
  const g = groups.get(key);
  const lines = [];
  for (const [bucketKey, heading, render] of SECTIONS) {
    const list = g[bucketKey].sort(byDue);
    if (list.length) lines.push(`_${heading}_`, ...list.map(render));
  }
  if (lines.length) blocks.push([`${mention(person(key))}`, ...lines].join('\n'));
}
if (groups.has(UNASSIGNED)) {
  const g = groups.get(UNASSIGNED);
  const lines = SECTIONS.flatMap(([k, h, render]) =>
    g[k].length ? [`_${h}_`, ...g[k].sort(byDue).map(render)] : []);
  if (lines.length) blocks.push(['**Unassigned**', ...lines].join('\n'));
}

// The project's name is the caller's to supply (it lives in workspace.json, which this script
// doesn't read) — without it the digest still reads correctly, just unbranded.
const header = `**${opts.title ? `${opts.title} — who's` : "Who's"} got what** · ${pretty(now)}`;
const messages = [];
let current = header;
for (const b of blocks) {
  if (`${current}\n\n${b}`.length > LIMIT) { messages.push(current); current = b; }
  else current += `\n\n${b}`;
}
messages.push(current);

if (blocks.length === 0) console.error('person-digest: nothing to report — every bucket was empty.');
console.log(flags.has('json') ? JSON.stringify(messages, null, 2) : messages.join('\n\n---MESSAGE---\n\n'));