#!/usr/bin/env node
// What is OUTSTANDING across the context ladder: the queues that have filled up and the skill
// that drains each one.
//
//   node context-status.mjs <workspace-or-context-repo-root> [--role name] [--json] [--today YYYY-MM-DD]
//   node context-status.mjs <root> --no-memory     # skip the native-memory scan (the slow part)
//
// IN A WORKSPACE (ADR 0002 — workspace.mjs's rootKind(), the same test context-doctor applies)
// the queues that survive are counted from their new homes: unlogged thread outcomes and
// curation lag in docs/threads/ against docs/memory.md, the Notion queue in .context/pending/,
// and native memory through memory-triage.mjs, which already knows a workspace. The queues that
// belonged to retired machinery — lessons, sweeps, doctrine, handoff/ — are not applicable there
// rather than empty, and --role is refused: a workspace declares no roles. A legacy context repo
// is counted exactly as before while the fallback lasts.
//
// WHY A SCRIPT. Every number here is a count against a threshold, and a queue whose depth is
// re-estimated in prose each time is a queue nobody trusts enough to drain. `unswept` already
// answers one of these questions; this answers all of them at once, in a fixed order, so that
// "what is outstanding" has the same meaning on Monday as it had on Friday.
//
// WHY IT SPAWNS ITS SIBLINGS. Lesson ids, the consumption ledger and the asymmetric native
// memory scan are already implemented, tested by use, and documented with `--json`. Calling
// them over that interface costs a few processes; re-implementing them would create a second
// authority on "which lessons are new" that drifts from the first one silently — the exact
// failure this repo keeps legislating against. Anything genuinely new (handoff parsing,
// distillation stamps, curation lag) is implemented here and nowhere else.
//
// WHAT IT NEVER DOES: write. Every path is a read, like assistants.mjs. It also never fetches
// a missing clone and never searches the filesystem for a repo it was not given — an absent
// source is reported absent.
//
// THE ASYMMETRY THAT CANNOT BE FIXED HERE. A project repo cannot see the handoff items
// addressed to it: they live in the cross-project layer, and nothing in a project's config
// points upward. Scanning the disk for a second brain would be exactly the discovery-by-
// filesystem this system forbids everywhere else. So a project run reports what it can see and
// names what it cannot, rather than implying its queue is empty.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve, basename } from 'node:path';
import { rootKind } from './workspace.mjs';

const OPTIONS = ['json', 'role', 'today', 'no-memory'];
const HERE = dirname(fileURLToPath(import.meta.url));

const die = (m) => { console.error(`context-status.mjs: ${m}`); process.exit(2); };

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flags = new Set();
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--role' || a === '--today') opts[a.slice(2)] = argv[++i];
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

// The stamps this reads are written BY HAND (or by a skill writing prose), so they are matched
// permissively: any line mentioning the word, carrying an ISO date. A strict pattern would
// report "never distilled" for a file that says so in a slightly different shape, and a false
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
// unavailable with its own stderr attached: a status report that dies because one of six
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

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// Retired keys are not read from a workspace even if one still carries them: nothing there acts
// on them, so a queue counted from them would be a queue nothing can drain.
const assistants = WS ? {} : obj(ctx.assistants);
const supervisors = WS ? {} : obj(ctx.supervisors);
const includes = WS ? [] : (Array.isArray(ctx.include) ? ctx.include : []).filter((v) => typeof v === 'string');

// `supervisors` is what makes a repo the layer that distils — the same test supervisor-sweep
// applies before it will run at all. Not `include`, which says only which repos may be READ.
const sweeps = Object.keys(supervisors).length > 0;
const repoName = (WS ? ctx.repo ?? ctx.name : ctx.contextRepo) ?? basename(root);

