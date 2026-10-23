#!/usr/bin/env bash
# context-kit — load shared context at session start, wherever the context-kit plugin is enabled.
# Inside a workspace (.claude/workspace.json) it loads nothing — Claude Code's own CLAUDE.md
# loading does that — and only warns when the workspace is behind its origin; see the workspace
# section below. Everywhere else it is the legacy loader: injects memory.md + pointers to
# glossary/threads so the session starts having read the shared context. Never prompts, never
# hangs, never blocks (always exits 0).
#
# Checkout resolution lives in scripts/context-repo.sh — the same resolver save-thread and
# curate-context use, so all three agree on which clone is "the" context repo.
#
# The refresh is capped (see the resolver). If it times out or fails, the session still gets
# the local copy, but with a STALE banner above it saying so and how old it is — never silently.
#
# CONTEXT_KIT_AUTOLOAD=off in the user-level ~/.claude/settings.json turns the automatic load
# off for the whole machine, before any of this runs; --refresh still loads. See the gate below.
#
# Also runs mid-session, by hand, as `load-context.sh --refresh` — that is the whole of the
# refresh-context skill. Same pull, same STALE banner, different header (claiming "loaded at
# session start" an hour into a session is exactly the kind of quiet lie this script exists to
# avoid) plus a provenance line naming the checkout it actually read.
set -u

# The one spelling of "off" in this system, answering two different questions below: whether
# this MACHINE autoloads (CONTEXT_KIT_AUTOLOAD, immediately after this) and whether this
# PROJECT has a context repo at all (the repo name, much further down). Deliberately the same
# vocabulary for both, so nobody has to remember which spelling a given switch accepts — and
# in step with OPTOUT in hooks/connection-gate.mjs, scripts/context-repo.sh and
# scripts/link-context.mjs. It sits up here, above every other helper, only because the
# autoload gate has to run before the script does any work at all.
is_optout() {  # $1 = the configured value; true when it means "deliberately no context repo"
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
    none|off|false|no|-|disabled) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------- machine-wide autoload switch
# CONTEXT_KIT_AUTOLOAD says whether this MACHINE loads context automatically at all — a
# different question from the per-project ladder below, which only ever answers *which repo*.
# Read from the `env` block of the USER-level ~/.claude/settings.json; Claude Code exports that
# block into the environment every hook runs in, so there is nothing to parse here and no `jq`
# or bash spawn to get wrong on a Windows box (where the `bash` on PATH may be WSL's, with its
# own $HOME). Before it existed, "off here" meant either disabling the whole plugin — losing the
# skills and the PreToolUse connection gate with it — or dropping an opt-out marker into every
# unrelated directory one ever opened a session in.
#
# Four properties, each of them deliberate:
#
#   * It is a HARD gate, and it goes first: before lookup_repo(), before the marker search,
#     before the sandbox mount-timing retry and its ~10s wait, before any clone or pull. Off
#     therefore costs one string comparison. Off means off in every project, with no exceptions
#     — a project that explicitly names a repo does NOT load. Local can only ever VETO (a
#     project `none` still beats a global on); it can never override a global off. The soft
#     reading, where a configured project opts back in, was considered and rejected: it makes
#     "off" mean "nothing loads unless something asked", which is not what a kill switch says.
#   * It is a variable of its own, NOT a user-level PROJECT_CONTEXT_REPO: lookup_repo() reads
#     that one first and returns immediately, so a user-level value would beat every project's
#     settings file and every marker, and would take connection-gate.mjs's policy lookup down
#     with it — a safety mechanism switched off by a convenience setting. Never use or document
#     that form as a shortcut for this.
#   * --refresh is exempt and still loads. An explicit hand-invocation is the user asking out
#     loud, and going quiet on them would be exactly the silent lie this script is written to
#     avoid. Deliberately different from the project-level opt-out below, which answers
#     --refresh with "nothing to refresh": there `none` means there IS no repo, whereas off
#     here means not AUTOMATICALLY. Different facts, different answers.
#   * It fails OPEN. Unset, empty, or anything outside the opt-out vocabulary (`1`, `yes`,
#     `maybe`, a typo) means on — today's behaviour, byte for byte. Silence must be something
#     the user asked for and never something a typo caused, and "not configured" must stay
#     distinguishable from "deliberately off".
#
# Silent exit 0: no banner, no warning, and no "no context repo configured" payload either —
# off is genuinely silent, not merely repo-less.
if [ "${1:-}" != "--refresh" ] && is_optout "${CONTEXT_KIT_AUTOLOAD:-}"; then
  exit 0
fi

# ------------------------------------------------------------ workspace: a freshness check only
# Inside a workspace (the nearest .claude/workspace.json — ADR 0002) there is nothing to LOAD:
# Claude Code already reads CLAUDE.md from the working dir and every parent, `@` imports
# included, so the workspace's memory and glossary arrive without this hook. Printing them here
# as well would load them twice. What Claude Code cannot tell anyone is that the checkout it is
# reading is behind its origin — a teammate pushed memory.md an hour ago and this session answers
# from the old one. So in a workspace this hook does exactly one thing: a capped `git fetch`, and
# one line when the workspace is behind (or has diverged). Up to date, it prints NOTHING — a
# line on every session would be read once and then never again, which is how the one that
# matters gets missed.
#
# What it deliberately does not do, each a failure the legacy loader below has to guard against:
#   * Pull. Fetch moves remote-tracking refs only; the working tree is the user's, and a pull at
#     session start can autostash, conflict or move a branch under an editor that has it open.
#     The warning names the command instead.
#   * Retry with a token. The legacy loader clones repos the user never cloned; a workspace is a
#     checkout they made, so their own credential helper already works for it. A failure here is
#     reported as one line rather than worked around.
#   * Run under --refresh. refresh-context is still the legacy route's skill; a workspace session
#     that runs it gets exactly what it got before this branch existed.
#
# Whether this IS a workspace comes from scripts/workspace-root.sh --no-fallback — the same walk
# every other resolver uses, never a second copy of its rules — and --no-fallback because without
# it "not a workspace" is answered by context-repo.sh, which may clone a repo just to say no. A
# malformed nearest workspace.json is not a workspace (the resolver's rule), so it falls through
# to the legacy loader, as the resolver does. If scripts/ was dropped by packaging (see the
# inline resolver below), the same: legacy, which is what every session got before.
#
# Never prompts (GIT_TERMINAL_PROMPT=0, stdin from /dev/null), never exits non-zero, and never
# runs past CONTEXT_KIT_FETCH_TIMEOUT seconds (default 10 — a third of the legacy pull's 30,
# because a fetch with nothing to transfer is one round trip, and this one only ever warns).
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
  # on stock macOS, where the legacy loader runs uncapped — and "never hangs past the cap" is the
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

