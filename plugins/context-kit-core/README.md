# context-kit

The **core layer** of a three-layer plugin architecture for project context in Claude Code /
Cowork. This plugin knows nothing about any particular project or workspace. It is the
machinery for finding, refreshing and writing a project's **workspace** (ADR 0002 in the
marketplace repo): the git repo at a project's root, marked by `.claude/workspace.json`, that
holds its shared context.

```
┌─────────────────────────────────────────────────────────────┐
│ Project layer — one workspace per project                   │
│   e.g. c-energie/workspace, corson94/thesis                 │
│   CLAUDE.md → @docs/memory.md, GLOSSARY.md, docs/threads/,  │
│   docs/meetings/, .context/pending/, and                    │
│   .claude/workspace.json (config the layers below read)     │
│   Created by project-workspace:setup-project-workspace.     │
├─────────────────────────────────────────────────────────────┤
│ Middle layer — structured-state backend                     │
│   plugins/context-notion in THIS repo: generic              │
│   add-action / log-decision / query / update / pending-queue│
│   skills, parameterised by each workspace's state.notion    │
│   (database IDs, property schemas, roster). One install     │
│   serves every Notion-backed project.                       │
├─────────────────────────────────────────────────────────────┤
│ Core layer — THIS PLUGIN                                    │
│   workspace resolver, SessionStart freshness check,         │
│   connection gate, refresh-context, save-thread, doctor     │
└─────────────────────────────────────────────────────────────┘
```

**Which workspace a session is in** is the nearest `.claude/workspace.json` at or above the
working directory (`scripts/workspace.mjs`, and its bash twin `scripts/workspace-root.sh`).
Nearest wins, levels never merge, and the walk does not stop at a member's `.git`. Nothing else
decides it: no folder name, no repo name, no env var. Outside a workspace the skills say there is
none and stop; a folder becomes a workspace through `project-workspace:setup-project-workspace`.

Claude Code already reads `CLAUDE.md` from the working directory and every parent, `@` imports
included, so the workspace's memory reaches every session without this plugin injecting
anything.

**The SessionStart hook only says when the workspace is behind.** `hooks/workspace-freshness.sh`
runs a `git fetch` on the workspace root, capped at `CONTEXT_KIT_FETCH_TIMEOUT` seconds (default
10). If the workspace is behind its upstream, it prints one line saying how far and naming the
`git pull` to run; if the branch has diverged, the line gives both counts. Up to date, ahead
only, no upstream, or not a workspace: it prints nothing. It never pulls. If the fetch fails or
times out, the line says the check could not run.

**Switching the hook off on a whole machine: `CONTEXT_KIT_AUTOLOAD`.** In the `env` block of the
**user-level** `~/.claude/settings.json`:

```json
{ "env": { "CONTEXT_KIT_AUTOLOAD": "off" } }
```

The hook then exits silently at its first line in every project. Any spelling of off works
(`none` / `off` / `false` / `no` / `-` / `disabled`, case-insensitive), and it **fails open**:
unset, empty or unrecognised means on, because silence must be something you asked for and never
something a typo caused. The `PreToolUse` connection gate is unaffected, and `refresh-context`
still pulls.

**`${CLAUDE_PLUGIN_ROOT}` in these commands is not a shell variable.** The plugin loader
substitutes it into skill text and hook commands before they run, per plugin; a terminal knows
nothing of it and expands it to the empty string, turning `node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs"`
into `node /scripts/workspace.mjs`. Pasting one of these into a shell needs the directory named
instead: `bash scripts/plugin-repo.sh --plugin context-kit-core` prints it, resolving the source
checkout rather than the read-only installed copy under `~/.claude/plugins/`.

**Cowork** has no checkout and no shell: upload the workspace's `.claude/workspace.json` to the
Cowork project. The connection gate finds it in the sandbox mount areas, and `context-access`
reads the workspace's own `repo` over the GitHub connector chosen by that repo's owner.

## Skills

| Skill | What it does |
| --- | --- |
| `context-doctor` | Health-check a workspace for the drift that never announces itself; fixes derivable config keys only |
| `context-status` | What is outstanding: curation lag, thread outcomes never logged, the pending queue, native memory — and the skill that clears each |
| `refresh-context` | Pull the workspace mid-session, re-read its memory and thread index, and report what changed |
| `save-thread` | 🔒 Write up the current work as a thread in the workspace's `docs/threads/` and push (never self-triggers) |
| `curate-context` | 🔒 Keep the context lean: promote, condense, archive, rebuild `docs/threads/INDEX.md` |
| `setup-connectors` | Provision the MCP connections a workspace's `workspace.json` declares |
| `memory-triage` | 🔒 Drain Claude's own per-directory memory into the right layer — project, repo or local |
| `context-access` | _(hidden)_ The GitHub-API route sandboxes use, and the rules that stop an API write truncating a file |
| `update-plugin` | Change these plugins themselves — check, bump, and (after asking) push |

### One layer, at the root

There is no layer choice to make. `save-thread` writes to the workspace root's `docs/threads/`
from wherever the session is, member repos included, records the member as `repo: owner/name`,
and regenerates the committed `docs/threads/INDEX.md`. `memory-triage` promotes into
`docs/memory.md`. Both ask before pushing. `curate-context` curates `docs/threads/` from the
root or any member; a member's leftover `.claude/threads/` is named and left alone.

### The connection gate

`connections` used to be enforced by *telling* the model to respect it, and nothing checked. The
only real gate was a `permissions.deny` list hand-written per repo, which enumerates *the others*
— so it is written against the connections that existed the day it was written, and goes stale
silently in the dangerous direction.

