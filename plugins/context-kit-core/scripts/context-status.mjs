#!/usr/bin/env node
// What is OUTSTANDING across the context ladder: the queues that have filled up and the skill
// that drains each one.
//
//   node context-status.mjs <workspace-or-context-repo-root> [--json] [--today YYYY-MM-DD]
//   node context-status.mjs <root> --no-memory     # skip the native-memory scan (the slow part)
//
// IN A WORKSPACE (ADR 0002 — workspace.mjs's rootKind(), the same test context-doctor applies)
// the queues are counted from their new homes: unlogged thread outcomes and curation lag in
// docs/threads/ against docs/memory.md, the Notion queue in .context/pending/, and native memory
// through memory-triage.mjs, which already knows a workspace. A legacy context repo is counted
// exactly as before while the fallback lasts.
//
// WHY A SCRIPT. Every number here is a count against a threshold, and a queue whose depth is
// re-estimated in prose each time is a queue nobody trusts enough to drain. This answers all of
// them at once, in a fixed order, so that "what is outstanding" has the same meaning on Monday
// as it had on Friday.
//
// WHY IT SPAWNS memory-triage.mjs. The single-store native memory scan is already implemented,
// tested and documented with `--json`. Calling it over that interface costs a process;
// re-implementing it would create a second authority on "what is not yet promoted" that drifts
// from the first one silently — the exact failure this repo keeps legislating against.
//
// WHAT IT NEVER DOES: write. Every path is a read. It also never fetches a missing clone and
// never searches the filesystem for a repo it was not given — an absent source is reported
// absent.
//
// No queue here lives outside the root it was given. The ones that did belonged to the
// cross-project layer ADR 0002 retired, so every run can see every queue it reports, and an
// empty punchline is an all-clear it has standing to give.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve, basename } from 'node:path';
import { rootKind } from './workspace.mjs';

const OPTIONS = ['json', 'today', 'no-memory'];
const HERE = dirname(fileURLToPath(import.meta.url));

const die = (m) => { console.error(`context-status.mjs: ${m}`); process.exit(2); };

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flags = new Set();
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--today') opts[a.slice(2)] = argv[++i];
  else if (a.startsWith('--')) flags.add(a.slice(2));
  else positional.push(a);
}
for (const f of flags) if (!OPTIONS.includes(f)) die(`unknown option --${f}`);

const today = opts.today ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) die(`--today needs YYYY-MM-DD, got ${opts.today}`);

const start = resolve(positional[0] ?? '.');
if (!existsSync(start)) die(`no such directory: ${start}`);
const where = rootKind(start);
const WS = where?.kind === 'workspace';
const root = where?.root ?? start;

// ---------------------------------------------------------------- small helpers

