# CLAUDE.md

## What this repo is

The **core layer** context plugin (`context-kit`), shipped from its own marketplace in
`c-energie/claude-tools`. Generic machinery only: it loads/refreshes/writes *a* project's
context repo, selected per project by `PROJECT_CONTEXT_REPO`, settings files, or a marker — with no default: unconfigured projects say so, and `none` opts a project out silently.
Anything project- or workspace-specific belongs in a higher layer: the planned Notion
middle-layer plugin, or the project's own context repo (created from
`c-energie/context-template`). See README.md for the three-layer picture and port status.

A fix to the resolver or hook belongs in all three plugins' copies (see the marketplace CLAUDE.md);
`check-plugin.mjs` now errors if a copy drifts from its original.

## Commands

```bash
node scripts/check-plugin.mjs .          # lint manifests/skills/hooks; exit 1 on error — run before any commit
node --test hooks/load-context.test.mjs  # the autoload gate; stdlib only, no network, no clone
node --test hooks/workspace-freshness.test.mjs  # the hook inside a workspace; local bare repos, no network
node scripts/bump-version.mjs . patch    # major|minor|patch; writes plugin.json only
node --test scripts/workspace.test.mjs   # the workspace resolver and its bash twin; stdlib only, no network
node --test hooks/connection-gate.test.mjs   # the connection gate + setup-connectors' workspace write; no network
node --test scripts/cowork-workspace.test.mjs   # the uploaded-workspace search + Cowork write allowlist; fake HOME and /mnt
node scripts/cowork-workspace.mjs        # the workspace.json uploaded to a Cowork sandbox, or why not (--json)
node scripts/workspace.mjs --no-pull     # the nearest .claude/workspace.json's root, else the context repo (--json)
bash scripts/workspace-root.sh --no-pull # the same, in bash, for hooks
bash scripts/workspace-root.sh --no-fallback  # the workspace route only — never runs context-repo.sh
node scripts/thread-target.mjs           # where save-thread writes: docs/threads/ in a workspace (+ member repo), else context-repo
node --test scripts/thread-target.test.mjs scripts/memory-triage.test.mjs   # workspace thread/memory targets; offline
bash scripts/context-repo.sh --no-pull   # resolve the (env-selected) context checkout
bash scripts/context-repo.sh --threads   # where this project's working notes go: repo|context|auto
bash hooks/load-context.sh --refresh     # exactly what refresh-context runs, against $PWD
bash scripts/plugin-repo.sh --writable   # resolve THIS repo's checkout (root), push-ready
bash scripts/plugin-repo.sh --plugin context-kit-core   # ...or one plugin's own directory
node scripts/list-plugins.mjs "$ROOT" --brief   # the plugin roster, read from the checkout — never hand-written
node scripts/list-plugins.mjs "$ROOT"           # ...plus each plugin's skills (--json)
node scripts/dates.mjs today
node scripts/json-block.mjs entries "$CTX/context.json"                # the top-level keys, in file order
node scripts/json-block.mjs set "$CTX/context.json" connections '{...}'   # PLAN one block; --write applies it
node scripts/init-context.mjs owner/repo            # PLAN a new context repo; --yes does it
node scripts/link-context.mjs owner/repo --load   # run from a PROJECT dir: link it to its context repo
node scripts/link-context.mjs owner/repo --threads context   # ...and route its threads off this repo
node scripts/context-doctor.mjs "$ROOT"           # health-check a workspace or context repo (--json, --fix, --today)
node scripts/context-status.mjs "$ROOT"           # what is OUTSTANDING in every queue (--json, --no-memory)
node --test scripts/context-doctor.test.mjs   # doctor + status in a workspace, and legacy unchanged; fake gh, offline
node scripts/memory-triage.mjs scan "$ROOT"        # native memory awaiting promotion (workspace root -> docs/memory.md)
```

## Invariants (all load-bearing)

- **Version lives in `plugin.json` only** — a `version` in a `marketplace.json` `plugins[]`
  entry silently overrides it.
- **No angle brackets in any YAML front-matter value** — the skill ingester drops the field.
- **`none` (also `off`/`false`/`no`/`-`) wherever the repo name is configured is the opt-out**
  — the hook exits 0 with no output and no marker search, and the resolvers exit 1 saying so.
  Keep the sentinel list in step across `hooks/load-context.sh`, both `context-repo.sh`
  copies and `link-context.mjs`. Never conflate it with *unconfigured*, which must stay loud.
