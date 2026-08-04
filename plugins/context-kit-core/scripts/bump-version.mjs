#!/usr/bin/env node
// Bump the plugin version — in .claude-plugin/plugin.json and NOWHERE ELSE.
//
//   node bump-version.mjs <repo-root>                 # print the current version
//   node bump-version.mjs <repo-root> patch           # 0.5.3 -> 0.5.4
//   node bump-version.mjs <repo-root> minor           # 0.5.3 -> 0.6.0
//   node bump-version.mjs <repo-root> major           # 0.5.3 -> 1.0.0
//   node bump-version.mjs <repo-root> 0.6.0           # set explicitly
//
// Prints the new version on stdout (nothing else) so callers can use it in a commit message.
//
// A field in a marketplace.json plugins[] entry OVERRIDES the same field in plugin.json, so a
// `version` there silently wins and strands installs on an old release (July 2026). This script
// refuses to run while such an override exists rather than writing a bump that does nothing.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const die = (m) => { console.error(`bump-version.mjs: ${m}`); process.exit(2); };

const [root, spec] = process.argv.slice(2);
if (!root) die('needs the plugin repo root (see scripts/plugin-repo.sh)');

const manifestPath = join(root, '.claude-plugin', 'plugin.json');
const marketplacePath = join(root, '.claude-plugin', 'marketplace.json');

const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch (e) {
    die(`cannot read ${p}: ${e.message}`);
  }
};
const parse = (raw, p) => {
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`${p} is not valid JSON: ${e.message}`);
  }
};

const rawManifest = read(manifestPath);
const manifest = parse(rawManifest, manifestPath);

const current = manifest.version;
if (typeof current !== 'string' || !/^\d+\.\d+\.\d+$/.test(current)) {
  die(`plugin.json version is not x.y.z: ${JSON.stringify(current)}`);
}

if (!spec) {
  console.log(current);
  process.exit(0);
}

// Refuse to bump into a silent override.
const marketplace = existsSync(marketplacePath) ? parse(read(marketplacePath), marketplacePath) : {};
const override = (marketplace.plugins ?? []).find((p) => p && p.version !== undefined);
if (override) {
  die(`marketplace.json plugins[] entry "${override.name ?? '?'}" declares version `
    + `${JSON.stringify(override.version)}, which overrides plugin.json. Remove it, then bump.`);
}

let next;
if (/^\d+\.\d+\.\d+$/.test(spec)) {
  next = spec;
} else {
  const [major, minor, patch] = current.split('.').map(Number);
  if (spec === 'major') next = `${major + 1}.0.0`;
  else if (spec === 'minor') next = `${major}.${minor + 1}.0`;
  else if (spec === 'patch') next = `${major}.${minor}.${patch + 1}`;
  else die(`unknown bump: ${spec} (use major|minor|patch or an explicit x.y.z)`);
}

const cmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
if (cmp(next, current) <= 0) die(`${next} is not ahead of the current ${current}`);

// Rewrite the version in place so the file's hand-tuned formatting and comments survive —
// JSON.stringify would reflow the whole manifest.
const versionLine = /("version"\s*:\s*")\d+\.\d+\.\d+(")/;
if (!versionLine.test(rawManifest)) die('could not locate the version field in plugin.json');
writeFileSync(manifestPath, rawManifest.replace(versionLine, `$1${next}$2`));

console.log(next);