`hooks/connection-gate.mjs` (`PreToolUse`, matcher `mcp__.*`) derives the decision instead:

| Situation | Outcome |
| --- | --- |
| server is the project's declared connection for that provider | pass, silently |
| server resembles no provider the project knows | pass, silently |
| server is another project's connector for a declared provider | **deny**, naming the one to use |
| provider not declared, `connections` non-empty | **deny** |
| `connections: {}` (a deliberate "none") | **deny** every provider connector |
| no `connections` key at all | pass — nobody has decided |
| policy unreadable (no workspace, broken JSON) | pass, with the reason on stderr |

The policy is the nearest `.claude/workspace.json`'s `connections`, found by walking up from the
project dir, so a member repo nested in a workspace is gated by the workspace. When the walk-up
finds none, it looks for a `workspace.json` **uploaded to a Cowork project**
(`scripts/cowork-workspace.mjs`: `/mnt/project/`, `~/mnt/.projects/[uuid]/docs/`,
`~/mnt/uploads/`, the Windows host's `.project-cache/[uuid]/docs/`, flat or under `.claude/`, then
a bounded search of the mount areas). With neither, it fails open.

**From an uploaded `workspace.json` the gate is stricter** (ADR 0002, #61), because there the
GitHub API is the only route and every write is an immediate whole-file commit:

| Situation (Cowork) | Outcome |
| --- | --- |
| a github connector other than the one for `repo`'s owner — even another entry of the map | **deny** |
| a path-taking write (`create_or_update_file`, `push_files`, `delete_file`, …) to any repo but `repo` — a member's included | **deny** |
| a write to `repo` outside `docs/threads/`, `docs/meetings/`, `.context/` | **deny**, naming the allowlist |
| a read, anywhere the connector reaches | unaffected |

`docs/memory.md`, `GLOSSARY.md` and `docs/adr/` are curated from a laptop: an API write replaces
the whole file, and a curated file rebuilt from a partial read is truncated without a diff anyone
sees. A laptop session, a workspace found by walking up, is untouched by all three rows.

It **fails open and says why**, because a gate that blocks every MCP call the moment a checkout
is missing is worse than no gate and breaks the hook contract.

A `permissions.deny` list still works and still composes; it is simply no longer the only thing
standing between a session and another project's workspace.

## Retired by ADR 0002

Workspaces replace context repos (`docs/adr/0002-workspace-replaces-context-repo.md` in the
marketplace repo). v1.0.0 removed the features no migrated workspace uses; v2.0.0 (#60) removed
the context-repo route itself, once the last project had migrated. Nothing reads a context
repo any more: a directory holding only a `context.json` is not a workspace.

| Removed | Instead |
| --- | --- |
| `include` (cross-project loads) and the top-level `handoff/` folder | one workspace is the home; the personal layer is imported by the user-level `~/.claude/CLAUDE.md`. triage-notes (context-notes) keeps its own shared-target outbox, at `.context/handoff/` in a workspace (ADR 0002, amended for #83) |
| assistants, roles, supervisors and lessons (`assistant`, `assistant-lesson`, `assistant-contract`, `supervisor-sweep`, `supervisor-distil`, `assistants.mjs`) | nothing — they were never used |
| `teach-workspace` and `teaching-workspace.mjs` | run **`/mattpocock-skills:teach`** in `teaching/[slug]/` inside a workspace — the directory project-workspace's `.gitignore` already keeps |
| `init-context`'s second-brain bootstrap and `assets/second-brain/` | the personal layer is a workspace of its own, migrated by hand |
| the session launchers (`Start-ContextSession.ps1`, `start-context-session.sh`) | open the workspace directory; Claude Code reads its `CLAUDE.md` from there |
| `PROJECT_CONTEXT_REPO`, `PROJECT_CONTEXT_THREADS`, the `context-project.json` / `.context-repo` / `context-repo.txt` markers, `context.json` (#60) | the nearest `.claude/workspace.json`; its `connections` and `state.*` carry what `context.json` did |
| the full session-start loader (`hooks/load-context.sh`, its STALE banner and `--refresh`) (#60) | Claude Code's own `CLAUDE.md` loading; `hooks/workspace-freshness.sh` warns when the workspace is behind; `refresh-context` pulls and re-reads |
| `scripts/context-repo.sh`, the managed clone root `~/.context` and the context-repo fallback in `workspace.mjs` / `workspace-root.sh` (#60) | the workspace checkout itself; `~/.context` was archived and deleted on 2026-10-25 |
| `init-context` and `init-context.mjs` (#60) | `project-workspace:setup-project-workspace` |
| `context-setup` and `link-context.mjs` (#60) | `project-workspace:setup-project-workspace` for the workspace, `setup-connectors` for its connections, `context-doctor` for diagnosis |
| the `c-energie/context-template` template repo (archived 2026-10-25) | nothing to stamp: `project-workspace:setup-project-workspace` writes a workspace's files |

## Roadmap

A project must never enable two plugins whose hooks both load context — the context loads
twice.

## Working on this repo

No build: `node scripts/check-plugin.mjs .` is CI, run it before any commit. The tests are
`node --test` files beside the scripts and hooks they cover (see `CLAUDE.md` for the list),
stdlib only, no network. Bump `.claude-plugin/plugin.json` via
`node scripts/bump-version.mjs . patch|minor|major`; version lives there **only** (a version in
`marketplace.json`'s `plugins[]` overrides it silently). `*.sh` stay LF. No angle brackets in
any YAML front-matter value. The hooks must exit 0 on every path.
