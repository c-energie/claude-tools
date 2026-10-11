---
name: context-access
description: How to reach the project's context repo over the GitHub API — the MCP route sandbox sessions (Cowork) use, git being unavailable there. Defines which route each surface takes, the operations it needs, and the rules that keep an API write from truncating a file. Background knowledge for save-thread, refresh-context, curate-context and the pending queue; not a task to run.
user-invocable: false
---

# Reaching the context repo over the GitHub API

**A project's context repo is reached two different ways, one per surface.** Which one applies
is a property of where the session is running, not something to discover by failure:

- **Claude Code on a laptop** — resolve a checkout with
  `${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh` and use `git`. Full history, atomic commits,
  and the `scripts/*.mjs` are all available. Prefer this whenever `bash` runs.
- **Cowork / cloud sandboxes** — the **GitHub API over MCP**, described in this file. Git is not
  the route there. Reads are complete and current; writes commit straight to the default
  branch, which is where the sharp edges are (see the rules below).

**Say which route produced the answer** — its provenance changes with it. Never present an API
read as a git one, and never answer from the copy loaded at session start while claiming it is
current.

If neither route is available, structured rows can still go to the project's backend (Notion:
`add-action` / `log-decision` / `add-open-question`). Narrative (`threads/`) has nowhere to go:
say so plainly rather than writing it somewhere it will be lost.

This file is the canonical description of the API route; the skills point here rather than each
carrying their own copy.

## Which repo, and which connector

Both are configuration, never a guess:

- **The repo** — `PROJECT_CONTEXT_REPO` (env, or the project's `.claude/settings(.local).json`
  env block), else a marker file's `contextRepo`. The value `none` means this project has
  deliberately opted out; there is nothing to reach. See `context-setup` for the full ladder.
- **The connector** — the context repo's `context.json` `connections.github` names the MCP
  server to use, and a `context-project.json` marker carries the same name so the very first
  action of a sandbox session already knows it. On a machine with several scoped GitHub
  connections, **any other one is off-limits for this project** — a token scoped to a different
  owner is exactly how the wrong repo gets written. `connection-gate.mjs` enforces this rather
  than trusting it, so reaching for another project's connector is refused, not merely discouraged.

  **It may name more than one.** A fine-grained PAT has a single resource owner, so a project
  spanning two owners declares a map of owner to connection:
  `{ "github": { "your-user": "github-second-brain", "c-energie": "github-second-brain-c-energie" } }`.
  Pick by the owner of the repo you are reaching for — that is what the key is for. Guessing
  costs you a 404 that says "not found" when it means "wrong credential", the same wrong-cause
  failure a data-source ID gives a Notion create. Where the owner is not knowable, the entry
  matching the context repo's own owner is the one every core operation here needs.

Pass `branch` explicitly (usually `main`) rather than relying on the tool's default.

## How the MCP route is set up

Cowork's own connector UI has no GitHub connector (checked 2026-07-29). What works instead is
an MCP server declared in the Claude configs, run on the **host** machine — which is precisely
why it fits: the token never enters the sandbox at all.

`${CLAUDE_PLUGIN_ROOT}/scripts/mcp/setup-connectors.mjs` provisions those servers from the
project's `connections` block (one scoped credential per provider per project, stored in the OS
credential store rather than in the config files), and `--check` diagnoses without changing
anything. The `setup-connectors` skill is the guided version of the same thing. **Never run the
write mode with a token you have been given** — the scripts read credentials from a hidden
prompt, stdin or the environment precisely so a token never passes through the conversation.
Point the user at the command; let them run it.

The token wants to be **fine-grained**, scoped to this project's context repo, Contents **read
and write**, with an expiry. A GitHub PAT has a single resource owner, so a second owner needs a
second token *and* a second connection —
`setup-connectors.mjs --add github:[owner]` declares it and keeps the existing one, promoting the
value to the owner-keyed map form rather than overwriting.

The server is registered **once, in the desktop app's `claude_desktop_config.json`** — the host
registry. That one file serves the chat app *and* Cowork: a Cowork sandbox does not run the
server, the host runs it and bridges it in, which is why the token never enters the sandbox.
Restart the desktop app after a change — quitting it completely, not just closing the window.

Confirmed 2026-08-31: with all seven servers removed from `~/.claude.json` and left in the host
config alone, Cowork still lists them under Settings → Connectors. Claude Code's user scope is
not a second registry Cowork falls back to; it never read it.

