# MCP connectors

Scripts for wiring Claude to GitHub and Notion with **one credential per project**, so a
connection scoped to the thesis workspace can't reach FlexSense and vice versa.

Tokens are never written into the Claude config files. They go into the OS credential store
(Windows DPAPI, macOS Keychain, Linux libsecret) and are read back when a server starts.

## Setup

These scripts ship inside the context-kit plugin: `plugins/context-kit-core/scripts/mcp/`
in the `c-energie/context-kit` marketplace checkout.

The usual route is project-driven — from a project whose context repo is configured:

```bash
node <marketplace>/plugins/context-kit-core/scripts/mcp/setup-connectors.mjs
```

It reads the `connections` block in the project's `context.json` (proposing and writing one
if the block is missing), compares that against what this machine actually has configured,
and walks through provisioning whatever is absent. `--check` diagnoses without changing
anything; `--add <provider>` declares a provider not yet in the block. The runtime is
copied to `~/.mcp/` before use, so the paths written into the Claude configs survive a
plugin update or marketplace re-sync.

`setup.mjs` in the same directory is the freeform variant: it checks the machine and lets
you add arbitrarily named connections with no `context.json` involved. Re-run either any
time; adding a connector that already exists replaces it.

**Prerequisites**

- Node 18+
- Claude Desktop opened at least once (so its config file exists)
- For GitHub: either a `github-mcp-server` binary, or Docker
- For Notion: `npx`

The GitHub binary is the recommended route — no daemon, faster start. Download for your
platform from https://github.com/github/github-mcp-server/releases, extract into
`~/.mcp/bin/` (the connectors flow looks there; `setup.mjs` looks in `bin/` next to
itself). It's ignored by git; each person fetches their own.

## Credentials

**GitHub** — fine-grained PAT from github.com/settings/personal-access-tokens, scoped to only
the repos that connection should reach. Classic tokens work but can't be limited per repo,
which defeats the point.

Two known GitHub quirks:

- The token lists more repos than it's scoped to. Public repos are readable by any token, and
  GitHub doesn't enforce scope on *listing* — only on actual access. Usually benign.
- Editing a fine-grained PAT in the web UI can silently reset its scope to "All repositories".
  Treat these tokens as immutable: to change anything, revoke and mint a new one.

To verify real access, a private repo that should be out of scope must return 404:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  https://api.github.com/repos/OWNER/OUT-OF-SCOPE-REPO
```

**Notion** — internal integration secret from notion.so/profile/integrations, created *in the
target workspace*. Then share the relevant pages with it (page ••• menu → Connections).
Without that sharing step reads come back empty even though the token verifies fine.

## Manual use

After a `setup-connectors.mjs` run the runtime lives in `~/.mcp/`; before one, run the same
files from the plugin's `scripts/mcp/` directory.

```bash
node ~/.mcp/add-mcp-connector.mjs --github github-flexsense --binary ~/.mcp/bin/github-mcp-server --toolsets repos,issues
node ~/.mcp/add-mcp-connector.mjs --notion notion-thesis
node ~/.mcp/mcp-launch.mjs github-flexsense --print    # check a stored credential
```

Flags: `--toolsets <list>`, `--readonly`, `--binary <path>`, `--remote`.

`--remote` bridges to GitHub's hosted server via `mcp-remote`. It passes the token as a
command-line argument, so anything running as your user can read it from the process list —
use the binary or Docker unless you have a reason not to.

## Files

| | |
|---|---|
| `setup-connectors.mjs` | provisions what the project's `context.json` declares; deploys the runtime to `~/.mcp/` |
| `setup.mjs` | machine checks and freeform guided setup |
| `add-mcp-connector.mjs` | adds one connector; verifies the token before writing anything |
| `mcp-launch.mjs` | reads the credential and starts the server; referenced from the configs |
| `secret-store.mjs` | per-platform credential storage and config path resolution |

Both Claude configs are written: `~/.claude.json` (Claude Code, Cowork) and the desktop app's
config. Backups are left as `.bak-mcp`.

## Notes

- These are local stdio servers, so they work in Claude Desktop and Claude Code but **not** on
  the phone or web. That's the tradeoff for per-project credential scoping — the hosted
  connectors authenticate as your whole account and can only be added once per service.
- After adding a connector, fully quit Claude Desktop (tray icon → Quit) rather than closing
  the window. Claude Code picks it up on the next session.
- Server failures are logged to `%APPDATA%\Claude\logs\` (Windows) or
  `~/Library/Logs/Claude/` (macOS).
- Set short expiries on the tokens. Rerunning the adder with the same name rotates cleanly.
- On a laptop project whose context repo is configured, the session-start hook also writes a
  `context-project.json` marker (contextRepo + connections) at the project root — attach that
  file to the Cowork project so sandbox sessions use the same connections declared here.

## When this becomes unnecessary

FlexSense now has a GitHub org, so the endgame is a GitHub App installed on it: an admin
picks the repos once and it applies to everyone, with no local setup or per-machine PAT
juggling. Until that App is set up, the fine-grained PATs above are still the way in — and
Notion has no org-level equivalent, so its per-workspace integrations stay either way.
