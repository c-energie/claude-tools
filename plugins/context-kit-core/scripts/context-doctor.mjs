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
// Imported rather than restated: the audience vocabulary is shared with a thread's front-matter,
// and a copy here would disagree with the roster the first time one of them gained a value.
import { AUDIENCES } from './teaching-workspace.mjs';

const OPTIONS = ['json', 'fix', 'include', 'today'];
// In step with hooks/load-context.sh, scripts/context-repo.sh and scripts/link-context.mjs.
const OPTOUT = ['none', 'off', 'false', 'no', '-', 'disabled'];
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PENDING_STALE_DAYS = 30;
// Shorter than the pending queue's, because a handoff item is addressed to a PERSON in another
// project rather than to a tool: it is only drained when somebody opens that project's session,
// so it goes stale by nobody doing anything rather than by a run failing.
const HANDOFF_STALE_DAYS = 14;
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
  // Moved out of ~/.context with the marketplace on 2026-08-31 — see kitDir below for why.
  const tmplDir = [
    process.env.CONTEXT_TEMPLATE_DIR,
    join(homedir(), 'c-energie', 'context-template'),
    join(homedir(), '.context', 'c-energie', 'context-template'),
  ].find((d) => d && existsSync(d)) ?? join(homedir(), 'c-energie', 'context-template');
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

  // -------------------------------------------------------------- teaching workspaces

  // Three ways a `teaching` declaration goes stale without announcing itself. All three are
  // REPORTS and none carries a `fix`: this tool only ever applies a fix whose correct value it
  // can DERIVE, and none of these has one. A slug with no directory could mean the workspace was
  // deleted or that the slug was mistyped, and the two repairs are opposites — creating an empty
  // workspace, or correcting a key. Guessing would be worse than saying nothing.
  //
  // Reads the declaration only. It does not depend on the scaffolder having written it, and must
  // keep working against a block somebody typed by hand.
  if (ctx.teaching !== undefined && ctx.teaching !== null) {
    if (typeof ctx.teaching !== 'object' || Array.isArray(ctx.teaching)) {
      add('err', 'teaching', '"teaching" is present but is not an object — no workspace in it is declared, and teach-workspace reports none');
    } else {
      // `_`-prefixed keys are comments, the convention this file already uses for
      // `_comment_include`. Skipped rather than reported, so the reasoning can live beside the
      // block it explains.
      for (const [slug, entry] of Object.entries(ctx.teaching).filter(([k]) => !k.startsWith('_'))) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          add('err', 'teaching', `"teaching.${slug}" is not an object — it declares neither a mission nor an audience`);
          continue;
        }
        // The parent is fixed at `teaching/` deliberately: it is what keeps teach's `lessons/`
        // from colliding with assistants/[role]/LESSONS.md, two unrelated senses of one word.
        if (!existsSync(join(ROOT, 'teaching', slug))) {
          add('warn', 'teaching',
            `"teaching.${slug}" is declared but there is no teaching/${slug}/ directory. Either the `
            + 'workspace was deleted and the declaration outlived it, or the slug is mistyped — '
            + 'the fixes are opposite, so this is not repaired for you.');
        }
        if (typeof entry.mission !== 'string' || !entry.mission) {
          add('warn', 'teaching', `"teaching.${slug}" declares no mission path`);
        } else if (!existsSync(join(ROOT, entry.mission))) {
          add('warn', 'teaching',
            `"teaching.${slug}" declares mission "${entry.mission}", which does not resolve. `
            + 'Expected while a workspace is prepared but not yet started — teach writes MISSION.md '
            + 'at the first session — and a real defect at any point after that.');
        }
        // ABSENT IS ABSENT, never a default, and never a finding. A workspace that declares no
        // audience has not been classified; reporting that as a defect would push people to
        // supply a value to silence the check, which is exactly how a repo ends up full of
        // audiences nobody chose. Only a value OUTSIDE the vocabulary is wrong.
        if (entry.audience !== undefined && !AUDIENCES.includes(entry.audience)) {
          add('warn', 'teaching',
            `"teaching.${slug}" declares audience ${JSON.stringify(entry.audience)}, which is not one of `
            + `${AUDIENCES.join(' / ')} — the same vocabulary a thread's front-matter uses. It is `
            + 'rendered as written and never corrected: a typo you can see costs seconds, one this '
            + 'swallowed would leave the workspace misclassified forever.');
        }
      }
    }
  }

  // -------------------------------------------------------------- stale Notion date guidance

  // context-notion's notion-discover used to stamp every date property's schema line with
  // "with is_datetime 0" — correct for the hosted notion-create-pages tool, and a 400 on every
  // date write through API-post-page, which rejects the key outright. Skills follow schema text
  // exactly, so the stale line outlives the fix in every project it was copied into.
  //
  // This is the one place core reads under state.notion, and it reads as little as it can: a
  // retired token in a string, the way DEAD_MARKETS carries a retired catalog name. It does not
  // interpret the schema — what a date should look like is context-notion's (notion-config) to
  // say, and spelling it out here would be a second copy of that rule. No fix: the right line
  // depends on the property's own notes, which only the user can rewrite.
  const schemas = ctx.state?.notion?.schemas;
  if (schemas && typeof schemas === 'object') {
    const walk = (v, path) => {
      if (typeof v === 'string') {
        if (v.includes('is_datetime')) {
          add('warn', 'notion-dates',
            `state.notion.schemas.${path} mentions is_datetime — stale guidance. That key is valid `
            + 'for one Notion tool only and API-post-page rejects it with a 400, so a skill that '
            + 'follows this line breaks every date write through that tool. Edit the line to name '
            + 'no tool (e.g. "date — YYYY-MM-DD (shape per notion-config)"); context-notion\'s '
            + 'notion-config owns the per-tool date rule.');
        }
      } else if (v && typeof v === 'object') {
        // Quoted when not a bare word: property names with trailing spaces are real, and an
        // unquoted path would hide exactly the character that makes the name what it is.
        for (const [k, child] of Object.entries(v)) {
          const seg = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
          walk(child, path ? `${path}.${seg}` : seg);
        }
      }
    };
    walk(schemas, '');
  }
}

