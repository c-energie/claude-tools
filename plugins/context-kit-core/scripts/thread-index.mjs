#!/usr/bin/env node
// Rebuild threads/INDEX.md from what is actually on disk. Date, title and path come from the
// file — the model only supplies the two fields that need judgement (status, gist).
//
//   node thread-index.mjs <context-repo-root>                 # skeleton, gist left as TODO
//   node thread-index.mjs <root> --gists gists.json           # fill from {"<file>": {"status","gist"}}
//   node thread-index.mjs <root> --gists g.json --write       # write threads/INDEX.md
//   node thread-index.mjs <repo> --dir .claude/threads         # a repo's own thread layer
//   node thread-index.mjs <workspace> --dir docs/threads       # a workspace's (ADR 0002)
//
// Prints the index to stdout unless --write. Filenames are expected as YYYY-MM-DD-<topic>.md;
// anything else is still listed, just without a date.
//
// The topic comes from the front-matter `title:`, then the first markdown heading, then the
// filename slug. Reading the first non-empty line instead — which was the original behaviour —
// yields the literal `---` fence for every file in a repo that uses front-matter, i.e. every
// file this is pointed at. Observed on a real curation pass, 2026-08-13.
//
// AUDIENCE. A thread's optional `audience:` says who it was written for — `working` (session
// sediment, nobody needs to read it cold), `team` (a document a colleague should read), or
// `external` (fit to leave the organisation). It is surfaced here because the question "which
// of these is a document rather than a pile of notes" is otherwise answerable only by opening
// twenty files, and because it is the one classification a reader cannot infer: every thread is
// written to the same house style whether or not anyone but its author will ever want it.
//
// It is read from front-matter and NEVER supplied through --gists. status and gist are
// index-side judgements *about* a thread and belong to whoever rebuilds the index; audience is a
// property *of* the thread, authored with it. Accepting it here as well would create a second
// place to answer it, and the two would disagree the first time a thread was edited.
//
// An absent audience renders nothing rather than a default. Treating absent as `working` would
// silently classify every thread written before the field existed, which is precisely the claim
// nobody has made yet — the same absent-versus-empty distinction drawn across this plugin.

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const flags = new Set();
const positional = [];
let gistsPath = null;
// --dir points the index at a repo's OWN thread layer (.claude/threads) instead of a context
// repo's threads/. That layer has no Archive/, so the archived scan is skipped rather than
// reported empty: "0 archived" would imply an archive exists and is empty.
let dirArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--gists') gistsPath = argv[++i];
  else if (argv[i] === '--dir') dirArg = argv[++i];
  else if (argv[i].startsWith('--')) flags.add(argv[i].slice(2));
  else positional.push(argv[i]);
}
const root = positional[0];
if (!root) { console.error('thread-index.mjs: needs the context repo root'); process.exit(2); }
const gists = gistsPath ? JSON.parse(readFileSync(gistsPath, 'utf8')) : {};

const SKIP = new Set(['README.md', 'INDEX.md']);

// Ordered least to most public. The order is the point: `working` is the default a thread earns
// by being nobody's document but its author's, and each step out widens who is expected to read
// it. Anything else in the field is reported rather than rejected — see scan().
const AUDIENCES = ['working', 'team', 'external'];
const unknownAudience = [];

// Split leading YAML front-matter from the body. Returns fm as an array of lines (null when the
// file has none, or when the block is never closed — an unterminated fence must not swallow the
// whole document).
function splitFrontMatter(text) {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (lines[i]?.trim() !== '---') return { fm: null, body: lines.slice(i) };
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === '---' || t === '...') return { fm: lines.slice(i + 1, j), body: lines.slice(j + 1) };
  }
  return { fm: null, body: lines.slice(i) };
}

