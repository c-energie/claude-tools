---
name: curate-context
description: Curate the workspace's shared context so it stays lean as it grows — classify threads active vs settled, promote load-bearing facts into docs/memory.md, condense settled history into a themed digest (docs/Archive/history.md), archive raw threads to docs/Archive/threads/, and rebuild a one-line-per-thread index (docs/threads/INDEX.md). Outside a workspace, the same for a context repo's memory.md and threads/. Propose-then-apply. Triggers like "curate the context", "curate the workspace", "the context is getting large", "condense the threads down", "tidy memory.md", "run the monthly context review".
disable-model-invocation: true
---

# Curate the project's context

Keeps the **workspace's** context (ADR 0002) lean and navigable as its threads and memory
accumulate — so the `docs/memory.md` its `CLAUDE.md` imports into every session stays tight,
while nothing is lost. This is the periodic (~monthly) curation ritual, as a skill. Outside a
workspace it curates a legacy context repo exactly as before, at that repo's own paths.

> **Rewrites shared files, moves history and pushes — run only when asked.** Excluded from
> automatic invocation (`disable-model-invocation: true`).

**Layers it maintains** — the workspace path first, the context-repo path after it:

| Layer | Workspace | Context repo | What it is |
| --- | --- | --- | --- |
| memory | `docs/memory.md` | `memory.md` | Small, authoritative, load-bearing facts only. Loaded every session; keep it tight. |
| history | `docs/Archive/history.md` | `Archive/history.md` | Condensed, **themed** summaries of settled work. Read on demand, NOT loaded each session. Where old thread conclusions go once they're no longer load-bearing. |
| index | `docs/threads/INDEX.md` | `threads/INDEX.md` | One line per thread (active + archived): `YYYY-MM-DD · topic · status · gist · path`. |
| archive | `docs/Archive/threads/` | `Archive/threads/` | Raw settled threads, preserved out of the working layer. |

Below, `$MEM`, `$HIST`, `$THREADS` and `$ARCHIVE` mean the column for the route section 1
resolves. On both routes the archive is an `Archive/threads/` beside the thread directory,
which is exactly where `thread-index.mjs` derives it from `--dir` — so the index finds archived
threads without being told where they went.

**`GLOSSARY.md` is read, never written.** In a workspace it supplies theme vocabulary only: it
may be generated (net-flex regenerates it from Notion daily, and its domain-modelling skill is
told to add terms in Notion), so an edit here is overwritten the next day at best and fights
the source of truth at worst. A term curation shows is missing is a suggestion to the user.

## 1. Find the root

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/workspace-root.sh" --writable)"
```

The resolver names its route on stderr — **read it**, because the two routes curate different
paths:

- **`route=workspace`** — `ROOT` is the nearest `.claude/workspace.json`'s directory, and the
  workspace column above applies. From a member repo that is still the workspace root: the
  workspace is the one home for context, so a member's own `.claude/threads/` is not curated from
  here (section 6). The workspace route does no network of its own, so bring it up to date
  before reading anything:

  ```bash
  git -C "$ROOT" pull --ff-only --autostash
  ```

  If that fails (offline, diverged, a conflicting local edit), say why and stop — curating a
  stale copy and pushing it is how settled work gets un-settled. Never merge or rebase on the
  user's behalf.
- **`route=context-repo`** — no workspace: `ROOT` is the context repo, un-shallowed and pulled
  by the resolver as before, and the context-repo column applies. A malformed nearest
  `workspace.json` lands here too, named on stderr — say so, since it is probably not the home
  the user meant, and stop to ask.

Stop if it exits non-zero.

**This skill is shell-only.** It moves files, rewrites the memory file and rebuilds the index
with `thread-index.mjs` — multi-file, script-driven, and damaging if half-applied. Unlike
`save-thread` it has **no** GitHub-connector fallback (see `context-access`; in a workspace
`docs/memory.md` is outside Cowork's write allowlist anyway). In a sandbox session with no
shell, say that and defer the curation to a session with one.

Today's date: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" today`.

## 2. Read the current state

`$MEM`, the glossary (`GLOSSARY.md` in a workspace, `glossary.md` in a context repo), every
`$THREADS/*.md` (skip `README.md` / `INDEX.md`), and — if they exist — `$THREADS/INDEX.md` and
`$HIST`. Read the root's own `README.md` / `WORKFLOW.md` too where present (and in a workspace
its `CLAUDE.md`): a repo may state its own curation cadence and its own rule about commits vs
pull requests, and that rule wins over the defaults here.

## 3. Classify each thread

- **Active** — ongoing work; leave it in `$THREADS` untouched.
- **Settled / stale** — concluded, superseded, or dormant; these get condensed and archived.

This is the judgement the skill exists for. `dates.mjs age [date]` gives the exact days since a
thread's last dated update if "dormant" is the question — but silence alone doesn't settle a thread.

## 4. Propose the curation (do NOT write yet)

For the settled threads, propose:
- **Promote** any still-**load-bearing** durable fact up into the right `$MEM` section, in a
  line or two (not the whole thread). Condense — don't paste.
- **Condense** the rest into **`$HIST`** under a coherent **theme**. Take the themes from the
  project's own vocabulary — the memory file's headings, the glossary and (where it has one)
  `taxonomy.yml` — not from a generic list. Merge overlaps across threads into one themed
  summary, not one blob per thread.
- **Archive** each settled raw thread with `git mv`, from `$THREADS` to `$ARCHIVE`:
  `git -C "$ROOT" mv docs/threads/[file] docs/Archive/threads/[file]` in a workspace,
  `git -C "$ROOT" mv threads/[file] Archive/threads/[file]` in a context repo.
- Update the memory file's last-reviewed line, if it carries one, to today.