const readJson = (file) => {
  const raw = readFileSync(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
};

// Same UTC calendar arithmetic as dates.mjs `age`: whole days elapsed, no timezone drift.
const ageDays = (iso) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso ?? '')) return null;
  return Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${iso}T00:00:00Z`)) / 86400000);
};

const frontMatter = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1] : '';
};

const fmValue = (fm, key) => {
  const m = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(fm);
  return m ? m[1].trim() : null;
};

// Markdown files whose *content* is the point. README and INDEX describe the folder rather
// than being an item in it, and counting them turns an empty queue into a queue of two.
const itemsIn = (dir) => {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'INDEX.md')
      .sort();
  } catch { return []; }
};

const fileDate = (name) => {
  const m = /^(\d{4}-\d{2}-\d{2})-/.exec(name);
  return m ? m[1] : null;
};

// The stamp this reads is written BY HAND (or by a skill writing prose), so it is matched
// permissively: any line mentioning the word, carrying an ISO date. A strict pattern would
// report "never reviewed" for a file that says so in a slightly different shape, and a false
// "never" here sends someone to redo work that was already done.
const stampedDate = (file, word) => {
  if (!existsSync(file)) return null;
  const head = readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 30);
  for (const line of head) {
    if (!new RegExp(word, 'i').test(line)) continue;
    const d = /(\d{4}-\d{2}-\d{2})/.exec(line);
    if (d) return d[1];
  }
  return null;
};

// Run a sibling script and take its --json output. A sibling that fails is reported as
// unavailable with its own stderr attached: a status report that dies because one of its
// queues could not be counted is worse than one that says which queue it could not count.
const sibling = (script, args) => {
  try {
    const stdout = execFileSync(process.execPath, [join(HERE, script), ...args, '--json'], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, data: JSON.parse(stdout) };
  } catch (e) {
    const why = (e.stderr || e.message || '').toString().trim().split('\n')[0];
    return { ok: false, why: why || 'failed' };
  }
};

// ---------------------------------------------------------------- the repo

// A malformed workspace.json is fatal, as in memory-triage.mjs: counting the queues of a
// workspace no route is using would report on a home the session is not in. context-doctor is
// where it is diagnosed.
let ctx;
if (WS) {
  if (where.error) die(`${where.file} is malformed — ${where.error} (context-doctor reports it)`);
  ctx = where.config;
} else {
  const cfgFile = join(root, 'context.json');
  if (!existsSync(cfgFile)) die(`no context.json at ${root} — not a context repo, and no .claude/workspace.json above it`);
  try { ctx = readJson(cfgFile); } catch (e) { die(`context.json is not valid JSON (${e.message})`); }
}

const repoName = (WS ? ctx.repo ?? ctx.name : ctx.contextRepo) ?? basename(root);

const actions = [];   // the punchline: what to run, in the order it makes sense to run it

// ---------------------------------------------------------------- 1. threads awaiting curation

// ADR 0002's layout in a workspace. No archive is defined there yet (curate-context has not
// moved), so none is counted rather than one guessed at.
const THREADS_REL = WS ? 'docs/threads' : 'threads';
const threadsDir = join(root, THREADS_REL);
const allThreads = itemsIn(threadsDir);
const reviewed = stampedDate(join(root, WS ? 'docs/memory.md' : 'memory.md'), 'last reviewed');
const since = reviewed ? allThreads.filter((f) => (fileDate(f) ?? '9999-99-99') > reviewed) : allThreads;

const indexFile = join(threadsDir, 'INDEX.md');
const indexed = existsSync(indexFile)
  ? (readFileSync(indexFile, 'utf8').match(/^\s*[-*]?\s*`?\d{4}-\d{2}-\d{2}/gm) ?? []).length
  : null;
const archived = WS ? 0 : itemsIn(join(root, 'Archive', 'threads')).length;

const threads = {
  total: allThreads.length,
  archived,
  lastReviewed: reviewed,
  reviewedAge: ageDays(reviewed),
  sinceReview: since.length,
  index: existsSync(indexFile)
    // A count, not a diff: INDEX.md is prose with a line per thread, and the useful signal is
    // "fewer lines than there are threads", which means a rebuild was skipped.
    ? { present: true, entries: indexed, covers: allThreads.length + archived, behind: indexed < allThreads.length + archived }
    : { present: false, entries: null, covers: allThreads.length + archived, behind: allThreads.length > 0 },
};

if (threads.index.behind) actions.push(`/curate-context  (${THREADS_REL}/INDEX.md lists ${threads.index.entries ?? 0} of ${threads.index.covers} threads)`);
else if (threads.sinceReview >= 5) actions.push(`/curate-context  (${threads.sinceReview} threads since the last review${reviewed ? ` on ${reviewed}` : ''})`);

// ---------------------------------------------------------------- 2. outcomes that never landed

