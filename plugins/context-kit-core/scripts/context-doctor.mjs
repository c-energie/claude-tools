#!/usr/bin/env node
// Health check for a context repo — the drift and misconfiguration that no session ever
// reports, because every one of these failures is SILENT.
//
//   node context-doctor.mjs <root>                      # report on that context checkout
//   node context-doctor.mjs <root> --include            # ...and report (never fix) on its includes
//   node context-doctor.mjs <root> --json               # machine-readable findings
//   node context-doctor.mjs <root> --fix                # apply the derivable JSON fixes, in place
//   node context-doctor.mjs <root> --today 2026-08-18   # pin dates so output can be compared
//
// WHAT IT MAY WRITE: keys in context.json and .claude/settings.json, and only where the
// correct value is *derivable* from something else already in the repo. Never markdown, never
// a value it would have to guess. That envelope is the whole safety property — a context repo
// is hand-written prose that exists in exactly one copy, and a diagnostic has no business
// rewriting it. Findings outside the envelope are reported with the fix spelled out instead.
//
// Includes are READ-ONLY here, as everywhere: --include reports on them and --fix skips them,
// because writing into an included repo is the one thing the cross-project layer forbids.
//
// Exit 0 = it ran (with or without findings). Exit 2 = it could NOT run. The caller must be
// able to tell "nothing wrong" from "never looked" — a silent clean bill of health on a check
// that never executed is the failure mode this whole plugin exists to prevent.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';

const OPTIONS = ['json', 'fix', 'include', 'today'];
// In step with hooks/load-context.sh, scripts/context-repo.sh and scripts/link-context.mjs.
const OPTOUT = ['none', 'off', 'false', 'no', '-', 'disabled'];
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PENDING_STALE_DAYS = 30;
const MEMORY_STALE_DAYS = 90;

const die = (m) => { console.error(`context-doctor.mjs: ${m}`); process.exit(2); };

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flags = new Set();
const positional = [];
let todayArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--today') todayArg = argv[++i];
  else if (a.startsWith('--')) flags.add(a.slice(2));
  else positional.push(a);
}
for (const f of flags) if (!OPTIONS.includes(f)) die(`unknown option --${f} (use ${OPTIONS.map((o) => `--${o}`).join(', ')})`);

if (!positional[0]) die('needs the context checkout as its first argument (bash scripts/context-repo.sh --no-pull)');
const ROOT = resolve(positional[0]);
if (!existsSync(ROOT)) die(`no such directory: ${ROOT}`);

const today = todayArg ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) die(`--today needs YYYY-MM-DD, got ${todayArg}`);
const daysSince = (iso) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / 86400000);

// ---------------------------------------------------------------- findings

// err  = actively broken, or actively misleading (worse than broken)
// warn = worth a look
// note = context for a human, not a defect
const findings = [];
const add = (level, check, message, fix = null) => findings.push({ level, check, message, fix });

const readJson = (file) => {
  const raw = readFileSync(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);   // BOM, if an editor left one
};
// --fix edits the RAW TEXT, not a parsed-and-restringified object. Round-tripping through
// JSON.stringify reformats the whole file — inline objects explode into blocks — burying one
// semantic change in a screenful of churn. For a tool whose entire claim is a minimal,
// auditable write, the diff IS the product. Each edit therefore rewrites one exact token, and
// refuses when that token is not unambiguous.
//
// Returns the new text, or null when the edit could not be made safely (caller reports it
// instead of writing).
const replaceOnce = (text, pattern, replacement) => {
  const matches = text.match(pattern);
  if (!matches || matches.length !== 1) return null;   // absent, or ambiguous — do not guess
  return text.replace(pattern, replacement);
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every connection name a provider declares, whichever of the three shapes it used: one name,
// a list, or a map of resource owner to name. Total on any input — this feeds warnings, so a
// malformed value must yield nothing to say rather than take the whole check down. In step with
// names() in hooks/connection-gate.mjs and scripts/mcp/setup-connectors.mjs.
const namesOf = (v) => {
  if (typeof v === 'string') return v ? [v] : [];
  if (Array.isArray(v)) return v.filter((n) => typeof n === 'string' && n);
  if (v && typeof v === 'object') return Object.values(v).filter((n) => typeof n === 'string' && n);
  return [];
};

// ---------------------------------------------------------------- context.json

const ctxFile = join(ROOT, 'context.json');
let ctx = null;
if (!existsSync(ctxFile)) {
  add('err', 'context.json', 'no context.json at the root — this directory is not a context repo');
} else {
  try {
    const parsed = readJson(ctxFile);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      add('err', 'context.json', 'context.json is not a JSON object');
    } else {
      ctx = parsed;
    }
  } catch (e) {
    add('err', 'context.json', `context.json is not valid JSON (${e.message}) — nothing else could be checked against it`);
  }
}

