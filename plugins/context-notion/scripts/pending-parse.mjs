#!/usr/bin/env node
// Parse the project's pending inbox — `.context/pending/` in a workspace, `pending/` in a legacy
// context repo (layout.mjs decides which) — the queue where anyone without a working Notion
// connection writes actions, decisions, questions, stakeholders and projects for later transfer
// into Notion. Workspace *guests* are the usual case: the connector returns them nothing rather
// than erroring, so an empty result is never evidence of absence and they need somewhere to
// write. Which people that covers is a fact about the project, not about this plugin — the
// roster lives in the project's `state.notion.people`.
//
//   node pending-parse.mjs <root> [--type action] [--json]
//
// <root> is a workspace root or a context repo, as workspace.mjs printed it. Every `file` this
// reports is relative to it (`.context/pending/actions.md`), and --drain resolves the same form.
//
// The entry format is defined here, once, rather than described in five skill files that then
// drift. `context-notion:add-pending` writes this format; `context-notion:process-pending` reads it.
//
// The format is deliberately plain, because it has to be hand-writable in the GitHub web editor:
//
//   ## Chase the supplier for the data extract
//   - owner: sam
//   - due: 2026-08-05
//   - notes: They said the Q3 dataset lands in August.
//
// A `## ` heading starts an entry and *is* its title. `- key: value` bullets are its fields.
// Anything before the first heading is the file's own instructions and is ignored, so the
// template text at the top of each file costs nothing.
//
// Validation is deliberately split: an **error** is something that would create a broken Notion
// row (a date Notion won't accept, a select value that isn't an option). A **warning** is
// something a human should look at but that still transfers (an unrecognised field, an owner
// who isn't on the roster, a decision with no rationale). Nothing here writes or deletes.

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, readInput, today } from './lib.mjs';
import { layout } from './layout.mjs';

const args = process.argv.slice(2);
const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
// The repo root is the first bare argument — "bare" meaning it isn't a flag and isn't the value
// belonging to one, so `--type action` and `--today 2026-07-29` can't be mistaken for it.
const root = args.find((a, i) => !a.startsWith('--') && !String(args[i - 1] ?? '').startsWith('--'));
const asJson = args.includes('--json');
const typeFilter = (() => {
  const i = args.indexOf('--type');
  return i >= 0 ? args[i + 1] : undefined;
})();

if (!root) { console.error('pending-parse.mjs: needs the workspace or context repo root'); process.exit(2); }
const where = layout(root);
const dir = where.pending;
// Relative, with `/`, as it appears in messages and in the `file` of every entry.
const rel = where.rel.pending;
if (!existsSync(dir)) {
  console.error(`pending-parse.mjs: no ${rel}/ directory in ${root}`);
  process.exit(2);
}

// ------------------------------------------------------------------ the schema

const DATE = { date: true };
const sel = (...values) => ({ select: values });

// `required` is intentionally almost empty — a half-filled entry is still worth transferring,
// and rejecting it just means the note gets lost in Slack instead. `wanted` produces a warning.
const TYPES = {
  action: {
    file: 'actions.md',
    title: 'Task',
    target: 'Notion Actions',
    skill: 'add-action',
    wanted: ['owner'],
    fields: {
      owner: { person: true },
      due: DATE,
      status: sel('Not started', 'In progress', 'Done'),
      workstream: {},
      notes: {},
    },
    aliases: { assignee: 'owner', 'due-date': 'due', deadline: 'due', task: null, by: 'due' },
  },
  decision: {
    file: 'decisions.md',
    title: 'Decision',
    target: 'Notion Decision log',
    skill: 'log-decision',
    wanted: ['rationale', 'decided'],
    fields: {
      decided: DATE,
      owner: { person: true },
      rationale: {},
      revisit: {},
      notes: {},
    },
    aliases: { why: 'rationale', date: 'decided', 'decided-by': 'owner', 'revisit?': 'revisit' },
  },
  'open-question': {
    file: 'open-questions.md',
    title: 'Question',
    target: 'Notion Open questions',
    skill: 'add-open-question',
    wanted: [],
    fields: {
      type: {},
      chasing: { person: true },
      opened: DATE,
      notes: {},
    },
    aliases: { 'who-is-chasing': 'chasing', owner: 'chasing', question: null },
  },
  stakeholder: {
    file: 'stakeholders.md',
    title: 'Name',
    target: 'Notion Stakeholders & companies',
    skill: 'tidy-stakeholders',
    wanted: ['entity-type'],
    fields: {
      'entity-type': sel('Individual', 'Organisation'),
      'stakeholder-type': {},
      org: {},
      email: {},
      link: {},
      'what-they-do': {},
      'relevance-to-us': {},
      priority: sel('High', 'Medium', 'Low'),
      owner: { person: true },
      notes: {},
    },
    aliases: {
      type: 'entity-type', 'entity type': 'entity-type', organisation: 'org', company: 'org',
      url: 'link', website: 'link', 'why-we-track-them': 'relevance-to-us', relevance: 'relevance-to-us',
    },
  },
  project: {
    file: 'projects.md',
    title: 'Project name',
    target: 'Notion Related projects',
    skill: 'tidy-projects',
    wanted: ['link'],
    fields: {
      link: {},
      'funding-body': {},
      'grant-size': {},
      'area-of-relevance': {},
      description: {},
      organisations: {},
      relevance: {},
      notes: {},
    },
    aliases: {
      url: 'link', funder: 'funding-body', grant: 'grant-size', orgs: 'organisations',
      partners: 'organisations', 'organisations-involved': 'organisations',
    },
  },
};

