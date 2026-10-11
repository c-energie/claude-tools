---
name: setup-project-workspace
description: First-run setup of a document workspace — create the writing repo (and, unless writing-only, the analysis repo) from the c-energie templates and prove the pipeline works — and later, adding the analysis repo to a writing-only workspace. Use when workspace.toml is missing at the workspace root, when the user asks to set up the workspace or bring an Overleaf document into it, or when a writing-only workspace now needs generated figures.
---

# Set up a document workspace

**First, invoke `/project-workspace:setup-observer`** (once per session): it records where this guide and
reality disagree, so the maintainer can fix the guide.

The end state, mirroring the reference thesis workspace:

```
<workspace>/                 this repo — a SHELL: tracks CLAUDE.md, .claude/, pyproject.toml,
|                            workspace.toml, .python-version, .gitignore; ignores both members
|-- <doc>-writing/           LaTeX. Own repo. Goes to Overleaf.
|-- <doc>-analysis/          Python figure/table tooling (doc_analysis). Own repo.
|                            Writes into <doc>-writing via DOC_REPO in its .env.
|-- pyproject.toml           uv workspace root; <doc>-analysis is its one member
`-- .venv/                   shared venv, created by `uv sync` HERE
```

That is the **full** layout. The **writing-only** layout (question 0 below) has only
`<doc>-writing/`: no analysis repo, and no `pyproject.toml` or `.venv/` unless doc-publish
is wanted. Steps marked *(full only)* are skipped for it.

**`workspace.toml` already exists?** Then this is not a first run. If it records
`layout = "writing-only"`, offer to add the analysis repo and, on a yes, go straight to
[Adding analysis later](#adding-analysis-later). Otherwise re-run only the step that
failed.

All mechanical work is done by `setup_workspace.py` beside this file. Your job is the
interview, running its steps in order, and the judgment work the script cannot do.
Always run it through uv — the system Python may be too old, uv fetches a right one:

```bash
uv run --no-project --python 3.12 "${CLAUDE_SKILL_DIR}/setup_workspace.py" --root "${CLAUDE_PROJECT_DIR}" <step> [flags]
```

Abbreviated below as `SETUP <step>`. Every step accepts `--dry-run` (before `<step>`); use
it to show the user the plan before the first step that creates a GitHub repo.

Rules:
- **Ask, don't guess** wherever the interview below says ask. Offer the default in brackets.
- **Never commit or push in any repo without asking.** The script creates repos and
  clones; it never commits. Creating a GitHub repo is outward-facing — confirm the full
  list of repos (names, owner, visibility) once, before the first `gh repo create`.
- Stop on the first failed step. Diagnose, fix, re-run that step — every step is safe to
  re-run (it reuses an existing repo / checkout rather than clobbering it).

## 0. Prerequisites

```bash
SETUP check                          # full layout
SETUP check --layout writing-only    # skips the analysis-template check
```

If the layout is not known yet, run plain `check`; a `FAIL` on only the analysis template
does not block a writing-only setup. If `uv` itself is missing the command above cannot run — give the install command first:

| Tool | Windows | macOS | Linux |
|---|---|---|---|
| uv | `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 \| iex"` or `winget install --id astral-sh.uv -e` or `pip install uv` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` or `brew install uv` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| git | `winget install --id Git.Git -e` | `xcode-select --install` | `sudo apt install git` |
| gh (GitHub CLI) | `winget install --id GitHub.cli -e` | `brew install gh` | `sudo apt install gh` |
| Python ≥ 3.11.4 | `uv python install 3.12` (uv manages it; no system Python needed) | same | same |

Then `gh auth login` (HTTPS; let it configure git). After any install the user must open
a **new terminal** (and restart Claude Code) so PATH picks it up. Work down every `FAIL`
line until `check` exits 0. `--` lines (latexmk, make) are optional: Overleaf compiles the
document without a local TeX install. latexmk is run, not just looked up, so
`[--] latexmk (found but does not run; it needs Perl)` means a TeX install is there but its
latexmk cannot start — install Perl only if the user wants local builds.

## 1. Interview

