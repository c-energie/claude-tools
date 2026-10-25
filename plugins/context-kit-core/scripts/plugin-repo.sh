#!/usr/bin/env bash
# Resolve a WRITABLE checkout of c-energie/claude-tools — the plugin's own source repo —
# and bring it up to date. Prints the absolute path on stdout (nothing else) so callers can do:
#   ROOT="$(bash scripts/plugin-repo.sh --writable)"
#
#   scripts/plugin-repo.sh                       # resolve + pull --ff-only --autostash (30s cap)
#   scripts/plugin-repo.sh --no-pull             # resolve only — no network against an existing clone
#   scripts/plugin-repo.sh --writable            # also un-shallow the managed clone so pushes work
#   scripts/plugin-repo.sh --plugin context-kit-core   # print that plugin's directory, not the repo root
#
# The repo is a MARKETPLACE holding plugins/<name>/ subdirectories (both plugins moved here on
# 2026-08-02). The default answer is therefore the repo root — where you commit and push —
# while --plugin narrows it to the one directory holding a plugin.json, which is what
# check-plugin.mjs and bump-version.mjs take and what packaging installs as
# ${CLAUDE_PLUGIN_ROOT}. A pre-move single-plugin layout (plugin.json at the root) still works.
#
# Why this exists: when the plugin is installed from the marketplace, ${CLAUDE_PLUGIN_ROOT}
# points at the installed copy under ~/.claude/plugins/. Editing there is a dead end — it has
# no push remote and the plugin manager overwrites it on the next update. Anything that means
# to CHANGE the plugin must go through the checkout this resolves.
#
# The repo is private. Credentials come from the environment's own git helper where there is
# one, else CONTEXT_GIT_TOKEN / GH_TOKEN / GITHUB_TOKEN, else `gh auth token` — see the
# credentials section below. Never prompts, and never persists a token anywhere.
#
# Exit 1 (with a reason on stderr) if the repo can't be reached; the reason distinguishes
# "needs authentication" from "offline".
set -u

PLUGIN_REMOTE="c-energie/claude-tools"
# The repo was c-energie/context-kit until 2026-08-31, when it was renamed to match the catalog
# it now declares (name: c-energie — one catalog per GitHub ORG, not per topic). GitHub redirects
# the old clone URL, so a checkout made before the rename still fetches and pushes fine; it just
# has the old name in its origin. Recognise it rather than cloning a second copy beside it — the
# legacy name is accepted for RESOLUTION only, never for cloning, so nothing new lands there.
PLUGIN_REMOTE_LEGACY="c-energie/context-kit"
# ~/<owner>/<repo>, a mirror of GitHub's layout rooted at $HOME: ~/c-energie/claude-tools, the
# org workspace's member. The earlier clone paths under ~/.context went with that directory,
# deleted on 2026-10-25 when context repos were retired (#60).
#
# Derived from PLUGIN_REMOTE rather than spelled out, so the two cannot drift.
CLONE_DIR="${CONTEXT_KIT_PLUGIN_DIR:-$HOME/$PLUGIN_REMOTE}"
cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

PULL=1; WRITABLE=0; PLUGIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull)  PULL=0 ;;
    --writable) WRITABLE=1 ;;
    --plugin)
      PLUGIN="${2:-}"
      [ -z "$PLUGIN" ] && { echo "plugin-repo.sh: --plugin needs a plugin name" >&2; exit 2; }
      shift ;;
    *) echo "plugin-repo.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

# Cap the pull so a bad connection can't stall the caller. `timeout` is GNU coreutils —
# present in Git Bash and on Linux, absent on stock macOS — so fall back to an unbounded
# pull rather than failing where it isn't installed.
PULL_TIMEOUT="${CONTEXT_GIT_TIMEOUT:-30}"
TIMEOUT_BIN="$(command -v timeout 2>/dev/null || true)"

# ---------------------------------------------------------------- credentials
# The repo is private and every call runs GIT_TERMINAL_PROMPT=0, so an environment without a
# git credential helper fails silently. Try plain first (a laptop is unaffected), and only retry
# with a token when the failure was specifically authentication; auth failures return at once,
# so the retry cannot push a capped pull toward twice its budget.
AUTH_RE='could not read Username|Authentication failed|Invalid username or password|terminal prompts disabled|403 Forbidden|Repository not found'
ERR_TMP="${TMPDIR:-/tmp}/context-kit-git-$$.err"
trap 'rm -f "$ERR_TMP"' EXIT

TOKEN=""; TOKEN_TRIED=0; AUTH_HINT=""

resolve_token() {
  [ "$TOKEN_TRIED" -eq 1 ] && { [ -n "$TOKEN" ]; return; }
  TOKEN_TRIED=1
  TOKEN="${CONTEXT_GIT_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
  if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then
    TOKEN="$(gh auth token 2>/dev/null || true)"
  fi
  [ -n "$TOKEN" ]
}

