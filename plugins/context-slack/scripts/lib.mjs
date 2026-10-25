// Shared helpers for the context-slack scripts. Nothing here needs the model.
//
// *** COPY of context-notion/scripts/lib.mjs — keep the two byte-identical below this banner. ***
// Plugins cannot reach into each other's install directories, so the copy is deliberate. A fix
// lands in context-notion's copy FIRST, then here.
//
// The config is per-project: the `state.notion` block of the project's config file — nothing
// is baked in. Resolution order:
//   1. CONTEXT_CONFIG=/path/to/file.json  — explicit, no git, no bash needed; still wins
//   2. the nearest `.claude/workspace.json` (ADR 0002) — resolveWorkspace(), the resolver's own
//      walk. There is no third rung: the context-repo route was deleted in #60.
// Either way the project must declare `"state": { "backend": "notion", "notion": {…} }` —
// a project without a Notion backend has nothing for these scripts to run against, and
// saying so beats pretending with an empty roster.
//
// 2 is one call to resolveWorkspace() rather than a walk of this file's own: a session
// whose context loaded from the workspace must not have its roster read from somewhere else,
// and two walks are how that would start. Its route line is NOT relayed on success — these
// scripts' stdout is a report or JSON and their stderr is read by people — but a malformed
// workspace.json is, because it silently changes which file the roster came from.
import { readFileSync } from 'node:fs';
import { resolveWorkspace } from './workspace.mjs';
import { layout } from './layout.mjs';

function configPath() {
  if (process.env.CONTEXT_CONFIG) return process.env.CONTEXT_CONFIG;
  const r = resolveWorkspace();
  for (const m of r.messages) if (/malformed/.test(m) && !m.startsWith('route=')) console.error(`note: ${m}`);
  if (!r.root) {
    throw new Error(r.messages.filter((m) => m.startsWith('route=none')).pop() ?? 'no workspace resolved');
  }
  return layout(r.root).config;
}

let parsed;
try {
  const path = configPath();
  // A BOM is stripped as findWorkspace() strips it: an editor-saved workspace.json the resolver
  // accepted must not then fail to parse here.
  parsed = { path, json: JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) };
} catch (e) {
  console.error(`Cannot load the project's config: ${e.message.split('\n')[0]}`);
  console.error('Run inside a workspace (.claude/workspace.json), or set CONTEXT_CONFIG=/path/to/file.json.');
  process.exit(2);
}

// A project without a Notion backend still gets working queue/date tooling — pending-parse
// only needs a roster, and an empty one just means owners surface as warnings. The stderr
// note keeps a *misconfigured* Notion project from failing silently; Notion-writing skills
// check the backend themselves and stand down.
const state = parsed.json.state;
const notion = (state && state.backend === 'notion' && state.notion) ? state.notion : null;
if (!notion) {
  console.error(`note: ${parsed.path} declares no Notion backend (state.backend = ${JSON.stringify(state?.backend ?? null)}) — running with an empty roster and default settings.`);
}

/** The roster, normalised to the canonical array of `{ name, notionUserId, ... }`.
 *  Older config files carry it as a `{ "Name": "notion-user-id" }` map instead, and every
 *  caller reaches for `.find` — an object arrived as `roster.find is not a function` and took
 *  pending-parse down mid-validation, which is the one thing the queue exists to survive. A
 *  shape this layer can read is not a fact about any one project, so it is normalised here
 *  rather than each caller guessing. `name` is forced to a string because `p.name.toLowerCase()`
 *  is on the hot path and an entry without one crashed the same way. */
const asRoster = (raw) => {
  const named = (name, rest) => ({ ...rest, name: String(name ?? '') });
  if (Array.isArray(raw)) return raw.filter(Boolean).map((p) => named(p?.name, p));
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([name, v]) => (v && typeof v === 'object')
      ? named(v.name ?? name, v)
      : named(name, { notionUserId: v == null ? null : String(v) }));
  }
  return [];
};

/** The project's state.notion block: databases, schemas, people, defaults. Null-proof:
 *  an explicit `"people": null` in a stub config must not defeat the guards. */
export const config = {
  databases: notion?.databases ?? {},
  schemas: notion?.schemas ?? {},
  people: asRoster(notion?.people),
  defaults: { dueSoonDays: 7, ...(notion?.defaults ?? {}) },
};

/** Strip Notion's `user://` prefix so IDs compare cleanly whichever form they arrive in. */
export const bareId = (id) => String(id ?? '').replace(/^user:\/\//, '');

/** Roster lookup by Notion user ID. Unknown IDs are never fatal — they surface as "Unknown owner". */
export function person(id) {
  const bare = bareId(id);
  return config.people.find((p) => p.notionUserId === bare)
      ?? { name: 'Unknown owner', notionUserId: bare, slackMemberId: null };
}

/** Slack @mention when we hold a member ID for them, plain name otherwise. */
export const mention = (p) => (p.slackMemberId ? `<@${p.slackMemberId}>` : `**${p.name}**`);

export const today = () => new Date().toISOString().slice(0, 10);

export const addDays = (isoDate, n) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Read a JSON argument as either a file path or inline JSON, or fall back to stdin. */
export function readInput(arg) {
  const raw = arg && arg !== '-'
    ? (arg.trimStart().startsWith('{') || arg.trimStart().startsWith('[') ? arg : readFileSync(arg, 'utf8'))
    : readFileSync(0, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Input is not valid JSON: ${e.message}`);
    process.exit(2);
  }
}

/** Human date for report lines: "Tue 28 Jul". Undated rows read as "no date". */
export function pretty(isoDate) {
  if (!isoDate) return 'no date';
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

/**
 * The one place due-date buckets are defined. Every skill that says "overdue" or
 * "due this week" means exactly this.
 */
export function bucket(row, now = today(), soonDays = config.defaults.dueSoonDays) {
  const soon = addDays(now, soonDays);
  if (row.status === 'Watching') return row.due && row.due <= now ? 'checkDue' : 'watching';
  if (!row.due) return 'undated';
  if (row.due < now) return 'overdue';
  if (row.due <= soon) return 'soon';
  return 'later';
}

export const byDue = (a, b) => String(a.due ?? '9999-12-31').localeCompare(String(b.due ?? '9999-12-31'));
