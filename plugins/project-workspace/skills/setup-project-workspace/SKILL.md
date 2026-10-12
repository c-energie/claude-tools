---
name: setup-project-workspace
description: Make a folder a project workspace — workspace.toml and CLAUDE.md, optionally its own git repo — then hand off to add-document; or migrate an old single-document workspace (a workspace.toml with no schema key). Use when the user asks to set up a project workspace, start a thesis or paper workspace, track the workspace in git, or migrate a workspace made from project-workspace-template.
---

# Set up a project workspace

**First, invoke `/project-workspace:setup-observer`** (once per session): it records where this
guide and reality disagree, so the maintainer can fix the guide.

A **project workspace** is a folder listing its **documents** in `workspace.toml`. Each
document is a document repo with, optionally, an analysis repo nested inside it:

```
<workspace>/
|-- workspace.toml        schema = 2; one [[document]] per document
|-- CLAUDE.md             generic rules + a managed table of the documents
|-- thesis/               a document repo            (add-document)
|   `-- thesis-analysis/  its nested analysis repo   (add-analysis)
`-- paper/                another document, writing only
```

This skill makes the folder; documents and analysis repos are added by their own skills,
now or any time later. There is no Python at the workspace root.

All mechanical work is done by `setup_workspace.py` beside this file, through uv:

```bash
uv run --no-project --python 3.12 "${CLAUDE_SKILL_DIR}/setup_workspace.py" --root "${CLAUDE_PROJECT_DIR}" <step> [flags]
```

Abbreviated `SETUP <step>`. Every step takes `--dry-run` (before `<step>`). Stop on the first
failed step, diagnose, fix, re-run it: every step is safe to re-run. Never commit or push
without asking.

## 0. Which branch

Read `workspace.toml` at the root, if any:

- **Missing** → a new workspace: §1 onwards.
- **Has `[workspace]` and no `schema`** → made from `project-workspace-template`, one document
  with its repos side by side: [Migrating](#migrating) instead.
- **`schema = 2`** → already set up. Say what it lists (`SETUP document --all`), offer
  `track` if `.git` is missing, and otherwise route: a new document → add-document, analysis
  for one → add-analysis.

## 1. Prerequisites

```bash
SETUP check
```

If `uv` itself is missing the command cannot run — give the install command first:

| Tool | Windows | macOS | Linux |
|---|---|---|---|
| uv | `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 \| iex"` or `winget install --id astral-sh.uv -e` or `pip install uv` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` or `brew install uv` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| git | `winget install --id Git.Git -e` | `xcode-select --install` | `sudo apt install git` |
| gh (GitHub CLI) | `winget install --id GitHub.cli -e` | `brew install gh` | `sudo apt install gh` |
| Python ≥ 3.11.4 | `uv python install 3.12` (uv manages it; no system Python needed) | same | same |

Then `gh auth login` (HTTPS; let it configure git). After any install the user must open a
**new terminal** (and restart Claude Code) so PATH picks it up. Work down every `FAIL` line
until `check` exits 0. `--` lines (latexmk, make) are optional: Overleaf compiles without a
local TeX install. `[--] latexmk (found but does not run; it needs Perl)` means a TeX
install is there but its latexmk cannot start — install Perl only for local builds.

## 2. Interview

1. **Workspace name** — default this folder's name.
2. **Track the workspace in git?** Default **no**. A yes makes the folder a repo tracking
   only `workspace.toml`, `CLAUDE.md` and `.gitignore`, ignoring every document — what it
   buys is restoring the set of documents on a second machine. If yes: **a GitHub repo for
   it?** owner (default the `gh` login), name (default the workspace name), visibility
   (default private). Confirm before creating it: it is outward-facing.

## 3. Make it

```bash
SETUP init --name <name>
SETUP track [--repo <owner>/<name> --visibility private]     # only on a yes
```

`init` writes `workspace.toml` (schema 2, no documents yet) and `CLAUDE.md` from
`CLAUDE.workspace.md` beside this file. A `CLAUDE.md` already there is kept; only its
documents table, between the `<!-- documents ... -->` markers, is ever rewritten.
`track` runs `git init` and writes `.gitignore` with a managed documents block; with
`--repo` it creates the GitHub repo as `origin` (and pushes if there are commits).

## 4. Hand off

Ask: **add a document now?** On a yes, invoke **`/project-workspace:add-document`**; it
offers add-analysis at its end. On a no, say both skills can be run any time from this
folder.

If tracked, propose the first commit at the root — `workspace.toml`, `CLAUDE.md`,
`.gitignore` — and ask before committing and before pushing.

## Migrating

A schema-1 workspace has one document: `<doc>-writing/` and, in the `full` layout,
`<doc>-analysis/` beside it, a root `pyproject.toml` making the analysis repo a uv member,
and one root `.venv`. Migrating nests the analysis repo inside the document repo
(`writing-hosts-analysis`), gives it its own venv, and leaves no Python at the root. It never
renames a repo or a document directory: Overleaf's sync and IDE configs point at them.

1. `SETUP check --analysis`, then show the plan: `SETUP --dry-run migrate`. Walk the user
   through every line. Stops it reports (a target taken, an analysis repo with no `origin`)
   are fixed first.
2. Ask them to **close Jupyter, IDEs and terminals inside the analysis repo and the root
   `.venv`**: Windows will not move or delete an open directory.
3. On an explicit yes: `SETUP migrate`. It moves the analysis checkout in (its `.env` travels
   unchanged: the document repo has not moved, so a `DOC_REPO` there is still right), runs the document's
   `setup-nested.sh --dir <analysis>` (adds `setup-nested.sh` first if the document repo
   lacks it), syncs the new venv with the old `extras`, and backs up `pyproject.toml`,
   `uv.lock`, `.python-version`, `workspace.toml` and `CLAUDE.md` to
   `.setup/migrate-backup/` before replacing or removing them.
4. Merge anything of the user's from `.setup/migrate-backup/CLAUDE.md` into the new
   `CLAUDE.md`, with them. Then delete the backups.
5. Re-point anything at the old venv: the IDE interpreter and notebook kernel are now
   `<doc>-writing/<doc>-analysis/.venv`. Prove it as add-analysis §4 does.
6. Commits, asking before each: in the document repo, `layout.toml`, `.gitignore`,
   `setup-nested.sh`/`.gitattributes` if added; in the analysis repo, `.python-version`; at
   the root (if tracked), `workspace.toml`, `CLAUDE.md`, `.gitignore` and the removals.

A migrate that stops before `workspace.toml` is rewritten is resumed by re-running it. One
that stops after (in `setup-nested.sh` or the sync) is finished with
`SETUP add-analysis --dir <analysis> --backend <backend>` and `SETUP sync`; `SETUP migrate`
then lists the root leftovers to back up and delete.

Not this skill: a document → `/project-workspace:add-document`; an analysis repo →
`/project-workspace:add-analysis`; publishing → `/project-workspace:setup-doc-publish`.
