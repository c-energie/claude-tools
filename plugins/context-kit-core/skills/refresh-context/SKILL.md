---
name: refresh-context
description: Pull the workspace mid-session and re-read its memory and thread index — docs/memory.md and docs/threads/INDEX.md (outside a workspace, the context repo's memory.md and threads/) — then report what changed since the recorded HEAD. Use when someone has just pushed, when this session has been open a while, when the session-start check said the workspace is behind, or before acting on anything the context says. Triggers like "refresh the context", "refresh the workspace", "update the context", "pull the workspace", "re-pull the context repo", "pull the latest memory", "has anything changed in the context".
---

# Refresh the shared context

Pulls the **workspace** the session is in (ADR 0002), re-reads its memory and thread index, and
says what changed. Outside a workspace it does the same against the project's context repo,
reading the same files it always read. Nothing else — this skill is **read-only**: it never
writes, commits or pushes, and it pulls with `--ff-only` only.

**Why it exists:** Claude Code reads `CLAUDE.md` — and through it `@docs/memory.md` — **once**,
when the session starts. A session left open while someone pushes keeps answering from the copy
it read hours ago, and has no way to tell. The session-start hook can only say the workspace is
*behind*; it never pulls. This is the manual pull, and the re-read that goes with it.

**It does not run the session-start loader, and injects nothing.** Re-reading the files is the
whole job. It used to run `hooks/load-context.sh --refresh`, which in a workspace would have
printed nothing (the hook loads nothing there) and outside one re-injected a block that
duplicates what the reads below already do.

## 0. In Cowork, or wherever git is unavailable

Do not report "context unavailable". Read the workspace over the **GitHub connector** instead —
`context-access` says which repo and which connector: the top-level `repo` of the
`workspace.json` uploaded to the project, never a `members[].repo`, and the connector keyed by
that repo's owner. Re-read `.claude/workspace.json` from `repo` as that skill describes. Then
read `docs/memory.md` in full; `docs/threads/INDEX.md` (or list `docs/threads/` and read the
newest few); and recent commits on the default branch for the "what changed". Continue from
step 3, and **say that you could not pull** — you read the remote over the API, there is no
checkout, and provenance differs between the routes.

No uploaded `workspace.json`? Then it may be a legacy context repo not yet migrated, found as
before: the project's `.claude/settings.json` env value if visible, else a one-line
`.context-repo` / `context-repo.txt` marker in the working folder, `/mnt/project/` or
`~/mnt/.projects/*/docs/`. Read that repo the same way at its old paths — `memory.md`,
`threads/INDEX.md`, any mirror's `_synced.json`. Neither found → say no workspace is
configured, never guess one. If neither a shell nor a GitHub connector is available, say exactly
that and stop; quietly falling back to whatever loaded at session start is not an answer.

## 1. Find the root and record HEAD before pulling

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/workspace-root.sh" --no-pull)"
BEFORE="$(git -C "$ROOT" rev-parse HEAD)"
git -C "$ROOT" status -sb | head -n 1
```

The resolver names its route on stderr — **read it**, because the two routes read different
paths below:

- **`route=workspace`** — `ROOT` is the nearest `.claude/workspace.json`'s directory. From a
  member repo that is still the workspace root, never the member.
- **`route=context-repo`** — no workspace; `ROOT` is the legacy context repo checkout. A
  malformed nearest `workspace.json` lands here too, named on stderr — say so, since it is
  probably not the home the user meant.

`--no-pull` resolves without touching the network, so `$BEFORE` is genuinely the commit this
session has been reading. A non-zero exit means **no root at all** (no workspace, and no context
repo configured or reachable) — say that plainly, with the resolver's reason, and stop.

From the `status -sb` line, tell the user if either is true: **`[ahead N]`** (a previous push
failed — pulling does not publish those commits; offer to push) or a **dirty worktree** (the
pull autostashes; worth saying only if the stash pop conflicts).

## 2. Pull

**`route=workspace`** — the workspace is a checkout the user made, so their own credential
helper already reaches it:

```bash
git -C "$ROOT" pull --ff-only --autostash
```

**`route=context-repo`** — let the resolver pull, exactly as before: it carries the token
handling, the 30s cap (`CONTEXT_GIT_TIMEOUT`) and the auth-versus-offline diagnosis a managed
clone needs.

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/workspace-root.sh" > /dev/null
```

It prints `pull failed …` on stderr when the pull did not happen; it still exits 0 then, because
it has a local copy to offer.

**A pull that fails is reported, never forced.** If it cannot fast-forward (the checkout has
diverged), say so and let the user decide — never merge, rebase or reset on their behalf. If it
failed for any other reason (offline, auth, a timeout), say why; retry once if it looks
transient. Either way **everything below is then read from the old copy — say so**: a silently
stale re-read is the one failure mode that actively misleads.

## 3. Re-read

**`route=workspace`** (ADR 0002's layout):

- `docs/memory.md` — **in full**. It supersedes the copy `CLAUDE.md` imported at session start.
- `docs/threads/INDEX.md`; with no index, list `docs/threads/*.md` and read the newest few.
- `GLOSSARY.md` only if the diff below touched it.

**`route=context-repo`** — the same files the old refresh re-injected:

- `memory.md` in full; `threads/INDEX.md`, or the newest few `threads/*.md`.
- `Archive/history.md`'s section headings only — enough to know whether an answer is in there.
- When the working directory is a different repo from `$ROOT`, its own `.claude/memory.md` in
  full and the names of its `.claude/threads/`.
- Each `notion/_synced.json`'s `syncedOn`, where a mirror exists.

## 4. Report what changed

```bash
git -C "$ROOT" log --oneline "$BEFORE"..HEAD
git -C "$ROOT" diff --stat "$BEFORE"..HEAD
```

- **HEAD did not move** — say **"nothing changed"**, with the newest commit's date, and stop.
- **It moved** — read the actual diffs, not just the log subjects:
  - **memory** (`docs/memory.md`; `memory.md` in a context repo) changed → say what,
    **explicitly**, and re-check any live conclusion reasoned from the old copy.
  - **threads** (`docs/threads/*.md`; `threads/*.md`) added or changed → name them; offer to
    read one in full.
  - **meetings** (`docs/meetings/`) added or changed → name them.
  - **`.context/pending/`** (`pending/` in a context repo) entries added or changed → someone
    queued structured items; surface them.
  - **a mirror** (`.context/notion/`; `notion/` in a context repo) changed → give its new
    `syncedOn`.

## 5. Boundaries

- **Read-only.** Writing is `save-thread`; never fold a commit into a refresh.
- **Never runs the session-start loader** (`hooks/load-context.sh`), in either route.
- The pull is `--ff-only`; never merge, rebase or force-update.
- Mirrors stay snapshots after refreshing — the backing workspace wins over them.

**Not this skill:** writing the session up into the workspace is `save-thread`; what is
outstanding in the queues is `context-status`; condensing threads and promoting facts is
`curate-context`.
