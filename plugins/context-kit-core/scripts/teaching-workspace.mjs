#!/usr/bin/env node
// Teaching workspaces inside a context repo: the roster, and (later) the scaffold.
//
//   node teaching-workspace.mjs resolve                    # which context repo, or WHY not
//   node teaching-workspace.mjs roster "$ROOT"             # what that repo declares
//   node teaching-workspace.mjs roster "$ROOT" --json
//
// A teaching workspace is a directory the `teach` skill owns outright — one topic, one mission,
// and the `lessons/`, `reference/`, `learning-records/` and `assets/` that accumulate as the
// topic is learned. They live under a fixed `teaching/` parent inside the context repo. See
// CONTEXT.md at the marketplace root for the term, and note that `lesson` means something else
// entirely in `assistants/[role]/LESSONS.md`.
//
// DECLARED, NEVER DISCOVERED. The roster is read from `context.json`'s `teaching` block, not
// from `ls teaching/`. Same rule as `include`, `assistants`, `roles` and `connections`, with a
// narrower justification than those: nothing loads this block at session start, so it is not
// load-safety that forces the declaration but `audience` — a fact about who may read a workspace
// that a directory cannot express — plus consistency with the rest of the file. A directory
// somebody created is not a workspace, and this reports it as a finding rather than adopting it.
//
// THE ROSTER IS A READ. No pull, no un-shallow, no network of any kind. Asking what workspaces
// exist should be instant, and the session-start hook already pulled this repo.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bashBin, NO_BASH } from './bash-bin.mjs';
import { upsertBlock, parseConfig } from './json-block.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// The audience vocabulary is the SAME one a thread's front-matter uses, in the same order of
// reach. Deliberately not a second vocabulary: a workspace's audience is also the default
// audience for any thread that workspace produces, and two lists would disagree the first time
// one of them gained a value.
export const AUDIENCES = ['working', 'team', 'external'];

// The parent is fixed and not configurable. It is the containment that keeps `teach`'s
// `lessons/` from ever colliding with `assistants/[role]/LESSONS.md` — two unrelated senses of
// one word in one repo. A configurable parent would let a repo opt back into the collision.
export const TEACHING_DIR = 'teaching';

const die = (m) => { console.error(`teaching-workspace.mjs: ${m}`); process.exit(2); };

// ---------------------------------------------------------------- resolving the repo

