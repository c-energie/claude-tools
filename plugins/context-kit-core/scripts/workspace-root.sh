#!/usr/bin/env bash
# Find the workspace a session is in — the bash TWIN of workspace.mjs, for hooks. Prints the
# absolute workspace root on stdout (nothing else), so callers can do:
#   ROOT="$(bash scripts/workspace-root.sh)"
#
#   scripts/workspace-root.sh              # nearest .claude/workspace.json, else context-repo.sh
#   scripts/workspace-root.sh --no-pull    # passed to the fallback only
#   scripts/workspace-root.sh --writable   # passed to the fallback only
#
# workspace.mjs carries the whole account of the file, its owners and why the rules are what
# they are; the rules themselves, in short: walk from the working dir to the filesystem root,
# the first .claude/workspace.json wins, levels never merge, and the walk does NOT stop at a
# .git (members are nested clones inside the workspace). A malformed nearest file is reported
# and the walk stops there for the fallback — never skipping on to an outer workspace.
#
# A twin, not a copy: check-plugin's drift rule cannot compare a .sh with a .mjs, so
# workspace.test.mjs runs both against the same fixtures. Change both, or neither.
#
# stderr always says which route answered (`route=workspace` / `route=context-repo`). Exit 1
# when neither resolves — the same contract as context-repo.sh, so a hook guards it the same
# way (`|| true`) and never exits non-zero itself. Never prompts.
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

PASS=()
for arg in "$@"; do
  case "$arg" in
    --no-pull|--writable) PASS+=("$arg") ;;
    *) echo "workspace-root.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done

# JSON validity needs a parser bash does not have. node is assumed wherever these hooks run —
# the connection gate is a .mjs — but where it is somehow absent the file is accepted on a
# first-byte sniff rather than ignored: a workspace that exists must not quietly lose to the
# legacy route because of a missing tool. Prints "ok [schema]" or "error [reason]".
check_json() {
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      try {
        const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace(/^﻿/, ""));
        if (c === null || typeof c !== "object" || Array.isArray(c)) console.log("error top level is not a JSON object");
        else console.log("ok " + JSON.stringify(c.schema ?? null));
      } catch (e) { console.log("error " + String(e.message).split("\n")[0]); }
    ' "$1" 2>/dev/null || echo "error node could not read it"
  else
    case "$(tr -d ' \t\r\n' < "$1" 2>/dev/null | head -c 1)" in
      "{") echo "ok unchecked" ;;
      *)   echo "error does not start with {" ;;
    esac
  fi
}

dir="$(cd "$cwd" 2>/dev/null && pwd)" || dir=""
why="no .claude/workspace.json above the working directory"
while [ -n "$dir" ]; do
  file="$dir/.claude/workspace.json"
  if [ -e "$file" ]; then   # -e, not -f: existsSync is true for a directory too, and the twins must agree
    verdict="$(check_json "$file")"
    case "$verdict" in
      ok\ *)
        schema="${verdict#ok }"
        case "$schema" in
          1|unchecked) ;;
          *) echo "workspace-root.sh: $file: schema is $schema, this resolver knows 1 — resolving the root anyway" >&2 ;;
        esac
        echo "workspace-root.sh: route=workspace ($file)" >&2
        echo "$dir"
        exit 0 ;;
      *)
        echo "workspace-root.sh: $file: malformed, ignored — ${verdict#error }" >&2
        why="the nearest .claude/workspace.json is malformed"
        break ;;
    esac
  fi
  [ "$dir" = "/" ] && break
  up="$(dirname "$dir")"
  [ "$up" = "$dir" ] && break
  dir="$up"
done

# The legacy route, unchanged. CLAUDE_PROJECT_DIR is pinned to the dir this walk started from
# so both routes look from the same place.
if ROOT="$(CLAUDE_PROJECT_DIR="$cwd" bash "$here/context-repo.sh" ${PASS[@]+"${PASS[@]}"})" && [ -n "$ROOT" ]; then
  echo "workspace-root.sh: route=context-repo ($why)" >&2
  echo "$ROOT"
  exit 0
fi
echo "workspace-root.sh: route=none — no workspace, and the context-repo fallback did not resolve" >&2
exit 1