# $1 = 1 to apply the pull cap, 0 for the uncapped one-offs. The token reaches git through the
# environment and a transient credential helper only — never the remote URL, never .git/config,
# never a command line — so it cannot leak through `git remote -v` or any printed diagnostic.
_git_run() {
  local capped="$1"; shift
  if [ "$capped" = 1 ] && [ -n "$TIMEOUT_BIN" ]; then
    GIT_TERMINAL_PROMPT=0 CONTEXT_TOKEN="$TOKEN" "$TIMEOUT_BIN" "$PULL_TIMEOUT" git "$@" >/dev/null 2>"$ERR_TMP"
  else
    GIT_TERMINAL_PROMPT=0 CONTEXT_TOKEN="$TOKEN" git "$@" >/dev/null 2>"$ERR_TMP"
  fi
}

git_net() {
  local capped="$1"; shift
  _git_run "$capped" "$@" && return 0
  grep -qE "$AUTH_RE" "$ERR_TMP" 2>/dev/null || return 1
  if resolve_token; then
    _git_run "$capped" -c credential.helper= \
      -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$CONTEXT_TOKEN"; }; f' \
      "$@" && return 0
    AUTH_HINT="authentication failed for $PLUGIN_REMOTE even with a token (expired, or no access to this repo?)"
  else
    AUTH_HINT="authentication required for $PLUGIN_REMOTE (private repo, no git credential in this environment) — set CONTEXT_GIT_TOKEN or sign in with 'gh auth login'"
  fi
  return 1
}

is_plugin_repo() {
  local url
  url="$(git -C "$1" remote get-url origin 2>/dev/null)" || return 1
  case "$url" in
    *"$PLUGIN_REMOTE"*)        return 0 ;;
    *"$PLUGIN_REMOTE_LEGACY"*) return 0 ;;
    *) return 1 ;;
  esac
}

ROOT=""
if is_plugin_repo "$cwd"; then
  ROOT="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || echo "$cwd")"
elif [ -d "$CLONE_DIR/.git" ] && is_plugin_repo "$CLONE_DIR"; then
  ROOT="$CLONE_DIR"
fi

if [ -z "$ROOT" ]; then
  mkdir -p "$(dirname "$CLONE_DIR")" 2>/dev/null || true
  if git_net 0 clone "https://github.com/$PLUGIN_REMOTE.git" "$CLONE_DIR"; then
    ROOT="$CLONE_DIR"
  fi
fi

if [ -z "$ROOT" ] || [ ! -d "$ROOT/.git" ]; then
  echo "plugin-repo.sh: no checkout of $PLUGIN_REMOTE — ${AUTH_HINT:-clone failed (offline?)}" >&2
  exit 1
fi

# Sanity check: the thing we resolved must actually look like the plugin source, not some
# other clone that happens to sit at the same path. Accept BOTH layouts — a marketplace repo
# (marketplace.json at the root, plugin.json inside each plugins/<name>/) and the pre-move
# single-plugin repo (plugin.json at the root). Checking only the latter is what broke this
# script when both plugins moved into plugins/.
if [ ! -f "$ROOT/.claude-plugin/marketplace.json" ] && [ ! -f "$ROOT/.claude-plugin/plugin.json" ]; then
  echo "plugin-repo.sh: $ROOT has neither .claude-plugin/marketplace.json nor .claude-plugin/plugin.json — refusing to treat it as the plugin repo" >&2
  exit 1
fi

# A shallow clone can't push; deepen before any write session.
if [ "$WRITABLE" -eq 1 ] && [ "$(git -C "$ROOT" rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  git_net 0 -C "$ROOT" fetch --unshallow || echo "plugin-repo.sh: --unshallow failed${AUTH_HINT:+ — $AUTH_HINT}; push may be rejected" >&2
fi

if [ "$PULL" -eq 1 ] && ! git_net 1 -C "$ROOT" pull --ff-only --autostash; then
  if [ -n "$AUTH_HINT" ]; then
    echo "plugin-repo.sh: pull failed — $AUTH_HINT; working from the local state" >&2
  else
    echo "plugin-repo.sh: pull failed or timed out after ${PULL_TIMEOUT}s; working from the local state" >&2
  fi
fi

# --plugin narrows the answer to one plugin's own directory. The root fallback covers the
# pre-move layout, and only when that root plugin.json actually carries the name asked for —
# otherwise "give me plugin X" would happily hand back a repo holding plugin Y.
if [ -n "$PLUGIN" ]; then
  if [ -f "$ROOT/plugins/$PLUGIN/.claude-plugin/plugin.json" ]; then
    echo "$ROOT/plugins/$PLUGIN"
  elif [ -f "$ROOT/.claude-plugin/plugin.json" ] \
       && grep -q "\"name\"[[:space:]]*:[[:space:]]*\"$PLUGIN\"" "$ROOT/.claude-plugin/plugin.json"; then
    echo "$ROOT"
  else
    echo "plugin-repo.sh: no plugin named $PLUGIN in $ROOT (looked for plugins/$PLUGIN/.claude-plugin/plugin.json)" >&2
    exit 1
  fi
  exit 0
fi

echo "$ROOT"