if [ "${1:-}" != "--refresh" ] && [ -f "$HERE/../scripts/workspace-root.sh" ]; then
  WS_ROOT="$(bash "$HERE/../scripts/workspace-root.sh" --no-fallback 2>/dev/null)" || WS_ROOT=""
  if [ -n "$WS_ROOT" ]; then
    WS_NOTE="$(workspace_freshness "$WS_ROOT")"
    # One line to BOTH readers when there is one: systemMessage puts it in front of the user,
    # who otherwise never sees a SessionStart hook's output, and additionalContext tells the
    # model, so that it can qualify an answer drawn from memory.md. Plain text where there is no
    # node, as the legacy emitter below degrades.
    if [ -n "$WS_NOTE" ]; then
      node -e '
        process.stdout.write(JSON.stringify({
          systemMessage: process.argv[1],
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: process.argv[1] },
        }));
      ' "$WS_NOTE" 2>/dev/null || printf '%s\n' "$WS_NOTE"
    fi
    exit 0
  fi
fi
# Not a workspace: the legacy context-repo loader, unchanged, until the last context repo is
# migrated (ADR 0002's transition). Everything below this line goes with it.

# In step with scripts/context-repo.sh: which context repo is PROJECT_CONTEXT_REPO
# — env var, else the project's .claude
# settings files (laptop — the committed settings.json rides along in the checkout), else a
# one-line marker file (Cowork — attached project files are the only channel into its
# sandbox, and env vars cannot be set there). Deliberately NO default: an unconfigured
# project must say so — falling back to some other project's repo loads the WRONG context.
# A project that will never have one sets the value to `none` and this hook goes silent.
proj="${CLAUDE_PROJECT_DIR:-$PWD}"
settings_key() {  # $1 = file, $2 = json key
  sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1
}
marker_repo() {
  # A marker is either one plain "owner/repo" line, or a JSON object (context-project.json)
  # whose "contextRepo" key names the repo and whose optional "connections" map names the
  # MCP connection per provider — one name, or a map of resource owner to name where a
  # project spans two. Mirrored here verbatim, so both shapes reach a sandbox. Sniff the first byte rather than trusting the filename.
  case "$(head -c 1 "$1" 2>/dev/null)" in
    "{") settings_key "$1" contextRepo ;;
    *)   head -n 1 "$1" 2>/dev/null | tr -d ' \t\r\n' ;;
  esac
}
# Thread routing, in step with scripts/context-repo.sh --threads: WHERE this project's working
# notes go, which is a different question from where its context lives. `repo` = .claude/threads/
# inside the working repo, `context` = threads/ in the context repo, absent = `auto` (save-thread
# picks by audience, the historical behaviour). It exists for repos SHARED as tools, where the
# repo layer's travelling property inverts and a dated working note would ship to everyone who
# clones the thing. Only the JSON markers are read — a one-line marker has nowhere to put this.
# One deliberate difference from the resolver: an unrecognised value falls back to `auto` in
# silence here. The resolver names it on stderr, which is where a misconfiguration should be
# reported; a hook that writes to stderr on every session of a mistyped repo is just noise.
normalise_threads() {
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -d ' \t\r\n')" in
    repo)            echo repo ;;
    context|project) echo context ;;
    *)               echo auto ;;
  esac
}
lookup_threads() {
  local t="${PROJECT_CONTEXT_THREADS:-}"
  for _f in "$proj/.claude/settings.local.json" "$proj/.claude/settings.json"; do
    [ -z "$t" ] && t="$(settings_key "$_f" PROJECT_CONTEXT_THREADS)"
  done
  for _m in "$proj/.claude/context-project.json" "$proj/context-project.json" \
            "$proj"/docs/context-project.json /mnt/project/context-project.json \
            "$HOME"/mnt/.projects/*/docs/context-project.json "$HOME"/mnt/uploads/context-project.json \
            "$proj"/../../.project-cache/*/docs/context-project.json; do
    [ -z "$t" ] && [ -f "$_m" ] && t="$(settings_key "$_m" threads)"
  done
  normalise_threads "$t"
}
lookup_repo() {  # line 1: owner/repo (or empty); line 2: the marker file it came from (or empty)
  local r=""
  r="${PROJECT_CONTEXT_REPO:-}"
  [ -n "$r" ] && { printf '%s\n\n' "$r"; return; }
  for _f in "$proj/.claude/settings.local.json" "$proj/.claude/settings.json"; do
    r="$(settings_key "$_f" PROJECT_CONTEXT_REPO)"
    [ -n "$r" ] && { printf '%s\n\n' "$r"; return; }
  done
  for _m in "$proj/.claude/context-project.json" \
            "$proj/context-project.json" "$proj/.context-repo" "$proj/context-repo.txt" \
            "$proj"/docs/context-project.json "$proj"/docs/.context-repo "$proj"/docs/context-repo.txt \
            /mnt/project/context-project.json /mnt/project/.context-repo /mnt/project/context-repo.txt \
            "$HOME"/mnt/.projects/*/docs/context-project.json "$HOME"/mnt/.projects/*/docs/.context-repo "$HOME"/mnt/.projects/*/docs/context-repo.txt \
            "$HOME"/mnt/uploads/context-project.json "$HOME"/mnt/uploads/.context-repo "$HOME"/mnt/uploads/context-repo.txt \
            "$proj"/../../.project-cache/*/docs/context-project.json "$proj"/../../.project-cache/*/docs/.context-repo "$proj"/../../.project-cache/*/docs/context-repo.txt; do
    if [ -f "$_m" ]; then
      r="$(marker_repo "$_m")"
      [ -n "$r" ] && { printf '%s\n%s\n' "$r" "$_m"; return; }
    fi
  done
  # Last resort, sandbox layouts drift: a bounded search of the mount areas only — never the
  # working tree, which on a laptop can be a huge repo this must not crawl at session start.
  # (.project-cache is the Windows-host Cowork area; the -d guard skips it everywhere else.)
  for _d in "$HOME/mnt" /mnt "$proj/../../.project-cache"; do
    if [ -d "$_d" ]; then
      _found="$(find "$_d" -maxdepth 5 \( -name context-project.json -o -name context-repo.txt -o -name .context-repo \) 2>/dev/null | head -n 1)"
      if [ -n "$_found" ]; then
        r="$(marker_repo "$_found")"
        [ -n "$r" ] && { printf '%s\n%s\n' "$r" "$_found"; return; }
      fi
    fi
  done
}
_res="$(lookup_repo)"
CONTEXT_REMOTE="$(printf '%s' "$_res" | sed -n 1p)"
MARKER_SRC="$(printf '%s' "$_res" | sed -n 2p)"

# Opt-out. Some projects have no shared context and never will, and for those the
# "no context repo configured" payload — which orders the model to go hunting for a marker
# before it answers anything — is pure noise on every single session. Naming the sentinel
# `none` wherever a repo name would go (PROJECT_CONTEXT_REPO, a .claude settings env block,
# or a marker file) says so deliberately, and this exits silently: no payload, no banner, no
# marker search, no sandbox retry. Distinct from *unconfigured*, which still speaks up —
# the whole point is that only a human can tell those two apart.
if is_optout "$CONTEXT_REMOTE"; then
  # --refresh is somebody asking out loud, so it answers rather than going quiet on them.
  [ "${1:-}" = "--refresh" ] && \
    echo "This project has opted out of a shared context repo (configured as \"$CONTEXT_REMOTE\"). Nothing to refresh — remove that setting to re-enable."
  exit 0