const wantRole = opts.role ? String(opts.role).trim().toLowerCase() : null;
const roleList = (names) => (wantRole ? names.filter((r) => r === wantRole) : names);
if (wantRole && WS) die('--role does not apply in a workspace — roles and assistants are retired there (ADR 0002)');
if (wantRole && ![...Object.keys(supervisors), ...Object.keys(assistants)].includes(wantRole)) {
  die(`role "${wantRole}" is not declared in ${repoName} (assistants: ${Object.keys(assistants).join(', ') || 'none'})`);
}

const actions = [];   // the punchline: what to run, in the order it makes sense to run it

// One `unswept` run per role, reused by the lesson counts and by the doctrine table below.
// Both need the same source list, and spawning twice for it would let the two halves of one
// report disagree if a file changed between them.
const unsweptCache = new Map();
const unsweptFor = (role) => {
  if (!unsweptCache.has(role)) unsweptCache.set(role, sibling('assistants.mjs', ['unswept', root, '--role', role]));
  return unsweptCache.get(role);
};

// ---------------------------------------------------------------- 1. lessons awaiting a sweep

const lessons = { applicable: sweeps, roles: [], total: 0 };

if (sweeps) {
  for (const role of roleList(Object.keys(supervisors))) {
    const r = unsweptFor(role);
    if (!r.ok) { lessons.roles.push({ role, error: r.why }); continue; }

    // Threshold precedence, and it is deliberate: an explicit value in context.json wins
    // outright over the tuned one, because a human who pins a number has overruled the tuner.
    const pinned = supervisors[role]?.threshold;
    const supMemory = join(root, 'supervisors', role, 'memory.md');
    const tunedRaw = existsSync(supMemory)
      ? fmValue(frontMatter(readFileSync(supMemory, 'utf8')), 'threshold')
      : null;
    const tuned = tunedRaw !== null && /^\d+$/.test(tunedRaw) ? Number(tunedRaw) : null;
    const threshold = Number.isInteger(pinned) ? pinned : tuned;
    const from = Number.isInteger(pinned) ? 'context.json' : (tuned !== null ? 'tuned' : null);

    const n = r.data.unswept;
    // No threshold yet means no supervisor memory yet, i.e. nothing has ever been distilled
    // for this role. Inventing a number here would make the script a second authority on a
    // value the sweep skill owns — so the verdict says "first sweep" and leaves the bar to it.
    let verdict;
    if (n === 0) verdict = 'clear';
    else if (threshold === null) verdict = 'ready — first sweep';
    else if (n >= threshold) verdict = 'ready';
    else verdict = `holding (${n} of ${threshold})`;

    const row = {
      role,
      unswept: n,
      cited: r.data.cited,
      threshold,
      thresholdFrom: from,
      verdict,
      sources: r.data.sources.map((s) => ({
        repo: s.repo, self: Boolean(s.self), available: s.available,
        count: s.available ? s.entries.length : null, root: s.root,
      })),
    };
    lessons.roles.push(row);
    lessons.total += n;
    if (verdict.startsWith('ready')) {
      actions.push(`/supervisor-sweep --role ${role}  (${n} unswept${threshold !== null ? `, threshold ${threshold}` : ', no threshold set yet'})`);
    }
  }
}

// ---------------------------------------------------------------- 1b. this repo's own slices

// What THIS repo holds, per declared role. In the cross-project layer it is a footnote; in a
// project repo it is the whole assistant picture, because that is the side of Fig. 2 a project
// can actually see: its own four files, and whether doctrine ever arrived.
const slices = { roles: [] };

for (const role of roleList(Object.keys(assistants))) {
  const dir = join(root, 'assistants', role);
  const has = (f) => existsSync(join(dir, f));
  const r = sibling('assistants.mjs', ['lessons', root, '--role', role]);
  const stamp = stampedDate(join(dir, 'DOCTRINE.md'), 'distilled');
  slices.roles.push({
    role,
    files: {
      persona: has('PERSONA.md'), memory: has('memory.md'),
      lessons: has('LESSONS.md'), doctrine: has('DOCTRINE.md'),
    },
    lessons: r.ok ? r.data.count : null,
    doctrineStamp: stamp,
    doctrineAge: ageDays(stamp),
  });
}

