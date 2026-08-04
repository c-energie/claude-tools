# CLAUDE.md

## What this repo is

The **core layer** context plugin (`context-kit`), shipped from its own marketplace in
`c-energie/context-kit`. Generic machinery only: it loads/refreshes/writes *a* project's
context repo, selected per project by `PROJECT_CONTEXT_REPO`, settings files, or a marker — with no default: unconfigured projects say so.
Anything project- or workspace-specific belongs in a higher layer: the planned Notion
middle-layer plugin, or the project's own context repo (created from
`c-energie/context-template`). See README.md for the three-layer picture and port status.

A fix to the resolver or hook belongs in both plugins' copies (see the marketplace CLAUDE.md).

## Commands

```bash
node scripts/check-plugin.mjs .          # lint manifests/skills/hooks; exit 1 on error — run before any commit
node scripts/bump-version.mjs . patch    # major|minor|patch; writes plugin.json only
bash scripts/context-repo.sh --no-pull   # resolve the (env-selected) context checkout
bash scripts/plugin-repo.sh --writable   # resolve THIS repo's checkout, push-ready
node scripts/dates.mjs today
```

## Invariants (all load-bearing)

- **Version lives in `plugin.json` only** — a `version` in a `marketplace.json` `plugins[]`
  entry silently overrides it.
- **No angle brackets in any YAML front-matter value** — the skill ingester drops the field.
- **The hook never prompts, never hangs, never exits non-zero.** Unknown args are ignored.
  Failed refreshes serve the local copy under a STALE banner naming the reason — a silent
  stale load is the one failure mode that actively misleads.
- **`hooks/load-context.sh` carries an inline duplicate of `context-repo.sh`** (packaging may
  drop `scripts/`). Keep the two in step; `context-repo.sh` is the real one.
- **Tokens reach git via the environment plus a transient `-c credential.helper` only** —
  never the remote URL, `.git/config`, or a command line. Retry only on auth failures, never
  on timeouts.
- **Skills that write outside the session must not self-trigger**: `disable-model-invocation:
  true` or an explicit ask-before-push gate.
- **Edit the source checkout, not the installed copy** — `${CLAUDE_PLUGIN_ROOT}` points at
  `~/.claude/plugins/…`, which has no push remote and is overwritten on update. Resolve with
  `scripts/plugin-repo.sh --writable` (managed clone: `~/.context/context-kit`).
- **`*.sh` stay LF** (enforced by `.gitattributes`).
