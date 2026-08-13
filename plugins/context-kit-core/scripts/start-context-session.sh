#!/usr/bin/env bash
# Pick a context repo under ~/.context and start a Claude session in it — the macOS/Linux
# sibling of Start-ContextSession.ps1, same menu, same rules.
#
#   start-context-session.sh                 # pick, then run `claude` there
#   start-context-session.sh --continue      # ...unrecognised args pass through to claude
#   start-context-session.sh --dry-run       # print the directory instead of launching
#   start-context-session.sh --root DIR      # browse somewhere other than ~/.context
#   start-context-session.sh --shortcut      # install a copy + a desktop launcher, then exit
#
# Walks the clone root one level at a time (owner -> repo) and stops descending as soon as
# the chosen directory *is* a repo. What counts as a repo is decided by content, never by
# depth: a context repo has context.json at its root, the plugin marketplace has
# .claude-plugin/marketplace.json, and anything else with a .git directory is a checkout.
#
# Reads nothing and writes nothing in the repos it lists (bar --shortcut, which writes only
# its own copy and the launcher): the session's own SessionStart hook does the loading,
# exactly as it would had you cd'd there by hand.
#
# The two launchers are deliberately NOT a copied pair — check-plugin.mjs's drift rule does
# not cover them. They are the same job written twice for two shells, and only the .ps1 can
# make a .lnk, only this one a .desktop / .command. Change both when the menu changes.
set -u

ROOT="$HOME/.context"
DRYRUN=0
SHORTCUT=0
NAME="Claude context session"
CLAUDE_ARGS=()

# The header comment above IS the help text — print it to the first non-comment line rather
# than a hard-coded line range, which silently truncates the moment the header grows.
usage() { awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --root)     ROOT="${2:-}"; shift 2 ;;
    --name)     NAME="${2:-}"; shift 2 ;;
    --dry-run)  DRYRUN=1; shift ;;
    --shortcut) SHORTCUT=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    # Everything after -- is claude's, verbatim — the escape hatch for the day claude grows
    # a flag this script also takes.
    --)         shift; CLAUDE_ARGS+=("$@"); break ;;
    *)          CLAUDE_ARGS+=("$1"); shift ;;
  esac
done

die() { printf '%s\n' "$*" >&2; exit 1; }

is_repo() {  # $1 = dir
  [ -f "$1/context.json" ] || [ -f "$1/.claude-plugin/marketplace.json" ] || [ -d "$1/.git" ]
}

label_of() {  # $1 = dir
  if   [ -f "$1/.claude-plugin/marketplace.json" ]; then printf 'marketplace'
  elif [ -f "$1/context.json" ];                    then printf 'context repo'
  elif [ -d "$1/.git" ];                            then printf 'checkout'
  fi
}

# Recursion carries its answer in a global rather than on stdout: stdout is where the menu
# has to be drawn, and a subshell could not update the caller's state anyway.
# Exit status: 0 = SELECTED holds the directory, 1 = quit, 2 = go back one level.
SELECTED=""
select_dir() {  # $1 = dir, $2 = depth
  local dir="$1" depth="$2" rel answer n child count
  while true; do
    local children=()
    while IFS= read -r child; do
      [ -n "$child" ] && children+=("$child")
    done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d ! -name '.*' 2>/dev/null | LC_ALL=C sort)
    count=${#children[@]}
    if [ "$count" -eq 0 ]; then SELECTED="$dir"; return 0; fi

    rel="${dir#"$ROOT"}"; rel="${rel#/}"
    printf '\n'
    if [ -n "$rel" ]; then printf '  %s\n\n' "$rel"; else printf '  Context repos  (%s)\n\n' "$ROOT"; fi

    for i in $(seq 0 $((count - 1))); do
      local lbl; lbl="$(label_of "${children[$i]}")"
      if [ -n "$lbl" ]; then printf '   %2d) %s  [%s]\n' "$((i + 1))" "$(basename "${children[$i]}")" "$lbl"
      else                   printf '   %2d) %s\n'       "$((i + 1))" "$(basename "${children[$i]}")"; fi
    done

    printf '\n'
    [ "$depth" -gt 0 ] && printf '    b) back\n'
    printf '    q) quit\n\n'
    printf 'Select: '
    # A closed stdin (piped, cron, a tool call) reads EOF forever — treat it as "quit"
    # rather than spinning the menu.
    if ! IFS= read -r answer; then printf '\n'; return 1; fi
    answer="$(printf '%s' "$answer" | tr -d '[:space:]')"

    case "$answer" in
      q|'') return 1 ;;
      b)    if [ "$depth" -gt 0 ]; then return 2; else continue; fi ;;
    esac

    case "$answer" in
      *[!0-9]*|'') printf "  '%s' is not one of the options.\n" "$answer"; continue ;;
    esac
    n="$answer"
    if [ "$n" -lt 1 ] || [ "$n" -gt "$count" ]; then
      printf "  '%s' is not one of the options.\n" "$answer"; continue
    fi

    local chosen="${children[$((n - 1))]}"
    if is_repo "$chosen"; then SELECTED="$chosen"; return 0; fi

    select_dir "$chosen" "$((depth + 1))"
    case $? in
      0) return 0 ;;
      2) continue ;;
      *) return 1 ;;
    esac
  done
}