// ---------------------------------------------------------------- the repo's own settings

// Which plugin ids actually exist. Without a marketplace this check cannot run, and saying so
// is the point: an unverifiable id must never read as a verified one.
// The TOOL repos live at ~/[owner]/[repo], outside ~/.context — that root is for context repos,
// the data. Both moved on 2026-08-31, and the marketplace was renamed from context-kit to
// claude-tools at the same time. Every earlier path is still tried: a clone at one of them is the
// same repo, and giving up would turn every plugin id below into an unverifiable one, which
// reads as "checked and fine" to anyone skimming the report.
const findRepo = (candidates, marker, fallback) =>
  candidates.find((d) => d && existsSync(join(d, marker))) ?? fallback;

const kitDir = findRepo([
  process.env.CONTEXT_KIT_PLUGIN_DIR,
  join(homedir(), 'c-energie', 'claude-tools'),
  join(homedir(), '.context', 'c-energie', 'claude-tools'),
  join(homedir(), '.context', 'c-energie', 'context-kit'),
], join('.claude-plugin', 'marketplace.json'), join(homedir(), 'c-energie', 'claude-tools'));
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

// Catalog names that USED to identify this marketplace and no longer resolve to anything.
// A stale id is the one failure this file exists to catch and the one the loop below would
// otherwise skip: `X@context-kit` looks like some other marketplace's business, so it is
// silently ignored, the plugin never loads, and nothing anywhere says why. Renaming a catalog
// therefore means retiring its old name HERE, not just in the marketplace.json that no longer
// answers to it. (context-kit -> c-energie, 2026-08-31.)
const DEAD_MARKETS = { 'context-kit': 'c-energie' };

