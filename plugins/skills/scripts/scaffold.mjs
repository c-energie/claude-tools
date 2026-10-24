#!/usr/bin/env node
// scaffold.mjs — turn an author-setup-skill interview spec into a first draft of a setup skill.
//
//   node scaffold.mjs --spec spec.json --out [repo]/.claude/skills/[skill] [--dry-run]   repo-local
//   node scaffold.mjs --spec spec.json --plugin [plugin dir] [--dry-run]                plugin-shipped
//   node scaffold.mjs --example                    print a complete example spec
//   node scaffold.mjs --help                       print this header
//
// Writes two files: SKILL.md (the recipe's shape, with every judgement the spec could not answer
// left as a TODO(author) marker) and the step script named by spec.script — a dependency-free
// skeleton with named steps, --dry-run, --root, reuse-don't-clobber helpers and, for owned state,
// read/write helpers for the state file. The script's extension picks its language: `.py` is
// stdlib Python run through uv, `.mjs` is node built-ins only. Refuses to overwrite either file —
// a re-run after hand edits must never destroy them.
//
// Repo-local (--out): both files go into [repo]/.claude/skills/[skill]/, the script beside its
// SKILL.md, and the script's --root defaults to the repo three levels above it.
// Plugin-shipped (--plugin, instead of --out): SKILL.md goes to [plugin]/skills/[skill]/ and the
// script to [plugin]/scripts/, called as ${CLAUDE_PLUGIN_ROOT}/scripts/… --root
// "${CLAUDE_PROJECT_DIR}". There --root is required: the script cannot know which project it
// is setting up from where it sits, and guessing the cwd writes into whatever directory the
// agent happened to be in.
//
// State is one of two shapes (spec.stateFile xor spec.existingState):
//   owned  — stateFile `x.json` or `x.toml`: a file this setup creates; missing means "not set up".
//   joined — existingState {files, check}: a record other skills defined, which this setup only
//            fills in; `check` failing means "not set up". No state helpers are generated.
//
// Unless spec.observer is false, also makes sure the step-0 setup-observer sits beside the
// skill: when [skills dir]/setup-observer/ is absent, copies SKILL.md and observe.py verbatim
// from this plugin's assets/setup-observer/ and writes observer.toml from the spec; repo-local
// mode also adds `.setup/` to the repo's .gitignore (a plugin has no project .gitignore to edit
// — observe.py's baseline git-ignores .setup/ through info/exclude wherever it runs). When the
// observer is present, leaves it alone and reports whether its two copied files have drifted.
// Exit 0 written (or would write), 1 bad spec or arguments, 2 refused.
//
// Dependency-free Node ESM, like every script in this marketplace.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'setup-observer');
const OBSERVER_FILES = ['SKILL.md', 'observe.py'];

// No `trigger`: for owned state it is derived from the state file being missing, which is the
// observable condition the recipe wants. A spec may still give one to override it.
const EXAMPLE = {
  skill: 'setup-widget-workspace',
  script: 'setup_widget.py',
  title: 'Set up a widget workspace',
  does: 'First-run setup of a widget workspace — create the widget repo from its template and prove a widget builds',
  stateFile: 'widget.json',
  observer: {
    owners: [
      { repo: 'c-energie/widget-workspace-template', covers: 'these setup skills and their scripts' },
      { repo: 'c-energie/widget-template', covers: 'the widget template and its init.py' },
    ],
    envVars: ['WIDGET_HOME'],
    secretVars: ['WIDGET_TOKEN'],
  },
  tools: ['git', 'gh', 'uv'],
  questions: [
    { ask: 'Widget short name', default: 'this directory\'s name' },
    { ask: 'GitHub owner for the new repo', default: 'the gh login from check' },
    { ask: 'Visibility', default: 'private' },
  ],
  modes: {
    question: 'Does a widget repo already exist?',
    rows: [
      { answer: 'Yes, keep its history', mode: 'adopt', effect: 'clone it and overlay the template\'s agent files' },
      { answer: 'No', mode: 'fresh', effect: 'new repo from c-energie/widget-template' },
    ],
  },
  steps: [
    { name: 'repo', does: 'create or adopt the widget repo', outward: true,
      args: ['--mode', '--repo', '--dir'], done: 'the checkout exists at --dir and its origin is --repo' },
    { name: 'root', does: 'write widget.json', args: ['--dir'], done: 'widget.json parses and names --dir' },
  ],
  invariants: [
    { rule: 'an existing widget repo is never modified', step: 'repo' },
  ],
  proof: { step: 'prove', does: 'build one widget end to end', cwds: ['the workspace root', 'the widget repo'],
    done: 'a widget file lands in build/' },
  neighbours: 'adapt-existing-widget (bringing old widgets in)',
};

const fail = (code, msg) => { process.stderr.write(`scaffold: ${msg}\n`); process.exit(code); };

function parseArgs(argv) {
  const a = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--example') a.example = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--spec' || k === '--out' || k === '--plugin') {
      if (argv[i + 1] === undefined) fail(1, `\`${k}\` needs a value`);
      a[k.slice(2)] = argv[++i];
    } else fail(1, `unknown argument \`${k}\` (see --help)`);
  }
  return a;
}

const SLUG = /^[a-z][a-z0-9-]*$/;
// One language per extension. Python keeps its module-name rule (no hyphens); node files are
// named like this marketplace's own scripts (setup-diagram-store.mjs).
const LANG = { py: /^[a-z][a-z0-9_]*\.py$/, mjs: /^[a-z][a-z0-9_-]*\.mjs$/ };
const STEP = /^[a-z][a-z0-9-]*$/;
const FLAG = /^--[a-z][a-z0-9-]*$/;

// Flags the generated parser already owns, or that would shadow its dispatch.
const RESERVED = new Set(['--help', '--dry-run', '--root', '--step', '--from']);
const KEYS = new Set(['skill', 'script', 'title', 'does', 'trigger', 'stateFile', 'existingState', 'observer',
  'tools', 'questions', 'modes', 'steps', 'invariants', 'proof', 'neighbours']);
const OBSERVER_KEYS = new Set(['owners', 'tools', 'envVars', 'secretVars', 'stateFiles']);
const EXISTING_KEYS = new Set(['files', 'check']);

const langOf = (script) => (script.endsWith('.mjs') ? 'mjs' : 'py');