fi

# Mount-timing race (observed 2026-08-02): in cloud sandboxes the project's attached files
# can mount AFTER SessionStart fires — the identical lookup succeeds moments later. So if
# nothing named a repo AND this looks like a sandbox, wait briefly and retry rather than
# declaring the project unconfigured. Laptops never match the sandbox test, so a genuinely
# unconfigured local project pays nothing; a sandbox one pays at most ~10s once per session.
if [ -z "$CONTEXT_REMOTE" ]; then
  case "$HOME" in
    /sessions/*) _sandbox=1 ;;
    *) _sandbox="${CLAUDE_CODE_HOST_HTTP_PROXY_PORT:+1}" ;;
  esac
  if [ -n "${_sandbox:-}" ]; then
    for _try in 1 2 3 4 5 6 7 8 9 10; do
      sleep 1
      _res="$(lookup_repo)"
      CONTEXT_REMOTE="$(printf '%s' "$_res" | sed -n 1p)"
      MARKER_SRC="$(printf '%s' "$_res" | sed -n 2p)"
      [ -n "$CONTEXT_REMOTE" ] && break
    done
  fi
fi
# A JSON marker can also name which MCP connection serves each provider — pull the GitHub
# one so the hand-off payload can say exactly which connector to read the repo with.
GITHUB_CONN=""
[ -n "${MARKER_SRC:-}" ] && GITHUB_CONN="$(settings_key "$MARKER_SRC" github)"
# Resolved here, once, so the payload can state the routing rather than leaving each skill to
# re-derive it — and so a session in a shared tool repo is told before it writes anything.
THREADS_MODE="$(lookup_threads)"
# The real resolver re-derives this identically; exporting pins both to the same answer even
# if only one copy is ever updated.
export PROJECT_CONTEXT_REPO="$CONTEXT_REMOTE"
RESOLVER="$HERE/../scripts/context-repo.sh"

# Unknown arguments are ignored rather than rejected: this runs as a SessionStart hook, and a
# hook that exits non-zero over an argument it didn't recognise breaks every session.
MODE="session"
[ "${1:-}" = "--refresh" ] && MODE="refresh"

# Why the refresh failed, if it did. A silently stale memory.md is worse than a slow session:
# the model reads it as current and nobody knows. Captured here, reported at the top of the
# output. Empty means the refresh was clean.
REFRESH_WARNING=""
ERRFILE="${TMPDIR:-/tmp}/context-kit-ctx-$$.err"
trap 'rm -f "$ERRFILE"' EXIT

if [ -z "$CONTEXT_REMOTE" ]; then
  # Nothing to resolve, and the inline fallback must not run either — its origin-URL match
  # against an empty remote would adopt whatever repo the session happens to sit in.
  ROOT=""
elif [ -f "$RESOLVER" ]; then
  # The resolver prints the path on stdout and any trouble on stderr, so they are captured
  # separately — stdout must stay path-only for the callers that consume it.
  ROOT="$(bash "$RESOLVER" 2>"$ERRFILE")" || ROOT=""
  if [ -s "$ERRFILE" ]; then
    REFRESH_WARNING="$(tr '\n' '; ' < "$ERRFILE" | sed -e 's/context-repo\.sh: //g' -e 's/[; ]*$//')"
  fi
else
  # Fallback: resolve inline. The plugin installer is only documented to ship skills/,
  # commands/, agents/ and hooks/ — a top-level scripts/ directory may not survive
  # packaging. Without this branch the whole session context silently disappears when it
  # doesn't. Keep in step with scripts/context-repo.sh; that file is the real one.
  # Clone dir, in step with context-repo.sh: PROJECT_CONTEXT_DIR pins it outright, else
  # ~/.context/<owner>/<repo> — owner as its own directory level, a flat "<owner>-<repo>" slug
  # until 2026-08-11. Both places must agree, or the hook and the skills resolve to different
  # checkouts of the same repo.
  if [ -n "${PROJECT_CONTEXT_DIR:-}" ]; then
    CLONE_DIR="$PROJECT_CONTEXT_DIR"
  else
    CLONE_DIR="$HOME/.context/$CONTEXT_REMOTE"
  fi
  cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

  # Capped like context-repo.sh's pull, so a half-open connection can't stall session start.
  # `timeout` is GNU coreutils and absent on stock macOS; fall back to unbounded there.
  TIMEOUT_BIN="$(command -v timeout 2>/dev/null || true)"
  # Credentials, in step with context-repo.sh: the repo is private, so an environment with no
  # git credential helper fails silently. Plain call first, token only on an auth failure.
  # The token goes through a transient helper and the environment — never into the remote URL
  # or .git/config, so nothing this prints can carry it.
  TOKEN=""; TOKEN_TRIED=0
  HELPER='!f() { echo username=x-access-token; echo "password=$CONTEXT_TOKEN"; }; f'
  resolve_token() {
    [ "$TOKEN_TRIED" -eq 1 ] && { [ -n "$TOKEN" ]; return; }
    TOKEN_TRIED=1
    TOKEN="${CONTEXT_GIT_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
    if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then
      TOKEN="$(gh auth token 2>/dev/null || true)"
    fi
    [ -n "$TOKEN" ]
  }
  run_git() {   # run_git <capped 0|1> <git args...>
    local capped="$1"; shift
    if [ "$capped" = 1 ] && [ -n "$TIMEOUT_BIN" ]; then
      GIT_TERMINAL_PROMPT=0 CONTEXT_TOKEN="$TOKEN" \
        "$TIMEOUT_BIN" "${CONTEXT_GIT_TIMEOUT:-30}" git "$@" >/dev/null 2>&1
    else
      GIT_TERMINAL_PROMPT=0 CONTEXT_TOKEN="$TOKEN" git "$@" >/dev/null 2>&1
    fi
  }
  git_net() {   # same, retried once with a token
    local capped="$1" rc; shift
    run_git "$capped" "$@" && return 0
    rc=$?
    # 124 is `timeout` killing it. Never retry that: the retry would double the very budget the
    # cap exists to enforce, and a timeout is not an authentication problem anyway. (The real
    # resolver reaches the same conclusion by matching git's stderr, which it captures.)
    [ "$rc" = 124 ] && return 1
    resolve_token || return 1
    run_git "$capped" -c credential.helper= -c "credential.helper=$HELPER" "$@"
  }

  origin_url="$(git -C "$cwd" remote get-url origin 2>/dev/null)" || origin_url=""
  ROOT=""
  case "$origin_url" in
    *"$CONTEXT_REMOTE"*)
      ROOT="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || echo "$cwd")" ;;
    *)
      if [ -d "$CLONE_DIR/.git" ]; then
        ROOT="$CLONE_DIR"
      else
        mkdir -p "$(dirname "$CLONE_DIR")" 2>/dev/null || true
        # A failed clone has to carry its reason forward too, or the "context unavailable"
        # message below is the whole story the user gets — and "unavailable" reads as "the
        # repo is empty" when it actually means "nobody here can authenticate".
        if git_net 0 clone --depth 1 "https://github.com/$CONTEXT_REMOTE.git" "$CLONE_DIR"; then
          ROOT="$CLONE_DIR"
        elif resolve_token; then
          REFRESH_WARNING="clone failed even with a token (expired, or no access to this repo?)"
        else
          REFRESH_WARNING="clone failed, and there is no git credential in this environment for a private repo — set CONTEXT_GIT_TOKEN or sign in with 'gh auth login'"
        fi
      fi ;;
  esac

  if [ -n "$ROOT" ] && ! git_net 1 -C "$ROOT" pull --ff-only --autostash; then
    if resolve_token; then
      REFRESH_WARNING="pull failed or timed out after ${CONTEXT_GIT_TIMEOUT:-30}s, including a retry with a token; working from the local state"
    else
      REFRESH_WARNING="pull failed after ${CONTEXT_GIT_TIMEOUT:-30}s, and there is no git credential in this environment for a private repo — set CONTEXT_GIT_TOKEN or sign in with 'gh auth login'; working from the local state"
    fi
  fi
fi

# ----------------------------------------------------------- context repo marker
# Keep a context-project.json in the CONTEXT REPO's own .claude/, generated from whatever
# named the repo this session — contextRepo from the resolved config, connections mirrored
# from the repo's context.json. ONE canonical marker per context repo, committed alongside
# `.claude/settings.json`, rather than a generated copy in every project that uses it: a
# Cowork sandbox sees neither a checkout nor an env var and so cannot make its own, and the
# file to attach to the Cowork project is this one. Written whichever channel named the repo
# — the content is derived entirely from the context repo, so it is the same file either way
# — but unknown keys in an existing marker are preserved, so anything hand-added survives
# the refresh. Silent on every failure path.
MARKER_NOTE=""
if [ -n "$CONTEXT_REMOTE" ] && [ -n "$ROOT" ] && [ -f "$ROOT/context.json" ] \
   && command -v node >/dev/null 2>&1; then
  mkdir -p "$ROOT/.claude" 2>/dev/null || true
  MARKER_NOTE="$(node -e '
    const fs = require("fs");
    const [ctxPath, repo, out] = process.argv.slice(1);
    try {
      const ctx = JSON.parse(fs.readFileSync(ctxPath, "utf8").replace(/^﻿/, ""));
      let prev = null, marker = {};
      try {
        prev = fs.readFileSync(out, "utf8");
        const held = JSON.parse(prev.replace(/^﻿/, ""));
        // Merge, do not replace: a marker may carry keys this hook knows nothing about.
        if (held && typeof held === "object" && !Array.isArray(held)) marker = held;
      } catch { /* absent or unparseable — rewrite it from scratch */ }
      marker.contextRepo = repo;
      if (ctx.connections && Object.keys(ctx.connections).length) marker.connections = ctx.connections;
      const next = JSON.stringify(marker, null, 2) + "\n";
      // Compare newline-insensitively. A context repo whose .gitattributes marks .json as
      // `text` checks the marker out with CRLF on Windows, and a byte-exact test would
      // rewrite it to LF every single session — a permanently dirty repo and a "refreshed"
      // line on every start, for a file whose content never changed.
      if (prev === null || prev.replace(/\r\n/g, "\n") !== next) {
        fs.writeFileSync(out, next);
        process.stdout.write(prev === null ? "created" : "refreshed");
      }
    } catch { /* a marker we cannot write is not worth failing a session over */ }
  ' "$ROOT/context.json" "$CONTEXT_REMOTE" "$ROOT/.claude/context-project.json" 2>/dev/null || true)"
