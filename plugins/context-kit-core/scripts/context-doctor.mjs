#!/usr/bin/env node
// Health check for a workspace — the drift and misconfiguration that no session ever reports,
// because every one of these failures is SILENT.
//
//   node context-doctor.mjs                             # the nearest workspace above the cwd
//   node context-doctor.mjs <dir>                       # the nearest workspace at or above <dir>
//   node context-doctor.mjs <dir> --json                # machine-readable findings
//   node context-doctor.mjs <dir> --fix                 # apply the derivable JSON fixes, in place
//   node context-doctor.mjs <dir> --today 2026-08-18    # pin dates so output can be compared
//
// WHAT IT MAY WRITE: keys in .claude/settings.json, and only where the correct value is
// *derivable* from something else already in the repo. Never markdown, never a value it would
// have to guess. That envelope is the whole safety property — a workspace's context is
// hand-written prose that exists in exactly one copy, and a diagnostic has no business rewriting
// it. Findings outside the envelope are reported with the fix spelled out instead. --fix never
// writes workspace.json: every key in it has a writing owner (workspace.mjs's header), and the
// doctor is not one of them.
//
// ONE KIND OF ROOT (ADR 0002): the nearest .claude/workspace.json, found by workspace.mjs's
// rootKind(). The context-repo mode — a directory holding context.json, checked for its template
// stamp, marker and contextRepo — was deleted with the rest of that route (#60). A directory that
// is not a workspace is refused (exit 2), and one still holding a context.json is told context
// repos are retired rather than "not found", so the fix it needs is named. In a workspace:
//   - workspace.json itself: it parses, `schema` is 1, `repo` is owner/name, every `members[]`
//     entry is on disk (or reported as not cloned), `connections` has a shape the gate can read;
//   - the docs/ layout: docs/memory.md exists and the root CLAUDE.md imports it, and
//     docs/threads/ gets the front-matter and INDEX.md checks;
//   - .context/pending/ is not stale;
//   - VISIBILITY: a PUBLIC repo holding docs/meetings/ or .context/pending/ is a warning, since
//     anyone who clones a workspace gets its context (ADR 0002). This is the one check that
//     touches the network (`gh repo view`, capped at 15s), it runs only when one of those two
//     directories exists, and a lookup that fails is a note saying it was NOT verified — never
//     a silent pass.
// The keys the workspace retired — template, the generated marker, include — are not checked.
// PROJECT_CONTEXT_REPO left in .claude/settings.json is reported as dead configuration.
//
// Exit 0 = it ran (with or without findings). Exit 2 = it could NOT run. The caller must be
// able to tell "nothing wrong" from "never looked" — a silent clean bill of health on a check
// that never executed is the failure mode this whole plugin exists to prevent.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve, basename } from 'node:path';
import { rootKind, SCHEMA, WORKSPACE_FILE } from './workspace.mjs';

const OPTIONS = ['json', 'fix', 'today'];
// The one spelling of "off", in step with hooks/workspace-freshness.sh's is_optout().
const OPTOUT = ['none', 'off', 'false', 'no', '-', 'disabled'];
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PENDING_STALE_DAYS = 30;
const MEMORY_STALE_DAYS = 90;
// A member's kind, as ADR 0002 lists them. project-workspace owns what each kind carries; this
// only spots a value outside the list, which none of its steps would recognise.
const MEMBER_KINDS = ['code', 'document', 'analysis'];
const GH_TIMEOUT_MS = 15000;

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

const start = resolve(positional[0] ?? process.cwd());
if (!existsSync(start)) die(`no such directory: ${start}`);
// Not a workspace: nothing to check, so it cannot run. A context.json there is a project that
// never migrated, and saying "not found" would send someone looking for a file that is present.
const kind = rootKind(start);
if (!kind) {
  die(existsSync(join(start, 'context.json'))
    ? `${start} holds context.json but no ${WORKSPACE_FILE} — context repos are retired (ADR 0002, #60); `
      + 'this project needs a workspace (project-workspace:setup-project-workspace)'
    : `no ${WORKSPACE_FILE} at or above ${start} — not a workspace (node scripts/workspace.mjs)`);
}
const ROOT = kind.root;

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

