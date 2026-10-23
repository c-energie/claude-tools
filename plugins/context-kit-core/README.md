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

**"env var first" is not "your shell first."** Claude Code applies a settings file's `env` block
to the environment every hook and tool then runs in, so by the time the resolver reads
`PROJECT_CONTEXT_REPO` the *settings* value is already sitting in it. In a project that
configures its repo through `.claude/settings.json` — which is most of them — running
`PROJECT_CONTEXT_REPO=none claude` from the shell therefore changes nothing, and changes it
**silently**: the session loads the full context exactly as if the variable had not been set.
Measured 2026-08-31 in `corson94/second-brain`: the shell form still produced the hook's whole
116,365-byte payload.

To override for one invocation, put the value in a settings file passed on the command line —
`--settings` wins over the project's own:

```bash
echo '{ "env": { "PROJECT_CONTEXT_REPO": "none" } }' > ~/.claude/no-context.json
claude --settings ~/.claude/no-context.json      # hook takes its opt-out path, emits nothing
```

Pass a **file**, not an inline `--settings '{...}'` JSON string: PowerShell strips the quotes
before `claude` sees them and the run dies with `Invalid JSON provided to --settings`. Note this
suppresses the context repo only — CLAUDE.md files still load. `claude --bare` skips those too,
along with every hook, but it never reads OAuth or the keychain, so it needs `ANTHROPIC_API_KEY`.

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

**Opting the whole MACHINE out: `CONTEXT_KIT_AUTOLOAD`.** Everything above answers *which repo*.
This answers whether this machine loads context automatically at all — a gate that sits above the
ladder rather than a rung in it. In the `env` block of the **user-level** `~/.claude/settings.json`:

```json
{ "env": { "CONTEXT_KIT_AUTOLOAD": "off" } }
```

`hooks/load-context.sh` then exits silently at its first line in **every** project on the machine:
no payload, no banner, no marker search, and no "unconfigured" warning either. Same vocabulary of
off as everywhere else (`none` / `off` / `false` / `no` / `-` / `disabled`, case-insensitive), and
it **fails open** — unset, empty or unrecognised means on, i.e. today's behaviour exactly, because
silence must be something you asked for and never something a typo caused.

It is for the cases the per-project ladder has no clean answer to: many sessions in directories
that are not context-governed projects, wanting the (not small) payload on demand only, and
debugging the plugin itself without editing a plugin file.

- **Off means off.** A project that explicitly names a repo does not load. A project may be *more*
  restrictive than the machine, never less: a project's `none` still wins over a global on, and
  nothing overrides a global off. To get context in one project on an off machine, flip the flag or
  run `refresh-context`.
- **`refresh-context` still loads** (`load-context.sh --refresh`) — the flag governs the automatic
  path, and going quiet on an explicit request would be the kind of silent lie this hook avoids.
  Deliberately unlike the project-level `none`, which answers `--refresh` with "nothing to
  refresh": there is no repo there, whereas here there is one and it is merely not automatic.
- **The `PreToolUse` connection gate is unaffected** — it resolves `connections` itself and must not
  be switchable off by a convenience setting.
- **Never do this with a user-level `PROJECT_CONTEXT_REPO: "none"` instead.** Both resolvers read
  that variable first and return immediately, so a user-level value beats every project's settings
  file and every marker on the machine, and disables the connection gate's policy lookup along with
  it. `docs/context-root.md` in the marketplace repo has the long form.

**`${CLAUDE_PLUGIN_ROOT}` in these commands is not a shell variable.** The plugin loader
substitutes it into skill text and hook commands before they run, per plugin; a terminal knows
nothing of it and expands it to the empty string, turning the line above into
`node /scripts/link-context.mjs`. Pasting one of these into a shell needs the directory named
instead — `bash scripts/plugin-repo.sh --plugin context-kit-core` prints it, resolving the
source checkout rather than the read-only installed copy under `~/.claude/plugins/`.

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
owner, so a project spanning two owners declares two connections as an owner-keyed map —
`setup-connectors.mjs --add github:[owner]`). Which of several connections a project may use is
declared in its `context.json` `connections` block — the gate `context-setup` verifies. Two platform quirks the hook
absorbs: project files can mount *after* SessionStart fires (the hook retries ~10s, and
the payload instructs the first response to recover regardless), and sandbox filesystem
layouts vary (marker candidates cover all known ones, with a bounded find as backstop).

