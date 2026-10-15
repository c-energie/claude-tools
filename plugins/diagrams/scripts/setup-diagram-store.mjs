#!/usr/bin/env node
// Set up a diagram store for a project: the mechanics behind skills/setup-diagram-store.
// The skill interviews and judges; this script only acts, one named step at a time.
//
//   node setup-diagram-store.mjs [--dry-run] [--root DIR] <step> [flags]
//
//   check                                         tools, gh login, what is named today (read-only)
//   store        --mode adopt|fresh|local --repo O/R [--dir D] [--public-ok]
//                                                 clone, or create PRIVATE, the store
//   stamp        --dir D [--taxonomy]             house files + empty index.jsonl, committed locally
//   push-store   --dir D                          push the store                       (outward)
//   config       --target repo-file|context --repo O/R [--project N] [--cross-org]
//   commit-config --target repo-file|context      commit only the config file, locally
//   push-config  --target repo-file|context       push that one commit                 (outward)
//   prove                                         where + save --dry-run + gallery, from 2 cwds
//
// Every step is safe to re-run: it reuses what is there and REFUSES (exit 2) rather than
// overwrite. --dry-run prints every write and command and performs none (check and prove only
// read, so they run the same either way). Exit 1 is FAILED. Every message starts OK, REFUSED or
// FAILED. Dependency-free Node ESM, like every script in this plugin.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REPO_FILE, findRepoFile, initStore, indexPath, locateStore, originOwner, readConfigSoft,
  readTaxonomy, resolveStore,
} from './diagram-store.mjs';

const here = dirname(fileURLToPath(import.meta.url));

class Refused extends Error {}
class Failed extends Error {}

const usage = (m) => {
  console.error(`REFUSED: ${m}\nusage: setup-diagram-store.mjs [--dry-run] [--root DIR] `
    + 'check | store | stamp | push-store | config | commit-config | push-config | prove');
  process.exit(2);
};

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const VALUED = new Set(['root', 'mode', 'repo', 'dir', 'target', 'project']);
const BOOL = new Set(['dry-run', 'taxonomy', 'cross-org', 'public-ok']);
const opts = {};
const bare = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (!a.startsWith('--')) { bare.push(a); continue; }
  const name = a.slice(2);
  if (BOOL.has(name)) { opts[name] = true; continue; }
  if (!VALUED.has(name)) usage(`unknown option --${name}`);
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) usage(`--${name} needs a value`);
  opts[name] = v;
  i += 1;
}

/** `~` arrives literally from PowerShell and from a quoted Bash argument; resolve() would put it
 *  under the cwd — inside the project — so expand it before anything else sees the path. */
const expand = (p) => resolve(String(p).replace(/^~(?=$|[\\/])/, homedir()));

const DRY = !!opts['dry-run'];
const ROOT = expand(opts.root ?? process.cwd());
if (!existsSync(ROOT) || !statSync(ROOT).isDirectory()) usage(`--root ${ROOT} is not a directory`);
// The context resolver works from the cwd, so --root has to become it.
process.chdir(ROOT);

// ---------------------------------------------------------------- helpers

const say = (m = '') => console.log(m);
const need = (name) => opts[name] ?? (() => { throw new Refused(`this step needs --${name}`); })();
const slugOk = (r) => /^[^/\s]+\/[^/\s]+$/.test(r);
const samePath = (a, b) => {
  const r = relative(resolve(a), resolve(b));
  return r === '';
};
const inside = (child, parent) => {
  const r = relative(resolve(parent), resolve(child));
  return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r));
};