// The connections policy in workspace.json, read with the same names() the gate uses, so a shape
// that passes here cannot fail there.
const checkConnections = (conns) => {
  if (conns !== undefined
      && (typeof conns !== 'object' || conns === null || Array.isArray(conns))) {
    add('err', 'connections', '"connections" is not an object');
  } else if (conns) {
    // Each provider names one connection, or a map of resource owner -> connection. A value the
    // gate cannot read is not cosmetic: connection-gate.mjs denies every call for that provider,
    // so a session loses the connector entirely and the refusal blames the wrong thing.
    for (const [provider, v] of Object.entries(conns)) {
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
};

// Stale Notion date guidance under state.notion.
const checkNotionDates = (conf) => {
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
  const schemas = conf.state?.notion?.schemas;
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
};

// ---------------------------------------------------------------- workspace.json

let ws = null;
const wsReport = { file: kind.file, members: [], visibility: null };
if (kind.error) {
  // Every route that reads this file — the resolver, the gate, save-thread — treats a malformed
  // one as no workspace at all, so the workspace is silently not in force: no policy gated, no
  // thread home. Nothing below can be checked against a file that did not parse.
  add('err', 'workspace.json',
    `${kind.file} is malformed (${kind.error}) — every session here runs as if there were no `
    + 'workspace (the connection gate fails open, save-thread has nowhere to write), and nothing '
    + 'else in it could be checked');
} else {
  ws = kind.config;
}

if (ws) {
  // Reported, not refused: workspace.mjs still resolves the root under another schema, so the
  // doctor goes on to check the rest rather than give up on a file every route still uses.
  if (ws.schema !== SCHEMA) {
    add('warn', 'workspace.json', `"schema" is ${JSON.stringify(ws.schema ?? null)}; these checks know schema ${SCHEMA}`);
  }
  if (ws.repo !== undefined && !REPO_RE.test(String(ws.repo))) {
    add('err', 'workspace.json', `"repo": ${JSON.stringify(ws.repo)} is not an owner/repo name`);
  }

  // Members are gitignored nested clones, so a fresh clone of a workspace has none of them on
  // disk — the normal state, not a defect, hence a note naming the clone rather than a warning.
  // What IS a defect is an entry no project-workspace step could act on. None of it is fixed:
  // `members` is project-workspace's key, and a doctor that rewrote it would be a second writer.
  if (ws.members !== undefined && !Array.isArray(ws.members)) {
    add('err', 'members', '"members" is not an array — no member of this workspace is declared');
  } else {
    const seen = new Set();
    (ws.members ?? []).forEach((m, i) => {
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        add('err', 'members', `members[${i}] is not an object`);
        return;
      }
      if (typeof m.dir !== 'string' || !m.dir.trim()) {
        add('err', 'members', `members[${i}] has no "dir" — nothing says where it lives`);
        return;
      }
      const cloned = existsSync(join(ROOT, m.dir));
      wsReport.members.push({ dir: m.dir, repo: m.repo ?? null, kind: m.kind ?? null, cloned });
      if (seen.has(m.dir)) add('warn', 'members', `members[${i}] repeats dir "${m.dir}"`);
      seen.add(m.dir);
      if (m.repo !== undefined && !REPO_RE.test(String(m.repo))) {
        add('err', 'members', `members[${i}] ("${m.dir}") has "repo": ${JSON.stringify(m.repo)}, which is not an owner/repo name`);
      }
      if (!MEMBER_KINDS.includes(m.kind)) {
        add('warn', 'members', `members[${i}] ("${m.dir}") has "kind": ${JSON.stringify(m.kind ?? null)}, not one of ${MEMBER_KINDS.join(' / ')}`);
      }
      if (!cloned) {
        add('note', 'members',
          `member "${m.dir}" is not cloned${REPO_RE.test(String(m.repo ?? '')) ? ` — gh repo clone ${m.repo} ${m.dir}` : ''}`);
      }
    });
  }

  checkConnections(ws.connections);
  checkNotionDates(ws);

  // ANYONE WHO CLONES A WORKSPACE GETS ITS CONTEXT (ADR 0002). Meetings and the Notion queue are
  // the parts that must never be public, and a workspace whose members are public open source
  // is exactly the one where somebody makes the wrapper public too. Asked only when one of the
  // two exists, so a workspace with nothing sensitive in it costs no network call.
  const sensitive = ['docs/meetings', '.context/pending'].filter((d) => existsSync(join(ROOT, d)));
  if (sensitive.length) {
    if (!REPO_RE.test(String(ws.repo ?? ''))) {
      add('note', 'visibility', `${sensitive.join(' and ')} exist but workspace.json names no "repo" — whether it is public was NOT checked`);
    } else {
      const r = spawnSync('gh', ['repo', 'view', ws.repo, '--json', 'visibility', '--jq', '.visibility'],
        { encoding: 'utf8', timeout: GH_TIMEOUT_MS, windowsHide: true });
      const v = r.status === 0 ? (r.stdout ?? '').trim().toUpperCase() : '';
      wsReport.visibility = v || null;
      if (!v) {
        const why = r.error ? r.error.message : ((r.stderr ?? '').trim().split('\n')[0] || `gh exited ${r.status}`);
        add('note', 'visibility', `could not read ${ws.repo}'s visibility (${why}) — whether it is public was NOT checked`);
      } else if (v === 'PUBLIC') {
        add('warn', 'visibility',
          `${ws.repo} is PUBLIC and holds ${sensitive.join(' and ')} — anyone who clones it gets them. `
          + 'Make the workspace repo private (its members can stay public), or move them out.');
      }
    }
  }
}

// ---------------------------------------------------------------- the repo's own settings

// Which plugin ids actually exist. Without a marketplace this check cannot run, and saying so
// is the point: an unverifiable id must never read as a verified one.
// The marketplace is cloned at ~/c-energie/claude-tools (CONTEXT_KIT_PLUGIN_DIR overrides). The
// paths under ~/.context it once lived at are gone with that root (#60).
const findRepo = (candidates, marker, fallback) =>
  candidates.find((d) => d && existsSync(join(d, marker))) ?? fallback;

const kitDir = findRepo([
  process.env.CONTEXT_KIT_PLUGIN_DIR,
  join(homedir(), 'c-energie', 'claude-tools'),
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

  // Dead configuration since #60: nothing resolves a context repo any more. Harmless to every
  // route, but it reads as if it did something, so it is named — and not removed, since deleting
  // a key from an env block is an edit to a file whose other keys the doctor cannot judge.
  for (const key of ['PROJECT_CONTEXT_REPO', 'PROJECT_CONTEXT_THREADS']) {
    if (settings.env?.[key] === undefined) continue;
    add('warn', 'settings',
      `.claude/settings.json sets ${key}, but context repos are retired (ADR 0002, #60) and nothing reads it — remove it from the env block`);
  }
}

// ---------------------------------------------------------------- machine-wide autoload
// CONTEXT_KIT_AUTOLOAD=off in the user-level ~/.claude/settings.json makes the SessionStart hook
// exit silently in every project on this machine. That is a legitimate setting, so it is a note
// and not a defect — but it is reported because a silenced "workspace is behind" warning looks
// EXACTLY like an up-to-date workspace: no line, everything else healthy.
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
    `${where} — the SessionStart hook's workspace freshness check is silenced in EVERY project on this machine, so a workspace behind its origin is never warned about. Deliberate, not a broken plugin. Remove the value, or set it to "on", to restore it.`);
}