fi

# ---------------------------------------------------------------- emission
# In session mode, wrap the payload in the hook JSON envelope when node is available:
# additionalContext carries the context to the model exactly as plain stdout would, and
# systemMessage puts a one-line status in front of the USER — who otherwise cannot see
# whether the context loaded, went stale, or failed, because the payload itself is
# injected invisibly. The STALE case is the whole point: a silently stale context is
# the one failure mode that actively misleads. --refresh keeps plain text (the model
# reads that stdout directly), and no-node degrades to plain text rather than failing.
OUT_TMP="${TMPDIR:-/tmp}/context-kit-out-$$.txt"
INC_TMP="${TMPDIR:-/tmp}/context-kit-inc-$$.txt"
trap 'rm -f "$ERRFILE" "$OUT_TMP" "$INC_TMP"' EXIT

emit() {  # $1 = one-line user-facing status; the body is already in $OUT_TMP
  if [ "$MODE" = "refresh" ] || ! command -v node >/dev/null 2>&1; then
    cat "$OUT_TMP"
  else
    node -e '
      const fs = require("fs");
      const body = fs.readFileSync(process.argv[1], "utf8");
      process.stdout.write(JSON.stringify({
        systemMessage: process.argv[2],
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: body },
      }));
    ' "$OUT_TMP" "$1" 2>/dev/null || cat "$OUT_TMP"
  fi
  exit 0
}

if [ -z "$CONTEXT_REMOTE" ]; then
  {
    echo "No context repo was configured for this project at session start."
    echo
    echo "MANDATORY FIRST ACTION of your first response — before answering the user's message,"
    echo "whatever it is (even a bare greeting): look for a marker this hook may have missed."
    echo "Run: find ~/mnt /mnt . -maxdepth 5 -name 'context-project.json' -o -name '.context-repo' 2>/dev/null"
    echo "If a marker is found: a context-project.json's \"contextRepo\" key names this project's"
    echo "context repo, and its optional \"connections\" map names the MCP connection per provider"
    echo "(a provider may name several, keyed by resource owner)"
    echo "— use only those; a plain .context-repo marker is one owner/repo line. Read that"
    echo "repo's memory.md and context.json (git if available, else the GitHub MCP"
    echo "connector), treat them as the session context, and tell the user in one line which"
    echo "repo loaded and by which route. Mention context-setup can diagnose why the hook missed it."
    echo
    echo "Only if no marker exists either: this project has no shared context — say so, do NOT"
    echo "guess a repo, and continue with the user's message. Configure one via"
    echo "PROJECT_CONTEXT_REPO, a .claude/settings.json env block, or an attached"
    echo "context-project.json marker; the context-setup skill walks the user through it."
  } > "$OUT_TMP"
  emit "⚠ No context repo configured — run context-setup, or add a context-project.json marker / PROJECT_CONTEXT_REPO setting"
fi