// A declared role with no PERSONA.md is a memory slice with no personality, and the user
// should know that is what they are talking to — the same thing `/assistant` refuses to pass
// over in silence.
for (const s of slices.roles.filter((s) => !s.files.persona)) {
  actions.push(`assistants/${s.role}/PERSONA.md is missing — /assistant ${s.role} can scaffold it`);
}

// ---------------------------------------------------------------- 2. sweeps awaiting distillation

// A supervisor thread that postdates the doctrine is work done and not yet promoted. The
// comparison is by DATE rather than by a consumed-style ledger because distillation has no
// per-thread id — supervisor-distil stamps the doctrine once, for the whole pass.
const sweptThreads = { applicable: sweeps, roles: [] };

if (sweeps) {
  const threadDirs = [
    { label: 'threads', dir: join(root, 'threads') },
    { label: 'Archive/threads', dir: join(root, 'Archive', 'threads') },
  ];
  for (const role of roleList(Object.keys(supervisors))) {
    const distilled = stampedDate(join(root, 'supervisors', role, 'memory.md'), 'distilled');
    const pending = [];
    for (const { label, dir } of threadDirs) {
      for (const f of itemsIn(dir)) {
        const fm = frontMatter(readFileSync(join(dir, f), 'utf8'));
        if (!fm || fmValue(fm, 'supervisor') !== role) continue;
        const d = fmValue(fm, 'date') ?? fileDate(f);
        if (distilled && d && d <= distilled) continue;
        pending.push({ file: `${label}/${f}`, date: d });
      }
    }
    const row = { role, distilled, pending };
    sweptThreads.roles.push(row);
    if (pending.length) {
      actions.push(`/supervisor-distil --role ${role}  (${pending.length} swept thread(s) not yet in doctrine)`);
    }
  }
}

// ---------------------------------------------------------------- 3. handoff awaiting a drain

const handoff = { applicable: !WS && existsSync(join(root, 'handoff')), items: [], byProject: [] };

if (handoff.applicable) {
  for (const f of itemsIn(join(root, 'handoff'))) {
    const fm = frontMatter(readFileSync(join(root, 'handoff', f), 'utf8'));
    const date = fmValue(fm, 'date') ?? fileDate(f);
    handoff.items.push({
      file: f,
      project: fmValue(fm, 'project') ?? '(no project in front-matter)',
      kind: fmValue(fm, 'kind') ?? '(no kind)',
      title: fmValue(fm, 'title') ?? f.replace(/\.md$/, ''),
      date, age: ageDays(date),
    });
  }
  const by = new Map();
  for (const it of handoff.items) {
    const g = by.get(it.project) ?? { project: it.project, count: 0, oldest: null, oldestAge: null };
    g.count += 1;
    if (it.date && (g.oldest === null || it.date < g.oldest)) { g.oldest = it.date; g.oldestAge = it.age; }
    by.set(it.project, g);
  }
  handoff.byProject = [...by.values()].sort((a, b) => b.count - a.count);
  for (const g of handoff.byProject) {
    actions.push(`open a session in ${g.project} and drain ${g.count} handoff item(s)${g.oldestAge !== null ? ` (oldest ${g.oldestAge}d)` : ''}`);
  }
}

// ---------------------------------------------------------------- 4. doctrine freshness

// Doctrine is a copy, so the question is only ever "is the copy behind the original". Absent is
// reported separately from stale: a project that has never received doctrine is a delivery that
// never happened, whereas a stale one is a delivery that happened and has been overtaken.
const doctrine = { applicable: sweeps, rows: [] };

