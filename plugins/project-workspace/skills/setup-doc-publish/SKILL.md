---
name: setup-doc-publish
description: Publish one document with doc-publish — a queryable corpus, a Notion wiki or a Quarto site — by installing it for that document and wiring it up. Use when the user wants to publish a document, build its corpus, or sync it to Notion.
---

# Set up doc-publish

**First, invoke `/project-workspace:setup-observer`** (once per session): it records where this guide and
reality disagree, so the maintainer can fix the guide.

doc-publish is set up **per document**. Find the document:
`uv run --no-project --python 3.12 "${CLAUDE_SKILL_DIR}/../setup-project-workspace/setup_workspace.py" --root "${CLAUDE_PROJECT_DIR}" document`
prints it as JSON — the one this session is inside, else the only one; with several it lists
them: ask, then pass `--document <name>`. Below, `<writing_dir>` is its `path`,
`<analysis_dir>` its `analysis_path` (a nested analysis) and `workspace_analyses` the
workspace analyses feeding it, each with its `path` and the `documents` it feeds.

Then read doc-publish's own docs before acting on anything below that has
drifted: [README](https://github.com/c-energie/doc-publish) and
[docs/publishing.md](https://github.com/c-energie/doc-publish/blob/main/docs/publishing.md).

Where things live — this is the part that surprises everyone. There is no checkout of
doc-publish and nothing imports it; it is a **command**, run from a **home directory** that
holds its per-machine `.env` and gets its `build/` and `dist/` (all gitignored):

| The document has | Home | `DP` below is | doc-publish finds the document by |
|---|---|---|---|
| a nested analysis (`<analysis_dir>` set) | `<analysis_dir>/` | `uv run doc-publish` — installed into that venv by the analysis repo's `publish` extra | walking up: the analysis sits inside the document |
| no nested analysis, but a workspace analysis feeding it, if the user wants to run from there | that analysis's `path` | `uv run doc-publish`, as above | `.claude/workspace.json`, when that analysis feeds **one** document. Feeding several, it cannot choose: **every** `DP` command below takes `--document <writing_dir>` |
| neither | `<writing_dir>/` | `uvx --from git+https://github.com/c-energie/doc-publish.git doc-publish` — no venv at all | walking up: run from inside the document |

**No `DOC_REPO` in any of these.** doc-publish resolves the document as `--document`, then
`DOC_REPO`, then the nearest directory at or above the home holding the root `.tex`, then
`.claude/workspace.json` — the same structure `doc_analysis` reads. A `DOC_REPO` there only
repeats it, and goes stale: if it ever names a different document than the structure does,
doc-publish and `doc_analysis` both stop on it. The several-documents case is `--document`,
never `DOC_REPO`, because a `.env` set to one document is silently wrong for the next.

**`DOC_REPO=<absolute writing_dir>` is for a home no structure describes**: an analysis
checkout beside the document that the workspace does not record (the sibling layout), or a
document elsewhere on disk. Write it there, and only there.

A workspace analysis's home is one `.env`, `build/` and `dist/` for every document it feeds;
building one replaces the last one's `build/`.

Its **state lives in the document repo**, `<writing_dir>/.doc-publish/`, and must be
committed there. Losing `notion_manifest.json` makes the next sync create a second copy of
the whole wiki; losing `anchor_map.json` breaks every inbound link.

Ask before every commit, push, Notion sync and `publish`.

## 1. Install

**With an analysis repo:**
`uv run --no-project --python 3.12 "${CLAUDE_SKILL_DIR}/../setup-project-workspace/setup_workspace.py" --root "${CLAUDE_PROJECT_DIR}" sync --document <name> --extra publish`
— records `publish` among the document's extras in `.claude/workspace.json` and syncs with all of
them (a bare `uv sync` would uninstall the others). Then
`cd <analysis_dir> && uv run doc-publish --help`.

**From a workspace analysis:**
`... setup_workspace.py ... sync --analysis <its dir> --extra publish`, the same way; then
`uv run doc-publish --help` from its `path`.

**Without either:** in `<writing_dir>/`, make sure `.gitignore` has `/.env`, `/build/` and
`/dist/` — writing-template's has only `/.env`, and an older or adopted document repo may have
none; add the missing lines and commit, asking. They are not optional: run from inside the
document, `build/` holds `corpus_draft.md` (every LaTeX comment) one `git add .` from
Overleaf, and `DP build` refuses until git ignores it. Then `DP --help` from there; the first
run fetches doc-publish into uv's cache.

**Then, every time — including a re-run of this skill**, from the home:

1. `DP config`. Its `document:` line must name `<writing_dir>` and say how — `found at or
   above ...` (walking up), `workspace analysis ... feeds`, or `--document`. That line is the
   proof; do not reason it out from the table instead.
2. If it says `unresolved` and the home is one no structure describes (above), write
   `DOC_REPO=<absolute path of writing_dir>` into the home's `.env` (gitignored; keep every
   other line) and run `DP config` again. If the home *is* in the table, a missing `DOC_REPO`
   is not the fault: fix what `DP config` names (a root `.tex` it cannot see is
   `DOC_MAIN_TEX`, §2; an analysis feeding nothing yet is `attach-analysis`).
3. If the home's `.env` already holds `DOC_REPO` (or `THESIS_REPO`, its old name), check it
   with both `DP config` runs below **without** `--document`, which would hide it:
   - `DP config` reads `unresolved - DOC_REPO=... is not the document ...` (every other
     command fails on it), or the `DOC_REPO` names another directory than `<writing_dir>`:
     **a conflict**. Report both paths and ask which
     is right; change nothing until the user answers. A wrong `DOC_REPO` is a line to remove
     (on yes); a wrong structure is the wrong home, or a workspace analysis attached to the
     wrong documents.
   - Otherwise run `DOC_REPO=' ' THESIS_REPO=' ' DP config` — blank values, which the `.env`
     cannot override, so this shows what the structure finds alone. If it names
     `<writing_dir>` too (or, feeding several, lists it and you are using `--document`), the
     line is redundant: harmless, but **offer** to remove it, and remove that one line only on
     yes. If it says `unresolved`, the line is needed: keep it.
   - In a nested analysis with no `doc_analysis/layout.py` (nor `src/doc_analysis/layout.py`:
     older than analysis-template #12) the line is `doc_analysis`'s, written by
     `/project-workspace:add-analysis`: leave it.

## 2. Diagnose, then scaffold

From the home directory:

```bash
DP doctor      # reads only; work down every FAIL line
DP env         # audits .env; names settings commands still need
DP config      # how every setting resolved, and from where
DP init        # writes .doc-publish/ + two skills into the DOCUMENT repo
```

`init` keeps existing files (the `AGENTS.md`/`CLAUDE.md` already in the document repo stay).
If the root `.tex` is not one of `main/thesis/dissertation/report/book.tex`, `doctor` fails
until `DOC_MAIN_TEX=<file>.tex` is in the home's `.env` — and walking up cannot find the
document without it either.

## 3. Build and finish the contract

```bash
DP build       # LaTeX -> corpus; exits non-zero on anything unresolved
DP check       # reports what in .doc-publish/ is unfinished
```

- **`build` failures are the real audit.** Every `[UNRESOLVED: ...]` is a macro, figure or
  citation it could not resolve. Zero-argument macros expand automatically; macros with
  arguments need `.doc-publish/macros.py`.
- **`check` fails on `prompt.md` until it is written — on purpose.** That file tells any
  agent what the document does and does not establish.

`init` wrote two skills for exactly these files into `<writing_dir>/.claude/skills/`:
`write-agent-prompt` and `write-macro-adapter`. Skills load only for a session started in
that directory — either tell the user to open Claude Code in `<writing_dir>/` and run them
there, or read their `SKILL.md` and follow it from here. Re-run `build` and `check` until
both pass, then commit `<writing_dir>/.doc-publish/` (ask).

## 4. Outputs — ask which they want

### Quarto site (offline, hand-carried or hosted)

Quarto is a system dependency; no Python extra provides it.

| Windows | macOS | Linux |
|---|---|---|
| `winget install --id Posit.Quarto -e` | `brew install --cask quarto` | download the `.deb` from https://quarto.org/docs/get-started/ then `sudo dpkg -i quarto-*.deb` |

New terminal, then `quarto --version`. If it is not on PATH, set `QUARTO=<path>` in the
home's `.env`.

```bash
DP site        # build the site from the PUBLIC corpus
DP serve       # view it locally
DP bundle      # zip for hand-carried distribution
```

### Notion wiki

1. https://www.notion.so/profile/integrations → **New integration** (internal) → copy the
   token.
2. In Notion, open the parent page → **⋯ → Connections** → add the integration.
3. Put `NOTION_TOKEN=<token>` and `DOC_NOTION_PARENT=<page id>` in the home's `.env`
   (gitignored — never commit a token; check `git status` there shows no `.env`).
4. `DP sync`. Run it **again**: the second run must report `0 writes`.
   If it does not, stop and investigate before anything else.
5. Commit `<writing_dir>/.doc-publish/notion_manifest.json` (ask).

### Publish repo (a site in its own git repo)

`DOC_PUBLISH_REPO=<path to a git repo>` in the home's `.env`; `DP publish`
writes files there and **never commits** — review the diff. Read
`docs/publishing.md` before the first push of anything public: treat that push as the
point of no return (a pushed history cannot be fully scrubbed from GitHub).

### Chat server (optional, heavier)

Needs `ANTHROPIC_API_KEY` in the home's `.env`. With an analysis repo, add to its
`pyproject.toml` (a change to commit there, asking):
```toml
[project.optional-dependencies]
app = ["doc-publish[app] @ git+https://github.com/c-energie/doc-publish.git"]
agent = ["doc-publish[app,agent] @ git+https://github.com/c-energie/doc-publish.git"]   # Agent SDK backend
```
then `... setup_workspace.py ... sync --document <name> --extra app` (or `agent`). Without
one, run it as `uvx --from "doc-publish[app] @ git+https://github.com/c-energie/doc-publish.git" doc-publish app`.
The `agent` backend also needs Node 18+ (`winget install --id OpenJS.NodeJS.LTS -e` /
`brew install node`) and the Claude Code CLI: `npm install -g @anthropic-ai/claude-code`.
Then `DP app` (or `agent`).

## Never

- Publish or serve anything outbound under `CORPUS_MODE=draft`. `corpus_draft.md` keeps
  LaTeX comments (TODOs, supervisor notes) and is for the author only.
- Commit `build/`, `dist/` or a built PDF.
- Put anything document-specific into doc-publish itself — it goes in `.doc-publish/`.
