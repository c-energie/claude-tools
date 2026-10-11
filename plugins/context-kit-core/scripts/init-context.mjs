#!/usr/bin/env node
// Stamp a NEW context repo from c-energie/context-template — and, the first time one is ever
// stamped on this account, bootstrap the cross-project SECOND BRAIN alongside it.
//
//   node init-context.mjs owner/project-context                  # plan only — says what it would do
//   node init-context.mjs owner/project-context --yes            # create, stamp, commit, push
//   node init-context.mjs owner/project-context --name "Thesis" --yes
//   node init-context.mjs owner/project-context --link . --yes   # ...and link THIS project to it
//   node init-context.mjs --second-brain-only --yes              # just the second brain
//   node init-context.mjs owner/repo --no-second-brain --yes     # project repo only
//
// Creating a GitHub repo is outward-facing and cannot be walked back quietly, so **nothing here
// writes to the network without --yes**: the default run is a plan, printing every repo it would
// create and every path it would write. That gate is the safety property; the skill's prose gate
// is the second one.
//
// The second brain is a context repo like any other — same template, same layout — plus the
// overlay in assets/second-brain/ that makes it the CROSS-PROJECT layer: an `include` list, a
// `handoff/` outbox, and a CLAUDE.md stating the read-only contract. It is stamped ONCE, at
// ~/.context/[login]/second-brain, owned by the authenticated GitHub *user* rather than by the
// project's owner — a project context repo often lives under an org, and the personal layer
// above it must not be governed by one project's org.
//
// Idempotent by construction: an existing clone, or an existing repo on GitHub, is adopted and
// left alone rather than re-stamped. Re-running after adding a second project is therefore safe,
// and prints the include-list line to add by hand — this script never writes into an existing
// second brain, because editing a repo the user has been keeping notes in is exactly what the
// cross-project layer's read-only contract forbids.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OVERLAY = join(PLUGIN_ROOT, 'assets', 'second-brain');
const TEMPLATE = process.env.CONTEXT_TEMPLATE_REPO || 'c-energie/context-template';
const OPTIONS = ['yes', 'name', 'link', 'public', 'template', 'today', 'no-second-brain', 'second-brain-only'];
const REPO_RE = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

const die = (m, code = 2) => { console.error(`init-context.mjs: ${m}`); process.exit(code); };
const ok = (m) => console.log(`  ok    ${m}`);
const info = (m) => console.log(`        ${m}`);
const warn = (m) => console.log(`  warn  ${m}`);
const next = (m) => console.log(`  next  ${m}`);
const head = (m) => console.log(`\n${m}`);
const slash = (p) => p.replace(/\\/g, '/');
// Synchronous sleep: a template repo is populated asynchronously by GitHub, so the clone that
// immediately follows `gh repo create --template` can land on an empty tree.
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SharedArrayBuffer */ } };

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flags = new Set();
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (!OPTIONS.includes(key)) die(`unknown option --${key} (use ${OPTIONS.map((o) => `--${o}`).join(', ')})`);
    if (['name', 'link', 'template', 'today'].includes(key)) opts[key] = argv[++i];
    else flags.add(key);
  } else positional.push(a);
}

const go = flags.has('yes');
const sbOnly = flags.has('second-brain-only');
const template = opts.template || TEMPLATE;
const visibility = flags.has('public') ? '--public' : '--private';
const today = opts.today || new Date().toISOString().slice(0, 10);

// Tolerate a pasted browser or clone URL — the same repo, just wearing more clothes.
const clean = (s) => s.replace(/^(https:\/\/|git@)github\.com[/:]/, '').replace(/\.git$/, '').replace(/\/+$/, '');
let projectRepo = null;
if (!sbOnly) {
  if (!positional[0]) die('needs the new context repo as owner/repo, e.g. your-user/thesis-context (or --second-brain-only)');
  projectRepo = clean(positional[0]);
  if (!REPO_RE.test(projectRepo)) die(`not an owner/repo name: ${positional[0]}`);
}