if (ctx) {
  if (!ctx.contextRepo) {
    add('err', 'contextRepo', 'context.json has no "contextRepo" — the resolver cannot confirm what this checkout is');
  } else if (!REPO_RE.test(String(ctx.contextRepo))) {
    add('err', 'contextRepo', `"contextRepo": ${JSON.stringify(ctx.contextRepo)} is not an owner/repo name`);
  }

  // The stamp. Nothing in any plugin reads it, so it drifts unnoticed — report it, and compare
  // against a template clone only if one is actually present. A version hard-coded in the
  // plugin would itself be a fact that goes stale, which is the bug being reported.
  const stamp = ctx.template?.version ?? null;
  const tmplDir = process.env.CONTEXT_TEMPLATE_DIR ?? join(homedir(), '.context', 'c-energie', 'context-template');
  let tmplVersion = null;
  try { tmplVersion = readJson(join(tmplDir, 'context.json')).template?.version ?? null; } catch { /* reported below */ }

  if (!ctx.template) {
    add('warn', 'template', 'no "template" block — this repo records no lineage from c-energie/context-template. A repo that predates the template should say so deliberately rather than leave it blank.');
  } else if (!stamp) {
    add('warn', 'template', 'the "template" block has no version');
  } else if (tmplVersion && stamp !== tmplVersion) {
    add('warn', 'template', `stamped ${stamp}, template clone is at ${tmplVersion}. The stamp is decorative — nothing reads it — so check by hand which changes actually apply before touching anything.`);
  } else if (!tmplVersion) {
    add('note', 'template', `stamped ${stamp} — no template clone at ${tmplDir}, so it could not be compared`);
  }

  // This filter MIRRORS the hook's include parser (load-context.sh). An entry the hook drops
  // loads nothing and says nothing, so a typo here costs a whole project's context with no
  // symptom at all. Keep the two in step.
  if (ctx.include !== undefined) {
    if (!Array.isArray(ctx.include)) {
      add('err', 'include', '"include" is not an array — the hook ignores it entirely');
    } else {
      const seen = new Set();
      for (const raw of ctx.include) {
        if (typeof raw !== 'string') {
          add('err', 'include', `include entry ${JSON.stringify(raw)} is not a string — the hook drops it silently`);
          continue;
        }
        const v = raw.trim();
        if (OPTOUT.includes(v.toLowerCase())) {
          add('note', 'include', `include entry "${v}" is an opt-out sentinel — deliberately skipped`);
        } else if (!REPO_RE.test(v)) {
          add('err', 'include', `include entry "${v}" is not an owner/repo name — the hook drops it silently, so that project's context never loads`);
        } else if (v === ctx.contextRepo) {
          add('warn', 'include', `include entry "${v}" is this repo itself — the hook drops it`);
        } else if (seen.has(v)) {
          add('warn', 'include', `include entry "${v}" is listed twice`);
        } else {
          seen.add(v);
        }
      }
    }
  }

  if (ctx.connections !== undefined
      && (typeof ctx.connections !== 'object' || ctx.connections === null || Array.isArray(ctx.connections))) {
    add('err', 'connections', '"connections" is not an object');
  } else if (ctx.connections) {
    // Each provider names one connection, or a map of resource owner -> connection. A value the
    // gate cannot read is not cosmetic: connection-gate.mjs denies every call for that provider,
    // so a session loses the connector entirely and the refusal blames the wrong thing.
    for (const [provider, v] of Object.entries(ctx.connections)) {
      // NAMING IS LOAD-BEARING. connection-gate.mjs classifies a connector by this block first,
      // then by sniffing the name for a provider word. So a name carrying no provider word is
      // gated *here* — and nowhere else: in every other project on the machine nothing can tell
      // what it is, and it is allowed unchecked. A GitHub connector called "claude-tools" was
      // live and ungated across every project on this machine, 2026-08-30. The gate cannot fix
      // that (it can never know what another project's connectors are for); only a rename can,
      // so this is the one place the problem is visible while it is still cheap.
      for (const n of namesOf(v)) {
        if (!n.toLowerCase().includes(provider.toLowerCase())) {
          add('warn', 'connections',
            `connection "${n}" does not contain "${provider}", so outside this project the gate `
            + 'cannot classify it and allows it unchecked. Rename it to carry the provider, and '
            + 'move the Claude configs, the stored credential and this block together.');
        }
      }
      if (typeof v === 'string') {
        if (!v) add('err', 'connections', `"${provider}" is an empty string — omit it, or name the connection`);
        continue;
      }
      if (Array.isArray(v)) {
        add('warn', 'connections',
          `"${provider}" is a list. It works, but it does not say which connection serves which `
          + 'owner, so a caller cannot choose and finds out by 404. Prefer a map: '
          + `{ "owner": "${v.find((n) => typeof n === 'string') ?? 'connection-name'}" }`);
        continue;
      }
      if (!v || typeof v !== 'object') {
        add('err', 'connections', `"${provider}" is neither a connection name nor a map of owner to name`);
        continue;
      }
      const pairs = Object.entries(v);
      if (!pairs.length) {
        add('err', 'connections',
          `"${provider}" is an empty map, which declares nothing while looking deliberate. `
          + 'Remove the key, or set connections to {} if this project declares none on purpose.');
      }
      for (const [owner, name] of pairs) {
        if (typeof name !== 'string' || !name) {
          add('err', 'connections', `"${provider}.${owner}" is not a connection name`);
        }
      }
      // One workspace is almost always right for these; two is a judgement call, not an error.
      if (pairs.length > 1 && provider !== 'github') {
        add('warn', 'connections',
          `"${provider}" declares ${pairs.length} connections. Multiple owners is a GitHub fact `
          + '(a fine-grained PAT has one resource owner); for other providers two usually means '
          + 'two workspaces have been merged into one project by mistake.');
      }
    }
  }
}