# ---------------------------------------------------------------- desktop launcher

desktop_dir() {
  # Honour the XDG user-dirs setting where there is one; a localised desktop folder is
  # common and writing to a hard-coded ~/Desktop puts the launcher where nobody looks.
  local d=""
  if [ -f "$HOME/.config/user-dirs.dirs" ]; then
    d="$(. "$HOME/.config/user-dirs.dirs" 2>/dev/null; printf '%s' "${XDG_DESKTOP_DIR:-}")"
  fi
  [ -z "$d" ] && d="$HOME/Desktop"
  printf '%s' "$d"
}

install_shortcut() {
  # Everything that can refuse the job goes first: platform, then desktop folder. Copying
  # before checking those left a stray copy behind on the paths that then bailed out.
  local kind; kind="$(uname -s)"
  case "$kind" in
    Darwin|Linux) ;;
    *) die "unsupported platform $kind — on Windows use Start-ContextSession.ps1 -Shortcut" ;;
  esac

  local desk; desk="$(desktop_dir)"
  [ -d "$desk" ] || die "no desktop folder at $desk — make the launcher by hand, or create that folder"

  # --shortcut is the one mode that may run before there is anything to browse: a fresh
  # install has no clone root yet, and refusing to make the launcher until the user has
  # cloned something is backwards — the launcher is how they get there.
  mkdir -p "$ROOT" || die "could not create $ROOT"
  ROOT="$(cd "$ROOT" && pwd)"
  # A stable home outside the versioned plugin directory: an installed plugin lives under
  # ~/.claude/plugins/cache/.../context-kit-core/[version]/scripts/, so a launcher aimed
  # straight at it breaks silently on the next plugin update.
  local installed="$ROOT/start-context-session.sh"
  local source; source="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  if [ "$source" != "$installed" ]; then
    cp "$source" "$installed" && chmod +x "$installed" || die "could not copy to $installed"
    printf '  ok    copied this script to %s\n' "$installed"
  else
    printf '  ok    already running from %s\n' "$installed"
  fi

  case "$kind" in
    Darwin)
      # macOS has no .desktop; a .command is an executable script Finder opens in Terminal.
      local target="$desk/$NAME.command"
      cat > "$target" <<EOF
#!/bin/sh
# Written by start-context-session.sh --shortcut. Re-run that after a plugin update.
exec "$installed"
EOF
      chmod +x "$target"
      printf '  ok    launcher written to %s\n' "$target"
      ;;
    Linux)
      local target="$desk/$NAME.desktop"
      # Terminal=true is what makes the desktop hand it a terminal — claude is a TUI and
      # exits immediately without one.
      cat > "$target" <<EOF
[Desktop Entry]
Type=Application
Name=$NAME
Comment=Pick a context repo and start a Claude session in it
Exec="$installed"
Terminal=true
Categories=Development;
EOF
      chmod +x "$target"
      printf '  ok    launcher written to %s\n' "$target"
      printf '        GNOME may need it marked trusted: gio set "%s" metadata::trusted true\n' "$target"
      ;;
  esac
  printf '\n        Re-run with --shortcut after a plugin update to refresh the copy;\n'
  printf '        the launcher points at the copy, so it never needs changing.\n'
  exit 0
}

# ---------------------------------------------------------------- main

# Before the clone-root check, deliberately: install_shortcut creates the root if it has to.
[ "$SHORTCUT" -eq 1 ] && install_shortcut

[ -d "$ROOT" ] || die "Clone root not found: $ROOT"
ROOT="$(cd "$ROOT" && pwd)"

if ! select_dir "$ROOT" 0; then
  printf 'Nothing selected.\n'
  exit 0
fi
target="$SELECTED"

if [ "$DRYRUN" -eq 1 ]; then
  printf '\n%s\n' "$target"
  exit 0
fi

command -v claude >/dev/null 2>&1 || die 'claude was not found on PATH.'

cd "$target" || die "could not enter $target"
printf '\n-> %s\n\n' "$target"

if [ "${#CLAUDE_ARGS[@]}" -gt 0 ]; then exec claude "${CLAUDE_ARGS[@]}"; else exec claude; fi
