#!/usr/bin/env node
// scaffold.mjs — turn an author-setup-skill interview spec into a first draft of a setup skill.
//
//   node scaffold.mjs --spec spec.json --out [repo]/.claude/skills/[skill] [--dry-run]
//   node scaffold.mjs --example                    print a complete example spec
//
// Writes two files into --out: SKILL.md (the recipe's shape, with every judgement the spec
// could not answer left as a TODO(author) marker) and the step script named by spec.script (a
// stdlib-only Python skeleton: named steps, --dry-run, reuse-don't-clobber helpers, a state
// file). Refuses to overwrite either file — a re-run after hand edits must never destroy them.
//
// Unless spec.observer is false, also makes sure the repo has the step-0 setup-observer: when
// .claude/skills/setup-observer/ is absent, copies SKILL.md and observe.py verbatim from this
// plugin's assets/setup-observer/, writes the repo's observer.toml from the spec, and adds
// `.setup/` to .gitignore. When present, leaves it alone and reports whether its two copied
// files have drifted from the master.
// Exit 0 written (or would write), 1 bad spec, 2 refused.
//
// Dependency-free Node ESM, like every script in this marketplace.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'setup-observer');
const OBSERVER_FILES = ['SKILL.md', 'observe.py'];

const EXAMPLE = {
  skill: 'setup-widget-workspace',
  script: 'setup_widget.py',
  title: 'Set up a widget workspace',
  does: 'First-run setup of a widget workspace — create the widget repo from its template and prove a widget builds',
  trigger: 'Use when widget.toml is missing at the workspace root, or the user asks to set up the widget workspace',
  stateFile: 'widget.toml',
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
    { name: 'root', does: 'write widget.toml', args: ['--dir'], done: 'widget.toml parses and names --dir' },
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
    else if (k === '--spec' || k === '--out') a[k.slice(2)] = argv[++i];
    else fail(1, `unknown argument \`${k}\` (see the header of this file)`);
  }
  return a;
}

const SLUG = /^[a-z][a-z0-9-]*$/;
const PY = /^[a-z][a-z0-9_]*\.py$/;
const STEP = /^[a-z][a-z0-9-]*$/;
const FLAG = /^--[a-z][a-z0-9-]*$/;

// Flags the generated argparse already owns, or that would shadow its dispatch.
const RESERVED = new Set(['--help', '--dry-run', '--step', '--from']);
const KEYS = new Set(['skill', 'script', 'title', 'does', 'trigger', 'stateFile', 'observer', 'tools',
  'questions', 'modes', 'steps', 'invariants', 'proof', 'neighbours']);
const OBSERVER_KEYS = new Set(['owners', 'tools', 'envVars', 'secretVars', 'stateFiles']);