// ---------------------------------------------------------------- the repo's own settings

// Which plugin ids actually exist. Without a marketplace this check cannot run, and saying so
// is the point: an unverifiable id must never read as a verified one.
const kitDir = process.env.CONTEXT_KIT_PLUGIN_DIR ?? join(homedir(), '.context', 'c-energie', 'context-kit');
let known = null;
try {
  const mk = readJson(join(kitDir, '.claude-plugin', 'marketplace.json'));
  known = { name: mk.name, plugins: (mk.plugins ?? []).map((p) => p.name) };
} catch { /* reported at the use site */ }

const setFile = join(ROOT, '.claude', 'settings.json');
let settings = null;
if (existsSync(setFile)) {
  try {
    const parsed = readJson(setFile);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) settings = parsed;
    else add('err', 'settings', '.claude/settings.json is not a JSON object');
  } catch (e) {
    add('err', 'settings', `.claude/settings.json is not valid JSON (${e.message})`);
  }
}

if (settings) {
  const enabled = settings.enabledPlugins ?? {};
  if (!known) {
    add('note', 'plugins', `could not read a marketplace at ${kitDir} — enabledPlugins ids were NOT verified`);
  } else {
    for (const key of Object.keys(enabled)) {
      const [plugin, market] = String(key).split('@');
      if (market !== known.name) continue;              // another marketplace's business
      if (known.plugins.includes(plugin)) continue;     // fine
      // Derivable only when exactly one real plugin extends the name that was written. That
      // rule is what makes this a fix rather than a guess: "context-kit" resolves to
      // "context-kit-core" when core is the sole candidate; anything ambiguous stays a report.
      const candidates = known.plugins.filter((p) => p.startsWith(`${plugin}-`));
      const fix = candidates.length === 1
        ? { file: setFile, kind: 'rename-enabled-plugin', from: key, to: `${candidates[0]}@${market}` }
        : null;
      add('err', 'plugins',
        `.claude/settings.json enables "${key}", but no plugin named "${plugin}" exists in the "${market}" marketplace (it ships ${known.plugins.join(', ')}). That line does nothing — the plugins load only because something else enables them.`,
        fix);
    }
  }

  // A repo whose own env block disagrees with its own context.json is a real trap: a session
  // opened IN the context repo resolves by env first, so it wins over the file beside it.
  const envRepo = settings.env?.PROJECT_CONTEXT_REPO;
  if (ctx?.contextRepo && envRepo
      && !OPTOUT.includes(String(envRepo).trim().toLowerCase())
      && envRepo !== ctx.contextRepo) {
    add('err', 'settings',
      `.claude/settings.json sets PROJECT_CONTEXT_REPO=${envRepo} but context.json says ${ctx.contextRepo} — env wins, so a session here loads the other repo`,
      { file: setFile, kind: 'align-env-repo', to: ctx.contextRepo });
  }
}

