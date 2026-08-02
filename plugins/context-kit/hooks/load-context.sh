#!/usr/bin/env bash
# context-kit — load shared context at session start, wherever the context-kit plugin is enabled.
# Injects memory.md + pointers to glossary/threads so the session starts having read the shared
# context. Never prompts, never hangs, never blocks (always exits 0).
#
# Checkout resolution lives in scripts/context-repo.sh — the same resolver save-thread and
# curate-context use, so all three agree on which clone is "the" context repo.
#
# The refresh is capped (see the resolver). If it times out or fails, the session still gets
# the local copy, but with a STALE banner above it saying so and how old it is — never silently.
#
# Also runs mid-session, by hand, as `load-context.sh --refresh` — that is the whole of the
# refresh-context skill. Same pull, same STALE banner, different header (claiming "loaded at
# session start" an hour into a session is exactly the kind of quiet lie this script exists to
# avoid) plus a provenance line naming the checkout it actually read.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# In step with scripts/context-repo.sh: which context repo is PROJECT_CONTEXT_REPO
# (FLEXSENSE_CONTEXT_REPO honoured as a legacy alias) — env var, else the project's .claude
# settings files (laptop — the committed settings.json rides along in the checkout), else a
# one-line marker file (Cowork — attached project files are the only channel into its
# sandbox, and env vars cannot be set there). Deliberately NO default: an unconfigured
# project must say so — falling back to some other project's repo loads the WRONG context.
proj="${CLAUDE_PROJECT_DIR:-$PWD}"
settings_key() {  # $1 = file, $2 = json key
  sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1
}
marker_repo() {
  head -n 1 "$1" 2>/dev/null | tr -d ' \t\r\n'
}
CONTEXT_REMOTE="${PROJECT_CONTEXT_REPO:-${FLEXSENSE_CONTEXT_REPO:-}}"
for _f in "$proj/.claude/settings.local.json" "$proj/.claude/settings.json"; do
  [ -z "$CONTEXT_REMOTE" ] && CONTEXT_REMOTE="$(settings_key "$_f" PROJECT_CONTEXT_REPO)"
  [ -z "$CONTEXT_REMOTE" ] && CONTEXT_REMOTE="$(settings_key "$_f" FLEXSENSE_CONTEXT_REPO)"
done
for _m in "$proj/.context-repo" "$proj/context-repo.txt" \
          "$proj"/docs/.context-repo "$proj"/docs/context-repo.txt \
          /mnt/project/.context-repo /mnt/project/context-repo.txt \
          "$HOME"/mnt/.projects/*/docs/.context-repo "$HOME"/mnt/.projects/*/docs/context-repo.txt \
          "$HOME"/mnt/uploads/.context-repo "$HOME"/mnt/uploads/context-repo.txt; do
  [ -z "$CONTEXT_REMOTE" ] && [ -f "$_m" ] && CONTEXT_REMOTE="$(marker_repo "$_m")"
done
# Last resort, sandbox layouts drift: a bounded search of the mount areas only — never the
# working tree, which on a laptop can be a huge repo this must not crawl at session start.
if [ -z "$CONTEXT_REMOTE" ]; then
  for _d in "$HOME/mnt" /mnt; do
    if [ -z "$CONTEXT_REMOTE" ] && [ -d "$_d" ]; then
      _found="$(find "$_d" -maxdepth 5 \( -name context-repo.txt -o -name .context-repo \) 2>/dev/null | head -n 1)"
      [ -n "$_found" ] && CONTEXT_REMOTE="$(marker_repo "$_found")"
    fi
  done
