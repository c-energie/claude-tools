---
name: add-analysis
description: Nest an analysis repo (c-energie/analysis-template; notebooks and doc_analysis figure/table tooling) inside one document of a project workspace, with its own venv, and prove a generated figure lands in the document — or restore the analysis repo on a fresh clone. Use when the user asks to add analysis, generated figures or notebooks to a document, or when a document's layout.toml names an analysis directory that is missing.
---

# Add an analysis repo to a document

**First, invoke `/project-workspace:setup-observer`** (once per session).

The analysis repo is **nested inside its document repo**: a separate repo with its own
remote, gitignored by the document repo and recorded in its `layout.toml`
(`writing-hosts-analysis`). It has its own `.venv`. It finds the document from `layout.toml`,
so no `DOC_REPO` is set anywhere. The work is done by the document repo's own
`setup-nested.sh` (writing-template ships it; the step adds it if missing); this skill does
the interview, the proof and the hand-offs.

Prerequisite: `workspace.toml` with `schema = 2` listing the document. Otherwise →
`/project-workspace:setup-project-workspace`, then `/project-workspace:add-document`.

```bash
uv run --no-project --python 3.12 "${CLAUDE_SKILL_DIR}/../setup-project-workspace/setup_workspace.py" --root "${CLAUDE_PROJECT_DIR}" <step> [flags]
```

Abbreviated `SETUP <step>`; `--dry-run` goes before `<step>`. Never commit or push without
asking; confirm the one repo to be created (owner, name, visibility) before it is.

## 1. Which document, and which case

`SETUP document` prints the document this session acts on as JSON — the one the session is
inside, else the only one; with several, it lists them: ask, then pass `--document <name>`
everywhere below. Its `analysis_dir`:

- **null** → create or adopt: §2.
- **set, but `analysis_path` missing on disk** → a fresh clone: **restore** it with
  `SETUP add-analysis --document <name> [--backend matplotlib]` (no other flags; the backend
  only if it was matplotlib), then §3–§4.
- **set and present** → already done; offer §4's proof or `SETUP sync`.

`SETUP check --analysis` must pass (it adds `sh` — Git Bash's on Windows — and the analysis
template).

## 2. Interview

1. **New or existing analysis repo?** New → created from `analysis-template` as
   `<owner>/<document repo>-analysis`, owner defaulting to the document repo's GitHub owner.
   An existing repo whose notebooks feed *only this document* → adopted with `--from <url>`
   (cloned; the original untouched). A larger project only partly feeding it → still
   **new**, with question 6.
2. **Names** (new) — repo name (default `<document repo>-analysis`) and directory inside the
   document repo (default the same); visibility (default private).
3. **Plotting backend** — `plotly` (default, recommended: one figure object gives the PDF PNG
   *and* an interactive HTML for a wiki/site) or `matplotlib` (static PNG only, no
   headless-Chrome download).
4. **Distribution name** (new) — default `<document>-analysis`; lower-case, digits, dashes.
   The import package stays `doc_analysis` regardless. **Author** — the document's author.
5. **Python version** for its venv, written to the analysis repo's `.python-version`.
   Default `3.12`: many scientific packages have no wheels for the newest Python yet. If
   question 6 names a project, read its `requires-python` and `.python-version` first and
   offer that `.python-version`, else the newest minor its range allows, capped at 3.12. At
   least 3.11.4. For an adopted repo that already pins one, leave `--python` out.
6. **Existing analysis to bring in?** A project with notebooks that should feed this
   document, beyond an adopted repo: its local path or `OWNER/NAME`, or none. If only part of
   it feeds this document, ask **which notebooks or folders?** — paths relative to that
   project (a folder, or a glob such as `results/**`).

Read back a summary and get an explicit yes, then show the plan:
`SETUP --dry-run add-analysis --document <name> ...`.

## 3. Create it

```bash
SETUP add-analysis --document <name> --backend plotly --python 3.12 \
      --distribution <dist> --author "<author>" [--repo-name <n>] [--dir <d>] [--owner <o>] [--public]
SETUP add-analysis --document <name> --from <url> --backend plotly        # adopt
```

`setup-nested.sh` clones or creates the repo, gitignores it, writes `layout.toml`, writes
`.python-version`, runs the analysis repo's `init.py` with the answers, and runs `uv sync`
inside it. The step then records the document's `extras` (`dev`, `notebooks`, the backend)
in `workspace.toml` — `SETUP sync` passes them all, so a later sync never uninstalls one —
and reports **document checks**:

