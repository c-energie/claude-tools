// Shared helpers for the context-notion scripts. Nothing here needs the model.
//
// The config is per-project: the `state.notion` block of the context repo's context.json —
// nothing is baked in. Resolution order:
//   1. CONTEXT_CONFIG=/path/to/context.json  — explicit, no git, no bash needed
//   2. resolve the context repo via context-repo.sh --no-pull and read its context.json
// Either way the project must declare `"state": { "backend": "notion", "notion": {…} }` —
// a project without a Notion backend has nothing for these scripts to run against, and
// saying so beats pretending with an empty roster.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bashBin, bashPath, NO_BASH } from './bash-bin.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Git Bash prints POSIX paths (/c/Users/…) that win32 path.join would mangle into \c\Users\….
const posixToNative = (p) =>
  (process.platform === 'win32' ? p.replace(/^\/([A-Za-z])\//, '$1:/') : p);

function configPath() {
  if (process.env.CONTEXT_CONFIG) return process.env.CONTEXT_CONFIG;
  // bashBin() rather than `bash`: the Windows PATH entry is WSL's launcher, which has its own
  // filesystem and $HOME — it cannot see this script, and cannot see the clone the resolver
  // would print back. Failing by name beats resolving against the wrong ~.
  const bin = bashBin();
  if (!bin) throw new Error(`${NO_BASH} (or set CONTEXT_CONFIG to skip the resolver)`);
  const root = execFileSync(bin, [bashPath(join(here, 'context-repo.sh')), '--no-pull'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return join(posixToNative(root), 'context.json');
}

let parsed;
try {
  const path = configPath();
  parsed = { path, json: JSON.parse(readFileSync(path, 'utf8')) };
} catch (e) {
  console.error(`Cannot load the project's context.json: ${e.message.split('\n')[0]}`);
  console.error('Set CONTEXT_CONFIG=/path/to/context.json, or check PROJECT_CONTEXT_REPO points at a reachable context repo.');
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
 *  Older context.json files carry it as a `{ "Name": "notion-user-id" }` map instead, and every
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
 *  an explicit `"people": null` in a stub context.json must not defeat the guards. */
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