if (settings) {
  const enabled = settings.enabledPlugins ?? {};
  for (const key of Object.keys(enabled)) {
    const [plugin, market] = String(key).split('@');
    const successor = DEAD_MARKETS[market];
    if (!successor) continue;
    add('err', 'plugins',
      `.claude/settings.json enables "${key}", but the "${market}" marketplace was renamed to "${successor}". That id resolves to nothing and enables nothing — it is silently ignored, not reported, by the plugin loader.`,
      { file: setFile, kind: 'rename-enabled-plugin', from: key, to: `${plugin}@${successor}` });
  }

  // The same rename, on the entry that registers the catalog in the first place.
  for (const name of Object.keys(settings.extraKnownMarketplaces ?? {})) {
    if (!DEAD_MARKETS[name]) continue;
    add('err', 'plugins',
      `.claude/settings.json registers the marketplace under its old name "${name}" (now "${DEAD_MARKETS[name]}"). The repo it points at was renamed too; GitHub redirects the clone, so this fails as "no such plugin" rather than "no such repo".`);
  }

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

// ---------------------------------------------------------------- machine-wide autoload
// CONTEXT_KIT_AUTOLOAD=off in the user-level ~/.claude/settings.json makes the SessionStart hook
// exit silently in every project on this machine. That is a legitimate setting, so it is a note
// and not a defect — but it is reported because "why didn't my context load?" is the question
// this script exists to answer, and an off flag otherwise looks EXACTLY like a plugin that
// failed to load: no payload, no banner, no warning, everything else healthy.
//
// Read from the environment first and the file second, because those can disagree and the
// difference matters: Claude Code exports the user-level `env` block into every hook, so the
// environment is what the hook actually saw this session, whereas the file is what it will see
// after the next restart (the settings watcher does not pick this up mid-session).
const autoloadEnv = process.env.CONTEXT_KIT_AUTOLOAD;
let autoloadFile = null;
const userSettings = join(homedir(), '.claude', 'settings.json');
if (existsSync(userSettings)) {
  // A user settings file we cannot parse is not this script's business to report — Claude Code
  // complains about that itself, loudly, at startup.
  try { autoloadFile = readJson(userSettings).env?.CONTEXT_KIT_AUTOLOAD ?? null; } catch { /* ignore */ }
}
const isOff = (v) => typeof v === 'string' && OPTOUT.includes(v.trim().toLowerCase());
if (isOff(autoloadEnv) || isOff(autoloadFile)) {
  const where = isOff(autoloadEnv)
    ? `CONTEXT_KIT_AUTOLOAD=${autoloadEnv} is set in this session's environment`
    : `${userSettings} sets CONTEXT_KIT_AUTOLOAD=${autoloadFile} (it takes effect at the next session start)`;
  add('note', 'autoload',
    `${where} — the SessionStart hook loads nothing in ANY project on this machine, including one that names a context repo. Deliberate, not a broken plugin: refresh-context still loads. Remove the value, or set it to "on", to restore automatic loading.`);
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

// The handoff queue is a SILENT BACKLOG: an item sits there until somebody opens the target
// project's own session, and nothing announces that it has been waiting. Reporting its age here
// is what turns it into a backlog somebody has seen — the same job this check does for every
// other drift that never announces itself. Report only: whether an item is still worth draining
// is a judgement about its content, which nothing here can make.
try {
  for (const f of readdirSync(join(ROOT, 'handoff')).filter((f) => f.endsWith('.md') && !['README.md', 'INDEX.md'].includes(f))) {
    const text = readFileSync(join(ROOT, 'handoff', f), 'utf8');
    const fm = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
    const dated = (fm?.[1].match(/^date:\s*(\d{4}-\d{2}-\d{2})/m) ?? f.match(/^(\d{4}-\d{2}-\d{2})/))?.[1] ?? null;
    const age = dated
      ? daysSince(dated)
      : Math.round((Date.parse(`${today}T00:00:00Z`) - statSync(join(ROOT, 'handoff', f)).mtimeMs) / 86400000);
    if (age > HANDOFF_STALE_DAYS) {
      add('warn', 'handoff', `handoff/${f} has been waiting ${age} days — it is addressed to another project and is only drained when somebody opens that project's session. triage-notes reports the backlog every run; context-notion:weekly-review is the cadence for the shared ones.`);
    }
    // kind: issue REQUIRES a repo: field. Without it the item names no destination, and a drainer
    // would have to infer one from the prose — which is the guess this field exists to prevent.
    const kind = fm?.[1].match(/^kind:\s*(\S+)/m)?.[1] ?? null;
    if (kind === 'issue' && !/^repo:\s*\S/m.test(fm?.[1] ?? '')) {
      add('err', 'handoff', `handoff/${f} is kind: issue with no "repo:" field — it names no destination repository, and a drainer must not infer one from the text`);
    }
  }
} catch { /* no handoff/ is fine — most context repos have none */ }

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
