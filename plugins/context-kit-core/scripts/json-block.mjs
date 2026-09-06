#!/usr/bin/env node
// Add or replace ONE top-level block in a hand-formatted JSON config, leaving every other byte
// of the file alone.
//
//   node json-block.mjs get     <file> <key>
//   node json-block.mjs set     <file> <key> <json-value>      # PLAN: prints the diff, writes nothing
//   node json-block.mjs set     <file> <key> <json-value> --write
//   node json-block.mjs set     <file> <key> --value-file <f>  # for a value too big for a shell argument
//   node json-block.mjs entries <file>                         # the top-level keys, in file order
//
//   --json    machine-readable result on stdout
//   --width N wrap an inline render longer than N columns (default 110)
//
// WHY THIS EXISTS. A context repo's context.json is hand-written and hand-formatted: a
// `_comment_[key]` above each block carrying the reasoning for it, inline objects laid out by
// hand, a deliberate key order. `JSON.stringify(cfg, null, 2)` reformats all of it — every
// inline object explodes into a block, every comment key moves, the trailing newline is lost —
// so a two-line change lands as ninety and the real edit becomes unreviewable. These files live
// in repos whose whole point is that their history reads. The diff IS the product.
//
// context-doctor.mjs got this right first, with a replaceOnce() that rewrites one exact token
// and refuses when the token is not unambiguous. That is the right instinct at token scale; this
// is the same instinct at BLOCK scale, and it is what a caller adding a whole new block needs.
// setup-connectors.mjs then grew its own one-key version of it. Rather than let a third caller
// invent a fourth, the operation lives here once.
//
// WHAT IS GUARANTEED
//   - Every line outside the edited block is byte-identical. Comment keys, key order,
//     indentation style and the trailing newline all survive, because none of them is ever
//     re-rendered — only the value span of one key is replaced, or one entry inserted.
//   - Insertion position is deterministic, not incidental: immediately after `_comment_[key]`
//     if the file declares one, otherwise as the last top-level entry. The comment convention is
//     "the reasoning sits directly above its block", so an insert that landed anywhere else
//     would orphan the comment the first time it ran.
//   - A file that does not parse is REFUSED, never rewritten. So is one whose top level is not
//     an object, and one where the resulting text would not parse back to the intended value.
//     There is no partial write and no "best effort": the caller is told what it must fix.
//
// WHAT IS NOT. Top-level keys only. A nested path (`state.notes`) is deliberately not supported:
// the caller would have to say what to do about a missing intermediate, and every use so far
// writes a whole block. Add it when something actually needs it, with that question answered.

import { readFileSync, writeFileSync } from 'node:fs';

export class JsonBlockError extends Error {}
const refuse = (m) => { throw new JsonBlockError(m); };

// ---------------------------------------------------------------- reading

// A BOM is not whitespace and JSON.parse rejects it, but editors leave them behind. Strip for
// parsing only — the raw text keeps its BOM so a write does not silently change the encoding.
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

export function parseConfig(raw) {
  try { return JSON.parse(stripBom(raw)); }
  catch (e) { refuse(`not valid JSON (${e.message}) — refusing to rewrite a file this cannot read`); }
}

// ---------------------------------------------------------------- scanning the raw text

// Assumes raw[i] is the opening quote. Returns the index one past the closing quote.
function endOfString(raw, i) {
  let esc = false;
  for (let j = i + 1; j < raw.length; j++) {
    const c = raw[j];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') return j + 1;
  }
  return -1;
}

// Index one past the end of the JSON value starting at i. Brace/bracket matched and
// string-aware, so a `{` inside a string cannot open a level and a `}` inside one cannot close
// it — the trap that makes a regex approach to this quietly wrong on comment-heavy files.
function endOfValue(raw, i) {
  const c = raw[i];
  if (c === '"') return endOfString(raw, i);
  if (c === '{' || c === '[') {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { if (--depth === 0) return j + 1; }
    }
    return -1;
  }
  // A primitive: number, true, false, null. Ends at the first delimiter or whitespace.
  let j = i;
  while (j < raw.length && !/[\s,}\]]/.test(raw[j])) j++;
  return j === i ? -1 : j;
}