Ask in this order, a few questions at a time. Collect everything before running anything.

0. **Will this document have generated figures or tables?** Default yes → layout `full`.
   No (an opinion piece, a proposal) → layout `writing-only`: skip questions 8–10 and the
   analysis name in question 4. Analysis can be added later without recreating any repo
   ([Adding analysis later](#adding-analysis-later)), so "not yet" means writing-only.
1. **Document short name** `<doc>` — lower-case, dashes (e.g. `thesis`, `gridflex-report`).
   Default: this workspace directory's name.
2. **GitHub owner** for the new repos. Default: the `gh` login from `check`. May be an org
   they belong to.
3. **Visibility** — default `private` (a template's visibility is not inherited; unpublished
   work should be private).
4. **Repo / directory names** — default `<doc>-writing` and `<doc>-analysis`, directory
   name = repo name. Let them override either.
5. **Where is the document now?** This picks the writing mode:

   | Answer | Mode | What happens |
   |---|---|---|
   | On Overleaf, and I want to keep that project and its history | `adapt` | Overleaf's GitHub sync creates `<owner>/<doc>-writing`; the script clones it and adds the template's `AGENTS.md`/`CLAUDE.md`/`docs/agents/`/ignore rules. The document is then adapted to the conventions in place. |
   | Exists (Overleaf or elsewhere), but I'd rather start from the template's layout | `import` | New repo from writing-template; the old document is staged in `.setup/import-source/` and moved into the template structure. A **new** Overleaf project is then imported from GitHub; the old one is retired. |
   | A document file (Word, ODT, Markdown, …) | `import` | As above, but the file is converted to LaTeX with pandoc first, into `.setup/import-source/`. The user must **download it to this machine first** — a SharePoint or OneDrive link will not work — and give that local path as the source. Word's `.doc` is not readable: save it as `.docx`. |
   | Nothing yet | `fresh` | New repo from writing-template. |
   | Already a repo made from writing-template, with no workspace around it | `adapt` | The same path as an Overleaf project: the repo is cloned in as the member, history intact, and no repo is created. Skip question 6 unless it is not yet linked to Overleaf. It already has `Sections/`, so §7's root proof uses `document_repo()` as for `fresh`. (To keep it standalone instead, it can host its analysis repo itself: writing-template's `setup-nested.sh`. That is writing-template's path, not this skill's.) |

   If unsure, recommend `adapt` for anyone with an active Overleaf project and
   collaborators/supervisors commenting there, `import` for a messy or short document.

6. **Overleaf GitHub sync** (modes `adapt`, and `import` when the source is on Overleaf).
   This needs a premium Overleaf plan — many universities provide one; ask. If they do
   not have it, stop and say so: this setup only supports Overleaf via GitHub sync. For
   `import` they can instead download the project zip and give a local path as source.

   For `adapt`, walk them through it now and wait for confirmation:
   > In Overleaf, open the project → left-hand panel → **Integrations** → **GitHub** →
   > connect your GitHub account if you haven't before → enter owner `<owner>` and repo
   > name exactly `<doc>-writing`, private. Overleaf pushes the project there.

   For `import` from Overleaf: same steps but any repo name (e.g. `<doc>-overleaf-old`);
   that repo is the `--source`.
7. **Title and author** (modes `import`/`fresh` — fills the template's placeholders).
   Author is also asked for the analysis repo in every mode.
8. **Plotting backend** — `plotly` (default, recommended: one figure object gives the PDF
   PNG *and* an interactive HTML for a wiki/site) or `matplotlib` (static PNG only, no
   headless-Chrome download).
9. **Analysis distribution name** — default `<doc>-analysis`. Lower-case, digits, dashes.
   The import package stays `doc_analysis` regardless; say so if they ask why.

10. **Existing analysis?** — a project with notebooks that should feed this document: its
    local path or `OWNER/NAME`, or none. The analysis repo is still created fresh from the
    template; the existing project is copied into it in step 8 and left untouched.
    If it is a larger project of which only part feeds this document, ask **which notebooks
    or folders?** and note each answer as a path relative to that project (a folder, or a
    glob such as `results/**`). Otherwise every file in it is planned for copying.
11. **Python version** for the workspace venv, written to `.python-version`. Default `3.12`:
    many scientific packages have no wheels for the newest Python yet, so the newest is
    not the safe choice. If question 10 named a project, read its `pyproject.toml`
    `requires-python` and its `.python-version` first. Offer that `.python-version` if it
    has one, or else the newest minor its range allows, capped at 3.12. A minor (`3.12`)
    or a patch release (`3.12.4`), at least 3.11.4. In the writing-only layout it matters
    only once doc-publish is installed; offer the default and move on.

Read back a summary table (layout, every repo to be created, every directory, mode,
backend, Python version) and get an explicit yes.

## 2. Make the workspace its own repo

```bash
SETUP workspace
```

If it reports origin is already theirs (they used **Use this template**), move on. If it
reports origin is the template, or none, ask for the workspace repo name (default `<doc>`)
and run `SETUP workspace --repo <owner>/<name> --visibility private`. That renames the
template remote to `template` (kept for pulling template updates) and pushes to the new repo.

## 3. The writing repo

```bash
SETUP writing --mode adapt  --repo <owner>/<doc>-writing --dir <doc>-writing
SETUP writing --mode import --repo <owner>/<doc>-writing --dir <doc>-writing --title "<title>" --author "<author>" --source <owner/old-repo | path>
SETUP writing --mode fresh  --repo <owner>/<doc>-writing --dir <doc>-writing --title "<title>" --author "<author>"
```

`--source` for `import` is one of:

- `OWNER/NAME` — cloned.
- A folder — copied.
- A `.tex` file — its whole folder is copied, so the files it `\input`s come too.
- A document file (`.docx`, `.odt`, `.md`, …) — converted by pandoc into
  `.setup/import-source/<name>.tex`, with its images under `media/`. pandoc runs through
  `uv run --with pypandoc_binary==1.17`, nothing is installed, but **the first run downloads
  about 230 MB**: say so before running it. Caption prefixes such as `Figure 3:` are
  stripped automatically (the script prints how many). Everything else the conversion gets
  wrong is on adapt-existing-document's checklist for converted documents.

## 4. The analysis repo *(full only)*

```bash
SETUP analysis --repo <owner>/<doc>-analysis --dir <doc>-analysis --writing-dir <doc>-writing \
               --distribution <doc>-analysis --author "<author>" --backend plotly
```

This runs the template's `init.py` with the answers, which writes `<doc>-analysis/.env`
with an absolute `DOC_REPO`. That file is per-machine and gitignored — correct as is.

## 5. The workspace root

```bash
SETUP root --name <doc> --writing-dir <doc>-writing --writing-repo <owner>/<doc>-writing \
           --writing-mode <mode> --analysis-dir <doc>-analysis --analysis-repo <owner>/<doc>-analysis \
           --backend plotly --python <version>
# writing-only:
SETUP root --name <doc> --layout writing-only --writing-dir <doc>-writing \
           --writing-repo <owner>/<doc>-writing --writing-mode <mode> --python <version>
```

Writes `pyproject.toml` (uv workspace root; full only), `workspace.toml` (what the other
skills read; records `layout`), `.python-version` (question 11's answer; default `3.12`;
kept if it exists, and the script says how to change it), the member
block in `.gitignore`, and fills the `<<...>>` placeholders in `CLAUDE.md`. For
writing-only it first replaces the still-unfilled `CLAUDE.md` with
`CLAUDE.writing-only.md` from beside the script (no pipeline, no `DOC_REPO`, no analysis
commands).

## 6. Install *(full only)*

Writing-only: nothing to install; `SETUP sync` says so and exits 0. doc-publish, if
wanted, is installed by `/project-workspace:setup-doc-publish` in step 10.

```bash
SETUP sync
```

= `uv sync --extra dev --extra notebooks --extra <backend>` at the root. The venv is built
on the interpreter `.python-version` names (question 11), not the newest one uv can find:
scientific stacks brought in later by `/project-workspace:adapt-existing-analysis` often have no wheels for
the newest Python yet. To change it, `uv python pin <version>` at the root, then re-run
`SETUP sync`. Then:

- **plotly backend only — Chrome for PNG export.** kaleido renders through Chrome/Chromium.
  If none is installed, `uv run plotly_get_chrome` fetches one (or install Chrome:
  `winget install --id Google.Chrome -e` / `brew install --cask google-chrome`). Prove it
  as **its own command**, not chained after `SETUP sync`, and **with a time limit** — the
  shell tool's timeout, or about 120 s:
  `uv run python -c "import plotly.express as px; px.scatter(x=[1],y=[1]).write_image('kaleido_check.png')"`
  then delete `kaleido_check.png`.
  A first Chrome launch by kaleido can stall: once, chained straight after `sync`, this
  hung past a 600 s timeout, yet the same check took ~10 s on the venv interpreter and
  later `uv run` calls were fine (#13; cause not found — possibly Chrome's first-run
  profile setup or a firewall prompt for its debugging port). Unlimited, a stall holds
  the whole session. If it stalls, in this order:
  1. Re-run it once, still with the limit.
  2. Run the same `-c` with the venv interpreter directly — `.venv\Scripts\python.exe`
     on Windows, `.venv/bin/python` elsewhere, from the root. If that passes, the
     problem was uv, not Chrome; if it stalls too, it is Chrome.
  3. `uv run plotly_get_chrome`, then the check again — a kaleido-managed Chrome even
     if a system one is installed.

  Tell `/project-workspace:setup-observer` whichever step it took; delete `kaleido_check.png` either way.
- **Tests**, from the analysis dir (uv finds the root venv):
  `cd <doc>-analysis && uv run python -m pytest tests -q`.
  Use `python -m pytest`; plain `uv run pytest` can fail on Windows with
  "trampoline failed to canonicalize script path".
- **Running notebooks**: walk the user through `<doc>-analysis/README.md`, "Running
  notebooks", for the editor they use — JupyterLab (`notebooks` extra: `uv run jupyter lab`
  from the analysis dir), VS Code, PyCharm, or marimo. For marimo, add
  `marimo = ["<doc>-analysis[marimo]"]` (the distribution name from §4) under `[project.optional-dependencies]` in
  the root `pyproject.toml`, add `"marimo"` to `extras` in `workspace.toml`, and re-run
  `SETUP sync`. Whatever the editor, the kernel is **the workspace root's venv**:
  `<workspace>\.venv\Scripts\python.exe` on Windows, `<workspace>/.venv/bin/python` elsewhere —
  not a venv inside the analysis repo.
- **Optional local LaTeX build** (only if `check` showed `[ok] latexmk`): `make` in the writing dir.
  Never commit the PDF.

## 7. Prove the pipeline

**Writing-only:** there is no figure to land; prove the document builds. Take the first
rung that applies and tell `/project-workspace:setup-observer` which one it was:

1. doc-publish installed (only after `/project-workspace:setup-doc-publish`): from the root,
   `uv run doc-publish doctor` then `uv run doc-publish build`.
2. `check` showed `[ok] latexmk`: `make` in `<doc>-writing/`. A failure here (a missing
   TeX package, say) is not a setup failure; log it and drop to rung 3.
3. Ask the user to compile on Overleaf (after step 9's wiring) and confirm it builds
   without errors. That confirmation is an acceptable proof.

For `adapt`, the document is proved as-is; `/project-workspace:adapt-existing-document` comes later.
Skip the rest of this section.

**Full layout:**

- **Every mode — setup from the workspace root.** This is the case an IDE that opens the
  whole workspace as its project hits (the kernel starts here, above the analysis repo).
  At the workspace root, by mode:
  - `fresh` / `import`:
    `uv run python -c "import sys; from doc_analysis import notebook_setup, document_repo; notebook_setup(); print(sys.executable); print(document_repo())"`.
  - `adapt`:
    `uv run python -c "import os, sys; from doc_analysis import notebook_setup; notebook_setup(); print(sys.executable); print(os.environ['DOC_REPO'])"`.
    Not `document_repo()`: it raises `NotADirectoryError: ... (no Sections/ directory)`
    until the first section is moved, and an adopted Overleaf project has none yet —
    `SETUP writing --mode adapt` adds only the overlay files and never creates `Sections/`,
    because an empty one would be pushed to the user's live Overleaf project (#3). So that
    error is expected here, not a deviation. `/project-workspace:adapt-existing-document` runs the
    `document_repo()` proof once the first section is in `Sections/`.

  Expect the root `.venv`'s interpreter, then the absolute path of `<doc>-writing`.
  If `DOC_REPO` is unset, the error lists every place it looked for a `.env`. Any other
  output is a deviation to log.
- **`fresh` / `import`**: the writing repo still has `Sections/Example/`. Run
  `<doc>-analysis/notebooks/example/example_figure.ipynb` (plotly only) — e.g.
  `cd <doc>-analysis && uv run jupyter nbconvert --to notebook --execute notebooks/example/example_figure.ipynb --output-dir ../.setup/executed --ExecutePreprocessor.timeout=600`.
  The executed copy goes to the workspace's gitignored `.setup/executed/`, never back over
  the tracked notebook: `--output example_figure.ipynb` wrote ~5 MB of plotly output into
  it, easy to commit by accident in §10 (#10). The command is the same in bash and
  PowerShell. The kernel still runs in the notebook's own directory, so its saves land
  where they would from Jupyter. The timeout is per cell and stated rather than left to
  whichever nbconvert is installed; a hang then fails instead of stalling the session.
  Expect a new `example_scatter.png` under `<doc>-writing/Sections/Example/Figures/`.
  (No figure block is appended: `example.tex` already references it — that is the
  duplicate gate working. A *new* figure name gets a commented `\begin{figure}` block.) Then
  `cd <doc>-analysis && uv run check-figure-parity --snapshot`.
  On matplotlib, copy the README's matplotlib usage block into a scratch notebook instead.

  **Tracked files this is expected to change** — show `git status` in both members:
  - `<doc>-analysis`: only the baseline `check-figure-parity --snapshot` records. A
    modified notebook means it was executed in place; `git restore` it.
  - `<doc>-writing`: `Sections/Example/Figures/example_scatter.png`, and
    `Sections/Example/tables.tex` — the example notebook's `save_table` rewrites it, and
    writing-template's committed copy predates the notebook's `bias` column (#10). Commit
    it with the figure in §10. Once writing-template commits the regenerated table, it
    will no longer change here; tell `/project-workspace:setup-observer` whether it did.

  Anything else in either `git status` is a deviation to log.
- **`adapt`**: the document has no `Sections/Example/`, so skip this. The proof happens
  in the next skill, against the first section moved into `Sections/` — the generated
  figure and the deferred `document_repo()` proof above both.

## 8. Bring existing work in

- **Document** (modes `adapt` and `import`): invoke the **adapt-existing-document** skill.
  It is judgment work (moving sections, `\graphicspath`, labels) done one section at a
  time with the user, not a script.
- **Analysis** (full only; an existing project named in question 10): then invoke the
  **adapt-existing-analysis** skill. It runs after the document, because notebooks are
  placed by the document's `Sections/`. Hand it the notebooks or folders named in
  question 10; it passes each to its `plan` step as `--include`.

## 9. Overleaf wiring

- `adapt`: already linked. Walk the user through the routine in the workspace `CLAUDE.md`,
  "Overleaf routine" — its order (pull before regenerating figures) is what keeps prose
  edited on Overleaf from colliding with regenerated figures.
- `import` / `fresh`: once the document builds, in Overleaf **New Project → Import from
  GitHub** → `<owner>/<doc>-writing`. For `import`, tell the user to archive the old
  Overleaf project so no one keeps editing it.
- Either way: **set the Overleaf compiler** (Menu → Settings) to whatever the document
  needs — the template uses biblatex/biber; lualatex or pdflatex both work for it.

## 10. Commit and finish

1. In each member, show `git status` and propose a commit (`adapt`: the overlay files;
   `fresh`/`import`: the initialised template plus any example figure). Ask before each
   commit and each push.
2. At the workspace root, the files to commit are `CLAUDE.md`, `.gitignore`,
   `.python-version`, `pyproject.toml`, `uv.lock`, `workspace.toml` (writing-only: no
   `pyproject.toml` or `uv.lock` yet). Ask, then commit and push.
3. Delete `.setup/import-source/` once an `import` is finished (gitignored, but stale),
   and `.setup/executed/` — §7's executed copies, kept only to read a failure from.
   `.setup/analysis-import/` belongs to adapt-existing-analysis, which deletes it itself.
4. Offer the optional next step: **/project-workspace:setup-doc-publish** (corpus, Notion wiki, Quarto site).
5. Point them at the `CLAUDE.md` at the workspace root — it is now filled in and is what
   every future session here loads.

## Adding analysis later

A writing-only workspace (`layout = "writing-only"` in `workspace.toml`) that now needs
generated figures moves to the full layout in place: the writing repo, its history and its
Overleaf link are kept; only the analysis repo is new.

1. **Interview** — questions 2, 3, 4 (the analysis name only), 7 (author), 8, 9 and 10
   from §1. `.python-version` already exists and is kept; if question 10 names a project
   whose `requires-python` excludes it, say so and offer `uv python pin <version>`.
   Confirm the one repo to be created, then show the plan:
   ```bash
   SETUP --dry-run add-analysis --repo <owner>/<doc>-analysis --dir <doc>-analysis \
                  --distribution <doc>-analysis --author "<author>" --backend plotly
   ```
2. **Run it** without `--dry-run`. It refuses before creating anything if `workspace.toml`
   is missing, already records a different analysis member, the root `pyproject.toml`
   is not the one `publish-root` wrote (it may hold the user's edits), `<doc>-analysis/`
   exists and is not a checkout, or the full layout's `CLAUDE.md` cannot be fetched. A
   `CLAUDE.md` still as setup filled it, from any version of the writing-only text, counts
   as unedited. Then it creates
   the analysis repo and runs its `init.py` with `DOC_REPO` = the writing member, and at
   the root:
   - `workspace.toml`: `layout = "full"`, the analysis keys, and `extras` gaining `dev`,
     `notebooks` and the backend (an existing `publish` is kept);
   - `pyproject.toml`: the full layout's, listing the member (`publish` passes through
     to the analysis repo's extra, the full layout's way to install doc-publish);
   - the `.gitignore` member block: both members. Lines outside the block are kept;
   - `CLAUDE.md`: swapped for the full layout's text, filled in — but only if it is
     still exactly the filled writing-only text. If it was edited, it is kept and the
     script says so: merge the full text (the link it prints) in by hand **with the user**,
     keeping their additions.
   - A root `.env` (from `publish-root`) is kept. doc-publish now runs from
     `<doc>-analysis/` and reads `<doc>-analysis/.env`: move anything other than
     `DOC_REPO` there (a Notion token, say), then delete the root one. Ask first.
3. **Document checks** — the script ends with them. A writing-only document may never have
   needed `Sections/<Name>/Figures/` (#3):
   - `no Sections/ yet` → `/project-workspace:adapt-existing-document` moves the first section in before
     any figure can land; the §7 root proof waits for it.
   - `Sections/<Name>/Figures/ is not in \graphicspath` → add the entry, per
     `/project-workspace:adapt-existing-document` step 3, for each section that will get figures. Ignore it
     for sections that never will.
4. **§6 and §7 as for the full layout.** `SETUP sync`, the plotly check and the tests.
   Then the proof: if `Sections/Example/` is still in the writing repo, as for `fresh`;
   otherwise the root proof with `document_repo()` once `Sections/` exists, and
   `/project-workspace:adapt-existing-document` step 5 (one generated figure into a real section).
5. **§8** for an existing analysis project (question 10), then **§10**: an initial commit
   in the new analysis repo, and at the root `CLAUDE.md`, `.gitignore`, `pyproject.toml`,
   `uv.lock`, `workspace.toml`. Ask before each commit and push.

Re-running `add-analysis` is safe: on a workspace it already moved it reuses the repo and
checkout and redoes only what is missing.
