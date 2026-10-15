#!/usr/bin/env node
// The diagram store: where it is, what a record looks like, and what a tag is allowed to be.
//
// THIS FILE IS THE SCHEMA. save-diagram.mjs writes index.jsonl through it and
// gallery-build.mjs reads index.jsonl through it, and they share this module rather than each
// carrying their own idea of the fields — a writer and a reader that agree only by convention
// drift the first time a field is added, and the symptom is a gallery quietly missing rows.
//
// Nothing here knows an org, a repo name or a tag. The store is named by the PROJECT
// (DIAGRAMS_STORE, the repo's .diagrams.json, or state.diagrams.repo in its context.json — see
// locateStore) and the vocabulary by the STORE (its own taxonomy.json). Both are read at
// runtime; neither has a default.
//
//   node diagram-store.mjs where          # resolve and print the store, or say what is missing
//   node diagram-store.mjs taxonomy       # the vocabulary in force, and where it came from
//   node diagram-store.mjs tags-in-use    # every tag actually used, with counts
//   node diagram-store.mjs init [dir]     # stamp README/.gitattributes/.gitignore into a store
//                                         #   --taxonomy also writes a STARTER taxonomy.json

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { bashBin, bashPath, NO_BASH } from './bash-bin.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Git Bash prints POSIX paths (/c/Users/…) that win32 path.join would mangle into \c\Users\….
const posixToNative = (p) =>
  (process.platform === 'win32' ? p.replace(/^\/([A-Za-z])\//, '$1:/') : p);

// ---------------------------------------------------------------- the record

/** One line of index.jsonl, in order. Add a field HERE and both sides see it at once.
 *  `text` is last because it is the long one — a human reading a raw line wants the rest first. */
export const FIELDS = [
  'id',                   // stable, derived from the path — what a comment or a link refers to
  'date',                 // YYYY-MM-DD, the day it was captured
  'org',                  // which store this came from; the gallery's cross-store filter facet
  'project',              // the project whose session drew it (see resolveStore)
  'title',                // human label, shown in the gallery
  'type',                 // one of the taxonomy's types
  'tags',                 // array, each from the taxonomy's tags
  'format',               // svg | html
  'path',                 // store-relative path to the source file
  'source_conversation',  // where it came from: a session id, a thread file, a URL — free text
  'status',               // one of the taxonomy's statuses
  'text',                 // labels lifted out of the SVG — see extractText()
];

/** Records are appended, never rewritten: one line per diagram, so two people saving at once
 *  conflict on nothing. That is the whole reason this is JSONL and not a JSON array — an array
 *  has a closing bracket, and a closing bracket is a merge conflict on every concurrent write. */
export const serialise = (entry) => {
  const ordered = {};
  for (const f of FIELDS) ordered[f] = entry[f] ?? (f === 'tags' ? [] : null);
  return JSON.stringify(ordered);
};

// ---------------------------------------------------------------- the project's config

export function readConfig() {
  const path = process.env.CONTEXT_CONFIG ?? (() => {
    // bashBin() rather than `bash`: on Windows the PATH entry is WSL's launcher, which has its
    // own filesystem and $HOME — it cannot see this script and could never see the clone the
    // resolver prints back. Failing by name beats resolving against the wrong ~.
    const bin = bashBin();
    if (!bin) throw new Error(`${NO_BASH} (or set CONTEXT_CONFIG to skip the resolver)`);
    const root = execFileSync(bin, [bashPath(join(here, 'context-repo.sh')), '--no-pull'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return join(posixToNative(root), 'context.json');
  })();
  return { path, json: JSON.parse(readFileSync(path, 'utf8')) };
}

/** The context repo is OPTIONAL: a project with no context repo names its store some other way.
 *  So an unresolvable context repo is a null here, with the reason kept for the error message —
 *  except when CONTEXT_CONFIG is set, where a missing file is the caller's mistake and says so. */
export function readConfigSoft() {
  if (process.env.CONTEXT_CONFIG) return { cfg: readConfig(), why: null };
  try { return { cfg: readConfig(), why: null }; } catch (e) {
    return { cfg: null, why: String(e.message ?? e).split('\n')[0] };
  }
}

export const REPO_FILE = '.diagrams.json';

/** Walk up from `cwd` to the enclosing repo root, returning the first `.diagrams.json` on the
 *  way. A walk rather than `git rev-parse` because Cowork has no git; stopping at the first
 *  `.git` keeps an outer repo's file from claiming an inner one that declares nothing. */
export function findRepoFile(cwd = process.cwd()) {
  let dir = cwd;
  for (;;) {
    const file = join(dir, REPO_FILE);
    if (existsSync(file)) return { path: file, root: dir, json: JSON.parse(readFileSync(file, 'utf8')) };
    if (existsSync(join(dir, '.git'))) return { path: null, root: dir, json: null };
    const up = dirname(dir);
    if (up === dir) return { path: null, root: null, json: null };
    dir = up;
  }
}

/** The owner of the repo being worked in — the org a diagram drawn here belongs to. Null when
 *  there is no git, no repo or no origin: the boundary then cannot be checked, and is reported
 *  rather than assumed either way. */
export function originOwner(cwd = process.cwd()) {
  try {
    const url = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return url.match(/github\.com[:/]([^/]+)\//)?.[1] ?? null;
  } catch { return null; }
}

/** Where this project's store is named, first match wins:
 *    1. DIAGRAMS_STORE=owner/repo           — one shell or session; tests; Cowork
 *    2. .diagrams.json in the current repo  — ties the store to the repo, no context repo needed
 *    3. context.json state.diagrams         — the context-kit route
 *  None of them → an error naming all three. The ladder makes context-kit optional; it does NOT
 *  add a default: nothing is inferred from an origin owner or from what exists on disk. */
export function locateStore({ env = process.env, cwd = process.cwd(), context = readConfigSoft, owner = originOwner } = {}) {
  if (env.DIAGRAMS_STORE) {
    return {
      source: 'env',
      configPath: 'DIAGRAMS_STORE',
      block: { repo: env.DIAGRAMS_STORE, crossOrg: env.DIAGRAMS_CROSS_ORG === '1' },
      project: null,
      repoRoot: findRepoFile(cwd).root,
      contextOwner: null,
    };
  }
  const rf = findRepoFile(cwd);
  if (rf.json) {
    return {
      source: 'repo-file', configPath: rf.path, block: rf.json,
      project: rf.json.project ?? null, repoRoot: rf.root, contextOwner: null,
    };
  }
  const { cfg, why } = context();
  const d = cfg?.json?.state?.diagrams ?? null;
  if (d?.repo) {
    return {
      source: 'context.json', configPath: cfg.path, block: d,
      project: cfg.json.project ?? cfg.json.contextRepo ?? null,
      repoRoot: rf.root,
      contextOwner: cfg.json.contextRepo?.split('/')[0] ?? null,
    };
  }
  const suggest = owner(cwd);
  throw new Error(
    'No diagram store is named for this project. Name one in any of:\n'
    + '  1. DIAGRAMS_STORE=[owner]/[repo]               (this shell only)\n'
    + `  2. ${REPO_FILE} at the repo root:  { "repo": "[owner]/[repo]" }\n`
    + `  3. context.json:  "state": { "diagrams": { "repo": "[owner]/[repo]" } }`
    + (cfg ? `   (${cfg.path} has none)` : `   (no context repo: ${why})`)
    + '\n'
    + (suggest ? `This repo's owner is ${suggest}, so ${suggest}/diagrams is the likely store — confirm it, it is not assumed.\n` : '')
    + 'There is no default on purpose: a default would let this project write into another '
    + "org's store, which is exactly the boundary the per-org stores exist to hold.",
  );
}

// ---------------------------------------------------------------- the store

/** Where this project's diagrams live. There is deliberately NO DEFAULT.
 *
 *  A default here would be the whole design failing at once: a net-flex project that named no
 *  store would silently write into whichever store the default named, and the org boundary this
 *  store exists to hold would be breached by the tool meant to hold it. So an unconfigured
 *  project is an error naming the three places a store can be named — loud, one line to fix,
 *  and impossible to mistake for "saved somewhere". A named store owned by another org than the
 *  work is refused too, unless `crossOrg: true` records that it is deliberate. */
export function resolveStore({ mustExist = true, env = process.env, cwd = process.cwd(), context = readConfigSoft, owner = originOwner } = {}) {
  const loc = locateStore({ env, cwd, context, owner });
  const d = loc.block;
  const repo = d.repo;

  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`${loc.configPath} names the store "${repo}" — expected owner/repo`);
  }

  // The org boundary, checked on every resolve rather than once at setup: a config file is
  // copied between repos, and the check must travel with the use, not with the writing.
  // "Home" is the repo being worked in; a workspace that is not a repo falls back to the
  // context repo's owner. Unknown is reported, not refused — there is nothing to compare.
  const storeOwner = repo.split('/')[0];
  const home = owner(cwd) ?? loc.contextOwner
    ?? (loc.source === 'context.json' ? null : context().cfg?.json?.contextRepo?.split('/')[0] ?? null);
  if (home && home.toLowerCase() !== storeOwner.toLowerCase() && d.crossOrg !== true) {
    throw new Error(
      `${loc.configPath} names the store ${repo}, but this work belongs to ${home}.\n`
      + `Diagrams saved here would be readable by everyone with access to ${repo}.\n`
      + 'If that is deliberate (a personal fork, one person owning both orgs), record it:\n'
      + `  "crossOrg": true   next to "repo" — or DIAGRAMS_CROSS_ORG=1 with DIAGRAMS_STORE.`,
    );
  }
  const boundary = !home ? 'unchecked' : (home.toLowerCase() === storeOwner.toLowerCase() ? 'same-org' : 'cross-org (declared)');

  // Own root, not ~/.context: that root is for context repos specifically, and a store living
  // there would say nothing false, but would invite the same tooling that resolves context repos
  // to resolve stores too, blurring a boundary that is deliberately separate.
  const dir = d.dir
    ?? process.env.DIAGRAM_STORE_DIR
    ?? join(homedir(), ...repo.split('/'));

  if (mustExist && !existsSync(join(dir, '.git'))) {
    throw new Error(
      `no checkout of ${repo} at ${dir}.\n`
      + `Clone it first:  git clone https://github.com/${repo}.git "${dir}"\n`
      + 'This script never clones: a store is a private per-org repo, and a failed clone that '
      + 'silently created an empty directory would look exactly like an empty store.',
    );
  }

  return {
    repo,
    dir,
    // The org is the facet the gallery filters on when it is showing more than one store, so it
    // is recorded on every row rather than inferred at read time — a row must still say which
    // store it came from once it has been merged with rows from another.
    org: d.org ?? storeOwner,
    project: loc.project ?? (loc.repoRoot ? basename(loc.repoRoot) : null),
    configPath: loc.configPath,
    source: loc.source,
    home,
    boundary,
  };
}

// ---------------------------------------------------------------- the taxonomy

/** The store's own `taxonomy.json` — the vocabulary, agreed per org, living with the diagrams
 *  rather than in this plugin. A plugin holding the tag list would be the same layering error as
 *  a hard-coded database ID: the plugin knows the shape, the store knows the values.
 *
 *  Absent / empty / present all mean different things, as everywhere else in this system:
 *    - ABSENT   — nobody has agreed a vocabulary yet. Saves proceed and SAY SO, and every tag
 *                 used is recorded, so `tags-in-use` gives that conversation its starting data.
 *                 Blocking here would strand the store behind a meeting.
 *    - `[]`     — considered, and deliberately open. Anything goes, silently.
 *    - non-empty— closed. An unlisted tag is rejected, with the near misses named.
 */
export function readTaxonomy(dir) {
  const path = join(dir, 'taxonomy.json');
  if (!existsSync(path)) {
    return { present: false, path, tags: [], types: [], statuses: [] };
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    present: true,
    path,
    tags: raw.tags ?? [],
    types: raw.types ?? [],
    statuses: raw.statuses ?? [],
  };
}

const near = (word, list) => {
  const w = String(word).toLowerCase();
  return list.filter((c) => {
    const l = c.toLowerCase();
    return l.startsWith(w.slice(0, 3)) || w.startsWith(l.slice(0, 3)) || l.includes(w) || w.includes(l);
  }).slice(0, 3);
};

/** Check one field's values against the vocabulary. Returns findings; it never throws, because
 *  the caller decides whether an unknown tag is fatal (a save) or a note (a report). */
export function checkVocabulary(taxonomy, field, values) {
  const allowed = taxonomy[field] ?? [];
  const used = [].concat(values ?? []).filter(Boolean).map(String);
  if (!taxonomy.present) {
    return { state: 'unagreed', used, unknown: [], suggestions: {} };
  }
  if (!allowed.length) return { state: 'open', used, unknown: [], suggestions: {} };
  const unknown = used.filter((v) => !allowed.includes(v));
  const suggestions = {};
  for (const u of unknown) {
    const s = near(u, allowed);
    if (s.length) suggestions[u] = s;
  }
  return { state: unknown.length ? 'rejected' : 'ok', used, unknown, suggestions };
}

// ---------------------------------------------------------------- the index

export const indexPath = (dir) => join(dir, 'index.jsonl');

/** Read every record. A malformed line is reported and skipped rather than aborting the read —
 *  one bad append must not make the whole store unreadable, which is the failure mode a JSON
 *  array would have had. */
export function readIndex(dir) {
  const path = indexPath(dir);
  if (!existsSync(path)) return { entries: [], bad: [], path };
  const entries = [];
  const bad = [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try { entries.push(JSON.parse(line)); } catch (e) { bad.push({ line: i + 1, error: e.message }); }
  });
  return { entries, bad, path };
}

/** Append one record. Append-only is the concurrency story: no read-modify-write, so two saves
 *  racing produce two lines rather than one lost one. */
export function appendIndex(dir, entry) {
  const path = indexPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(path, `${prefix}${serialise(entry)}\n`, 'utf8');
  return path;
}

// ---------------------------------------------------------------- the searchable text

/** Lift the words that are drawn IN the diagram into the index.
 *
 *  This is the search that actually gets used. People remember a box labelled "settlement
 *  window" months after they have forgotten whether they tagged the thing `architecture` or
 *  `data-flow` — so the labels are the index, and the tags are the filter.
 *
 *  Deliberately a regex over the source rather than an XML parse: the input is a file Claude
 *  just wrote, a dependency-free script cannot parse HTML properly anyway, and a missed label
 *  costs a search hit while a thrown parser costs the whole save. */
export function extractText(source, format = 'svg') {
  const cleaned = String(source)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ');

  const out = [];
  // SVG text lives in <text>/<tspan>; HTML diagrams put labels in ordinary elements too, and
  // in both cases <title>/<desc> carry the accessible name worth searching.
  const tagged = /<(?:text|tspan|title|desc)\b[^>]*>([\s\S]*?)<\/(?:text|tspan|title|desc)>/gi;
  for (const m of cleaned.matchAll(tagged)) out.push(m[1]);
  if (format === 'html') {
    for (const m of cleaned.matchAll(/<(?:h[1-6]|p|li|td|th|span|div|figcaption)\b[^>]*>([^<]{2,})</gi)) {
      out.push(m[1]);
    }
  }
  // aria-label / alt say what an unlabelled shape is; they are the only text some diagrams have.
  for (const m of cleaned.matchAll(/\b(?:aria-label|alt)\s*=\s*"([^"]+)"/gi)) out.push(m[1]);

  const seen = new Set();
  const words = [];
  for (const chunk of out) {
    const t = chunk.replace(/<[^>]*>/g, ' ')
      .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    words.push(t);
  }
  return words.join(' · ');
}

// ---------------------------------------------------------------- ids and paths

export const slug = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60) || 'untitled';

/** `diagrams/YYYY/YYYY-MM-DD-title.svg`, and the id is that path minus its extension. One
 *  derivation, so an id can always be turned back into a file and vice versa. */
export function placeFor(dir, { date, title, format }) {
  const base = `${date}-${slug(title)}`;
  const year = String(date).slice(0, 4);
  let rel = `diagrams/${year}/${base}.${format}`;
  let n = 2;
  while (existsSync(join(dir, rel))) {
    rel = `diagrams/${year}/${base}-${n}.${format}`;
    n += 1;
  }
  return { rel, id: rel.replace(/\.[^.]+$/, '') };
}

/** Rasters are build output, not artifacts: they are looked for beside the source and lazily
 *  linked by the gallery, never inlined and never required. */
export const rasterFor = (dir, rel) => {
  const png = rel.replace(/\.[^.]+$/, '.png');
  return existsSync(join(dir, png)) ? png : null;
};

// ---------------------------------------------------------------- bootstrapping a store

/** Stamp the house files into an existing store checkout. Never creates the repo and never
 *  clones: a store is a private per-org repo, and a directory this script conjured would look
 *  exactly like an empty store rather than a missing one.
 *
 *  taxonomy.json is NOT written by default, and that is the point. Absent means "the vocabulary
 *  has not been agreed", which is true of a brand-new store — stamping a plausible-looking one
 *  would replace an honest unagreed state with a vocabulary nobody chose, and it would then be
 *  enforced. `--taxonomy` writes a starter to edit, for when the agreeing has actually happened. */
export function initStore(dir, { taxonomy = false } = {}) {
  if (!existsSync(join(dir, '.git'))) {
    throw new Error(`${dir} is not a git checkout — clone the store repo first. This never `
      + 'creates one: an empty directory reads as an empty store, not a missing one.');
  }
  const assets = join(here, '..', 'assets', 'store');
  const written = [];
  const skipped = [];
  const place = (from, to) => {
    const target = join(dir, to);
    if (existsSync(target)) { skipped.push(to); return; }
    copyFileSync(join(assets, from), target);
    written.push(to);
  };
  place('README.md', 'README.md');
  place('.gitattributes', '.gitattributes');
  place('gitignore', '.gitignore');   // shipped unprefixed so it is not applied to this repo

  if (taxonomy) {
    const target = join(dir, 'taxonomy.json');
    if (existsSync(target)) skipped.push('taxonomy.json');
    else {
      writeFileSync(target, `${JSON.stringify({
        _comment: 'The vocabulary for this store, agreed by the people who use it. An unlisted '
          + 'value is REJECTED by save-diagram; add one in a commit of its own so the change is '
          + 'visible. An empty array means that field is deliberately open.',
        types: ['architecture', 'sequence', 'state-machine', 'flow', 'sketch'],
        tags: [],
        statuses: ['draft', 'current', 'superseded'],
      }, null, 2)}
`, 'utf8');
      written.push('taxonomy.json');
    }
  }
  return { written, skipped, taxonomyPresent: existsSync(join(dir, 'taxonomy.json')) };
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2];
  const die = (m) => { console.error(m); process.exit(2); };
  try {
    if (cmd === 'where') {
      const s = resolveStore({ mustExist: false });
      console.log(`repo     ${s.repo}`);
      console.log(`checkout ${s.dir}${existsSync(join(s.dir, '.git')) ? '' : '   (NOT CLONED)'}`);
      console.log(`org      ${s.org}`);
      console.log(`project  ${s.project ?? '(unnamed)'}`);
      console.log(`config   ${s.configPath}  (${s.source})`);
      console.log(`boundary ${s.boundary}${s.home ? ` — this work belongs to ${s.home}` : ' — no origin or context repo to compare against'}`);
    } else if (cmd === 'taxonomy') {
      const s = resolveStore();
      const t = readTaxonomy(s.dir);
      if (!t.present) {
        console.log(`No taxonomy.json in ${s.repo}. The vocabulary has NOT been agreed yet:`);
        console.log('tags are recorded as given and reported, not rejected. `tags-in-use` shows');
        console.log('what is actually being used, which is the input that conversation needs.');
      } else {
        console.log(`taxonomy ${t.path}`);
        for (const f of ['types', 'tags', 'statuses']) {
          console.log(`${f.padEnd(9)}${t[f].length ? t[f].join(', ') : '(open — anything allowed)'}`);
        }
      }
    } else if (cmd === 'tags-in-use') {
      const s = resolveStore();
      const { entries, bad } = readIndex(s.dir);
      const counts = new Map();
      for (const e of entries) for (const t of e.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
      const t = readTaxonomy(s.dir);
      const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      if (!rows.length) console.log('(no tags recorded yet)');
      for (const [tag, n] of rows) {
        const mark = !t.present ? '' : (t.tags.length && !t.tags.includes(tag) ? '  ← not in taxonomy.json' : '');
        console.log(`${String(n).padStart(4)}  ${tag}${mark}`);
      }
      if (bad.length) console.error(`\n${bad.length} unreadable line(s) in index.jsonl: ${bad.map((b) => b.line).join(', ')}`);
    } else if (cmd === 'init') {
      const dir = process.argv[3] && !process.argv[3].startsWith('--')
        ? process.argv[3]
        : resolveStore().dir;
      const r = initStore(dir, { taxonomy: process.argv.includes('--taxonomy') });
      console.log(`store ${dir}`);
      if (r.written.length) console.log(`wrote   ${r.written.join(', ')}`);
      if (r.skipped.length) console.log(`kept    ${r.skipped.join(', ')} (already there)`);
      if (!r.taxonomyPresent) {
        console.log('');
        console.log('No taxonomy.json — deliberately. Absent means the vocabulary has not been');
        console.log('agreed, which is honest for a new store: saves proceed and say so, rather');
        console.log('than enforcing a list nobody chose. Run again with --taxonomy once it has.');
      }
    } else {
      die('usage: diagram-store.mjs where | taxonomy | tags-in-use | init [dir] [--taxonomy]');
    }
  } catch (e) {
    die(e.message);
  }
}
