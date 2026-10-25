---
name: refresh-context
description: Pull the workspace mid-session and re-read its memory and thread index — docs/memory.md and docs/threads/INDEX.md — then report what changed since the recorded HEAD. Use when someone has just pushed, when this session has been open a while, when the session-start check said the workspace is behind, or before acting on anything the context says. Triggers like "refresh the context", "refresh the workspace", "update the context", "pull the workspace", "pull the latest memory", "has anything changed in the context".
---

# Refresh the shared context

Pulls the **workspace** the session is in (ADR 0002), re-reads its memory and thread index, and
says what changed. Nothing else: this skill is **read-only**. It never writes, commits or pushes,
and it pulls with `--ff-only` only.

**Why it exists:** Claude Code reads `CLAUDE.md`, and through it `@docs/memory.md`, **once**,
when the session starts. A session left open while someone pushes keeps answering from the copy
it read hours ago, and has no way to tell. The session-start hook can only say the workspace is
*behind*; it never pulls. This is the manual pull, and the re-read that goes with it.

**It injects nothing.** Re-reading the files is the whole job.

## 0. In Cowork, or wherever git is unavailable

Do not report "context unavailable". Read the workspace over the **GitHub connector** instead —
`context-access` says which repo and which connector: the top-level `repo` of the
`workspace.json` uploaded to the project, never a `members[].repo`, and the connector keyed by
that repo's owner. Re-read `.claude/workspace.json` from `repo` as that skill describes. Then
read `docs/memory.md` in full; `docs/threads/INDEX.md` (or list `docs/threads/` and read the
newest few); and recent commits on the default branch for the "what changed". Continue from
step 3, and **say that you could not pull**: you read the remote over the API, there is no
checkout, and provenance differs between the routes.

No uploaded `workspace.json`? Say no workspace is configured, never guess one. If neither a
shell nor a GitHub connector is available, say exactly that and stop; quietly falling back to
whatever loaded at session start is not an answer.

## 1. Find the root and record HEAD before pulling

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/workspace-root.sh")"
BEFORE="$(git -C "$ROOT" rev-parse HEAD)"
git -C "$ROOT" status -sb | head -n 1
```

`ROOT` is the nearest `.claude/workspace.json`'s directory; from a member repo that is still the
workspace root, never the member. The resolver reads the filesystem only, so `$BEFORE` is
genuinely the commit this session has been reading.

A non-zero exit (`route=none` on stderr) means **no workspace**: there is no `.claude/workspace.json`
above the working directory, or the nearest one is malformed (named on stderr). Say that plainly
with the resolver's reason and stop. A folder becomes a workspace through
`project-workspace:setup-project-workspace`.

From the `status -sb` line, tell the user if either is true: **`[ahead N]`** (a previous push
failed; pulling does not publish those commits, so offer to push) or a **dirty worktree** (the
pull autostashes; worth saying only if the stash pop conflicts).

## 2. Pull

The workspace is a checkout the user made, so their own credential helper already reaches it:

```bash
git -C "$ROOT" pull --ff-only --autostash
```

**A pull that fails is reported, never forced.** If it cannot fast-forward (the checkout has
diverged), say so and let the user decide; never merge, rebase or reset on their behalf. If it
failed for any other reason (offline, auth, a timeout), say why; retry once if it looks
transient. Either way **everything below is then read from the old copy, so say so**: a silently
stale re-read is the one failure mode that actively misleads.

## 3. Re-read

ADR 0002's layout:

- `docs/memory.md`, **in full**. It supersedes the copy `CLAUDE.md` imported at session start.
- `docs/threads/INDEX.md`; with no index, list `docs/threads/*.md` and read the newest few.
- `GLOSSARY.md` only if the diff below touched it.

## 4. Report what changed

```bash
git -C "$ROOT" log --oneline "$BEFORE"..HEAD
git -C "$ROOT" diff --stat "$BEFORE"..HEAD
```

- **HEAD did not move**: say **"nothing changed"**, with the newest commit's date, and stop.
- **It moved**: read the actual diffs, not just the log subjects:
  - **memory** (`docs/memory.md`) changed → say what, **explicitly**, and re-check any live
    conclusion reasoned from the old copy.
  - **threads** (`docs/threads/*.md`) added or changed → name them; offer to read one in full.
  - **meetings** (`docs/meetings/`) added or changed → name them.
  - **`.context/pending/`** entries added or changed → someone queued structured items; surface
    them.
  - **a mirror** (`.context/notion/`) changed → give its new `syncedOn`.

## 5. Boundaries

- **Read-only.** Writing is `save-thread`; never fold a commit into a refresh.
- The pull is `--ff-only`; never merge, rebase or force-update.
- Mirrors stay snapshots after refreshing; the backing workspace wins over them.

**Not this skill:** writing the session up into the workspace is `save-thread`; what is
outstanding in the queues is `context-status`; condensing threads and promoting facts is
`curate-context`; making a folder a workspace is `project-workspace:setup-project-workspace`.
