---
name: add-document
description: Add a document to a project workspace — a new document repo from c-energie/writing-template, an existing Overleaf project adopted through its GitHub sync, or an existing document imported (LaTeX, Word, Markdown) — and prove it builds. Use when the user asks to add a document, thesis, paper or report to the workspace, or to bring an Overleaf project or a Word document in.
---

# Add a document

**First, invoke `/project-workspace:setup-observer`** (once per session).

A **document** is one document repo inside the project workspace, recorded as a
`kind: "document"` member in `.claude/workspace.json`, with optionally an analysis repo nested inside it later
(`/project-workspace:add-analysis`). A workspace holds any number of them.

Prerequisite: `.claude/workspace.json` at the root. Missing, or only a `workspace.toml` there
(every step refuses until it is migrated) → invoke `/project-workspace:setup-project-workspace`
first.

Mechanical work is `setup_workspace.py`, shared with setup-project-workspace:

```bash
uv run --no-project --python 3.12 "${CLAUDE_SKILL_DIR}/../setup-project-workspace/setup_workspace.py" --root "${CLAUDE_PROJECT_DIR}" <step> [flags]
```

Abbreviated `SETUP <step>`; `--dry-run` goes before `<step>`. Never commit or push without
asking; creating a GitHub repo is outward-facing — confirm owner, name and visibility once,
before the first one. Run `SETUP check` if this session has not.

## 1. Interview

Ask in this order, a few at a time; collect everything before running anything.

1. **Document short name** — lower-case, dashes (`thesis`, `gridflex-report`). It is the
   default repo name and directory, and must not clash with a document already listed
   (`SETUP document --all`).
2. **GitHub owner** — default the `gh` login; may be an org they belong to.
3. **Visibility** — default `private` (a template's visibility is not inherited).
4. **Where is the document now?** This picks the mode:

   | Answer | Mode | What happens |
   |---|---|---|
   | On Overleaf, keeping that project and its history | `adapt` | Overleaf's GitHub sync creates `<owner>/<name>`; the script clones it and adds writing-template's `AGENTS.md`/`CLAUDE.md`/`docs/agents/`/`setup-nested.sh`/ignore rules. The document is adapted to the conventions in place, later. |
   | Exists (Overleaf or elsewhere), but start from the template's layout | `import` | New repo from writing-template; the old document is staged in `.setup/<dir>/import-source/` and moved into the template structure. A **new** Overleaf project is imported from GitHub; the old one is retired. |
   | A document file (Word, ODT, Markdown, …) | `import` | As above, converted to LaTeX with pandoc first. The user must **download it to this machine** — a SharePoint or OneDrive link will not work. Word's `.doc` is not readable: save it as `.docx`. |
   | Nothing yet | `fresh` | New repo from writing-template. |
   | Already a repo made from writing-template, elsewhere on GitHub | `adapt` | Cloned in as it is, history intact; no repo is created. Skip question 5 unless it is not yet linked to Overleaf. |

   Recommend `adapt` for anyone with an active Overleaf project that collaborators or
   supervisors comment in; `import` for a messy or short document.

   **Already cloned somewhere else on this machine?** It is cloned again, fresh, inside the
   workspace: a document lives in the workspace folder. Tell the user the old checkout will
   go stale — push anything in it, then delete it.
5. **Overleaf GitHub sync** (`adapt`, and `import` from Overleaf). Needs a premium Overleaf
   plan — many universities provide one; ask. Without it, stop: Overleaf is supported only
   through GitHub sync. For `import` they can download the project zip and give a local
   path as source instead.

   For `adapt`, walk them through it now and wait for confirmation:
   > In Overleaf, open the project → left-hand panel → **Integrations** → **GitHub** →
   > connect your GitHub account if you haven't → owner `<owner>`, repo name exactly
   > `<name>`, private. Overleaf pushes the project there.

   For `import` from Overleaf: the same, any repo name (e.g. `<name>-overleaf-old`); that
   repo is the `--source`.
6. **Title and author** (`import`/`fresh` — fills the template's placeholders).
7. **Generated figures or tables?** Not acted on here — it decides whether §5 offers
   add-analysis.

Read back a summary (name, repo, directory, mode, source) and get an explicit yes.

## 2. Create it

```bash
SETUP add-document --mode adapt  --repo <owner>/<name>
SETUP add-document --mode import --repo <owner>/<name> --title "<title>" --author "<author>" --source <owner/old-repo | path>
SETUP add-document --mode fresh  --repo <owner>/<name> --title "<title>" --author "<author>"
```

`--dir` (default: the repo name) and `--name` (default: the directory) override. `--source`
for `import` is one of: `OWNER/NAME` (cloned); a folder (copied); a `.tex` file (its whole
folder is copied, so what it `\input`s comes too); a document file (`.docx`, `.odt`, `.md`,
…), converted by pandoc into `.setup/<dir>/import-source/<name>.tex` with its images under
`media/`. pandoc runs through `uv run --with pypandoc_binary==1.17`, nothing is installed,
but **the first run downloads about 230 MB**: say so before running it. Caption prefixes
such as `Figure 3:` are stripped automatically; everything else the conversion gets wrong is
on adapt-existing-document's checklist.

The step records the document as a member in `.claude/workspace.json`, adds a row to
`CLAUDE.md`'s documents table and, **in a tracked workspace, edits the root `.gitignore`**: its
managed members block gains `/<dir>/`. A line the user already has for that directory outside
the block is left alone and reported (`note .gitignore already ignores ...`), not repeated.

## 3. Bring the existing document in (`adapt`, `import`)

Invoke **`/project-workspace:adapt-existing-document`** for this document. It is judgment
work (moving sections, `\graphicspath`, labels), done one section at a time with the user.

## 4. Prove it builds

Take the first rung that applies, and tell setup-observer which one it was:

1. `check` showed `[ok] latexmk`: `make` in the document repo. A failure here (a missing TeX
   package) is not a setup failure; log it and drop to rung 2.
2. Ask the user to compile on Overleaf (after §5's wiring) and confirm it builds without
   errors.

## 5. Overleaf, commits, and next

- **Overleaf.** `adapt`: already linked; walk them through the workspace `CLAUDE.md`'s
  "Overleaf routine" — its order (pull before regenerating figures) keeps prose edited on
  Overleaf from colliding with regenerated figures. `import`/`fresh`: **New Project → Import
  from GitHub** → `<owner>/<name>`; for `import`, tell them to archive the old Overleaf
  project. Either way, **set the compiler** (Menu → Settings) to what the document needs;
  the template uses biblatex/biber, and lualatex or pdflatex both work.
- **Commit** in the document repo (`adapt`: the overlay files; `fresh`/`import`: the
  initialised template), asking before the commit and the push. In a tracked workspace,
  propose `.claude/workspace.json`, `CLAUDE.md`, `.gitignore` at the root.
- Delete `.setup/<dir>/import-source/` once an `import` is finished.
- **Generated figures?** If question 7 was yes, invoke **`/project-workspace:add-analysis`**
  for this document now; otherwise say it can be added any time, without recreating anything.

Not this skill: the workspace itself → `/project-workspace:setup-project-workspace`; an
analysis repo → `/project-workspace:add-analysis`; publishing →
`/project-workspace:setup-doc-publish`.
