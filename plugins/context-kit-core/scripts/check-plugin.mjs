#!/usr/bin/env node
// Lint the plugin for the failure modes that have actually bitten this repo — the ones that
// break silently, where the plugin still installs and a skill just never appears.
//
//   node check-plugin.mjs <repo-root>
//
// Prints findings as markdown; exits 1 if there is at least one ERROR, 0 otherwise.
// Run it before every commit that touches skills, hooks or the manifests.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) { console.error('check-plugin.mjs: needs the plugin repo root'); process.exit(2); }

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`**${where}** — ${msg}`);
const warn = (where, msg) => warnings.push(`**${where}** — ${msg}`);

const readJsonOptional = (rel) => (existsSync(join(root, rel)) ? readJson(rel) : null);
const readJson = (rel) => {
  const p = join(root, rel);
  if (!existsSync(p)) { err(rel, 'missing'); return null; }
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    err(rel, `not valid JSON: ${e.message}`);
    return null;
  }
};

// ---------------------------------------------------------------- manifests
const manifest = readJson('.claude-plugin/plugin.json');
if (manifest) {
  for (const field of ['name', 'description', 'version']) {
    if (!manifest[field]) err('plugin.json', `missing required field \`${field}\``);
  }
  if (manifest.version && !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    err('plugin.json', `version is not x.y.z: ${JSON.stringify(manifest.version)}`);
  }
}

const marketplace = readJsonOptional('.claude-plugin/marketplace.json');
if (marketplace && manifest) {
  const entries = marketplace.plugins ?? [];
  if (!entries.length) err('marketplace.json', 'no plugins[] entries');
  for (const entry of entries) {
    const label = `marketplace.json plugins[${entry?.name ?? '?'}]`;
    // These override plugin.json silently — the July 2026 stranded-install bug.
    for (const field of ['version', 'description']) {
      if (entry?.[field] !== undefined) {
        err(label, `declares \`${field}\`, which OVERRIDES plugin.json. Delete it — `
          + `plugin.json is the single source for that field.`);
      }
    }
    // The name-match rule only binds the entry shipped from THIS repo (source "./") —
    // a marketplace may also list sibling plugins living in other repos (context-notion).
    if (entry?.name && entry?.source === './' && entry.name !== manifest.name) {
      err(label, `name "${entry.name}" does not match plugin.json name "${manifest.name}"`);
    }
  }
}

