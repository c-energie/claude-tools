#!/usr/bin/env node
// List every plugin in the marketplace checkout, read from disk — with each one's version and,
// unless --brief, the skills inside it.
//
//   node list-plugins.mjs <marketplace-root>            # plugins + their skills
//   node list-plugins.mjs <marketplace-root> --brief    # one line per plugin
//   node list-plugins.mjs <marketplace-root> --json
//
// Why this exists: update-plugin's "which plugin does this belong to?" step used to carry a
// hand-written roster, and a hand-written roster goes stale the moment a plugin is added. It
// listed two plugins for the whole time context-slack had been shipping, which is long enough
// for a resolver fix to miss a copy. The layering rules stay in prose — those are judgement —
// but WHICH PLUGINS EXIST is a fact about the checkout, so read it from the checkout.
//
// Both layouts are accepted, matching plugin-repo.sh: a marketplace root holding
// plugins/<name>/, and the pre-move single-plugin repo with .claude-plugin/plugin.json at the
// top. Exits 0 with a note rather than failing when there is nothing to list — this is a
// reporting tool, and a non-zero exit here would read as "the repo is broken".

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const brief = args.includes('--brief');
const root = args.find((a) => !a.startsWith('--'));
if (!root) {
  console.error('list-plugins.mjs: needs the marketplace root (or one plugin directory)');
  process.exit(2);
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
};

// Front-matter only — the same shallow key: value parse check-plugin.mjs does, deliberately, so
// the two agree on what a field "is". No YAML library, and none wanted.
const frontMatter = (text) => {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  const fields = new Map();
  if (!fm) return fields;
  for (const line of fm[1].split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) fields.set(m[1], m[2].trim());
  }
  return fields;
};

// Descriptions are one long line by convention (that line is what makes a skill trigger), so
// clip at a word boundary for the table. --json keeps them whole.
const clip = (s, n) => {
  if (!s || s.length <= n) return s ?? '';
  const cut = s.slice(0, n);
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:—-]$/, '')}…`;
};

const pluginDirs = [];
if (existsSync(join(root, '.claude-plugin', 'plugin.json'))) {
  pluginDirs.push(root);
} else if (existsSync(join(root, 'plugins'))) {
  for (const name of readdirSync(join(root, 'plugins')).sort()) {
    const dir = join(root, 'plugins', name);
    if (statSync(dir).isDirectory() && existsSync(join(dir, '.claude-plugin', 'plugin.json'))) {
      pluginDirs.push(dir);
    }
  }
}

const plugins = pluginDirs.map((dir) => {
  const manifest = readJson(join(dir, '.claude-plugin', 'plugin.json')) ?? {};
  const skillsDir = join(dir, 'skills');
  const skills = [];
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir).sort()) {
      const file = join(skillsDir, name, 'SKILL.md');
      if (!existsSync(file)) continue;
      const fields = frontMatter(readFileSync(file, 'utf8'));
      skills.push({
        name,
        description: fields.get('description') ?? '',
        // The two gates worth seeing while deciding where a change goes: what will never
        // self-trigger, and what is background knowledge rather than a task.
        noAuto: fields.get('disable-model-invocation') === 'true',
        reference: fields.get('user-invocable') === 'false',
      });
    }
  }
  return {
    plugin: manifest.name ?? basename(dir),
    version: manifest.version ?? '?',
    description: manifest.description ?? '',
    dir,
    skills,
  };
});

if (asJson) {
  console.log(JSON.stringify(plugins, null, 2));
  process.exit(0);
}

if (!plugins.length) {
  console.log(`No plugins found under ${root} — expected plugins/[name]/.claude-plugin/plugin.json`);
  process.exit(0);
}

const total = plugins.reduce((n, p) => n + p.skills.length, 0);
const out = [`**${plugins.length} plugin(s), ${total} skill(s)** · read from ${root}`, ''];

if (brief) {
  const w = Math.max(...plugins.map((p) => p.plugin.length));
  for (const p of plugins) {
    out.push(`  ${p.plugin.padEnd(w)}  v${p.version}  ${p.skills.length} skill(s)`);
  }
  console.log(out.join('\n'));
  process.exit(0);
}

const width = Math.max(...plugins.flatMap((p) => p.skills.map((s) => s.name.length)), 0);
for (const p of plugins) {
  out.push(`### ${p.plugin} v${p.version} — ${p.skills.length} skill(s)`);
  if (!p.skills.length) out.push('  (no skills/ directory)');
  for (const s of p.skills) {
    const flags = [s.noAuto ? '[no-auto]' : '', s.reference ? '[reference]' : ''].filter(Boolean).join(' ');
    out.push(`  ${s.name.padEnd(width)}  ${flags ? `${flags} ` : ''}${clip(s.description, 90)}`);
  }
  out.push('');
}
out.push('[no-auto] = disable-model-invocation: true — never self-triggers, the user must name it.');
out.push('[reference] = user-invocable: false — background knowledge, not a task to run.');
console.log(out.join('\n'));