function validate(s) {
  const errs = [];
  const need = (k, test, what) => { if (!test(s[k])) errs.push(`\`${k}\`: ${what}`); };
  const str = (v) => typeof v === 'string' && v.trim() !== '';
  for (const k of Object.keys(s)) if (!KEYS.has(k)) errs.push(`\`${k}\`: unknown key (see --example)`);
  need('skill', (v) => str(v) && SLUG.test(v), 'lower-case slug, e.g. setup-widget-workspace');
  need('script', (v) => str(v) && PY.test(v), 'a python file name, e.g. setup_widget.py');
  need('title', (v) => str(v) && !/"""|\\/.test(v), 'the SKILL.md heading (no """ or backslash: it becomes a docstring)');
  need('does', str, 'what the skill does — the front of its description');
  need('trigger', str, 'when to use it — the rest of its description');
  need('stateFile', (v) => str(v) && /\.toml$/.test(v), 'the TOML state file later skills read, e.g. widget.toml');
  need('steps', (v) => Array.isArray(v) && v.length > 0, 'at least one step');
  need('proof', (v) => v && str(v.step) && STEP.test(v.step) && str(v.does) && Array.isArray(v.cwds),
    '{step: lower-case name, does, cwds: [two or more working directories], done}');
  for (const k of ['does', 'trigger']) {
    if (str(s[k]) && /[<>]/.test(s[k])) errs.push(`\`${k}\`: no angle brackets — it goes into front-matter, where the ingester drops the field; use [placeholder]`);
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

function skillMd(s) {
  const run = `uv run --no-project --python 3.12 .claude/skills/${s.skill}/${s.script}`;
  const outward = s.steps.filter((st) => st.outward).map((st) => `\`${st.name}\``);
  const L = [];
  // JSON's double-quoted string is valid YAML, so a ': ' or '#' in the prose cannot break the field.
  const desc = `${s.does.trim().replace(/\.+$/, '')}. ${s.trigger.trim().replace(/\.+$/, '')}.`;
  L.push('---', `name: ${s.skill}`, `description: ${JSON.stringify(desc)}`, '---', '');
  L.push(`# ${s.title}`, '');
  if (s.observer !== false) {
    L.push('**First, invoke `/setup-observer`** (once per session): it records where this guide and',
      'reality disagree, so the maintainer can fix the guide.', '');
  }
  L.push(`${TODO}: the end state, as a directory tree — what exists when this skill is done.`, '');
  L.push(`All mechanical work is done by \`${s.script}\` beside this file. Your job is the interview,`,
    'running its steps in order, and the judgement work the script cannot do. Run it through uv —',
    'the system Python may be too old:', '', '```bash', `${run} <step> [flags]`, '```', '');
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
    'Claude Code) so PATH picks it up. If `uv` itself is missing, give its install command first.', '');

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
    `2. Point the user at \`${s.stateFile}\` — every later skill reads it instead of re-asking.`,
    `3. ${TODO}: the optional next skill, if any.`, '');
  L.push(`**Not this skill:** ${s.neighbours || `${TODO}: the neighbouring skills that own the adjacent jobs`}.`, '');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// the step script
// ---------------------------------------------------------------------------

const pyIdent = (name) => name.replace(/-/g, '_');
const pyStr = (v) => JSON.stringify(String(v));
// Prose pasted into the module docstring: nothing in it may close the docstring or start an escape.
const doc = (v) => String(v).replace(/\\/g, '/').replace(/"""/g, "'''");

function script(s) {
  const steps = [...s.steps, { name: s.proof.step, does: s.proof.does, args: ['--from'], proof: true }];
  const L = [];
  L.push('#!/usr/bin/env python3', `"""${s.title}.`, '',
    `Driven by the \`${s.skill}\` skill, which does the interview and then calls the steps below in`,
    'order. Each step is also runnable by hand, and each refuses rather than overwrites when its',
    'target already exists:', '');
  const w = Math.max(5, ...steps.map((st) => st.name.length)) + 2;
  L.push(`    ${'check'.padEnd(w)}prerequisites, with the install command for anything missing`);
  for (const st of steps) L.push(`    ${st.name.padEnd(w)}${doc(st.does)}`);
  L.push('', 'Run with uv so no system Python is needed:', '',
    `    uv run --no-project --python 3.12 .claude/skills/${s.skill}/${s.script} check`, '', 'Stdlib only.', '"""');
  L.push(`import argparse
import json
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

# .claude/skills/${s.skill}/${s.script} -> the repo root
ROOT = Path(__file__).resolve().parents[3]

STATE_FILE = ROOT / ${pyStr(s.stateFile)}

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
    content is a no-op."""
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
    """Refuse any destination outside root — the guardrail for every copy or write target."""
    path, root = Path(path).resolve(), Path(root).resolve()
    if path != root and root not in path.parents:
        raise Refused(f"{path} is outside {root}; refusing to write there")
    return path


def load_state():
    return tomllib.loads(STATE_FILE.read_text(encoding="utf-8")) if STATE_FILE.exists() else {}


def save_state(**updates):
    """Merge flat scalar keys (str, bool, int, float) into the state file. Later skills read
    it instead of re-asking the user. ${TODO}: tables, if the state needs them."""
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
    const inv = (s.invariants || []).filter((i) => i.step === st.name);
    L.push('', `def cmd_${pyIdent(st.name)}(args):`, `    ${pyStr(st.does)}`);
    if (st.outward) L.push('    # Outward-facing: the skill gets an explicit yes before this runs. Reuse an existing', '    # target (repo, checkout) rather than recreating it, so a re-run is safe.');
    for (const i of inv) L.push(`    # GUARDRAIL: ${i.rule}. Enforce it here and raise Refused — never warn and carry on.`);
    if (st.proof) {
      L.push('    # Run the real pipeline from args.from_dir (the skill runs this once per working directory)', '    # and check the observable result, not that a file exists.');
    }
    if (st === s.steps[s.steps.length - 1]) {
      L.push(`    # ${TODO}: call save_state(...) here, so the state file the skill triggers on exists afterwards.`);
    }
    L.push(`    say("${TODO}: implement step ${st.name}")`, '    return 4  # not implemented: never 0, so a stub cannot pass for a done step');
  }
  L.push('', '', `def main(argv=None):
    global DRY_RUN
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="print what would run; change nothing")
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

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.example) { process.stdout.write(JSON.stringify(EXAMPLE, null, 2) + '\n'); process.exit(0); }
if (!args.spec || !args.out) fail(1, 'need --spec FILE and --out DIR (or --example)');

let spec;
try { spec = JSON.parse(readFileSync(args.spec, 'utf8')); }
catch (e) { fail(1, `cannot read ${args.spec}: ${e.message}`); }
const errs = validate(spec);
if (errs.length) fail(1, `spec has ${errs.length} problem(s):\n  ${errs.join('\n  ')}`);

const out = resolve(args.out);
// The generated script finds the repo root three levels up, and the observer sits beside the
// skill — both only hold when --out is [repo]/.claude/skills/[skill].
const skillsDir = dirname(out);
if (basename(out) !== spec.skill || basename(skillsDir) !== 'skills' || basename(dirname(skillsDir)) !== '.claude') {
  fail(1, `--out must be [repo]/.claude/skills/${spec.skill}, got ${out}`);
}
const repo = dirname(dirname(skillsDir));
const files = [[join(out, 'SKILL.md'), skillMd(spec)], [join(out, spec.script), script(spec)]];
const clash = files.filter(([f]) => existsSync(f)).map(([f]) => f);
if (clash.length) fail(2, `refusing to overwrite:\n  ${clash.join('\n  ')}\nEdit them by hand, or move them aside and re-run.`);

const verb = args.dryRun ? 'would write' : 'wrote';
for (const [f, text] of files) {
  const todos = (text.match(/TODO\(author\)/g) || []).length;
  process.stdout.write(`${verb} ${f}  (${todos} TODO(author) marker${todos === 1 ? '' : 's'})\n`);
  if (!args.dryRun) { mkdirSync(out, { recursive: true }); writeFileSync(f, text); }
}

if (spec.observer !== false) observer(spec);

function observerToml(s) {
  const o = typeof s.observer === 'object' ? s.observer : {};
  const list = (v) => `[${(v || []).map((x) => JSON.stringify(x)).join(', ')}]`;
  const L = ['# Everything setup-observer knows about THIS repo. Its SKILL.md and observe.py are',
    '# verbatim copies of the master in the skills@c-energie plugin; edit this file, not those.', '',
    '# Extra tools to record versions of (git, gh, uv, python, node and claude always are).',
    `tools = ${list(o.tools || s.tools)}`,
    '# Env vars whose presence before setup is a deviation-in-waiting. Secrets are recorded as set/unset only.',
    `env_vars = ${list(o.envVars)}`, `secret_vars = ${list(o.secretVars)}`,
    '# Files and directories at the repo root whose presence the baseline records.',
    `state_files = ${list(o.stateFiles || [s.stateFile])}`, '',
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
  const gi = join(repo, '.gitignore');
  const has = existsSync(gi) && lf(readFileSync(gi, 'utf8')).split('\n').some((l) => /^\/?\.setup\/?$/.test(l.trim()));
  if (has) return;
  process.stdout.write(`${args.dryRun ? 'would add' : 'added'} .setup/ to ${gi} (the observer logs there)\n`);
  if (!args.dryRun) {
    const prev = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
    appendFileSync(gi, `${prev && !prev.endsWith('\n') ? '\n' : ''}.setup/\n`);
  }
}