// ---------------------------------------------------------------- hooks
const hooks = readJsonOptional('hooks/hooks.json');
if (hooks) {
  // Scan the PARSED command strings, never `JSON.stringify(hooks)`. A hook command quotes its
  // path — `bash "${CLAUDE_PLUGIN_ROOT}/hooks/load-context.sh"` — because a Windows plugin
  // root contains spaces; re-stringifying turns that quote back into \", and a scan that stops
  // at " but admits \ then ran on past the path and took the backslash with it, so the check
  // looked for a file called `load-context.sh\` and never found it. On Windows \ is a path
  // separator, so join() normalised it away and the check passed; on Linux it is an ordinary
  // filename character and the same manifest reported both of core's hooks as missing files.
  // Invisible for as long as this only ran on Windows, and found the first time it ran in a
  // Linux container.
  //
  // Excluding the backslash from the class (affd079) fixes that instance. Reading the parsed
  // object takes the escaping out of the problem altogether, which is the difference worth
  // having on the one gate whose whole contract is that exit 1 means stop before committing.
  const commands = [];
  const collect = (node) => {
    if (typeof node === 'string') commands.push(node);
    // Arrays and objects both answer to Object.values, and hooks.json nests both.
    else if (node && typeof node === 'object') for (const value of Object.values(node)) collect(value);
  };
  collect(hooks);
  for (const command of commands) {
    for (const ref of command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/[^"'\s]+/g) ?? []) {
      const rel = ref.replace('${CLAUDE_PLUGIN_ROOT}/', '');
      if (!existsSync(join(root, rel))) err('hooks/hooks.json', `references missing file \`${rel}\``);
    }
  }
}

// ---------------------------------------------------------------- skills
const skillsDir = join(root, 'skills');
if (!existsSync(skillsDir)) {
  err('skills/', 'missing');
} else {
  for (const dir of readdirSync(skillsDir).sort()) {
    if (!statSync(join(skillsDir, dir)).isDirectory()) continue;
    const rel = `skills/${dir}/SKILL.md`;
    const abs = join(root, rel);
    if (!existsSync(abs)) { err(rel, 'directory has no SKILL.md'); continue; }

    const text = readFileSync(abs, 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    if (!fm) { err(rel, 'no YAML front-matter block'); continue; }

    const fields = new Map();
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (m) fields.set(m[1], m[2].trim());
    }

    const name = fields.get('name');
    if (!name) err(rel, 'front-matter has no `name`');
    else if (name !== dir) err(rel, `name "${name}" does not match its directory "${dir}"`);
    if (!fields.get('description')) err(rel, 'front-matter has no `description` (it is what makes the skill trigger)');

    // Angle brackets in a front-matter value are read as a tag and silently dropped —
    // this is what stranded the plugin at 13/15 skills in Cowork, July 2026.
    for (const [key, value] of fields) {
      if (/<[^>]*>/.test(value)) {
        err(rel, `front-matter \`${key}\` contains angle brackets — use [placeholder] or {placeholder}`);
      }
    }

    // A skill that writes outside Notion (Slack, the shared repos) must not do it unprompted.
    // Two acceptable ways: `disable-model-invocation: true` so it never self-triggers, or an
    // explicit "ask the user before pushing" gate in the prose (what update-plugin does, so
    // that "add a skill that does X" can still route to it).
    const reachesOut = /slack_send_message|git .*push|git -C .*commit/.test(text);
    const blocked = fields.get('disable-model-invocation') === 'true';
    const gated = /ask(ing)? (the user|first|before)|before pushing|get an explicit yes/i.test(text);
    if (reachesOut && !blocked && !gated) {
      warn(rel, 'pushes to git or posts to Slack, but is neither `disable-model-invocation: true` '
        + 'nor gated by an explicit "ask the user before pushing" step — one or the other is required');
    }

    // Backslash excluded here too. This one reads raw SKILL.md text rather than stringified
    // JSON, so it has no escaped quotes to trip on today — but the fault is the same one, and a
    // path ending at an escaped or Windows-style separator would capture it identically.
    for (const ref of text.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/[^"'`\s)\\]+/g) ?? []) {
      const target = ref.replace('${CLAUDE_PLUGIN_ROOT}/', '');
      // Prose placeholders (".../scripts/...", "[name]", "{name}") are documentation, not paths.
      if (/\.\.\.|[[\]{}]/.test(target)) continue;
      if (!existsSync(join(root, target))) err(rel, `references missing file \`${target}\``);
    }
  }
}

// Deliberately NOT checked: whether each skill appears in weekly-review. Most skills are
// on-demand, so that check is all false positives — "is this one recurring?" is a judgement
// the update-plugin checklist asks for, not something to lint.

// ---------------------------------------------------------------- copied scripts
// Some scripts exist in more than one plugin ON PURPOSE: a skill can only reference
// ${CLAUDE_PLUGIN_ROOT}/scripts/... inside its OWN plugin's install directory, so anything a
// skill calls at runtime has to sit in that plugin. The rule is that the copies stay in step,
// each group with a named origin so a fix has exactly one direction to travel.
//
// Nothing enforced that until now — the rule lived in four CLAUDE.md files and in whoever
// remembered to run diff. It had already failed twice: check-plugin.mjs and bump-version.mjs
// (both since consolidated into context-kit-core, being dev-time tools no skill invokes) had
// drifted apart, check-plugin's copies losing a guard the original has. A drifted copy means
// the same job behaves differently depending on which plugin ran it, silently.
//
// Compared BELOW the leading comment header: a copy carries a banner saying it is one, naming
// its origin, and that banner is the single part meant to differ.
const COPIES = [
  // Generic machinery originates in the CORE plugin — context-notion owns only what is
  // Notion-specific. dates.mjs is pure UTC calendar arithmetic with nothing Notion in it, and
  // core's own skills (save-thread, curate-context, update-plugin) call it, so core is its home;
  // it was mis-declared as context-notion's until 2026-08-10.
  { file: 'scripts/dates.mjs',         origin: 'context-kit-core', copies: ['context-notion', 'context-slack', 'diagrams', 'context-notes'] },
  // The workspace resolver (ADR 0002). Core originates it — finding the workspace is generic.
  // Since #60 it is the whole route: no context-repo.sh fallback and nothing spawned, so neither
  // context-repo.sh nor bash-bin.mjs is copied any more. Its bash twin workspace-root.sh is
  // core-only (hooks), compared by workspace.test.mjs rather than here.
  { file: 'scripts/workspace.mjs',     origin: 'context-kit-core', copies: ['context-notion', 'context-slack', 'diagrams', 'context-notes'] },
  // Notion-coupled, so context-notion is the origin: lib.mjs reads state.notion and resolves
  // people by notionUserId; pending-parse.mjs defines the queue format those rows land in.
  { file: 'scripts/lib.mjs',           origin: 'context-notion',   copies: ['context-slack'] },
  { file: 'scripts/pending-parse.mjs', origin: 'context-notion',   copies: ['context-slack'] },
  // Where the queue, the mirror and the meetings folder live in a workspace (#53; one layout
  // since #60). Notion-coupled paths, so context-notion owns the table; notify-pending and the
  // digest's mirror fallback read the same directories context-notion writes.
  { file: 'scripts/layout.mjs',        origin: 'context-notion',   copies: ['context-slack'] },
  // The block-scale JSON editor. Generic, so core owns it; context-notion's notion-state.mjs
  // writes state.backend + state.notion through it, since every workspace.json writer must
  // leave the keys other plugins own byte-identical.
  { file: 'scripts/json-block.mjs',    origin: 'context-kit-core', copies: ['context-notion'] },
  // The step-0 setup observer. Its master is an inert asset in `skills` (scaffold.mjs copies it
  // into repos); a plugin ships it as a live skill, so the copy sits at another path (`to`).
  // Both files are copied whole — neither has a banner — so any difference is drift.
  // DISCOVERED rather than listed (#63): any plugin can gain a setup skill, and its observer
  // copy went unchecked until someone remembered to edit a list here — `diagrams` was added by
  // hand in #43, after the fact. `discover` names the directory whose presence binds a plugin.
  { file: 'assets/setup-observer/SKILL.md',   to: 'skills/setup-observer/SKILL.md',   origin: 'skills', discover: 'skills/setup-observer' },
  { file: 'assets/setup-observer/observe.py', to: 'skills/setup-observer/observe.py', origin: 'skills', discover: 'skills/setup-observer' },
];

// Drop the shebang and the contiguous comment block at the top, then compare what is left.
// Stops at the first line that is neither blank nor a comment, so comments further down are
// part of the body and a change to one IS drift.
const bodyOf = (text) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = lines[0]?.startsWith('#!') ? 1 : 0;
  while (i < lines.length) {
    const t = lines[i].trimStart();
    if (t !== '' && !t.startsWith('//') && !t.startsWith('#')) break;
    i += 1;
  }
  return lines.slice(i).join('\n').trimEnd();
};

// Only possible from a marketplace checkout, where the siblings are on disk. An installed
// plugin has no siblings to compare against, so this silently does nothing there.
const marketRoot = [join(root, '..', '..'), root]
  .find((d) => existsSync(join(d, '.claude-plugin', 'marketplace.json'))) ?? null;

if (marketRoot) {
  const plugins = readdirSync(join(marketRoot, 'plugins'), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const { file, to = file, origin, copies, discover } of COPIES) {
    const originPath = join(marketRoot, 'plugins', origin, file);
    if (!existsSync(originPath)) continue;
    const originBody = bodyOf(readFileSync(originPath, 'utf8'));
    // A discovered group binds every plugin but the origin that has the directory; a plugin
    // without it is not flagged, since shipping the observer at all is the plugin's choice.
    const bound = discover
      ? plugins.filter((p) => p !== origin && existsSync(join(marketRoot, 'plugins', p, discover)))
      : copies;
    for (const copy of bound) {
      const copyPath = join(marketRoot, 'plugins', copy, to);
      if (!existsSync(copyPath)) {
        // A listed copy may legitimately be absent — only plugins that ship the file are bound.
        // A discovered one may not: the directory is there, so this is a half-copied observer,
        // and SKILL.md without observe.py is a step 0 that installs cleanly and cannot run.
        if (discover) {
          err(`plugins/${copy}/${to}`, `is MISSING, but \`plugins/${copy}/${discover}/\` exists. `
            + `Copy \`plugins/${origin}/${file}\` here whole, or remove the directory.`);
        }
        continue;
      }
      if (bodyOf(readFileSync(copyPath, 'utf8')) !== originBody) {
        err(`plugins/${copy}/${to}`, `has DRIFTED from its original in \`${origin}\`. These are `
          + `deliberate copies and must stay identical below the header banner. Fix `
          + `\`plugins/${origin}/${file}\` first, then copy it over this one, restoring only this `
          + `file's banner. (diff plugins/${origin}/${file} plugins/${copy}/${to})`);
      }
    }
  }
}

// ---------------------------------------------------------------- line endings
// .gitattributes forces LF on *.sh; a CRLF copy in the tree still breaks bash.
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  if (d.name === '.git' || d.name === 'node_modules') return [];
  const p = join(dir, d.name);
  return d.isDirectory() ? walk(p) : [p];
});
for (const file of walk(root).filter((f) => f.endsWith('.sh'))) {
  if (readFileSync(file).includes('\r\n')) {
    err(file.slice(root.length + 1), 'has CRLF line endings — bash will not run it; must be LF');
  }
}

// ---------------------------------------------------------------- report
const out = [`**Plugin check** · ${errors.length} error(s), ${warnings.length} warning(s)`, ''];
if (errors.length) out.push('### ❌ Errors', ...errors.map((e) => `- ${e}`), '');
if (warnings.length) out.push('### ⚠️ Warnings', ...warnings.map((w) => `- ${w}`), '');
if (!errors.length && !warnings.length) out.push('All clear.');
console.log(out.join('\n'));

process.exit(errors.length ? 1 : 0);