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
- A marker file — `context-project.json` (JSON: `contextRepo`, plus an optional
  `connections` map naming the MCP connection per provider), or one-line `.context-repo` /
  `context-repo.txt` — in the working directory
  or the attached project files. Layouts differ by surface; look in `/mnt/project/`,
  `~/mnt/.projects/*/docs/` (imported project knowledge), `~/mnt/uploads/`, and if none of
  those exist, search: `find ~ /mnt -maxdepth 5 -name "context-project.json" -o -name "context-repo.txt" -o -name ".context-repo" 2>/dev/null`.
  **A marker found in a location the hook doesn't check is a plugin bug — report the exact
  path to the user so it can be added.**

Multiple channels disagreeing is worth surfacing: the precedence is env → settings → marker.

## 2. Nothing found? Configure it with the user

Ask which repo (owner/repo on github.com) holds this project's context — never guess. Then:

- **Laptop (Claude Code):** run it, from the project directory —
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/link-context.mjs" owner/repo --load`. That checks the
  repo resolves BEFORE writing (so a typo fails clean), merges `PROJECT_CONTEXT_REPO` into the
  project's `.claude/settings.json` without disturbing the rest of the file, warns if a
  `/.claude/*` ignore rule means nobody else will get it, and with `--load` puts the context in
  THIS session instead of the next one. Add `--local` for `.claude/settings.local.json` (this
  machine only), `--force` to re-point a project that is already linked elsewhere. The repo
  name is an argument, never a guess — it comes from the user's answer above.
- **Cowork / cloud sandbox:** the sandbox is ephemeral — nothing written here survives to the
  next session, so the ONLY durable store is a file attached to the project. Tell the user to
  attach a `context-project.json` to the project's files:
  `{ "contextRepo": "owner/repo", "connections": { "github": "github-myproject", "notion": "notion-myproject" } }`
  (a one-line `context-repo.txt` also works but can't name connections). Until they do,
  every new session starts unconfigured. No need to write it by hand if a laptop already
  has the project configured: the session-start hook generates exactly this file at the
  project root there — tell the user to attach that one.
- No context repo exists yet at all? Creating one is a separate job with no skill behind it
  yet: point the user at `c-energie/context-template`, whose README covers stamping a new
  context repo. Once it exists, link it with the command above.

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

**Not this skill:** re-pulling an already-configured context repo mid-session is
`refresh-context`.
