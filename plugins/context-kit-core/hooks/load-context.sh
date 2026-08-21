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
  # MCP connection per provider. Sniff the first byte rather than trusting the filename.
  case "$(head -c 1 "$1" 2>/dev/null)" in
    "{") settings_key "$1" contextRepo ;;
    *)   head -n 1 "$1" 2>/dev/null | tr -d ' \t\r\n' ;;
  esac
}
is_optout() {  # $1 = the configured value; true when it means "deliberately no context repo"
  case "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" in
    none|off|false|no|-|disabled) return 0 ;;
    *) return 1 ;;
  esac
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
            "$HOME"/mnt/uploads/context-project.json "$HOME"/mnt/uploads/.context-repo "$HOME"/mnt/uploads/context-repo.txt; do
    if [ -f "$_m" ]; then
      r="$(marker_repo "$_m")"
      [ -n "$r" ] && { printf '%s\n%s\n' "$r" "$_m"; return; }
    fi
  done
  # Last resort, sandbox layouts drift: a bounded search of the mount areas only — never the
  # working tree, which on a laptop can be a huge repo this must not crawl at session start.
  for _d in "$HOME/mnt" /mnt; do
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
      const ctx = JSON.parse(fs.readFileSync(ctxPath, "utf8").replace(/^\uFEFF/, ""));
      let prev = null, marker = {};
      try {
        prev = fs.readFileSync(out, "utf8");
        const held = JSON.parse(prev.replace(/^\uFEFF/, ""));
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

# ----------------------------------------------------------- included context repos
# The cross-project layer: a context repo whose context.json declares
#   "include": ["owner/repo", ...]
# also gets each named repo's memory.md, glossary.md and threads/INDEX.md loaded — read-only,
# and ONE level only (an included repo's own include list is ignored, by construction: only
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
          for _incf in memory.md glossary.md threads/INDEX.md; do
            if [ -f "$INC_ROOT/$_incf" ]; then
              echo "----- $inc · $_incf -----"
              cat "$INC_ROOT/$_incf"
              echo "----- end $inc · $_incf -----"
            else
              echo "($inc has no $_incf)"
            fi
            echo
          done
          echo "Depth on demand, still read-only: full threads/, meetings/ and any notion/ mirror under $INC_ROOT."
        fi
        echo
      } >> "$INC_TMP"
      INC_NAMES="${INC_NAMES:+$INC_NAMES, }$inc"
      if [ -z "$INC_ROOT" ] || [ -n "$INC_WARN" ]; then INC_STALE=1; fi
    done
  fi
fi
# Lists the newest threads in a directory, with titles. Shared by the project layer and the
# per-repo layer so the title-extraction awk exists once: it was duplicated the moment a second
# thread location appeared, and a title parser that drifts between two copies would print the
# literal front-matter fence in one of them with nobody noticing which.
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

# The repo's own layer, after the project's: the primary context stays primary, and the heading
# says which is which so a decision about the product and a note about this codebase are never
# read as the same kind of thing.
if [ -n "$REPO_THREADS" ] && [ "${REPO_N:-0}" -gt 0 ] 2>/dev/null; then
  echo
  echo "This repo's own threads (.claude/threads/ in $proj — travels with THIS repo, not with the project context):"
  list_threads "$REPO_THREADS" ".claude/threads/" 6
  [ "${REPO_N:-0}" -gt 6 ] 2>/dev/null && echo "   ($REPO_N in total)"
  echo "   Decisions about the product still belong in $CONTEXT_REMOTE; these are about this codebase."
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