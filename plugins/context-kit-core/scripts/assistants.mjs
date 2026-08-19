#!/usr/bin/env node
// The deterministic half of the assistant layer: reading the roster, resolving slice paths,
// validating a role against the canonical registry, minting and parsing LESSONS.md entry ids,
// and working out which lessons a supervisor has already consumed.
//
//   node assistants.mjs roster   <root>                     # what this repo declares
//   node assistants.mjs paths    <root> --role software-dev # the four files, and which exist
//   node assistants.mjs resolve  <root> --role dev          # canonical name via the registry
//   node assistants.mjs lesson-id --text "the lesson"       # the id a new entry would carry
//   node assistants.mjs lessons  <root> --role software-dev # entries in this repo, with ids
//   node assistants.mjs unswept  <root> --role software-dev # lessons across sources, minus
//                                                           # every id a supervisor thread cites
// Every subcommand takes --json. Date-bearing output takes --today YYYY-MM-DD.
//
// WHY A SCRIPT: ids must come out identically every time or the sweep re-consumes lessons it
// has already distilled, and "which lessons are new" must be computable rather than
// remembered. Prose cannot promise either.
//
// WHAT IT NEVER DOES: write. Every subcommand reads. The skills own the writing, so that the
// one place a lesson is composed is also the place a human is looking at it.
//
// Reading a SOURCE repo (an include) is reading only — the clone is on disk, and the
// read-only rule is about writes. Nothing here resolves or pulls anything: paths come from
// the ~/.context/[owner]/[repo] layout the resolver already uses, and a repo that is not
// cloned is reported absent rather than fetched.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const COMMANDS = ['roster', 'paths', 'resolve', 'lesson-id', 'lessons', 'unswept'];
const OPTIONS = ['json', 'role', 'text', 'today'];
const OPTOUT = ['none', 'off', 'false', 'no', '-', 'disabled'];
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
// Kebab-case, so a role name is safe in a filename, a front-matter value and a JSON key alike.
const ROLE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const die = (m) => { console.error(`assistants.mjs: ${m}`); process.exit(2); };

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flags = new Set();
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--role' || a === '--text' || a === '--today') opts[a.slice(2)] = argv[++i];
  else if (a.startsWith('--')) flags.add(a.slice(2));
  else positional.push(a);
}
for (const f of flags) if (!OPTIONS.includes(f)) die(`unknown option --${f}`);

const command = positional[0];
if (!command) die(`needs a subcommand (${COMMANDS.join(', ')})`);
if (!COMMANDS.includes(command)) die(`unknown subcommand "${command}" (${COMMANDS.join(', ')})`);

const today = opts.today ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) die(`--today needs YYYY-MM-DD, got ${opts.today}`);

const out = (data, lines) => {
  if (flags.has('json')) console.log(JSON.stringify(data, null, 2));
  else for (const l of lines) console.log(l);
};

// ---------------------------------------------------------------- config

