#!/usr/bin/env node
// PostToolUse hook: when a numbered ADR under a `docs/adr/` directory is written or edited, tell
// the model to offer mirroring it into the project's Notion decision log with `log-decision`.
//
// WHY A HOOK. On 2026-09-09 an ADR was written, reviewed, merged and its issue closed, and the
// decision log never got a row — the only prompt to mirror lived in one skill
// (domain-modeling), and that ADR arrived another way. ADRs are also written by `implement`, by
// spec follow-ups and by hand; a file-write trigger is the one place every route passes through.
// The session then told the issue the project had no decision log at all, because it looked for
// its config in the code repo. Under ADR 0002 the config is found by walking up to the nearest
// `.claude/workspace.json`, which is what this does — from the ADR's own directory.
//
// IT NUDGES; IT NEVER WRITES. The row is `log-decision`'s job: what it should say needs the ADR's
// reasoning and the resolved `state.notion` block. A hook POSTing on its own would have only a
// file path to go on and would produce rows keyed on filenames. So the output is
// `hookSpecificOutput.additionalContext` — read by the model in the same turn — and never
// `systemMessage` (the user sees that, the model does not, and the mirroring becomes a task on
// someone's list) nor `decision: "block"` (this is a nudge, not a gate).
//
// THE PREDICATE IS THE PATH, AND IT RUNS FIRST. This hook runs on every Write/Edit in every
// session where the plugin is enabled, so nothing — no import of the resolver, no file read, no
// state file — happens until the written path is a numbered ADR: basename starting with a digit
// sequence, directly inside a directory named `adr` whose parent is `docs`. That admits
// `0001-slug.md` and rejects `.gitkeep`, `README.md` and `template.md`. The file's content is not
// read. hooks.json's matcher keeps it to the file-writing tools; the per-handler `if` filter was
// considered and not used, because a Claude Code that does not know the key may drop the whole
// handler, and that failure is silence — the exact thing this hook exists to end.
//
// ANY docs/adr/ INSIDE THE WORKSPACE COUNTS, not only the root's. ADR 0002 puts the workspace's
// own ADRs at `docs/adr/`, but a session opened in a member repo writes its ADRs to the member's
// `docs/adr/` (domain-modeling writes into whatever repo it is in) — and that is the incident's
// shape. The walk up from the ADR finds the same workspace either way, and that workspace's
// decision log is the one the row belongs in.
//
// GATED ON A DECISION LOG TO WRITE TO. The config ladder is lib.mjs's: `CONTEXT_CONFIG` if
// pinned (tests, and anyone who pins it), else the nearest workspace.json above the ADR via
// findWorkspace(). lib.mjs itself is not imported: it exits the process on a config it cannot
// load and writes to stderr, and a hook must do neither. No workspace above the ADR means no
// nudge — silence, which is the failure this hook is allowed. No `state.backend: "notion"`, or no
// `decisionLog` in `databases` or `pageParents`, means there is nowhere to log to, and a nudge
// toward somewhere that does not exist is worse than none. Reachability is NOT tested here:
// configured-but-offline is `add-pending`'s case, and the injected text says so.
//
// ONCE PER ADR PER SESSION. Iterative edits and a declined offer must not re-ask, so each path
// nudged is recorded in a per-session file under the OS temp dir, keyed by `session_id`. That
// is cheap and goes away with the temp dir; a stale entry costs one missed nudge, which beats
// a wall of identical injections. A state file that cannot be written does not stop the nudge.
//
// NODE, NOT SHELL. No jq to be missing, and no bare `bash` to resolve to WSL's System32\bash.exe
// on Windows — a hook command string cannot pick Git Bash, so the way to stay clear of that is
// not to need bash at all (connection-gate.mjs is the precedent).
//
// FAIL SILENT. Every path exits 0, and every error — unreadable stdin, malformed JSON, missing or
// malformed config — exits with no output, so a broken hook never blocks a write or ends a turn.
//
//   echo '{"session_id":"s","cwd":"/ws","tool_name":"Write","tool_input":{"file_path":"/ws/docs/adr/0001-x.md"}}' \
//     | node hooks/adr-nudge.mjs
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

