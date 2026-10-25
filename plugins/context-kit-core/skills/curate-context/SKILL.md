---
name: curate-context
description: Curate the workspace's shared context so it stays lean as it grows — classify threads active vs settled, promote load-bearing facts into docs/memory.md, condense settled history into a themed digest (docs/Archive/history.md), archive raw threads to docs/Archive/threads/, and rebuild a one-line-per-thread index (docs/threads/INDEX.md). Propose-then-apply. Triggers like "curate the context", "curate the workspace", "the context is getting large", "condense the threads down", "tidy memory.md", "run the monthly context review".
disable-model-invocation: true
---

# Curate the project's context

Keeps the **workspace's** context (ADR 0002) lean and navigable as its threads and memory
accumulate, so the `docs/memory.md` its `CLAUDE.md` imports into every session stays tight
while nothing is lost. This is the periodic (~monthly) curation ritual, as a skill.

> **Rewrites shared files, moves history and pushes — run only when asked.** Excluded from
> automatic invocation (`disable-model-invocation: true`).

**Layers it maintains:**

| Layer | Path | What it is |
| --- | --- | --- |
| memory | `docs/memory.md` | Small, authoritative, load-bearing facts only. Loaded every session; keep it tight. |
| history | `docs/Archive/history.md` | Condensed, **themed** summaries of settled work. Read on demand, NOT loaded each session. Where old thread conclusions go once they're no longer load-bearing. |
| index | `docs/threads/INDEX.md` | One line per thread (active + archived): `YYYY-MM-DD · topic · status · gist · path`. |
| archive | `docs/Archive/threads/` | Raw settled threads, preserved out of the working layer. |

The archive is an `Archive/threads/` beside the thread directory, which is exactly where
`thread-index.mjs` derives it from `--dir`, so the index finds archived threads without being
told where they went.

**`GLOSSARY.md` is read, never written.** It supplies theme vocabulary only: it may be generated
(net-flex regenerates it from Notion daily, and its domain-modelling skill is told to add terms
in Notion), so an edit here is overwritten the next day at best and fights the source of truth
at worst. A term curation shows is missing is a suggestion to the user.

## 1. Find the root

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/workspace-root.sh")"
```

`ROOT` is the nearest `.claude/workspace.json`'s directory. From a member repo that is still the
workspace root: the workspace is the one home for context, so a member's own `.claude/threads/`
is not curated from here (section 6). A non-zero exit (`route=none` on stderr) means there is no
workspace, or the nearest `workspace.json` is malformed (named on stderr): say so and stop. A
folder becomes a workspace through `project-workspace:setup-project-workspace`.

The resolver does no network, so bring the workspace up to date before reading anything:

```bash
git -C "$ROOT" pull --ff-only --autostash
```

If that fails (offline, diverged, a conflicting local edit), say why and stop: curating a stale
copy and pushing it is how settled work gets un-settled. Never merge or rebase on the user's
behalf.

**This skill is shell-only.** It moves files, rewrites the memory file and rebuilds the index
with `thread-index.mjs`: multi-file, script-driven, and damaging if half-applied. Unlike
`save-thread` it has **no** GitHub-connector fallback (see `context-access`; `docs/memory.md` is
outside Cowork's write allowlist anyway). In a sandbox session with no shell, say that and defer
the curation to a session with one.

Today's date: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" today`.

## 2. Read the current state

`docs/memory.md`, `GLOSSARY.md`, every `docs/threads/*.md` (skip `README.md` / `INDEX.md`), and,
if they exist, `docs/threads/INDEX.md` and `docs/Archive/history.md`. Read the root's own
`README.md` / `WORKFLOW.md` / `CLAUDE.md` too where present: a repo may state its own curation
cadence and its own rule about commits vs pull requests, and that rule wins over the defaults
here.

## 3. Classify each thread

- **Active** — ongoing work; leave it in `docs/threads/` untouched.
- **Settled / stale** — concluded, superseded, or dormant; these get condensed and archived.

This is the judgement the skill exists for. `dates.mjs age [date]` gives the exact days since a
thread's last dated update if "dormant" is the question — but silence alone doesn't settle a thread.

