#!/usr/bin/env node
// Stamp a NEW context repo from c-energie/context-template.
//
//   node init-context.mjs owner/project-context                  # plan only — says what it would do
//   node init-context.mjs owner/project-context --yes            # create, stamp, commit, push
//   node init-context.mjs owner/project-context --name "Thesis" --yes
//   node init-context.mjs owner/project-context --link . --yes   # ...and link THIS project to it
//
// Creating a GitHub repo is outward-facing and cannot be walked back quietly, so **nothing here
// writes to the network without --yes**: the default run is a plan, printing the repo it would
// create and the path it would write. That gate is the safety property; the skill's prose gate
// is the second one.
//
// An existing clone, or an existing repo on GitHub, is adopted and left alone rather than
// re-stamped, so re-running is safe.
//
// It stamps no cross-project layer: ADR 0002 retired that. The personal layer is a workspace,
// loaded through the user-level ~/.claude/CLAUDE.md, and nothing here creates it.
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = process.env.CONTEXT_TEMPLATE_REPO || 'c-energie/context-template';
const OPTIONS = ['yes', 'name', 'link', 'public', 'template', 'today'];
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
const template = opts.template || TEMPLATE;
const visibility = flags.has('public') ? '--public' : '--private';
const today = opts.today || new Date().toISOString().slice(0, 10);

// Tolerate a pasted browser or clone URL — the same repo, just wearing more clothes.
const clean = (s) => s.replace(/^(https:\/\/|git@)github\.com[/:]/, '').replace(/\.git$/, '').replace(/\/+$/, '');
if (!positional[0]) die('needs the new context repo as owner/repo, e.g. your-user/thesis-context');
const projectRepo = clean(positional[0]);
if (!REPO_RE.test(projectRepo)) die(`not an owner/repo name: ${positional[0]}`);

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

// Same layout the resolver uses (scripts/context-repo.sh): ~/.context/[owner]/[repo].
const cloneDir = (remote) => join(homedir(), '.context', ...remote.split('/'));
const remoteExists = (remote) => gh('repo', 'view', remote, '--json', 'nameWithOwner').status === 0;
const isCheckout = (dir) => existsSync(join(dir, '.git'));

// ---------------------------------------------------------------- stamping

// Placeholders are the template's: {{PROJECT_NAME}}, {{OWNER_REPO}}, {{OWNER}}, {{DATE}}.
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
function stamp({ remote, projectName }) {
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
  const commit = run('git', ['commit', '-m', `init: stamp this context repo from ${template}`], dir);
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

const projectName = opts.name
  || projectRepo.split('/')[1].replace(/[-_]?context$/i, '').replace(/[-_]/g, ' ').trim()
  || projectRepo.split('/')[1];

if (!go) {
  head('init-context — PLAN ONLY (nothing written). Re-run with --yes to do it.');
  info(`authenticated as ${login}; template ${template}`);
  const state = isCheckout(cloneDir(projectRepo)) ? 'already checked out — would be left untouched'
    : remoteExists(projectRepo) ? 'already on GitHub — would be cloned, not stamped'
    : `would be CREATED from ${template} (${visibility.slice(2)}), stamped, committed and pushed`;
  console.log(`\n  project context repo  ${projectRepo}`);
  info(state);
  info(`clone: ${slash(cloneDir(projectRepo))}`);
  info(`name written into context.json / memory.md: ${projectName}`);
  if (opts.link) console.log(`\n  link                  ${slash(resolve(opts.link))} → ${projectRepo}`);
  console.log('');
  process.exit(0);
}

// ---------------------------------------------------------------- do it

head(`Project context repo — ${projectRepo}`);
const projectState = stamp({ remote: projectRepo, projectName });

// ---------------------------------------------------------------- link, then what is left by hand

if (opts.link) {
  head(`Linking ${slash(resolve(opts.link))}`);
  const link = run('node', [join(PLUGIN_ROOT, 'scripts', 'link-context.mjs'), projectRepo, '--project', resolve(opts.link)]);
  process.stdout.write(link.stdout ?? '');
  process.stderr.write(link.stderr ?? '');
}

head('Next');
if (!opts.link) {
  next(`link the project: from its directory, node "${slash(join(PLUGIN_ROOT, 'scripts', 'link-context.mjs'))}" ${projectRepo} --load`);
}
// Only for a repo this run actually stamped: an adopted one already has whatever it has.
if (projectState === 'created') next(`write the first memory.md in ${slash(cloneDir(projectRepo))} — the skeleton's headings are prompts, not rules`);
next('connectors and backends: see the c-energie/context-template README, or run the setup-connectors skill');
console.log('');