if [ -z "$ROOT" ] || [ ! -f "$ROOT/memory.md" ]; then
  {
    echo "This project's context repo is $CONTEXT_REMOTE, but git could not fetch it here."
    [ -n "$REFRESH_WARNING" ] && echo "Reason: $REFRESH_WARNING"
    echo
    if [ -n "$GITHUB_CONN" ]; then
      echo "This project's marker declares its GitHub connection: use the MCP server named \"$GITHUB_CONN\" — no other."
    fi
    CONN_PHRASE="${GITHUB_CONN:+the \"$GITHUB_CONN\" connection}"
    CONN_PHRASE="${CONN_PHRASE:-the GitHub MCP connector}"
    echo "MANDATORY FIRST ACTION of your first response — before answering the user's message,"
    echo "whatever it is (even a bare greeting): read $CONTEXT_REMOTE's memory.md (and"
    echo "context.json, plus threads/INDEX.md if present) with $CONN_PHRASE,"
    echo "treat that as the session context, and CONFIRM to the user on the first line:"
    echo "\"✓ Shared context loaded — $CONTEXT_REMOTE · via ${GITHUB_CONN:-GitHub connector}\". This is the"
    echo "NORMAL route in cloud sandboxes, not an error path. Once context.json is loaded, its"
    echo "connections block governs every provider (Notion included) — use only what it declares."
    echo
    echo "Only if there is no GitHub connector either: say the context is unavailable and why."
    echo "Never answer from a guess or another project's context. Skills still load from the plugin."
    :
  } > "$OUT_TMP"
  emit "→ Context repo: $CONTEXT_REMOTE — loading via ${GITHUB_CONN:-the GitHub connector} in the first response (git has no credentials in this environment)"
fi

# Lists the newest threads in a directory, with titles. Shared by the project layer, the
# per-repo layer and each included repo, so the title-extraction awk exists once: it was
# duplicated the moment a second thread location appeared, and a title parser that drifts
# between two copies would print the literal front-matter fence in one of them with nobody
# noticing which.
#   list_threads DIR DISPLAY_PREFIX MAX
list_threads() {
  _d="$1"; _pfx="$2"; _max="${3:-6}"
  find "$_d" -maxdepth 1 -name '*.md' ! -name 'README.md' ! -name 'INDEX.md' ! -name '*-asst-*' -print 2>/dev/null     | sort | tail -n "$_max"     | while IFS= read -r f; do
        title="$(awk '
          NR == 1 && /^---[[:space:]]*$/ { fm = 1; next }
          fm == 1 && /^---[[:space:]]*$/ { fm = 0; next }
          fm == 1 && /^title:[[:space:]]/ { sub(/^title:[[:space:]]*/, ""); print; exit }
          fm == 0 && /^#+[[:space:]]/ { sub(/^#+[[:space:]]*/, ""); print; exit }
        ' "$f" 2>/dev/null | sed -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//')"
        [ -z "$title" ] && title="$(basename "$f" .md)"
        echo "   - ${_pfx}$(basename "$f") — ${title}"
      done
}

# Names the terms a glossary defines, without loading their definitions. The name is what makes
# the file findable — "is X defined here?" is answered by the list, and the entry itself is only
# needed once the answer is yes — and the list costs a tenth of the text: net-flex/context's
# generated 71-term glossary is 39 KB whole and under 4 KB as names. Below SMALL_GLOSSARY the
# pointer would cost more than the file it points at, so the file wins and is loaded entire;
# that threshold is the point of the function, not a special case bolted onto it.
#
# Two glossary shapes are in the wild and both are matched: "### Term — Status" headings (the
# form a Notion mirror generates) and the template's "**Term** — definition" paragraphs. A file
# in neither shape is reported as unread rather than silently summarised to nothing: a term list
# that quietly omits terms is worse than none, because it reads as complete.
#   glossary_terms FILE LABEL MAX
_gloss_scan() {  # FILE SED_EXPR -> one term per line, trailing space and blanks dropped
  sed -n -e "$2" "$1" 2>/dev/null | sed -e 's/[[:space:]]*$//' | grep -v '^[[:space:]]*$'
}
glossary_terms() {
  _g="$1"; _lbl="$2"; _max="${3:-120}"
  _sz="$(wc -c < "$_g" 2>/dev/null | tr -d ' ')"
  if [ "${_sz:-0}" -le "${SMALL_GLOSSARY:-4096}" ] 2>/dev/null; then
    echo "----- $_lbl -----"
    cat "$_g"
    echo "----- end $_lbl -----"
    return
  fi
  # Strictly ONE shape per file, tried in order, because mixing them is what goes wrong: a
  # heading-shaped glossary also opens with prose like "**Status** reads: ..." and that bold
  # lead would enter the list as a term the file does not define. h3/h4 first (the terms,
  # wherever sections take h2), then the template's "**Term** — definition" paragraphs, then
  # h2 for a glossary with no sections at all.
  _terms="$(_gloss_scan "$_g" 's/^#\{3,4\}[[:space:]]\{1,\}//p')"
  [ -z "$_terms" ] && _terms="$(_gloss_scan "$_g" 's/^\*\*\([^*]\{1,\}\)\*\*.*$/\1/p')"
  [ -z "$_terms" ] && _terms="$(_gloss_scan "$_g" 's/^##[[:space:]]\{1,\}//p')"
  if [ -z "$_terms" ]; then
    echo "$_lbl is $_sz bytes and is NOT loaded here; its shape was not recognised, so no term list could be built. Read the file before relying on any project vocabulary."
    return
  fi
  _n="$(printf '%s\n' "$_terms" | grep -c . )"
  echo "$_lbl defines these $_n terms (the definitions are NOT loaded here, $_sz bytes). Read the"
  echo "file before using one of them in a sense of your own; do not answer from silence:"
  printf '%s\n' "$_terms" | head -n "$_max" | sed -e 's/^/   - /'
  [ "${_n:-0}" -gt "$_max" ] 2>/dev/null && echo "   (+$((_n - _max)) more — this list is truncated, so read glossary.md rather than concluding a term is absent)"
}

