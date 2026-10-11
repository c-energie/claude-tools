# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this workspace.

<!-- setup-banner -->
> **Not set up yet?** `workspace.toml` does not exist beside this file, so nothing below is
> true yet and the `<<...>>` names are unfilled. Run **/project-workspace:setup-project-workspace** first.
<!-- /setup-banner -->

## What this directory is

The `<<WORKSPACE>>` workspace, **writing-only layout**: one checkout that authors one LaTeX
document, with no analysis repo. Made from `c-energie/project-workspace-template`.
`workspace.toml` records `layout = "writing-only"`.

It is **itself a git repo, but only as a SHELL**: it tracks this file, `.claude/`,
`workspace.toml`, `.python-version`, `docs/agents/` and `.gitignore` (plus `pyproject.toml`
and `uv.lock` once doc-publish is installed), and ignores the member. Project-level issues
are filed here.

| Path | Remote | Role |
|---|---|---|
| `<<WRITING_DIR>>/` | `<<WRITING_REPO>>` | The LaTeX document. Pure markup — no Python. Compiled on Overleaf (GitHub sync). |

The member is a repo in its own right: **a commit here records only workspace work.**
Commit document changes inside `<<WRITING_DIR>>/`. It has its own `CLAUDE.md`/`AGENTS.md` —
read it before editing there.

`c-energie/doc-publish` (optional; `/project-workspace:setup-doc-publish`) is not checked out. If installed,
it lives in this root's venv (`pyproject.toml`'s `publish` extra), runs **from this root**,
and finds the document through `DOC_REPO` in `.env` here (gitignored, per-machine, absolute
path — never in a shell profile). Its per-document state lives in
`<<WRITING_DIR>>/.doc-publish/`.

## Commands

The LaTeX is compiled on Overleaf. `make` in `<<WRITING_DIR>>/` is optional and local only.
Never commit a built PDF.

If doc-publish is installed, from the workspace root:

```bash
uv sync --extra publish              # pass EVERY extra in workspace.toml's `extras`; uv removes the rest
uv run doc-publish doctor|build|check
```

`/project-workspace:setup-project-workspace` can also run its `sync` step, which reads that list
for you.

## Overleaf routine (GitHub sync)

1. In Overleaf: **left-hand panel → Integrations → GitHub → Push Overleaf changes to GitHub**.
2. `git pull` in `<<WRITING_DIR>>/` before editing locally.
3. Commit and push in `<<WRITING_DIR>>/`.
4. In Overleaf: **Pull GitHub changes into Overleaf**.

## Rules that break things silently

- **Never rename or move a committed figure.** LaTeX resolves bare filenames via
  `\graphicspath`; doc-publish indexes by name. A rename breaks both with no error.
- **Figure filenames are unique document-wide**, and labels mirror them
  (`foo.png` ↔ `\label{Fig: foo}`) — keeps the document ready for generated figures.
- **`\graphicspath` does not recurse.** One entry per figure directory.
- **Don't delete `<<WRITING_DIR>>/.doc-publish/*.json`.** They map the document to live
  Notion pages and stable site URLs.

## Skills here

From the `project-workspace@c-energie` plugin, which `.claude/settings.json` enables once you
trust this folder (with auto-update on, so fixes arrive by themselves).

| Skill | Use |
|---|---|
| `/project-workspace:setup-project-workspace` | First-run setup: create the writing repo from the template (or adopt an Overleaf project), name it, prove the document builds. Safe to re-run. |
| `/project-workspace:adapt-existing-document` | Bring an existing document into the `Sections/` / `\graphicspath` / label conventions, one section at a time. |
| `/project-workspace:setup-doc-publish` | Optional: corpus, Notion wiki, Quarto site. |
| `/project-workspace:setup-observer` | Invoked by the setup skills: logs deviations from the guide and, with consent, files them on GitHub. |

`/project-workspace:adapt-existing-analysis` needs an analysis repo, which this layout does not have. To add
one, keeping the writing repo as it is, run `/project-workspace:setup-project-workspace` again: it moves the
workspace to the full layout.

## Agent skills

### Issue tracker

GitHub Issues on this repo, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels, each named for its role: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root, created lazily. See `docs/agents/domain.md`.
