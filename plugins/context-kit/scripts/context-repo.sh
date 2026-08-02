#!/usr/bin/env bash
# Resolve the context repo checkout and bring it up to date. Prints the absolute path on
# stdout (nothing else) so callers can do:  ROOT="$(bash scripts/context-repo.sh)"
#
# Which repo is FLEXSENSE_CONTEXT_REPO (owner/repo on github.com), defaulting to the FlexSense
# one, net-flex/context — so a per-project override in that project's .claude/settings.json env
# block points this same machinery at another project's context repo.
#
#   scripts/context-repo.sh              # resolve + pull --ff-only --autostash (30s cap)
#   scripts/context-repo.sh --no-pull    # resolve only — no network against an existing clone
#   scripts/context-repo.sh --writable   # also un-shallow the managed clone so pushes work
#
# The pull is capped at FLEXSENSE_GIT_TIMEOUT seconds (default 30) where `timeout` exists.
# Clone and --unshallow are deliberately NOT capped: they are one-off and legitimately slower
# than a pull, and cutting them short leaves no usable checkout at all.
#
# The repo is private. Credentials come from the environment's own git helper where there is
# one, else FLEXSENSE_GIT_TOKEN / GH_TOKEN / GITHUB_TOKEN, else `gh auth token` — see the
# credentials section below. Never prompts, and never persists a token anywhere.
#
# Exit 1 (with a reason on stderr) if the context repo can't be reached — callers decide
# whether that is fatal. The reason distinguishes "needs authentication" from "offline",
# because those look identical from the outside and want completely different fixes.
set -u

cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

# Which context repo, in order: the env var; else the project's .claude settings files (the
# laptop route — the committed settings.json rides along in the checkout; local beats project,
# matching the client's own precedence); else a one-line marker file, checked in the working
# dir and in /mnt/project — the latter is where Cowork surfaces files attached to a project,
# the ONLY channel into its sandbox, which also cannot set env vars; else the default.
# The sed is deliberately dumb: it finds the key anywhere in the file, which is fine for a
# name this deliberate.
settings_repo() {
  sed -n 's/.*"FLEXSENSE_CONTEXT_REPO"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1
}
marker_repo() {  # first line of a marker file, whitespace stripped ("owner/repo" has none)
  head -n 1 "$1" 2>/dev/null | tr -d ' \t\r\n'
}
CONTEXT_REMOTE="${FLEXSENSE_CONTEXT_REPO:-}"
[ -z "$CONTEXT_REMOTE" ] && CONTEXT_REMOTE="$(settings_repo "$cwd/.claude/settings.local.json")"
[ -z "$CONTEXT_REMOTE" ] && CONTEXT_REMOTE="$(settings_repo "$cwd/.claude/settings.json")"
# Marker candidates cover every sandbox layout seen so far: the working dir; /mnt/project
# (one Cowork/claude.ai layout); ~/mnt/.projects/[uuid]/docs and ~/mnt/uploads (the
# /sessions/... layout, where attached project files land under the session's home).
for _m in "$cwd/.context-repo" "$cwd/context-repo.txt" \
          /mnt/project/.context-repo /mnt/project/context-repo.txt \
          "$HOME"/mnt/.projects/*/docs/.context-repo "$HOME"/mnt/.projects/*/docs/context-repo.txt \
          "$HOME"/mnt/uploads/.context-repo "$HOME"/mnt/uploads/context-repo.txt; do
  [ -z "$CONTEXT_REMOTE" ] && [ -f "$_m" ] && CONTEXT_REMOTE="$(marker_repo "$_m")"
done
CONTEXT_REMOTE="${CONTEXT_REMOTE:-net-flex/context}"

# The managed clone follows the remote: FLEXSENSE_CONTEXT_DIR beats everything, the default
# remote keeps its historical ~/.flexsense/context so existing clones survive, and any other
# remote lands at ~/.context/<owner>-<repo> — owner included because context repos tend to all
# be *named* "context", and two projects' clones must not collide.
if [ -n "${FLEXSENSE_CONTEXT_DIR:-}" ]; then
  CLONE_DIR="$FLEXSENSE_CONTEXT_DIR"
elif [ "$CONTEXT_REMOTE" = "net-flex/context" ]; then
  CLONE_DIR="$HOME/.flexsense/context"
else
  CLONE_DIR="$HOME/.context/${CONTEXT_REMOTE//\//-}"
fi

PULL=1; WRITABLE=0
for arg in "$@"; do
  case "$arg" in
    --no-pull)  PULL=0 ;;
    --writable) WRITABLE=1 ;;
    *) echo "context-repo.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done

# The pull runs inside the SessionStart hook, so an unbounded one stalls the start of every
# session on a slow or half-open connection. Cap it. `timeout` is GNU coreutils — present in
# Git Bash and on Linux, absent on stock macOS — so fall back to an unbounded pull rather than
# failing outright where it isn't installed.
PULL_TIMEOUT="${FLEXSENSE_GIT_TIMEOUT:-30}"
TIMEOUT_BIN="$(command -v timeout 2>/dev/null || true)"