// Three outcomes, and they must stay distinguishable because their fixes are opposite:
//
//   ok            — a checkout on disk
//   unconfigured  — this project never said which context repo it uses. Fix: name one.
//   opted-out     — this project deliberately has none (`none`/`off`/`false`/`no`/`-`/
//                   `disabled`). Fix: remove that setting, IF you actually wanted one.
//   unreachable   — configured, but the checkout could not be resolved (auth, offline).
//
// Flattening opted-out into unconfigured is the exact failure the whole context system exists to
// prevent: it turns a deliberate silence into a nag, and it invites a "helpful" fallback to some
// other project's repo. The resolver already separates them and exits 1 for both, distinguished
// only by what it says — so this classifies the reason rather than the exit code.
//
// There is deliberately NO fallback that scans ~/.context for candidate repos. That is
// filesystem discovery, and picking a repo because it happens to be on disk is how the wrong
// context gets loaded.
export function resolveRoot({ cwd = process.cwd() } = {}) {
  const bin = bashBin();
  if (!bin) return { status: 'unreachable', root: null, reason: NO_BASH };
  const r = spawnSync(bin, [join(HERE, 'context-repo.sh'), '--no-pull'], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
  const out = (r.stdout ?? '').trim();
  const err = (r.stderr ?? '').trim();
  if (r.status === 0 && out) return { status: 'ok', root: out, reason: null };
  if (/opted out/i.test(err)) return { status: 'opted-out', root: null, reason: err };
  if (/no context repo configured/i.test(err)) return { status: 'unconfigured', root: null, reason: err };
  return { status: 'unreachable', root: null, reason: err || `context-repo.sh exited ${r.status}` };
}

// What to tell a person for each non-ok outcome. One sentence of what is true, one of what to do
// — and a DIFFERENT fix per status, which is the whole reason the statuses are separate.
export const REFUSALS = {
  'opted-out': {
    says: 'This project has deliberately opted out of a context repo, so there is nowhere to keep a teaching workspace.',
    fix: 'That is a setting, not a fault. If you meant to opt out, nothing here applies — learn somewhere else. If you did not, remove the `none` from .claude/settings*.json, the env, or the marker file, and run context-setup.',
  },
  unconfigured: {
    says: 'This project has never said which context repo it uses, so there is no repo to list workspaces from.',
    fix: 'Run context-setup to link this project to one, or init-context to create one. Do not guess a repo — loading the wrong project\'s context is the failure this refusal exists to prevent.',
  },
  unreachable: {
    says: 'A context repo is configured, but its checkout could not be resolved.',
    fix: 'This is the link, not the workspaces: check authentication and connectivity, then run context-doctor.',
  },
};

// ---------------------------------------------------------------- the roster

const readJson = (file) => {
  const raw = readFileSync(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
};

/**
 * Every workspace the repo DECLARES, in declaration order, each annotated with whether what it
 * declares is actually there. Reporting a missing directory or an unrecognised audience is a
 * read, not a repair: none of the three has a derivable correct value, so context-doctor
 * reports them too and neither fixes them.
 */
export function roster(root) {
  const ctxFile = join(root, 'context.json');
  if (!existsSync(ctxFile)) {
    return { root, configured: false, reason: 'no context.json in the checkout', workspaces: [] };
  }
  let ctx;
  try { ctx = readJson(ctxFile); }
  catch (e) { return { root, configured: false, reason: `context.json does not parse (${e.message})`, workspaces: [] }; }

  const block = ctx.teaching;
  if (block === undefined || block === null) {
    return { root, configured: true, declared: false, workspaces: [] };
  }
  if (typeof block !== 'object' || Array.isArray(block)) {
    return { root, configured: true, declared: false, reason: '"teaching" is present but is not an object', workspaces: [] };
  }

  const workspaces = Object.entries(block)
    // A `_`-prefixed key is a comment, the convention this file family already uses
    // (`_comment_include`, `_stakeholdersNote`). Skipping them rather than rejecting unknown
    // keys is what lets the reasoning for a block live beside it.
    .filter(([slug]) => !slug.startsWith('_'))
    .map(([slug, entry]) => {
      const e = (entry && typeof entry === 'object' && !Array.isArray(entry)) ? entry : {};
      const mission = typeof e.mission === 'string' ? e.mission : null;
      // ABSENT IS ABSENT, never a default. A workspace that declares no audience has not been
      // classified; it has not been classified as `working`. Defaulting would silently label
      // every workspace declared before anyone thought about who may read it.
      const audience = typeof e.audience === 'string' ? e.audience : null;
      const dir = join(root, TEACHING_DIR, slug);
      return {
        slug,
        mission,
        audience,
        dir,
        dirExists: existsSync(dir),
        missionExists: mission ? existsSync(join(root, mission)) : false,
        audienceKnown: audience === null ? null : AUDIENCES.includes(audience),
        malformed: !(entry && typeof entry === 'object' && !Array.isArray(entry)),
      };
    });

  return { root, configured: true, declared: true, workspaces };
}

// ---------------------------------------------------------------- the scaffold

// Kebab-case the topic. Deliberately lossy and deliberately stable: the slug is a directory name
// and a config key, so it has to survive being typed again months later.
export function slugify(topic) {
  const s = String(topic)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // "Résumé" and "Resume" are one topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s;
}

// The four directories `teach` expects. A `.gitkeep` goes in each because git does not track
// directories: without one the scaffold would vanish at the first commit, and a workspace that
// does not survive a clone is not in the repo in any sense that matters.
export const WORKSPACE_DIRS = ['lessons', 'reference', 'learning-records', 'assets'];

// NOT created, and their absence is load-bearing rather than an omission. `teach` treats an
// unpopulated mission as its signal to interview the user, and an absent resources file as its
// signal to go and vet sources. A helpful-looking stub full of placeholders reads as populated
// and suppresses both — which are exactly the two behaviours that make its output grounded
// rather than invented. Anyone "completing" the scaffold by adding these is removing the
// feature.
export const DELIBERATELY_ABSENT = [
  { path: 'MISSION.md', why: 'an unpopulated mission is what makes teach interview you; a stub suppresses the interview' },
  { path: 'RESOURCES.md', why: 'an absent resources file is what makes teach go and vet sources; a stub suppresses the vetting' },
];

const notesBody = (topic, slug) => `# Notes — ${topic}

Teaching preferences for this workspace. \`teach\` consults this file when it designs lessons, so
a standing instruction has a chance of being honoured here and nowhere else.

## Standing instructions

1. **Topic vocabulary goes to this repo's \`glossary.md\`.** Do not start a second glossary under
   \`reference/\`. One repo, one glossary: a term defined in two places is a term that will
   disagree with itself, and the repo's glossary is the one everything else already reads.

2. **End each lesson by asking whether anything learned bears on the project.** Not "did that make
   sense" — whether it changes something we are actually doing. Most of the time the answer is no,
   and that is a fine answer. The question is what stops a workspace becoming a private hobby
   running alongside the work.

3. **A thread arising from a lesson cites that lesson.** When the answer to (2) is yes, write it up
   with \`save-thread\` and name the lesson file it came from. A conclusion whose origin is not
   recorded cannot be re-checked when the topic is revisited.

## What this workspace is not

Its \`lessons/\` are HTML documents about a topic. They are **not** \`assistants/[role]/LESSONS.md\`,
which is human-authored, sanitised at write time, about how work should be done, and the only
file a supervisor may read. Nothing here is promoted into that file automatically. If something
learned here really is a lesson in that sense, write it by hand with \`assistant-lesson\`.

## Workspace

\`teaching/${slug}/\` — mission, lessons, reference, learning records and assets.
`;

const readmeBody = () => `# teaching/

Teaching workspaces. One directory per topic, each owned outright by the \`teach\` skill
(\`/mattpocock-skills:teach\`), prepared by \`teach-workspace\`.

## Why this parent directory exists

Containment. \`teach\` writes \`lessons/*.html\`; this repo already has
\`assistants/[role]/LESSONS.md\`, which means something completely unrelated — human-authored,
sanitised, about how work should be done, and the only file a supervisor may read. The fixed
\`teaching/\` parent is what keeps the two senses of "lesson" from ever meeting. It is not
configurable, deliberately.

## Audience

| | What it is | Who it is for |
| --- | --- | --- |
| \`lessons/\` | The taught material | **Team-visible.** Written to be read by someone other than its author. |
| \`reference/\` | Reference documents drawn from vetted sources | **Team-visible.** |
| \`RESOURCES.md\` | The vetted sources themselves | **Team-visible.** |
| \`MISSION.md\` | What this workspace set out to learn, and why | Working notes. |
| \`learning-records/\` | What actually happened in a session: what landed, what did not | Working notes. |
| \`NOTES.md\` | Standing teaching preferences for this workspace | Working notes. |

"Working notes" means readable by anyone with access to this repo, and written for its author
rather than for them. Nothing here is secret; the distinction is about what was *written to be
read*, which is the same distinction a thread's \`audience:\` draws.

Which repo a workspace lives in decides who can read it at all: one in a shared project context
repo is reviewable by that project's people, one in a personal cross-project repo is not.

## This file does not list the workspaces

\`context.json\`'s \`teaching\` block does, and a second list would drift from it. Run
\`teach-workspace\` with no arguments for the roster.
`;

/**
 * What scaffolding this topic would do. Pure: reads the repo, writes nothing, and is what both
 * the preview and the apply run from — so the preview cannot describe one thing and the write
 * do another.
 */
export function planScaffold(root, topic, { audience = null } = {}) {
  const slug = slugify(topic);
  if (!slug) throw new Error(`"${topic}" has no slug in it — name a topic with some letters or digits`);

  const existing = roster(root);
  const declared = existing.workspaces?.find((w) => w.slug === slug) ?? null;
  const wsRel = `${TEACHING_DIR}/${slug}`;
  const wsDir = join(root, TEACHING_DIR, slug);
  // REUSE, never a suffixed near-duplicate. One mission per workspace is teach's whole model, so
  // `deep-learning-2` is almost always a mistake — and refusing outright would make returning to
  // a topic an error, which is the opposite of what a roster is for.
  const reused = Boolean(declared) || existsSync(wsDir);

  const dirs = [];
  for (const d of WORKSPACE_DIRS) {
    const rel = `${wsRel}/${d}`;
    dirs.push({ rel, exists: existsSync(join(wsDir, d)), keep: `${rel}/.gitkeep` });
  }

  const files = [];
  const notesRel = `${wsRel}/NOTES.md`;
  files.push({ rel: notesRel, exists: existsSync(join(wsDir, 'NOTES.md')), body: () => notesBody(topic, slug) });
  // Once per REPO, not once per workspace: it states the audience convention for teaching/ as a
  // whole, and one copy per topic would be four copies to keep in step.
  const readmeRel = `${TEACHING_DIR}/README.md`;
  files.push({ rel: readmeRel, exists: existsSync(join(root, TEACHING_DIR, 'README.md')), body: readmeBody, oncePerRepo: true });

  const missionRel = `${wsRel}/MISSION.md`;
  const declaration = { mission: missionRel, ...(audience ? { audience } : {}) };

  return {
    root,
    topic,
    slug,
    reused,
    declared,
    wsRel,
    wsDir,
    absolute: resolve(wsDir),
    dirs,
    files,
    absent: DELIBERATELY_ABSENT.map((a) => ({ ...a, rel: `${wsRel}/${a.path}` })),
    declaration,
    audience,
    // The mission path is declared BEFORE teach writes it. Until the first teaching session the
    // roster and context-doctor will both say it does not resolve, which is true and is the
    // honest report of a workspace that is prepared but not yet started.
    missionPending: !existsSync(join(root, missionRel)),
    pasteLine: `/mattpocock-skills:teach ${resolve(wsDir)}`,
  };
}

/** Perform a plan. Creates only what is absent; an existing workspace keeps everything it has. */
export function applyScaffold(plan) {
  const created = [];
  mkdirSync(plan.wsDir, { recursive: true });
  for (const d of plan.dirs) {
    const dir = join(plan.root, ...d.rel.split('/'));
    if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); created.push(d.rel + '/'); }
    const keep = join(plan.root, ...d.keep.split('/'));
    if (!existsSync(keep)) writeFileSync(keep, '');
  }
  for (const f of plan.files) {
    const abs = join(plan.root, ...f.rel.split('/'));
    if (existsSync(abs)) continue;               // never overwrite: these are edited by hand
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.body());
    created.push(f.rel);
  }

  // The declaration, written in place. upsertBlock replaces the `teaching` block's value span
  // only, so every comment key, every hand-laid-out inline object and the file's line endings
  // survive — the reason json-block.mjs exists.
  const ctxFile = join(plan.root, 'context.json');
  const raw = readFileSync(ctxFile, 'utf8');
  const current = parseConfig(raw);
  const block = (current.teaching && typeof current.teaching === 'object' && !Array.isArray(current.teaching))
    ? current.teaching : {};
  const next = { ...block, [plan.slug]: { ...(block[plan.slug] ?? {}), ...plan.declaration } };
  const edit = upsertBlock(raw, 'teaching', next);
  if (edit.changed) writeFileSync(ctxFile, edit.text);

  return { created, declaration: edit.action, declarationChanged: edit.changed };
}

