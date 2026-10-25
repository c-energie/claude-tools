---
name: context-access
description: How to reach the project's workspace repo over the GitHub API — the MCP route sandbox sessions (Cowork) use, git being unavailable there. Defines which route each surface takes, which repo and connector the uploaded workspace.json names, the paths Cowork may write, and the rules that keep an API write from truncating a file. Background knowledge for save-thread, refresh-context, curate-context and the pending queue; not a task to run.
user-invocable: false
---

# Reaching the workspace repo over the GitHub API

**A project's context is reached two different ways, one per surface.** Which one applies is a
property of where the session is running, not something to discover by failure:

- **Claude Code on a laptop** — the context is the workspace checkout, found with
  `${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs` (the nearest `.claude/workspace.json`), and
  `git` is the route. Full history, atomic commits, and the `scripts/*.mjs` are all available.
  Prefer this whenever `bash` runs.
- **Cowork / cloud sandboxes** — the **GitHub API over MCP**, described in this file, against
  the workspace's own repo. Git is not the route there. Reads are complete and current; writes
  commit straight to the default branch, which is where the sharp edges are (see the rules
  below), and they are limited to three paths.

**Say which route produced the answer** — its provenance changes with it. Never present an API
read as a git one, and never answer from the copy loaded at session start while claiming it is
current.

If neither route is available, structured rows can still go to the project's backend (Notion:
`add-action` / `log-decision` / `add-open-question`). Narrative (`threads/`) has nowhere to go:
say so plainly rather than writing it somewhere it will be lost.

This file is the canonical description of the API route; the skills point here rather than each
carrying their own copy.

## Which repo, and which connector

Both come from the workspace's **`workspace.json`**, never a guess. In Cowork it arrives as a
file uploaded to the project — wherever the sandbox put it (`/mnt/project/`, `~/mnt/uploads/`,
`~/mnt/.projects/[uuid]/docs/`, flat or under `.claude/`). The connection gate finds it with
`${CLAUDE_PLUGIN_ROOT}/scripts/cowork-workspace.mjs`; without a shell, look in those places
yourself.

- **The repo** — the top-level **`repo`** (`owner/name`). That one, and **never a
  `members[].repo`**: the members are code and documents with their own history, not the place
  context lives, and a Cowork write into one is refused by the gate.
- **The connector** — `connections.github`, chosen exactly as on a laptop: a single name is the
  connector, and an owner-keyed map
  (`{ "github": { "c-energie": "github-c-energie", "your-user": "github-personal" } }`, needed
  because a fine-grained PAT has a single resource owner) is read at **the owner of `repo`**.
  From Cowork every other GitHub connector is refused — including the map's other entries, which
  reach other owners' repositories and are not needed for the one repo this route touches.
  Guessing would cost a 404 that says "not found" when it means "wrong credential".
  `connection-gate.mjs` enforces this rather than trusting it.

**The uploaded copy only bootstraps.** It is a snapshot from whenever someone uploaded it, so
take exactly two things from it — `repo` and the connector name — and then **re-read
`.claude/workspace.json` from `repo` over the API**. That copy wins for everything else
(`state.*`, `members`, `connections` changes made since), and if it disagrees with the upload on
`repo` or the connector, say so: the upload is stale and should be replaced. (The gate, which has
no API access, keeps using the uploaded copy; that is why only those two keys are trusted from
it.) No uploaded `workspace.json` at all means the gate is failing open — say so, and ask for it
to be attached to the project rather than guessing a repo.

Pass `branch` explicitly (usually `main`) rather than relying on the tool's default.

## What Cowork may write

**Writes go to the workspace `repo` only, and only under:**

- `docs/threads/` — working threads (`save-thread`)
- `docs/meetings/` — meeting notes
- `.context/` — machine state, such as the pending queue (`.context/pending/`)

