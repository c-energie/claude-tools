# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this project
workspace.

## What this directory is

The `<<WORKSPACE>>` project workspace: a folder of **documents**, each authored in its own
repos. `.claude/workspace.json` lists them as `members`; the table below is rewritten from it
whenever a document is added. Made by the `project-workspace@c-energie` plugin.

<!-- documents (managed by /project-workspace:add-document) -->
<!-- /documents -->

Each document is a **document repo** (LaTeX, compiled on Overleaf through GitHub sync) and,
optionally, an **analysis repo nested inside it**: the notebooks and `doc_analysis` tooling
that write that document's figures and tables. The document repo's `layout.toml` names the
nested directory; the analysis repo finds its document from it, so there is no `DOC_REPO`
to set.

A **workspace analysis** is the other kind of analysis repo: a member of the workspace in
its own right, in no document repo, with its own `.venv`, feeding the documents its member
lists in `documents` — none yet, or several. The managed block above lists them under
"Analyses". A document can have its nested analysis and be fed by workspace analyses too.

**Every document and every analysis repo is a repo in its own right.** Commit inside the
repo the change belongs to, never from here. A document repo gitignores its analysis repo,
so `git status` in the document repo never shows analysis changes. Each has its own
`CLAUDE.md`/`AGENTS.md`: read it before editing there.

This folder may itself be a git repo (`/project-workspace:setup-project-workspace` offers it).
If it is, it tracks root files (this one, `.gitignore`) and its own folders (`.claude/`,
`docs/`, `.context/`, `teaching/`) only: its `.gitignore` is an allowlist that ignores every
other top-level directory, every member among them.

There is no Python here. Each analysis repo has its own `.venv`, built by `uv sync` inside
it; a notebook's kernel is that venv's interpreter.

## The pipeline, per document

```
<doc>/<doc>-analysis/notebooks ──save_fig──┬─> <doc>/Sections/<Name>/Figures/<stem>.png + \begin{figure} block ─> Overleaf ─> PDF
                                           └─> figures_html/ + figures_manifest.json ─> doc-publish ─> wiki / site
```

## Commands

From a document's analysis repo (`<doc>/<analysis dir>/`):

```bash
uv sync --extra dev --extra notebooks --extra plotly   # pass EVERY extra you use; uv removes the rest
uv run python -m pytest tests -q        # not `uv run pytest`: Windows trampoline error
uv run jupyter lab
uv run check-figure-parity              # after regenerating figures; non-zero on drift
uv run check-figure-parity --snapshot   # record a new baseline
```

The plugin's `sync` step passes the extras `.claude/workspace.json` records for each analysis
repo, so nothing gets uninstalled by mistake; with no flag, it syncs every one of them.

The LaTeX is compiled on Overleaf. `make` in a document repo is optional and local only.
Never commit a built PDF.

## Overleaf routine (GitHub sync)

Figures arrive from the analysis repo, a third place, so order matters:

1. In Overleaf: **left-hand panel → Integrations → GitHub → Push Overleaf changes to GitHub**.
2. `git pull` in the document repo — **before** regenerating any figure.
3. Run notebooks; commit `Sections/` in the document repo; push.
4. In Overleaf: **Pull GitHub changes into Overleaf**.

## Rules that break things silently

- **Never rename or move a committed figure.** LaTeX resolves bare filenames via
  `\graphicspath`; doc-publish indexes by name. A rename breaks both with no error.
- **Figure filenames are unique document-wide**, and labels mirror them
  (`foo.png` ↔ `\label{Fig: foo}`) — that is how re-running a notebook knows not to append
  a second block.
- **`\graphicspath` does not recurse.** One entry per figure directory.
- **Never commit an analysis repo from its document repo** (`git add -f`): that records an
  embedded repo, not its files.
- **Don't delete a document's `.doc-publish/*.json`.** They map it to live Notion pages and
  stable site URLs.

## Skills here

From the `project-workspace@c-energie` plugin. Each acts on one document: the one this
session is inside, else the only one, else the one you name.

| Skill | Use |
|---|---|
| `/project-workspace:setup-project-workspace` | Make a folder a project workspace, optionally a git repo; migrate an old single-document workspace. |
| `/project-workspace:add-document` | Add a document: a new one from writing-template, an Overleaf project, or an import. |
| `/project-workspace:add-analysis` | Nest an analysis repo in a document, or make a workspace analysis and attach documents to it; restore either on a fresh clone. |
| `/project-workspace:adapt-existing-document` | Bring an existing document into the `Sections/` / `\graphicspath` / label conventions, one section at a time. |
| `/project-workspace:adapt-existing-analysis` | Copy an existing analysis project's notebooks into a document's analysis repo and retrofit them. |
| `/project-workspace:setup-doc-publish` | Optional, per document: corpus, Notion wiki, Quarto site. |
| `/project-workspace:setup-observer` | Invoked by the setup skills: logs deviations from the guide and, with consent, files them on GitHub. |

To drop a document from this workspace, delete its entry in `members` in
`.claude/workspace.json` — and its nested analysis repo's, if it has one — (and its directory,
once everything in it is pushed). Leave the file's other keys alone: they belong to other
plugins.
