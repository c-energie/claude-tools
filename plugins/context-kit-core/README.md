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
`context-project.json` / `.context-repo` / `context-repo.txt` marker file** (checked in `.claude/`, the working folder and
`/mnt/project/`) — with **no default**: an unconfigured project reports itself as such instead of silently loading another project's context. The same committed settings file drives
Claude Code whether or not the client applies the env var.

**Opting a project out.** A project that will never have a context repo sets the value to
`none` (`off` / `false` / `no` / `-` also work) in any of those same channels:

```json
{ "env": { "PROJECT_CONTEXT_REPO": "none" } }
```

— or `node "${CLAUDE_PLUGIN_ROOT}/scripts/link-context.mjs" none`. The session-start hook then
loads nothing, says nothing, and — the point of it — never goes marker-hunting. That is
deliberately different from *unconfigured*, which still announces itself on every session:
only a human can tell "not set up yet" from "not applicable here".

Writing that settings file by hand is optional — from the project's own directory:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/link-context.mjs" c-energie/thesis-context --load
```

It verifies the repo resolves *before* writing anything, merges `PROJECT_CONTEXT_REPO` into
`.claude/settings.json` without disturbing the rest of the file (`--local` targets
`settings.local.json`, `--force` re-points an already-linked project), warns when a
`/.claude/*` ignore rule would stop the link reaching anyone who clones the project, and with
`--load` reads the context into the *running* session rather than the next one. The repo is an
argument, never inferred from the project's git remote: guessing it is the wrong-context
failure this plugin exists to prevent.

**Starting from the context instead of the project.** Everything above answers "which context
does *this* project load", asked from a session that has already started somewhere. The two
launchers go the other way — pick a checkout under `~/.context`, then start Claude in it —
which is what a desktop shortcut needs, having no working directory to speak of:

```powershell
scripts\Start-ContextSession.ps1              # menu: owner -> repo, then runs `claude` there
scripts\Start-ContextSession.ps1 -Shortcut    # ...and put a shortcut for it on the Desktop
```

```bash
scripts/start-context-session.sh              # the same menu on macOS / Linux
scripts/start-context-session.sh --shortcut   # ...writes a .desktop (Linux) or .command (macOS)
```

The menu descends one level at a time and stops as soon as the chosen directory *is* a repo —
decided by content (`context.json`, `.claude-plugin/marketplace.json`, or a `.git` directory),
never by depth, so a hand-made or non-standard layout still lists correctly. `-DryRun` /
`--dry-run` prints the directory instead of launching, `-Root` / `--root` browses somewhere
else, and anything unrecognised is passed through to `claude` verbatim. The launcher itself
loads nothing: the new session's SessionStart hook does that, exactly as if you had cd'd there
by hand. This is the one interactive script here — a menu is the point, not a fallback — so
unlike `link-context.mjs` it prompts instead of taking its answer as an argument.

`-Shortcut` / `--shortcut` first copies the script to `~/.context/` and points the shortcut at
**that** copy. An installed plugin lives at a versioned path
(`~/.claude/plugins/cache/.../context-kit-core/[version]/scripts/`), so a shortcut aimed straight
at it breaks silently on the next plugin update; re-run with the flag after an update to
refresh the copy, and the shortcut never needs touching. On Windows the shortcut runs
PowerShell with `-ExecutionPolicy Bypass`, without which a stock machine refuses an unsigned
`.ps1` and the double-click looks like it did nothing.

**Cowork** is why the marker file exists: its sandbox sees neither your repo checkout nor any
env var — the only channel in is files attached to the Cowork project. Attach a
`context-project.json`:

```json
{
  "contextRepo": "c-energie/thesis-context",
  "connections": { "github": "github-thesis", "notion": "notion-thesis" }
}
```

Every session in that Cowork project then targets that repo, and — because a machine can hold
several same-provider MCP connections scoped to different workspaces — the `connections` map
tells the session exactly which connection to read/write with, from the very first bootstrap
read (the hook's hand-off names it). `contextRepo`'s value must be on that GitHub
connection's PAT. A plain one-line `context-repo.txt` still works but cannot name
connections. `context.json` in the context repo remains authoritative once loaded — keep the
marker's `connections` in step with it (`context-setup` flags drift).

**You don't write that file by hand.** Any laptop session that resolves the context repo
generates it — once, in the **context repo's own `.claude/context-project.json`**, next to the
committed `settings.json` — with `contextRepo` from the resolved config and `connections`
mirrored from the repo's `context.json`. Commit it and every clone carries it; that is also
the file to attach to a Cowork project. One canonical marker per context repo, not a generated
copy in every project that uses it. Keys the hook doesn't know about are preserved on refresh,
so anything hand-added survives.

Managed clones land at `~/.context/<owner>/<repo>`; `PROJECT_CONTEXT_DIR` pins the location
outright. (That was a flat `<owner>-<repo>` slug until 2026-08-11 — an existing clone under the
old name is not migrated, just re-cloned at the new path and left to be deleted by hand.)
Private repos authenticate via the OS git helper, else `CONTEXT_GIT_TOKEN` /
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
| `context-setup` | First-run wiring and diagnosis: how this project names its repo, is it reachable, load it now |
| `context-doctor` | Health-check an already-linked repo for the drift that never announces itself; fixes derivable config keys only |
| `refresh-context` | Re-pull the project's context repo mid-session and report what changed |
| `save-thread` | 🔒 Write up the current work as a `threads/` entry and push (never self-triggers) |
| `curate-context` | 🔒 Keep the repo lean: promote, condense, archive, rebuild `threads/INDEX.md` |
| `setup-connectors` | Provision the MCP connections a project's `context.json` declares |
| `assistant` | Adopt a role assistant — its persona, memory, doctrine and thread history; scaffolds one on first use |
| `assistant-lesson` | 🔒 Record a transferable lesson into `LESSONS.md`, abstracted at write time |
| `supervisor-sweep` | 🔒 Distil role lessons across every included project into a supervisor thread |
| `supervisor-distil` | 🔒 Promote supervisor threads into durable doctrine and queue it to each project |
| `memory-triage` | 🔒 Drain Claude's own per-directory memory into the right layer — personal, project, role or local |
| `context-access` | _(hidden)_ The GitHub-API route sandboxes use, and the rules that stop an API write truncating a file |
| `update-plugin` | Change these plugins themselves — check, bump, and (after asking) push |

The SessionStart hook loads `memory.md` + thread pointers automatically, with a STALE banner
when the refresh fails — a silently stale context is the one failure mode that actively
misleads. A project that will never have a context repo opts out with `none`; see above.

### The cross-project layer: `include`

A context repo may declare, in its `context.json`:

```json
"include": ["owner/repo-a", "owner/repo-b"]
```

Sessions on that repo then also load each included repo's `memory.md`, `glossary.md` and
`threads/INDEX.md` — **read-only**, after the repo's own context, each pulled under the same
ff-only/timeout/credential rules with its own per-repo STALE or UNAVAILABLE banner.
`refresh-context` re-pulls them too. The contract, all load-bearing:

- **Explicit list only.** The loaded set is committed config, never discovered from the
  filesystem — an *accidental* cross-project load is the failure mode this plugin exists to
  prevent, so the deliberate one must be spelled out.
- **One level.** An included repo's own `include` list is ignored.
- **Read-only.** Nothing in a combined session writes into an included repo — not git, not
  its structured-state backend, not its `pending/`. A combined repo that wants to route
  items outward keeps its own outbox folder (by convention `handoff/`, which the payload
  mentions when present).
- **Route-agnostic.** Entries are `owner/repo` names only; nothing in the schema assumes a
  local clone, so a sandbox route reading repos over the GitHub API can honour the same list.
- Parsing the array needs `node`; without it the payload says loudly that the includes were
  skipped rather than quietly omitting them.

## Roadmap

Planned here: `init-context` (stamp a new context repo from `c-energie/context-template` and
wire it up end to end — the one remaining hand-run checklist).

A project must never enable two plugins whose hooks both load context — the context loads
twice.

## Working on this repo

No build, no tests: `node scripts/check-plugin.mjs .` is CI, run it before any commit. Bump
`.claude-plugin/plugin.json` via `node scripts/bump-version.mjs . patch|minor|major` — version
lives there **only** (a version in `marketplace.json`'s `plugins[]` overrides it silently).
`*.sh` stay LF. No angle brackets in any YAML front-matter value. The hook must exit 0 on
every path. `hooks/load-context.sh` carries an inline duplicate of `context-repo.sh` for
installs where packaging drops `scripts/` — change both or neither.