## Skills

| Skill | What it does |
| --- | --- |
| `init-context` | Stamp a NEW context repo from `c-energie/context-template` — and, on the first run, the cross-project second brain (asks before creating anything) |
| `context-setup` | First-run wiring and diagnosis: how this project names its repo, is it reachable, load it now |
| `context-doctor` | Health-check an already-linked repo for the drift that never announces itself; fixes derivable config keys only |
| `context-status` | What is outstanding: lessons awaiting a sweep, sweeps awaiting distillation, undrained handoff, curation lag, native memory — and the skill that clears each |
| `refresh-context` | Re-pull the project's context repo mid-session and report what changed |
| `save-thread` | 🔒 Write up the current work as a thread — a workspace's `docs/threads/`, else `threads/` — and push (never self-triggers) |
| `curate-context` | 🔒 Keep the repo lean: promote, condense, archive, rebuild `threads/INDEX.md` |
| `setup-connectors` | Provision the MCP connections a project's `context.json` declares |
| `assistant` | Adopt a role assistant — its persona, memory, doctrine and thread history; scaffolds one on first use |
| `assistant-lesson` | 🔒 Record a transferable lesson into `LESSONS.md`, abstracted at write time |
| `supervisor-sweep` | 🔒 Distil role lessons across every included project into a supervisor thread |
| `supervisor-distil` | 🔒 Promote supervisor threads into durable doctrine and queue it to each project |
| `teach-workspace` | 🔒 List the teaching workspaces a context repo declares, and prepare a new one for `teach` to work in (never self-triggers) |
| `memory-triage` | 🔒 Drain Claude's own per-directory memory into the right layer — personal, project, role or local |
| `assistant-contract` | _(hidden)_ The four-file contract behind role assistants, and why each rule exists |
| `context-access` | _(hidden)_ The GitHub-API route sandboxes use, and the rules that stop an API write truncating a file |
| `update-plugin` | Change these plugins themselves — check, bump, and (after asking) push |

The SessionStart hook loads `memory.md` + thread pointers automatically, with a STALE banner
when the refresh fails — a silently stale context is the one failure mode that actively
misleads. A project that will never have a context repo opts out with `none`, and a whole machine
opts out of the automatic load with `CONTEXT_KIT_AUTOLOAD`; see above.

### What is loaded eagerly, and what is announced

`memory.md` is **injected** every session, at both the project and repo layer: it is the
authoritative durable layer, and a missing authoritative fact produces a confidently wrong
answer with nothing to signal the gap.

Everything deeper is **announced rather than loaded** — threads by title, the `notion/` mirror
by pointer, and `Archive/history.md` by its section headings. `curate-context` has always
described that file as "read on demand, NOT injected each session", but nothing used to tell a
session it existed, so condensing anything out of `memory.md` made it invisible. That made the
safe move always to leave `memory.md` long, which is how a durable layer reaches 292 lines and
92% of a payload. The headings cost about 3% of the file they stand for, and they are what makes
curation lossless from a session's point of view.

Lazy-loading `memory.md` itself is deliberately **not** done. Threads can be lazy because
missing one loses depth; authoritative facts cannot, because a topic index fails exactly when a
question is phrased in a way it did not anticipate, and fails silently.

### Inside a workspace: one layer, at the root

In a workspace (the nearest `.claude/workspace.json`, ADR 0002) there is no layer choice to make.
`save-thread` writes to the workspace root's `docs/threads/` from wherever the session is,
member repos included, records the member as `repo: owner/name`, and regenerates the committed
`docs/threads/INDEX.md`. `memory-triage` promotes into `docs/memory.md`. Both ask before
pushing. Everything below describes the context-repo route, which still applies outside a
workspace until the last context repo is migrated.

### Two thread layers