// A thread reaches a decision, names an action or leaves a question open, and that outcome is
// supposed to end up somewhere structured — a decision log, an issue tracker — because a
// decision only findable by rereading the thread that produced it is a decision nobody will
// find. `save-thread` REMINDS the author to do that and deliberately does not do it itself, so
// the reminder is exactly as reliable as the person reading it. Nothing counted whether it was
// ever acted on, which made this the one queue in the ladder with no depth gauge at all.
//
// WHAT COUNTS AS LANDED is the front-matter link key, and the absent-versus-empty distinction
// drawn everywhere else in this plugin is the whole mechanism:
//   absent          — never reconciled. Reported.
//   `notion_ids: []` — reconciled, and there was nothing to log. Clear.
//   non-empty       — the outcome landed and here is where. Clear.
// So the queue drains to zero by doing the work OR by recording that there was none, both of
// them one line in the file. A queue that can only be drained by the first is a queue that
// never reaches zero, and a number that cannot reach zero stops being read.
//
// TWO KEYS, because outcomes have two destinations and core is not entitled to know which one
// this project uses: `notion_ids` for the decision-log route, `issue_ids` for the tracker
// route. Either satisfies the check. Naming both here rather than reading the backend config
// keeps this a generic scan — context-notion owns what a Notion id *means*, this owns only
// whether the author answered the question.
//
// HEADINGS, NOT PROSE. Whether a thread carries an outcome is judged from its section headings
// alone. Reading the body for decision-shaped sentences would be a second, fuzzier authority on
// what a decision is, disagreeing with the author's own structure. The house template already
// names these sections, so a thread that has one meant it.
//
// ACTIVE THREADS ONLY. An archived thread's outcomes were curate-context's business at the
// moment it was archived, and nobody is going to reopen a settled thread to log a decision from
// it. Counting them would put a floor under the number that no amount of work could lift.
const OUTCOME_HEADING =
  /^#{2,6}\s*(decisions?|actions?|action items?|follow[-\s]?ups?|next steps?|open questions?)\b/i;
const LINK_KEYS = ['notion_ids', 'issue_ids'];

const reconcile = { total: allThreads.length, unlinked: [], carrying: 0 };
for (const f of allThreads) {
  const text = readFileSync(join(threadsDir, f), 'utf8');
  const fm = frontMatter(text);
  // Any of the keys PRESENT — at any value, including empty — is an answer. Only silence counts.
  if (LINK_KEYS.some((k) => fmValue(fm, k) !== null)) continue;
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const sections = [...new Set(
    body.split(/\r?\n/).map((l) => OUTCOME_HEADING.exec(l)?.[1].toLowerCase()).filter(Boolean),
  )];
  reconcile.unlinked.push({
    file: f,
    date: fmValue(fm, 'date') ?? fileDate(f),
    title: fmValue(fm, 'title') ?? f.replace(/\.md$/, ''),
    sections,
  });
  if (sections.length) reconcile.carrying += 1;
}
// Carrying an outcome first, then oldest first: the top of the list is the thread that has been
// waiting longest with something in it actually worth logging.
reconcile.unlinked.sort((a, b) =>
  (b.sections.length ? 1 : 0) - (a.sections.length ? 1 : 0)
  || String(a.date ?? '9999').localeCompare(String(b.date ?? '9999')));

// Only the carrying ones raise an action. A thread with no outcome section and no link key has
// nothing to reconcile yet, and telling someone to go and confirm that would be manufacturing
// work rather than reporting it.
if (reconcile.carrying > 0) {
  actions.push(`${reconcile.carrying} thread(s) carry decisions/actions with no outcome link`
    + ` — log them (/log-decision, /add-action if this project uses Notion), or record \`notion_ids: []\``);
}

// ---------------------------------------------------------------- 3. pending, and native memory

// pending/ belongs to whichever backend layer is installed — context-notion owns its format.
// Counting files needs none of that, and a queue nobody counts is a queue nobody drains, so
// the count is reported and the parsing is left to the layer entitled to do it.
const PENDING_REL = WS ? '.context/pending' : 'pending';
const pendingDir = join(root, PENDING_REL);
const pending = { present: existsSync(pendingDir), count: itemsIn(pendingDir).length };
if (pending.count > 0) actions.push(`drain the ${PENDING_REL}/ queue (${pending.count} item(s)) — /process-pending if this project uses Notion`);