Present this as a clear plan, **naming every path in full** — which threads stay, which are
promoted / condensed / archived, the memory changes, and the history themes. In a workspace
every path in the plan is under `docs/`; a bare `memory.md`, `threads/` or `Archive/` there is
the legacy layout, and a sign the route was misread. The plan never includes the glossary.
**Get the user's confirmation before writing.**

## 5. Apply

1. Write `$MEM` and `$HIST` (create the history file, and `$ARCHIVE`, if absent); `git mv` the
   archived threads **first**, so the index is built from the final layout.
2. **Rebuild the index with the script** — date, title and path come off disk, so don't retype
   them. In a workspace, `--dir docs/threads` is what points it at ADR 0002's layout, and the
   archived rows then read `docs/Archive/threads/…`:

   ```bash
   # 1. see what's there (a dry run: prints, writes nothing)
   node "${CLAUDE_PLUGIN_ROOT}/scripts/thread-index.mjs" "$ROOT" --dir docs/threads
   # 2. supply only the two fields that need judgement, then write it
   node "${CLAUDE_PLUGIN_ROOT}/scripts/thread-index.mjs" "$ROOT" --dir docs/threads --gists gists.json --write
   ```

   In a context repo, the same two commands **without** `--dir` (it defaults to `threads`).
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
3. Stage only what curation touched — `$MEM`, `$HIST`, the moved threads and `$THREADS/INDEX.md`
   (`git -C "$ROOT" status --short` should show nothing else; `GLOSSARY.md` never). This changes
   shared understanding, so **ask the user before publishing** and follow the repo's own rule:
   open a pull request where the repo asks for one, else commit to the default branch. Report
   the PR / commit.

## 6. Two modes: which layer this session curates

**In a workspace there is one layer, and this is not a choice.** The workspace root is the one
home for context (ADR 0002), so a session anywhere inside it — the root or a member — curates
`docs/threads/` and nothing else, and `context-repo.sh --threads` / `PROJECT_CONTEXT_THREADS`
are not consulted. A member that still carries a `.claude/threads/` from before it joined is
the second home the ADR retires: say it is there, and leave it alone — moving it in is a
migration for the user to ask for, not a side effect of curating.

**Outside a workspace, the session's working directory decides, and it curates exactly one
layer** — exactly as before:

- **In the context repo** — curate the project's `threads/`, promoting into `memory.md` and
  archiving to `Archive/threads/`. Everything above describes this mode.
- **In a code repo** — curate that repo's own `.claude/threads/`, promoting into
  `.claude/memory.md` and archiving to `.claude/Archive/threads/`. Nothing else.

**Unless that code repo has routed its threads away.** Check before choosing:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --threads
```

`context` means this repo has no working layer of its own — it is shared as a tool, so its
working notes were written into the **context repo** instead. Curate that one, first mode above,
and leave `.claude/` here alone. The flag covers threads only: `.claude/memory.md` is still this
codebase's durable layer, so when a thread in the context repo settles into a fact about *this
code*, say so and offer to promote it here rather than into the project's `memory.md`. That
promotion crosses a repo boundary, so it is a suggestion to the user, never automatic.

Never both. A sweep across a project's code repos was considered and rejected: the context repo
does not know which code repos belong to it (the link runs child to parent only), there is no
way to resolve a code repo's name to a checkout on an arbitrary machine, and the judgement of
whether a thread has settled needs the code in front of you. Curating from a distance produces
confident wrong archiving.

### Code-repo mode, in detail

**Touch only these paths**, and say so before starting:

```
.claude/threads/           the working layer
.claude/Archive/threads/   settled threads, git mv'd here
.claude/memory.md          the durable layer this promotes into
```

Never source, tests, build config or `CLAUDE.md`. A curation skill loose in a codebase is a bad
shape, and the fact that it rewrites prose elsewhere is exactly why the boundary is stated
rather than assumed.

**`.claude/memory.md` is the promotion target, not `CLAUDE.md`.** `CLAUDE.md` is instructions
for working in the repo; a durable record of what was tried and concluded is a different kind of
thing, and merging them turns the instructions into a changelog. Create `.claude/memory.md` if
absent, with a `_Last reviewed:_` line. The session-start hook injects it, so it is loaded
rather than merely pointed at, which means the same discipline applies: keep it tight.

**Archiving alone is a complete outcome.** Not every settled thread has a durable fact in it.
"Here is how the nav rework went" is finished work, not a standing instruction, and archiving it
without promoting anything is the right answer.

Rebuild that layer's index with the same script, pointed at it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/thread-index.mjs" "$PWD" --dir .claude/threads --gists g.json --write
```

**Check `.claude/` is not gitignored** before writing. A `/.claude/*` rule would make the whole
layer invisible to everyone else, silently.

## 7. Boundaries

- **Never delete** a thread — archive it. **Never** rewrite an active thread's content.
- **Never write the glossary** — `GLOSSARY.md`, or `glossary.md` in a context repo. It is read
  for vocabulary only; see the top of this file.
- Where the project has a structured decision log (`state.notion` in a workspace's
  `workspace.json`; its `context.json` outside one), decisions belong there — `log-decision`,
  not the memory file; summarise only the load-bearing ones in it.
- Stay faithful — condense and reorganise; don't invent conclusions a thread didn't actually reach.

**Outside a workspace, curating the other layer is this skill too**, run from the other
directory: open a session in
the code repo to curate its threads, or in the context repo to curate the project's. If you
notice the layer you are *not* in going stale, say so rather than reaching into it.

**Not this skill:** writing up the current session is `save-thread`; re-reading the context is
`refresh-context`; checking a repo's config and layout for silent drift is `context-doctor`.
