---
name: adapt-existing-analysis
description: Copy an existing analysis project's notebooks into a document's analysis repo, placed by document section, and retrofit each with the save_fig/save_table setup. Use after add-analysis names an existing analysis, or when asked to bring old notebooks in.
---

# Adapt an existing analysis project

**First, invoke `/project-workspace:setup-observer`** (once per session): it records where this guide and
reality disagree, so the maintainer can fix the guide.

## The source is read-only

The existing project is **copied, never modified.** Every file in it stays exactly where
and as it is; all work happens on the copies inside `<analysis_dir>/`.

- Files reach the analysis repo only through `COPY copy`, which only reads the source.
- In the source, only read files and run `git --no-optional-locks` `log`, `show`,
  `ls-files` or `status`.
- Run notebooks only as copies, and only after step 4.1 has pointed every write at the
  analysis repo.
- `COPY verify` re-hashes the source and re-lists every file in it, ignored ones included.
  It must print `OK` at the end of every step below. On `FAIL`, stop and show the user what
  changed.

## Setup

Find the document: `uv run --no-project --python 3.12 "${CLAUDE_SKILL_DIR}/../setup-project-workspace/setup_workspace.py" --root "${CLAUDE_PROJECT_DIR}" document`
prints it as JSON — the one this session is inside, else the only one; with several it
lists them: ask, then pass `--document <name>` to it and to `COPY plan`. Below,
`<writing_dir>` is its `path` and `<analysis_dir>` its `analysis_path`. A null
`analysis_path` means the document has no analysis repo to copy into: stop, and offer
`/project-workspace:add-analysis` first.
Read `<analysis_dir>/AGENTS.md`: it is the authority on the saver conventions.

```bash
uv run --no-project --python 3.12 "${CLAUDE_SKILL_DIR}/copy_analysis.py" --root "${CLAUDE_PROJECT_DIR}" <step>
```

Abbreviated `COPY <step>`. The plan lives in `.setup/analysis-import/plan.json`
(gitignored). To re-plan from scratch, delete `.setup/analysis-import/` and any
`.setup/analysis-source/` clone: both are scaffolding, never the original.

Sections are named after the document's `Sections/` tree, so adapt the document first
(`/project-workspace:adapt-existing-document`), at least for the sections these notebooks feed. A notebook
whose section does not exist yet goes to `notebooks/unsorted/`.

## 1. Inventory

Ask where the existing project is: a local path, or `OWNER/NAME` (cloned into
`.setup/analysis-source/`). Then `COPY plan --source <it> [--document <name>]`.

**Only part of a larger project?** Ask which notebooks or folders (add-analysis question 6
may already have the answer), and pass each as `--include <glob>`, repeated:
`COPY plan --source <it> --include 'results/**' --include 'notebooks/2024-*.ipynb'`.
Globs are relative to the source, with `/` separators; `*` stays within one folder, `**`
spans folders, and naming a folder (`results`) takes everything in it. Quote each glob so
the shell does not expand it. Without `--include`, every file gets a default `dest` below,
so a subset import would mean nulling the rest of the project in `plan.json` by hand.

The plan gives every file a default `dest`: notebooks → `notebooks/unsorted/`, other files
→ `imported/`, `.env*` files and files over 1 MB → `null` (skipped). With `--include`, a file
matching no glob is `null` too, with `"why": "not included"`; it is still inventoried and
hashed, so `verify` still proves the whole source untouched. `plan` prints the included and
excluded counts and warns about a glob that matched nothing — re-plan if that was a typo.

A source that began as a fork of analysis-template carries its own `doc_analysis`
(`src/doc_analysis/` or a top-level `doc_analysis/`). Those files are always `null`, with
`"why": "the template provides doc_analysis"`, even if a glob includes them: the analysis
repo already has one, and an older copy beside it collides by name. They stay hashed for
`verify`. `plan` then warns about every `import doc_analysis.<x>` / `from doc_analysis.<x>`
in a file planned for copying where the template's `doc_analysis` has no `<x>` — a
**fork-only module** the copy will fail to import. Keep the list for step 4.
It also lists the document's sections.