const readJson = (file) => {
  const raw = readFileSync(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
};

function loadContext(root) {
  const file = join(root, 'context.json');
  if (!existsSync(file)) die(`no context.json at ${root} — not a context repo`);
  try { return readJson(file); } catch (e) { die(`context.json is not valid JSON (${e.message})`); }
}

// The roster is DECLARED, never discovered. A folder someone happened to create is not an
// assistant — same rule as `include`, and for the same reason: what a session loads has to be
// legible from committed config rather than from whatever is lying around on disk.
function roster(ctx) {
  const assistants = ctx.assistants && typeof ctx.assistants === 'object' && !Array.isArray(ctx.assistants)
    ? ctx.assistants : {};
  const supervisors = ctx.supervisors && typeof ctx.supervisors === 'object' && !Array.isArray(ctx.supervisors)
    ? ctx.supervisors : {};
  const roles = ctx.roles && typeof ctx.roles === 'object' && !Array.isArray(ctx.roles)
    ? ctx.roles : {};
  return { assistants, supervisors, roles };
}

// The canonical registry lives in ONE repo — whichever declares `roles`. Children reference it
// by exact string. Aliases exist so a rename is additive: name the old spelling, sweep once so
// both fold into one supervisor, rename the directories afterwards.
function resolveRole(roles, name) {
  const want = String(name ?? '').trim().toLowerCase();
  if (!want) return { ok: false, reason: 'no role given' };
  if (!ROLE_RE.test(want)) return { ok: false, reason: `"${want}" is not kebab-case` };
  if (Object.keys(roles).length === 0) return { ok: true, canonical: want, viaAlias: null, registry: false };
  if (roles[want]) return { ok: true, canonical: want, viaAlias: null, registry: true };
  for (const [canonical, def] of Object.entries(roles)) {
    const aliases = Array.isArray(def?.aliases) ? def.aliases.map((a) => String(a).toLowerCase()) : [];
    if (aliases.includes(want)) return { ok: true, canonical, viaAlias: want, registry: true };
  }
  return { ok: false, reason: `"${want}" is not in the role registry (${Object.keys(roles).join(', ') || 'empty'})`, registry: true };
}

const slicePaths = (root, role) => ({
  dir: join(root, 'assistants', role),
  persona: join(root, 'assistants', role, 'PERSONA.md'),
  memory: join(root, 'assistants', role, 'memory.md'),
  lessons: join(root, 'assistants', role, 'LESSONS.md'),
  doctrine: join(root, 'assistants', role, 'DOCTRINE.md'),
});

// ---------------------------------------------------------------- lesson ids

// Content-addressed, six hex characters. Content-addressed rather than sequential so that an
// id survives LESSONS.md being reordered, re-indented or partially rewritten — the failure
// mode a counter cannot survive. Six characters is ~16.7M values, which is not collision-proof
// in general but is far beyond the scale of one role's lessons, and a collision costs one
// re-consulted lesson rather than a corrupted file.
const lessonId = (text) => createHash('sha256')
  .update(String(text).replace(/\s+/g, ' ').trim().toLowerCase())
  .digest('hex').slice(0, 6);

// An entry heading: `## YYYY-MM-DD · abc123 — one-line summary`. The id sits in the heading so
// it is visible to a human editing the file, and so a supervisor thread can cite it in prose.
const ENTRY_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s+·\s+([0-9a-f]{6})\s*(?:—|--)?\s*(.*)$/;

function parseLessons(file) {
  if (!existsSync(file)) return [];
  const entries = [];
  let current = null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = ENTRY_RE.exec(line);
    if (m) {
      if (current) entries.push(current);
      current = { date: m[1], id: m[2], summary: m[3].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) entries.push(current);
  return entries.map((e) => ({ ...e, body: e.body.join('\n').trim() }));
}

// Which repos a supervisor draws on: this one, plus everything in `include`. Deliberately not
// a separate list — the include list is already the explicit statement of which projects this
// repo may see, and a second list could disagree with it.
function sourceRepos(root, ctx) {
  const sources = [{ repo: ctx.contextRepo ?? '(this repo)', root, self: true }];
  for (const raw of Array.isArray(ctx.include) ? ctx.include : []) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (!REPO_RE.test(v) || OPTOUT.includes(v.toLowerCase())) continue;
    sources.push({ repo: v, root: join(homedir(), '.context', ...v.split('/')), self: false });
  }
  return sources;
}

// The consumption ledger IS the supervisor's own threads — no state file, so nothing to
// conflict under a fast-forward-only pull and nothing to desynchronise when LESSONS.md is
// curated.
//
// Consumption must be DECLARED in front-matter, never inferred from the prose:
//
//   ---
//   supervisor: software-dev
//   consumed: aaa111, bbb222
//   ---
//
// Scanning the body for six-hex tokens was the first attempt and it is wrong in both
// directions. A thread reading "bbb222 was left for next time" would mark it consumed — the
// exact opposite of what it says — and a git SHA prefix or a hex colour would consume a lesson
// that does not exist. Distilling a lesson is a decision, so it gets stated, not detected.
function citedIds(root, role) {
  const cited = new Set();
  for (const dir of [join(root, 'threads'), join(root, 'Archive', 'threads')]) {
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      if (!fm) continue;
      // Only threads belonging to THIS supervisor count: a dev thread must not be able to
      // mark a finance lesson consumed.
      if (!new RegExp(`^supervisor:\\s*${role}\\s*$`, 'm').test(fm[1])) continue;
      const line = /^consumed:\s*(.*)$/m.exec(fm[1]);
      if (!line) continue;
      for (const m of line[1].matchAll(/\b([0-9a-f]{6})\b/g)) cited.add(m[1]);
    }
  }
  return cited;
}