**Everything else is read-only from Cowork** — `docs/memory.md`, `GLOSSARY.md`, `docs/adr/`,
`CLAUDE.md`, code, all of it. The reason is the rule below that bites hardest: an API write
replaces the whole file, so a curated file rebuilt from a partial or stale read is silently
truncated, with no diff anyone sees before it is public. Threads, meetings and queue entries are
created or appended one at a time and survive that; the curated files are exactly the ones a
truncation would quietly destroy. **Curate them from a laptop**, where git shows the diff — and
if the user asks for such an edit here, say so and draft the change in the reply instead.

This is enforced, not merely asked: the connection gate denies any path-taking GitHub write
(`create_or_update_file`, `push_files`, `delete_file`, and the like) outside those prefixes or
outside `repo`, naming the allowlist. A `push_files` with one disallowed path is refused whole.
Paths are compared normalised, so `docs/threads/../memory.md` is refused too.

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

The token wants to be **fine-grained**, scoped to this project's workspace repo, Contents
**read and write**, with an expiry. A GitHub PAT has a single resource owner, so a second owner needs a
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
| List a directory | `docs/threads/`, `.context/pending/` | `get_file_contents` with a directory path, which returns entries |
| Recent commits | "what changed since" | `list_commits` |
| Write one file | `save-thread`, `add-pending` | `create_or_update_file` — needs `sha` when the file exists |
| Write several in one commit | rare here | `push_files` |

If the server is missing, or an operation you need has no tool, **stop and name the missing
piece.** "I can read the context but cannot write it" is a useful, true answer; guessing a tool
name and reporting success is not.

When the server is missing entirely, the diagnosis is: is a `workspace.json` attached to the
project at all, and is the connection it declares present in this session? Then
`setup-connectors` (is the
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
  and it has no equivalent on the git path, where a diff would have shown it. It is also why
  the curated files are off-limits here (see *What Cowork may write*).
- **Updating an existing file needs its blob `sha`**, returned by `get_file_contents`. Read
  immediately before writing, and pass that `sha` through. Omitting it on a file that exists is
  rejected as a create-over-existing; passing a stale one is the API telling you someone else
  changed the file in between — **re-read and reapply**, never force. Creating a genuinely new
  file takes no `sha`.
- **Appending means read + append + write back whole**, for the same reason. `.context/pending/`
  entries and dated thread updates are both appends.
- **Pass plain text** where the tool accepts it. Only base64-encode if the tool requires it, and
  never double-encode — a base64 blob committed as text is the kind of thing nobody notices for
  a week.
- Commit messages follow the workspace repo's own convention exactly as on the git path
  (`threads: [topic]`, `pending: [what]`).

## What this path cannot do

Say so rather than half-doing it:

- **`curate-context`** — moves files, rewrites `docs/memory.md`, and rebuilds
  `docs/threads/INDEX.md` with `thread-index.mjs`. Multi-file, script-driven, destructive if
  half-applied — and `docs/memory.md` is outside the write allowlist anyway. Shell only.
- **`memory-triage`'s promotion into `docs/memory.md`**, and any edit to `GLOSSARY.md` or
  `docs/adr/` — read-only from Cowork, by the allowlist above.
- **`sync-notion-mirror`** (context-notion) — `mirror-render.mjs` owns the mirror folder so that
  an unchanged Notion produces no diff. Hand-writing that folder destroys the property that
  makes its `git diff` readable. Shell only, and **never hand-edit the mirror**.
- **Anything needing `scripts/*.mjs`** — date arithmetic, triage buckets, index rebuilds,
  `pending-parse.mjs`. Without a shell there is no script; do the reasoning in prose, say that
  you did, and prefer to defer the job to a session that has one.

## Rules that do not change

The workspace's own house rules for `docs/threads/` hold on either route — read its
`docs/threads/README.md` and any templates it points at (where they exist) through the connector
before writing, exactly as the git path reads them off disk. **No angle brackets in any
front-matter value** on either route: ingesters read them as a tag and silently drop the field.

**Not this skill:** the Notion side of the same problem — a workspace *guest* whose queries
return empty rather than erroring — is context-notion's `notion-config`; declaring or provisioning
a connector is `setup-connectors`. This file is only about reaching the workspace *repo*.
