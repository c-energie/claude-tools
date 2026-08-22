---
name: setup-connectors
description: Provision the MCP connections a project declares in its context.json — one credential per connection, scoped to that project's repos or workspace — and diagnose why a declared connection is missing or wrong. Triggers like "set up my connectors", "the project's github connection isn't there", "I'm getting the wrong notion workspace", "add a scoped PAT for this project", "why can't Claude see this repo".
---

# Provision this project's declared connections

The `connections` block in the project's `context.json` names which MCP server serves each
provider here — e.g. `{ "github": "github-thesis", "notion": "notion-thesis" }`. This skill
makes those exist on the current machine, each backed by its own narrowly-scoped credential.

**Why per-project credentials.** One connection per provider per machine would authenticate as
the whole account: every repo, every workspace. Separate named connections, each with a
fine-grained PAT or a workspace-specific integration token, are what make
"use ONLY the one this project declares" enforceable rather than a convention.

## 1. Diagnose first

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mcp/setup-connectors.mjs" --check
```

Reports each declared connection as configured or missing, and names any other connection of
the same provider present on this machine — those belong to other projects and are off-limits
here. Read the output back to the user before changing anything.

The script finds `context.json` on its own: `PROJECT_CONTEXT_REPO` (the env var, or the
project's `.claude/settings*.json`) names the repo, and its managed clone lives at
`~/.context/owner/repo` — cloned there on first use. `--context path` is an override for
odd layouts, not the normal route.

If it can't find `context.json`, that's `context-setup`'s job, not this one — the context repo
isn't configured. If it finds the file but there's **no `connections` key at all**, offer to add
one; the block is what stops a multi-workspace machine writing to the wrong place.

**`"connections": {}` is not the same thing, and must not be treated as one.** An empty block is
a decision already taken — this project declares no connections — exactly as `none` is a decision
about the repo name rather than a missing one. The script reports it and exits 0; say so and stop
rather than offering to fill it in. A repo whose whole safety property is holding no workspace
credential is precisely the one that writes `{}` and means it. If the user genuinely wants to
reopen it, `--add [provider]` names what to declare.

## 2. Provision what's missing

Drop `--check` to run it interactively. It deploys the runtime to `~/.mcp/`, then for each
missing connection prompts for a credential (hidden input), verifies it against the provider's
API before touching any config, stores it in the OS credential store, and writes both Claude
configs.

Tell the user what to create before they're prompted:

- **GitHub** — a *fine-grained* PAT at github.com/settings/personal-access-tokens, scoped to
  only this project's repos. Classic tokens can't be limited per repo and defeat the purpose.
- **Notion** — an *internal integration* at notion.so/profile/integrations created **in this
  project's workspace**, then shared with the relevant pages (••• → Connections). Without the
  sharing step, reads return empty while the token verifies fine.

Nothing is written until the credential verifies, so an abandoned run leaves no mess.

## 3. Finish

The user must **fully quit** Claude Desktop — tray icon → Quit, not closing the window — and
reopen. Claude Code picks up new servers on its next session. Say this explicitly; a server
that "doesn't appear" is almost always this.

## Known traps worth naming when they come up

- **A GitHub token lists more repos than it's scoped to.** Public repos are readable by any
  token, and GitHub doesn't enforce scope on *listing* — only on access. Usually benign. To
  check for real, a private out-of-scope repo must return 404:
  `curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $T" https://api.github.com/repos/OWNER/REPO`
- **Editing a fine-grained PAT in the web UI can silently reset its scope to "All
  repositories".** Treat these tokens as immutable: to change anything, revoke and mint a new
  one, then re-run this skill with the same connection name to rotate.
- **Docker route needs Docker Desktop running**, not merely installed. The native binary in
  `~/.mcp/bin/` avoids this and starts faster.
- **These are local stdio servers.** They work in Claude Desktop and Claude Code, not on
  phone or web. That is the cost of per-project scoping — the hosted connectors authenticate
  as the whole account and can only be added once per service.

## Verifying a stored credential

```bash
node ~/.mcp/mcp-launch.mjs <connection-name> --print
```

**Not this skill:** configuring which context repo a project uses is `context-setup`;
re-pulling context mid-session is `refresh-context`.