A **project's** threads live in its context repo: decisions about the product, the research or
the direction. A **repo's own** threads live in `.claude/threads/` inside that repo: how this
codebase works and what was tried in it. The session-start hook lists both, under separate
headings, and skips the second when the working directory *is* the context repo.

The audience decides which layer, not the subject. A repo's threads travel with a clone of that
repo, so they reach someone who does not have the context repo at all, which is the reason the
layer exists rather than being a tag in the project's `threads/`.

Each layer mirrors the other:

| | project | repo |
| --- | --- | --- |
| working notes | `threads/` | `.claude/threads/` |
| durable layer | `memory.md` | `.claude/memory.md` |
| settled work | `Archive/threads/` | `.claude/Archive/threads/` |

Both durable layers are **injected** by the hook rather than pointed at, so neither depends on
the model choosing to follow a link. `.claude/memory.md` is the promotion target rather than
`CLAUDE.md`, which stays instructions for working in the repo rather than becoming a changelog.

#### Turning the repo layer off: `PROJECT_CONTEXT_THREADS`

The property that makes the repo layer valuable — a thread travels with a clone — is the same
property that makes it wrong for a repo **shared as a tool** rather than worked on as a project.
There, `.claude/threads/` ships one person's dated working notes to everyone who installs the
thing. Same mechanism, opposite verdict, and no amount of reading a thread reveals which case it
is: distribution is a fact about the repo, not about its contents. So it is configured, not
judged.

