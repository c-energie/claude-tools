# project-workspace

Setup and workflow skills for a **document workspace** — the shell repo made from
[`c-energie/project-workspace-template`](https://github.com/c-energie/project-workspace-template) that
holds a LaTeX writing repo (from `writing-template`) and an analysis repo (from
`analysis-template`) side by side, with one uv venv and a figure pipeline from notebooks into the
document.

Install from the `c-energie` catalog: `project-workspace@c-energie`. You rarely do that by hand:
the three templates commit a `.claude/settings.json` that registers the catalog and enables this
plugin, with auto-update on, so it loads as soon as you trust a workspace made from them.

| Skill | What it does |
| --- | --- |
| `setup-project-workspace` | First-run setup: create the writing repo (and, unless writing-only, the analysis repo) from the templates or adopt an Overleaf project, write the root `pyproject.toml`/`workspace.toml`, sync, prove the pipeline. Later: add the analysis repo to a writing-only workspace |
| `adapt-existing-document` | Bring an existing document into the `Sections/` / `\graphicspath` / label conventions, one section at a time |
| `adapt-existing-analysis` | Copy an existing analysis project's notebooks in — the source stays untouched — and retrofit each with the `save_fig`/`save_table` setup |
| `setup-doc-publish` | Optional: install `doc-publish` for a corpus, Notion wiki or Quarto site |
| `setup-observer` | Step 0 of the four above: baseline the machine, log every place the guide and reality disagree, and with consent file redacted issues or PRs on the repo that owns each problem |

Invoke them by their full names, e.g. `/project-workspace:setup-project-workspace`.

## Why a plugin and not copies in the template

Until 2026-10-11 these skills lived in `doc-workspace-template/.claude/skills/`. A template is
copied once, at "Use this template", so every workspace kept the skills it was stamped with: a fix
filed by `setup-observer` reached new workspaces only, never the people who had hit the bug. A
plugin is versioned and updated in place.

## Layout

```
plugins/project-workspace/
  .claude-plugin/plugin.json
  skills/
    setup-project-workspace/
      SKILL.md
      setup_workspace.py           the step script: check, workspace, writing, analysis, root, ...
      test_setup_workspace.py
      CLAUDE.writing-only.md       the workspace CLAUDE.md for the writing-only layout
    adapt-existing-document/SKILL.md
    adapt-existing-analysis/
      SKILL.md
      copy_analysis.py             plan / copy / verify; never writes to the source
      test_copy_analysis.py
    setup-doc-publish/SKILL.md
    setup-observer/
      SKILL.md                     verbatim copy of plugins/skills/assets/setup-observer/
      observe.py                   verbatim copy, ditto
      observer.toml                this plugin's owners, env vars and state files
```

## Tests

From the marketplace root:

```bash
uv run --no-project --python 3.12 -m unittest discover -s plugins/project-workspace/skills/setup-project-workspace
uv run --no-project --python 3.12 -m unittest discover -s plugins/project-workspace/skills/adapt-existing-analysis
```

## Moving an existing workspace onto the plugin

A workspace made before 2026-10-11 still carries its own copies in `.claude/skills/`. In the
workspace root:

1. Add `.claude/settings.json` — copy it from
   [`project-workspace-template`](https://github.com/c-energie/project-workspace-template/blob/main/.claude/settings.json),
   or merge its two keys into the one you have.
2. Delete the five old skill directories: `setup-doc-workspace`, `adapt-existing-document`,
   `adapt-existing-analysis`, `setup-doc-publish`, `setup-observer` under `.claude/skills/`.
   Left in place, both copies show up and the old one never gets fixes.
3. In `CLAUDE.md`, change `/setup-doc-workspace`-style names to `/project-workspace:...` and the
   `.claude/skills/setup-doc-workspace/setup_workspace.py sync` line to the `uv sync --extra ...`
   form the template now uses.
4. Commit, restart Claude Code in the workspace and accept the trust prompt. `/plugin` should list
   `project-workspace@c-energie` as enabled.

`setup_workspace.py` still reads the old copy's history in such a workspace, so a `CLAUDE.md` filled
from an earlier writing-only template is not mistaken for a hand-edited one.