let memory = { available: false, why: 'skipped (--no-memory)' };
if (!flags.has('no-memory')) {
  const r = sibling('memory-triage.mjs', ['scan', root]);
  if (!r.ok) memory = { available: false, why: r.why };
  else {
    const byType = {};
    for (const c of r.data.candidates) byType[c.type ?? 'untyped'] = (byType[c.type ?? 'untyped'] ?? 0) + 1;
    memory = { available: true, mode: r.data.mode, stores: r.data.storesRead, candidates: r.data.candidates.length, byType };
    if (memory.candidates > 0) actions.push(`/memory-triage  (${memory.candidates} native memory entr(ies) not yet promoted)`);
  }
}

// ---------------------------------------------------------------- output

const data = {
  root, repo: repoName, today,
  kind: WS ? 'workspace' : 'project context repo',
  layout: { threads: THREADS_REL, pending: PENDING_REL },
  queues: { threads, reconcile, pending, memory },
  actions,
};

if (flags.has('json')) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

const L = [];
const pad = (s, n) => String(s).padEnd(n);
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const head = (title, owner) => {
  L.push('');
  L.push(`  ${title}${owner ? `${' '.repeat(Math.max(2, 58 - title.length))}${owner}` : ''}`);
};

L.push(`context-status — ${repoName}  (${today})`);
L.push(`  ${data.kind} · threads in ${THREADS_REL}/ · pending in ${PENDING_REL}/`);

head('THREADS AWAITING CURATION', '/curate-context');
L.push(`    ${threads.total} thread(s) in ${THREADS_REL}/, ${threads.archived} archived`);
L.push(`    last review: ${threads.lastReviewed ?? `never stamped in ${WS ? 'docs/memory.md' : 'memory.md'}`}${threads.reviewedAge !== null ? ` (${threads.reviewedAge}d ago)` : ''} · ${threads.sinceReview} thread(s) since`);
L.push(threads.index.present
  ? `    ${THREADS_REL}/INDEX.md lists ${threads.index.entries} of ${threads.index.covers}${threads.index.behind ? '  — BEHIND' : ''}`
  : `    ${THREADS_REL}/INDEX.md is absent`);

if (reconcile.total) {
  head('THREAD OUTCOMES NEVER LOGGED', '/log-decision · /add-action');
  L.push(`    ${reconcile.carrying} of ${reconcile.total} active thread(s) carry decisions/actions/questions`
    + ' and declare no outcome link');
  for (const t of reconcile.unlinked.filter((t) => t.sections.length)) {
    L.push(`        ${t.date ?? 'undated'}  ${pad(clip(t.title, 46), 46)} ${t.sections.join(', ')}`);
  }
  const silent = reconcile.unlinked.length - reconcile.carrying;
  // Stated rather than listed. These are threads with nothing to reconcile, and a name per line
  // would bury the ones that do under the ones that do not.
  if (silent) L.push(`    ${silent} more carry no outcome section — nothing to log`);
  if (reconcile.carrying || silent) {
    L.push('    Clear one by logging the outcome and recording where it went, or by writing');
    L.push('    `notion_ids: []` — absent means never checked, empty means checked and there was none.');
  }
}

if (pending.present) {
  head('PENDING QUEUE', '');
  L.push(`    ${pending.count} item(s) in ${PENDING_REL}/`);
}

head('NATIVE MEMORY AWAITING TRIAGE', '/memory-triage');
if (!memory.available) L.push(`    not counted — ${memory.why}`);
else {
  L.push(`    ${memory.candidates} entr(ies) not yet promoted · ${memory.stores} store(s) read`);
  L.push(`    mode: ${memory.mode}`);
  const t = Object.entries(memory.byType).map(([k, v]) => `${v} ${k}`).join(' · ');
  if (t) L.push(`    ${t}`);
}

L.push('');
if (actions.length) L.push(`  WHAT TO RUN (${actions.length}):`);
else L.push('  WHAT TO RUN: nothing — every queue is clear.');
for (const a of actions) L.push(`    - ${a}`);
L.push('');
L.push('  Nothing has been changed. This is a read.');

console.log(L.join('\n'));