const FILE_TO_TYPE = Object.fromEntries(
  Object.entries(TYPES).map(([type, spec]) => [spec.file, type]),
);

// ------------------------------------------------------------------ parsing

const normaliseKey = (k) => k.trim().toLowerCase()
  .replace(/\*\*/g, '')
  .replace(/\s+/g, '-')
  .replace(/^-+|-+$/g, '');

const BULLET = /^\s*[-*]\s+(?:\*\*)?([A-Za-z][A-Za-z0-9 _?-]*?)(?:\*\*)?\s*:\s*(.*)$/;
const HEADING = /^##\s+(.+?)\s*$/;

function parseFile(type, text) {
  const spec = TYPES[type];
  const lines = text.split(/\r?\n/);
  const entries = [];
  let current = null;
  let lastKey = null;
  let fenced = false;

  const push = () => { if (current) entries.push(current); current = null; lastKey = null; };

  lines.forEach((line, i) => {
    // Each file carries its own worked example, and an example is written in a code fence.
    // Without this the example's `## ` heading parses as a real entry and gets filed to Notion.
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      if (current) current.raw.push(line);
      return;
    }
    if (fenced) { if (current) current.raw.push(line); return; }

    const heading = HEADING.exec(line);
    if (heading) {
      push();
      current = {
        type, line: i + 1, title: heading[1].replace(/\*\*/g, '').trim(),
        fields: {}, prose: [], errors: [], warnings: [], raw: [line],
      };
      return;
    }
    if (!current) return; // preamble: the file's own instructions
    current.raw.push(line);

    const bullet = BULLET.exec(line);
    if (bullet) {
      const rawKey = normaliseKey(bullet[1]);
      const key = rawKey in spec.aliases ? spec.aliases[rawKey] : rawKey;
      if (key === null) { lastKey = null; return; }   // alias mapped to "this is the title"
      if (!(key in spec.fields)) {
        current.warnings.push(`unrecognised field \`${rawKey}\` — kept as a note`);
        current.prose.push(`${rawKey}: ${bullet[2].trim()}`);
        lastKey = null;
        return;
      }
      current.fields[key] = [bullet[2].trim()].filter(Boolean);
      lastKey = key;
      return;
    }
    // A wrapped bullet continues the field above it; anything else is prose.
    if (lastKey && /^\s+\S/.test(line)) {
      current.fields[lastKey].push(line.trim());
      return;
    }
    lastKey = null;
    if (line.trim()) current.prose.push(line.trim());
  });
  push();

  // Trailing blank lines belong to the gap between entries, not to the entry.
  for (const e of entries) {
    while (e.raw.length && !e.raw[e.raw.length - 1].trim()) e.raw.pop();
    e.endLine = e.line + e.raw.length - 1;   // 1-based, inclusive — what --drain removes
    e.raw = e.raw.join('\n');
  }
  return entries;
}

// ------------------------------------------------------------------ validation

const roster = config.people;
const resolvePerson = (value) => {
  const want = value.trim().toLowerCase();
  return roster.find((p) => p.name.toLowerCase() === want)
    ?? roster.find((p) => p.name.toLowerCase().startsWith(want))
    ?? null;
};

