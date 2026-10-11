---
name: setup-doc-publish
description: Publish the document with doc-publish — a queryable corpus, a Notion wiki or a Quarto site — by installing it into the workspace and wiring it to the document. Use after setup-project-workspace when the user wants to publish, build the corpus, or sync to Notion.
---

# Set up doc-publish

**First, invoke `/project-workspace:setup-observer`** (once per session): it records where this guide and
reality disagree, so the maintainer can fix the guide.

Prerequisite: `/project-workspace:setup-project-workspace` has finished — `workspace.toml` exists at the
workspace root. Read it for `layout`, `analysis_dir`, `writing_dir`,
`analysis_distribution`, `extras` (no `layout` key means `full`).

**Writing-only layout** (`layout = "writing-only"`): there is no analysis repo. Everything
below that says `<analysis_dir>` means **the workspace root** instead — doc-publish is
installed into the root's venv, run from the root, and reads the root's `.env`. Step 1
differs; from step 2 on, just run each command from the root.

Then read doc-publish's own docs before acting on anything below that has
drifted: [README](https://github.com/c-energie/doc-publish) and
[docs/publishing.md](https://github.com/c-energie/doc-publish/blob/main/docs/publishing.md).

Where things live — this is the part that surprises everyone:
- doc-publish is a **command** installed into the workspace venv via the analysis repo's
  `publish` extra. There is no checkout of it here and nothing imports it.
- Run it **from `<analysis_dir>/`**: it reads that checkout's `.env` (nearest `.env` above
  the cwd), and writes `build/` and `dist/` there (both gitignored).
- Its **state lives in the document repo**, `<writing_dir>/.doc-publish/`, and must be
  committed there. Losing `notion_manifest.json` makes the next sync create a second copy
  of the whole wiki; losing `anchor_map.json` breaks every inbound link.

Ask before every commit, push, Notion sync and `publish`.

## 1. Install

**Writing-only:**

1. `uv run --no-project --python 3.12 "${CLAUDE_SKILL_DIR}/../setup-project-workspace/setup_workspace.py" --root "${CLAUDE_PROJECT_DIR}" publish-root`
   — writes a minimal root `pyproject.toml` (only a `publish` extra), a root `.env` with
   an absolute `DOC_REPO` pointing at `<writing_dir>`, and adds `"publish"` to `extras`.
   It keeps any existing `pyproject.toml` or `.env`.
2. `... setup_workspace.py sync`, then `uv run doc-publish --help` from the root.
3. Commit `pyproject.toml`, `uv.lock`, `workspace.toml` at the root (ask). Never `.env`.

**Full:**

1. Add to the root `pyproject.toml`, under `[project.optional-dependencies]`:
   ```toml
   publish = ["<analysis_distribution>[publish]"]
   ```
   and add `"publish"` to the `extras` list in `workspace.toml`.
2. `uv run --no-project --python 3.12 "${CLAUDE_SKILL_DIR}/../setup-project-workspace/setup_workspace.py" --root "${CLAUDE_PROJECT_DIR}" sync`
   (it passes every extra in `workspace.toml`; a bare `uv sync` would uninstall the others).
3. `cd <analysis_dir> && uv run doc-publish --help` to confirm.

## 2. Diagnose, then scaffold

From `<analysis_dir>/`:

```bash
uv run doc-publish doctor      # reads only; work down every FAIL line
uv run doc-publish env         # audits .env; names settings commands still need
uv run doc-publish config      # how every setting resolved, and from where
uv run doc-publish init        # writes .doc-publish/ + two skills into the DOCUMENT repo
```

`init` keeps existing files (the `AGENTS.md`/`CLAUDE.md` already in the writing repo stay).
If the root `.tex` is not one of `main/thesis/dissertation/report/book.tex`, `doctor` fails
until `DOC_MAIN_TEX=<file>.tex` is in `<analysis_dir>/.env`.

## 3. Build and finish the contract

```bash
uv run doc-publish build       # LaTeX -> corpus; exits non-zero on anything unresolved
uv run doc-publish check       # reports what in .doc-publish/ is unfinished
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
analysis `.env`.

```bash
uv run doc-publish site        # build the site from the PUBLIC corpus
uv run doc-publish serve       # view it locally
uv run doc-publish bundle      # zip for hand-carried distribution
```

### Notion wiki

1. https://www.notion.so/profile/integrations → **New integration** (internal) → copy the
   token.
2. In Notion, open the parent page → **⋯ → Connections** → add the integration.
3. Put `NOTION_TOKEN=<token>` and `DOC_NOTION_PARENT=<page id>` in `<analysis_dir>/.env`
   (gitignored — never commit a token; check `git status` in the analysis repo shows no `.env`).
4. `uv run doc-publish sync`. Run it **again**: the second run must report `0 writes`.
   If it does not, stop and investigate before anything else.
5. Commit `<writing_dir>/.doc-publish/notion_manifest.json` (ask).

### Publish repo (a site in its own git repo)

`DOC_PUBLISH_REPO=<path to a git repo>` in the analysis `.env`; `uv run doc-publish publish`
writes files there and **never commits** — review the diff. Read
`docs/publishing.md` before the first push of anything public: treat that push as the
point of no return (a pushed history cannot be fully scrubbed from GitHub).

### Chat server (optional, heavier)

Add to root `pyproject.toml`:
```toml
[project.optional-dependencies]
app = ["doc-publish[app]"]
agent = ["doc-publish[app, agent]"]   # Agent SDK backend

[tool.uv.sources]
doc-publish = { git = "https://github.com/c-energie/doc-publish.git" }
```
Add `"app"` (or `"agent"`) to `extras` in `workspace.toml` and re-run `sync`. Needs
`ANTHROPIC_API_KEY` in the analysis `.env`. The `agent` backend also needs Node 18+
(`winget install --id OpenJS.NodeJS.LTS -e` / `brew install node`) and the Claude Code CLI:
`npm install -g @anthropic-ai/claude-code`. Then `uv run doc-publish app` (or `agent`).

## Never

- Publish or serve anything outbound under `CORPUS_MODE=draft`. `corpus_draft.md` keeps
  LaTeX comments (TODOs, supervisor notes) and is for the author only.
- Commit `build/`, `dist/` or a built PDF.
- Put anything document-specific into doc-publish itself — it goes in `.doc-publish/`.