function validate(s) {
  const errs = [];
  const need = (k, test, what) => { if (!test(s[k])) errs.push(`\`${k}\`: ${what}`); };
  const str = (v) => typeof v === 'string' && v.trim() !== '';
  for (const k of Object.keys(s)) if (!KEYS.has(k)) errs.push(`\`${k}\`: unknown key (see --example)`);
  need('skill', (v) => str(v) && SLUG.test(v), 'lower-case slug, e.g. setup-widget-workspace');
  need('script', (v) => str(v) && Object.values(LANG).some((re) => re.test(v)),
    'the step script, its extension picking the language: setup_widget.py (stdlib Python, run through uv) '
    + 'or setup-widget.mjs (node built-ins only); no other language');
  need('title', (v) => str(v) && !/"""|\\|`|\$\{/.test(v),
    'the SKILL.md heading (no """, backslash, backtick or ${: it becomes a docstring or a string literal)');
  need('does', str, 'what the skill does — the front of its description');
  if (s.trigger !== undefined) need('trigger', str, 'when to use it — the rest of its description (omit it to derive one from the state)');
  need('steps', (v) => Array.isArray(v) && v.length > 0, 'at least one step');
  need('proof', (v) => v && str(v.step) && STEP.test(v.step) && str(v.does) && Array.isArray(v.cwds),
    '{step: lower-case name, does, cwds: [two or more working directories], done}');

  // Owned xor joined. Neither leaves later skills nothing to read and the skill no trigger;
  // both leaves it unclear which one "set up" means.
  const owned = s.stateFile !== undefined, joined = s.existingState !== undefined;
  if (owned && joined) errs.push('`stateFile` and `existingState`: give exactly one — a file this setup owns, or a record it joins');
  if (!owned && !joined) errs.push('`stateFile` or `existingState`: give exactly one — `stateFile: "widget.json"` for state this setup owns, `existingState: {files, check}` for a record it only fills in');
  if (owned) {
    if (!(str(s.stateFile) && /\.(json|toml)$/.test(s.stateFile))) {
      errs.push('`stateFile`: the owned state file, its extension picking the format — widget.json, or widget.toml only if people hand-edit it');
    } else if (str(s.script) && langOf(s.script) === 'mjs' && s.stateFile.endsWith('.toml')) {
      errs.push('`stateFile`: a node script cannot own a .toml file — node has no built-in TOML parser and the skeleton takes no dependency; use .json, or a .py script');
    }
  }
  if (joined) {
    const e = s.existingState;
    if (!e || typeof e !== 'object' || Array.isArray(e)) errs.push('`existingState`: {files: [where the record lives], check: "the command that succeeds once it is filled in"}');
    else {
      for (const k of Object.keys(e)) if (!EXISTING_KEYS.has(k)) errs.push(`existingState.${k}: unknown key`);
      if (!(Array.isArray(e.files) && e.files.length && e.files.every(str))) errs.push('existingState.files: the files the record lives in, e.g. [".diagrams.json", "context.json"]');
      if (!str(e.check)) errs.push('existingState.check: a command that exits 0 once the record is filled in — failing is the trigger');
    }
  }

  // Every one of these lands in the generated description, which is front-matter.
  for (const [k, v] of [['does', s.does], ['trigger', s.trigger], ['existingState.check', s.existingState?.check],
    ['stateFile', s.stateFile], ['title', s.title]]) {
    if (str(v) && /[<>]/.test(v)) errs.push(`\`${k}\`: no angle brackets — it goes into front-matter, where the ingester drops the field; use [placeholder]`);
  }
  const names = new Set(['check']);
  for (const [i, st] of (s.steps || []).entries()) {
    if (!st || !str(st.name) || !STEP.test(st.name)) { errs.push(`steps[${i}].name: lower-case step name`); continue; }
    if (names.has(st.name)) errs.push(`steps[${i}].name: \`${st.name}\` is used twice (\`check\` is always generated)`);
    names.add(st.name);
    if (!str(st.does)) errs.push(`steps[${i}].does: one line on what the step does`);
    const seen = new Set();
    for (const f of st.args || []) {
      if (!FLAG.test(f)) errs.push(`steps[${i}].args: \`${f}\` is not a --long-flag`);
      else if (RESERVED.has(f)) errs.push(`steps[${i}].args: \`${f}\` is reserved by the generated script`);
      else if (seen.has(f)) errs.push(`steps[${i}].args: \`${f}\` is listed twice`);
      seen.add(f);
    }
    if ((st.args || []).includes('--mode') && !s.modes) errs.push(`steps[${i}].args: \`--mode\` needs a \`modes\` table`);
  }
  if (s.proof && str(s.proof.step)) {
    if (names.has(s.proof.step)) errs.push(`proof.step: \`${s.proof.step}\` clashes with a step name`);
    if (Array.isArray(s.proof.cwds) && s.proof.cwds.length < 2) errs.push('proof.cwds: name at least two working directories (recipe lesson 8)');
  }
  for (const [i, inv] of (s.invariants || []).entries()) {
    if (!inv || !str(inv.rule)) errs.push(`invariants[${i}].rule: the rule that must never break`);
    else if (inv.step && (inv.step === 'check' || !names.has(inv.step))) {
      errs.push(`invariants[${i}].step: \`${inv.step}\` is not one of \`steps\` (check and the proof only read)`);
    }
  }
  for (const [i, q] of (s.questions || []).entries()) if (!q || !str(q.ask)) errs.push(`questions[${i}].ask: the question`);
  const o = s.observer;
  if (o !== undefined && typeof o !== 'boolean') {
    const strs = (v) => v === undefined || (Array.isArray(v) && v.every(str));
    if (typeof o !== 'object' || o === null) errs.push('`observer`: true, false, or {owners, tools, envVars, secretVars, stateFiles}');
    else {
      for (const k of Object.keys(o)) if (!OBSERVER_KEYS.has(k)) errs.push(`observer.${k}: unknown key`);
      for (const k of ['tools', 'envVars', 'secretVars', 'stateFiles']) if (!strs(o[k])) errs.push(`observer.${k}: a list of strings`);
      if (o.owners !== undefined && !(Array.isArray(o.owners) && o.owners.every((r) => r && str(r.repo) && str(r.covers)))) {
        errs.push('observer.owners: a list of {repo: "owner/name", covers: "what it owns"}');
      }
    }
  }
  if (s.modes) {
    const rows = Array.isArray(s.modes.rows) ? s.modes.rows : [];
    const modes = rows.map((r) => r && r.mode);
    if (!rows.length || !modes.every((m) => str(m) && STEP.test(m)) || new Set(modes).size !== modes.length) {
      errs.push('modes.rows: one or more rows of {answer, mode, effect}, each mode a unique lower-case slug');
    }
  }
  return errs;
}

// ---------------------------------------------------------------------------
// SKILL.md
// ---------------------------------------------------------------------------

const TODO = 'TODO(author)';
const lc = (v) => `${v[0].toLowerCase()}${v.slice(1)}`;

/** How the SKILL.md (and the script's own docs) invoke the script, per language and mode. A
 *  plugin-shipped script names the project explicitly; a repo-local one finds it from its own
 *  location, so the command stays short. */
function runLine(s, ctx) {
  const path = ctx.plugin ? `"\${CLAUDE_PLUGIN_ROOT}/scripts/${s.script}"` : `.claude/skills/${s.skill}/${s.script}`;
  const root = ctx.plugin ? ' --root "${CLAUDE_PROJECT_DIR}"' : '';
  return `${ctx.lang === 'py' ? 'uv run --no-project --python 3.12' : 'node'} ${path}${root}`;
}

/** The description's trigger: the spec's own, else the observable condition its state gives. */
function trigger(s) {
  if (s.trigger) return s.trigger;
  const asks = `or the user asks to ${lc(s.title.trim().replace(/\.+$/, ''))}`;
  return s.stateFile ? `Use when ${s.stateFile} is missing at the project root, ${asks}`
    : `Use when \`${s.existingState.check}\` fails, ${asks}`;
}

function skillMd(s, ctx) {
  const outward = s.steps.filter((st) => st.outward).map((st) => `\`${st.name}\``);
  const L = [];
  // JSON's double-quoted string is valid YAML, so a ': ' or '#' in the prose cannot break the field.
  const desc = `${s.does.trim().replace(/\.+$/, '')}. ${trigger(s).trim().replace(/\.+$/, '')}.`;
  L.push('---', `name: ${s.skill}`, `description: ${JSON.stringify(desc)}`, '---', '');
  L.push(`# ${s.title}`, '');
  if (s.observer !== false) {
    // A plugin's skills are namespaced; a bare /setup-observer would find nothing unless the
    // project happens to carry its own copy too.
    L.push(`**First, invoke \`/${ctx.plugin ? `${ctx.plugin}:` : ''}setup-observer\`** (once per session): it records where this guide and`,
      'reality disagree, so the maintainer can fix the guide.', '');
  }
  if (s.existingState) {
    L.push(`This skill fills in a record that other skills define, in ${s.existingState.files.map((f) => `\`${f}\``).join(' / ')}.`,
      'Until it is filled in, this fails — and once this skill is done, it succeeds:', '',
      '```bash', s.existingState.check, '```', '');
  }
  L.push(`${TODO}: the end state, as a directory tree — what exists when this skill is done.`, '');
  const where = ctx.plugin ? `\`scripts/${s.script}\` in this plugin` : `\`${s.script}\` beside this file`;
  L.push(`All mechanical work is done by ${where}. Your job is the interview,`,
    'running its steps in order, and the judgement work the script cannot do.');
  L.push(...(ctx.lang === 'py' ? ['Run it through uv — the system Python may be too old:'] : ['Run it with node:']),
    '', '```bash', `${runLine(s, ctx)} <step> [flags]`, '```', '');
  L.push('Abbreviated below as `SETUP <step>`. Every step accepts `--dry-run` (before `<step>`); use it',
    'to show the user the plan before the first outward-facing step.', '');
  L.push('Rules:',
    '- **Ask, don\'t guess** wherever the interview says ask. Offer the default in brackets.',
    '- **Ask before every commit and every push**, per repo. The script never commits.');
  if (outward.length) {
    L.push(`- Outward-facing steps (${outward.join(', ')}) run only after the step-1 read-back gets an`,
      '  explicit yes. If auto mode blocks one, hand the user the command to run themselves: short',
      '  lines, no `\\` continuations, JSON read from a file.');
  }
  L.push('- Stop on the first failed step. Diagnose, fix, re-run that step — every step is safe to',
    '  re-run (it reuses what exists rather than overwriting it).', '');

  L.push('## 0. Prerequisites', '', '```bash', 'SETUP check', '```', '');
  L.push(`Done when \`check\` exits 0. After any install the user opens a **new terminal** (and restarts`,
    `Claude Code) so PATH picks it up. If \`${ctx.lang === 'py' ? 'uv' : 'node'}\` itself is missing, give its install command first.`, '');

  L.push('## 1. Interview', '', 'Ask in this order, a few questions at a time. Collect everything before running anything.', '');
  let n = 0;
  for (const q of s.questions || []) {
    n++;
    L.push(`${n}. **${q.ask}**${q.default ? ` [${q.default}]` : ''}${q.why ? ` — ${q.why}` : ''}`);
  }
  if (s.modes) {
    n++;
    L.push(`${n}. **${s.modes.question || `${TODO}: the question that picks the mode`}** This picks the mode:`, '',
      '   | Answer | Mode | What happens |', '   |---|---|---|');
    for (const r of s.modes.rows) L.push(`   | ${r.answer || TODO} | \`${r.mode}\` | ${r.effect || TODO} |`);
    L.push('', `   ${TODO}: which mode to recommend when the user is unsure, and why.`);
  }
  if (!n) L.push(`${TODO}: the questions, in order, each with its default in brackets.`);
  L.push('', 'Read back a summary table — every repo, directory and mode, and every outward-facing step —',
    'and get an explicit yes. Done when the user has said yes to the table as shown.', '');

  let h = 2;
  const invFor = (name) => (s.invariants || []).filter((i) => i.step === name);
  for (const st of s.steps) {
    L.push(`## ${h++}. ${st.does[0].toUpperCase()}${st.does.slice(1)}`, '', '```bash',
      `SETUP ${st.name}${(st.args || []).map((f) => ` ${f} <${f.slice(2)}>`).join('')}`, '```', '');
    if (st.outward) L.push('Outward-facing: covered by the step-1 read-back. Run `--dry-run` first and show it.', '');
    for (const inv of invFor(st.name)) {
      L.push(`Guardrail — ${inv.rule}. \`${st.name}\` enforces it in code; it must refuse, not warn. ${TODO}: say what it prints on refusal.`, '');
    }
    L.push(`Done when ${st.done || `${TODO}: what must be TRUE (not merely exist) — a stale file also exists`}.`, '');
  }
  const loose = (s.invariants || []).filter((i) => !i.step);
  if (loose.length) {
    L.push(`${TODO}: these invariants have no enforcing step yet — give each one a script check, then cite it above:`);
    for (const inv of loose) L.push(`- ${inv.rule}`);
    L.push('');
  }

  const p = s.proof;
  L.push(`## ${h++}. Prove it`, '', `${p.does[0].toUpperCase()}${p.does.slice(1)} — the real pipeline, not a check of its parts.`,
    'Run it once per working directory below, passing each as `--from`; a proof run from one place',
    'only hides every path bug the other places would hit:', '');
  for (const c of p.cwds) L.push(`- ${c}`);
  L.push('', '```bash', `SETUP ${p.step} --from <dir>`, '```', '',
    `Done when ${p.done || `${TODO}: the observable result`} — from every directory above.`, '');

  L.push(`## ${h++}. Commit and finish`, '',
    '1. In each repo touched, show `git status` and propose a commit. Ask before each commit and each push.',
    s.stateFile ? `2. Point the user at \`${s.stateFile}\` — every later skill reads it instead of re-asking.`
      : `2. Run \`${s.existingState.check}\` once more: it must succeed now, or this skill re-triggers next session.`,
    `3. ${TODO}: the optional next skill, if any.`, '');
  L.push(`**Not this skill:** ${s.neighbours || `${TODO}: the neighbouring skills that own the adjacent jobs`}.`, '');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// the step script — Python
// ---------------------------------------------------------------------------

const pyIdent = (name) => name.replace(/-/g, '_');
const pyStr = (v) => JSON.stringify(String(v));
// Prose pasted into the module docstring: nothing in it may close the docstring or start an escape.
const doc = (v) => String(v).replace(/\\/g, '/').replace(/"""/g, "'''");

/** check, then the spec's steps, then the proof — the one sequence both skeletons share, so a
 *  .py and a .mjs from the same spec list the same steps in the same order. */
const allSteps = (s) => [...s.steps, { name: s.proof.step, does: s.proof.does, args: ['--from'], proof: true }];

/** The step table in each script's own docs, shared so both languages list it identically. */
function stepTable(s, indent) {
  const steps = allSteps(s);
  const w = Math.max(5, ...steps.map((st) => st.name.length)) + 2;
  return [`${indent}${'check'.padEnd(w)}prerequisites, with the install command for anything missing`,
    ...steps.map((st) => `${indent}${st.name.padEnd(w)}${doc(st.does)}`)];
}

function pyScript(s, ctx) {
  const steps = allSteps(s);
  const L = [];
  L.push('#!/usr/bin/env python3', `"""${s.title}.`, '',
    `Driven by the \`${s.skill}\` skill, which does the interview and then calls the steps below in`,
    'order. Each step is also runnable by hand, and each refuses rather than overwrites when its',
    'target already exists:', '', ...stepTable(s, '    '));
  L.push('', 'Run with uv so no system Python is needed:', '', `    ${runLine(s, ctx)} check`, '',
    ctx.plugin ? '--root is required: this script ships in a plugin and cannot tell from where it sits which project it sets up.'
      : '--root defaults to the repo this script sits in (three levels up); pass it to aim a copy at a scratch directory.',
    '', 'Stdlib only.', '"""');
  L.push(`import argparse
import json
import shutil
import subprocess
import sys${s.stateFile?.endsWith('.toml') ? '\nimport tomllib' : ''}
from pathlib import Path

`);
  if (!ctx.plugin) L.push(`# .claude/skills/${s.skill}/${s.script} -> the repo root, unless --root says otherwise
DEFAULT_ROOT = Path(__file__).resolve().parents[3]
`);
  L.push(`# Set from --root in main(), before any step runs.
ROOT = None`);
  if (s.stateFile) L.push(`STATE_FILE = None  # ROOT / ${pyStr(s.stateFile)}`);
  else {
    L.push(`# Joined state: this setup fills in a record other skills define, in
#   ${s.existingState.files.join(', ')}
# and is done when this succeeds: ${s.existingState.check}
# The schema is theirs, so there are no state helpers here — read and write it as they do.`);
  }
  L.push(`
DRY_RUN = False


# ---------------------------------------------------------------------------
# install commands, per platform
# ---------------------------------------------------------------------------

def _os():
    return {"win32": "windows", "darwin": "macos"}.get(sys.platform, "linux")


# ${TODO}: an install command per tool per platform. Remind the user a new terminal is needed.
INSTALL = {`);
  for (const t of s.tools || []) {
    L.push(`    ${pyStr(t)}: {"windows": "${TODO}", "macos": "${TODO}", "linux": "${TODO}"},`);
  }
  L.push(`}


# ---------------------------------------------------------------------------
# helpers — every write goes through these, so --dry-run covers it
# ---------------------------------------------------------------------------

def say(msg=""):
    print(msg, flush=True)


class Refused(Exception):
    """A step met something it must not touch. The message is the fix."""


def run(cmd, cwd=None, stdin=None, check=True):
    """Run for the side effect. Honours --dry-run."""
    say(f"$ {' '.join(map(str, cmd))}" + (f"   (in {cwd})" if cwd else ""))
    if DRY_RUN:
        return None
    return subprocess.run(list(map(str, cmd)), cwd=cwd, input=stdin, text=True, check=check)


def quiet(cmd, cwd=None):
    """Run for the answer, not the side effect. Reads only, so it ignores --dry-run."""
    r = subprocess.run(list(map(str, cmd)), cwd=cwd, text=True, capture_output=True)
    return r.stdout.strip() if r.returncode == 0 else None


def write(path, text, replace=False, root=None):
    """Write a file with LF endings, inside root (default ROOT) or refuse. An existing file
    with different content is refused unless replace=True — reuse, don't clobber. Identical
    content is a no-op. A relative path is taken from root, not the cwd."""
    path = inside(path, root or ROOT)
    if path.exists():
        if path.read_text(encoding="utf-8") == text:
            say(f"= {path} (unchanged)")
            return
        if not replace:
            raise Refused(f"{path} already exists with different content; move it aside or edit it by hand")
    say(f"> {path}")
    if not DRY_RUN:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\\n")


def inside(path, root):
    """Refuse any destination outside root — the guardrail for every copy or write target.
    Symlinks are resolved first, so a link inside root that points out does not pass. ~ is
    expanded first: PowerShell and a quoted Bash argument pass it literally (recipe lesson 11)."""
    root = Path(root).expanduser().resolve()
    path = Path(path).expanduser()
    path = (path if path.is_absolute() else root / path).resolve()
    if path != root and root not in path.parents:
        raise Refused(f"{path} is outside {root}; refusing to write there")
    return path


def root_dir(given):
    """The project this run sets up, from --root.`);
  if (ctx.plugin) {
    L.push(`    Required: a plugin-shipped script sits in the plugin's install directory, so where it is says
    nothing about the project, and the cwd is wherever the agent happened to be."""
    if given is None:
        raise Refused('--root is required: pass --root "\${CLAUDE_PROJECT_DIR}", the project this sets up')
    root = Path(given).expanduser().resolve()`);
  } else {
    L.push(`    Defaults to the repo this script sits in."""
    root = Path(given).expanduser().resolve() if given is not None else DEFAULT_ROOT`);
  }
  L.push(`    if not root.is_dir():
        raise Refused(f"--root {root} is not a directory")
    return root
`);
  if (s.stateFile?.endsWith('.toml')) {
    L.push(`
def load_state():
    """The state file as a dict; {} until it exists. A hand-edit that broke it is refused, not
    overwritten — it may hold answers the user typed."""
    if not STATE_FILE.exists():
        return {}
    try:
        return tomllib.loads(STATE_FILE.read_text(encoding="utf-8"))
    except ValueError as e:
        raise Refused(f"{STATE_FILE} is not valid TOML ({e}); fix it by hand, then re-run")


def save_state(**updates):
    """Merge flat scalar keys (str, bool, int, float) into the state file. Later skills read
    it instead of re-asking the user; it is committed, so never a machine path (recipe lesson 2).
    ${TODO}: tables, if the state needs them."""
    state = {**load_state(), **updates}
    lines = []
    for k, v in state.items():
        key = k if k and all(c.isalnum() or c in "_-" for c in k) else json.dumps(k)
        if isinstance(v, bool):
            lines.append(f"{key} = {'true' if v else 'false'}")
        elif isinstance(v, (int, float)):
            lines.append(f"{key} = {v!r}")
        elif isinstance(v, str):
            lines.append(f"{key} = {json.dumps(v)}")  # a JSON string is a valid TOML basic string
        else:
            raise Refused(f"state key {k!r} is a {type(v).__name__}; save_state writes scalars only — extend it")
    write(STATE_FILE, "\\n".join(lines) + "\\n", replace=True)
`);
  } else if (s.stateFile) {
    L.push(`
def load_state():
    """The state file as a dict; {} until it exists. A hand-edit that broke it is refused, not
    overwritten — it may hold answers the user typed."""
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8-sig"))
    except ValueError as e:
        raise Refused(f"{STATE_FILE} is not valid JSON ({e}); fix it by hand, then re-run")


def save_state(**updates):
    """Merge top-level keys into the state file. Later skills read it instead of re-asking the
    user; it is committed, so never a machine path (recipe lesson 2)."""
    write(STATE_FILE, json.dumps({**load_state(), **updates}, indent=2) + "\\n", replace=True)
`);
  }
  L.push(`
# ---------------------------------------------------------------------------
# steps — each returns an exit code, and is safe to re-run
# ---------------------------------------------------------------------------

def cmd_check(args):
    missing = 0
    for tool, how in INSTALL.items():
        if shutil.which(tool):
            say(f"OK   {tool}")
        else:
            missing += 1
            say(f"FAIL {tool} — install: {how[_os()]}")
    if missing:
        say("After installing, open a NEW terminal (and restart Claude Code) so PATH picks it up.")
    return 1 if missing else 0
`);
  for (const st of steps) {
    L.push('', `def cmd_${pyIdent(st.name)}(args):`, `    ${pyStr(st.does)}`);
    for (const c of stepComments(s, st)) L.push(`    # ${c}`);
    L.push(`    say("${TODO}: implement step ${st.name}")`, '    return 4  # not implemented: never 0, so a stub cannot pass for a done step');
  }
  L.push('', '', `def main(argv=None):
    global DRY_RUN, ROOT${s.stateFile ? ', STATE_FILE' : ''}
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="print what would run; change nothing")
    ap.add_argument("--root", help=${pyStr(ctx.plugin ? 'the project to set up (required)' : 'the project to set up (default: the repo this script sits in)')})
    sub = ap.add_subparsers(dest="step", required=True)

    sub.add_parser("check", help="prerequisites, with the install command for anything missing")`);
  for (const st of steps) {
    L.push('', `    p = sub.add_parser(${pyStr(st.name)}, help=${pyStr(st.does)})`);
    if (st.proof) {
      L.push('    p.add_argument("--from", dest="from_dir", required=True, help="the working directory to run the proof from (pass cwd=args.from_dir to run())")');
      continue;
    }
    for (const f of st.args || []) {
      if (f === '--mode' && s.modes) {
        L.push(`    p.add_argument("--mode", choices=(${s.modes.rows.map((r) => pyStr(r.mode)).join(', ')},), required=True)`);
      } else {
        L.push(`    p.add_argument(${pyStr(f)}, required=True)  # ${TODO}: help text; optional?`);
      }
    }
  }
  const table = ['"check": cmd_check', ...steps.map((st) => `${pyStr(st.name)}: cmd_${pyIdent(st.name)}`)];
  L.push('', `    args = ap.parse_args(argv)
    DRY_RUN = args.dry_run
    steps = {${table.join(', ')}}
    try:
        ROOT = root_dir(args.root)${s.stateFile ? `\n        STATE_FILE = ROOT / ${pyStr(s.stateFile)}` : ''}
        return steps[args.step](args)
    except Refused as e:
        say(f"REFUSED: {e}")
        return 3
    except FileNotFoundError as e:
        say(f"MISSING: {e.filename} is not on PATH. Run the check step; on Windows, resolve .cmd shims with shutil.which first.")
        return 1
    except subprocess.CalledProcessError as e:
        say(f"FAILED: {' '.join(map(str, e.cmd))} exited {e.returncode}. Fix the cause, then re-run this step.")
        return e.returncode or 1


if __name__ == "__main__":
    sys.exit(main())
`);
  return L.join('\n');
}

/** The TODO comments inside each step stub — identical in both languages bar the comment marker. */
function stepComments(s, st) {
  const c = [];
  if (st.outward) c.push('Outward-facing: the skill gets an explicit yes before this runs. Reuse an existing', 'target (repo, checkout) rather than recreating it, so a re-run is safe.');
  for (const i of (s.invariants || []).filter((x) => x.step === st.name)) c.push(`GUARDRAIL: ${i.rule}. Enforce it here and refuse — never warn and carry on.`);
  if (st.proof) c.push('Run the real pipeline from the --from directory (the skill runs this once per working', 'directory) and check the observable result, not that a file exists.');
  if (st === s.steps[s.steps.length - 1]) {
    c.push(s.stateFile ? `${TODO}: save the state here, so the state file the skill triggers on exists afterwards.`
      : `${TODO}: fill in the joined record here, so \`${s.existingState.check}\` succeeds afterwards.`);
  }
  return c;
}

// ---------------------------------------------------------------------------
// the step script — node
// ---------------------------------------------------------------------------

// The node skeleton keeps the Python one's contract line for line — same steps, same flags,
// same OK/REFUSED/FAILED/MISSING lines and the same exit codes (3 refused, 4 not implemented,
// 2 usage) — so an author moving between the two, or an audit reading either, finds the same
// shape. Node built-ins only: the script runs in someone else's project, with no install step.

const jsIdent = (name) => `cmd${name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('')}`;
const jsStr = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
// Prose pasted into a // or /** comment: no line break may end it early, no */ close it.
const jsDoc = (v) => String(v).replace(/[\r\n]+/g, ' ').replace(/\*\//g, '* /');
// Text pasted into a template literal, kept verbatim: a backtick would end it, and ${ in a
// plugin's run line (${CLAUDE_PLUGIN_ROOT}) would be read as an interpolation.
const jsTpl = (v) => String(v).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

function nodeScript(s, ctx) {
  const steps = allSteps(s);
  const L = [];
  L.push('#!/usr/bin/env node', `// ${s.script} — ${jsDoc(s.title)}. Run with --help for the steps.`, '//',
    `// Driven by the \`${s.skill}\` skill. Node built-ins only, so it needs no install in the project`,
    '// it sets up. Exit 0 done, 1 FAILED or a tool missing, 2 usage, 3 REFUSED, 4 a step not yet implemented.', '');
  L.push(`import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = basename(fileURLToPath(import.meta.url));

// --help prints this. The same text as the Python skeleton's docstring.
const DOC = \`${jsTpl(s.title)}.

Driven by the ${jsTpl(`\`${s.skill}\``)} skill, which does the interview and then calls the steps below in
order. Each step is also runnable by hand, and each refuses rather than overwrites when its
target already exists:

${stepTable(s, '    ').map(jsTpl).join('\n')}

Run with:

    ${jsTpl(runLine(s, ctx))} check

${ctx.plugin ? '--root is required: this script ships in a plugin and cannot tell from where it sits which project it sets up.'
    : '--root defaults to the repo this script sits in (three levels up); pass it to aim a copy at a scratch directory.'}

Node built-ins only.\`;
`);
  if (!ctx.plugin) L.push(`// .claude/skills/${s.skill}/${s.script} -> the repo root, unless --root says otherwise
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
`);
  L.push('// Set from --root in main(), before any step runs.', 'let ROOT = null;');
  if (s.stateFile) L.push(`let STATE_FILE = null;  // join(ROOT, ${jsStr(s.stateFile)})`);
  else {
    L.push(`// Joined state: this setup fills in a record other skills define, in
//   ${jsDoc(s.existingState.files.join(', '))}
// and is done when this succeeds: ${jsDoc(s.existingState.check)}
// The schema is theirs, so there are no state helpers here — read and write it as they do.`);
  }
  L.push(`let DRY_RUN = false;

// ---------------------------------------------------------------------------
// install commands, per platform
// ---------------------------------------------------------------------------

const os = () => ({ win32: 'windows', darwin: 'macos' }[process.platform] ?? 'linux');

// ${TODO}: an install command per tool per platform. Remind the user a new terminal is needed.
const INSTALL = {`);
  for (const t of s.tools || []) {
    L.push(`  ${jsStr(t)}: { windows: '${TODO}', macos: '${TODO}', linux: '${TODO}' },`);
  }
  L.push(`};

// ---------------------------------------------------------------------------
// helpers — every write goes through these, so --dry-run covers it
// ---------------------------------------------------------------------------

const say = (msg = '') => console.log(msg);

/** A step met something it must not touch. The message is the fix. */
class Refused extends Error {}
/** A command exited non-zero. */
class Failed extends Error { constructor(cmd, code) { super(\`\${cmd} exited \${code}\`); this.cmd = cmd; this.code = code; } }
/** A command is not on PATH. */
class Missing extends Error { constructor(cmd) { super(cmd); this.cmd = cmd; } }

const shown = (cmd, args) => [cmd, ...args].map(String).join(' ');

/** Run for the side effect. Honours --dry-run. On Windows a .cmd shim (gh, npm) is not found by
 *  name: resolve it with which() first. */
function run(cmd, args = [], { cwd, stdin, check = true } = {}) {
  say(\`$ \${shown(cmd, args)}\` + (cwd ? \`   (in \${cwd})\` : ''));
  if (DRY_RUN) return null;
  const r = spawnSync(cmd, args.map(String), {
    cwd, input: stdin, encoding: 'utf8', stdio: [stdin === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
  });
  if (r.error?.code === 'ENOENT') throw new Missing(cmd);
  if (r.error) throw r.error;
  if (check && r.status !== 0) throw new Failed(shown(cmd, args), r.status);
  return r;
}

/** Run for the answer, not the side effect. Reads only, so it ignores --dry-run. */
function quiet(cmd, args = [], { cwd } = {}) {
  const r = spawnSync(cmd, args.map(String), { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** shutil.which: the tool's path on PATH, or null. PATHEXT on Windows finds the .cmd shims. */
function which(tool) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const ext of exts) {
      const p = dir && join(dir, tool + ext);
      if (p && existsSync(p) && statSync(p).isFile()) return p;
    }
  }
  return null;
}

/** ~ arrives literally from PowerShell and from a quoted Bash argument; resolve() would put it
 *  under the cwd, so expand it before anything else sees the path (recipe lesson 11). */
const expand = (p) => String(p).replace(/^~(?=$|[\\\\/])/, homedir());

/** The real path of p, though its tail may not exist yet: realpath the longest existing prefix,
 *  so a symlink inside root that points out is seen for what it is. */
function real(p) {
  const rest = [];
  let cur = resolve(p);
  while (!existsSync(cur) && dirname(cur) !== cur) { rest.unshift(basename(cur)); cur = dirname(cur); }
  return join(realpathSync(cur), ...rest);
}

/** Refuse any destination outside root — the guardrail for every copy or write target. A
 *  relative path is taken from root, not the cwd. */
function inside(path, root) {
  const r = real(expand(root));
  const p = real(resolve(r, expand(path)));
  const rel = relative(r, p);
  if (rel === '..' || rel.startsWith(\`..\${sep}\`) || isAbsolute(rel)) throw new Refused(\`\${p} is outside \${r}; refusing to write there\`);
  return p;
}

/** Write a file with LF endings, inside root (default ROOT) or refuse. An existing file with
 *  different content is refused unless replace — reuse, don't clobber. Identical content is a no-op. */
function write(path, text, { replace = false, root = ROOT } = {}) {
  path = inside(path, root);
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === text) { say(\`= \${path} (unchanged)\`); return; }
    if (!replace) throw new Refused(\`\${path} already exists with different content; move it aside or edit it by hand\`);
  }
  say(\`> \${path}\`);
  if (!DRY_RUN) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, 'utf8'); }
}
`);
  if (ctx.plugin) {
    L.push(`/** The project this run sets up, from --root. Required: a plugin-shipped script sits in the
 *  plugin's install directory, so where it is says nothing about the project, and the cwd is
 *  wherever the agent happened to be. */
function rootDir(given) {
  if (given === undefined) throw new Refused('--root is required: pass --root "\${CLAUDE_PROJECT_DIR}", the project this sets up');
  const root = resolve(expand(given));`);
  } else {
    L.push(`/** The project this run sets up, from --root; defaults to the repo this script sits in. */
function rootDir(given) {
  const root = given === undefined ? DEFAULT_ROOT : resolve(expand(given));`);
  }
  L.push(`  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Refused(\`--root \${root} is not a directory\`);
  return realpathSync(root);
}
`);
  if (s.stateFile) {
    L.push(`/** The state file as an object; {} until it exists. A hand-edit that broke it is refused, not
 *  overwritten — it may hold answers the user typed. The BOM is PowerShell's. */
function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8').replace(/^\\uFEFF/, '')); } catch (e) {
    throw new Refused(\`\${STATE_FILE} is not valid JSON (\${e.message}); fix it by hand, then re-run\`);
  }
}

/** Merge top-level keys into the state file. Later skills read it instead of re-asking the
 *  user; it is committed, so never a machine path (recipe lesson 2). */
function saveState(updates) {
  write(STATE_FILE, JSON.stringify({ ...loadState(), ...updates }, null, 2) + '\\n', { replace: true });
}
`);
  }
  L.push(`// ---------------------------------------------------------------------------
// steps — each returns an exit code, and is safe to re-run
// ---------------------------------------------------------------------------

function cmdCheck() {
  let missing = 0;
  for (const [tool, how] of Object.entries(INSTALL)) {
    if (which(tool)) say(\`OK   \${tool}\`);
    else { missing += 1; say(\`FAIL \${tool} — install: \${how[os()]}\`); }
  }
  if (missing) say('After installing, open a NEW terminal (and restart Claude Code) so PATH picks it up.');
  return missing ? 1 : 0;
}`);
  for (const st of steps) {
    L.push('', `/** ${jsDoc(st.does)} */`, `function ${jsIdent(st.name)}(args) {`);
    for (const c of stepComments(s, st)) L.push(`  // ${jsDoc(c)}`);
    L.push(`  say('${TODO}: implement step ${st.name}');`, '  return 4;  // not implemented: never 0, so a stub cannot pass for a done step', '}');
  }
  // The step table drives parsing, --help and dispatch alike, so they cannot disagree.
  L.push('', `// Each step's flags, in the order --help lists them. Every flag takes a value and is required.
const STEPS = {
  check: { help: 'prerequisites, with the install command for anything missing', flags: [], run: cmdCheck },`);
  for (const st of steps) {
    const flags = st.proof
      ? [`{ flag: '--from', help: 'the working directory to run the proof from (pass { cwd: args.from } to run())' }`]
      : (st.args || []).map((f) => (f === '--mode' && s.modes
        ? `{ flag: '--mode', choices: [${s.modes.rows.map((r) => jsStr(r.mode)).join(', ')}] }`
        : `{ flag: ${jsStr(f)} /* ${TODO}: help text; optional? */ }`));
    L.push(`  ${jsStr(st.name)}: {`, `    help: ${jsStr(st.does)},`, `    flags: [${flags.join(', ')}],`,
      `    run: ${jsIdent(st.name)},`, '  },');
  }
  L.push(`};

const USAGE = \`usage: \${SCRIPT} [--help] [--dry-run] [--root ROOT] {\${Object.keys(STEPS).join(',')}} ...\`;

/** --mode {adopt,fresh} or --dir DIR, as argparse writes them. */
const metavar = (f) => \`\${f.flag} \${f.choices ? \`{\${f.choices.join(',')}}\` : f.flag.slice(2).toUpperCase()}\`;

function help() {
  const w = Math.max(...Object.keys(STEPS).map((k) => k.length)) + 2;
  const L = [USAGE, '', DOC, '', 'options:', '  --help       show this help and exit',
    '  --dry-run    print what would run; change nothing',
    ${jsStr(`  --root ROOT  ${ctx.plugin ? 'the project to set up (required)' : 'the project to set up (default: the repo this script sits in)'}`)}, '', 'steps:'];
  for (const [name, st] of Object.entries(STEPS)) {
    L.push(\`  \${name.padEnd(w)}\${st.help}\`);
    for (const f of st.flags) L.push(\`  \${''.padEnd(w)}  \${metavar(f)}\${f.help ? \`  \${f.help}\` : ''}\`);
  }
  return L.join('\\n');
}

/** A usage error: argparse's shape and exit code, so both skeletons fail alike. */
function usage(msg) {
  process.stderr.write(\`\${USAGE}\\n\${SCRIPT}: error: \${msg}\\n\`);
  process.exit(2);
}

/** [--dry-run] [--root ROOT] step [step flags] — global flags before the step, as argparse wants. */
function parse(argv) {
  const g = { dryRun: false, root: undefined };
  let i = 0;
  for (; i < argv.length && argv[i].startsWith('-'); i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { say(help()); process.exit(0); }
    else if (a === '--dry-run') g.dryRun = true;
    else if (a === '--root') { if (argv[i + 1] === undefined) usage('argument --root: expected one argument'); g.root = argv[++i]; }
    else usage(\`unrecognized arguments: \${a}\`);
  }
  const step = argv[i++];
  if (step === undefined) usage('the following arguments are required: step');
  const spec = STEPS[step];
  if (!spec) usage(\`argument step: invalid choice: '\${step}' (choose from \${Object.keys(STEPS).join(', ')})\`);
  const args = {};
  for (; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      say([\`usage: \${SCRIPT} \${step} \${spec.flags.map(metavar).join(' ')}\`, '', spec.help,
        ...spec.flags.map((f) => \`  \${metavar(f)}\${f.help ? \`  \${f.help}\` : ''}\`)].join('\\n'));
      process.exit(0);
    }
    const f = spec.flags.find((x) => x.flag === a);
    if (!f) usage(\`unrecognized arguments: \${a}\`);
    const v = argv[++i];
    if (v === undefined) usage(\`argument \${a}: expected one argument\`);
    if (f.choices && !f.choices.includes(v)) usage(\`argument \${a}: invalid choice: '\${v}' (choose from \${f.choices.join(', ')})\`);
    args[a.slice(2)] = v;
  }
  const missing = spec.flags.filter((f) => !(f.flag.slice(2) in args)).map((f) => f.flag);
  if (missing.length) usage(\`the following arguments are required: \${missing.join(', ')}\`);
  return { ...g, step, args };
}

function main() {
  const { dryRun, root, step, args } = parse(process.argv.slice(2));
  DRY_RUN = dryRun;
  try {
    ROOT = rootDir(root);${s.stateFile ? `\n    STATE_FILE = join(ROOT, ${jsStr(s.stateFile)});` : ''}
    return STEPS[step].run(args);
  } catch (e) {
    if (e instanceof Refused) { say(\`REFUSED: \${e.message}\`); return 3; }
    if (e instanceof Missing) {
      say(\`MISSING: \${e.cmd} is not on PATH. Run the check step; on Windows, resolve .cmd shims with which() first.\`);
      return 1;
    }
    if (e instanceof Failed) { say(\`FAILED: \${e.message}. Fix the cause, then re-run this step.\`); return e.code || 1; }
    throw e;
  }
}

process.exit(main());
`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------

// --help is the header comment above, so the two cannot disagree.
const source = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
const HELP = source.slice(0, source.findIndex((l) => !l.startsWith('//')))
  .map((l) => l.replace(/^\/\/ ?/, '')).join('\n');

const args = parseArgs(process.argv.slice(2));
if (args.help) { process.stdout.write(`${HELP}\n`); process.exit(0); }
if (args.example) { process.stdout.write(JSON.stringify(EXAMPLE, null, 2) + '\n'); process.exit(0); }
if (args.out && args.plugin) fail(1, '--out and --plugin are exclusive: --out for a repo-local skill, --plugin for a plugin-shipped one');
if (!args.spec || !(args.out || args.plugin)) fail(1, 'need --spec FILE and --out DIR or --plugin DIR (or --example; see --help)');

let spec;
try { spec = JSON.parse(readFileSync(args.spec, 'utf8')); }
catch (e) { fail(1, `cannot read ${args.spec}: ${e.message}`); }
const errs = validate(spec);
if (errs.length) fail(1, `spec has ${errs.length} problem(s):\n  ${errs.join('\n  ')}`);

// out: the skill's directory. skillsDir: where setup-observer/ sits beside it. scriptPath: the
// step script — beside SKILL.md in a repo, in the plugin's scripts/ (the only place a skill's
// ${CLAUDE_PLUGIN_ROOT} reference can reach) in a plugin. repo: whose .gitignore to edit, if any.
let out, skillsDir, scriptPath, repo = null;
const ctx = { lang: langOf(spec.script), plugin: null };
if (args.plugin) {
  const plugin = resolve(args.plugin);
  const manifest = join(plugin, '.claude-plugin', 'plugin.json');
  let name;
  try { name = JSON.parse(readFileSync(manifest, 'utf8')).name; } catch (e) { fail(1, `--plugin ${plugin}: cannot read ${manifest} (${e.message}) — is it a plugin directory?`); }
  if (typeof name !== 'string' || !name) fail(1, `--plugin ${plugin}: ${manifest} has no \`name\``);
  ctx.plugin = name;
  skillsDir = join(plugin, 'skills');
  out = join(skillsDir, spec.skill);
  scriptPath = join(plugin, 'scripts', spec.script);
} else {
  out = resolve(args.out);
  // The generated script finds the repo root three levels up, and the observer sits beside the
  // skill — both only hold when --out is [repo]/.claude/skills/[skill].
  skillsDir = dirname(out);
  if (basename(out) !== spec.skill || basename(skillsDir) !== 'skills' || basename(dirname(skillsDir)) !== '.claude') {
    fail(1, `--out must be [repo]/.claude/skills/${spec.skill}, got ${out}`);
  }
  repo = dirname(dirname(skillsDir));
  scriptPath = join(out, spec.script);
}
const files = [[join(out, 'SKILL.md'), skillMd(spec, ctx)],
  [scriptPath, ctx.lang === 'py' ? pyScript(spec, ctx) : nodeScript(spec, ctx)]];
const clash = files.filter(([f]) => existsSync(f)).map(([f]) => f);
if (clash.length) fail(2, `refusing to overwrite:\n  ${clash.join('\n  ')}\nEdit them by hand, or move them aside and re-run.`);

const verb = args.dryRun ? 'would write' : 'wrote';
for (const [f, text] of files) {
  const todos = (text.match(/TODO\(author\)/g) || []).length;
  process.stdout.write(`${verb} ${f}  (${todos} TODO(author) marker${todos === 1 ? '' : 's'})\n`);
  if (!args.dryRun) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); }
}

