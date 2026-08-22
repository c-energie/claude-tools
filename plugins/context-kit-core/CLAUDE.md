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
bash scripts/plugin-repo.sh --writable   # resolve THIS repo's checkout (root), push-ready
bash scripts/plugin-repo.sh --plugin context-kit-core   # ...or one plugin's own directory
node scripts/list-plugins.mjs "$ROOT" --brief   # the plugin roster, read from the checkout — never hand-written
node scripts/list-plugins.mjs "$ROOT"           # ...plus each plugin's skills (--json)
node scripts/dates.mjs today
node scripts/init-context.mjs owner/repo            # PLAN a new context repo (+ the second brain, once); --yes does it
node scripts/link-context.mjs owner/repo --load   # run from a PROJECT dir: link it to its context repo
node scripts/context-doctor.mjs "$ROOT" --include   # health-check a context repo (--json, --fix, --today)
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
- **`*.sh` stay LF** (enforced by `.gitattributes`).