**Interpreter range.** The source may pin its own Python: `plan` prints its
`requires-python` and `.python-version` (also saved as `source_python` in `plan.json`) and
checks the analysis repo's `.python-version` against the range — or, when the source
declares no range, against the minor its `.python-version` names. The analysis repo's venv
is built on that pin, so a stack whose range excludes it will not install. If `plan` warns
that the pin is outside the range, or could not check it, or there is no `.python-version`:

1. Pick a version inside the source's `requires-python`, preferring its `.python-version`.
   Confirm it with the user.
2. In `<analysis_dir>/`, `uv python pin <version>`, then re-sync:
   `uv run --no-project --python 3.12 "${CLAUDE_SKILL_DIR}/../setup-project-workspace/setup_workspace.py" --root "${CLAUDE_PROJECT_DIR}" sync --document <name>`
   (it passes every extra the document records; a bare `uv sync` removes the others).
   Commit the new `.python-version` in the analysis repo (ask).
3. Do this **before** step 3: the copies' dependencies go into the re-pinned venv.

Done when `plan` printed `Inventoried N file(s) in <the path given>`, with `--include`
every glob matched, and the analysis repo's pin fits the source's `requires-python` (or the
source declares none).

## 2. Placement

Set the `dest` of each notebook and helper in `plan.json`, with the user. Each notebook
goes to `notebooks/<Section path>/<name>.ipynb`, mirroring `<writing_dir>/Sections/`.

1. **Gather evidence per notebook**: the figure files it saves (`savefig`, `write_image`)
   and which `Sections/*/Figures/` already holds a file of that name; its headings; any
   section named in it. A figure already in the document is the strongest evidence.
2. **Propose a table**: notebook → section → evidence. Ask the user about every notebook
   whose evidence is missing or points at two sections, a few at a time. A notebook the
   user cannot place yet stays in `notebooks/unsorted/`.
3. **Helper code** the notebooks import: small modules go in `notebooks/` itself,
   not a section folder: the setup cell's `notebook_setup()` puts that directory on
   `sys.path`, so they import from a notebook in any section. A package goes
   in through the plan too (`dest: packages/<name>/...`) and becomes an extra pointing at
   that copy — see `<analysis_dir>/AGENTS.md` on keeping it out of `src/`.
   Never give the source's own `doc_analysis` a `dest`, under `src/` or anywhere else.
4. **Large files, data, secrets and files not included** stay `null` unless the user
   names one to copy.
5. Read back the final table and get an explicit yes.

Done when every notebook `dest` outside `notebooks/unsorted/` matches the table the user
said yes to, and the user has named each notebook left in `unsorted/`.

## 3. Copy

`COPY copy`, then `COPY verify`. Done when copy reports no conflicts and verify prints `OK`.
A conflict means the `dest` already holds different content: agree a different `dest`
with the user and re-run `copy`.

## 4. Retrofit, one notebook at a time

For each placed notebook (`notebooks/unsorted/` ones wait until they have a section):

1. **Point every write at the analysis repo.** Find each path in the copy that resolves
   into the source (absolute paths, and relative ones from the source's old working
   directory). Reads may stay. Anything written there — caches, `to_csv`, pickles,
   `open(..., "w")` — goes under `<analysis_dir>/` instead.
2. From `<analysis_dir>/`:
   `uv run notebook-skeleton retrofit <notebook> --section <Section path>`.
   It inserts the template's setup cell (`SECTION`, `NOTEBOOK`, `TEX`, `save_fig`,
   `save_table`) and lists the lines outside it still saving the old way.
3. Convert each listed line:

   | Listed | Becomes |
   |---|---|
   | `figure save` — `plt.savefig(...)`, `fig.write_image(...)` | `save_fig(fig, "<figure>.png", caption=..., label="<figure>")` |
   | `html export` — `fig.write_html(...)` | removed: `save_fig` writes the interactive export |
   | `table export` — `df.to_latex(...)` written to a file | `save_table(df, "<table>", caption=...)` |
   | `path hack` — `os.chdir`, `sys.path.append` | removed: `notebook_setup()` in the setup cell does this |

   `<figure>` is the **existing filename** when the document already has that figure, so
   it is regenerated in place. Remove the notebook's own save helpers and `SAVE = ...`
   flags; `figures_config.toml` decides now. Pin each figure's size as `AGENTS.md` says;
   for a committed PNG, inches = its pixels ÷ `PRINT_DPI` (in `doc_analysis/style.py`).
