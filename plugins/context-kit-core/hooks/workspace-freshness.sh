#!/usr/bin/env bash
# context-kit — the session-start hook. It LOADS NOTHING: inside a workspace (the nearest
# .claude/workspace.json — ADR 0002) Claude Code already reads CLAUDE.md from the working dir and
# every parent, `@` imports included, so the workspace's memory and glossary arrive without this
# hook, and printing them here as well would load them twice. What Claude Code cannot tell anyone
# is that the checkout it is reading is behind its origin — a teammate pushed memory.md an hour
# ago and this session answers from the old one. So this hook does exactly one thing: a capped
# `git fetch`, and one line when the workspace is behind (or has diverged). Up to date, it prints
# NOTHING — a line on every session would be read once and then never again, which is how the one
# that matters gets missed.
#
# Outside a workspace — or with a malformed nearest workspace.json, which the resolver treats as
# none — it prints nothing at all. It used to be the legacy context-repo loader there; that route
# was deleted once the last project migrated (#60), and with it --refresh, PROJECT_CONTEXT_REPO,
# the marker and the STALE banner. Arguments are ignored, so an old `--refresh` call is harmless.
#
# What it deliberately does not do:
#   * Pull. Fetch moves remote-tracking refs only; the working tree is the user's, and a pull at
#     session start can autostash, conflict or move a branch under an editor that has it open.
#     The warning names the command instead.
#   * Retry with a token. A workspace is a checkout the user made, so their own credential helper
#     already works for it. A failure here is reported as one line rather than worked around.
#
# Whether this IS a workspace comes from scripts/workspace-root.sh — the same walk every other
# resolver uses, never a second copy of its rules. If scripts/ was dropped by packaging, it says
# nothing, which is never wrong for a check that only warns.
#
# Never prompts (GIT_TERMINAL_PROMPT=0, stdin from /dev/null), never exits non-zero, and never
# runs past CONTEXT_KIT_FETCH_TIMEOUT seconds (default 10 — a fetch with nothing to transfer is
# one round trip, and this one only ever warns).
set -u

# The one spelling of "off" in this system, in step with OPTOUT in scripts/context-doctor.mjs.
is_optout() {  # $1 = the configured value
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
    none|off|false|no|-|disabled) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------- machine-wide kill switch
# CONTEXT_KIT_AUTOLOAD, read from the `env` block of the USER-level ~/.claude/settings.json
# (Claude Code exports that block into the environment every hook runs in), switches this hook
# off on the whole machine without disabling the plugin — which would take the skills and the
# PreToolUse connection gate with it. A hard gate, checked first, so off costs one string
# comparison; nothing project-level overrides it. It fails OPEN: unset, empty or anything outside
# the opt-out vocabulary (`1`, `yes`, a typo) means on, because silence must be something the
# user asked for and never something a typo caused. The gate itself is deliberately untouched by
# the flag.
if is_optout "${CONTEXT_KIT_AUTOLOAD:-}"; then
  exit 0
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Prints the one warning line for $1 (the workspace root), or nothing when there is nothing to
# say. Silent, deliberately, where there is no upstream to compare against: a workspace that is
# not a git repo, a detached HEAD, a branch never pushed. None of those is behind anything, and
# they are the user's own arrangements rather than faults.
workspace_freshness() {
  local root="$1" upstream cap errf pid watch rc reason counts ahead behind
  upstream="$(git -C "$root" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null)" || return 0
  [ -n "$upstream" ] || return 0

  cap="${CONTEXT_KIT_FETCH_TIMEOUT:-10}"
  case "$cap" in ''|*[!0-9]*) cap=10 ;; esac
  errf="${TMPDIR:-/tmp}/context-kit-fetch-$$.err"

  # The cap is a watcher in the background, not `timeout`: `timeout` is GNU coreutils and absent
  # on stock macOS — and "never hangs past the cap" is the
  # one promise that must hold everywhere. The watcher's output goes to /dev/null so that its
  # `sleep`, which outlives a kill of the subshell, cannot hold the hook's stdout open and keep
  # Claude Code waiting for EOF. A plain `git fetch` fetches the current branch's own remote, so
  # there is no remote name to work out here. gc and maintenance are off: an auto-gc triggered by
  # the fetch is the one step here whose duration has nothing to do with the network.
  GIT_TERMINAL_PROMPT=0 git -C "$root" -c gc.auto=0 -c maintenance.auto=false \
    fetch --quiet --no-recurse-submodules </dev/null >/dev/null 2>"$errf" &
  pid=$!
  ( sleep "$cap"; kill "$pid" ) </dev/null >/dev/null 2>&1 &
  watch=$!
  # Braced so bash's own "Terminated" job notice, when the watcher fires, is not printed.
  { wait "$pid"; } 2>/dev/null
  rc=$?
  kill "$watch" 2>/dev/null

  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -gt 128 ]; then
      reason="timed out after ${cap}s"
    else
      # git's last line is the specific one ("Could not resolve host", "Authentication failed").
      # Userinfo is stripped from any URL in it: a token embedded in a remote URL would otherwise
      # be printed into the session.
      reason="$(grep -v '^[[:space:]]*$' "$errf" 2>/dev/null | tail -n 1 \
        | sed -e 's#://[^/@[:space:]]*@#://#g' -e 's/^fatal: //' -e 's/^error: //')"
      reason="${reason:-git fetch exited $rc}"
    fi
    rm -f "$errf"
    echo "Workspace freshness check could not run ($reason) — $root may be behind $upstream."
    return 0
  fi
  rm -f "$errf"

  counts="$(git -C "$root" rev-list --left-right --count "HEAD...$upstream" 2>/dev/null)" || return 0
  ahead="$(printf '%s' "$counts" | awk '{print $1}')"
  behind="$(printf '%s' "$counts" | awk '{print $2}')"
  [ "${behind:-0}" -gt 0 ] 2>/dev/null || return 0   # ahead only, or level: nothing to warn about
  local s=""; [ "$behind" -ne 1 ] && s="s"
  if [ "${ahead:-0}" -gt 0 ]; then
    # Diverged: no single safe command exists, so none is pretended. Naming both counts lets the
    # user see whether this is one stray commit or a real fork before choosing rebase or merge.
    echo "⚠ Workspace $root has diverged from $upstream: $behind commit$s behind, $ahead ahead — reconcile by hand: git -C \"$root\" pull --rebase (or merge)."
  else
    echo "⚠ Workspace $root is $behind commit$s behind $upstream — update with: git -C \"$root\" pull --ff-only"
  fi
}

[ -f "$HERE/../scripts/workspace-root.sh" ] || exit 0
WS_ROOT="$(bash "$HERE/../scripts/workspace-root.sh" 2>/dev/null)" || exit 0
[ -n "$WS_ROOT" ] || exit 0
WS_NOTE="$(workspace_freshness "$WS_ROOT")"
# One line to BOTH readers when there is one: systemMessage puts it in front of the user, who
# otherwise never sees a SessionStart hook's output, and additionalContext tells the model, so
# that it can qualify an answer drawn from memory.md. Plain text where there is no node.
if [ -n "$WS_NOTE" ]; then
  node -e '
    process.stdout.write(JSON.stringify({
      systemMessage: process.argv[1],
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: process.argv[1] },
    }));
  ' "$WS_NOTE" 2>/dev/null || printf '%s\n' "$WS_NOTE"
fi
exit 0