// ---------------------------------------------------------------- CLI

// Options that take a value, so `--audience team` does not leave "team" looking like a topic.
const VALUED = ['audience'];
const flagValue = (argv, name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
};

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')[0]));
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { if (!a.includes('=') && VALUED.includes(a.slice(2))) i++; continue; }
    positional.push(a);
  }
  const [cmd, arg] = positional;
  const asJson = flags.has('json');

  if (cmd === 'resolve') {
    const r = resolveRoot();
    if (asJson) { console.log(JSON.stringify(r, null, 2)); }
    else if (r.status === 'ok') { console.log(r.root); }
    else {
      const { says, fix } = REFUSALS[r.status];
      console.error(`teach-workspace — ${r.status}`);
      console.error(`  ${says}`);
      console.error(`  ${fix}`);
      if (r.reason) console.error(`  resolver said: ${r.reason}`);
    }
    process.exit(r.status === 'ok' ? 0 : 1);
  }

  if (cmd === 'roster') {
    let root = arg;
    let resolution = null;
    if (!root) {
      resolution = resolveRoot();
      if (resolution.status !== 'ok') {
        if (asJson) { console.log(JSON.stringify({ ...resolution, workspaces: [] }, null, 2)); }
        else {
          const { says, fix } = REFUSALS[resolution.status];
          console.error(`teach-workspace — ${resolution.status}`);
          console.error(`  ${says}`);
          console.error(`  ${fix}`);
        }
        process.exit(1);
      }
      root = resolution.root;
    }
    if (!existsSync(root)) die(`no such checkout: ${root}`);

    const r = roster(root);
    if (asJson) { console.log(JSON.stringify({ status: 'ok', ...r }, null, 2)); return; }

    console.log(`teaching workspaces — ${r.root}`);
    if (!r.configured) {
      console.log(`  none — ${r.reason}`);
      console.log('  Run context-doctor: the checkout resolved but does not look like a context repo.');
      return;
    }
    if (!r.declared) {
      // Distinct from "could not resolve a repo at all", and said so plainly. Both are empty
      // rosters; only one of them is a problem, and only one of them has a fix.
      console.log('  none declared yet.');
      if (r.reason) console.log(`  (${r.reason})`);
      console.log(`  This repo resolved fine — it simply has no "teaching" block in context.json.`);
      console.log(`  Start one:  /teach-workspace [topic]`);
      return;
    }
    if (!r.workspaces.length) {
      console.log('  none declared yet — the "teaching" block is empty.');
      console.log(`  Start one:  /teach-workspace [topic]`);
      return;
    }
    const w = Math.max(...r.workspaces.map((x) => x.slug.length));
    for (const x of r.workspaces) {
      const notes = [];
      if (x.malformed) notes.push('declaration is not an object');
      if (!x.dirExists) notes.push(`no directory at ${TEACHING_DIR}/${x.slug}`);
      if (!x.mission) notes.push('no mission declared');
      else if (!x.missionExists) notes.push('mission path does not resolve');
      if (x.audienceKnown === false) notes.push(`audience "${x.audience}" is not one of ${AUDIENCES.join('/')}`);
      console.log(`  ${x.slug.padEnd(w)}  ${x.mission ?? '(no mission)'}  ·  audience: ${x.audience ?? '(none declared)'}`);
      for (const n of notes) console.log(`  ${' '.repeat(w)}  ! ${n}`);
    }
    const flagged = r.workspaces.filter((x) => !x.dirExists || !x.missionExists || x.audienceKnown === false || x.malformed).length;
    if (flagged) console.log(`\n  ${flagged} declaration(s) flagged above — context-doctor reports these too. Neither fixes them: none has a derivable correct value.`);
    return;
  }

  if (cmd === 'scaffold') {
    const root = positional[1];
    const topic = positional.slice(2).join(' ');
    if (!root || !topic) die('scaffold needs a checkout and a topic: scaffold "$ROOT" "deep learning"');
    if (!existsSync(root)) die(`no such checkout: ${root}`);
    const audience = flagValue(argv, 'audience');
    const write = flags.has('yes');

    // --audience is REQUIRED to write. Absent is absent, never a default: this tool will not
    // invent a classification for who may read a workspace. Refusing rather than defaulting is
    // what keeps that honest — a `working` picked by a script is indistinguishable from one a
    // person chose, and only one of those two is true.
    if (write && !audience) {
      die(`--audience is required to write: one of ${AUDIENCES.join(', ')}. `
        + 'It says who a workspace was written for and a script must not guess it. '
        + 'It is also the default audience for any thread this workspace produces.');
    }
    if (audience && !AUDIENCES.includes(audience)) {
      die(`--audience "${audience}" is not one of ${AUDIENCES.join(', ')} — the same vocabulary a thread's front-matter uses`);
    }

    let plan;
    try { plan = planScaffold(root, topic, { audience }); }
    catch (e) { die(e.message); }

    const result = write ? applyScaffold(plan) : null;

    if (asJson) {
      console.log(JSON.stringify({
        root, topic, slug: plan.slug, reused: plan.reused, workspace: plan.wsRel, absolute: plan.absolute,
        directories: plan.dirs, files: plan.files.map(({ body, ...f }) => f), deliberatelyAbsent: plan.absent,
        declaration: { teaching: { [plan.slug]: plan.declaration } }, missionPending: plan.missionPending,
        pasteLine: plan.pasteLine, written: Boolean(write), created: result?.created ?? [],
      }, null, 2));
      return;
    }

    console.log(`teach-workspace — ${plan.topic}`);
    console.log(`  slug        ${plan.slug}`);
    console.log(`  workspace   ${plan.wsRel}`);
    if (plan.reused) {
      console.log(`\n  REUSED — this topic already has a workspace. One mission per workspace is teach's`);
      console.log(`  whole model, so this hands back the existing one rather than making a near-duplicate.`);
    }
    console.log(`\n  Directories:`);
    for (const d of plan.dirs) console.log(`    ${d.exists ? 'have' : ' new'}  ${d.rel}/`);
    console.log(`\n  Files:`);
    for (const f of plan.files) {
      console.log(`    ${f.exists ? 'have' : ' new'}  ${f.rel}${f.oncePerRepo ? '   (once per repo, not per workspace)' : ''}`);
    }
    console.log(`\n  NOT created, deliberately:`);
    for (const a of plan.absent) console.log(`    skip  ${a.rel}  — ${a.why}`);
    console.log(`\n  context.json gains:`);
    console.log(`    "teaching": { "${plan.slug}": ${JSON.stringify(plan.declaration)} }`);
    if (!plan.audience) console.log(`    (no audience yet — --audience ${AUDIENCES.join('|')} is required to write)`);
    if (plan.missionPending) {
      console.log(`\n  The mission path is declared before teach writes it, so the roster and`);
      console.log(`  context-doctor will report it as unresolved until the first teaching session.`);
      console.log(`  That is the honest state of a workspace that is prepared but not yet started.`);
    }

    if (!write) {
      console.log(`\n  PLAN ONLY — nothing written. Re-run with --yes --audience ${AUDIENCES.join('|')} to create it.`);
      return;
    }
    console.log(`\n  created ${result.created.length} path(s)${result.declarationChanged ? `, declaration ${result.declaration}` : ', declaration already current'}`);
    for (const c of result.created) console.log(`    + ${c}`);
    console.log(`\n  Paste this to start learning — the path is ABSOLUTE deliberately:\n`);
    console.log(`    ${plan.pasteLine}\n`);
    console.log(`  Nothing was committed and nothing was pushed.`);
    return;
  }

  console.error('usage: teaching-workspace.mjs resolve [--json]');
  console.error('       teaching-workspace.mjs roster [checkout] [--json]');
  console.error('       teaching-workspace.mjs scaffold [checkout] [topic] [--audience working|team|external] [--yes] [--json]');
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith('teaching-workspace.mjs')) main(process.argv.slice(2));