# ----------------------------------------------------------- included context repos
# The cross-project layer: a context repo whose context.json declares
#   "include": ["owner/repo", ...]
# also gets each named repo's memory.md loaded read-only, plus POINTERS to its glossary (term
# names, no definitions) and its threads (the six newest, by title) — the same shape the primary
# repo's own layer uses, since an included repo cannot be the one that gets loaded more eagerly.
# ONE level only (an included repo's own include list is ignored, by construction: only
# the primary repo's context.json is ever read). The list is explicit and committed; nothing
# is ever discovered from the filesystem. An *accidental* cross-project load is the failure
# mode this plugin exists to prevent, so the deliberate one must be spelled out in config.
# Entries are owner/repo names only — the contract stays route-agnostic, so a sandbox session
# reading repos over the GitHub API (no git) can honour the same list.
#
# Each include resolves and pulls under the same rules as the primary repo (ff-only, capped,
# token via transient helper — the resolver owns all of that) and degrades PER REPO: a stale
# pull serves that repo's local copy under its own STALE warning; an unreachable repo is a
# loud absence, never a silent one. A context.json with no include key pays nothing here.
# Parsing the array needs node (the sed used for scalar keys cannot read a JSON list); if
# node is missing the payload says the includes were skipped rather than quietly omitting
# them. The sentinel filter below mirrors is_optout() — keep them in step.
INC_NAMES=""; INC_STALE=""; INC_NOTE=""
: > "$INC_TMP" 2>/dev/null || true
if [ -n "$ROOT" ] && [ -f "$ROOT/context.json" ] && grep -q '"include"' "$ROOT/context.json" 2>/dev/null; then
  if ! command -v node >/dev/null 2>&1; then
    INC_NOTE="context.json declares an include list, but node is unavailable, so the cross-project context was NOT loaded this session — say so before answering anything that spans projects."
  else
    INCLUDE_LIST="$(node -e '
      const fs = require("fs");
      try {
        const raw = fs.readFileSync(process.argv[1], "utf8");
        const ctx = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        const seen = new Set();
        for (const e of Array.isArray(ctx.include) ? ctx.include : []) {
          if (typeof e !== "string") continue;
          const v = e.trim();
          if (["none", "off", "false", "no", "-", "disabled"].includes(v.toLowerCase())) continue;
          if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(v)) continue;
          if (v === process.argv[2] || seen.has(v)) continue;
          seen.add(v);
          console.log(v);
        }
      } catch { /* an unparseable context.json already has bigger problems; load nothing */ }
    ' "$ROOT/context.json" "$CONTEXT_REMOTE" 2>/dev/null)"
    for inc in $INCLUDE_LIST; do
      INC_ROOT=""; INC_WARN=""
      if [ -f "$RESOLVER" ]; then
        # The resolver reads PROJECT_CONTEXT_REPO first, so overriding it per call reuses
        # every rule the primary repo got. PROJECT_CONTEXT_DIR must be cleared: it pins the
        # clone path outright, and with several repos in play it can only name one of them.
        INC_ROOT="$(PROJECT_CONTEXT_DIR= PROJECT_CONTEXT_REPO="$inc" bash "$RESOLVER" 2>"$ERRFILE")" || INC_ROOT=""
        [ -s "$ERRFILE" ] && INC_WARN="$(tr '\n' '; ' < "$ERRFILE" | sed -e 's/context-repo\.sh: //g' -e 's/[; ]*$//')"
      else
        # Inline fallback (packaging dropped scripts/): reuse the run_git/git_net helpers the
        # primary repo's fallback branch defined above — that branch always ran if we are here.
        INC_DIR="$HOME/.context/$inc"
        if [ -d "$INC_DIR/.git" ]; then
          INC_ROOT="$INC_DIR"
        else
          mkdir -p "$(dirname "$INC_DIR")" 2>/dev/null || true
          if git_net 0 clone --depth 1 "https://github.com/$inc.git" "$INC_DIR"; then
            INC_ROOT="$INC_DIR"
          else
            INC_WARN="clone failed (offline, or no git credential for a private repo?)"
          fi
        fi
        if [ -n "$INC_ROOT" ] && ! git_net 1 -C "$INC_ROOT" pull --ff-only --autostash; then
          INC_WARN="pull failed or timed out after ${CONTEXT_GIT_TIMEOUT:-30}s"
        fi
      fi
      {
        echo "=== Included context: $inc (read-only) ==="
        if [ -z "$INC_ROOT" ]; then
          echo "!!! UNAVAILABLE — $inc could not be reached: ${INC_WARN:-no checkout and the clone failed}"
          echo "The combined context is incomplete. Say so before answering anything that depends on $inc."
        else
          if [ -n "$INC_WARN" ]; then
            INC_AGE="$(git -C "$INC_ROOT" log -1 --format='%cd' --date=relative 2>/dev/null)" || INC_AGE=""
            echo "!!! WARNING — THIS INCLUDED CONTEXT MAY BE STALE !!!"
            echo "The refresh of $inc did not complete: $INC_WARN"
            echo "Showing the local copy${INC_AGE:+ — its most recent commit is dated $INC_AGE}."
            echo
          fi
          # memory.md whole; glossary and threads as POINTERS. The primary repo has always
          # worked that way — its glossary is one line and its threads are the six newest — and
          # an included repo is by construction the secondary one, so loading it *more* eagerly
          # than the repo the session is actually in was backwards. It was also the largest
          # single item in the payload: net-flex/context's glossary alone put 39 KB into every
          # session that included it, before a word of the primary context had been read.
          #
          # memory.md stays whole for the reason the primary layer keeps it whole: a fact nobody
          # is told about is not lazy, it is lost. A glossary and a thread index are different in
          # kind — each is a *list of names*, so the names alone say what is in there, which is
          # what a pointer has to do to be safe.
          if [ -f "$INC_ROOT/memory.md" ]; then
            echo "----- $inc · memory.md -----"
            cat "$INC_ROOT/memory.md"
            echo "----- end $inc · memory.md -----"
          else
            echo "($inc has no memory.md)"
          fi
          echo
          if [ -f "$INC_ROOT/glossary.md" ]; then
            glossary_terms "$INC_ROOT/glossary.md" "$inc · glossary.md" 120
          else
            echo "($inc has no glossary.md)"
          fi
          echo
          if [ -d "$INC_ROOT/threads" ]; then
            echo "$inc working threads (one topic per file; newest last):"
            list_threads "$INC_ROOT/threads" "threads/" 6
            [ -f "$INC_ROOT/threads/INDEX.md" ] && echo "   (full list: threads/INDEX.md under $INC_ROOT, NOT loaded here)"
          else
            echo "($inc has no threads/)"
          fi
          echo
          echo "Depth on demand, still read-only, under $INC_ROOT: the whole of glossary.md and threads/INDEX.md summarised above, plus full threads/, meetings/ and any notion/ mirror."
        fi
        echo
      } >> "$INC_TMP"
      INC_NAMES="${INC_NAMES:+$INC_NAMES, }$inc"
      if [ -z "$INC_ROOT" ] || [ -n "$INC_WARN" ]; then INC_STALE=1; fi
    done
  fi
fi

# Per-repo threads: .claude/threads/ in the WORKING directory, a different layer from the
# project's context repo. A code repo's narrative travels with its own clone and is readable by
# anyone who has that repo without the context repo, which is the whole reason it lives there
# rather than as a tag in the project layer.
#
# Skipped when the working directory IS the context repo, where the two would be the same
# material listed twice under different names.
REPO_THREADS=""
if [ -n "$ROOT" ] && [ -d "$proj/.claude/threads" ]; then
  _pp="$(cd "$proj" 2>/dev/null && pwd -P)"; _rp="$(cd "$ROOT" 2>/dev/null && pwd -P)"
  [ "$_pp" != "$_rp" ] && REPO_THREADS="$proj/.claude/threads"
fi
REPO_N=0
[ -n "$REPO_THREADS" ] && REPO_N="$(find "$REPO_THREADS" -maxdepth 1 -name '*.md' ! -name 'README.md' ! -name 'INDEX.md' -print 2>/dev/null | wc -l | tr -d ' ')"

# The repo's own durable layer, injected rather than pointed at. A pointer in CLAUDE.md would
# be a hint the model may or may not follow, which is the same failure as a roster sitting in a
# payload nobody reads. Every layer therefore behaves the same way: memory is loaded, threads
# are pointed at. Guarded on the same cwd-is-not-the-context-repo test as the threads above.
REPO_MEMORY=""
if [ -n "$ROOT" ] && [ -f "$proj/.claude/memory.md" ]; then
  _pp="$(cd "$proj" 2>/dev/null && pwd -P)"; _rp="$(cd "$ROOT" 2>/dev/null && pwd -P)"
  [ "$_pp" != "$_rp" ] && REPO_MEMORY="$proj/.claude/memory.md"
fi