fi
# The real resolver re-derives this identically; exporting pins both to the same answer even
# if only one copy is ever updated.
export PROJECT_CONTEXT_REPO="$CONTEXT_REMOTE"
export FLEXSENSE_CONTEXT_REPO="$CONTEXT_REMOTE"
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
  # Clone dir follows the remote, in step with context-repo.sh: FLEXSENSE_CONTEXT_DIR beats
  # everything, the default remote keeps its historical ~/.flexsense/context, any other remote
  # lands at ~/.context/<owner>-<repo>.
  if [ -n "${FLEXSENSE_CONTEXT_DIR:-}" ]; then
    CLONE_DIR="$FLEXSENSE_CONTEXT_DIR"
  elif [ "$CONTEXT_REMOTE" = "net-flex/context" ]; then
    CLONE_DIR="$HOME/.flexsense/context"
  else
    CLONE_DIR="$HOME/.context/${CONTEXT_REMOTE//\//-}"
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
  HELPER='!f() { echo username=x-access-token; echo "password=$FLEXSENSE_TOKEN"; }; f'
  resolve_token() {
    [ "$TOKEN_TRIED" -eq 1 ] && { [ -n "$TOKEN" ]; return; }
    TOKEN_TRIED=1
    TOKEN="${FLEXSENSE_GIT_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
    if [ -z "$TOKEN" ] && command -v gh >/dev/null 2>&1; then
      TOKEN="$(gh auth token 2>/dev/null || true)"
    fi
    [ -n "$TOKEN" ]
  }
  run_git() {   # run_git <capped 0|1> <git args...>
    local capped="$1"; shift
    if [ "$capped" = 1 ] && [ -n "$TIMEOUT_BIN" ]; then
      GIT_TERMINAL_PROMPT=0 FLEXSENSE_TOKEN="$TOKEN" \
        "$TIMEOUT_BIN" "${FLEXSENSE_GIT_TIMEOUT:-30}" git "$@" >/dev/null 2>&1
    else
      GIT_TERMINAL_PROMPT=0 FLEXSENSE_TOKEN="$TOKEN" git "$@" >/dev/null 2>&1
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
          REFRESH_WARNING="clone failed, and there is no git credential in this environment for a private repo — set FLEXSENSE_GIT_TOKEN or sign in with 'gh auth login'"
        fi
      fi ;;
  esac

  if [ -n "$ROOT" ] && ! git_net 1 -C "$ROOT" pull --ff-only --autostash; then
    if resolve_token; then
      REFRESH_WARNING="pull failed or timed out after ${FLEXSENSE_GIT_TIMEOUT:-30}s, including a retry with a token; working from the local state"
    else
      REFRESH_WARNING="pull failed after ${FLEXSENSE_GIT_TIMEOUT:-30}s, and there is no git credential in this environment for a private repo — set FLEXSENSE_GIT_TOKEN or sign in with 'gh auth login'; working from the local state"
    fi
  fi
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
trap 'rm -f "$ERRFILE" "$OUT_TMP"' EXIT

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
    echo "Run: find ~/mnt /mnt . -maxdepth 5 -name 'context-repo.txt' -o -name '.context-repo' 2>/dev/null"
    echo "If a marker is found, its one owner/repo line names this project's context repo:"
    echo "read that repo's memory.md and context.json (git if available, else the GitHub MCP"
    echo "connector), treat them as the session context, and tell the user in one line which"
    echo "repo loaded and by which route. Mention context-setup can diagnose why the hook missed it."
    echo
    echo "Only if no marker exists either: this project has no shared context — say so, do NOT"
    echo "guess a repo, and continue with the user's message. Configure one via"
    echo "PROJECT_CONTEXT_REPO, a .claude/settings.json env block, or an attached"
    echo "context-repo.txt marker; the context-setup skill walks the user through it."
  } > "$OUT_TMP"
  emit "⚠ No context repo configured — run context-setup, or add a context-repo.txt marker / PROJECT_CONTEXT_REPO setting"
fi

if [ -z "$ROOT" ] || [ ! -f "$ROOT/memory.md" ]; then
  {
    echo "This project's context repo is $CONTEXT_REMOTE, but git could not fetch it here."
    [ -n "$REFRESH_WARNING" ] && echo "Reason: $REFRESH_WARNING"
    echo
    echo "MANDATORY FIRST ACTION of your first response — before answering the user's message,"
    echo "whatever it is (even a bare greeting): if a GitHub MCP connector is available, read"
    echo "$CONTEXT_REMOTE's memory.md (and context.json, plus threads/INDEX.md if present) with"
    echo "it, treat that as the session context, and CONFIRM to the user on the first line:"
    echo "\"✓ Shared context loaded — $CONTEXT_REMOTE · via GitHub connector\". This is the"
    echo "NORMAL route in cloud sandboxes, not an error path."
    echo
    echo "Only if there is no GitHub connector either: say the context is unavailable and why."
    echo "Never answer from a guess or another project's context. Skills still load from the plugin."
    :
  } > "$OUT_TMP"
  emit "→ Context repo: $CONTEXT_REMOTE — loading via the GitHub connector in the first response (git has no credentials in this environment)"
fi

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
[ -f "$ROOT/glossary.md" ] && echo "Vocabulary: see glossary.md in $CONTEXT_REMOTE."
if [ -d "$ROOT/threads" ]; then
  echo "Working threads (one topic per file; newest last):"
  find "$ROOT/threads" -maxdepth 1 -name '*.md' ! -name 'README.md' ! -name 'INDEX.md' -print 2>/dev/null \
    | sort | tail -n 6 \
    | while IFS= read -r f; do
        # Title comes from the front-matter `title:` if the file has a block, else the
        # first markdown heading. Taking line 1 blindly prints "---" for every file
        # written since the front-matter convention landed.
        title="$(awk '
          NR == 1 && /^---[[:space:]]*$/ { fm = 1; next }
          fm == 1 && /^---[[:space:]]*$/ { fm = 0; next }
          fm == 1 && /^title:[[:space:]]/ { sub(/^title:[[:space:]]*/, ""); print; exit }
          fm == 0 && /^#+[[:space:]]/ { sub(/^#+[[:space:]]*/, ""); print; exit }
        ' "$f" 2>/dev/null | sed -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//')"
        [ -z "$title" ] && title="$(basename "$f" .md)"
        echo "   - threads/$(basename "$f") — ${title}"
      done
  [ -f "$ROOT/threads/INDEX.md" ] && echo "   (full list: threads/INDEX.md)"
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
echo
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
  emit "⚠ Shared context loaded but may be STALE — refresh from $CONTEXT_REMOTE failed${LAST_UPDATED:+; newest local commit is $LAST_UPDATED}"
else
  AGE="$(git -C "$ROOT" log -1 --format='%cd' --date=relative 2>/dev/null)" || AGE=""
  emit "✓ Shared context loaded — $CONTEXT_REMOTE${AGE:+ · newest commit $AGE}"
fi