// ---------------------------------------------------------------- content layout

// Where each piece lives — ADR 0002's layout.
const MEMORY_REL = 'docs/memory.md';
const THREADS_REL = 'docs/threads';
const PENDING_REL = '.context/pending';

if (!existsSync(join(ROOT, MEMORY_REL))) {
  add('warn', 'memory', `no ${MEMORY_REL} — the workspace has no durable memory for its CLAUDE.md to import`);
} else {
  const mem = readFileSync(join(ROOT, MEMORY_REL), 'utf8');
  const reviewed = mem.match(/_Last reviewed:\s*(\d{4}-\d{2}-\d{2})/);
  if (reviewed) {
    const age = daysSince(reviewed[1]);
    if (age > MEMORY_STALE_DAYS) {
      add('warn', 'memory', `${MEMORY_REL} was last reviewed ${age} days ago (${reviewed[1]}) — the durable layer is drifting. curate-context is the ritual for this.`);
    }
  }
}

// The personal layer's workspace (ADR 0002) is the exception: its docs/memory.md is imported by
// the user-level ~/.claude/CLAUDE.md so it loads in every session, and importing it again from
// its own CLAUDE.md would load it twice there. Any workspace imported that way counts: an `@`
// path names this file once `~/` is expanded and a relative path is taken from ~/.claude/, as
// Claude Code resolves it; on Windows a Git Bash `/c/...` path counts and case is ignored.
const importedByUserClaudeMd = (memoryPath) => {
  const dir = join(homedir(), '.claude');
  let text;
  try { text = readFileSync(join(dir, 'CLAUDE.md'), 'utf8'); } catch { return false; }
  const win = process.platform === 'win32';
  const norm = (p) => {
    if (/^~[\\/]/.test(p)) p = join(homedir(), p.slice(2));
    else if (win && /^\/[a-z]\//i.test(p)) p = `${p[1]}:${p.slice(2)}`;
    const r = resolve(dir, p).replace(/\\/g, '/');
    return win ? r.toLowerCase() : r;
  };
  const want = norm(memoryPath);
  return [...text.matchAll(/(?:^|[\s(])@([^\s`)]+)/g)].some(([, p]) =>
    norm(p.replace(/[.,;:]+$/, '')) === want);
};

// NOTHING injects memory: the session-start hook loads nothing, and
// docs/memory.md reaches a session only through `@docs/memory.md` in the root CLAUDE.md, or the
// user-level import above. Drop the import and the file is still there, still curated, and never
// read — no error anywhere.
if (existsSync(join(ROOT, MEMORY_REL))) {
  const claudeMd = join(ROOT, 'CLAUDE.md');
  if (!existsSync(claudeMd)) {
    add('warn', 'memory', `no CLAUDE.md at the workspace root — nothing imports ${MEMORY_REL}, so no session loads it`);
  } else if (!/@(\.\/)?docs\/memory\.md\b/.test(readFileSync(claudeMd, 'utf8'))
    && !importedByUserClaudeMd(join(ROOT, MEMORY_REL))) {
    add('warn', 'memory', `CLAUDE.md does not import @${MEMORY_REL} — the workspace's memory is never loaded`);
  }
}

let threads = null;
try {
  threads = readdirSync(join(ROOT, THREADS_REL))
    .filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'INDEX.md')
    .sort();
} catch { /* no threads directory */ }

// A workspace that has never saved a thread has no docs/threads/ yet, and save-thread makes it.
if (threads !== null) {
  for (const f of threads) {
    if (!/^\d{4}-\d{2}-\d{2}-/.test(f)) {
      add('warn', 'threads', `${THREADS_REL}/${f} is not named YYYY-MM-DD-topic.md — thread-index.mjs lists threads by filename sort, so it lands in the wrong place`);
    }
    // The silent-drop rule, checked where it actually bites. An angle bracket in a
    // front-matter value makes the ingester read a tag and discard the field: no error, no
    // symptom, the title simply vanishes.
    const text = readFileSync(join(ROOT, THREADS_REL, f), 'utf8');
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
      for (const line of fm[1].split(/\r?\n/)) {
        const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
        if (kv && /[<>]/.test(kv[2])) {
          add('err', 'threads', `${THREADS_REL}/${f} front-matter "${kv[1]}" contains an angle bracket — the ingester silently drops the field. Use [placeholder].`);
        }
      }
    } else if (text.trim()) {
      add('note', 'threads', `${THREADS_REL}/${f} has no front-matter block`);
    }
  }

  // An index that is merely out of date reads exactly like a complete one. The index is the ONLY
  // route to the threads — CLAUDE.md points at it and no hook lists them — and
  // save-thread regenerates it on every save, so any thread without one is a finding.
  const indexRel = `${THREADS_REL}/INDEX.md`;
  const indexFile = join(ROOT, indexRel);
  if (!existsSync(indexFile)) {
    if (threads.length) {
      add('warn', 'index', `${threads.length} thread(s) and no ${indexRel} — the workspace's CLAUDE.md points at the index, so these are invisible to a session. Build it with thread-index.mjs --dir ${THREADS_REL}.`);
    }
  } else {
    const index = readFileSync(indexFile, 'utf8');
    const missing = threads.filter((f) => !index.includes(f));
    if (missing.length) {
      add('warn', 'index', `${indexRel} does not mention ${missing.length} thread(s): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''} — rebuild with thread-index.mjs --dir ${THREADS_REL}`);
    }
    if (/\bTODO:/.test(index)) {
      add('warn', 'index', `${indexRel} still carries a TODO: placeholder from an unfinished curation`);
    }
  }
}

// The pending queue is a fallback store — an entry sitting in it is work that never landed.
try {
  for (const f of readdirSync(join(ROOT, PENDING_REL)).filter((f) => f.endsWith('.md') && f !== 'README.md')) {
    const dated = f.match(/^(\d{4}-\d{2}-\d{2})/);
    const age = dated
      ? daysSince(dated[1])
      : Math.round((Date.parse(`${today}T00:00:00Z`) - statSync(join(ROOT, PENDING_REL, f)).mtimeMs) / 86400000);
    if (age > PENDING_STALE_DAYS) {
      add('warn', 'pending', `${PENDING_REL}/${f} has been queued ${age} days — process-pending never drained it`);
    }
  }
} catch { /* no pending queue is fine */ }

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
  // `mode` is always 'workspace' now; kept so a consumer written against both modes still reads.
  console.log(JSON.stringify({
    root: ROOT, mode: 'workspace', today, findings,
    workspace: wsReport, applied, refused, fixable,
  }, null, 2));
} else {
  console.log(`context-doctor — ${ROOT}  (workspace, ${today})`);
  if (!findings.length) console.log('  ok    nothing to report');
  const order = { err: 0, warn: 1, note: 2 };
  for (const f of [...findings].sort((a, b) => order[a.level] - order[b.level])) {
    console.log(`  ${f.level.padEnd(5)} [${f.check}] ${f.message}`);
    if (f.fix && !flags.has('fix')) console.log('        fixable: re-run with --fix');
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
