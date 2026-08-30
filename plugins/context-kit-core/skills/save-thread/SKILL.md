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

## 2. Which layer: the project's, or this repo's?

Two thread layers exist and they answer different questions.

- **The project's `threads/`**, in the context repo. Decisions about the product, the research
  or the direction. Audience: whoever thinks about the project.
- **The repo's own `.claude/threads/`**, in the working directory. How this codebase works, what
  was tried in it, why the build is shaped as it is. Audience: whoever next opens this repo.
  It travels with a clone of THAT repo, so it reaches someone who does not have the context repo
  at all.

**Check the routing before judging it — a repo can have decided already:**

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --threads
```

- **`context`** — the repo layer is **off**. Write to the project's `threads/`, whatever the
  subject. This repo is *shared as a tool* rather than worked on as a project, so a thread in
  `.claude/threads/` would ship one person's dated working notes to everyone who clones it.
  Nothing in a thread's content reveals that — it is a fact about the repo's distribution — which
  is exactly why it is configured rather than judged. Name the repo it came from in the
  front-matter (`repo: owner/name`), so the project's `threads/` stays readable once several
  tools write into it.
- **`repo`** — write to `.claude/threads/`, whatever the subject.
- **`auto`** — nothing configured; judge it as below.

It prints in one line without touching git or the network, and it still answers for a project
whose context repo is `none`. **`context` with a context repo of `none` is a contradiction** —
threads are routed somewhere that does not exist. Say so and stop. Do **not** fall back to
`.claude/threads/`: writing into the shared repo is the precise outcome the flag was set to
prevent, and doing it quietly is worse than not saving the thread.

### Judging it, when the routing is `auto`

**The audience decides, not the subject matter.** A note about the website that is really a
product decision belongs to the project; a product-shaped question about how to structure the
static export belongs to the repo.

Default to the **project** layer when the working directory is the context repo, or when the
work spans repos. Default to the **repo** layer when the session is in a code repo and the work
was about that code. Genuinely ambiguous, or spanning both: ask, and say which way you are
leaning and why.

The repo layer is plain markdown in `.claude/threads/`, same filename and front-matter
convention. Create the directory if it is absent; `.claude/` is already committed in these repos
alongside `.claude/skills/`, so a thread there is shared rather than local. **Check it is not
gitignored** before writing: a `/.claude/*` ignore rule would make the thread invisible to
everyone else, silently, which is the failure this layer exists to avoid.

## 3. New thread, or update an existing one?

List `$ROOT/threads/*.md`. If one clearly covers this topic, **append** a dated section —
`## YYYY-MM-DD — what changed` — without rewriting earlier content. Otherwise create
`threads/YYYY-MM-DD-short-topic.md` (kebab-case; `-2` if taken). Genuinely ambiguous → ask.

## 4. Write it (house style)

- **Write for a stranger** — zero assumed context, acronyms spelled out on first use.
- Structure: what happened / where we got to, then **Decisions** and **Follow-ups / open
  questions** if any. Tight — this is the working layer, not the durable one.
- New files start with the front-matter block the repo's `templates/thread.md` defines (if the
  repo has one — read it rather than inventing). Appends leave existing front-matter alone.
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
- The filename **must** end `.md` — the SessionStart hook only finds `*.md`.
- **No angle brackets in any front-matter value** — ingesters read `[token]`-style angle
  brackets as tags and silently drop the field. Use `[topic]` or `{topic}`.

## 5. Commit + push

Stage **only the thread file(s) you touched**:

```bash
git -C "$ROOT" add threads/FILE && git -C "$ROOT" commit -m "threads: topic" && git -C "$ROOT" push
```

Report the file path and the pushed commit.

## 6. Remind (don't do automatically)

If a conclusion has **settled**, suggest promoting it into `memory.md`. If the project has a
structured decision log (see its `context.json`), suggest recording the decision there too.

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

**Not this skill:** re-reading the context is `refresh-context`.