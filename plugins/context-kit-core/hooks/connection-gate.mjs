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
// project's context.json — and a connection provisioned tomorrow is covered without anyone
// editing anything.
//
// THE RULE, for a tool named mcp__[server]__[tool]:
//   - [server] resembles no known provider          -> stay silent (not ours to judge)
//   - the project declares that provider, and       -> stay silent
//     [server] is exactly the declared connection
//   - anything else                                 -> DENY, naming what should have been used
//
// "Declares that provider" is deliberately strict. A project whose connections block is `{}` has
// declared none, on purpose (see setup-connectors.mjs), so every provider connector is denied
// there — that is the whole point of a cross-project layer that must not hold a workspace
// credential. A project with NO connections key has decided nothing, so nothing is denied: the
// same absent-versus-empty distinction the resolvers draw between unconfigured and opted out.
//
// FAIL OPEN, LOUDLY. If the policy cannot be read — no context repo, no clone, unparseable JSON —
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
import { join } from 'node:path';

// Providers this plugin knows by name, so a connector can be recognised even when the project
// declares nothing for it. A `connections` block naming something else adds to this at runtime.
const KNOWN_PROVIDERS = ['github', 'notion', 'slack'];
// In step with hooks/load-context.sh, scripts/context-repo.sh, scripts/link-context.mjs.
const OPTOUT = ['none', 'off', 'false', 'no', '-', 'disabled'];

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
  let connections = null;
  let source = null;
  let unreadable = null;      // present but broken is NOT the same as absent — say which
  if (repo && /^[^/]+\/[^/]+$/.test(repo)) {
    const ctxFile = join(process.env.PROJECT_CONTEXT_DIR || join(homedir(), '.context', ...repo.split('/')), 'context.json');
    const ctx = readJson(ctxFile);
    if (!ctx && existsSync(ctxFile)) unreadable = ctxFile;
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
        + 'read and this call is being allowed unchecked. Fix that file — a broken context.json '
        + 'silently disables this gate.'
      : `${server}: no connections policy found${repo ? ` for ${repo}` : ''} — allowing, nothing to enforce`);
  }

  // ------------------------------------------------------------ decide
  const providers = [...new Set([...KNOWN_PROVIDERS, ...Object.keys(connections)])];
  const lower = server.toLowerCase();
  const provider = providers.find((p) => lower.includes(String(p).toLowerCase()));
  if (!provider) allow(`${server}: not a connector for any provider this project knows about`);

  const declared = connections[provider];
  if (declared && String(declared) === server) process.exit(0);   // the declared one: silent pass

  const empty = !Object.keys(connections).length;
  deny(declared
    ? `Blocked: "${server}" is not this project's ${provider} connection. ${source} declares `
      + `${provider} → "${declared}", and only the declared connection may be used — several `
      + `same-provider connectors scoped to different projects exist on this machine, and using `
      + `the wrong one writes into another project's repo or workspace. Use ${declared}, or, if `
      + `${server} is genuinely the right one here, change connections in ${source} first.`
    : `Blocked: this project declares no ${provider} connection${empty ? ' (its connections block is {}, which is a deliberate "none", not an omission)' : ''}. `
      + `"${server}" belongs to another project. If this project should have a ${provider} `
      + `connection, declare it in ${source} — do not reach for another project's.`);
} catch (e) {
  // A gate that throws must not take the session with it, and must not silently swallow itself.
  allow(`internal error, allowing the call: ${e && e.message ? e.message : e}`);
}
