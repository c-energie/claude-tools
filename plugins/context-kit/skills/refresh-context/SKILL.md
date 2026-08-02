---
name: refresh-context
description: Re-pull the project's shared context repo mid-session and re-read it — memory.md, thread pointers and any mirrors — then report what changed since the session started. Use when someone has just pushed, when this session has been open a while, when the session-start load warned it was stale or unavailable, or before acting on anything the context says. Triggers like "refresh the context", "update the context", "re-pull the context repo", "pull the latest memory.md", "has anything changed in the context".
---

# Refresh the shared context

Pulls the project's context repo (`${FLEXSENSE_CONTEXT_REPO:-net-flex/context}`) again and
re-reads it into the session. Nothing else — this skill is **read-only**: it never writes,
commits or pushes.

**Why it exists:** the plugin's `SessionStart` hook loads `memory.md` and the thread pointers
**once**, at `startup` or `resume`. A session left open while someone pushes keeps answering
from the copy it read hours ago — and has no way to tell. Same problem when the hook printed
its STALE banner, or when the context wasn't available at all. This is the manual re-run.

## 0. In Cowork, or wherever git is unavailable

Do not report "context unavailable". Read the context repo over the **GitHub MCP server**
instead. Which repo: the project's `.claude/settings.json` env value if visible, else a
one-line `.context-repo` / `context-repo.txt` marker in the working folder, `/mnt/project/`, or `~/mnt/.projects/*/docs/`
(Cowork surfaces attached project files there), else `net-flex/context`. Read `memory.md` in
full; `threads/INDEX.md` (or list `threads/` and read the newest few);
any mirror's `_synced.json` for its `syncedOn` date; recent commits on `main` for the "what
changed". Then continue from step 3, and **say you used the connector rather than a checkout**
— provenance differs between the routes. If neither a shell nor a GitHub connector is
available, say exactly that and stop; quietly falling back to whatever loaded at session start
is not an answer.

## 1. Note where you are before pulling

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --no-pull)"
BEFORE="$(git -C "$ROOT" rev-parse HEAD)"
git -C "$ROOT" status -sb | head -n 1
```

`--no-pull` resolves the checkout without touching the network, so `$BEFORE` is genuinely the
commit this session has been working from. If it exits non-zero there is **no checkout at all**
(offline, or no credentials for a private repo) — say that plainly and stop.

From the `status -sb` line, tell the user if either is true: **`[ahead N]`** (a previous push
failed — pulling does not publish those commits; offer to push) or a **dirty worktree** (the
pull autostashes; worth saying only if the stash pop conflicts).

## 2. Re-pull and re-read

```bash
bash "${CLAUDE_PLUGIN_ROOT}/hooks/load-context.sh" --refresh
```

Deliberately the **same script the session-start hook runs** — one implementation, so the
manual refresh cannot drift from the automatic one. Treat its output as the current shared
context, superseding whatever loaded at session start.

**If it prints the `WARNING — THIS CONTEXT MAY BE STALE` banner, relay that.** The pull failed
and you are still on the old copy. Retry once if it looks like a transient timeout
(`FLEXSENSE_GIT_TIMEOUT=60` raises the 30s cap), then report the failure.

## 3. Report what changed

```bash
git -C "$ROOT" log --oneline "$BEFORE"..HEAD
git -C "$ROOT" diff --stat "$BEFORE"..HEAD
```

- **Nothing new** — one line ("already current, newest commit dated …") and stop.
- **Something new** — read the actual diffs, not just the log subjects:
  `memory.md` changed → say what, explicitly; re-check any live conclusion reasoned from the
  old copy. New or updated `threads/*.md` → name them; offer to read one in full. A mirror
  directory changed → give its new `syncedOn`. `pending/` changed → someone queued structured
  items; surface them.

## 4. Boundaries

- **Read-only.** Writing is `save-thread`; never fold a commit into a refresh.
- The pull is `--ff-only`; never merge, rebase or force-update. If the checkout diverged,
  report it and let the user decide.
- Mirrors stay snapshots after refreshing — the backing workspace wins over them.

**Not this skill:** writing the session up into the context repo is `save-thread`.
