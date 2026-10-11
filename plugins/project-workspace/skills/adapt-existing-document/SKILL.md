---
name: adapt-existing-document
description: Adapt an existing LaTeX document to the conventions the figure tooling needs (Sections/[Name]/Figures, \graphicspath, bare filenames, labels mirroring filenames), one section at a time — in place, or moved from .setup/import-source/ into the template. Use after setup-project-workspace in adapt or import mode, or when generated figures aren't found by the document.
---

# Adapt an existing document

**First, invoke `/project-workspace:setup-observer`** (once per session): it records where this guide and
reality disagree, so the maintainer can fix the guide.

Read `workspace.toml` at the workspace root for `writing_dir`, `analysis_dir` and
`writing_mode` (and `layout`). **Writing-only layout** (`layout = "writing-only"`): there
is no analysis repo, so skip every step that runs one (the generated-figure proof, deleting
the example notebook, `check-figure-parity`) — a section is proved when the document
compiles. `DOC_MAIN_TEX` goes in the workspace root's `.env`, not `<analysis_dir>/.env`.
Then read `<writing_dir>/AGENTS.md` and the template's
[SETUP.md](https://github.com/c-energie/writing-template/blob/main/SETUP.md) section
"Adapting an existing document" — that is the authority; this skill is the procedure.

Rules:
- **One section at a time.** Move one, prove a figure lands, commit, then the next.
- **Never rename a committed figure file**, and never change prose. Layout and markup only.
- **Ask before every commit and push.** In `adapt` mode the repo is live on Overleaf: a
  push followed by "Pull GitHub changes into Overleaf" is what makes a change real there.
- You cannot see a rendered PDF. What you can check: balanced braces, every
  `\subfile`/`\input`/`\include`/`\includegraphics`/`\ref` target exists. If the user has
  latexmk (`make` in the writing dir), use it; otherwise ask them to recompile on Overleaf
  after each section and report errors back.

## What is required, and what is not

| Required | Why it matters |
|---|---|
| A root `.tex` at the repo root | Everything starts there. `main.tex`, `thesis.tex`, `dissertation.tex`, `report.tex`, `book.tex` are found automatically; any other name → set `DOC_MAIN_TEX=<name>.tex` in `<analysis_dir>/.env`. **Do not rename it.** |
| Figures referenced by **bare filename** (`\includegraphics{foo.png}`, never `figs/ch2/foo.png`) | `\graphicspath` resolves them; the tooling indexes by name |
| Labels mirroring filenames (`foo.png` ↔ `\label{Fig: foo}`) | How the analysis tooling knows a figure is already placed; without it, re-running a notebook appends a duplicate block |
| Sections that get generated figures live in `Sections/<Name>/` with a `Figures/` dir | Where `doc_analysis` writes |
| Figure filenames unique across the whole document | Two matches = `ambiguous`, silently dropped from wiki/site |

Not required — leave alone: the document class, the root filename, the `.sty` name, the
bibliography location, whether a glossary exists, `\chapter` vs `\section`.

## Mode `adapt` — restructure in place

1. **Survey.** List the root `.tex`, how sections are pulled in (`\subfile`/`\input`/`\include`),
   where figures live, every `\graphicspath` (and which file it is in), every
   `\includegraphics` that uses a path or extension, and whether the preamble already
   defines `\width` and loads `float` (step 3 needs both). Report it as a table and agree
   with the user which section to do first — pick one that will get generated figures soonest.
2. **Move one section.**
   ```bash
   mkdir -p Sections/<Name>/Figures
   git mv <old>/<file>.tex Sections/<Name>/
   git mv <old figure files for this section> Sections/<Name>/Figures/
   ```
   `git mv` (not copy) keeps history and lets Overleaf's sync see a move.
3. **Fix the references.** The `\input`/`\subfile` line in the root `.tex`; add
   `Sections/<Name>/Figures/` to `\graphicspath` (it does **not** recurse — one entry per
   directory, each with a trailing slash, each in its own braces); make that section's
   `\includegraphics` bare filenames. If a section used `\subfile`, the `subfiles` package
   must already be loaded; don't introduce it if they use `\input`.

   **`\graphicspath` is declared once, in a root-level `.sty` or the root `.tex`** — never in
   an `\input`/`\include`/`\subfile`-d file. LaTeX does not care, but doc-publish reads it
   only from the repo root's `.sty` files and the root `.tex`, and the first declaration it
   finds wins: one left in an `\input`-ed `setup.tex` is invisible to it, and a second one
   elsewhere is silently ignored. (Its last-resort search of `Sections/` can make a figure
   resolve anyway, so a misplaced `\graphicspath` does not show up as an error.) If the
   survey found it in a nested file, move the whole declaration to the root `.tex`'s
   preamble, or to a root `.sty` the document already `\usepackage`s, and add new entries
   there.

   **The preamble must define `\width` and load `float`.** The blocks `save_fig` appends use
   `\begin{figure}[H]` (needs `float`) and `width=\width`; the template defines `\width`
   in its `document_settings.sty`, which an adapted document does not have. Add, beside
   `\graphicspath`:
   ```latex
   \usepackage{float}
   \providecommand{\width}{0.95\textwidth}
   ```
   `\providecommand` leaves an existing `\width` alone — if the survey found the class or
   preamble already defines one, check with the user that it is a width (a length or
   `\textwidth` fraction), because every generated figure will be sized by it.
4. **Labels.** For figures this section's notebooks will (re)generate, the label must be
   `Fig: <stem>`. Renaming a label means updating every `\ref`/`\cref` to it — grep the
   whole repo. Leave figures nobody will regenerate alone.
5. **Prove it.** Recompile (local `make` or Overleaf). Then, from the analysis repo,
   `uv run notebook-skeleton new <Name> <notebook>` and fill in its figure cell to save one
   figure for this section. (If `/project-workspace:adapt-existing-analysis` will bring this section's real
   notebooks in later, delete this one then.) Confirm the PNG landed in
   `Sections/<Name>/Figures/` and a commented `\begin{figure}` block was appended. Then
   **uncomment that block once and recompile**: it is the only check that `\width`, `float`
   and the `\graphicspath` entry from step 3 work, because the block compiles nowhere while
   it is commented. Re-comment it afterwards if the figure is not meant to appear yet.
   **After the first section only** (full layout), finish the workspace-root proof that
   `setup-project-workspace` §7 deferred — it could not run while the document had no
   `Sections/` (#3). At the workspace root:
   `uv run python -c "import sys; from doc_analysis import notebook_setup, document_repo; notebook_setup(); print(sys.executable); print(document_repo())"`.
   Expect the root `.venv`'s interpreter, then the absolute path of the writing repo.
   Anything else is a deviation to log with `/project-workspace:setup-observer`.
6. **Commit** in the writing repo (ask), push, then Overleaf → Pull GitHub changes.
7. Repeat for the next section. Sections that will never hold generated figures may stay
   where they are.

## Mode `import` — move into the template layout

The new writing repo is the initialised template; the old document is in
`.setup/import-source/` (read-only reference — never edit it, never commit it).

**If the source was a document file** (Word, ODT, Markdown, …), setup converted it with
pandoc: `.setup/import-source/` holds one `<name>.tex` and a `media/` folder, and its
captions have already lost any `Figure 3:` / `Table 1.` prefix. Nothing else was fixed.
Work through this list as each section moves in (step 4):

- **Headings.** A Word heading can come through as `\paragraph{...}` holding a whole
  paragraph, or with a long auto-generated `\label`. Restructure them into proper
  `\section`/`\subsection` headings with short labels.
- **Equations.** Remove blank lines inside `equation` environments: LaTeX rejects them.
- **Images against captions.** View each image and confirm it matches its caption.
  Captions on images placed inline in Word can be paired off by one.
- **`\textbackslash` in the text** means LaTeX was typed inside Word and pandoc escaped it
  (`\textbackslash citep\{X\}`). Fix those spots by hand, back to the LaTeX intended.
- **Images into place.** pandoc names them `media/media/image1.png` and so on. Move each
  into `Sections/<Name>/Figures/` under a descriptive, document-wide unique name, and
  follow the bare-filename, label and `\graphicspath` rules above.

1. **Class and preamble.** Copy any `.cls` beside `main.tex` and swap the `\documentclass`
   line. Move the old preamble's packages and macros into `document_settings.sty`, keeping
   what the template already loads and resolving duplicate/conflicting packages with the
   user. Old acronym/glossary entries → `glossary_terms.tex`.
2. **Front matter** into `Preamble/` (title page, abstract, acknowledgements).
3. **Bibliography** `.bib` files into `Bibliographies/`; fix `\addbibresource`. If the old
   document used BibTeX (`\bibliography{}`) rather than biblatex, ask before converting.
4. **Sections**, one at a time, each into `Sections/<Name>/<file>.tex` with its figures in
   `Sections/<Name>/Figures/`, a `\subfile` line in `main.tex` in reading order, and a
   `\graphicspath` line in `document_settings.sty`. Each section file needs the
   `\documentclass[../../main.tex]{subfiles}` wrapper — copy it from
   `Sections/Example/example.tex`. Apply the bare-filename and label rules above as you go.
5. Once the first real section compiles and a generated figure lands in it, remove the
   example — all of it, because every leftover is still indexed by name somewhere.
   1. **In the writing repo, delete `Sections/Example/`**, its `\subfile` line and its
      `\graphicspath` entry. A plain `git rm -r` refuses: the setup proof run rewrote
      `tables.tex`, so the tracked files carry local modifications. And `git rm` only
      touches tracked files, leaving the generated `Figures/example_scatter.png` behind —
      a figure still found under `Sections/` by name. So force the removal, then delete
      the directory:
      ```bash
      git rm -rf Sections/Example; rm -rf Sections/Example
      ```
      ```powershell
      git rm -rf Sections/Example; Remove-Item -Recurse -Force Sections/Example -ErrorAction SilentlyContinue
      ```
      The second command runs regardless, so a re-run after a partial removal still clears
      the untracked files. `Sections/Example` must no longer exist afterwards.
   2. **In the analysis repo, delete the example notebook** (`notebooks/example/`) and its
      `figures_config.toml` entry.
   3. **Still in the analysis repo, remove what the example wrote to `figures_html/`.** It is
      gitignored, so nothing above touches it, and `check-figure-parity --snapshot` reads it:
      left in place, the snapshot records `example_scatter` at its old
      `Sections/Example/Figures/` path as if it were part of the document. Delete
      `figures_html/example_scatter.html`, then open `figures_html/figures_manifest.json`
      and delete the `example_scatter` entry (label `Fig: example_scatter`), keeping the
      JSON valid. Check nothing is left:
      ```bash
      grep -rl example_scatter figures_html        # must print nothing
      ```
      ```powershell
      Get-ChildItem -Recurse -File figures_html | Select-String -List -Pattern example_scatter   # must print nothing
      ```
   4. **Re-run `uv run check-figure-parity --snapshot`** from the analysis dir, then confirm
      the new baseline holds no example path:
      ```bash
      grep -E 'Sections/Example/|example_scatter' docs/figure_png_baseline.json   # must print nothing
      ```
      ```powershell
      Select-String -Pattern 'Sections/Example/|example_scatter' -Path docs/figure_png_baseline.json   # must print nothing
      ```
      If it still lists one, something in step 5.3 survived: find it rather than editing
      the baseline by hand.

   Writing-only layout: do 5.1 only — there is no analysis repo.
6. Diff the old and new document for lost content: every `\label` in the old should exist
   in the new. Report any that don't.
7. Commit (ask), push, then Overleaf **New Project → Import from GitHub**. Delete
   `.setup/import-source/` at the workspace root.

## Finish

Update `<writing_dir>/AGENTS.md` so its layout description matches the document as it now
is (it was written for the template's example layout). Then suggest `/project-workspace:setup-doc-publish`
if they want a corpus/wiki/site — its `doc-publish build` is the strictest audit of
everything above and will name anything still unresolved.