# The assistant roster, computed here rather than inside the payload because it has TWO
# consumers: the payload (which the model reads) and systemMessage (which the USER reads). The
# roster was originally emitted into the payload alone, which put it 8% of the way into a 70KB
# block the user never sees — discoverability aimed at the model, when the whole argument for
# the line was that a memory layer the HUMAN forgets to consult does not work.
#
# Read with an INLINE node -e, not scripts/assistants.mjs. Packaging is only documented to ship
# skills/, commands/, agents/ and hooks/, so a call to a .mjs would fail silently and the roster
# would simply never appear. sed cannot do it; these are JSON objects, not scalars.
ASST_NAMES=""; SUP_NAMES=""; ASST_NOTE=""
if [ -n "$ROOT" ] && [ -f "$ROOT/context.json" ] && grep -q '"assistants"\|"supervisors"' "$ROOT/context.json" 2>/dev/null; then
  if command -v node >/dev/null 2>&1; then
    ASST_NAMES="$(node -e '
      const fs = require("fs");
      try {
        const raw = fs.readFileSync(process.argv[1], "utf8");
        const ctx = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        const o = ctx.assistants;
        if (o && typeof o === "object" && !Array.isArray(o)) console.log(Object.keys(o).join(", "));
      } catch { /* an unparseable context.json already has bigger problems */ }
    ' "$ROOT/context.json" 2>/dev/null)"
    SUP_NAMES="$(node -e '
      const fs = require("fs");
      try {
        const raw = fs.readFileSync(process.argv[1], "utf8");
        const ctx = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
        const o = ctx.supervisors;
        if (o && typeof o === "object" && !Array.isArray(o)) console.log(Object.keys(o).join(", "));
      } catch { }
    ' "$ROOT/context.json" 2>/dev/null)"
  else
    # Never a silent absence: "no assistants" and "could not look" must stay distinguishable.
    ASST_NOTE="context.json declares assistants or supervisors, but node is unavailable, so the roster was NOT read this session."
  fi
fi
# Undrained handoff items are a debt created HERE and payable in another repo session. Nothing in
# the target repo can announce them, so the only place the reminder can appear is the repo that
# owes them.
HO_N=0
if [ -d "$ROOT/handoff" ]; then
  HO_N="$(find "$ROOT/handoff" -maxdepth 1 -name '*.md' ! -name 'README.md' ! -name 'INDEX.md' -print 2>/dev/null | wc -l | tr -d ' ')"
fi

# The user-visible half. Names while the list is short enough to read at a glance; a bare count
# once it is not, because a summary line nobody finishes reading is the same failure in a new
# place.
ASST_SUMMARY=""
if [ -n "$ASST_NAMES" ]; then
  ASST_N="$(printf '%s' "$ASST_NAMES" | awk -F', ' '{print NF}')"
  if [ "${ASST_N:-0}" -le 4 ] 2>/dev/null; then
    ASST_SUMMARY=" · assistants: $ASST_NAMES"
  else
    ASST_SUMMARY=" · $ASST_N assistants (/assistant to list)"
  fi
fi
[ -n "$ASST_NOTE" ] && ASST_SUMMARY=" · ⚠ roster not read (no node)"
[ "${HO_N:-0}" -gt 0 ] 2>/dev/null && ASST_SUMMARY="$ASST_SUMMARY · handoff: $HO_N undrained"
[ "${REPO_N:-0}" -gt 0 ] 2>/dev/null && ASST_SUMMARY="$ASST_SUMMARY · repo threads: $REPO_N"

INC_SUMMARY=""
[ -n "$INC_NAMES" ] && INC_SUMMARY=" + included: $INC_NAMES${INC_STALE:+ (some STALE or unavailable)}"
[ -n "$INC_NOTE" ] && INC_SUMMARY=" ⚠ includes skipped (no node)"

