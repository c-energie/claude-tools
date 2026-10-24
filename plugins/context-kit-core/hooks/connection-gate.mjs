#!/usr/bin/env node
// PreToolUse gate: refuse an MCP call through a connection this project did not declare.
//
// Until now `connections` was enforced by TELLING the model to respect it — the session payload
// says "use only what it declares" and nothing checked. Every actual gate was a hand-written
// `permissions.deny` list in a repo's .claude/settings.json, which enumerates *the others* and so
// is written against the connections that existed the day it was written. On this machine that
// had already failed three times over: two repos' lists predate connections since provisioned,
// and one context repo has no permissions block at all.
//
// This derives the decision instead. The policy has exactly one author — `connections` in the
// nearest `.claude/workspace.json` (ADR 0002), or, for a project not yet migrated to one, in its
// context repo's context.json — and a connection provisioned tomorrow is covered without anyone
// editing anything.
//
// THE WORKSPACE IS ASKED FIRST, and found by walking up. The legacy route reads the repo name
// from env / settings / a marker in the project dir ONLY, so a member repo nested inside a
// workspace and opened as the project found no policy at all and allowed every connector. Only
// findWorkspace() is used, never resolveWorkspace(): the latter's fallback runs context-repo.sh,
// which may pull or clone, and this runs on every MCP call. When a workspace is found it is the
// whole answer — levels never merge, so an absent `connections` there denies nothing rather than
// falling through to a context.json or marker that is no longer this directory's policy.
//
// THE RULE, for a tool named mcp__[server]__[tool]:
//   - [server] resembles no known provider          -> stay silent (not ours to judge)
//   - the project declares that provider, and       -> stay silent
//     [server] is one of the connections it declares
//   - anything else                                 -> DENY, naming what should have been used
//
// ONE PROVIDER MAY DECLARE MORE THAN ONE CONNECTION, because a fine-grained GitHub PAT has a
// single resource owner: a project spanning two owners needs two tokens and therefore two
// connectors, and before this it had nowhere to say so — a personal repo reaching both the
// user's own repos and an org's was the case that forced it. The allowlist grew from one entry to N; it did not become a weaker rule.
// Anything outside the declared set is still denied, and the set still has exactly one author.
//
// "Declares that provider" is deliberately strict. A project whose connections block is `{}` has
// declared none, on purpose (see setup-connectors.mjs), so every provider connector is denied
// there — that is the whole point of a personal repo that must not hold a project's
// credential. A project with NO connections key has decided nothing, so nothing is denied: the
// same absent-versus-empty distinction the resolvers draw between unconfigured and opted out.
//
// FAIL OPEN, LOUDLY. If the policy cannot be read — no workspace and no context repo, no clone,
// unparseable JSON —
// this allows the call and says why on stderr. A gate that blocks every MCP call the moment a
// checkout is missing would be worse than the status quo, and the hook contract is that a hook
// never blocks wrongly. The cost is that "no output" means either "allowed" or "could not tell",
// so the reason is always written.
//
// WHY IT WORKS IN COWORK. A sandbox has no checkout and no env var, but it does get the attached
// .claude/context-project.json, and load-context.sh already mirrors `connections` into that file
// every session. So the marker is the fallback source here, which is what makes this the only
// mechanism that reaches both surfaces: settings.json permissions travel with a checkout, and a
// Cowork sandbox never has one.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Providers this plugin knows by name, so a connector can be recognised even when the project
// declares nothing for it. A `connections` block naming something else adds to this at runtime.
const KNOWN_PROVIDERS = ['github', 'notion', 'slack'];
// In step with hooks/load-context.sh, scripts/context-repo.sh, scripts/link-context.mjs.
const OPTOUT = ['none', 'off', 'false', 'no', '-', 'disabled'];

// A provider's value is either one connection name, or a map of resource owner -> name (a repo
// owner for github, a workspace for the others). The map form is preferred over a bare array
// because the key is the fact a caller needs: reaching c-energie through the corson94 token
// 404s, and a 404 reads as "no such repo" rather than "wrong credential". An array is still
// accepted rather than rejected — a shape this gate does not understand must not silently
// become "declares nothing", which denies every call for that provider.
//
// TOTAL BY CONSTRUCTION: no input may make this throw. It sits in front of a gate that fails
// open, so a throw here would not deny — it would allow every MCP call on the machine, quietly.
const names = (v) => {
  if (typeof v === 'string') return v ? [v] : [];
  if (Array.isArray(v)) return v.filter((n) => typeof n === 'string' && n);
  if (v && typeof v === 'object') return Object.values(v).filter((n) => typeof n === 'string' && n);
  return [];
};