function validate(entry) {
  const spec = TYPES[entry.type];

  if (!entry.title) entry.errors.push('entry has no title (the `## ` heading is empty)');
  if (/^</.test(entry.title) || /^\[.*\]$/.test(entry.title) || /^example\b/i.test(entry.title)) {
    entry.warnings.push('title looks like the template placeholder — is this a real entry?');
  }

  const flat = {};
  for (const [key, parts] of Object.entries(entry.fields)) {
    const value = parts.join(' ').trim();
    if (!value) continue;
    const rule = spec.fields[key];

    if (rule.date && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      entry.errors.push(`\`${key}: ${value}\` is not a date Notion will take — use YYYY-MM-DD`);
      continue;
    }
    if (rule.select) {
      const match = rule.select.find((v) => v.toLowerCase() === value.toLowerCase());
      if (!match) {
        entry.errors.push(`\`${key}: ${value}\` is not one of ${rule.select.map((v) => `\`${v}\``).join(' / ')}`);
        continue;
      }
      flat[key] = match;
      continue;
    }
    if (rule.person) {
      const people = value.split(/\s*[,/&]\s*|\s+and\s+/).filter(Boolean);
      const resolved = [];
      for (const name of people) {
        const hit = resolvePerson(name);
        if (!hit) {
          entry.warnings.push(`\`${key}: ${name}\` is not on the roster — the person field will be left empty`);
        } else if (!hit.notionUserId) {
          // On the roster but we don't hold their Notion ID. Saying so beats both guessing and
          // silently dropping them — the fix is one line in the project's config (state.notion.people).
          entry.warnings.push(`\`${key}: ${name}\` has no Notion user ID in ${where.rel.config}'s state.notion.people `
            + '— the person field will be left empty until someone fills it in');
        } else {
          resolved.push({ name: hit.name, notionUserId: hit.notionUserId });
        }
      }
      flat[key] = value;
      if (resolved.length) entry[`${key}Resolved`] = resolved;
      continue;
    }
    flat[key] = value;
  }

  if (entry.prose.length) flat.notes = [flat.notes, entry.prose.join(' ')].filter(Boolean).join(' ');
  entry.fields = flat;
  delete entry.prose;

  for (const key of spec.wanted) {
    if (!flat[key]) entry.warnings.push(`no \`${key}\` — worth filling in before this goes to Notion`);
  }
  return entry;
}

// ------------------------------------------------------------------ run

const entries = [];
const filesRead = [];
for (const file of readdirSync(dir).sort()) {
  const type = FILE_TO_TYPE[file];
  if (!type) continue;                       // README.md, done/, anything else
  if (typeFilter && type !== typeFilter) continue;
  filesRead.push(file);
  for (const entry of parseFile(type, readFileSync(join(dir, file), 'utf8'))) {
    entries.push(validate({ ...entry, file: `${rel}/${file}` }));
  }
}

const counts = {};
for (const e of entries) counts[e.type] = (counts[e.type] ?? 0) + 1;
const errored = entries.filter((e) => e.errors.length);

// ------------------------------------------------------------------ drain
// Cutting transferred entries out of the inbox and filing them under done/ is done here rather
// than by rewriting the markdown from the model: the risk being guarded against is an
// *untransferred* entry disappearing in the rewrite, which nobody would notice until the thing
// it asked for didn't happen.
//
//   node pending-parse.mjs <root> --drain results.json [--today YYYY-MM-DD]
//
// results.json is [{file, line, notionUrl}] — file and line as reported by this same script in
// the run that fed the transfer. A line that no longer holds that entry aborts the whole drain:
// it means the file changed underneath, and half a drain is worse than none.
if (args.includes('--drain')) {
  const results = readInput(args[args.indexOf('--drain') + 1]);
  const stamp = args.includes('--today') ? args[args.indexOf('--today') + 1] : today();
  const byFile = new Map();

  for (const r of list(results)) {
    const hit = entries.find((e) => e.file === r.file && e.line === Number(r.line));
    if (!hit) {
      console.error(`pending-parse.mjs: no entry at ${r.file}:${r.line} — the pending files have `
        + 'changed since they were parsed. Nothing drained; re-parse and try again.');
      process.exit(1);
    }
    if (!byFile.has(hit.file)) byFile.set(hit.file, []);
    byFile.get(hit.file).push({ ...hit, notionUrl: r.notionUrl });
  }

  const doneFile = join(where.done, `${stamp}-processed.md`);
  const doneBlocks = [];
  const report = [];

  for (const [file, hits] of byFile) {
    const path = join(root, file);
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    // Descending, so removing one entry doesn't shift the line numbers of the next.
    for (const hit of [...hits].sort((a, b) => b.line - a.line)) {
      lines.splice(hit.line - 1, hit.endLine - hit.line + 1);
    }
    const text = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
    writeFileSync(path, text, 'utf8');
    report.push(`- \`${file}\` — ${hits.length} entr${hits.length === 1 ? 'y' : 'ies'} removed`);
    for (const hit of hits.sort((a, b) => a.line - b.line)) {
      doneBlocks.push(`${hit.raw}\n- processed: ${stamp}${hit.notionUrl ? `\n- notion: ${hit.notionUrl}` : ''}\n`);
    }
  }

  if (doneBlocks.length) {
    mkdirSync(where.done, { recursive: true });
    const head = existsSync(doneFile) ? readFileSync(doneFile, 'utf8').trimEnd() + '\n\n' : [
      `# Transferred to Notion — ${stamp}`,
      '',
      'Entries kept verbatim as they were written, with the Notion page each became. Audit trail',
      'only; see `../README.md`. Nothing reads this file.',
      '',
      '',
    ].join('\n');
    writeFileSync(doneFile, head + doneBlocks.join('\n'), 'utf8');
  }

  console.log([
    `**Drained** · ${list(results).length} entr${list(results).length === 1 ? 'y' : 'ies'} → `
    + `\`${where.rel.done}/${stamp}-processed.md\``,
    '',
    ...report,
    '',
    `${entries.length - list(results).length} entr${entries.length - list(results).length === 1 ? 'y' : 'ies'} left in the queue.`,
  ].join('\n'));
  process.exit(0);
}