// Every TOP-LEVEL entry, in file order, with the exact span of its key and of its value.
// Top-level is the whole point: a `"connections"` nested inside `state` must not be mistaken for
// the one at the root, and a raw text search cannot tell them apart.
export function scanTopLevel(raw) {
  let i = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  if (raw[i] !== '{') refuse('top level is not an object — nothing here can add a block to it');
  const objectStart = i;
  i++;
  const entries = [];
  for (;;) {
    while (i < raw.length && /[\s,]/.test(raw[i])) i++;
    if (i >= raw.length) refuse('unterminated top-level object');
    if (raw[i] === '}') return { objectStart, objectEnd: i, entries };
    if (raw[i] !== '"') refuse(`unexpected ${JSON.stringify(raw[i])} where a top-level key was expected`);
    const keyStart = i;
    const keyEnd = endOfString(raw, i);
    if (keyEnd < 0) refuse('unterminated key string');
    const key = JSON.parse(raw.slice(keyStart, keyEnd));
    i = keyEnd;
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (raw[i] !== ':') refuse(`no ":" after top-level key ${JSON.stringify(key)}`);
    i++;
    while (i < raw.length && /\s/.test(raw[i])) i++;
    const valueStart = i;
    const valueEnd = endOfValue(raw, i);
    if (valueEnd < 0) refuse(`could not find the end of the value for ${JSON.stringify(key)}`);
    entries.push({ key, keyStart, keyEnd, valueStart, valueEnd });
    i = valueEnd;
  }
}

// The indent of the line a given offset sits on — the leading run of spaces or tabs, whatever
// the file already uses. Never assume two spaces: a multi-line render that does not line up with
// its neighbours announces which tool wrote it.
const indentAt = (raw, at) => {
  const lineStart = raw.lastIndexOf('\n', at - 1) + 1;
  return (raw.slice(lineStart, at).match(/^[ \t]*/) ?? [''])[0];
};

// One level of indentation, read off the file rather than assumed. The first indented top-level
// key is the honest sample; a file with no top-level keys at all has no evidence, so two spaces.
export function detectIndentUnit(raw, scan) {
  for (const e of scan.entries) {
    const ind = indentAt(raw, e.keyStart);
    if (ind) return ind;
  }
  return '  ';
}

// ---------------------------------------------------------------- rendering a value