`PROJECT_CONTEXT_THREADS` takes `repo` (always `.claude/threads/`), `context` (always the context
repo's `threads/`), or nothing at all — the default `auto`, where `save-thread` picks by audience
as above. It resolves on the same ladder as the repo name, and for the same reason: env, then
`.claude/settings*.json`, then a `"threads"` key in a `context-project.json` marker, because a
laptop can set an env block and a sandbox can only be handed a file. The one-line marker forms
(`.context-repo`, `context-repo.txt`) cannot carry it — they are one line by definition.

```bash
bash scripts/context-repo.sh --threads                        # repo | context | auto
node scripts/link-context.mjs owner/repo --threads context     # set it; `auto` clears the key
```

Two things follow from it being a *routing* flag rather than a second destination. It never names
a repo: threads go to the context repo already resolved for the project, so there is only ever one
answer to "which repo does this project use" and no second channel to disagree with the first.
And `context` with a context repo of `none` is a **contradiction** — routed somewhere that does
not exist — which `save-thread` reports and refuses rather than quietly falling back into the
shared repo, the one outcome the flag was set to prevent.

The flag covers **threads only**. `.claude/memory.md` keeps working in a shared repo, deliberately:
a promoted, durable account of how a codebase works is exactly what someone cloning the tool
should read first, where a dated session narrative is not.

**`curate-context` curates exactly one layer: whichever the session is standing in.** A sweep
across a project's code repos was considered and rejected. The context repo does not know which
code repos belong to it, since the link runs child to parent only; there is no way to resolve a
code repo's name to a checkout on an arbitrary machine; and judging whether a thread has settled
needs the code in front of you.

### The cross-project layer: `include`

A context repo may declare, in its `context.json`:

```json
"include": ["owner/repo-a", "owner/repo-b"]
```

Sessions on that repo then also load each included repo's `memory.md` in full, plus **pointers**
to its `glossary.md` (the term names, not the definitions) and its `threads/` (the six newest,
by title) — **read-only**, after the repo's own context, each pulled under the same
ff-only/timeout/credential rules with its own per-repo STALE or UNAVAILABLE banner.
`refresh-context` re-pulls them too. The contract, all load-bearing:

- **Explicit list only.** The loaded set is committed config, never discovered from the
  filesystem — an *accidental* cross-project load is the failure mode this plugin exists to
  prevent, so the deliberate one must be spelled out.
- **One level.** An included repo's own `include` list is ignored.
- **Pointers, not the whole repo.** `memory.md` is loaded entire, because a fact nobody is told
  about is not lazy, it is lost. A glossary and a thread index are different in kind — each is a
  *list of names*, so the names alone say what is in there, which is all a pointer has to do to
  be safe. Included context is then loaded no more eagerly than the repo the session is actually
  in, whose own glossary and threads have always been pointers. A glossary under `SMALL_GLOSSARY`
  bytes (default 4096) is loaded whole instead: below that the pointer costs more than the file.
- **Read-only.** Nothing in a combined session writes into an included repo — not git, not
  its structured-state backend, not its `pending/`. A combined repo that wants to route
  items outward keeps its own outbox folder (by convention `handoff/`, which the payload
  mentions when present).
- **Route-agnostic.** Entries are `owner/repo` names only; nothing in the schema assumes a
  local clone, so a sandbox route reading repos over the GitHub API can honour the same list.
- Parsing the array needs `node`; without it the payload says loudly that the includes were
  skipped rather than quietly omitting them.

### Creating the repos in the first place — `init-context`

`scripts/init-context.mjs` stamps `c-energie/context-template` into a real repo, clones it to
`~/.context/[owner]/[repo]` where the resolver looks, fills the template placeholders, applies
the derivable `context-doctor` fixes, and pushes. **Nothing reaches the network without
`--yes`:** the default run is a plan, and the skill asks before passing it.

The **first** stamp on an account also bootstraps the cross-project **second brain** at
`~/.context/[login]/second-brain` — the same template plus `assets/second-brain/`, the overlay
that makes a context repo the layer *above* the projects (an `include` list, a `handoff/`
outbox, the read-only contract in its `CLAUDE.md`). Three properties are load-bearing:

- **Owned by the authenticated user, not the project's owner.** A project context repo often
  lives under an org; a personal layer governed by one project's org is the wrong shape, and
  invisible to the next project's owner.
- **Stamped once, then adopted.** An existing repo — on GitHub or already cloned — is taken as
  it is, never re-stamped. Re-running for a second project is safe by construction.
- **The `include` list starts empty and is never written for you.** The script prints the exact
  edit and stops: an *accidental* cross-project load is the failure mode the include contract
  exists to prevent, so every entry is a deliberate, committed act.

### The connection gate

`connections` used to be enforced by *telling* the model to respect it: the session payload says
"use only what it declares", and nothing checked. The only real gate was a `permissions.deny` list
hand-written per repo, which enumerates *the others* — so it is written against the connections
that existed the day it was written, and goes stale silently in the dangerous direction.

`hooks/connection-gate.mjs` (`PreToolUse`, matcher `mcp__.*`) derives the decision instead:

| Situation | Outcome |
| --- | --- |
| server is the project's declared connection for that provider | pass, silently |
| server resembles no provider the project knows | pass, silently |
| server is another project's connector for a declared provider | **deny**, naming the one to use |
| provider not declared, `connections` non-empty | **deny** |
| `connections: {}` (a deliberate "none") | **deny** every provider connector |
| no `connections` key at all | pass — nobody has decided |
| policy unreadable (no repo, no clone, broken JSON) | pass, with the reason on stderr |

Two properties are load-bearing. It **fails open and says why**, because a gate that blocks every
MCP call the moment a checkout is missing is worse than no gate and breaks the hook contract. And
it reads `context.json` *or* the `.claude/context-project.json` marker, whose `connections` the
session-start hook already mirrors — which is what makes it the only mechanism that reaches
**Cowork**, where there is no checkout and so no `.claude/settings.json` to carry permissions.

A `permissions.deny` list still works and still composes; it is simply no longer the only thing
standing between a session and another project's workspace.

## Roadmap

A project must never enable two plugins whose hooks both load context — the context loads
twice.

## Working on this repo

No build: `node scripts/check-plugin.mjs .` is CI, run it before any commit. The one test file
covers the autoload gate — `node --test hooks/load-context.test.mjs`, stdlib only, no network. Bump
`.claude-plugin/plugin.json` via `node scripts/bump-version.mjs . patch|minor|major` — version
lives there **only** (a version in `marketplace.json`'s `plugins[]` overrides it silently).
`*.sh` stay LF. No angle brackets in any YAML front-matter value. The hook must exit 0 on
every path. `hooks/load-context.sh` carries an inline duplicate of `context-repo.sh` for
installs where packaging drops `scripts/` — change both or neither.
