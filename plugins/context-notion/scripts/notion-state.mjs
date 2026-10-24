#!/usr/bin/env node
// Write this plugin's two keys of `state` — `state.backend` and `state.notion` — into the
// project's config, and nothing else. notion-discover's last step.
//
//   node notion-state.mjs <config> <notion-block.json>          # PLAN: says what it would do, writes nothing
//   node notion-state.mjs <config> <notion-block.json> --write  # ...and does it
//   node notion-state.mjs <config> - --write                    # the block on stdin
//   --json   machine-readable result
//
// <config> is `node layout.mjs "$ROOT" config`: `.claude/workspace.json` in a workspace,
// `context.json` in a legacy context repo. The same rule holds for both.
//
// WHY A SCRIPT. `state` is not this plugin's block — each `state.*` key belongs to the plugin
// that reads it (ADR 0002; workspace.mjs's header), and workspace.json's other top-level keys
// belong to project-workspace and setup-connectors. notion-discover used to read the file,
// set `"state": { "backend": "notion", "notion": {…} }` and write the whole file back, which
// replaced `state` outright: any sibling block under it was gone, and the commit that dropped it
// was titled "discover Notion state block". So the merge happens here, deterministically:
// every other key of `state` keeps its value and its position, `backend` and `notion` are
// replaced where they sit (or appended), and the file outside `state` is byte-identical,
// because json-block.mjs replaces one top-level value span and refuses anything that would not
// round-trip.
//
// Refuses — exit 1, nothing written — a config that does not parse, a `state` that is neither
// absent, null nor an object, and a block that is not a JSON object.
import { readFileSync, writeFileSync } from 'node:fs';
import { JsonBlockError, parseConfig, upsertBlock } from './json-block.mjs';

const args = process.argv.slice(2);
const [file, source] = args.filter((a) => !a.startsWith('--'));
const write = args.includes('--write');
const asJson = args.includes('--json');

if (!file || !source) {
  console.error('usage: notion-state.mjs <config> <notion-block.json|-> [--write] [--json]');
  process.exit(2);
}

const fail = (m) => { console.error(`notion-state.mjs: ${m}`); process.exit(1); };

try {
  const raw = readFileSync(file, 'utf8');
  const before = parseConfig(raw);
  if (before === null || typeof before !== 'object' || Array.isArray(before)) fail(`${file}: top level is not a JSON object`);

  let block;
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8');
  try { block = JSON.parse(text); } catch (e) { fail(`the notion block is not valid JSON (${e.message})`); }
  if (block === null || typeof block !== 'object' || Array.isArray(block)) fail('the notion block must be a JSON object');

  // A fresh config carries `"state": null` (context-template did); absent and null both mean
  // "no state yet". Anything else that is not an object is someone's data, not ours to replace.
  const state = before.state ?? {};
  if (typeof state !== 'object' || Array.isArray(state)) {
    fail(`${file}: \`state\` is ${JSON.stringify(state)}, not an object — fix it by hand; nothing written`);
  }
  // Spread keeps each existing key where it is; the two assignments replace in place or append.
  const next = { ...state, backend: 'notion', notion: block };
  const result = upsertBlock(raw, 'state', next);
  if (write && result.changed) writeFileSync(file, result.text);

  const kept = Object.keys(state).filter((k) => k !== 'backend' && k !== 'notion');
  const report = {
    file, changed: result.changed, written: write && result.changed,
    previousBackend: state.backend ?? null, replacedNotion: Object.hasOwn(state, 'notion'), keptStateKeys: kept,
  };
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`notion-state — ${file}`);
    console.log(`  state.backend: ${JSON.stringify(report.previousBackend)} -> "notion"`);
    console.log(`  state.notion: ${report.replacedNotion ? 'replaced' : 'added'}`);
    console.log(`  other state keys kept as they were: ${kept.length ? kept.join(', ') : '(none)'}`);
    console.log(write
      ? (result.changed ? '  written' : '  no change — nothing written')
      : '  PLAN ONLY — re-run with --write to apply');
  }
} catch (e) {
  if (e instanceof JsonBlockError) fail(e.message);
  if (e?.code === 'ENOENT') fail(`${e.path}: no such file`);
  throw e;
}