// ---------------------------------------------------------------- shell helpers

const run = (cmd, args, cwd) => spawnSync(cmd, args, {
  encoding: 'utf8',
  cwd,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PAGER: '', GH_PROMPT_DISABLED: '1' },
});
const gh = (...args) => run('gh', args);

const login = (() => {
  const probe = gh('api', 'user', '--jq', '.login');
  if (probe.error) die('the GitHub CLI (gh) is not on PATH — install it and run `gh auth login`, or stamp the repos from the template by hand (see the c-energie/context-template README)');
  if (probe.status !== 0) die(`gh is not authenticated: ${(probe.stderr || '').trim() || 'run `gh auth login`'}`);
  return (probe.stdout || '').trim();
})();

// The second brain belongs to the PERSON, not to whichever org owns the project.
const sbRepo = process.env.SECOND_BRAIN_REPO || `${login}/second-brain`;
if (!REPO_RE.test(sbRepo)) die(`SECOND_BRAIN_REPO is not an owner/repo name: ${sbRepo}`);

// Same layout the resolver uses (scripts/context-repo.sh): ~/.context/[owner]/[repo].
const cloneDir = (remote) => join(homedir(), '.context', ...remote.split('/'));
const remoteExists = (remote) => gh('repo', 'view', remote, '--json', 'nameWithOwner').status === 0;
const isCheckout = (dir) => existsSync(join(dir, '.git'));

// ---------------------------------------------------------------- stamping

// Placeholders are the template's ({{PROJECT_NAME}}, {{OWNER_REPO}}) plus two the overlay uses.
const fillPlaceholders = (dir, values) => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (e.name === '.git' || e.name === 'node_modules') return [];
    const p = join(d, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  let touched = 0;
  for (const file of walk(dir)) {
    const buf = readFileSync(file);
    if (buf.includes(0)) continue;                       // binary — never rewrite it
    const text = buf.toString('utf8');
    if (!text.includes('{{')) continue;
    let out = text;
    for (const [k, v] of Object.entries(values)) out = out.split(`{{${k}}}`).join(v);
    if (out !== text) { writeFileSync(file, out); touched += 1; }
  }
  return touched;
};

// Top-level merge, the overlay's keys winning. The overlay carries only what makes a context
// repo the cross-project layer, so it never has to reach inside a nested object.
const mergeOverlayJson = (contextJson, overlayJson) => {
  const base = JSON.parse(readFileSync(contextJson, 'utf8'));
  const over = JSON.parse(readFileSync(overlayJson, 'utf8'));
  delete over._comment_overlay;                          // about the overlay file, not the repo
  writeFileSync(contextJson, `${JSON.stringify({ ...base, ...over }, null, 2)}\n`);
};

const cloneWithRetry = (remote, dir) => {
  // Something that is not a checkout sitting in the clone path is a person's files until proven
  // otherwise. Only a directory this run created — or an empty one — is ever cleared; anything
  // else stops the stamp and is reported, because `git clone` into it would fail anyway and
  // deleting it would be the one unrecoverable thing this script could do.
  if (existsSync(dir) && !isCheckout(dir)) {
    if (readdirSync(dir).length) {
      warn(`${slash(dir)} exists and is not a git checkout — refusing to touch it; move it aside and re-run`);
      return false;
    }
    rmSync(dir, { recursive: true, force: true });
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    if (!isCheckout(dir)) {
      mkdirSync(dirname(dir), { recursive: true });
      run('git', ['clone', `https://github.com/${remote}.git`, dir]);
    }
    // A template instantiation is populated asynchronously: an empty clone means "not yet",
    // not "broken". context.json is the file every context repo has.
    if (isCheckout(dir) && existsSync(join(dir, 'context.json'))) return true;
    if (attempt < 5) { info(`waiting for ${remote} to be populated (attempt ${attempt}/5)`); sleep(2000); }
  }
  return isCheckout(dir);
};

