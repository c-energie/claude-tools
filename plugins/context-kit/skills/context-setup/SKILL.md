---
name: context-setup
description: First-run wiring and diagnosis for a project's context repo — find how this project names its repo (env, settings, or marker file), verify the repo is actually reachable, load the context into this session, and walk the user through configuring anything missing. Triggers like "set up the context", "context setup", "connect this project to its context repo", "why didn't my context load", "the wrong context loaded", "it can't find my context repo".
---

# Set up / diagnose this project's context

Run this once in a new project — or whenever a session starts with the ⚠ "no context repo
configured" line, or with the wrong context. It finds the configuration, verifies it, loads
the context now, and fixes gaps with the user.

## 1. How is (or isn't) the repo named? Check every channel, report what you find

- `PROJECT_CONTEXT_REPO` in the environment.
- The project's `.claude/settings.local.json` / `.claude/settings.json` env block.
- A one-line marker file — `.context-repo` or `context-repo.txt` — in the working directory
  or the attached project files. Layouts differ by surface; look in `/mnt/project/`,
  `~/mnt/.projects/*/docs/` (imported project knowledge), `~/mnt/uploads/`, and if none of
  those exist, search: `find ~ /mnt -maxdepth 5 -name "context-repo.txt" -o -name ".context-repo" 2>/dev/null`.
  **A marker found in a location the hook doesn't check is a plugin bug — report the exact
  path to the user so it can be added.**

Multiple channels disagreeing is worth surfacing: the precedence is env → settings → marker.

## 2. Nothing found? Configure it with the user

Ask which repo (owner/repo on github.com) holds this project's context — never guess. Then:

- **Laptop (Claude Code):** offer to write `{ "env": { "PROJECT_CONTEXT_REPO": "owner/repo" } }`
  into the project's `.claude/settings.json` (committed — the whole team gets it) or
  `.claude/settings.local.json` (this machine only). Takes effect next session.
- **Cowork / cloud sandbox:** the sandbox is ephemeral — nothing written here survives to the
  next session, so the ONLY durable store is a file attached to the project. Tell the user to
  attach `context-repo.txt` containing exactly one line (`owner/repo`) to the project's
  files, and say plainly that until they do, every new session starts unconfigured.
- No context repo exists yet at all? Creating one is `init-context`'s job (from the
  `c-energie/context-template` repo) — if that skill isn't installed, point the user at the
  template repo's README.

## 3. Verify the repo is reachable, then load it NOW

- **Shell + git:** `ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh")"` — then
  `bash "${CLAUDE_PLUGIN_ROOT}/hooks/load-context.sh" --refresh` and treat its output as the
  session context.
- **No git route (Cowork):** read `memory.md` and `context.json` from the repo over the
  GitHub MCP connector, and say the connector was the route. A 404 on a private repo usually
  means the PAT's resource owner or repository list doesn't cover it — say which token needs
  editing rather than "repo not found".
- Report the outcome the user cares about in one line: which repo, reachable or not and why,
  and the newest commit's age.
- **Check the connector gate:** if `context.json` has a `connections` block, verify each
  named MCP server's tools are actually present in this session, and flag any OTHER
  connection of the same provider as off-limits for this project. If the project uses
  connectors but declares no `connections` block, offer to add one — it is what stops a
  multi-workspace machine writing through the wrong connection.

## 4. If the hook should have done this but didn't

The SessionStart hook performs the same lookup automatically. If a marker/setting exists in a
standard location but the session still started unconfigured, check the installed plugin
version — `grep '"version"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json"` — against the
marketplace, and tell the user whether the fix is "update the plugin" (stale version), "new
location" (report the path), or "restart" (config read at session start only).

**Not this skill:** creating a brand-new context repo is `init-context`; re-pulling an
already-configured one mid-session is `refresh-context`.
