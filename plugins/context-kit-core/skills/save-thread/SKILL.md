---
name: save-thread
description: Write up the current work as a context "thread" in the workspace's docs/threads/ — a new per-topic file or a dated update to an existing one — then commit and push. Use to capture what a session did or decided into the shared context. Triggers like "save this to the context threads", "write up what we did", "log this session to the workspace", "update the 'topic' thread".
disable-model-invocation: true
---

# Save a context thread

Captures the current work as a thread, the working layer, in the **workspace** the session is
in, under `docs/threads/` (ADR 0002). There is no other destination: the context-repo and
`.claude/threads/` routes were retired with context repos (#60).

Follow **the destination's own house rules**: read `docs/threads/README.md` (and `templates/` /
`taxonomy.yml` if present) before writing; its conventions win over the defaults below. One
topic per file, filename dated `YYYY-MM-DD-short-topic.md`, keep the same file as a topic
develops, promote settled conclusions up into the durable layer, `docs/memory.md`.

> **Commits and pushes to a shared repo — run only when asked.** Excluded from automatic
> invocation (`disable-model-invocation: true`).

## 1. Find the workspace

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/thread-target.mjs"
```

One JSON line, no network, nothing written. It finds the workspace with the same walk
`workspace.mjs` uses, so a thread can never be routed to a different home from the context the
session loaded.

**Anything but `"route": "workspace"` means there is no workspace**: no `.claude/workspace.json`
above the working directory, or the nearest one is malformed (stderr names it). Say so and
**stop**; never write somewhere else instead. A folder becomes a workspace through
`project-workspace:setup-project-workspace`. Offer to keep the draft in the reply.

With `"route": "workspace"`:

- `ROOT` is `root`; `DIR` is `docs/threads`. **That is the whole routing answer.** A session in
  a **member** repo writes into the workspace root's `docs/threads/`, **never** the member's
  `.claude/threads/`: the workspace is the one home for context, and a member's thread layer is
  the second home ADR 0002 retires.
- `repo` (when not null) is the member repo the session is in. New threads carry it as
  `repo: owner/name` in their front-matter, so `docs/threads/` stays readable once several members
  write into it. Null means the thread comes from the workspace's own repo; leave the key out.
  If stderr says a nested clone has no GitHub origin, ask which repo to record rather than
  dropping it silently.
- Bring the checkout up to date before writing; the resolver does no network of its own:

  ```bash
  git -C "$ROOT" pull --ff-only
  ```

  If it fails (offline, diverged, a conflicting local edit), say why and ask whether to write
  and commit locally anyway; never pull with a merge or rebase on the user's behalf.
- Check `docs/threads/` is not gitignored in the workspace repo (`git -C "$ROOT" check-ignore -q
  docs/threads/x.md` succeeding means it is): an ignored thread is invisible to everyone else,
  silently.

Today's date: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" today`.

**No shell?** (Cowork.) Write through the **GitHub connector** instead: same house rules, same
file, in the uploaded `workspace.json`'s `repo`, under `docs/threads/` (the only thread path
Cowork may write there; see `context-access`). Two differences: the write **is** the commit and
is public the moment it succeeds (ask before the write, not before a push), and appending means
read the file, append, write the whole thing back; never rebuild it from memory. No connector
either? Say so and keep the draft in the reply rather than inventing a destination.

## 2. New thread, or update an existing one?

List `$ROOT/docs/threads/*.md`. If one clearly covers this topic, **append** a dated section —
`## YYYY-MM-DD — what changed` — without rewriting earlier content. Otherwise create
`docs/threads/YYYY-MM-DD-short-topic.md` (kebab-case; `-2` if taken). Genuinely ambiguous → ask.

## 3. Write it (house style)

- **Write for a stranger** — zero assumed context, acronyms spelled out on first use.
- Structure: what happened / where we got to, then **Decisions** and **Follow-ups / open
  questions** if any. Tight — this is the working layer, not the durable one.
- New files start with the front-matter block the repo's `templates/thread.md` defines (if the
  repo has one — read it rather than inventing). Appends leave existing front-matter alone.