## 4. Propose the curation (do NOT write yet)

For the settled threads, propose:
- **Promote** any still-**load-bearing** durable fact up into the right `docs/memory.md`
  section, in a line or two (not the whole thread). Condense; don't paste.
- **Condense** the rest into **`docs/Archive/history.md`** under a coherent **theme**. Take the
  themes from the project's own vocabulary (the memory file's headings, the glossary and, where
  it has one, `taxonomy.yml`), not from a generic list. Merge overlaps across threads into one
  themed summary, not one blob per thread.
- **Archive** each settled raw thread with `git mv`:
  `git -C "$ROOT" mv docs/threads/[file] docs/Archive/threads/[file]`.
- Update the memory file's last-reviewed line, if it carries one, to today.

Present this as a clear plan, **naming every path in full**: which threads stay, which are
promoted / condensed / archived, the memory changes, and the history themes. Every path in the
plan is under `docs/`; a bare `memory.md`, `threads/` or `Archive/` is the retired context-repo
layout, and a sign something was misread. The plan never includes the glossary.
**Get the user's confirmation before writing.**

## 5. Apply

1. Write `docs/memory.md` and `docs/Archive/history.md` (create the history file, and
   `docs/Archive/threads/`, if absent); `git mv` the archived threads **first**, so the index is
   built from the final layout.
2. **Rebuild the index with the script.** Date, title and path come off disk, so don't retype
   them; `--dir docs/threads` points it at ADR 0002's layout, and the archived rows then read
   `docs/Archive/threads/…`:

   ```bash
   # 1. see what's there (a dry run: prints, writes nothing)
   node "${CLAUDE_PLUGIN_ROOT}/scripts/thread-index.mjs" "$ROOT" --dir docs/threads
   # 2. supply only the two fields that need judgement, then write it
   node "${CLAUDE_PLUGIN_ROOT}/scripts/thread-index.mjs" "$ROOT" --dir docs/threads --gists gists.json --write
   ```

   Keep `gists.json` in a temp dir, never in the repo.

   `gists.json` is `{"[filename].md": {"status": "active", "gist": "one line"}}`. Anything you omit
   is left as a visible `TODO:` — never leave those in a committed index.

   **`audience:` is not one of the fields you supply here.** It is read from each thread's own
   front-matter and rendered as a column. `status` and `gist` are index-side judgements *about*
   a thread and belong to whoever rebuilds the index; audience is a property *of* the thread,
   authored with it. If curation shows a thread is plainly a document the team should read, edit
   that thread's front-matter and rebuild — never route it through `gists.json`, which would
   create a second place to answer the same question. The script reports how many threads
   declare no audience at all; that count is information, not a TODO to clear.
   Read its stderr: a line it could not parse means a hand-written gist was not carried — look
   before committing.
3. Stage only what curation touched: `docs/memory.md`, `docs/Archive/history.md`, the moved
   threads and `docs/threads/INDEX.md` (`git -C "$ROOT" status --short` should show nothing
   else; `GLOSSARY.md` never). This changes shared understanding, so **ask the user before
   publishing** and follow the repo's own rule: open a pull request where the repo asks for one,
   else commit to the default branch. Report the PR / commit.

## 6. One layer

**There is one layer, and this is not a choice.** The workspace root is the one home for
context (ADR 0002), so a session anywhere inside it, the root or a member, curates
`docs/threads/` and nothing else. A member that still carries a `.claude/threads/` from before
it joined is the second home the ADR retires: say it is there, and leave it alone. Moving it in
is a migration for the user to ask for, not a side effect of curating.

## 7. Boundaries

- **Never delete** a thread — archive it. **Never** rewrite an active thread's content.
- **Never write `GLOSSARY.md`.** It is read for vocabulary only; see the top of this file.
- Where the project has a structured decision log (`state.notion` in `workspace.json`),
  decisions belong there (`log-decision`), not the memory file; summarise only the load-bearing
  ones in it.
- Stay faithful — condense and reorganise; don't invent conclusions a thread didn't actually reach.

**Not this skill:** writing up the current session is `save-thread`; re-reading the context is
`refresh-context`; checking a workspace's config and layout for silent drift is `context-doctor`.