4. Run it from `<analysis_dir>/`:
   `uv run jupyter nbconvert --to notebook --execute <notebook> --output-dir <workspace>/.setup/<document dir>/executed --ExecutePreprocessor.timeout=1800`.
   - The executed copy goes to the workspace's `.setup/<document dir>/executed/`, never back
     over the notebook: `--output <notebook file name>` wrote megabytes of output into the
     tracked copy (#10). The command is the same in bash and PowerShell; the kernel still
     runs in the notebook's own directory. The copy is overwritten by the next notebook of
     the same name, and is there only to read a traceback from.
   - The timeout is **per cell**. 1800 s suits imported notebooks, some of which take
     around 10 minutes; raise it for a cell known to run longer.
   - **One notebook at a time, and in the background** when it may outrun the shell's
     foreground limit (e.g. a coding agent's 600 s): wait for it to exit before starting the
     next. A 10-minute notebook was killed at that limit, and another by the OS for low
     memory — two at once would only make that likelier.
5. Done when the notebook runs clean, each converted figure is in
   `<writing_dir>/Sections/<Section>/Figures/` (report the document repo's `git status`),
   the notebook in `notebooks/` holds no output from this run (only `.setup/` does), and
   `COPY verify` prints `OK`. Then the next notebook.

### Source already on an older `doc_analysis`

A notebook from a fork of analysis-template already calls `notebook_savers`, but with the
fork's signature, so the table above does not apply to it. Retrofit does not rewrite such a
call, by decision: forks differ, and the old `section=` cannot be rewritten without a person
deciding what it meant. Fix each call by hand:

- **Find them.** Until [analysis-template#6](https://github.com/c-energie/analysis-template/issues/6)
  is in the installed `doc_analysis`, retrofit says "already calls notebook_savers; nothing
  to graft" and the notebook then fails at its setup cell. After it, retrofit lists each
  incompatibility with its cell and line and exits non-zero. Until then, search each
  notebook for `notebook_savers(`, `save_value(` and `label=` yourself.
- **`chapter=X` → `section=X`.** `chapter=` still works but is deprecated.
- **Trap: `section=` changed meaning.** In older forks `section=Y` named the
  `figures_config.toml` table; that is now `config_section=Y`. Nothing detects it at run
  time — figures just land in the wrong section, or the wrong switches apply. Check every
  `section=` in an old call and ask the user what it meant when the value is not a
  `Sections/` path.
- **`values=True` and `save_value(...)`.** Once
  [analysis-template#9](https://github.com/c-energie/analysis-template/issues/9) is in the
  installed `doc_analysis`, they work unchanged: the call returns three savers. Each section
  with values then needs `\InputIfFileExists{Sections/<Name>/values.tex}{}{}` in the document
  ([writing-template#5](https://github.com/c-energie/writing-template/issues/5)); `save_value`
  warns with the exact line when it is missing. **Until analysis-template#9:** drop
  `values=True`, unpack two savers, and replace each `save_value(value, "<name>", ...)` with
  `print(...)` of the value, so the number stays visible in the output for the user to copy
  into the prose by hand. Tell the user which values these were.
- **`label=`** that is not the figure or table stem is replaced by the stem: labels mirror
  filenames, and a free-text label makes re-running append a second block.
- **Fork-only modules** that `plan` warned about (a helper importing `doc_analysis.values`,
  say): port the module into the private helper package (the extra from step 2.3), or, if it
  belongs in the template, ask the user to raise an issue on analysis-template. Never copy
  the fork's `doc_analysis` to get it back. A helper importing a module the template does
  have (`doc_analysis.env`) needs nothing.

## 5. Finish

1. From `<analysis_dir>/`: `uv run check-figure-parity --snapshot`.
2. Ask before each commit and push, in the analysis repo and then the document repo.
3. Tell the user which notebooks are still in `notebooks/unsorted/` and which files were
   left in the source (`dest: null`).
4. Last `COPY verify`. Once it prints `OK` and nothing is left in `unsorted/`,
   `.setup/analysis-import/`, `.setup/<document dir>/executed/` and any
   `.setup/analysis-source/` clone can be deleted.