// The canonical generated marker, per the core invariant: one committable file per context
// repo, and the file a Cowork session gets attached.
const markerFile = join(ROOT, '.claude', 'context-project.json');
if (!existsSync(markerFile)) {
  add('warn', 'marker', 'no .claude/context-project.json — a Cowork session has nothing to attach. Any laptop session that resolves this repo generates it; commit it once it appears.');
} else {
  try {
    const marker = readJson(markerFile);
    if (ctx?.contextRepo && marker.contextRepo && marker.contextRepo !== ctx.contextRepo) {
      add('err', 'marker', `.claude/context-project.json names ${marker.contextRepo} but context.json says ${ctx.contextRepo}`);
    }
  } catch (e) {
    add('err', 'marker', `.claude/context-project.json is not valid JSON (${e.message})`);
  }
}

// ---------------------------------------------------------------- content layout

if (!existsSync(join(ROOT, 'memory.md'))) {
  add('err', 'memory', 'no memory.md — the session-start hook has nothing to inject');
} else {
  const mem = readFileSync(join(ROOT, 'memory.md'), 'utf8');
  const reviewed = mem.match(/_Last reviewed:\s*(\d{4}-\d{2}-\d{2})/);
  if (reviewed) {
    const age = daysSince(reviewed[1]);
    if (age > MEMORY_STALE_DAYS) {
      add('warn', 'memory', `memory.md was last reviewed ${age} days ago (${reviewed[1]}) — the durable layer is drifting. curate-context is the ritual for this.`);
    }
  }
}

let threads = null;
try {
  threads = readdirSync(join(ROOT, 'threads'))
    .filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'INDEX.md')
    .sort();
} catch { /* no threads/ */ }

if (threads === null) {
  add('note', 'threads', 'no threads/ directory');
} else {
  for (const f of threads) {
    if (!/^\d{4}-\d{2}-\d{2}-/.test(f)) {
      add('warn', 'threads', `threads/${f} is not named YYYY-MM-DD-topic.md — the hook lists threads by filename sort, so it lands in the wrong place`);
    }
    // The silent-drop rule, checked where it actually bites. An angle bracket in a
    // front-matter value makes the ingester read a tag and discard the field: no error, no
    // symptom, the title simply vanishes.
    const text = readFileSync(join(ROOT, 'threads', f), 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
      for (const line of fm[1].split(/\r?\n/)) {
        const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
        if (kv && /[<>]/.test(kv[2])) {
          add('err', 'threads', `threads/${f} front-matter "${kv[1]}" contains an angle bracket — the ingester silently drops the field. Use [placeholder].`);
        }
      }
    } else if (text.trim()) {
      add('note', 'threads', `threads/${f} has no front-matter block`);
    }
  }

  // An index that is merely out of date reads exactly like a complete one.
  const indexFile = join(ROOT, 'threads', 'INDEX.md');
  if (!existsSync(indexFile)) {
    if (threads.length > 6) {
      add('warn', 'index', `${threads.length} threads and no threads/INDEX.md — the hook injects only the newest 6, so the rest are invisible at session start. Build it with thread-index.mjs.`);
    }
  } else {
    const index = readFileSync(indexFile, 'utf8');
    const missing = threads.filter((f) => !index.includes(f));
    if (missing.length) {
      add('warn', 'index', `threads/INDEX.md does not mention ${missing.length} thread(s): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''} — rebuild with thread-index.mjs`);
    }
    if (/\bTODO:/.test(index)) {
      add('warn', 'index', 'threads/INDEX.md still carries a TODO: placeholder from an unfinished curation');
    }
  }
}

// The pending queue is a fallback store — an entry sitting in it is work that never landed.
try {
  for (const f of readdirSync(join(ROOT, 'pending')).filter((f) => f.endsWith('.md') && f !== 'README.md')) {
    const dated = f.match(/^(\d{4}-\d{2}-\d{2})/);
    const age = dated
      ? daysSince(dated[1])
      : Math.round((Date.parse(`${today}T00:00:00Z`) - statSync(join(ROOT, 'pending', f)).mtimeMs) / 86400000);
    if (age > PENDING_STALE_DAYS) {
      add('warn', 'pending', `pending/${f} has been queued ${age} days — process-pending never drained it`);
    }
  }
} catch { /* no pending/ is fine */ }