if (sweeps) {
  for (const role of roleList(Object.keys(supervisors))) {
    const source = stampedDate(join(root, 'supervisors', role, 'memory.md'), 'distilled');
    // Every repo a sweep reads is a repo that may hold this role — reuse the source list the
    // ledger itself uses rather than deriving a second one from `include`.
    const r = unsweptFor(role);
    const sources = r.ok ? r.data.sources : [];
    for (const s of sources) {
      if (!s.available) { doctrine.rows.push({ role, repo: s.repo, state: 'clone absent', stamp: null, source }); continue; }
      const file = join(s.root, 'assistants', role, 'DOCTRINE.md');
      if (!existsSync(join(s.root, 'assistants', role))) continue;   // role not present in that repo
      if (!existsSync(file)) { doctrine.rows.push({ role, repo: s.repo, state: 'absent', stamp: null, source }); continue; }
      const stamp = stampedDate(file, 'distilled');
      let state = 'current';
      if (!stamp) state = 'unstamped';
      else if (source && stamp < source) state = 'stale';
      doctrine.rows.push({ role, repo: s.repo, state, stamp, source });
    }
  }
  for (const row of doctrine.rows.filter((d) => d.state === 'stale')) {
    actions.push(`${row.repo} has doctrine for ${row.role} from ${row.stamp}, behind ${row.source} — queue a handoff`);
  }
}

// ---------------------------------------------------------------- 5. threads awaiting curation

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
  assistant: allThreads.filter((f) => f.includes('-asst-')).length,
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

// ---------------------------------------------------------------- 6. outcomes that never landed

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

// ---------------------------------------------------------------- 7. pending, and native memory

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
  kind: WS ? 'workspace' : (sweeps ? 'cross-project layer' : 'project context repo'),
  layout: { threads: THREADS_REL, pending: PENDING_REL },
  declared: { assistants: Object.keys(assistants), supervisors: Object.keys(supervisors), include: includes },
  queues: { lessons, slices, sweptThreads, handoff, doctrine, threads, reconcile, pending, memory },
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
if (WS) L.push(`  workspace · threads in ${THREADS_REL}/ · pending in ${PENDING_REL}/`);
else L.push(`  ${data.kind} · ${Object.keys(assistants).length} assistant(s) · ${Object.keys(supervisors).length} supervisor(s)${includes.length ? ` · include: ${includes.length}` : ''}`);

if (lessons.applicable) {
  head('LESSONS AWAITING A SWEEP', '/supervisor-sweep');
  if (!lessons.roles.length) L.push('    (no roles matched)');
  for (const r of lessons.roles) {
    if (r.error) { L.push(`    ${pad(r.role, 20)} could not read — ${r.error}`); continue; }
    const t = r.threshold === null ? 'no threshold yet' : `threshold ${r.threshold} (${r.thresholdFrom})`;
    L.push(`    ${pad(r.role, 20)} ${String(r.unswept).padStart(3)} unswept   ${pad(t, 28)} ${r.verdict.toUpperCase()}`);
    // A per-source breakdown of zero is noise. An ABSENT clone is not: it contributed nothing
    // and looks identical to a source with no lessons, which is the confusion worth spending
    // a line on even when the role is otherwise clear.
    for (const s of r.sources) {
      if (!s.available) { L.push(`        ---  ${s.repo} — NO CLONE at ${s.root}, contributed nothing`); continue; }
      if (r.unswept === 0) continue;
      L.push(`        ${String(s.count).padStart(3)}  ${s.repo}${s.self ? ' (this repo)' : ''}`);
    }
  }
} else if (!WS) {
  head('LESSONS', '');
  L.push('    This repo declares no supervisors, so it is a project rather than the layer that');
  L.push('    distils. Whether its lessons have been swept is only knowable where the sweeping');
  L.push('    happens — run this there. Handoff items addressed to this repo live there too.');
}