- `no Sections/ yet` → `/project-workspace:adapt-existing-document` moves the first section
  in before any figure can land; §4's proof waits for it.
- `Sections/<Name>/Figures/ is not in \graphicspath` → add the entry (adapt-existing-document
  step 3) for each section that will get figures.

Extras later (`marimo`, `publish`, …): `SETUP sync --document <name> --extra <x>`.

## 4. Prove the pipeline

All from the analysis repo, `<document>/<analysis>/`, unless said otherwise.

- **plotly only — Chrome for PNG export.** kaleido renders through Chrome. If none is
  installed, `uv run plotly_get_chrome` fetches one. Prove it as **its own command, with a
  time limit** (the shell tool's timeout, about 120 s):
  `uv run python -c "import plotly.express as px; px.scatter(x=[1],y=[1]).write_image('kaleido_check.png')"`,
  then delete `kaleido_check.png`. A first Chrome launch can stall (#13). If it does: re-run
  once with the limit; then the same `-c` with the venv interpreter directly
  (`.venv\Scripts\python.exe` / `.venv/bin/python`) — passing means the problem was uv, not
  Chrome; then `uv run plotly_get_chrome` and the check again. Tell setup-observer which.
- **Tests:** `uv run python -m pytest tests -q` (not `uv run pytest`: a Windows trampoline
  error).
- **The document is found.** `uv run python -c "import sys; from doc_analysis import notebook_setup, document_repo; notebook_setup(); print(sys.executable); print(document_repo())"`
  — expect this repo's `.venv` interpreter, then the document repo's absolute path. Run the
  same with that interpreter from the **document repo root** too: an IDE opening the
  document starts its kernel there. `document_repo()` raises `no Sections/ directory` for an
  adopted Overleaf document not yet adapted; that is expected — adapt-existing-document runs
  this proof once the first section is in.
- **A figure lands** (document still has `Sections/Example/`, plotly):
  `uv run jupyter nbconvert --to notebook --execute notebooks/example/example_figure.ipynb --output-dir <workspace>/.setup/<document dir>/executed --ExecutePreprocessor.timeout=600`.
  The executed copy goes to the workspace's `.setup/`, never back over the tracked notebook
  (#10); the per-cell timeout makes a hang fail instead of stalling. Expect a new
  `example_scatter.png` under `<document>/Sections/Example/Figures/` (no figure block is
  appended: `example.tex` already references it). Then `uv run check-figure-parity --snapshot`.
  On matplotlib, copy the README's matplotlib usage block into a scratch notebook instead.
  No `Sections/Example/` → adapt-existing-document step 5 does this against a real section.

  **Expected `git status`:** analysis repo — the `--snapshot` baseline, `.python-version`
  and `init.py`'s changes (a modified notebook means it ran in place: `git restore` it);
  document repo — `layout.toml`, `.gitignore`, `Sections/Example/Figures/example_scatter.png`
  and `Sections/Example/tables.tex` (#10). Anything else is a deviation to log.
- **Running notebooks:** walk the user through the analysis repo's README, "Running
  notebooks", for their editor — JupyterLab (`uv run jupyter lab`), VS Code, PyCharm or
  marimo. The kernel is **this analysis repo's venv**.

## 5. Bring existing analysis in, commit, finish

- Question 6 named a project → invoke **`/project-workspace:adapt-existing-analysis`** for
  this document, handing it the notebooks or folders named. It runs after the document has
  `Sections/`, because notebooks are placed by section.
- Commits, asking before each commit and push: in the **analysis repo**, its initial commit
  (`init.py`'s changes, `.python-version`, the baseline); in the **document repo**,
  `layout.toml`, `.gitignore` (and `setup-nested.sh`/`.gitattributes` if the step added
  them) and the example figure; at a tracked workspace root, `workspace.toml` and `CLAUDE.md`.
- Delete `.setup/<document dir>/executed/`.
- Offer **`/project-workspace:setup-doc-publish`** (corpus, Notion wiki, Quarto site).

Not this skill: a new document → `/project-workspace:add-document`; existing notebooks →
`/project-workspace:adapt-existing-analysis`; an old workspace with the analysis repo beside
the document → `/project-workspace:setup-project-workspace` (migrate).