// ---------------------------------------------------------------- includes (report only)

const includeReports = [];
if (flags.has('include') && Array.isArray(ctx?.include)) {
  for (const raw of ctx.include) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim();
    if (!REPO_RE.test(v) || OPTOUT.includes(v.toLowerCase())) continue;
    // Same ~/.context/<owner>/<repo> layout the resolver clones into.
    const dir = join(homedir(), '.context', ...v.split('/'));
    if (!existsSync(dir)) {
      includeReports.push({ repo: v, available: false, note: `no clone at ${dir}` });
      continue;
    }
    let stamp = null;
    let readable = true;
    try { stamp = readJson(join(dir, 'context.json')).template?.version ?? null; } catch { readable = false; }
    includeReports.push({
      repo: v,
      available: true,
      templateVersion: stamp,
      note: !readable ? 'context.json unreadable' : (stamp ? `template ${stamp}` : 'no template stamp'),
    });
  }
}

// ---------------------------------------------------------------- fix (JSON keys only)

const applied = [];
const refused = [];
if (flags.has('fix')) {
  const byFile = new Map();   // file -> current text, so several edits to one file compose
  for (const f of findings) {
    if (!f.fix) continue;
    if (!byFile.has(f.fix.file)) byFile.set(f.fix.file, readFileSync(f.fix.file, 'utf8'));
    const text = byFile.get(f.fix.file);
    let next = null;
    let what = null;

    if (f.fix.kind === 'rename-enabled-plugin') {
      // The key token only, quotes included — the value and every byte of layout survive.
      next = replaceOnce(text, new RegExp(`"${escapeRe(f.fix.from)}"`, 'g'), `"${f.fix.to}"`);
      what = `enabledPlugins "${f.fix.from}" to "${f.fix.to}"`;
    } else if (f.fix.kind === 'align-env-repo') {
      next = replaceOnce(
        text,
        /("PROJECT_CONTEXT_REPO"\s*:\s*)"[^"]*"/g,
        `$1${JSON.stringify(f.fix.to)}`,
      );
      what = `PROJECT_CONTEXT_REPO to "${f.fix.to}"`;
    }

    if (next === null) {
      refused.push(`${basename(f.fix.file)}: ${what} — the exact text was not found once and only once; fix it by hand`);
      continue;
    }
    // Never hand back a file that stopped being valid JSON.
    try { JSON.parse(next.charCodeAt(0) === 0xfeff ? next.slice(1) : next); }
    catch (e) { refused.push(`${basename(f.fix.file)}: ${what} — the edit would not have parsed (${e.message}); nothing written`); continue; }

    byFile.set(f.fix.file, next);
    applied.push(`${basename(f.fix.file)}: ${what}`);
  }
  for (const [file, text] of byFile) {
    if (text !== readFileSync(file, 'utf8')) writeFileSync(file, text);
  }
}

// ---------------------------------------------------------------- report

const fixable = findings.filter((f) => f.fix).length;

if (flags.has('json')) {
  console.log(JSON.stringify({ root: ROOT, today, findings, includes: includeReports, applied, refused, fixable }, null, 2));
} else {
  console.log(`context-doctor — ${ROOT}  (${today})`);
  if (!findings.length && !includeReports.length) console.log('  ok    nothing to report');
  const order = { err: 0, warn: 1, note: 2 };
  for (const f of [...findings].sort((a, b) => order[a.level] - order[b.level])) {
    console.log(`  ${f.level.padEnd(5)} [${f.check}] ${f.message}`);
    if (f.fix && !flags.has('fix')) console.log('        fixable: re-run with --fix');
  }
  for (const r of includeReports) {
    console.log(`  note  [include] ${r.repo} — ${r.note} (read-only from here)`);
  }
  if (refused.length) {
    console.log('\n  NOT applied:');
    for (const r of refused) console.log(`    - ${r}`);
  }
  if (applied.length) {
    console.log('\n  applied:');
    for (const a of applied) console.log(`    - ${a}`);
    console.log('  Settings are read at session start — restart for these to take effect.');
  } else if (fixable && !flags.has('fix')) {
    console.log(`\n  ${fixable} finding(s) can be fixed automatically (JSON keys only): re-run with --fix`);
  }
}
