#!/usr/bin/env node
// Drain Claude's native per-directory memory into the context ladder.
//
//   node memory-triage.mjs scan <workspace-or-context-repo-root> [--dir path] [--json] [--today YYYY-MM-DD]
//   node memory-triage.mjs mark <memory-file> --to "your-org/workspace docs/memory.md" [--today ...]
//
// THE PROBLEM. Claude's own memory lives in ~/.claude/projects/[mangled-cwd]/memory/, keyed by
// WORKING DIRECTORY. One project spread over several checkouts therefore gets several stores
// that never see each other — and none of them is committed, so nothing in there is visible to
// anyone else or to a session opened one directory over. A preference stated once applies in
// one folder and nowhere else.
//
// THE SHAPE OF THE FIX. Native memory is an INBOX, not a layer: the frictionless place a fact
// lands mid-task. This gives it a drain. Nothing redirects where memory is written — that path
// belongs to the harness — so integration means promotion.
//
// THE SCAN READS ONE STORE: the one for the session's own working directory. No
// directory-to-project mapping is guessed, because guessing wrong files a fact under the wrong
// project.
//
// There is no longer a cross-project mode that read every store on the machine: ADR 0002
// retired the cross-project layer it served, and the personal layer now loads through the
// user-level ~/.claude/CLAUDE.md rather than by being a repo that declares anything, so nothing
// committed would entitle a scan of every store. Inventing that entitlement (a name, a path under
// ~/gh-orgs) would be exactly the guess the single-store rule refuses. A PERSONAL entry
// (`type: user` / `feedback`) is therefore reported as belonging elsewhere, never promoted here.
//
// IN A WORKSPACE (a root holding .claude/workspace.json, ADR 0002) the project layer is the
// workspace's docs/memory.md, which its CLAUDE.md imports — not a context repo's memory.md.
//
// It never writes into a repo. `scan` is read-only; `mark` stamps one metadata key on a native
// memory file so a promoted entry is not promoted twice. The skill does the promotion itself,
// into the repo the session is already in — which is the only repo it is allowed to write to.
// In a workspace that is the WORKSPACE's repo even from inside a member, because the workspace
// is the session's home: a member's checkout is where the code lives, not where context does.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';

const COMMANDS = ['scan', 'mark'];
const OPTIONS = ['json', 'dir', 'to', 'today'];
// The personal layer: facts about the person and how to work with them. `feedback` is included
// deliberately — "prefers prose over multiple choice" is not a fact about a project.
const PERSONAL = new Set(['user', 'feedback']);

const die = (m) => { console.error(`memory-triage.mjs: ${m}`); process.exit(2); };

const argv = process.argv.slice(2);
const flags = new Set();
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dir' || a === '--to' || a === '--today') opts[a.slice(2)] = argv[++i];
  else if (a.startsWith('--')) flags.add(a.slice(2));
  else positional.push(a);
}
for (const f of flags) if (!OPTIONS.includes(f)) die(`unknown option --${f}`);

const command = positional[0];
if (!command) die(`needs a subcommand (${COMMANDS.join(', ')})`);
if (!COMMANDS.includes(command)) die(`unknown subcommand "${command}"`);

const today = opts.today ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) die(`--today needs YYYY-MM-DD, got ${opts.today}`);

const PROJECTS = join(homedir(), '.claude', 'projects');

// The harness derives a store name from the working directory by flattening every path
// separator. Verified against the real directories rather than assumed.
const storeKey = (dir) => resolve(dir).replace(/[:\\/.]/g, '-');

function parseEntry(file) {
  const text = readFileSync(file, 'utf8');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const get = (k) => {
    const m = fm && new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm').exec(fm[1]);
    if (!m) return '';
    let v = m[1].trim();
    if (/^"(.*)"$/.test(v) || /^'(.*)'$/.test(v)) v = v.slice(1, -1);
    return v.trim();
  };
  return {
    file,
    name: get('name') || basename(file, '.md'),
    description: get('description'),
    type: get('type') || 'unknown',
    modified: (get('modified') || '').slice(0, 10) || null,
    promotedTo: get('promotedTo') || null,
    body: text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim(),
  };
}

function readStore(key) {
  const dir = join(PROJECTS, key, 'memory');
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch { return null; }
  return { key, dir, entries: files.map((f) => parseEntry(join(dir, f))) };
}

// ---------------------------------------------------------------- mark

if (command === 'mark') {
  const file = positional[1];
  if (!file) die('mark needs the native memory file to stamp');
  if (!existsSync(file)) die(`no such file: ${file}`);
  if (!opts.to) die('mark needs --to "where it was promoted"');
  const text = readFileSync(file, 'utf8');
  if (/^\s*promotedTo:/m.test(text)) die(`${basename(file)} is already stamped promotedTo — refusing to stamp twice`);
  const fm = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(text);
  if (!fm) die(`${basename(file)} has no front-matter block to stamp`);
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  // Stamped inside metadata, beside the keys the harness already writes there, so the record
  // travels with the entry. The entry itself is left intact: deleting it would lose the "why",
  // and re-promotion is what the stamp prevents.
  const stamped = text.replace(fm[0], `${fm[1]}${fm[2]}${nl}  promotedTo: ${opts.to} (${today})${fm[3]}`);
  writeFileSync(file, stamped);
  console.log(`stamped ${basename(file)} -> promotedTo: ${opts.to} (${today})`);
  process.exit(0);
}

// ---------------------------------------------------------------- scan

