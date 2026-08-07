#!/usr/bin/env node
// Convert a WebVTT meeting transcript into compact speaker-labelled text for synthesis.
//
// Raw .vtt is roughly 3x the size of the words spoken (cue IDs, timestamps, markup), which
// is what pushes a one-hour meeting past tool-result limits. This strips all of that and
// merges consecutive turns by the same speaker, so the model reads only "Speaker: words".
//
// Input (first argument) is either:
//   - a raw .vtt file, or
//   - a saved Drive tool-result: JSON with a string `fileContent` key holding the VTT.
//     (The Drive read tool backslash-escapes markup — `\<v Name\>`, `--\>` — so both the
//     escaped and unescaped forms are handled.)
//
// Output goes to --out <file> if given, otherwise next to the input as <input>.txt —
// never to stdout, so a large transcript can't flood a shell tool result. Stdout gets a
// one-line summary: output path, turn count, byte count, and the speaker labels seen.
// Compare those labels against the meeting's expected attendees before trusting
// attributions: fewer labels than attendees means shared mics or collapsed diarisation.
//
// Usage: node vtt-to-text.mjs <transcript.vtt | tool-result.json> [--out <file>]

import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outPath = outFlag !== -1 ? args[outFlag + 1] : null;
const inPath = args.find((a, i) => a !== '--out' && i !== outFlag + 1);
if (!inPath || (outFlag !== -1 && !outPath)) {
  console.error('Usage: node vtt-to-text.mjs <transcript.vtt | tool-result.json> [--out <file>]');
  process.exit(2);
}

let raw = readFileSync(inPath, 'utf8');
if (raw.trimStart().startsWith('{')) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.fileContent === 'string') raw = parsed.fileContent;
  } catch { /* not a tool-result wrapper; treat as raw VTT */ }
}
raw = raw.replace(/\\</g, '<').replace(/\\>/g, '>');

const isCueId = (ln) => /^[\w-]+\/\d+-\d+$/.test(ln) || /^\d+$/.test(ln);
const turns = [];
let speaker = null;
let text = null;

const flush = () => {
  if (text === null) return;
  const clean = text.replace(/<\/v>\s*$/, '').trim();
  if (clean) turns.push([speaker ?? 'Unknown', clean]);
  text = null;
};

for (let ln of raw.split('\n')) {
  ln = ln.trim();
  if (!ln || ln === 'WEBVTT' || ln.includes('-->') || isCueId(ln)) continue;
  const cue = ln.match(/^<v ([^>]+)>(.*)$/);
  if (cue) {
    flush();
    speaker = cue[1];
    text = cue[2];
  } else if (text !== null) {
    text += ` ${ln}`;
  } else {
    // Cue text with no <v> tag at all (some transcribers omit speakers entirely).
    speaker = null;
    text = ln;
  }
  if (text !== null && text.trimEnd().endsWith('</v>')) flush();
}
flush();

const merged = [];
for (const [sp, tx] of turns) {
  if (merged.length && merged[merged.length - 1][0] === sp) merged[merged.length - 1][1] += ` ${tx}`;
  else merged.push([sp, tx]);
}

const out = outPath ?? `${inPath.replace(/\.(vtt|json|txt)$/i, '')}.txt`;
const body = merged.map(([sp, tx]) => `${sp}: ${tx}`).join('\n\n') + '\n';
writeFileSync(out, body, 'utf8');

const speakers = [...new Set(merged.map(([sp]) => sp))].sort();
console.log(`${out} — ${merged.length} turns, ${Buffer.byteLength(body)} bytes, speakers: ${speakers.join(', ') || 'none'}`);