const quiet = () => process.exit(0);

// The numbered-ADR test, on the path alone. Both separators are split on because a Windows
// session hands over `C:\…\docs\adr\0001-x.md`, and the hook may be reading it on either side.
const isAdr = (file) => {
  const parts = file.split(/[\\/]+/);
  const name = parts.at(-1) ?? '';
  return /^\d+/.test(name)
    && parts.at(-2)?.toLowerCase() === 'adr'
    && parts.at(-3)?.toLowerCase() === 'docs';
};

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

// Is there a decision log to mirror into? Either id is enough: log-decision resolves the other.
const hasDecisionLog = (config) => {
  const state = config?.state;
  if (!state || state.backend !== 'notion' || !state.notion || typeof state.notion !== 'object') return false;
  return Boolean(state.notion.databases?.decisionLog || state.notion.pageParents?.decisionLog);
};

// -> true the first time this session sees `file`, false after. Recorded BEFORE the nudge is
// printed, so a nudge that the model then declines is already on the list.
const firstTime = (sessionId, file) => {
  if (!sessionId) return true;
  // Windows paths compare case-insensitively; a re-cased path is the same ADR.
  const key = process.platform === 'win32' ? file.toLowerCase() : file;
  const dir = join(tmpdir(), 'context-notion-adr-nudge');
  const state = join(dir, `${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}.txt`);
  let seen = [];
  try { seen = readFileSync(state, 'utf8').split('\n'); } catch { /* first nudge this session */ }
  if (seen.includes(key)) return false;
  try { mkdirSync(dir, { recursive: true }); appendFileSync(state, `${key}\n`); } catch { /* nudge anyway */ }
  return true;
};

try {
  let event;
  try { event = JSON.parse(readFileSync(0, 'utf8')); } catch { quiet(); }
  const raw = event?.tool_input?.file_path;
  if (typeof raw !== 'string' || !raw || !isAdr(raw)) quiet();

  // Relative paths resolve against the session's cwd, which the event carries.
  const file = resolve(typeof event.cwd === 'string' && event.cwd ? event.cwd : process.cwd(), raw);

  // Only now is the resolver loaded — the path test above is all a non-ADR write ever costs.
  let config, root;
  if (process.env.CONTEXT_CONFIG) {
    config = readJson(process.env.CONTEXT_CONFIG);
    root = dirname(dirname(dirname(file)));
  } else {
    const { findWorkspace } = await import('../scripts/workspace.mjs');
    const found = findWorkspace(dirname(file));
    if (!found?.root) quiet();
    ({ config, root } = found);
  }
  if (!hasDecisionLog(config)) quiet();
  if (!firstTime(event.session_id, file)) quiet();

  const shown = relative(root, file).split(/[\\/]+/).join('/') || basename(file);
  // Write's response says whether it created the file; Edit always changes an existing one.
  const created = event.tool_name === 'Write' && event.tool_response?.type === 'create';
  const lines = [
    `An Architecture Decision Record was ${created ? 'written' : 'changed'}: ${shown}.`,
    'This project has a Notion decision log (state.notion.decisionLog), and ADRs do not reach it on their own.',
    `Before ending the turn, ASK the user whether to mirror this decision there with the context-notion log-decision skill — do not log it unasked. Name the ADR's filename (${basename(file)}) in the row, so its reasoning is one hop away rather than paraphrased into a Notion property.`,
    created
      ? 'Skip the offer if the decision is already logged.'
      : 'This file may already have a row: check with query-decisions first and update or supersede that row rather than creating a duplicate. A typo fix or wording change needs no offer at all; a status change (accepted, superseded) does.',
    'If the user declines, drop it — you will not be reminded about this ADR again this session. If Notion is configured but unreachable, queue the row with add-pending instead.',
  ];
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join(' ') },
  }));
  process.exit(0);
} catch {
  quiet();
}
