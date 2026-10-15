---
name: save-diagram
description: Capture a diagram from this session into the project's per-org diagram store — write the SVG or HTML source, append the index line with tags and the words drawn inside it, and commit. Triggers like "save that diagram", "keep this diagram", "add this to the diagram store", "capture that architecture picture".
disable-model-invocation: true
---

# Save a diagram to the store

> **Writes to a shared repo — excluded from automatic invocation**
> (`disable-model-invocation: true`). It runs when the user names it. A diagram committed to an
> org's store is visible to everyone with read on that store, and rewriting history to remove
> one is not something to do casually.

Takes a diagram Claude drew in this session — an SVG or a self-contained HTML page — and puts it
somewhere it will still be findable in a year: the project's **per-org store repo**, as committed
source, with an index line carrying its tags and the words drawn inside it.

Read `diagrams-config` first. The whole contract is there — where the store is, why there is no
default, what a record holds, and what the taxonomy's absent/empty/present states mean.

## 1. Resolve the store

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram-store.mjs" where
```

If this fails saying no diagram store is named, **stop and say so.** That is the designed
outcome, not an obstacle to work around: relay the three places it lists, offer the one-line
edit, and never pick another store. If it refuses a cross-org store, stop too — `crossOrg` is
the user's decision to record, not yours. Writing a net-flex diagram into the c-energie store is the
failure this plugin is shaped to prevent.

If it resolves but the checkout is missing, print the `git clone` line and stop. The script never
clones — an empty directory it created would read as an empty store rather than a missing one.

## 2. Get the source onto disk

The store holds **SVG and HTML source, committed as text**. Not PNG:

- A PNG does not diff, does not grep, and cannot be restyled. It is a raster of a decision, not
  the decision.
- Rasters are welcome *beside* the source, as build output. The gallery lazy-loads a `.png` sitting
  next to a source file and never inlines one.

If the diagram exists only as an artifact in the conversation, write it to a file first. If it
only exists as a rendered image, say that the source is what the store wants and ask whether to
redraw it as SVG — do not save a screenshot and call it captured.

## 3. Decide the metadata with the user, not for them

Four fields carry all the later value, and three of them are cheap to get wrong:

- **`--title`** — what someone would search for. Defaults to the filename, which is almost never
  what they would search for.
- **`--type`** and **`--tags`** — from the store's vocabulary. Check it rather than guessing:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/diagram-store.mjs" taxonomy
  ```
  If there is no `taxonomy.json`, the vocabulary has not been agreed: the save will proceed and
  say so. Pass that on rather than swallowing it, and mention `tags-in-use` — the question "what
  should the tag list be" is answerable with data, and that is the command that produces it.
- **`--source`** — where this came from: the session, a thread file, a meeting. **Ask for it.**
  It is the one field nobody can reconstruct later, and the row that lacks it is the row nobody
  can explain in six months.

`--status` defaults to `current`; use `draft` for something still moving, and set `superseded` on
the old one when a diagram replaces it.

## 4. Dry-run, then write

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/save-diagram.mjs" [file] \
  --title "Settlement flow" --type architecture --tags data-flow,billing \
  --source "sizing call, 2026-08-31" --dry-run
```

`--dry-run` prints the exact path and the exact index line and touches nothing. **Show that to
the user before the real run** — the index is append-only, so a bad line is corrected by another
commit rather than an edit.

Drop `--dry-run` to write. The script writes the source under `diagrams/[year]/`, appends one
line to `index.jsonl`, and commits **locally**.

If it refuses a tag, it is because the store's vocabulary is closed and the tag is not in it. It
names the near misses. Do not reach for `--force-tags` to get past it — either use an existing
value, or add the new one to `taxonomy.json` in a commit of its own so the vocabulary changing is
visible in the log. `--force-tags` exists for the case where the user has decided, and it labels
the row as forced.

## 5. Ask before pushing

**The script never pushes.** Show the commit, then ask:

```bash
git -C [store checkout] log --oneline -1
git -C [store checkout] push          # only after an explicit yes
```

Same gate as `save-thread`: a push into a shared repo is visible immediately and awkward to walk
back. Offering to leave it committed locally is a fine answer.

## In Cowork, where there is no git

The GitHub API over MCP, through the connection the project declares for the store's owner. Read
`context-kit-core`'s `context-access` first — it is the canonical description of that route. The
two rules that bite hardest here:

- **A write is an immediate commit to the default branch.** There is no local commit to show
  first, so ask *before* the write, and say that it lands publicly the moment it succeeds.
- **Appending means read the whole `index.jsonl`, append your line, write the whole thing back**,
  passing the blob `sha` from the read. Reconstructing it from memory truncates every row you did
  not remember, and on this path there is no diff to catch it.

If the connector cannot reach the store, say so plainly. There is no queue for diagrams — the
source file is in the session and can be saved from a session that has a shell.

**Not this skill:** looking at what is already in the store is `browse-diagrams`. Writing up what
a session *decided* is `context-kit-core`'s `save-thread`, into a different repo entirely — a
diagram and the thread that produced it are two artifacts, and `--source` is the link between them.