if (asJson) {
  console.log(JSON.stringify({ root, files: filesRead, counts, entries }, null, 2));
  process.exit(0);
}

// ------------------------------------------------------------------ slack notification
// Renders the "there is stuff waiting for you" message for whoever drains the queue. Here rather
// than composed per-run so that two notifications about the same queue read the same, and so the
// 5000-character limit on a Slack text element can't be walked into with a long queue.
//
//   node pending-parse.mjs <root> --slack [--added-by <name>]
//
// Prints the message and nothing else, ready to hand to slack_send_message. Standard Markdown,
// which is what that tool expects — not Slack mrkdwn.
if (args.includes('--slack')) {
  const addedBy = args[args.indexOf('--added-by') + 1];
  const by = addedBy && !addedBy.startsWith('--') ? addedBy : null;

  if (!entries.length) {
    console.log(`The \`${rel}/\` queue is empty — nothing waiting for Notion.`);
    process.exit(0);
  }

  const LABEL = {
    action: 'Actions', decision: 'Decisions', 'open-question': 'Open questions',
    stakeholder: 'Stakeholders', project: 'Projects',
  };
  const MAX_PER_TYPE = 12;   // a long queue is a summary, not a transcript
  const detail = (e) => {
    const bits = [
      e.fields.owner ?? e.fields.chasing,
      e.fields.due ? `due ${e.fields.due}` : null,
      e.fields['entity-type'],
      e.fields['funding-body'],
    ].filter(Boolean);
    return bits.length ? ` — ${bits.join(' · ')}` : '';
  };

  const out = [
    `**${entries.length} item${entries.length === 1 ? '' : 's'} queued for Notion**`
    + `${by ? ` — latest added by ${by}` : ''}`,
    '',
  ];
  for (const [type, n] of Object.entries(counts).sort()) {
    const of = entries.filter((e) => e.type === type);
    out.push(`**${LABEL[type] ?? type} (${n})**`);
    for (const e of of.slice(0, MAX_PER_TYPE)) out.push(`- ${e.title}${detail(e)}`);
    if (of.length > MAX_PER_TYPE) out.push(`- …and ${of.length - MAX_PER_TYPE} more`);
    out.push('');
  }
  if (errored.length) {
    out.push(`⚠️ ${errored.length} entr${errored.length === 1 ? 'y' : 'ies'} won't transfer as `
      + `written (${errored.map((e) => `\`${e.file.slice(rel.length + 1)}:${e.line}\``).join(', ')}) `
      + '— a date or a status Notion won\'t take.', '');
  }
  out.push(`In ${where.kind === 'workspace' ? 'the workspace' : 'the context repo'} → \`${rel}/\`. `
    + 'Run `context-notion:process-pending` to transfer them.');

  const text = out.join('\n');
  // 5000 is the per-element limit; the cap above makes this essentially unreachable, but a
  // silently truncated message would be worse than a blunt one.
  console.log(text.length > 4900 ? `${text.slice(0, 4700)}\n\n…truncated. See \`${rel}/\`.` : text);
  process.exit(0);
}

const out = [
  `**Pending queue** · ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} in `
  + `${filesRead.length} file(s)${errored.length ? ` · ${errored.length} with errors` : ''}`,
  '',
];
if (!entries.length) {
  out.push('Nothing waiting. (Entries live under `## ` headings; text above the first heading is ignored.)');
} else {
  for (const [type, n] of Object.entries(counts).sort()) {
    out.push(`### ${type} × ${n} → ${TYPES[type].target}`, '');
    for (const e of entries.filter((x) => x.type === type)) {
      const fields = Object.entries(e.fields).map(([k, v]) => `${k}: ${v}`).join(' · ');
      out.push(`- **${e.title || '(no title)'}** — ${e.file}:${e.line}`);
      if (fields) out.push(`  - ${fields}`);
      for (const err of e.errors) out.push(`  - ❌ ${err}`);
      for (const w of e.warnings) out.push(`  - ⚠️ ${w}`);
    }
    out.push('');
  }
}
console.log(out.join('\n').trimEnd());