// Returns 'created' | 'adopted-remote' | 'adopted-local' | 'failed'.
function stamp({ remote, projectName, overlay }) {
  const dir = cloneDir(remote);

  if (isCheckout(dir)) { ok(`${remote} already checked out at ${slash(dir)} — left untouched`); return 'adopted-local'; }
  if (remoteExists(remote)) {
    ok(`${remote} already exists on GitHub — cloning it rather than stamping a new one`);
    if (!cloneWithRetry(remote, dir)) { warn(`could not clone ${remote} — clone it by hand into ${slash(dir)}`); return 'failed'; }
    info(`cloned to ${slash(dir)}; left exactly as it was on GitHub`);
    return 'adopted-remote';
  }

  const create = gh('repo', 'create', remote, '--template', template, visibility);
  if (create.status !== 0) {
    warn(`could not create ${remote}: ${(create.stderr || create.stdout || '').trim()}`);
    return 'failed';
  }
  ok(`created ${remote} from ${template} (${visibility.slice(2)})`);
  if (!cloneWithRetry(remote, dir)) { warn(`created ${remote} but could not clone it — clone it by hand into ${slash(dir)}`); return 'failed'; }
  ok(`cloned to ${slash(dir)}`);

  if (overlay) {
    cpSync(overlay, dir, { recursive: true });
    const overlayJson = join(dir, 'context.overlay.json');
    if (existsSync(overlayJson)) {
      mergeOverlayJson(join(dir, 'context.json'), overlayJson);
      rmSync(overlayJson);
    }
    ok('applied the cross-project overlay (CLAUDE.md, handoff/, empty include list)');
  }

  const filled = fillPlaceholders(dir, {
    PROJECT_NAME: projectName,
    OWNER_REPO: remote,
    OWNER: remote.split('/')[0],
    DATE: today,
  });
  ok(`filled the template placeholders in ${filled} file(s)`);

  // The derivable-key fixes — chiefly the enabledPlugins id, which the template has carried
  // stale before now. A dead id installs cleanly and then simply never loads anything.
  const doctor = run('node', [join(PLUGIN_ROOT, 'scripts', 'context-doctor.mjs'), dir, '--fix', '--json', '--today', today]);
  if (doctor.status === 0) {
    try {
      const report = JSON.parse(doctor.stdout);
      for (const a of report.applied ?? []) ok(`context-doctor fixed ${a}`);
      // A finding that carried a fix has just been applied — it stays in `findings` describing
      // what WAS wrong. Only the ones with nothing derivable are still outstanding.
      const errs = (report.findings ?? []).filter((f) => f.level === 'err' && !f.fix).length;
      if (errs) warn(`context-doctor still reports ${errs} error(s) it cannot derive a fix for — run it against ${slash(dir)} for detail`);
    } catch { /* a doctor whose output will not parse is no reason to fail the stamp */ }
  }

  run('git', ['add', '-A'], dir);
  const msg = overlay
    ? `init: stamp the cross-project second brain from ${template}`
    : `init: stamp this context repo from ${template}`;
  const commit = run('git', ['commit', '-m', msg], dir);
  if (commit.status !== 0 && !/nothing to commit/i.test(commit.stdout || '')) {
    warn(`could not commit in ${slash(dir)}: ${(commit.stderr || commit.stdout || '').trim()}`);
    return 'created';
  }
  const push = run('git', ['push'], dir);
  if (push.status !== 0) warn(`committed locally but could not push ${remote}: ${(push.stderr || '').trim()}`);
  else ok(`pushed the stamped repo to ${remote}`);
  return 'created';
}

// ---------------------------------------------------------------- the plan (the default run)

const projectName = opts.name || (projectRepo
  ? projectRepo.split('/')[1].replace(/[-_]?context$/i, '').replace(/[-_]/g, ' ').trim() || projectRepo.split('/')[1]
  : null);
const wantSecondBrain = !flags.has('no-second-brain');
const sbDir = cloneDir(sbRepo);
const sbPresent = wantSecondBrain && (isCheckout(sbDir) || remoteExists(sbRepo));

