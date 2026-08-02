# context-kit

The **core layer** of a three-layer plugin architecture for project context in Claude Code /
Cowork. This plugin knows nothing about any particular project or workspace — it is the
machinery for loading, refreshing and writing a project's **context repo**.

```
┌─────────────────────────────────────────────────────────────┐
│ Project layer — one context repo per project                │
│   e.g. your-org/project-context, c-energie/thesis-context           │
│   memory.md, glossary, threads/, meetings/, pending/,       │
│   context.json (config the layers below read)               │
│   Created from the c-energie/context-template repo.         │
├─────────────────────────────────────────────────────────────┤
│ Middle layer — structured-state backend                     │
│   plugins/context-notion in THIS repo: generic              │
│   add-action / log-decision / query / update / pending-queue│
│   skills, parameterised by each project's context.json      │
│   (database IDs, property schemas, roster). One install     │
│   serves every Notion-backed project — a product and a      │
│   thesis alike. An Obsidian or other backend could          │
│   implement the same contracts later.                       │
├─────────────────────────────────────────────────────────────┤
│ Core layer — THIS PLUGIN                                    │
│   SessionStart hook (memory.md + thread pointers),          │
│   context-repo resolver, refresh-context, save-thread       │
└─────────────────────────────────────────────────────────────┘
```

Which context repo a session loads is per-project:

```json
{ "env": { "PROJECT_CONTEXT_REPO": "c-energie/thesis-context" } }
```

in the project's `.claude/settings.json`. The resolvers look for the name in order —
**env var (`PROJECT_CONTEXT_REPO`) → the project's `.claude/settings(.local).json` env block → a one-line
`.context-repo` or `context-repo.txt` marker file** (checked in the working folder and in
`/mnt/project/`) — with **no default**: an unconfigured project reports itself as such instead of silently loading another project's context. The same committed settings file drives
Claude Code whether or not the client applies the env var.

**Cowork** is why the marker file exists: its sandbox sees neither your repo checkout nor any
env var — the only channel in is files attached to the Cowork project, which surface under
`/mnt/project/`. So attach a `context-repo.txt` containing exactly one line, e.g.
`c-energie/thesis-context`, and every session in that Cowork project targets that repo (the
skills use the same marker to aim their GitHub MCP calls). Also add the repo to the
fine-grained PAT that the desktop app's GitHub MCP server holds.

Managed clones land at `~/.context/<owner>-<repo>`; `PROJECT_CONTEXT_DIR` pins the location
outright. Private repos authenticate via the OS git helper, else `CONTEXT_GIT_TOKEN` /
`GH_TOKEN` / `GITHUB_TOKEN`, else `gh auth token`. The pull is capped at
`CONTEXT_GIT_TIMEOUT` seconds (default 30).

**In cloud sandboxes, git cannot authenticate at all** — expected, not an error. The hook
then emits a hand-off status and the session's first response reads the repo over the
GitHub MCP connector instead. That connector must be registered in `~/.claude.json` (the
config Claude Code and Cowork sandboxes read — the desktop app's
`claude_desktop_config.json` feeds only its chat side), holding a credential that can
actually see the repo (fine-grained PATs have a single resource owner: one token per repo
owner). Which of several connections a project may use is declared in its `context.json`
`connections` block — the gate `context-setup` verifies. Two platform quirks the hook
absorbs: project files can mount *after* SessionStart fires (the hook retries ~10s, and
the payload instructs the first response to recover regardless), and sandbox filesystem
layouts vary (marker candidates cover all known ones, with a bounded find as backstop).

## Skills

| Skill | What it does |
| --- | --- |
| `refresh-context` | Re-pull the project's context repo mid-session and report what changed |
| `save-thread` | 🔒 Write up the current work as a `threads/` entry and push (never self-triggers) |

The SessionStart hook loads `memory.md` + thread pointers automatically, with a STALE banner
when the refresh fails — a silently stale context is the one failure mode that actively
misleads.

## Roadmap

Planned here: `curate-context` (condense/restructure a context repo as threads accumulate),
`context-access` (the full GitHub-API route documentation for cloud sandboxes), an
`update-plugin` analogue for maintaining this marketplace, and `init-context` (stamp a new
context repo from `c-energie/context-template` and wire it up end to end).

A project must never enable two plugins whose hooks both load context — the context loads
twice.

## Working on this repo

No build, no tests: `node scripts/check-plugin.mjs .` is CI, run it before any commit. Bump
`.claude-plugin/plugin.json` via `node scripts/bump-version.mjs . patch|minor|major` — version
lives there **only** (a version in `marketplace.json`'s `plugins[]` overrides it silently).
`*.sh` stay LF. No angle brackets in any YAML front-matter value. The hook must exit 0 on
every path. `hooks/load-context.sh` carries an inline duplicate of `context-repo.sh` for
installs where packaging drops `scripts/` — change both or neither.