const inlineRender = (v) => {
  if (Array.isArray(v)) return v.length ? `[${v.map(inlineRender).join(', ')}]` : '[]';
  if (v && typeof v === 'object') {
    const es = Object.entries(v);
    return es.length ? `{ ${es.map(([k, x]) => `${JSON.stringify(k)}: ${inlineRender(x)}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(v);
};

// Render in the prevailing inline style, dropping to one entry per line only when a single line
// would be unreadable. Matches how these files are already written by hand: short blocks inline,
// long ones expanded, and never one rule mechanically applied to both.
export function renderValue(value, indent, { unit = '  ', width = 110 } = {}) {
  const one = inlineRender(value);
  if (indent.length + one.length <= width) return one;
  const pad = indent + unit;
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[\n${value.map((x) => pad + renderValue(x, pad, { unit, width })).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const es = Object.entries(value);
    if (!es.length) return '{}';
    return `{\n${es.map(([k, x]) => `${pad}${JSON.stringify(k)}: ${renderValue(x, pad, { unit, width })}`).join(',\n')}\n${indent}}`;
  }
  return one;   // a long string has no expanded form; a wrapped one would change its value
}

// ---------------------------------------------------------------- the edit

const deepEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
};

/**
 * Add or replace one top-level block. Returns the new text and what it did; never writes.
 * Throws JsonBlockError, having changed nothing, if the file cannot be read or the edit cannot
 * be made safely.
 *
 * @returns {{text: string, action: 'replaced'|'inserted'|'unchanged', after: string|null, changed: boolean}}
 */
export function upsertBlock(raw, key, value, { width = 110 } = {}) {
  const before = parseConfig(raw);          // refuses an unparseable file before touching anything
  const scan = scanTopLevel(raw);
  const unit = detectIndentUnit(raw, scan);
  const opts = { unit, width };

  // Line endings are read off the file too. Every one of these configs is committed from a
  // Windows checkout and is therefore CRLF on disk; splicing in a fragment with bare LFs would
  // leave the file mixed, and the next tool that normalises it would rewrite every line — the
  // whole-file churn this exists to prevent, arriving one commit later instead.
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const nl = (s) => (eol === '\n' ? s : s.replace(/\n/g, eol));

  const existing = scan.entries.find((e) => e.key === key);
  let text, action, after;

  if (existing) {
    // Replace the VALUE span only. The key, its line, the comment above it and everything either
    // side of it are untouched, so an unchanged value is a byte-identical file.
    const indent = indentAt(raw, existing.keyStart);
    text = raw.slice(0, existing.valueStart) + nl(renderValue(value, indent, opts)) + raw.slice(existing.valueEnd);
    action = 'replaced';
    after = null;
  } else {
    // Deterministic placement: directly under this block's own comment key if the file declares
    // one, otherwise last. Anything else — alphabetical, or "wherever the parser happened to
    // stop" — would separate a comment from the block it explains.
    const anchor = scan.entries.find((e) => e.key === `_comment_${key}`)
      ?? scan.entries[scan.entries.length - 1];
    if (!anchor) {
      // An empty top-level object has no line to copy an indent from, and no comma to write.
      const inner = nl(`\n${unit}${JSON.stringify(key)}: ${renderValue(value, unit, opts)}\n`);
      text = `${raw.slice(0, scan.objectStart + 1)}${inner}${raw.slice(scan.objectEnd)}`;
      action = 'inserted';
      after = null;
    } else {
      const indent = indentAt(raw, anchor.keyStart);
      // Inserted immediately after the anchor's value. Any comma that already followed the
      // anchor now follows the inserted entry instead, which is correct in both cases: mid-file
      // the list stays comma-separated, and at the end there was no comma to displace.
      const entry = nl(`,\n${indent}${JSON.stringify(key)}: ${renderValue(value, indent, opts)}`);
      text = raw.slice(0, anchor.valueEnd) + entry + raw.slice(anchor.valueEnd);
      action = 'inserted';
      after = anchor.key;
    }
  }

  // Never hand back a file that stopped being valid JSON, or that says something other than what
  // the caller asked for. Cheap, and it turns every rendering bug into a refusal rather than a
  // corrupted context repo.
  let round;
  try { round = JSON.parse(stripBom(text)); }
  catch (e) { refuse(`the edit would not have parsed (${e.message}); nothing written`); }
  if (!deepEqual(round, { ...before, [key]: value })) {
    refuse(`the edit did not round-trip to the intended value; nothing written`);
  }

  return { text, action, after, changed: text !== raw };
}

/** Read a file, upsert one block, and write it back only if it changed. */
export function upsertBlockInFile(file, key, value, { width = 110, write = true } = {}) {
  const raw = readFileSync(file, 'utf8');
  const result = upsertBlock(raw, key, value, { width });
  if (write && result.changed) writeFileSync(file, result.text);
  return { ...result, before: raw };
}

// ---------------------------------------------------------------- CLI

// A plan-by-default CLI, matching init-context.mjs: the default run writes nothing and shows what
// it would do, and it takes an explicit --write to act. It is also how this file is verified —
// this repo has no test runner, so externally visible CLI behaviour is the seam.
function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')[0]));
  const flagValue = (name) => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : null;
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { if (!a.includes('=') && ['width', 'value-file'].includes(a.slice(2))) i++; continue; }
    positional.push(a);
  }

  const [cmd, file, key, valueArg] = positional;
  const width = Number(flagValue('width') ?? 110);
  const asJson = flags.has('json');
  const out = (o, human) => { if (asJson) console.log(JSON.stringify(o, null, 2)); else human(); };

  if (!cmd || !file) {
    console.error('usage: json-block.mjs entries|get|set <file> [key] [json-value] [--write] [--json] [--width N]');
    process.exit(2);
  }

  const raw = readFileSync(file, 'utf8');

  if (cmd === 'entries') {
    const scan = scanTopLevel(raw);
    const keys = scan.entries.map((e) => e.key);
    out({ file, indentUnit: JSON.stringify(detectIndentUnit(raw, scan)), keys },
      () => { for (const k of keys) console.log(k); });
    return;
  }

  if (cmd === 'get') {
    if (!key) { console.error('json-block.mjs get: a key is required'); process.exit(2); }
    const cfg = parseConfig(raw);
    const present = Object.hasOwn(cfg, key);
    out({ file, key, present, value: present ? cfg[key] : null },
      () => console.log(present ? JSON.stringify(cfg[key], null, 2) : `(absent)`));
    if (!present) process.exit(1);
    return;
  }

  if (cmd === 'set') {
    if (!key) { console.error('json-block.mjs set: a key is required'); process.exit(2); }
    const valueFile = flagValue('value-file');
    const source = valueFile ? readFileSync(valueFile, 'utf8') : valueArg;
    if (source === undefined || source === null) {
      console.error('json-block.mjs set: a json-value argument or --value-file is required');
      process.exit(2);
    }
    let value;
    try { value = JSON.parse(source); }
    catch (e) { console.error(`json-block.mjs set: the value is not valid JSON (${e.message})`); process.exit(2); }

    const result = upsertBlock(raw, key, value, { width });
    const write = flags.has('write');
    if (write && result.changed) writeFileSync(file, result.text);

    // "Everything else survives untouched" is the claim this tool actually makes, so report it
    // rather than leaving a reviewer to diff for it. The edit is always one contiguous run, so
    // the honest measure is the common prefix and suffix of whole lines: matching by line INDEX
    // would count every line after an insertion as changed, which is exactly the alarm this tool
    // exists to avoid raising.
    const beforeLines = raw.split('\n');
    const afterLines = result.text.split('\n');
    let pre = 0;
    while (pre < beforeLines.length && pre < afterLines.length && beforeLines[pre] === afterLines[pre]) pre++;
    let suf = 0;
    while (suf < beforeLines.length - pre && suf < afterLines.length - pre
      && beforeLines[beforeLines.length - 1 - suf] === afterLines[afterLines.length - 1 - suf]) suf++;
    const removed = beforeLines.length - pre - suf;
    const added = afterLines.length - pre - suf;
    const untouched = pre + suf;

    out({ file, key, action: result.action, after: result.after, changed: result.changed, written: write && result.changed, linesBefore: beforeLines.length, linesAfter: afterLines.length, linesUntouched: untouched, linesRemoved: removed, linesAdded: added },
      () => {
        console.log(`json-block — ${file}`);
        console.log(`  ${result.action} "${key}"${result.after ? ` after "${result.after}"` : ''}`);
        console.log(`  ${beforeLines.length} lines in, ${afterLines.length} out; `
          + `${untouched} untouched, ${removed} removed, ${added} added`);
        console.log(write
          ? (result.changed ? '  written' : '  no change — nothing written')
          : '  PLAN ONLY — re-run with --write to apply');
      });
    return;
  }

  console.error(`json-block.mjs: unknown command ${JSON.stringify(cmd)}`);
  process.exit(2);
}

if (process.argv[1] && process.argv[1].endsWith('json-block.mjs')) {
  try { main(process.argv.slice(2)); }
  catch (e) {
    if (e instanceof JsonBlockError) { console.error(`json-block.mjs: ${e.message}`); process.exit(1); }
    throw e;
  }
}