// For the deny message only: name each connector and, where the map form gives one, the owner
// it serves. A refusal that does not say what to use instead just moves the puzzle.
const describe = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const pairs = Object.entries(v).filter(([, n]) => typeof n === 'string' && n);
    if (pairs.length) return pairs.map(([owner, n]) => `"${n}" (${owner})`).join(' and ');
  }
  return names(v).map((n) => `"${n}"`).join(' and ');
};

const allow = (why) => { if (why) process.stderr.write(`connection-gate: ${why}\n`); process.exit(0); };
const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(0);
};

const readJson = (file) => {
  try {
    const raw = readFileSync(file, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch { return null; }
};

try {
  // ------------------------------------------------------------ what is being called
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no stdin: allow */ }
  const tool = String(payload.tool_name ?? '');
  if (!tool.startsWith('mcp__')) process.exit(0);          // not an MCP call; silent, not "allowed"
  const server = tool.slice(5).split('__')[0];
  if (!server) process.exit(0);

  const project = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();

  // ------------------------------------------------------------ the workspace route
  // Imported dynamically, inside the try, rather than statically: a static import that failed
  // (packaging is not guaranteed to ship scripts/ beside hooks/ — see load-context.sh's inline
  // resolver) would throw before any catch and exit non-zero on every MCP call. Losing it here
  // costs only the workspace route, and says so.
  let connections = null;
  let source = null;
  let unreadable = null;      // present but broken is NOT the same as absent — say which
  let found = null;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const { findWorkspace } = await import(pathToFileURL(join(here, '..', 'scripts', 'workspace.mjs')).href);
    found = findWorkspace(project);
  } catch (e) {
    process.stderr.write(`connection-gate: workspace resolver unavailable (${e && e.message ? e.message : e}); using the context-repo route\n`);
  }

  if (found?.root) {
    const ws = found.config;
    if (!Object.prototype.hasOwnProperty.call(ws, 'connections')) {
      allow(`${server}: ${found.file} declares no connections — allowing, nothing to enforce`);
    }
    // A string, array or null where the map belongs is a policy this cannot read, not "none":
    // treating it as {} would deny every provider connector over a typo.
    if (!ws.connections || typeof ws.connections !== 'object' || Array.isArray(ws.connections)) {
      allow(`${server}: "connections" in ${found.file} is not an object, so the connection policy `
        + 'could NOT be read and this call is being allowed unchecked. Fix that file — a broken '
        + 'workspace.json silently disables this gate.');
    }
    connections = ws.connections;
    source = found.file;
  } else {
    // A malformed nearest workspace.json goes to the legacy route, exactly as workspace.mjs does
    // for the session's context — never on to an outer workspace. It is remembered so that, if
    // the legacy route finds nothing either, the allow names the file that broke the gate.
    if (found?.error) {
      unreadable = found.file;
      process.stderr.write(`connection-gate: ${found.file} is malformed (${found.error}); falling back to the context-repo route\n`);
    }
    // ------------------------------------------------------------ which repo holds the policy
    // Resolution order matches the resolvers exactly, minus the network: this runs on every MCP
    // call, so it may never pull, clone or block.
    const settingsRepo = (file) => readJson(file)?.env?.PROJECT_CONTEXT_REPO ?? null;
    const MARKERS = [
      join(project, '.claude', 'context-project.json'),
      join(project, 'context-project.json'),
      join(project, 'docs', 'context-project.json'),
      '/mnt/project/context-project.json',
      join(homedir(), 'mnt', 'uploads', 'context-project.json'),
    ];

    let repo = process.env.PROJECT_CONTEXT_REPO
      || settingsRepo(join(project, '.claude', 'settings.local.json'))
      || settingsRepo(join(project, '.claude', 'settings.json'));
    let markerJson = null;
    for (const m of MARKERS) {
      if (!existsSync(m)) continue;
      const held = readJson(m);
      if (!held) continue;
      markerJson = markerJson ?? held;
      repo = repo || held.contextRepo;
    }

    if (repo && OPTOUT.includes(String(repo).trim().toLowerCase())) {
      allow(`${server}: this project opts out of a context repo, so it declares no connection policy`);
    }

    // ------------------------------------------------------------ the policy itself
    // context.json is authoritative; the marker is the fallback that reaches a Cowork sandbox,
    // where there is no clone to read.
    if (repo && /^[^/]+\/[^/]+$/.test(repo)) {
      const ctxFile = join(process.env.PROJECT_CONTEXT_DIR || join(homedir(), '.context', ...repo.split('/')), 'context.json');
      const ctx = readJson(ctxFile);
      if (!ctx && existsSync(ctxFile)) unreadable = unreadable ?? ctxFile;
      if (ctx && Object.prototype.hasOwnProperty.call(ctx, 'connections') && ctx.connections && typeof ctx.connections === 'object') {
        connections = ctx.connections;
        source = `${repo} context.json`;
      }
    }
    if (!connections && markerJson?.connections && typeof markerJson.connections === 'object') {
      connections = markerJson.connections;
      source = 'the context-project.json marker';
    }
    if (!connections) {
      allow(unreadable
        ? `${server}: ${unreadable} exists but will not parse, so the connection policy could NOT be `
          + 'read and this call is being allowed unchecked. Fix that file — a broken policy file '
          + 'silently disables this gate.'
        : `${server}: no connections policy found${repo ? ` for ${repo}` : ''} — allowing, nothing to enforce`);
    }
  }

  // ------------------------------------------------------------ decide
  // Which provider is this connector for? Usually its name says so. But a connector this
  // project DECLARES belongs to the provider it is declared under, whatever it is called, and
  // checking the declaration FIRST is the only way an opaquely-named one is gated at all: a
  // GitHub connector called "claude-tools" matches no provider word, so name-sniffing alone
  // classifies it as none of our business and allows it — while its own project's declaration
  // sat there saying exactly which provider it served. Observed on this machine, 2026-08-30.
  //
  // This does NOT make such a name safe. Declaration only reaches the project that wrote it;
  // in every OTHER project the fallback still cannot classify the connector and still allows
  // it. That residual hole is not closable here — a gate cannot know what another project's
  // connectors are for — so `context-doctor` warns about a declared name that carries no
  // provider word, which is where a fix can actually be made.
  const declaredProviderOf = (s) => {
    for (const [p, v] of Object.entries(connections)) if (names(v).includes(s)) return p;
    return null;
  };
  const providers = [...new Set([...KNOWN_PROVIDERS, ...Object.keys(connections)])];
  const lower = server.toLowerCase();
  const provider = declaredProviderOf(server)
    ?? providers.find((p) => lower.includes(String(p).toLowerCase()));
  if (!provider) allow(`${server}: not a connector for any provider this project knows about`);

  const declared = connections[provider];
  const allowed = names(declared);
  if (allowed.includes(server)) process.exit(0);                  // a declared one: silent pass

  const empty = !Object.keys(connections).length;
  deny(allowed.length
    ? `Blocked: "${server}" is not one of this project's ${provider} connections. ${source} `
      + `declares ${provider} → ${describe(declared)}, and only a declared connection may be `
      + `used — several same-provider connectors scoped to different projects exist on this `
      + `machine, and using the wrong one writes into another project's repo or workspace. Use `
      + `${allowed.length > 1 ? 'the one whose owner matches what you are reaching for' : allowed[0]}`
      + `, or, if ${server} is genuinely the right one here, change connections in ${source} first.`
    : `Blocked: this project declares no ${provider} connection${empty ? ' (its connections block is {}, which is a deliberate "none", not an omission)' : ''}. `
      + `"${server}" belongs to another project. If this project should have a ${provider} `
      + `connection, declare it in ${source} — do not reach for another project's.`);
} catch (e) {
  // A gate that throws must not take the session with it, and must not silently swallow itself.
  allow(`internal error, allowing the call: ${e && e.message ? e.message : e}`);
}