// One top-level scalar out of the front-matter block. Indented lines are skipped so a nested
// key of the same name can't shadow the real one.
function fmScalar(fm, key) {
  if (!fm) return '';
  for (const line of fm) {
    if (/^\s/.test(line)) continue;
    const m = new RegExp(`^${key}\\s*:\\s*(.*)$`).exec(line);
    if (!m) continue;
    const v = m[1].trim();
    if (/^"(.*)"$/.test(v)) return v.slice(1, -1).replace(/\\"/g, '"').trim();
    if (/^'(.*)'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'").trim();
    return v;
  }
  return '';
}

function topicOf(text, filename) {
  const { fm, body } = splitFrontMatter(text);
  const title = fmScalar(fm, 'title');
  if (title) return title;
  const heading = body.find((l) => /^#{1,6}\s+\S/.test(l));
  if (heading) return heading.replace(/^#+\s*/, '').trim();
  return filename.replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
}

// Status and gist are judgement, and judgement already spent is not free to spend again. A bare
// --write used to replace every existing gist with a TODO, so rebuilding an index that had them
// meant re-deriving twelve summaries by hand — which is why an index goes stale rather than
// being rebuilt. So: read whatever INDEX.md is already there and carry its answers forward,
// keyed on PATH, which is stable when a title is edited.
//
// Precedence: --gists (an explicit answer now) beats the existing file, which beats TODO.
// Lines that do not parse are counted and reported rather than dropped in silence: losing a
// hand-written gist without saying so is exactly the failure this is fixing.
//
// The owner segment is OPTIONAL and must be matched explicitly, because this file has to
// re-parse its own output. A thread tagged `assistant:` or `supervisor:` emits SIX fields, not
// five; without the optional group the parser read the owner as the status and carried
// "supervisor: editor" forward as a status — a line that still matched, so carriedUnparsed
// stayed 0 and nothing was reported. Latent until the first owner-bearing line was generated
// (2026-08-23): the three that existed had been hand-written into an index, five fields wide.
//
// `audience:` is the second such optional segment and is matched the same way, for the same
// reason. Both are prefixed with a literal tag in the rendered line precisely so this pattern
// can tell them apart from the status that follows — an untagged optional field between two
// free-text ones cannot be located unambiguously at all.
const INDEX_LINE =
  /^-\s+(\S+)\s+·\s+(.*?)\s+·\s+(?:(?:assistant|supervisor):\s*[^·]+?\s+·\s+)?(?:audience:\s*[^·]+?\s+·\s+)?([^·]*?)\s+·\s+(.*?)\s+·\s+`([^`]+)`\s*$/;
// Belt and braces for the same failure: a status is never a tag, so if one ever appears there
// again the line is treated as unparsed and COUNTED, rather than silently overwriting a real
// status. A format change should cost a warning, not a column.
const TAG_AS_STATUS = /^(assistant|supervisor|audience):/;
let carriedUnparsed = 0;
function readExistingIndex(dir) {
  const file = join(root, ...dir.split('/'), 'INDEX.md');
  const map = new Map();
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('- ')) continue;
    if (line.trim() === '- _none_') continue;
    const m = INDEX_LINE.exec(line);
    if (!m) { carriedUnparsed++; continue; }
    const [, , , status, gist, path] = m;
    if (TAG_AS_STATUS.test(status)) { carriedUnparsed++; continue; }
    // A carried TODO is not an answer; leave it to be regenerated.
    map.set(path, {
      status: status.startsWith('TODO:') ? undefined : status,
      gist: gist.startsWith('TODO:') ? undefined : gist,
    });
  }
  return map;
}

function scan(dir, archived) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith('.md') && !SKIP.has(f))
    .sort()
    .map((f) => {
      const text = readFileSync(join(abs, f), 'utf8');
      const explicit = gists[f] ?? gists[`${dir}/${f}`] ?? {};
      const carried = existing.get(`${dir}/${f}`) ?? {};
      const meta = {
        status: explicit.status ?? carried.status,
        gist: explicit.gist ?? carried.gist,
      };
      if (carried.gist && !explicit.gist) carriedCount++;
      const fm = splitFrontMatter(text).fm;
      const audience = fmScalar(fm, 'audience');
      // An unknown value is rendered as written and counted, never corrected or dropped. A
      // typo'd value the reader can see is a two-second fix; one this silently swallowed would
      // leave a thread looking unclassified forever, and the author would never learn why.
      if (audience && !AUDIENCES.includes(audience)) unknownAudience.push(`${dir}/${f}: ${audience}`);
      return {
        date: /^(\d{4}-\d{2}-\d{2})/.exec(f)?.[1] ?? '—',
        topic: topicOf(text, f),
        // An assistant's or supervisor's thread is otherwise indistinguishable from an ordinary
        // one here — tagging rather than nesting was chosen precisely so these stay in the same
        // flat directory. Surfacing the owner is what keeps the index navigable once a role
        // starts writing daily, and what lets a reader see which lines belong to a role rather
        // than to the project itself.
        owner: fmScalar(fm, 'assistant') || fmScalar(fm, 'supervisor') || null,
        kind: fmScalar(fm, 'assistant') ? 'assistant'
          : (fmScalar(fm, 'supervisor') ? 'supervisor' : null),
        audience: audience || null,
        status: meta.status ?? (archived ? 'archived' : 'TODO: active/settled?'),
        gist: meta.gist ?? 'TODO: one-line gist',
        path: `${dir}/${f}`,
      };
    });
}

const THREAD_DIR = dirArg ?? 'threads';
// The archive is always a sibling of the thread directory: threads/ archives to
// Archive/threads/, and .claude/threads/ archives to .claude/Archive/threads/. Deriving it
// removes the special case that skipped the archive entirely for the repo layer, which was
// only ever right while that layer had nowhere to archive to.
const ARCHIVE_DIR = THREAD_DIR.includes('/')
  ? `${THREAD_DIR.split('/').slice(0, -1).join('/')}/Archive/threads`
  : 'Archive/threads';
const existing = readExistingIndex(THREAD_DIR);
let carriedCount = 0;
const active = scan(THREAD_DIR, false);
const archived = scan(ARCHIVE_DIR, true);
const line = (t) => `- ${t.date} · ${t.topic}`
  + `${t.owner ? ` · ${t.kind}: ${t.owner}` : ''}`
  + `${t.audience ? ` · audience: ${t.audience}` : ''}`
  + ` · ${t.status} · ${t.gist} · \`${t.path}\``;

const out = [
  '# Thread index',
  '',
  `_Generated ${new Date().toISOString().slice(0, 10)} — one line per thread. Format: date · topic · [assistant/supervisor: owner] · [audience: working|team|external] · status · gist · path. The two bracketed segments appear only when the thread declares them._`,
  '',
  `## Active (${active.length})`,
  ...(active.length ? active.map(line) : ['- _none_']),
  '',
  // Omitted rather than shown empty when no archive directory exists at all: a
  // "## Archived (0)" implies an archive exists and happens to be empty, a different claim.
  ...(existsSync(join(root, ...ARCHIVE_DIR.split('/'))) ? [
    `## Archived (${archived.length})`,
    ...(archived.length ? archived.map(line) : ['- _none_']),
    '',
  ] : []),
].join('\n');

if (flags.has('write')) {
  writeFileSync(join(root, ...THREAD_DIR.split('/'), 'INDEX.md'), out);
  console.error(`Wrote ${THREAD_DIR}/INDEX.md — ${active.length} active, ${archived.length} archived.`);
} else {
  console.log(out);
}

const missing = [...active, ...archived].filter((t) => t.gist.startsWith('TODO:')).length;
console.error(
  `${active.length + archived.length} thread(s): ${carriedCount} gist(s) carried from the existing index`
  + `, ${missing} still needing one.`);
if (carriedUnparsed) {
  console.error(
    `WARNING: ${carriedUnparsed} line(s) in the existing INDEX.md could not be parsed, so any`
    + ` gist they held was NOT carried forward. Check them before writing.`);
}

// Reported, never actioned. An unclassified thread is not a defect — the field is optional and
// most threads predate it — but the count is the only way anyone learns the classification
// exists, and a number that moves is what makes it worth setting.
const unclassified = [...active, ...archived].filter((t) => !t.audience).length;
if (unclassified) {
  console.error(
    `${unclassified} thread(s) declare no audience: — add `
    + `\`audience: ${AUDIENCES.join('|')}\` to a thread's front-matter to say who it was written for.`);
}
if (unknownAudience.length) {
  console.error(
    `WARNING: ${unknownAudience.length} thread(s) declare an audience outside `
    + `${AUDIENCES.join('|')} — rendered as written:\n    ${unknownAudience.join('\n    ')}`);
}