if (spec.observer !== false) observer(spec);

function observerToml(s) {
  const o = typeof s.observer === 'object' ? s.observer : {};
  const list = (v) => `[${(v || []).map((x) => JSON.stringify(x)).join(', ')}]`;
  const L = [ctx.plugin
    ? `# Everything setup-observer knows about the projects ${s.skill} sets up. Its SKILL.md and`
    : '# Everything setup-observer knows about THIS repo. Its SKILL.md and observe.py are',
  ctx.plugin
    ? '# observe.py are verbatim copies of the master in the skills@c-energie plugin; edit this file, not those.'
    : '# verbatim copies of the master in the skills@c-energie plugin; edit this file, not those.', '',
  '# Extra tools to record versions of (git, gh, uv, python, node and claude always are).',
  `tools = ${list(o.tools || s.tools)}`,
  '# Env vars whose presence before setup is a deviation-in-waiting. Secrets are recorded as set/unset only.',
  `env_vars = ${list(o.envVars)}`, `secret_vars = ${list(o.secretVars)}`,
  '# Files and directories at the repo root whose presence the baseline records.',
  `state_files = ${list(o.stateFiles || (s.stateFile ? [s.stateFile] : s.existingState.files))}`, '',
  '# Which repo a deviation is reported on. `upstream` and `this machine only` are implicit.'];
  if (!o.owners || !o.owners.length) L.push(`# ${TODO}: one [[owners]] table per repo — repo = "owner/name", covers = "what it owns".`);
  for (const r of o.owners || []) L.push('', '[[owners]]', `repo = ${JSON.stringify(r.repo)}`, `covers = ${JSON.stringify(r.covers)}`);
  return L.join('\n') + '\n';
}