// ---------------------------------------------------------------- subcommands

if (command === 'lesson-id') {
  if (!opts.text) die('lesson-id needs --text "the lesson text"');
  const id = lessonId(opts.text);
  out({ id, today }, [`${today} · ${id}`]);
  process.exit(0);
}

const root = resolve(positional[1] ?? '.');
if (!existsSync(root)) die(`no such directory: ${root}`);
const ctx = loadContext(root);
const { assistants, supervisors, roles } = roster(ctx);

if (command === 'roster') {
  const data = {
    repo: ctx.contextRepo ?? null,
    assistants: Object.keys(assistants),
    supervisors: Object.keys(supervisors),
    roles: Object.keys(roles),
    // What the hook needs, already phrased. Kept here so the wording lives in one place even
    // though the hook itself inlines its own reader.
    line: Object.keys(assistants).length
      ? `Assistants here: ${Object.keys(assistants).join(', ')} — adopt one with /assistant [name]`
      : null,
  };
  out(data, [
    data.line ?? 'No assistants declared in context.json.',
    ...(data.supervisors.length ? [`Supervisors here: ${data.supervisors.join(', ')}`] : []),
    ...(data.roles.length ? [`Role registry: ${data.roles.join(', ')}`] : []),
  ]);
  process.exit(0);
}

if (command === 'resolve') {
  const r = resolveRole(roles, opts.role);
  if (!r.ok) { console.error(`assistants.mjs: ${r.reason}`); process.exit(1); }
  out(r, [r.viaAlias ? `${r.canonical} (via alias "${r.viaAlias}")` : r.canonical]);
  process.exit(0);
}

if (!opts.role) die(`${command} needs --role [name]`);
const resolved = resolveRole(roles, opts.role);
if (!resolved.ok) { console.error(`assistants.mjs: ${resolved.reason}`); process.exit(1); }
const role = resolved.canonical;

if (command === 'paths') {
  const p = slicePaths(root, role);
  const data = {
    role,
    declared: Boolean(assistants[role]),
    files: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { path: v, exists: existsSync(v) }])),
  };
  out(data, [
    `role ${role}${data.declared ? '' : '  (NOT declared in context.json assistants block)'}`,
    ...Object.entries(data.files).map(([k, v]) => `  ${v.exists ? 'ok     ' : 'missing'} ${k}: ${v.path}`),
  ]);
  process.exit(0);
}

if (command === 'lessons') {
  const entries = parseLessons(slicePaths(root, role).lessons);
  out({ role, count: entries.length, entries },
    entries.length
      ? entries.map((e) => `${e.date} · ${e.id} — ${e.summary}`)
      : [`no lessons in assistants/${role}/LESSONS.md`]);
  process.exit(0);
}

if (command === 'unswept') {
  const cited = citedIds(root, role);
  const sources = [];
  let unswept = 0;
  for (const s of sourceRepos(root, ctx)) {
    if (!existsSync(s.root)) { sources.push({ ...s, available: false, entries: [] }); continue; }
    const fresh = parseLessons(slicePaths(s.root, role).lessons).filter((e) => !cited.has(e.id));
    unswept += fresh.length;
    sources.push({ ...s, available: true, entries: fresh });
  }
  // The threshold is advisory here — the script reports, the skill decides. Its home is the
  // supervisor's own memory.md front-matter, which the skill reads; a number invented here
  // would be a second authority.
  out({ role, unswept, cited: cited.size, sources }, [
    `role ${role}: ${unswept} unswept lesson(s); ${cited.size} id(s) already cited by supervisor threads`,
    ...sources.map((s) => (s.available
      ? `  ${String(s.entries.length).padStart(3)} new  ${s.repo}${s.self ? ' (this repo)' : ''}`
      : `  absent  ${s.repo} — no clone at ${s.root}`)),
    ...sources.flatMap((s) => s.entries.map((e) => `    ${e.date} · ${e.id} — ${e.summary}  [${s.repo}]`)),
  ]);
  process.exit(0);
}