- **`repo: owner/name`** whenever `thread-target.mjs` returned a `repo` (section 1).
- **`audience:` — say who this was written for.** `working` (session sediment; nobody needs to
  read it cold), `team` (a document a colleague should read), or `external` (fit to leave the
  organisation). It is the one thing about a thread a later reader cannot infer: every thread is
  written to the same house style whether or not anyone but its author will ever want it, so
  without the field the pile is undifferentiated and the readable documents in it stay buried.
  `thread-index.mjs` surfaces it as a column. **Set it from the work, not from the polish** —
  a rough note that a colleague needs is `team`; a beautifully written trace of a debugging
  session is `working`. Genuinely unsure, or appending to a thread that has no `audience:`
  yet → leave it out. Absent means unclassified, and is treated as such everywhere; guessing
  `working` to fill the field in is the one way to make the classification worse than no
  classification.
- The filename **must** end `.md` — `thread-index.mjs` only finds `*.md`.
- **No angle brackets in any front-matter value** — ingesters read `[token]`-style angle
  brackets as tags and silently drop the field. Use `[topic]` or `{topic}`.

## 4. Regenerate the index, commit, then ask before pushing

`docs/threads/INDEX.md` is **committed**, so the workspace's `CLAUDE.md` can point at it rather
than every session listing the directory. Rebuild it from disk after every write, supplying the
status and gist only for the thread you touched; every other line's answers are carried
forward from the existing index by `thread-index.mjs`:

```bash
# g.json, in a temp dir, never in the repo: {"YYYY-MM-DD-topic.md": {"status": "active", "gist": "one line"}}
node "${CLAUDE_PLUGIN_ROOT}/scripts/thread-index.mjs" "$ROOT" --dir docs/threads --gists g.json --write
```

Read its stderr: a line it could not parse means a hand-written gist was not carried — look
before committing. Confirm `INDEX.md` lists the new thread. Then stage **only** the thread
file(s) you touched and the index, and commit:

```bash
git -C "$ROOT" add docs/threads/FILE docs/threads/INDEX.md && git -C "$ROOT" commit -m "threads: topic"
```

Show the user the commit (`git -C "$ROOT" show --stat HEAD`) and **ask before pushing**: the
workspace repo is everyone's context, and every member's people read it. Push only on an
explicit yes:

```bash
git -C "$ROOT" push
```

Anything short of yes leaves the commit local; say so, with the path. Report the file path and
the commit, and whether it was pushed.

If the workspace's `CLAUDE.md` does not mention `docs/threads/INDEX.md`, offer the line that
points at it; don't write it: `CLAUDE.md` is curated, not this skill's file.

## 5. Remind (don't do automatically)

If a conclusion has **settled**, suggest promoting it into `docs/memory.md` (`memory-triage`
and `curate-context` own that). If the project has a structured decision log (`state.notion` in
its `workspace.json`), suggest recording the decision there too.

**Then record the answer, whichever way it goes.** A thread whose decisions were logged and a
thread whose decisions were forgotten look identical from the outside, so the reminder above was
for years exactly as reliable as the person reading it. Close the loop in the front-matter:

- `notion_ids: ["url", ...]` (or `issue_ids:` for a tracker) — where the outcome landed.
- `notion_ids: []` — asked and answered: there was nothing here worth logging.
- **the key absent** — nobody has considered it yet.

That absent-versus-empty distinction is the whole mechanism: `context-status` counts threads
carrying a Decisions / Actions / Open questions / Next step section with **no** link key, and
reports them under `THREAD OUTCOMES NEVER LOGGED`. Writing `notion_ids: []` is therefore a real
answer that drains the queue, not a way of dodging it — and the queue can only reach zero
because that answer exists. Offer the line; don't write outcomes to Notion unasked (that is
`add-action` / `log-decision`, and both are their own skills for a reason).

**Not this skill:** re-reading the context is `refresh-context`; condensing old threads is
`curate-context`; making a folder a workspace is `project-workspace:setup-project-workspace`.
