#!/usr/bin/env bash
# Resolve the context repo checkout and bring it up to date. Prints the absolute path on
# stdout (nothing else) so callers can do:  ROOT="$(bash scripts/context-repo.sh)"
#
# Which repo (owner/repo on github.com) comes from PROJECT_CONTEXT_REPO — env var, the
# project's .claude settings files, or a marker file, see below. There is deliberately no
# default repo.
#
#   scripts/context-repo.sh              # resolve + pull --ff-only --autostash (30s cap)
#   scripts/context-repo.sh --no-pull    # resolve only — no network against an existing clone
#   scripts/context-repo.sh --writable   # also un-shallow the managed clone so pushes work
#
# The pull is capped at CONTEXT_GIT_TIMEOUT seconds (default 30) where `timeout` exists.
# Clone and --unshallow are deliberately NOT capped: they are one-off and legitimately slower
# than a pull, and cutting them short leaves no usable checkout at all.
#
# The repo is private. Credentials come from the environment's own git helper where there is
# one, else CONTEXT_GIT_TOKEN / GH_TOKEN / GITHUB_TOKEN, else `gh auth token` — see the
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
# the ONLY channel into its sandbox, which also cannot set env vars. There is deliberately
# NO default: an unconfigured project must say so, because falling back to some other
# project's context repo silently loads the WRONG context — the one failure mode this whole
# plugin exists to prevent. The sed is deliberately dumb: it finds the key anywhere in the
# file, which is fine for a name this deliberate.
settings_key() {  # $1 = file, $2 = json key
  sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1
}
marker_repo() {
  # A marker is either one plain "owner/repo" line, or a JSON object (context-project.json)
  # whose "contextRepo" key names the repo — the JSON form can also carry a "connections"
  # map for the skills. Sniff the first byte rather than trusting the filename.
  case "$(head -c 1 "$1" 2>/dev/null)" in
    "{") settings_key "$1" contextRepo ;;
    *)   head -n 1 "$1" 2>/dev/null | tr -d ' \t\r\n' ;;
  esac
}
CONTEXT_REMOTE="${PROJECT_CONTEXT_REPO:-}"
for _f in "$cwd/.claude/settings.local.json" "$cwd/.claude/settings.json"; do
  [ -z "$CONTEXT_REMOTE" ] && CONTEXT_REMOTE="$(settings_key "$_f" PROJECT_CONTEXT_REPO)"
done
# Marker candidates cover every sandbox layout seen so far: the working dir; /mnt/project
# (one Cowork/claude.ai layout); ~/mnt/.projects/[uuid]/docs and ~/mnt/uploads (the
# /sessions/... layout, where attached project files land under the session's home).
for _m in "$cwd/context-project.json" "$cwd/.context-repo" "$cwd/context-repo.txt" \
          "$cwd"/docs/context-project.json "$cwd"/docs/.context-repo "$cwd"/docs/context-repo.txt \
          /mnt/project/context-project.json /mnt/project/.context-repo /mnt/project/context-repo.txt \
          "$HOME"/mnt/.projects/*/docs/context-project.json "$HOME"/mnt/.projects/*/docs/.context-repo "$HOME"/mnt/.projects/*/docs/context-repo.txt \
          "$HOME"/mnt/uploads/context-project.json "$HOME"/mnt/uploads/.context-repo "$HOME"/mnt/uploads/context-repo.txt; do
  [ -z "$CONTEXT_REMOTE" ] && [ -f "$_m" ] && CONTEXT_REMOTE="$(marker_repo "$_m")"
done
# Last resort, sandbox layouts drift: a bounded search of the mount areas only — never the
# working tree, which on a laptop can be a huge repo this must not crawl at session start.
if [ -z "$CONTEXT_REMOTE" ]; then
  for _d in "$HOME/mnt" /mnt; do
    if [ -z "$CONTEXT_REMOTE" ] && [ -d "$_d" ]; then
      _found="$(find "$_d" -maxdepth 5 \( -name context-project.json -o -name context-repo.txt -o -name .context-repo \) 2>/dev/null | head -n 1)"
      [ -n "$_found" ] && CONTEXT_REMOTE="$(marker_repo "$_found")"
    fi
  done
fi
if [ -z "$CONTEXT_REMOTE" ]; then
  echo "context-repo.sh: no context repo configured for this project — set PROJECT_CONTEXT_REPO, add an env block to .claude/settings.json, or attach a one-line .context-repo / context-repo.txt marker (owner/repo)" >&2
  exit 1
fi
# The opt-out sentinel: a project that deliberately has no context repo, spelled `none`
# wherever the repo name goes. Same exit code as unconfigured — callers already treat that as
# "no context here" — but a different reason, because the fix is the opposite one.
case "$(printf '%s' "$CONTEXT_REMOTE" | tr 'A-Z' 'a-z')" in
  none|off|false|no|-|disabled)
    echo "context-repo.sh: this project has opted out of a context repo (configured as \"$CONTEXT_REMOTE\") — nothing to resolve. Remove that setting from .claude/settings*.json, the env, or the marker to re-enable." >&2
    exit 1 ;;
esac

# The managed clone lands at ~/.context/<owner>-<repo> — owner included because context repos
# tend to all be *named* "context", and two projects' clones must not collide.
# PROJECT_CONTEXT_DIR pins the location outright.
if [ -n "${PROJECT_CONTEXT_DIR:-}" ]; then
  CLONE_DIR="$PROJECT_CONTEXT_DIR"
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
PULL_TIMEOUT="${CONTEXT_GIT_TIMEOUT:-30}"
TIMEOUT_BIN="$(command -v timeout 2>/dev/null || true)"

# ---------------------------------------------------------------- credentials
# Context repos are typically private, and every git call here runs GIT_TERMINAL_PROMPT=0, so an
# environment with no credential helper fails *silently* — indistinguishable from an empty or
# missing repo, which is the failure this whole file is written to avoid. A laptop has the OS
# helper; a session running in a cloud environment (Cowork) has nothing.
#
# So: always try the plain call first — that leaves the laptop path byte-identical — and only
# retry with a token when the failure was specifically AUTHENTICATION. Auth failures return
# immediately, so the retry cannot push a capped pull toward twice its budget.
AUTH_RE='could not read Username|Authentication failed|Invalid username or password|terminal prompts disabled|403 Forbidden|Repository not found'
ERR_TMP="${TMPDIR:-/tmp}/context-git-$$.err"
trap 'rm -f "$ERR_TMP"' EXIT

TOKEN=""; TOKEN_TRIED=0; AUTH_HINT=""

# Resolved lazily — only ever after something has already failed on auth, so a healthy machine
# never pays for it. Returns non-zero when there is nothing to try.
resolve_token() {
  [ "$TOKEN_TRIED" -eq 1 ] && { [ -n "$TOKEN" ]; return; }
  TOKEN_TRIED=1
  TOKEN="${CONTEXT_GIT_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
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
    AUTH_HINT="authentication failed for $CONTEXT_REMOTE even with a token (expired, or no access to this repo?)"
  else
    AUTH_HINT="authentication required for $CONTEXT_REMOTE (private repo, no git credential in this environment) — set CONTEXT_GIT_TOKEN or sign in with 'gh auth login'"
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