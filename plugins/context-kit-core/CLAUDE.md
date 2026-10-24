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
node scripts/bump-version.mjs . patch    # major|minor|patch; writes plugin.json only
node --test scripts/workspace.test.mjs   # the workspace resolver and its bash twin; stdlib only, no network
node scripts/workspace.mjs --no-pull     # the nearest .claude/workspace.json's root, else the context repo (--json)
bash scripts/workspace-root.sh --no-pull # the same, in bash, for hooks
bash scripts/context-repo.sh --no-pull   # resolve the (env-selected) context checkout
bash scripts/context-repo.sh --threads   # where this project's working notes go: repo|context|auto
bash hooks/load-context.sh --refresh     # exactly what refresh-context runs, against $PWD
bash scripts/plugin-repo.sh --writable   # resolve THIS repo's checkout (root), push-ready
bash scripts/plugin-repo.sh --plugin context-kit-core   # ...or one plugin's own directory
node scripts/list-plugins.mjs "$ROOT" --brief   # the plugin roster, read from the checkout — never hand-written
node scripts/list-plugins.mjs "$ROOT"           # ...plus each plugin's skills (--json)
node scripts/dates.mjs today
node scripts/json-block.mjs entries "$CTX/context.json"                # the top-level keys, in file order
node scripts/json-block.mjs set "$CTX/context.json" teaching '{...}'   # PLAN one block; --write applies it
node scripts/init-context.mjs owner/repo            # PLAN a new context repo (+ the second brain, once); --yes does it
node scripts/link-context.mjs owner/repo --load   # run from a PROJECT dir: link it to its context repo
node scripts/link-context.mjs owner/repo --threads context   # ...and route its threads off this repo
node scripts/context-doctor.mjs "$ROOT" --include   # health-check a context repo (--json, --fix, --today)
node scripts/context-status.mjs "$ROOT"           # what is OUTSTANDING in every queue (--json, --role, --no-memory)
node scripts/assistants.mjs roster "$ROOT"        # the assistant/supervisor/role roster
node scripts/assistants.mjs unswept "$ROOT" --role software-dev   # lessons not yet distilled
node scripts/memory-triage.mjs scan "$ROOT"        # native memory awaiting promotion
node scripts/teaching-workspace.mjs resolve --json               # which context repo, or WHY not (no network)
node scripts/teaching-workspace.mjs roster "$ROOT"                # the teaching workspaces it DECLARES (--json)
node scripts/teaching-workspace.mjs scaffold "$ROOT" "deep learning"   # PLAN a workspace; --yes --audience writes it
pwsh scripts/Start-ContextSession.ps1 -DryRun    # menu over ~/.context; -Shortcut installs a Desktop launcher
bash scripts/start-context-session.sh --dry-run  # the same menu for macOS/Linux (--shortcut writes .desktop/.command)
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
- **`include` (cross-project loads) is explicit, one-level, and read-only.** A context repo's
  `context.json` may declare `include: ["owner/repo", ...]`; the hook then loads each named
  repo's memory alongside the repo's own — and its glossary and threads only as POINTERS (term
  names, six newest by title), so an included repo is never loaded more eagerly than the repo
  the session is in — per-repo STALE/UNAVAILABLE banners included. Never discover includes
  from the filesystem, never recurse into an included repo's own list, and never write into an
  included repo. Entries are repo names only — the contract stays route-agnostic for the
  sandbox/API route. The sentinel filter in the hook's include parser mirrors `is_optout()`
  — keep them in step.
- **The two session launchers are twins, not copies.** `Start-ContextSession.ps1` and
  `start-context-session.sh` are the same menu written for two shells, so `check-plugin.mjs`'s
  drift rule (which compares byte-for-byte) deliberately does not cover them — only they can
  make a `.lnk` and a `.desktop`/`.command` respectively. Change both, or neither.
- **The second brain is stamped once and then adopted.** `init-context` bootstraps
  `~/.context/[login]/second-brain` from the template plus `assets/second-brain/` only when no
  such repo exists locally or on GitHub; an existing one is cloned and left exactly as it is.
  It never writes that repo's `include` list — it prints the edit. Owner is the authenticated
  GitHub user, never the project's owner, and never inferred from a git remote.
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
  every MCP call on the machine rather than deny one. The policy is *derived* from
  `context.json` (falling back to the marker's mirrored copy, which is what reaches a Cowork
  sandbox) — never a hand-written deny list, which enumerates the others and is stale the day
  a connection is added. It **fails open and says so on stderr** when the policy cannot be
  read: a gate that blocked every MCP call on a missing checkout would be worse than none.
  `connections: {}` denies every provider connector; an absent `connections` key denies
  nothing — the same absent-versus-empty distinction drawn everywhere else.
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
- **`*.sh` stay LF** (enforced by `.gitattributes`).