**Claude Code does not read that file, and is given the server per repo.** It has its own
registry, and its *user* scope (`~/.claude.json`) loads a server in every session on the machine
regardless of the project — which is how a laptop with seven connectors made every session pay
for all seven. So Claude Code gets each server in the one directory entitled to it:

```bash
claude mcp add-json [name] '[the entry, copied from the host config]' -s local   # this repo only
claude mcp list                                                                 # what this directory sees
```

`setup-connectors.mjs` prints that command for any declared connection the host has and the
current directory cannot see. **None of this reaches Cowork**, which never read `~/.claude.json`:
a sandbox session's connectors are exactly what the host config holds.

## Checking what the session actually exposes

**Do not assume the tool names.** The prefix follows the server name from `connections`, and
different GitHub MCP servers expose different sets — so list the GitHub tools present in *this*
session and map them onto the operations below:

| Operation | Needed by | Tool |
|---|---|---|
| Read one file | everything | `get_file_contents` — returns the content **and its `sha`** |
| List a directory | `threads/`, `pending/` | `get_file_contents` with a directory path, which returns entries |
| Recent commits | "what changed since" | `list_commits` |
| Write one file | `save-thread`, `add-pending` | `create_or_update_file` — needs `sha` when the file exists |
| Write several in one commit | rare here | `push_files` |

If the server is missing, or an operation you need has no tool, **stop and name the missing
piece.** "I can read the context but cannot write it" is a useful, true answer; guessing a tool
name and reporting success is not.

When the server is missing entirely, the diagnosis is `context-setup` (is the repo named at
all? is the declared connection present in this session?) then `setup-connectors` (is the
credential scoped to this repo, approved by the org, and unexpired?). Work in that order, and
reach for `CONTEXT_GIT_TOKEN` and the git route only after those are ruled out: on every
surface but a laptop shell, this server *is* the route.

## Rules for writing through the API

These are the differences that bite. They are not stylistic.

- **A write is an immediate commit to the default branch.** There is no staging area, no local
  commit, no separate push. The moment the call succeeds the change is public. So the "ask
  before pushing" gate that `save-thread` and `add-pending` apply to a push applies here to the
  **write itself** — ask first, every time, and say plainly that it will be visible immediately.
- **Never reconstruct a file from memory.** Read the current content, modify it, write the whole
  thing back. The API replaces the file; a write built from what you remember of it silently
  truncates everything you forgot. This is the single most damaging failure mode on this path,
  and it has no equivalent on the git path, where a diff would have shown it.
- **Updating an existing file needs its blob `sha`**, returned by `get_file_contents`. Read
  immediately before writing, and pass that `sha` through. Omitting it on a file that exists is
  rejected as a create-over-existing; passing a stale one is the API telling you someone else
  changed the file in between — **re-read and reapply**, never force. Creating a genuinely new
  file takes no `sha`.
- **Appending means read + append + write back whole**, for the same reason. `pending/` entries
  and dated thread updates are both appends.
- **Pass plain text** where the tool accepts it. Only base64-encode if the tool requires it, and
  never double-encode — a base64 blob committed as text is the kind of thing nobody notices for
  a week.
- Commit messages follow the context repo's own convention exactly as on the git path
  (`threads: [topic]`, `pending: [what]`).

## What this path cannot do

Say so rather than half-doing it:

- **`curate-context`** — moves files, rewrites `memory.md`, and rebuilds `threads/INDEX.md` with
  `thread-index.mjs`. Multi-file, script-driven, and destructive if half-applied. Shell only.
- **`sync-notion-mirror`** (context-notion) — `mirror-render.mjs` owns the mirror folder so that
  an unchanged Notion produces no diff. Hand-writing that folder destroys the property that
  makes its `git diff` readable. Shell only, and **never hand-edit the mirror**.
- **Anything needing `scripts/*.mjs`** — date arithmetic, triage buckets, index rebuilds,
  `pending-parse.mjs`. Without a shell there is no script; do the reasoning in prose, say that
  you did, and prefer to defer the job to a session that has one.

## Rules that do not change

The context repo's own house rules for `threads/` hold on either route — read its
`threads/README.md`, `templates/` and `taxonomy.yml` (where they exist) through the connector
before writing, exactly as the git path reads them off disk. **No angle brackets in any
front-matter value** on either route: ingesters read them as a tag and silently drop the field.

**Not this skill:** the Notion side of the same problem — a workspace *guest* whose queries
return empty rather than erroring — is context-notion's `notion-config`. This file is only about
reaching the context *repo*.