const root = resolve(positional[1] ?? '.');
if (!existsSync(root)) die(`no such directory: ${root}`);

const readJson = (file) => {
  const raw = readFileSync(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
};

// The workspace file is checked FIRST and at the root given only — no walk. The caller passes
// what workspace.mjs resolved, so the walk has already happened once; a second one here could
// only find a different answer. A malformed file is fatal rather than a reason to look for
// context.json: workspace.mjs would have fallen back to a context repo and passed THAT root,
// so arriving here with a broken workspace.json means the root came from somewhere else.
const isWorkspace = existsSync(join(root, '.claude', 'workspace.json'));
if (isWorkspace) {
  try { readJson(join(root, '.claude', 'workspace.json')); }
  catch (e) { die(`${join(root, '.claude', 'workspace.json')} is malformed — ${String(e?.message ?? e).split('\n')[0]}`); }
} else {
  try { readJson(join(root, 'context.json')); }
  catch { die(`no .claude/workspace.json and no readable context.json at ${root} — neither a workspace nor a context repo`); }
}

// Where a promoted project fact lands, relative to root.
const MEMORY = isWorkspace ? 'docs/memory.md' : 'memory.md';

const stores = [];
{
  const dir = opts.dir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const s = readStore(storeKey(dir));
  if (s) stores.push(s);
  else stores.push({ key: storeKey(dir), dir: join(PROJECTS, storeKey(dir), 'memory'), entries: [], absent: true });
}

const candidates = [];
for (const s of stores) {
  for (const e of s.entries) {
    if (e.promotedTo) continue;                                   // already drained
    candidates.push({ ...e, store: s.key });
  }
}

// `type: feedback` does NOT mean personal, and treating it that way is the mistake this guard
// exists to prevent. "Jamie prefers prose over multiple choice" is about the person; "Jamie
// wants Acme docs to state only what works" wears the same type and is about a project.
// Promote the second into the personal layer and a product's documentation convention becomes
// a fact about a human being.
//
// The mechanical signal available without guessing: the store an entry was captured in has the
// project in its path. If the entry's own text names one of those path segments, it is talking
// about that project. Reported as a HINT, never as a decision — the skill and the user judge.
const STOP = new Set(['users', 'corso', 'claude', 'projects', 'documents', 'onedrive', 'context', 'main', 'repo', 'temp', 'scratchpad', 'worktrees']);

const storeTokens = (key) => [...new Set(
  key.toLowerCase().split('-').filter((t) => t.length >= 4 && !STOP.has(t) && !/^\d+$/.test(t)),
)];

// Summary only — name and description — never the body. The body of a well-written memory
// always names the episode the fact was learned from ("on the grid-flex design session he
// rejected..."), which is evidence for a general preference rather than a limit on its scope.
// Searching it flags every entry. Word-bounded, so "flex" does not match "flexibility".
const namesItsProject = (e) => {
  const hay = `${e.name} ${e.description}`.toLowerCase();
  return storeTokens(e.store).filter((t) => new RegExp(`\\b${t}\\b`).test(hay));
};

const suggest = (e) => {
  if (PERSONAL.has(e.type)) {
    const named = namesItsProject(e);
    if (named.length) {
      return `AMBIGUOUS — names ${named.map((n) => `"${n}"`).join(', ')} from its own store path, so this is probably feedback ABOUT A PROJECT. Promote it to that project's repo, not the personal layer, unless the preference really is general.`;
    }
    // A session may only write into its own repo, so this is a finding, not a task: the person
    // is not this repo's subject, and no repo the session can write to is the personal layer.
    return 'personal — NOT promotable from here (a session writes only to its own repo). It belongs in the personal layer the user-level ~/.claude/CLAUDE.md imports; leave it in native memory until it is moved there by hand.';
  }
  const home = isWorkspace ? `the workspace's ${MEMORY}` : `the project context repo ${MEMORY}`;
  if (e.type === 'reference') return `reference — ${home}, or leave local if it is a laptop path`;
  return `project — ${home}, unless it is a code convention (that repo's CLAUDE.md) or machine-local (leave)`;
};

const data = {
  root,
  layer: isWorkspace ? 'workspace' : 'context-repo',
  memory: MEMORY,
  today,
  mode: 'project (this working directory only)',
  storesRead: stores.length,
  candidates: candidates.map((e) => ({ ...e, suggestion: suggest(e) })),
};

if (flags.has('json')) {
  console.log(JSON.stringify(data, null, 2));
} else {
  console.log(`memory-triage — ${root}  (${today})`);
  console.log(`  mode: ${data.mode}; ${stores.length} store(s) read`);
  console.log(`  project facts go to: ${join(root, MEMORY)}`);
  if (!candidates.length) {
    console.log('  ok    nothing to promote');
  } else {
    console.log(`  ${candidates.length} entr(ies) not yet promoted:\n`);
    for (const e of candidates) {
      console.log(`  ${e.type.padEnd(9)} ${e.name}`);
      console.log(`            ${e.description || '(no description)'}`);
      console.log(`            ${e.modified ?? 'undated'} · ${e.store}`);
      console.log(`            -> ${suggest(e)}`);
      console.log(`            ${e.file}`);
      console.log();
    }
    console.log(`  Nothing has been changed. Promote by hand into ${isWorkspace ? 'THIS workspace' : 'THIS repo'}, then stamp each`);
    console.log('  source with:  memory-triage.mjs mark [file] --to "[where]"');
  }
}