if (slices.roles.length) {
  head("THIS REPO'S ASSISTANT SLICES", '/assistant [role]');
  for (const s of slices.roles) {
    // DOCTRINE.md is deliberately absent until a supervisor sends one, so listing it as
    // "missing" would report the normal state as a defect. Its own column already says so.
    const missing = Object.entries(s.files).filter(([k, v]) => !v && k !== 'doctrine').map(([k]) => k);
    const doctrine = s.files.doctrine
      ? `doctrine ${s.doctrineStamp ?? 'unstamped'}${s.doctrineAge !== null ? ` (${s.doctrineAge}d)` : ''}`
      : 'no doctrine yet';
    L.push(`    ${pad(s.role, 20)} ${String(s.lessons ?? '?').padStart(3)} lesson(s)   ${pad(doctrine, 28)}${missing.length ? ` missing: ${missing.join(', ')}` : ''}`);
  }
}

if (sweptThreads.applicable) {
  head('SWEEPS AWAITING DISTILLATION', '/supervisor-distil');
  let any = false;
  for (const r of sweptThreads.roles) {
    if (!r.pending.length) continue;
    any = true;
    L.push(`    ${pad(r.role, 20)} ${r.pending.length} thread(s) since ${r.distilled ?? 'doctrine was first written (never)'}`);
    for (const p of r.pending) L.push(`        ${p.date ?? 'undated'}  ${p.file}`);
  }
  if (!any) L.push(`    none — ${sweptThreads.roles.every((r) => !r.distilled) ? 'no sweep has ever run' : 'doctrine is level with the threads'}`);
}

if (handoff.applicable) {
  head('HANDOFF AWAITING A DRAIN', 'in the TARGET repo session');
  if (!handoff.items.length) L.push('    none — handoff/ is empty');
  for (const g of handoff.byProject) {
    L.push(`    ${pad(g.project, 32)} ${String(g.count).padStart(2)} item(s)${g.oldestAge !== null ? `   oldest ${g.oldestAge}d (${g.oldest})` : ''}`);
    for (const it of handoff.items.filter((i) => i.project === g.project)) {
      L.push(`        ${pad(it.kind, 12)} ${it.title}`);
    }
  }
}

if (doctrine.applicable && doctrine.rows.length) {
  head('DOCTRINE DELIVERED TO EACH REPO', '');
  for (const role of [...new Set(doctrine.rows.map((d) => d.role))]) {
    const rows = doctrine.rows.filter((d) => d.role === role);
    // Nothing distilled means nothing to deliver, and a row per repo saying "absent" would
    // read as a delivery failure rather than as a step that has not been reached yet.
    if (rows.every((d) => d.source === null)) {
      L.push(`    ${pad(role, 20)} no doctrine written yet — nothing to deliver to ${rows.length} repo(s)`);
      continue;
    }
    for (const d of rows) L.push(`    ${pad(d.role, 20)} ${pad(d.repo, 30)} ${d.state}${d.stamp ? ` (${d.stamp})` : ''}`);
  }
}

head('THREADS AWAITING CURATION', '/curate-context');
L.push(`    ${threads.total} thread(s) in ${THREADS_REL}/${threads.assistant ? ` (${threads.assistant} assistant)` : ''}, ${threads.archived} archived`);
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
// "Every queue is clear" must never be said from a repo that cannot see every queue. A project
// run is blind to the sweep backlog and to the handoff items addressed to it, and an empty
// punchline there would read as an all-clear it has no standing to give. A workspace is not
// blind to them: they are retired, so there is no layer above it holding a queue for it.
const seesAll = sweeps || WS;
if (actions.length) L.push(`  WHAT TO RUN (${actions.length}):`);
else if (seesAll) L.push('  WHAT TO RUN: nothing — every queue is clear.');
else L.push('  WHAT TO RUN: nothing HERE. The sweep backlog and any handoff bound for this repo');
if (!actions.length && !seesAll) L.push('    are only visible in the cross-project layer — run this there as well.');
for (const a of actions) L.push(`    - ${a}`);
if (actions.length && !seesAll) {
  L.push('');
  L.push('  Cross-project queues (sweeps, and handoff addressed to this repo) are not visible');
  L.push('  from a project repo — run this in the cross-project layer as well.');
}
L.push('');
L.push('  Nothing has been changed. This is a read.');

console.log(L.join('\n'));