- **`CONTEXT_KIT_AUTOLOAD` is a machine-wide KILL SWITCH, not a default.** Any spelling of off
  (`is_optout()`, so `none`/`off`/`false`/`no`/`-`/`disabled`) in the `env` block of the
  **user-level** `~/.claude/settings.json`, and `hooks/load-context.sh` exits silently at its
  first line in **every** project — including one that explicitly names a repo, and including
  the loud "unconfigured" payload. Four things are load-bearing. It is a **hard gate placed
  first**, before `lookup_repo()`, the marker search and the sandbox retry's ~10s wait, so off
  costs one string comparison. **Local can only veto**: a project's `none` still beats a global
  on, and nothing project-level overrides a global off — the soft reading ("off by default, opt
  in per project") was considered and rejected, because it makes off mean "nothing loads unless
  something asked". **`--refresh` is exempt** and still loads, unlike the project-level opt-out
  which answers `--refresh` with "nothing to refresh" — `none` means there is no repo, off means
  not automatically. And it **fails open**: unset, empty or unrecognised is today's behaviour
  exactly, because silence must be asked for and never caused by a typo. Never implement this as
  a user-level `PROJECT_CONTEXT_REPO` — that is read first and returned from, so it would beat
  every project's settings and marker on the machine and take `connection-gate.mjs`'s policy
  lookup with it. The gate itself is deliberately untouched by the flag, and the flag must never
  grow a marker-file or sandbox route: in a sandbox the loader is what mirrors `connections`
  into the marker the gate falls back to.
- **The resolver's "env var first" does NOT mean "the invoking shell first."** Claude Code applies
  a settings file's `env` block to the environment hooks and tools run in, so the settings value
  is already *in* `PROJECT_CONTEXT_REPO` before the resolver looks. A project that configures its
  repo in `.claude/settings.json` has therefore pinned the variable, and `PROJECT_CONTEXT_REPO=none
  claude` from the shell is overwritten with no warning — it fails in exactly the projects someone
  would reach for it in. The per-invocation override is a settings file on the command line
  (`claude --settings [file]`), whose `env` beats the project's; a file rather than inline JSON
  because PowerShell strips the quotes off `--settings '{...}'`. Do not "fix" this by having the
  resolver prefer some other channel: the ladder is correct, and the environment is genuinely the
  highest-precedence *channel* — what is counter-intuitive is who last wrote to it.
- **Inside a workspace the session-start hook LOADS NOTHING; it only says when the workspace is
  behind.** Claude Code already reads `CLAUDE.md` from the cwd and every parent (with `@`
  imports), so printing memory and glossary as well would load them twice. What it cannot say is
  that the checkout is behind its origin, so the hook runs a `git fetch` capped at
  `CONTEXT_KIT_FETCH_TIMEOUT` seconds (default 10), and prints one line, to the user and to the
  model alike, when the workspace is behind or has diverged. It prints **nothing** when up to
  date, ahead only, or there is no upstream. It **never pulls**: a fetch moves remote-tracking refs
  only, and the line names the command. If the fetch fails or times out, it prints one line
  saying the check could not run. The cap is a background watcher, not `timeout`, which stock
  macOS lacks. "Is this a workspace" is `workspace-root.sh --no-fallback`. Without that flag the
  question is answered by `context-repo.sh`, which may clone just to say no. A malformed
  `workspace.json` therefore falls through to the legacy loader, as the resolver does, and so do
  `--refresh` and every session outside a workspace, unchanged until the fallback is deleted. The
  kill switch above is checked first and silences this too.
- **The hook never prompts, never hangs, never exits non-zero.** Unknown args are ignored.
  Failed refreshes serve the local copy under a STALE banner naming the reason — a silent
  stale load is the one failure mode that actively misleads.
- **`hooks/load-context.sh` carries an inline duplicate of `context-repo.sh`** (packaging may
  drop `scripts/`). Keep the two in step; `context-repo.sh` is the real one.
- **Never spawn bare `bash` from a `.mjs`** — always `bashBin()` from `scripts/bash-bin.mjs`
  (copied to all three plugins). On Windows the `bash` on PATH is WSL's `System32\bash.exe`:
  a real executable, so `spawnSync` reports no `error`, but it has its own filesystem and
  `$HOME`, so it exits 127 on a Windows path and could never see the clone the resolver
  prints back anyway. A caller checking only `status` then blames the *context repo* for a
  bash problem — which is exactly what `link-context.mjs` did, refusing to write a setting
  that was correct. `bashBin()` returning null means no Git Bash: a state to report, not an
  error to swallow.
- **`PROJECT_CONTEXT_THREADS` routes threads; it never names a repo.** `repo` / `context` /
  absent (`auto`), on the same env → settings → JSON-marker ladder as the repo name, resolved by
  `context-repo.sh --threads` and inlined in the hook. It exists for repos SHARED as tools, where
  `.claude/threads/` would ship one person's working notes to everyone who clones them — a fact
  about distribution that no thread's *content* reveals, which is why it is configured rather
  than judged. Two consequences are load-bearing: threads go to the context repo already
  resolved, so no second channel can disagree about which repo a project uses; and `context`
  with a repo of `none` is a **contradiction** that `save-thread` must report and refuse, never
  fall back from into the shared repo. Covers threads only — `.claude/memory.md` is untouched,
  because a durable account of how a codebase works *should* travel with a clone of it.
- **A thread's `audience:` is AUTHORED, and absent is not a value.** `working` / `team` /
  `external`, in that order of reach, declared in the thread's own front-matter and rendered by
  `thread-index.mjs` as an optional index column. It answers the one thing a later reader cannot
  infer — every thread is written to the same house style whether or not anyone but its author
  will want it. Two rules keep it honest: it is **never** supplied through `--gists`, because
  `status` and `gist` are judgements *about* a thread while audience is a property *of* one, and
  a second place to answer it would disagree the first time a thread was edited; and **absent
  renders nothing rather than defaulting to `working`**, since defaulting would silently
  classify every thread written before the field existed. An unrecognised value is rendered as
  written and reported, never corrected — a typo the author can see costs seconds, one this
  swallowed would leave the thread unclassified forever with no way to learn why.
- **A thread's outcome link is absent / empty / present, and all three mean different things.**
  `notion_ids` (decision-log route) or `issue_ids` (tracker route) in a thread's front-matter:
  **absent** = nobody has considered whether this thread's decisions were logged; **`[]`** =
  considered, and there was nothing to log; **non-empty** = it landed, and here is where.
  `context-status`'s `THREAD OUTCOMES NEVER LOGGED` queue counts only the absent case, and only
  for threads carrying a Decisions / Actions / Open questions / Next step heading, in
  `threads/` and never `Archive/threads/`. The empty form is what makes the queue *drainable* —
  without it the count has a floor no amount of work can lift, and a number that cannot reach
  zero stops being read. Core names both keys rather than reading the backend config: it owns
  whether the author answered, not what a Notion id means.
- **The generated marker lives in the CONTEXT repo's `.claude/context-project.json`** — one
  canonical, committable file per context repo, never a generated copy in each project that
  uses it. The hook merges into whatever is there (unknown keys survive) and writes only on a
  real change. Marker *lookup* still reads the legacy project-root locations.
- **Tokens reach git via the environment plus a transient `-c credential.helper` only** —
  never the remote URL, `.git/config`, or a command line. Retry only on auth failures, never
  on timeouts.
- **Skills that write outside the session must not self-trigger**: `disable-model-invocation:
  true` or an explicit ask-before-push gate.
- **`update-plugin` is the route for changing these plugins** — it resolves the writable
  checkout, checks and bumps **per plugin directory**, and asks before every push.
- **Edit the source checkout, not the installed copy** — `${CLAUDE_PLUGIN_ROOT}` points at
  `~/.claude/plugins/…`, which has no push remote and is overwritten on update. Resolve with
  `scripts/plugin-repo.sh --writable` (managed clone: `~/c-energie/claude-tools`). Same
  `[owner]/[repo]` mirror of GitHub the context repos use, but rooted at `$HOME` rather than at
  `~/.context` — that root is the managed clone root for **context** repos, the data, and this is
  a tool. A tool sitting in the data root made the path say nothing about which kind of thing a
  directory held. Moving it out (2026-08-31) does not retire the content tests that decide what a
  directory *is*; it stops the layout suggesting the wrong answer. Every earlier path is still
  resolved and used where it sits — re-cloning beside an existing checkout is how one of them
  silently goes stale.
- **One registry per surface, and they are not the same file.** `claude_desktop_config.json` is
  the **host** registry — the desktop chat app and **Cowork** both read it, because a Cowork
  sandbox does not run these servers: the host runs them and bridges them in, which is the whole
  reason the token never enters the sandbox. `~/.claude.json`'s top-level `mcpServers` is
  **Claude Code's user scope**, a different thing that only looks the same: a server there loads
  in *every* Claude Code session on the machine whatever the project declares, so a laptop with
  seven connectors made every one of its project directories pay for all seven. So
  `configPaths()` in `scripts/mcp/secret-store.mjs` writes the host config **only**, and Claude
  Code is given each server per repo (`claude mcp add-json … -s local`, or a committed
  `.mcp.json`). `detectConfigPaths()` still *reads* the user scope — a machine part-way through
  the move has servers there, and calling a working connection missing would send someone to
  mint a second credential. `setup-connectors.mjs` reports the gap between the two and prints
  the command that closes it; it must never close it by writing user scope.
- **`connections` is ENFORCED, not merely announced.** `hooks/connection-gate.mjs` runs
  `PreToolUse` on every `mcp__*` call and denies any connector the project's `connections`
  does not declare for that provider. **A provider may declare more than one** — as a map of
  resource owner to connection name, `{ "github": { "acme": "github-acme", "acme-labs": "…" } }`
  — because a fine-grained GitHub PAT has a single resource owner, so a project spanning two
  owners needs two tokens and therefore two connectors. The allowlist is a set of N, not a
  weaker rule: everything outside it is still denied and it still has exactly one author. The
  owner key is load-bearing rather than decorative — it says which connector reaches which
  repositories, so a caller chooses deterministically instead of discovering it as a 404 that
  reads like "no such repo". A plain string stays valid and means what it always did; a bare
  array is accepted but says nothing about which is which, so `context-doctor` nudges it to a
  map. `names()` in the gate and in `setup-connectors.mjs` must stay in step, and the gate's
  copy must be **total** — it sits in front of a fail-open catch, so a throw there would allow
  every MCP call on the machine rather than deny one. The policy is *derived* from the
  nearest `.claude/workspace.json` (`findWorkspace()` only — never `resolveWorkspace()`, whose
  fallback can pull or clone), then from a `workspace.json` uploaded to a Cowork sandbox (see the
  next invariant), and only when there is neither from `context.json` (falling back to the
  marker's mirrored copy) — never a hand-written deny
  list, which enumerates the others and is stale the day a connection is added. It **fails open and says so on stderr** when the policy cannot be
  read: a gate that blocked every MCP call on a missing checkout would be worse than none.
  `connections: {}` denies every provider connector; an absent `connections` key denies
  nothing — the same absent-versus-empty distinction drawn everywhere else. A workspace that is
  found is the whole answer: its absent `connections` does not fall through to a context.json or
  marker. A malformed nearest `workspace.json` goes to the legacy route, as the resolver does,
  and the gate fails open naming it if that finds nothing; `setup-connectors` instead **refuses**
  it, since a writer that fell back would edit a policy the directory no longer uses. In a
  workspace `setup-connectors` writes only the top-level `connections` key, through
  `json-block.mjs`'s `upsertBlockInFile()`, and names connections from `name` with `repo`'s owner
  as the default owner key.
- **In Cowork the workspace is an UPLOADED `workspace.json`, and the gate narrows** (ADR 0002,
  #61). `scripts/cowork-workspace.mjs`'s `findUploadedWorkspace()` is asked **only when the
  walk-up found nothing** (a malformed nearest file still goes to the legacy route): the marker
  search's layouts — `/mnt/project/`, `~/mnt/.projects/*/docs/`, `~/mnt/uploads/`,
  `[project]/../../.project-cache/*/docs/` — each for `workspace.json` and
  `.claude/workspace.json`, then a bounded search (depth ≤5, an entry budget, no symlinks, no
  WSL drive mounts) of the mount areas only, **never the working tree**. A candidate counts only
  with a `"repo": "owner/name"` — `workspace.json` is also Nx's file name — and a refused one is
  reported and skipped, not stopped at. It is core-only and deliberately **not** in
  `findWorkspace()`, which four other plugins copy and every laptop resolver uses. From such a
  file, two rules apply that a laptop never sees: the github connector is the one keyed by
  `repo`'s owner (other map entries are denied), and any path-taking GitHub tool that is not a
  `get_`/`list_`/`search_`-style read must target `repo` itself — never a `members[].repo` — with
  every path under `COWORK_WRITE_ALLOWLIST` (`docs/threads/`, `docs/meetings/`, `.context/`),
  normalised, `..` refused. Curated files (`docs/memory.md`, `GLOSSARY.md`, `docs/adr/`) are
  read-only from Cowork because an API write replaces the whole file. Writes are classified by a
  **read**-list, so a server's next writing tool is gated on arrival. `context-access` states the
  same list and adds what the gate cannot do: the upload only bootstraps `repo` and the
  connector, and the `.claude/workspace.json` re-read from `repo` over the API wins for the rest.
- **A workspace is the nearest `.claude/workspace.json`, and nothing else decides it** (ADR
  0002). `scripts/workspace.mjs` walks from the working dir to the filesystem root and returns
  the first directory holding one: nearest wins, levels never merge, and the walk does **not**
  stop at a `.git` — members are nested clones, and stopping at the member's `.git` is how the
  old resolver cloned a second copy of a context already on disk above it. Folder and repo names
  are never consulted. A malformed nearest file is reported (path + parse error) and the walk
  **stops** for the fallback rather than skipping on to an outer workspace, which would load the
  wrong context over a typo. With no workspace it falls back to `context-repo.sh` unchanged, and
  stderr always names the route (`route=workspace` / `route=context-repo`) — the fallback goes
  when the last context repo is migrated. The resolver validates only "a JSON object": each
  top-level key has one writing owner (`schema`/`name`/`repo`/`members` — project-workspace;
  `connections` — setup-connectors; each `state.*` — the plugin reading it), member entries
  carry kind-specific fields only project-workspace defines, and every writer preserves keys it
  does not know at both levels. `scripts/workspace-root.sh` is its bash **twin** for hooks, not a
  copy — `workspace.test.mjs` runs both against the same fixtures. Change both, or neither.
- **Inside a workspace, threads and memory have ONE home: the workspace root** (ADR 0002,
  #51). `save-thread` writes `docs/threads/YYYY-MM-DD-topic.md` and regenerates the committed
  `docs/threads/INDEX.md` (`thread-index.mjs --dir docs/threads`), so the workspace's `CLAUDE.md`
  can point at one file; `memory-triage` promotes into `docs/memory.md`, the file `CLAUDE.md`
  imports. From a member that is still the workspace root — never the member's
  `.claude/threads/` or `.claude/memory.md`, the second home the ADR retires — and no routing
  question is asked: `PROJECT_CONTEXT_THREADS` is not consulted in a workspace at all. The
  member is recorded instead, as `repo: owner/name` front-matter, decided by
  `scripts/thread-target.mjs` (declared `members[]` entry first, then a nested clone's origin;
  null for the workspace's own repo) — a script, because two sessions in one directory must
  record the same provenance. It finds the workspace with `workspace.mjs`'s `findWorkspace()`
  rather than a walk of its own, so a thread can never be routed to a different home from the
  context the session loaded. Both skills ask before pushing; outside a workspace both behave as
  before.
- **`context-doctor` and `context-status` take either kind of root, told apart by
  `workspace.mjs`'s `rootKind()`** (#52): a directory holding `context.json` and no
  `workspace.json` is a legacy context repo, checked exactly as before and tested FIRST so an
  outer workspace never judges it; anything else is the nearest workspace. In a workspace the
  checks for keys it retired (template, the marker) do not run, and the same rules apply at ADR
  0002's paths — `docs/memory.md` (and its `@` import in `CLAUDE.md`), `docs/threads/`,
  `.context/pending/`.
  `--fix` **never writes `workspace.json`**: the doctor owns no key in it. The doctor's one
  network call is `gh repo view` for visibility, made only when `docs/meetings/` or
  `.context/pending/` exists, warning when the workspace repo is PUBLIC; a failed lookup is a
  note saying it was not checked, never a pass. `--json` carries `mode` and `workspace`.
- **`memory-triage.mjs` reads ONE native memory store: the session's own working directory's.**
  There is no mode that reads every store on the machine. That mode was keyed on the cross-project
  layer, retired with the rest below, and nothing committed now says a repo is entitled to see
  every directory's memory — inventing that entitlement (a name, a path under `~/gh-orgs`) is the
  directory-to-project guess the single store exists to refuse. A `user`/`feedback` entry is
  reported as belonging to the personal layer the user-level `~/.claude/CLAUDE.md` imports, and is
  never promoted or stamped from here.
- **The features ADR 0002 retired are gone, not dormant** (#54, v1.0.0): `include` and
  `handoff/`, assistants/roles/supervisors/lessons and their five skills, `teach-workspace`,
  `init-context`'s second-brain bootstrap, and both session launchers. Nothing reads their keys
  any more, so a legacy context repo that still carries them loads exactly as one that never did,
  and no check or queue reports them — `load-context.test.mjs` and `context-doctor.test.mjs` hold
  that line. Two deliberate leftovers: `thread-index.mjs` still *parses* the old
  `assistant:`/`supervisor:` index segment (it no longer writes it), so rebuilding an index written
  before the retirement keeps its hand-written gists; and the README's "Retired by ADR 0002" table
  names each feature once, with what replaces it (`/mattpocock-skills:teach` in `teaching/[slug]/`
  for teach-workspace). Do not bring any of them back without a new ADR.
- **`*.sh` stay LF** (enforced by `.gitattributes`).
