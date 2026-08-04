---
name: save-thread
description: Write up the current work as a context "thread" in the project's context repo (threads/) — a new per-topic file or a dated update to an existing one — then commit and push. Use to capture what a session did or decided into the shared context. Triggers like "save this to the context threads", "write up what we did", "log this session to the context repo", "update the 'topic' thread".
disable-model-invocation: true
---

# Save a context thread

Captures the current work into the project's context repo
(the repo configured for this project) under `threads/` — the working layer —
following **that repo's own house rules**: read its `threads/README.md` (and `templates/` /
`taxonomy.yml` if present) before writing; the repo's conventions win over the defaults below.
One topic per file, filename dated `YYYY-MM-DD-short-topic.md`, keep the same file as a topic
develops, promote settled conclusions up into `memory.md`.

> **Commits and pushes to a shared repo — run only when asked.** Excluded from automatic
> invocation (`disable-model-invocation: true`).

## 1. Find the context checkout

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --writable)"
```

Uses the current repo if its `origin` matches, otherwise the managed clone (cloning if
missing), un-shallows so the push can succeed, and pulls. Exits non-zero with a reason if the
repo can't be reached — say so and stop rather than writing somewhere else. Today's date:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" today`.

**No shell?** (Cowork.) Write through the **GitHub connector** instead — same repo, same house
rules, same file. Two differences: the write **is** the commit and is public the moment it
succeeds (ask before the write, not before a push), and appending means read the file, append,
write the whole thing back — never rebuild it from memory. No connector either? Say so and
keep the draft in the reply rather than inventing a destination.

## 2. New thread, or update an existing one?

List `$ROOT/threads/*.md`. If one clearly covers this topic, **append** a dated section —
`## YYYY-MM-DD — what changed` — without rewriting earlier content. Otherwise create
`threads/YYYY-MM-DD-short-topic.md` (kebab-case; `-2` if taken). Genuinely ambiguous → ask.

## 3. Write it (house style)

- **Write for a stranger** — zero assumed context, acronyms spelled out on first use.
- Structure: what happened / where we got to, then **Decisions** and **Follow-ups / open
  questions** if any. Tight — this is the working layer, not the durable one.
- New files start with the front-matter block the repo's `templates/thread.md` defines (if the
  repo has one — read it rather than inventing). Appends leave existing front-matter alone.
- The filename **must** end `.md` — the SessionStart hook only finds `*.md`.
- **No angle brackets in any front-matter value** — ingesters read `[token]`-style angle
  brackets as tags and silently drop the field. Use `[topic]` or `{topic}`.

## 4. Commit + push

Stage **only the thread file(s) you touched**:

```bash
git -C "$ROOT" add threads/FILE && git -C "$ROOT" commit -m "threads: topic" && git -C "$ROOT" push
```

Report the file path and the pushed commit.

## 5. Remind (don't do automatically)

If a conclusion has **settled**, suggest promoting it into `memory.md`. If the project has a
structured decision log (see its `context.json`), suggest recording the decision there too.

**Not this skill:** re-reading the context is `refresh-context`.