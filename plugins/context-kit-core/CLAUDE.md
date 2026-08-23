# CLAUDE.md

## What this repo is

The **core layer** context plugin (`context-kit`), shipped from its own marketplace in
`c-energie/context-kit`. Generic machinery only: it loads/refreshes/writes *a* project's
context repo, selected per project by `PROJECT_CONTEXT_REPO`, settings files, or a marker — with no default: unconfigured projects say so, and `none` opts a project out silently.
Anything project- or workspace-specific belongs in a higher layer: the planned Notion
middle-layer plugin, or the project's own context repo (created from
`c-energie/context-template`). See README.md for the three-layer picture and port status.

A fix to the resolver or hook belongs in all three plugins' copies (see the marketplace CLAUDE.md);
`check-plugin.mjs` now errors if a copy drifts from its original.

## Commands

```bash
node scripts/check-plugin.mjs .          # lint manifests/skills/hooks; exit 1 on error — run before any commit
node scripts/bump-version.mjs . patch    # major|minor|patch; writes plugin.json only
bash scripts/context-repo.sh --no-pull   # resolve the (env-selected) context checkout
bash scripts/context-repo.sh --threads   # where this project's working notes go: repo|context|auto
bash scripts/plugin-repo.sh --writable   # resolve THIS repo's checkout (root), push-ready
bash scripts/plugin-repo.sh --plugin context-kit-core   # ...or one plugin's own directory
node scripts/list-plugins.mjs "$ROOT" --brief   # the plugin roster, read from the checkout — never hand-written
node scripts/list-plugins.mjs "$ROOT"           # ...plus each plugin's skills (--json)
node scripts/dates.mjs today
node scripts/init-context.mjs owner/repo            # PLAN a new context repo (+ the second brain, once); --yes does it
node scripts/link-context.mjs owner/repo --load   # run from a PROJECT dir: link it to its context repo
node scripts/link-context.mjs owner/repo --threads context   # ...and route its threads off this repo
node scripts/context-doctor.mjs "$ROOT" --include   # health-check a context repo (--json, --fix, --today)
node scripts/context-status.mjs "$ROOT"           # what is OUTSTANDING in every queue (--json, --role, --no-memory)
node scripts/assistants.mjs roster "$ROOT"        # the assistant/supervisor/role roster
node scripts/assistants.mjs unswept "$ROOT" --role software-dev   # lessons not yet distilled
node scripts/memory-triage.mjs scan "$ROOT"        # native memory awaiting promotion
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
  `scripts/plugin-repo.sh --writable` (managed clone: `~/.context/c-energie/context-kit` — the
  same `~/.context/<owner>/<repo>` layout context repos use; flat until 2026-08-11).
- **`include` (cross-project loads) is explicit, one-level, and read-only.** A context repo's
  `context.json` may declare `include: ["owner/repo", ...]`; the hook then loads each named
  repo's memory/glossary/thread-index alongside the repo's own, per-repo STALE/UNAVAILABLE
  banners included. Never discover includes from the filesystem, never recurse into an
  included repo's own list, and never write into an included repo. Entries are repo names
  only — the contract stays route-agnostic for the sandbox/API route. The sentinel filter in
  the hook's include parser mirrors `is_optout()` — keep them in step.
- **The two session launchers are twins, not copies.** `Start-ContextSession.ps1` and
  `start-context-session.sh` are the same menu written for two shells, so `check-plugin.mjs`'s
  drift rule (which compares byte-for-byte) deliberately does not cover them — only they can
  make a `.lnk` and a `.desktop`/`.command` respectively. Change both, or neither.
- **The second brain is stamped once and then adopted.** `init-context` bootstraps
  `~/.context/[login]/second-brain` from the template plus `assets/second-brain/` only when no
  such repo exists locally or on GitHub; an existing one is cloned and left exactly as it is.
  It never writes that repo's `include` list — it prints the edit. Owner is the authenticated
  GitHub user, never the project's owner, and never inferred from a git remote.
- **`connections` is ENFORCED, not merely announced.** `hooks/connection-gate.mjs` runs
  `PreToolUse` on every `mcp__*` call and denies any connector that is not the one the
  project's `connections` declares for that provider. The policy is *derived* from
  `context.json` (falling back to the marker's mirrored copy, which is what reaches a Cowork
  sandbox) — never a hand-written deny list, which enumerates the others and is stale the day
  a connection is added. It **fails open and says so on stderr** when the policy cannot be
  read: a gate that blocked every MCP call on a missing checkout would be worse than none.
  `connections: {}` denies every provider connector; an absent `connections` key denies
  nothing — the same absent-versus-empty distinction drawn everywhere else.
- **`*.sh` stay LF** (enforced by `.gitattributes`).