/** Run a command, or print it under --dry-run. Throws Failed with the command's stderr. */
function run(cmd, args, { cwd = ROOT, outward = false } = {}) {
  const shown = `${cmd} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  if (DRY) { say(`  would run${outward ? ' (outward)' : ''}: ${shown}`); return ''; }
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Failed(`${shown}\n${(r.stderr || r.error?.message || '').trim()}`);
  }
  say(`  ran: ${shown}`);
  return (r.stdout ?? '').trim();
}

/** Read-only command: runs even under --dry-run; null on failure. */
function probe(cmd, args, cwd = ROOT) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

/** Write with LF endings, or print it under --dry-run. */
function write(path, text) {
  if (DRY) { say(`  would write ${path}:\n${text.replace(/^/gm, '    ')}`); return; }
  writeFileSync(path, text.replace(/\r\n/g, '\n'), 'utf8');
  say(`  wrote ${path}`);
}

/** JSON from a file a person may have saved from PowerShell: tolerate the BOM, name the file. */
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
    throw new Failed(`${path} is not valid JSON (${e.message}) — fix it by hand, then re-run`);
  }
}

const sameRepo = (url, repo) => {
  const m = String(url ?? '').match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return !!m && `${m[1]}/${m[2]}`.toLowerCase() === repo.toLowerCase();
};

const defaultDir = (repo) => join(homedir(), ...repo.split('/'));
const storeDir = (repo) => (opts.dir ? expand(opts.dir) : defaultDir(repo));
const hasCommits = (dir) => !!probe('git', ['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD']);

/** A store checkout must be its own repo, never nested in the project or in any other work
 *  tree: a nested repo is an embedded repo there, and gets committed or pushed along with it. */
function refuseNested(dir) {
  if (inside(dir, ROOT)) throw new Refused(`${dir} is inside the project (${ROOT}). Pick a --dir outside it — the default is ~/[owner]/[repo].`);
  let up = dirname(dir);
  while (!existsSync(up) && dirname(up) !== up) up = dirname(up);
  const top = probe('git', ['-C', up, 'rev-parse', '--show-toplevel']);
  if (top && !samePath(top, dir)) throw new Refused(`${dir} would sit inside the git work tree ${top}. Pick a --dir outside any repo.`);
}

/** The file `config` writes for a target, and the repo that holds it. */
function configTarget(target) {
  if (target === 'repo-file') {
    const rf = findRepoFile(ROOT);
    if (!rf.root) {
      throw new Refused(`${ROOT} is not inside a git repo, so it has no repo root for ${REPO_FILE}.\n`
        + 'Use --target context, or run from inside the repo whose diagrams these are.');
    }
    // Only the repo's own root: a walk that ended in some ancestor repo (a dotfiles repo in ~)
    // would write, commit and push the store into the wrong project.
    if (!samePath(rf.root, ROOT)) {
      throw new Refused(`${ROOT} is not a repo root — it sits inside ${rf.root}. `
        + `Re-run with --root "${rf.root}" if that is the project, else use --target context.`);
    }
    return { file: join(rf.root, REPO_FILE), repoDir: rf.root };
  }
  if (target === 'context') {
    const { cfg, why } = readConfigSoft();
    if (!cfg) {
      throw new Refused(`no context repo (${why}).\nUse --target repo-file, or set one up first `
        + 'with context-kit-core:context-setup.');
    }
    return { file: resolve(cfg.path), repoDir: dirname(resolve(cfg.path)), cfg };
  }
  throw new Refused(`--target must be repo-file or context, got ${target}`);
}

const SOURCE_OF = { 'repo-file': 'repo-file', context: 'context.json' };
const COMMIT_MSG = 'Name the diagram store';

// ---------------------------------------------------------------- steps

const steps = {
  check() {
    let bad = 0;
    say('tools');
    for (const [cmd, args] of [['git', ['--version']], ['gh', ['--version']], ['node', ['--version']]]) {
      const v = probe(cmd, args);
      say(`  [${v ? 'OK' : 'FAIL'}] ${cmd}${v ? `  ${v.split('\n')[0]}` : '  not found'}`);
      if (!v) bad += 1;
    }
    const login = probe('gh', ['api', 'user', '--jq', '.login']);
    say(`  [${login ? 'OK' : 'FAIL'}] gh login${login ? `  ${login}` : '  — run: gh auth login'}`);
    if (!login) bad += 1;

    say('\nthis project');
    let rf;
    try { rf = findRepoFile(ROOT); } catch (e) { throw new Failed(`${REPO_FILE} near ${ROOT} is not valid JSON (${e.message})`); }
    const owner = originOwner(ROOT);
    const { cfg, why } = readConfigSoft();
    say(`  root        ${ROOT}`);
    say(`  repo root   ${rf.root ?? '(not inside a git repo)'}${rf.root && !samePath(rf.root, ROOT) ? '   (ROOT is a subdirectory)' : ''}`);
    say(`  origin      ${owner ?? '(no GitHub origin)'}`);
    say(`  context     ${cfg ? cfg.path : `(none: ${why})`}`);
    if (process.env.DIAGRAM_STORE_DIR) say(`  checkout dir DIAGRAM_STORE_DIR=${process.env.DIAGRAM_STORE_DIR}`);
    if (process.env.DIAGRAMS_STORE) {
      say(`  NOTE        DIAGRAMS_STORE=${process.env.DIAGRAMS_STORE} is set for this shell only; it overrides`);
      say('              any config and is not a setup. Unset it before continuing.');
    }

    // Named-and-refused is not the same as unnamed: locate first, resolve second.
    let loc = null;
    try { loc = locateStore({ cwd: ROOT }); } catch { /* nothing named */ }
    if (loc && loc.source !== 'env') {
      try {
        const s = resolveStore({ cwd: ROOT, mustExist: false });
        const cloned = existsSync(join(s.dir, '.git'));
        say(`  store       ${s.repo}  (named by ${s.source}: ${s.configPath})`);
        say(`  checkout    ${s.dir}${cloned ? '' : '   NOT CLONED'}`);
        say(`  boundary    ${s.boundary}`);
        say(cloned ? '\nSTATE set-up — named and cloned; `prove` confirms it.'
          : '\nSTATE named-not-cloned — run `store --mode adopt` (or `local` with --dir, plus DIAGRAM_STORE_DIR).');
      } catch (e) {
        say(`  store       named by ${loc.source} (${loc.configPath}) but REFUSED:`);
        say(e.message.replace(/^/gm, '                '));
        say('\nSTATE named-refused — fix the named config by hand with the user; a new setup would be refused.');
      }
    } else {
      const home = owner ?? cfg?.json?.contextRepo?.split('/')[0];
      say('  store       none named');
      if (home) {
        const vis = probe('gh', ['repo', 'view', `${home}/diagrams`, '--json', 'visibility', '--jq', '.visibility']);
        say(`  suggestion  ${home}/diagrams  (${vis ? `exists on GitHub, ${vis.toLowerCase()} — adopt` : 'not on GitHub — fresh'}); confirm with the user`);
      }
      say(`  target      ${cfg ? 'context repo found — ask: repo-file or context' : 'no context repo — repo-file'}`);
      say('\nSTATE unnamed — a new setup.');
    }
    if (bad) throw new Failed(`${bad} check(s) failed`);
  },

  store() {
    const mode = need('mode');
    const repo = need('repo');
    if (!slugOk(repo)) throw new Refused(`--repo must be owner/repo, got ${repo}`);
    if (!['adopt', 'fresh', 'local'].includes(mode)) throw new Refused(`--mode must be adopt, fresh or local, got ${mode}`);
    const dir = storeDir(repo);
    let reuse = false;

    if (existsSync(dir)) {
      if (existsSync(join(dir, '.git'))) {
        const url = probe('git', ['-C', dir, 'remote', 'get-url', 'origin']);
        if (url && !sameRepo(url, repo)) {
          throw new Refused(`${dir} is a checkout of ${url}, not ${repo}. Pick another --dir; this never re-points a repo.`);
        }
        if (url) reuse = true;
        else if (hasCommits(dir)) {
          throw new Refused(`${dir} is a git repo with commits and no origin — its history is not a store's. Pick another --dir.`);
        } else if (mode !== 'fresh') {
          throw new Refused(`${dir} is an empty git repo with no origin (a half-finished fresh run?). `
            + `Delete it (rm -rf "${dir}") and re-run --mode ${mode}.`);
        }
      } else if (readdirSync(dir).length) {
        throw new Refused(`${dir} exists, is not a git repo, and is not empty. Pick another --dir.`);
      }
    } else if (mode === 'local') {
      throw new Refused(`--mode local needs an existing checkout at ${dir}`);
    }
    if (!reuse) refuseNested(dir);

    const vis = probe('gh', ['repo', 'view', repo, '--json', 'visibility', '--jq', '.visibility']);
    if (vis && vis !== 'PRIVATE' && !opts['public-ok']) {
      throw new Refused(`${repo} is ${vis.toLowerCase()} on GitHub: every diagram saved there is readable by `
        + 'anyone it is visible to. Make it private, or re-run with --public-ok on the user\'s explicit say-so.');
    }

    if (reuse) say(`  kept ${dir} (origin ${repo})`);
    else if (mode === 'adopt') {
      if (!vis) throw new Refused(`${repo} is not on GitHub (or not visible to this gh login) — use --mode fresh.`);
      run('gh', ['repo', 'clone', repo, dir]);
    } else if (mode === 'fresh') {
      if (vis) throw new Refused(`${repo} already exists on GitHub (${vis.toLowerCase()}) — use --mode adopt.`);
      if (!DRY) mkdirSync(dir, { recursive: true });
      if (!existsSync(join(dir, '.git'))) run('git', ['init', '-b', 'main', dir]);
      // Private, always: a store is a permission boundary, and there is no flag to say otherwise.
      run('gh', ['repo', 'create', repo, '--private', '--source', dir, '--remote', 'origin',
        '--description', 'Diagram store: SVG/HTML source, index.jsonl, gallery (diagrams plugin).'], { outward: true });
    }
    if (DRY) return;
    const url = probe('git', ['-C', dir, 'remote', 'get-url', 'origin']);
    if (!sameRepo(url, repo)) throw new Failed(`after store, ${dir} has origin ${url ?? '(none)'}, expected ${repo}`);
    if (!samePath(dir, defaultDir(repo)) && !(process.env.DIAGRAM_STORE_DIR && samePath(process.env.DIAGRAM_STORE_DIR, dir))) {
      say(`  NOTE ${dir} is not the default checkout: set DIAGRAM_STORE_DIR=${dir} permanently on this machine`);
    }
    say(`OK ${dir} is a checkout of ${repo}`);
  },

  stamp() {
    const dir = expand(need('dir'));
    if (!existsSync(join(dir, '.git'))) throw new Refused(`${dir} is not a git checkout — run \`store\` first.`);
    const want = ['README.md', '.gitattributes', '.gitignore', 'index.jsonl'];
    if (DRY) {
      for (const f of want) say(`  ${existsSync(join(dir, f)) ? 'keep       ' : 'would write'} ${f}`);
      if (opts.taxonomy) say(`  ${existsSync(join(dir, 'taxonomy.json')) ? 'keep       ' : 'would write'} taxonomy.json (starter)`);
      say('  would commit only the files it writes');
      return;
    }
    const r = initStore(dir, { taxonomy: !!opts.taxonomy });
    if (r.skipped.length) say(`  kept  ${r.skipped.join(', ')}`);
    if (r.written.length) {
      say(`  wrote ${r.written.join(', ')}`);
      run('git', ['-C', dir, 'add', '--', ...r.written]);
      // `-- files` commits those paths alone: nothing the user had staged, none of their edits.
      run('git', ['-C', dir, 'commit', '-m', 'diagram store: house files', '--', ...r.written]);
    }
    const missing = want.filter((f) => !existsSync(join(dir, f)));
    if (missing.length) throw new Failed(`still missing after stamp: ${missing.join(', ')}`);
    const untracked = want.filter((f) => !probe('git', ['-C', dir, 'ls-files', '--error-unmatch', '--', f]));
    if (untracked.length) {
      throw new Failed(`not tracked by git: ${untracked.join(', ')} (gitignored, or left uncommitted by an earlier run). `
        + 'Commit them by hand with the user.');
    }
    say(`OK ${dir} has ${want.join(', ')}, committed`);
  },

  'push-store'() {
    const dir = expand(need('dir'));
    if (!hasCommits(dir)) throw new Refused(`${dir} has no commits — run \`stamp\` first.`);
    run('git', ['-C', dir, 'push', '-u', 'origin', 'HEAD'], { outward: true });
    if (DRY) return;
    const ahead = probe('git', ['-C', dir, 'rev-list', '--count', '@{u}..HEAD']);
    if (ahead !== '0') throw new Failed(`${dir} is still ${ahead ?? '?'} commit(s) ahead of its upstream`);
    say(`OK ${dir} matches its upstream`);
  },

  config() {
    const target = need('target');
    const repo = need('repo');
    if (!slugOk(repo)) throw new Refused(`--repo must be owner/repo, got ${repo}`);
    // No `dir`: both files are committed and shared, and a checkout path is one machine's fact.
    if (opts.dir) throw new Refused('config takes no --dir: the file is shared, a checkout path is not. '
      + 'For a non-default checkout set DIAGRAM_STORE_DIR on that machine instead.');
    const { file, repoDir, cfg } = configTarget(target);

    // A higher rung would shadow what this writes: refuse before writing, not after.
    if (process.env.DIAGRAMS_STORE) throw new Refused('DIAGRAMS_STORE is set and would override the config — unset it, then re-run.');
    if (target === 'context') {
      const rf = findRepoFile(ROOT);
      if (rf.json) throw new Refused(`${rf.path} names ${rf.json.repo ?? '(nothing)'} and takes precedence over context.json — use --target repo-file, or remove it with the user.`);
      // Edit the context repo only at its tip, or push-config is rejected as behind.
      if (!DRY) probe('git', ['-C', repoDir, 'fetch', '-q']);
      const behind = probe('git', ['-C', repoDir, 'rev-list', '--count', 'HEAD..@{u}']);
      if (behind && behind !== '0') throw new Refused(`the context repo is ${behind} commit(s) behind — pull first: git -C "${repoDir}" pull --ff-only`);
    }

    // The org boundary, refused here as well as on every resolve: setup is where the decision
    // is made, and --cross-org is the user saying so, recorded as crossOrg: true.
    const home = originOwner(ROOT) ?? (cfg ?? readConfigSoft().cfg)?.json?.contextRepo?.split('/')[0] ?? null;
    const storeOwner = repo.split('/')[0];
    const cross = !!home && home.toLowerCase() !== storeOwner.toLowerCase();
    if (cross && !opts['cross-org']) {
      throw new Refused(`${repo} belongs to ${storeOwner}, but this work belongs to ${home}. `
        + 'Diagrams saved here would be readable by everyone with access to that store.\n'
        + 'Only with the user\'s explicit say-so: re-run with --cross-org (recorded as "crossOrg": true).');
    }

    /** An existing block for the same repo is kept — unless it cannot work as it stands. */
    const keepOrRefuse = (cur, where) => {
      if (cur.repo !== repo) throw new Refused(`${where} already names ${cur.repo}. Change it by hand with the user if that is wrong; this never replaces a named store.`);
      if (cross && cur.crossOrg !== true) throw new Refused(`${where} names ${repo} but lacks "crossOrg": true, so it is refused on every save. Add it by hand with the user.`);
      say(`  kept ${where} (names ${repo})`);
    };

    if (target === 'repo-file') {
      if (existsSync(file)) {
        const cur = readJson(file);
        if (!cur.repo) throw new Refused(`${file} exists but names no "repo". Fix or delete it by hand with the user.`);
        keepOrRefuse(cur, file);
      } else {
        const block = { repo };
        if (opts.project) block.project = opts.project;
        if (cross) block.crossOrg = true;
        write(file, `${JSON.stringify(block, null, 2)}\n`);
      }
    } else {
      const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const json = readJson(file);
      const cur = json.state?.diagrams ?? null;
      if (cur?.repo) keepOrRefuse(cur, `${file} state.diagrams`);
      else {
        // Merge into whatever state.diagrams already holds (org, dir): only `repo` is new.
        const diagrams = { ...(cur ?? {}), repo, ...(cross ? { crossOrg: true } : {}) };
        // A top-level `"state": null` is replaced in place so a hand-formatted file keeps its
        // shape — only when that is the file's one such match; otherwise re-serialise the whole.
        const nulls = raw.match(/"state"\s*:\s*null/g) ?? [];
        const next = json.state === null && nulls.length === 1
          ? raw.replace(/"state"\s*:\s*null/, `"state": ${JSON.stringify({ diagrams })}`)
          : `${JSON.stringify({ ...json, state: { ...(json.state ?? {}), diagrams } }, null, 2)}\n`;
        const parsed = JSON.parse(next);
        for (const k of Object.keys(json)) if (k !== 'state' && JSON.stringify(parsed[k]) !== JSON.stringify(json[k])) {
          throw new Failed(`internal: rewriting ${file} would change "${k}" — stopped, nothing written`);
        }
        for (const k of Object.keys(json.state ?? {})) if (k !== 'diagrams' && JSON.stringify(parsed.state[k]) !== JSON.stringify(json.state[k])) {
          throw new Failed(`internal: rewriting ${file} would change state.${k} — stopped, nothing written`);
        }
        write(file, next);
      }
    }

    if (DRY) return;
    // Done means: THIS file names the store, and the checkout it points at exists.
    const s = resolveStore({ cwd: ROOT, mustExist: false });
    if (s.repo !== repo || s.source !== SOURCE_OF[target] || !samePath(s.configPath, file)) {
      throw new Failed(`written, but ${ROOT} resolves to ${s.repo} via ${s.source} (${s.configPath}), not via ${file}.`);
    }
    if (!existsSync(join(s.dir, '.git'))) {
      throw new Failed(`${file} names ${repo}, but there is no checkout at ${s.dir}. Clone it there (\`store\`), `
        + 'or set DIAGRAM_STORE_DIR permanently to where it is, then re-run config.');
    }
    say(`OK ${ROOT} resolves to ${repo} via ${s.source} (boundary ${s.boundary}), checkout ${s.dir}`);
  },

  'commit-config'() {
    const { file, repoDir } = configTarget(need('target'));
    if (!existsSync(file)) throw new Refused(`${file} does not exist — run \`config\` first.`);
    const dirty = probe('git', ['-C', repoDir, 'status', '--porcelain', '--', file]);
    if (dirty) {
      run('git', ['-C', repoDir, 'add', '--', file]);
      // `-- file` commits that path alone, whatever else the user has staged.
      run('git', ['-C', repoDir, 'commit', '-m', COMMIT_MSG, '--', file]);
    }
    if (DRY) return;
    if (probe('git', ['-C', repoDir, 'status', '--porcelain', '--', file])) throw new Failed(`${file} is still uncommitted`);
    say(`OK ${file} is committed in ${repoDir}`);
  },

  'push-config'() {
    const { file, repoDir } = configTarget(need('target'));
    const upstream = probe('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', '@{u}']);
    if (!upstream) throw new Refused(`${repoDir} has no upstream branch. Push by hand with the user: git -C "${repoDir}" push -u origin HEAD`);
    const ahead = Number(probe('git', ['-C', repoDir, 'rev-list', '--count', '@{u}..HEAD']) ?? NaN);
    if (ahead === 0) { say(`OK ${repoDir} matches its upstream`); return; }
    // Consent was for one commit naming the store: push it only when it is the only one.
    const touched = probe('git', ['-C', repoDir, 'show', '--name-only', '--format=%s', 'HEAD'])?.split('\n').filter(Boolean) ?? [];
    const rel = relative(repoDir, file).replace(/\\/g, '/');
    if (ahead !== 1 || touched[0] !== COMMIT_MSG || touched.length !== 2 || touched[1] !== rel) {
      const log = probe('git', ['-C', repoDir, 'log', '--oneline', '@{u}..HEAD']) ?? '';
      throw new Refused(`${repoDir} has ${ahead} unpushed commit(s), not just "${COMMIT_MSG}":\n${log}\n`
        + 'Pushing would publish all of them. Ask the user; they push by hand if they agree.');
    }
    run('git', ['-C', repoDir, 'push'], { outward: true });
    if (DRY) return;
    const left = probe('git', ['-C', repoDir, 'rev-list', '--count', '@{u}..HEAD']);
    if (left !== '0') throw new Failed(`${repoDir} is still ${left ?? '?'} commit(s) ahead`);
    say(`OK ${repoDir} matches its upstream`);
  },

  prove() {
    if (process.env.DIAGRAMS_STORE) throw new Refused('DIAGRAMS_STORE is set: a proof would prove the env var, not the setup. Unset it.');
    let s;
    try { s = resolveStore({ cwd: ROOT, mustExist: true }); } catch (e) { throw new Failed(e.message); }
    const sub = readdirSync(ROOT).find((n) => !n.startsWith('.') && statSync(join(ROOT, n)).isDirectory()
      && !existsSync(join(ROOT, n, '.git')));
    const cwds = [ROOT, ...(sub ? [join(ROOT, sub)] : [])];
    if (!sub) say(`NOTE ${ROOT} has no plain subdirectory: proving from one working directory only`);

    // A status the store's vocabulary accepts, so a closed taxonomy does not fail a good setup.
    const statuses = readTaxonomy(s.dir).statuses;
    const status = !statuses.length || statuses.includes('current') ? 'current' : statuses[0];

    const idx = indexPath(s.dir);
    const hash = () => (existsSync(idx) ? createHash('sha256').update(readFileSync(idx)).digest('hex') : 'absent');
    const before = hash();
    const tmp = mkdtempSync(join(tmpdir(), 'diagram-prove-'));
    const svg = join(tmp, 'setup-probe.svg');
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><text x="10" y="25">setup probe</text></svg>\n');
    let bad = 0;
    try {
      for (const cwd of cwds) {
        say(`from ${cwd}`);
        const checks = [
          ['where', [join(here, 'diagram-store.mjs'), 'where'], (o) => o.includes(`repo     ${s.repo}`)],
          ['save --dry-run', [join(here, 'save-diagram.mjs'), svg, '--title', 'setup probe', '--status', status, '--dry-run'],
            (o) => o.includes(s.repo) && o.includes('dry run')],
          ['gallery', [join(here, 'gallery-build.mjs'), '--out', join(tmp, 'gallery.html')], (o) => o.includes('built')],
        ];
        for (const [name, args, ok] of checks) {
          const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
          const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
          const pass = r.status === 0 && ok(out);
          if (!pass) bad += 1;
          say(`  [${pass ? 'OK' : 'FAIL'}] ${name}${pass ? '' : `\n${out.trim().replace(/^/gm, '      ')}`}`);
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    if (hash() !== before) throw new Failed(`index.jsonl changed during prove — that must never happen (${idx})`);
    if (bad) throw new Failed(`${bad} proof check(s) failed`);
    say(`OK ${s.repo} resolves, saves (dry run) and builds from ${cwds.length} working director${cwds.length > 1 ? 'ies' : 'y'}`);
  },
};

// ---------------------------------------------------------------- main

const step = bare[0];
if (!step || !steps[step]) usage(step ? `unknown step ${step}` : 'which step?');
if (bare.length > 1) usage(`one step at a time, got ${bare.join(' ')}`);
try {
  if (DRY) say('(dry run — nothing is written or run)\n');
  steps[step]();
} catch (e) {
  if (e instanceof Refused) { console.error(`REFUSED: ${e.message}`); process.exit(2); }
  console.error(`FAILED: ${e.message ?? e}`);
  process.exit(1);
}