if (!go) {
  head('init-context — PLAN ONLY (nothing written). Re-run with --yes to do it.');
  info(`authenticated as ${login}; template ${template}`);
  if (projectRepo) {
    const state = isCheckout(cloneDir(projectRepo)) ? 'already checked out — would be left untouched'
      : remoteExists(projectRepo) ? 'already on GitHub — would be cloned, not stamped'
      : `would be CREATED from ${template} (${visibility.slice(2)}), stamped, committed and pushed`;
    console.log(`\n  project context repo  ${projectRepo}`);
    info(state);
    info(`clone: ${slash(cloneDir(projectRepo))}`);
    info(`name written into context.json / memory.md: ${projectName}`);
  }
  if (wantSecondBrain) {
    console.log(`\n  second brain          ${sbRepo}`);
    info(sbPresent
      ? 'already exists — would be left untouched (this is the first-run bootstrap only)'
      : `would be CREATED from ${template} (${visibility.slice(2)}), overlaid with assets/second-brain/, and pushed`);
    info(`clone: ${slash(sbDir)}`);
  }
  if (opts.link && projectRepo) console.log(`\n  link                  ${slash(resolve(opts.link))} → ${projectRepo}`);
  console.log('');
  process.exit(0);
}

// ---------------------------------------------------------------- do it

if (wantSecondBrain && !sbPresent && !existsSync(OVERLAY)) {
  die(`the second-brain overlay is missing at ${slash(OVERLAY)} — this install did not ship assets/. Report that, and re-run with --no-second-brain to stamp the project repo alone.`);
}

let projectState = null;
if (projectRepo) {
  head(`Project context repo — ${projectRepo}`);
  projectState = stamp({ remote: projectRepo, projectName, overlay: null });
}

let sbState = null;
if (wantSecondBrain) {
  head(`Second brain — ${sbRepo}`);
  if (sbPresent && !isCheckout(sbDir)) {
    // On GitHub but not on this machine: clone it so sessions here work, and change nothing.
    if (cloneWithRetry(sbRepo, sbDir)) ok(`${sbRepo} already exists on GitHub — cloned to ${slash(sbDir)}, unchanged`);
    else warn(`${sbRepo} exists on GitHub but could not be cloned into ${slash(sbDir)}`);
    sbState = 'adopted-remote';
  } else {
    sbState = stamp({ remote: sbRepo, projectName: 'Second brain', overlay: OVERLAY });
  }
}

// ---------------------------------------------------------------- link, then what is left by hand

if (opts.link && projectRepo) {
  head(`Linking ${slash(resolve(opts.link))}`);
  const link = run('node', [join(PLUGIN_ROOT, 'scripts', 'link-context.mjs'), projectRepo, '--project', resolve(opts.link)]);
  process.stdout.write(link.stdout ?? '');
  process.stderr.write(link.stderr ?? '');
}

head('Next');
if (projectRepo && !opts.link) {
  next(`link the project: from its directory, node "${slash(join(PLUGIN_ROOT, 'scripts', 'link-context.mjs'))}" ${projectRepo} --load`);
}
// Only for a repo this run actually stamped: an adopted one already has whatever it has.
if (projectState === 'created') next(`write the first memory.md in ${slash(cloneDir(projectRepo))} — the skeleton's headings are prompts, not rules`);
// The include list is never written for you: see the header comment. Print the exact edit.
if (wantSecondBrain && projectRepo) {
  next("add the project to the second brain's include list BY HAND — nothing here writes into it:");
  info(`${slash(join(sbDir, 'context.json'))}   →   "include": [ ..., "${projectRepo}" ]`);
}
if (sbState === 'created') {
  next(`fill in ${slash(join(sbDir, 'memory.md'))} — who you are across projects`);
  next(`if a project of yours uses Notion or Slack, deny its connectors in ${slash(join(sbDir, '.claude', 'settings.json'))}`);
}
next('connectors and backends: see the c-energie/context-template README, or run the setup-connectors skill');
console.log('');
