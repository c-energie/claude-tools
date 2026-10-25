#!/usr/bin/env bash
# Find the workspace a session is in — the bash TWIN of workspace.mjs, for hooks. Prints the
# absolute workspace root on stdout (nothing else), so callers can do:
#   ROOT="$(bash scripts/workspace-root.sh)"
#
# The nearest .claude/workspace.json is the only route: the context-repo fallback was deleted
# once the last project migrated (#60). --no-pull, --writable and --no-fallback are accepted and
# ignored, so a caller written before then does not start failing on an unknown option.
#
# workspace.mjs carries the whole account of the file, its owners and why the rules are what
# they are; the rules themselves, in short: walk from the working dir to the filesystem root,
# the first .claude/workspace.json wins, levels never merge, and the walk does NOT stop at a
# .git (members are nested clones inside the workspace). A malformed nearest file is reported
# and the walk stops there, resolving nothing — never skipping on to an outer workspace.
#
# A twin, not a copy: check-plugin's drift rule cannot compare a .sh with a .mjs, so
# workspace.test.mjs runs both against the same fixtures. Change both, or neither.
#
# stderr always says which route answered (`route=workspace` / `route=none`). Exit 1 when there
# is no workspace, so a hook guards it (`|| true`) and never exits non-zero itself. Never
# prompts, never touches the network.
set -u

cwd="${CLAUDE_PROJECT_DIR:-$PWD}"

for arg in "$@"; do
  case "$arg" in
    --no-pull|--writable|--no-fallback) ;;   # the retired fallback's; accepted, ignored
    *) echo "workspace-root.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done

# JSON validity needs a parser bash does not have. node is assumed wherever these hooks run —
# the connection gate is a .mjs — but where it is somehow absent the file is accepted on a
# first-byte sniff rather than ignored: a workspace that exists must not quietly vanish because
# of a missing tool. Prints "ok [schema]" or "error [reason]".
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

echo "workspace-root.sh: route=none — $why" >&2
exit 1
