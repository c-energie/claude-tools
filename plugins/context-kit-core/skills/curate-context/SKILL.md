---
name: curate-context
description: Curate the project's shared context repo so it stays lean as it grows — classify threads active vs settled, promote load-bearing facts into memory.md, condense settled history into a themed digest (Archive/history.md), archive raw threads to Archive/threads/, and rebuild a one-line-per-thread index (threads/INDEX.md). Propose-then-apply. Triggers like "curate the context", "the context is getting large", "condense the threads down", "tidy memory.md", "run the monthly context review".
disable-model-invocation: true
---

# Curate the project's context

Keeps the project's context repo lean and navigable as `threads/` and `memory.md` accumulate —
so the `memory.md` the plugin injects every session stays tight, while nothing is lost. This is
the periodic (~monthly) curation ritual, as a skill.

> **Rewrites shared files, moves history and pushes — run only when asked.** Excluded from
> automatic invocation (`disable-model-invocation: true`).

**Layers it maintains:**
- **`memory.md`** — small, authoritative, load-bearing facts only. Injected every session; keep it tight.
- **`Archive/history.md`** — condensed, **themed** summaries of settled work. Read on demand, NOT
  injected each session. Where old thread conclusions go once they're no longer load-bearing.
- **`threads/INDEX.md`** — one line per thread (active + archived): `YYYY-MM-DD · topic · status · gist · path`.
- **`Archive/threads/`** — raw settled threads, preserved out of the working layer.

## 1. Find the context checkout

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --writable)"
```

Same resolver `save-thread` and the session-start hook use: current repo if it *is* the context
repo, else the managed clone; un-shallowed and pulled. Stop if it exits non-zero.

**This skill is shell-only.** It moves files, rewrites `memory.md` and rebuilds the index with
`thread-index.mjs` — multi-file, script-driven, and damaging if half-applied. Unlike
`save-thread` it has **no** GitHub-connector fallback (see `context-access`). In a sandbox
session with no shell, say that and defer the curation to a session with one.

Today's date: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" today`.

## 2. Read the current state

`memory.md`, `glossary.md`, every `threads/*.md` (skip `README.md` / `INDEX.md`), and — if they
exist — `threads/INDEX.md` and `Archive/history.md`. Read the repo's own `README.md` /
`WORKFLOW.md` too where present: a context repo may state its own curation cadence and its own
rule about commits vs pull requests, and that rule wins over the defaults here.

## 3. Classify each thread

- **Active** — ongoing work; leave it in `threads/` untouched.
- **Settled / stale** — concluded, superseded, or dormant; these get condensed and archived.

This is the judgement the skill exists for. `dates.mjs age [date]` gives the exact days since a
thread's last dated update if "dormant" is the question — but silence alone doesn't settle a thread.

## 4. Propose the curation (do NOT write yet)

For the settled threads, propose:
- **Promote** any still-**load-bearing** durable fact up into the right `memory.md` section, in a
  line or two (not the whole thread). Condense — don't paste.
- **Condense** the rest into **`Archive/history.md`** under a coherent **theme**. Take the themes
  from the project's own vocabulary — its `memory.md` headings, `glossary.md` and (where it has
  one) `taxonomy.yml` — not from a generic list. Merge overlaps across threads into one themed
  summary, not one blob per thread.
- **Archive** each settled raw thread: `git -C "$ROOT" mv threads/[file] Archive/threads/[file]`.
- Update `memory.md`'s last-reviewed line, if it carries one, to today.

Present this as a clear plan: which threads stay, which are promoted / condensed / archived, the
`memory.md` changes, and the `history.md` themes. **Get the user's confirmation before writing.**

## 5. Apply

1. Write `memory.md` and `Archive/history.md`; `git mv` the archived threads **first**, so the
   index is built from the final layout.
2. **Rebuild the index with the script** — date, title and path come off disk, so don't retype them:

   ```bash
   # 1. see what's there
   node "${CLAUDE_PLUGIN_ROOT}/scripts/thread-index.mjs" "$ROOT"
   # 2. supply only the two fields that need judgement, then write it
   node "${CLAUDE_PLUGIN_ROOT}/scripts/thread-index.mjs" "$ROOT" --gists gists.json --write
   ```

   `gists.json` is `{"[filename].md": {"status": "active", "gist": "one line"}}`. Anything you omit
   is left as a visible `TODO:` — never leave those in a committed index.
3. This changes shared understanding, so **ask the user before publishing** and follow the
   repo's own rule: open a pull request where the repo asks for one, else commit to the default
   branch. Report the PR / commit.

## 6. Assistant and supervisor threads

A repo with role assistants keeps their threads in this same flat `threads/` — tagged
`assistant: [role]` (or `supervisor: [role]`), and named `YYYY-MM-DD-asst-[role]-topic.md`.
They are curated like any other thread, with three differences:

- **A settled assistant thread promotes into `assistants/[role]/memory.md`, not the root
  `memory.md`.** That role's durable layer is its own; a dev conclusion promoted to the
  project's top-level memory is then loaded into every session forever, which is exactly what
  the slice exists to avoid.
- **Keep the tag when archiving.** `git mv` preserves it; do not strip it in a tidy-up. The tag
  is what `thread-index.mjs` renders, and what tells a later reader whose thread it was.
- **`assistants/[role]/memory.md` needs curating too** — it grows exactly as the root one does,
  and nothing else ever reviews it. Treat it as another durable layer in this pass.

**Never rewrite `assistants/[role]/LESSONS.md`.** Its entries carry content-addressed ids, and a
supervisor in the cross-project layer records what it has distilled by citing them. Renumber,
reword or remove an entry and a lesson silently becomes new again — re-distilled as though it
were fresh evidence — or an already-unread one becomes permanently invisible. The file is
append-only; corrections are new entries that supersede old ones in their text. Archiving it is
not a curation option.

## 6. Boundaries

- **Never delete** a thread — archive it. **Never** rewrite an active thread's content.
- Where the project has a structured decision log (its `context.json` declares one), decisions
  belong there — `log-decision`, not `memory.md`; summarise only the load-bearing ones in
  `memory.md`.
- Stay faithful — condense and reorganise; don't invent conclusions a thread didn't actually reach.

**Not this skill:** writing up the current session is `save-thread`; re-reading the context is
`refresh-context`; recording a transferable lesson for a supervisor is `assistant-lesson`;
checking a repo's config and layout for silent drift is `context-doctor`.