{
if [ "$MODE" = "refresh" ]; then
  echo "=== Shared context (re-pulled just now — supersedes the copy loaded at session start) ==="
else
  echo "=== Shared context (auto-loaded at session start) ==="
fi
echo

# Loud, and above memory.md — a warning printed after 200 lines of context is a warning nobody
# reads. `git log --date=relative` says how old the local copy actually is, which is the part
# that decides whether stale matters.
if [ -n "$REFRESH_WARNING" ]; then
  LAST_UPDATED="$(git -C "$ROOT" log -1 --format='%cd' --date=relative 2>/dev/null)" || LAST_UPDATED=""
  echo "!!! WARNING — THIS CONTEXT MAY BE STALE !!!"
  echo "The refresh from $CONTEXT_REMOTE did not complete: $REFRESH_WARNING"
  # Content age, not sync age: the newest commit we hold. Deliberately not "time since last
  # fetch" — reading that portably means date(1), which differs GNU vs BSD.
  echo "Showing the local copy${LAST_UPDATED:+ — its most recent commit is dated $LAST_UPDATED}."
  echo "Anything below may be out of date. Say so before relying on it for a decision, and"
  echo "re-check $CONTEXT_REMOTE (or just start a new session on a working connection)."
  echo
fi
echo "----- memory.md (authoritative durable layer — treat as read) -----"
cat "$ROOT/memory.md"
echo
echo "----- end memory.md -----"
echo
# The deep half of the durable layer. curate-context condenses settled work into
# Archive/history.md and calls it "read on demand, NOT injected each session" — which is lazy
# loading by design, and until now nothing told a session the file existed. A lazy layer nobody
# is told about is not lazy, it is lost, and worse: condensing something out of memory.md made
# it invisible, so the safe move was always to leave memory.md long. That is why one of these
# repos carries 292 lines of durable layer.
#
# So: the section headings, not the content. Enough to know whether the answer is in there and
# to go and read it, at a cost that does not grow with the history itself. Capped, because an
# unbounded list would recreate the problem one layer up.
if [ -f "$ROOT/Archive/history.md" ]; then
  HIST_LINES="$(wc -l < "$ROOT/Archive/history.md" 2>/dev/null | tr -d ' ')"
  echo "Condensed history of settled work in Archive/history.md (${HIST_LINES:-?} lines, NOT loaded here). Read it when a question touches one of these; do not answer from silence if it might be in there:"
  grep -E '^#{2,3} ' "$ROOT/Archive/history.md" 2>/dev/null     | sed -e 's/^#\{1,\}[[:space:]]*/   - /' | head -n 12
  HIST_N="$(grep -cE '^#{2,3} ' "$ROOT/Archive/history.md" 2>/dev/null | tr -d ' ')"
  [ "${HIST_N:-0}" -gt 12 ] 2>/dev/null && echo "   (+$((HIST_N - 12)) more themes)"
fi
[ -f "$ROOT/glossary.md" ] && echo "Vocabulary: see glossary.md in $CONTEXT_REMOTE."
if [ -d "$ROOT/threads" ]; then
  echo "Working threads (one topic per file; newest last):"
  # Assistant threads are excluded from the six. They carry the filename form
  # YYYY-MM-DD-asst-[role]-topic.md precisely so this filter costs one glob and opens no extra
  # file: a working assistant writes daily, and without it would fill every slot within a week,
  # pushing the repo's ordinary threads out of every session start — silently, since the list
  # never says how much it is hiding. Counted below instead; /assistant loads a role's history.
  list_threads "$ROOT/threads" "threads/" 6
  ASST_N="$(find "$ROOT/threads" -maxdepth 1 -name '*-asst-*.md' -print 2>/dev/null | wc -l | tr -d ' ')"
  [ "${ASST_N:-0}" -gt 0 ] 2>/dev/null && echo "   (+$ASST_N assistant thread(s), not listed — adopt the role with /assistant)"
  [ -f "$ROOT/threads/INDEX.md" ] && echo "   (full list: threads/INDEX.md)"
fi

# The repo's own durable layer, before its threads, mirroring the order the project layer uses.
if [ -n "$REPO_MEMORY" ]; then
  echo
  echo "----- this repo's own .claude/memory.md (durable layer for THIS codebase) -----"
  cat "$REPO_MEMORY" 2>/dev/null
  echo
  echo "----- end .claude/memory.md -----"
  echo "Facts about the PROJECT still live in $CONTEXT_REMOTE; the file above is about this codebase."
fi

# The repo's own layer, after the project's: the primary context stays primary, and the heading
# says which is which so a decision about the product and a note about this codebase are never
# read as the same kind of thing.
if [ -n "$REPO_THREADS" ] && [ "${REPO_N:-0}" -gt 0 ] 2>/dev/null; then
  echo
  if [ "${THREADS_MODE:-auto}" = "context" ]; then
    # Listed, not hidden: these threads exist and are worth reading. But routing has moved, so
    # the heading has to say that adding to them is the wrong move — an unlabelled list here
    # reads as an invitation, and the whole point of the flag is that nothing in a thread's
    # content reveals which repo it should have been written into.
    echo "This repo's own threads (.claude/threads/ in $proj) — EXISTING only. Thread routing here is \"context\", so new working notes go to $CONTEXT_REMOTE threads/, not this folder:"
  else
    echo "This repo's own threads (.claude/threads/ in $proj — travels with THIS repo, not with the project context):"
  fi
  list_threads "$REPO_THREADS" ".claude/threads/" 6
  [ "${REPO_N:-0}" -gt 6 ] 2>/dev/null && echo "   ($REPO_N in total)"
  [ "${THREADS_MODE:-auto}" != "context" ] && \
    echo "   Decisions about the product still belong in $CONTEXT_REMOTE; these are about this codebase."
fi
# Said even with nothing to list, because the whole value of the flag is that the routing is
# known BEFORE the first thread is written. The condition mirrors REPO_THREADS above: a real
# context repo, and a working directory that is not it.
if [ "${THREADS_MODE:-auto}" = "context" ] && [ -n "$ROOT" ] && [ "${REPO_N:-0}" -eq 0 ] 2>/dev/null; then
  _pp="$(cd "$proj" 2>/dev/null && pwd -P)"; _rp="$(cd "$ROOT" 2>/dev/null && pwd -P)"
  if [ "$_pp" != "$_rp" ]; then
    echo
    echo "Thread routing for this repo is \"context\": working notes go to $CONTEXT_REMOTE threads/, never .claude/threads/ here. This repo is shared with others, so a thread written into it would travel to everyone who clones it."
  fi
fi
echo
# The mirror is the only structured state a Notion *guest* can see (guests get empty results from
# the connector, not errors), so it has to be pointed at here — a session that doesn't know the
# folder exists will confidently answer "we have no stakeholders on file".
if [ -f "$ROOT/notion/_synced.json" ]; then
  SYNCED="$(sed -n 's/.*"syncedOn"[[:space:]]*:[[:space:]]*"\([0-9-]*\)".*/\1/p' \
    "$ROOT/notion/_synced.json" 2>/dev/null | head -n 1)"
  echo "Read-only Notion mirror in notion/${SYNCED:+ (last synced $SYNCED)}. A snapshot, not a live feed: Notion wins."
fi
[ -d "$ROOT/pending" ] && echo "No workspace access? Queue structured items in pending/."
# The same roster, in the payload, because the model needs the names to act on rather than
# merely to see. Computed above; this only renders it.
if [ -n "$ASST_NAMES" ]; then
  echo "Assistants here: $ASST_NAMES — adopt one with /assistant [name], which loads that role persona, memory and doctrine. /assistant on its own lists them."
fi
[ -n "$SUP_NAMES" ] && echo "Supervisors here (cross-project roles): $SUP_NAMES. supervisor-sweep distils each role LESSONS.md across the include list."
[ -n "$ASST_NOTE" ] && echo "$ASST_NOTE"
[ "${HO_N:-0}" -gt 0 ] 2>/dev/null && echo "handoff/: $HO_N undrained item(s) bound for other repos — drain each in that project own session (see handoff/INDEX.md)."
# Only when the file actually changed this session — a line repeated every start is noise
# nobody reads, but a fresh marker is something the user may want to attach to Cowork now.
[ -n "$MARKER_NOTE" ] && echo "Cowork marker $MARKER_NOTE: .claude/context-project.json in $CONTEXT_REMOTE now mirrors this configuration — commit it there so every clone carries it, and attach that file to a Cowork project so its sandbox sessions load the same context and connections."
echo
# The cross-project layer, when this repo's context.json declares one (see the include
# section above). Emitted after the repo's own material: the primary context stays primary.
if [ -s "$INC_TMP" ]; then
  echo "=== Cross-project context (this repo's context.json \"include\" list) ==="
  echo "Every included repo below is READ-ONLY from this session: never commit to it, never"
  echo "write to its Notion or Slack, never queue into its pending/ — its own facts are owned"
  echo "by its own sessions, and this combined view must not leak writes into them."
  [ -d "$ROOT/handoff" ] && echo "Anything belonging to an included project goes in handoff/ HERE (one file per item — see handoff/README.md), to be drained later in that project's own session."
  echo
  cat "$INC_TMP"
fi
[ -n "$INC_NOTE" ] && { echo "!!! $INC_NOTE"; echo; }
echo "Full context repo: $CONTEXT_REMOTE."
# Which checkout this actually came from, and how new it is. Only in --refresh mode: someone
# asking for a re-pull is asking whether they now hold the latest, and on a surface that runs
# the session somewhere other than the user's own machine (Cowork's cloud environments) the
# answer depends entirely on which clone was reached.
if [ "$MODE" = "refresh" ]; then
  HEAD_LINE="$(git -C "$ROOT" log -1 --format='%h %cd — %s' --date=short 2>/dev/null)"
  echo "Read from: $ROOT${HEAD_LINE:+ · newest commit $HEAD_LINE}"
fi
} > "$OUT_TMP"

if [ -n "$REFRESH_WARNING" ]; then
  emit "⚠ Shared context loaded but may be STALE — refresh from $CONTEXT_REMOTE failed${LAST_UPDATED:+; newest local commit is $LAST_UPDATED}$INC_SUMMARY$ASST_SUMMARY"
else
  AGE="$(git -C "$ROOT" log -1 --format='%cd' --date=relative 2>/dev/null)" || AGE=""
  emit "✓ Shared context loaded — $CONTEXT_REMOTE${AGE:+ · newest commit $AGE}$INC_SUMMARY$ASST_SUMMARY"
fi