function observer(s) {
  const dir = join(skillsDir, 'setup-observer');
  const lf = (t) => t.replace(/\r\n/g, '\n');
  if (existsSync(dir)) {
    const drifted = OBSERVER_FILES.filter((f) => !existsSync(join(dir, f))
      || lf(readFileSync(join(dir, f), 'utf8')) !== lf(readFileSync(join(ASSETS, f), 'utf8')));
    process.stdout.write(`kept ${dir} (already present)${drifted.length
      ? `; ${drifted.join(', ')} ${drifted.length === 1 ? 'differs' : 'differ'} from the plugin's master — re-sync by copying them from ${ASSETS}`
      : '; matches the master'}.\n  Check its observer.toml [[owners]] covers this skill's repos.\n`);
    return;
  }
  const writes = [...OBSERVER_FILES.map((f) => [join(dir, f), lf(readFileSync(join(ASSETS, f), 'utf8'))]),
    [join(dir, 'observer.toml'), observerToml(s)]];
  for (const [f, text] of writes) {
    process.stdout.write(`${verb} ${f}\n`);
    if (!args.dryRun) { mkdirSync(dir, { recursive: true }); writeFileSync(f, text); }
  }
  // A plugin has no project .gitignore to edit: the projects it sets up are not known here, and
  // observe.py's baseline adds .setup/ to each one's info/exclude when it runs.
  if (!repo) return;
  const gi = join(repo, '.gitignore');
  const has = existsSync(gi) && lf(readFileSync(gi, 'utf8')).split('\n').some((l) => /^\/?\.setup\/?$/.test(l.trim()));
  if (has) return;
  process.stdout.write(`${args.dryRun ? 'would add' : 'added'} .setup/ to ${gi} (the observer logs there)\n`);
  if (!args.dryRun) {
    const prev = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    appendFileSync(gi, `${prev && !prev.endsWith('\n') ? '\n' : ''}.setup/\n`);
  }
}