# ---------------------------------------------------------------- credentials
# net-flex/context is private and every git call here runs GIT_TERMINAL_PROMPT=0, so an
# environment with no credential helper fails *silently* — indistinguishable from an empty or
# missing repo, which is the failure this whole file is written to avoid. A laptop has the OS
# helper; a session running in a cloud environment (Cowork) has nothing.
#
# So: always try the plain call first — that leaves the laptop path byte-identical — and only
# retry with a token when the failure was specifically AUTHENTICATION. Auth failures return
# immediately, so the retry cannot push a capped pull toward twice its budget.
AUTH_RE='could not read Username|Authentication failed|Invalid username or password|terminal prompts disabled|403 Forbidden|Repository not found'
ERR_TMP="${TMPDIR:-/tmp}/flexsense-ctx-git-$$.err"
trap 'rm -f "$ERR_TMP"' EXIT

TOKEN=""; TOKEN_TRIED=0; AUTH_HINT=""

# Resolved lazily — only ever after something has already failed on auth, so a healthy machine
# never pays for it. Returns non-zero when there is nothing to try.
resolve_token() {
  [ "$TOKEN_TRIED" -eq 1 ] && { [ -n "$TOKEN" ]; return; }
  TOKEN_TRIED=1
  TOKEN="${FLEXSENSE_GIT_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
  # Borrowing the GitHub CLI's token is the no-secret path: if gh is already signed in, nobody
  # has to issue, store or paste a personal access token at all.
  if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then
    TOKEN="$(gh auth token 2>/dev/null || true)"
  fi
  [ -n "$TOKEN" ]
}

# $1 = 1 to apply the pull cap, 0 for the one-off operations (clone, --unshallow) that are
# deliberately uncapped. The token reaches git through the environment and a transient
# credential helper — never the remote URL, never .git/config, never a command line — so it
# cannot leak through `git remote -v` or anything else this or its callers print.
_git_run() {
  local capped="$1"; shift
  if [ "$capped" = 1 ] && [ -n "$TIMEOUT_BIN" ]; then
    GIT_TERMINAL_PROMPT=0 FLEXSENSE_TOKEN="$TOKEN" "$TIMEOUT_BIN" "$PULL_TIMEOUT" git "$@" >/dev/null 2>"$ERR_TMP"
  else
    GIT_TERMINAL_PROMPT=0 FLEXSENSE_TOKEN="$TOKEN" git "$@" >/dev/null 2>"$ERR_TMP"
  fi
}

git_net() {
  local capped="$1"; shift
  _git_run "$capped" "$@" && return 0
  grep -qE "$AUTH_RE" "$ERR_TMP" 2>/dev/null || return 1
  if resolve_token; then
    _git_run "$capped" -c credential.helper= \
      -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$FLEXSENSE_TOKEN"; }; f' \
      "$@" && return 0
    AUTH_HINT="authentication failed for $CONTEXT_REMOTE even with a token (expired, or no access to this repo?)"
  else
    AUTH_HINT="authentication required for $CONTEXT_REMOTE (private repo, no git credential in this environment) — set FLEXSENSE_GIT_TOKEN or sign in with 'gh auth login'"
  fi
  return 1
}

is_context_repo() {
  local url
  url="$(git -C "$1" remote get-url origin 2>/dev/null)" || return 1
  case "$url" in *"$CONTEXT_REMOTE"*) return 0 ;; *) return 1 ;; esac
}

ROOT=""
if is_context_repo "$cwd"; then
  ROOT="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || echo "$cwd")"
elif [ -d "$CLONE_DIR/.git" ]; then
  ROOT="$CLONE_DIR"
else
  mkdir -p "$(dirname "$CLONE_DIR")" 2>/dev/null || true
  if git_net 0 clone --depth 1 "https://github.com/$CONTEXT_REMOTE.git" "$CLONE_DIR"; then
    ROOT="$CLONE_DIR"
  fi
fi

if [ -z "$ROOT" ] || [ ! -d "$ROOT/.git" ]; then
  echo "context-repo.sh: no checkout of $CONTEXT_REMOTE — ${AUTH_HINT:-clone failed (offline?)}" >&2
  exit 1
fi

# A shallow clone can't push; deepen before any write session.
if [ "$WRITABLE" -eq 1 ] && [ "$(git -C "$ROOT" rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  git_net 0 -C "$ROOT" fetch --unshallow || echo "context-repo.sh: --unshallow failed${AUTH_HINT:+ — $AUTH_HINT}; push may be rejected" >&2
fi

if [ "$PULL" -eq 1 ] && ! git_net 1 -C "$ROOT" pull --ff-only --autostash; then
  if [ -n "$AUTH_HINT" ]; then
    echo "context-repo.sh: pull failed — $AUTH_HINT; working from the local state" >&2
  else
    echo "context-repo.sh: pull failed or timed out after ${PULL_TIMEOUT}s; working from the local state" >&2
  fi
fi

echo "$ROOT"