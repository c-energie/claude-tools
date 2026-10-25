# Optional convenience recipes for this marketplace. `just` is NEVER required: every recipe
# here is a thin pass-through to a script under plugins/context-kit-core/scripts/, and those
# scripts remain the reproducible route — this file is a second way to type them, not a second
# way to do them. Recipes must not grow logic of their own; anything that has to come out the
# same every time belongs in a scripts/*.mjs, where check-plugin.mjs can see it.
#
# `just` is not installed by default and is deliberately not assumed anywhere else in this
# repo — Cowork sandboxes cannot install it, which is why nothing depends on it:
#
#     winget install --id Casey.Just
#
# Recipes name a workspace by its directory (the one holding .claude/workspace.json). Run them
# from anywhere inside this checkout.
#
#     just connector-check ~/gh-orgs/corson94/thesis
#     just connector-add   ~/gh-orgs/corson94/thesis github
#     just connector       ~/gh-orgs/corson94/thesis

# Windows needs an explicit shell, and both obvious choices are wrong. just's default is `sh`,
# which a plain PowerShell session cannot find: the Windows PATH carries `C:\Program Files\Git\cmd`
# (git.exe) but not `Git\bin` or `Git\usr\bin`, which is where sh.exe actually lives — so it works
# from a Git Bash prompt and fails everywhere else. `cmd /c` is found but mangles the quoting:
# node receives the script path with its quotes still attached and resolves it as relative
# (`Cannot find module 'C:\...\context-kit\"C:\...\setup-connectors.mjs"'`), and --dry-run does
# not show this because the line only breaks once a shell parses it. powershell.exe is in
# System32, so it is always on PATH, and it parses the quoted arguments correctly.
#
# Not `bash`: on Windows that can resolve to WSL's System32\bash.exe, which cannot see the paths
# or the $HOME these scripts assume — the trap bash-bin.mjs exists to avoid.
set windows-shell := ["powershell.exe", "-NoProfile", "-Command"]

scripts  := justfile_directory() + "/plugins/context-kit-core/scripts"

# List the recipes.
default:
    @just --list

# Report which of a workspace's declared connections exist on this machine. Changes nothing.
connector-check workspace:
    node "{{scripts}}/mcp/setup-connectors.mjs" --check --context "{{workspace}}"

# Declare a provider (github / notion / slack) in that workspace.json's connections block.
connector-add workspace provider:
    node "{{scripts}}/mcp/setup-connectors.mjs" --add {{provider}} --context "{{workspace}}"

# `connector` reads each credential from a hidden prompt — precisely so it never passes through
# a conversation or a shell history — so it needs a real terminal and cannot be driven by an
# agent. Nothing is written until the credential verifies against the provider's API, so an
# abandoned run leaves no mess. That note lives up here rather than in the recipe body: `just`
# passes body comments through to the shell rather than stripping them.
#
# Only the LAST comment line above a recipe becomes its `just --list` description. Keep each
# one to a single line.

# Provision every declared-but-missing connection. Needs a real terminal (hidden token prompt).
connector workspace:
    node "{{scripts}}/mcp/setup-connectors.mjs" --context "{{workspace}}"
