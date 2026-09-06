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

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { bashBin, NO_BASH } from './bash-bin.mjs';

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

// ---------------------------------------------------------------- CLI

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.slice(2)));
  const positional = argv.filter((a) => !a.startsWith('--'));
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

  console.error('usage: teaching-workspace.mjs resolve [--json]');
  console.error('       teaching-workspace.mjs roster [checkout] [--json]');
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith('teaching-workspace.mjs')) main(process.argv.slice(2));
