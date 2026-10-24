# project-workspace

Setup and workflow skills for a **project workspace** — a folder holding several LaTeX
**documents**, each a document repo (from
[`writing-template`](https://github.com/c-energie/writing-template), or an Overleaf project)
with, optionally, an analysis repo (from `analysis-template`) nested inside it, its own venv
and a figure pipeline from its notebooks into that document:

```
my-phd/                     .claude/workspace.json + CLAUDE.md; optionally a git repo
|-- thesis/                 document repo
|   `-- thesis-analysis/    its nested analysis repo (layout.toml), with .venv/
`-- paper/                  another document, writing only
```

Install it yourself from the `c-energie` catalog — `/plugin marketplace add c-energie/claude-tools`,
then `/plugin install project-workspace@c-energie` — and run
`/project-workspace:setup-project-workspace` in an empty folder: it creates the rest.
`writing-template` and `analysis-template` also commit a `.claude/settings.json` enabling it,
so a collaborator who clones just one document repo gets it too.

| Skill | What it does |
| --- | --- |
| `setup-project-workspace` | Make a folder a project workspace (`.claude/workspace.json`, `CLAUDE.md`, optionally its own git repo); convert a `workspace.toml` into `workspace.json` — schema 2, or the schema-1 workspace made from the retired `project-workspace-template` |
| `add-document` | Add a document: new from writing-template, an adopted Overleaf project, or an import (LaTeX, Word, Markdown); prove it builds |
| `add-analysis` | Nest an analysis repo in one document through its `setup-nested.sh` — create, adopt or restore — and prove a figure lands |
| `adapt-existing-document` | Bring an existing document into the `Sections/` / `\graphicspath` / label conventions, one section at a time |
| `adapt-existing-analysis` | Copy an existing analysis project's notebooks into a document's analysis repo — the source stays untouched — and retrofit each with the `save_fig`/`save_table` setup |
| `setup-doc-publish` | Optional, per document: `doc-publish` for a corpus, Notion wiki or Quarto site |
| `setup-observer` | Step 0 of the setup skills: baseline the machine, log every place the guide and reality disagree, and with consent file redacted issues or PRs on the repo that owns each problem |

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
      setup_workspace.py           the step script every skill shares: check, init, track,
                                   add-document, add-analysis, document, sync, migrate
      test_setup_workspace.py
      fixtures/                    workspace.toml files the conversion is tested against
      CLAUDE.workspace.md          the workspace CLAUDE.md init writes
    add-document/SKILL.md
    add-analysis/SKILL.md
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

## The manifest: `.claude/workspace.json`

Since ADR 0002 ([`docs/adr/0002-workspace-replaces-context-repo.md`](../../docs/adr/0002-workspace-replaces-context-repo.md))
a workspace is marked and described by `.claude/workspace.json`, shared with the context
plugins. This plugin writes only `schema`, `name`, `repo` and `members`:

```json
{
  "schema": 1,
  "name": "my-phd",
  "repo": "me/my-phd",
  "members": [
    { "dir": "thesis", "repo": "me/thesis", "kind": "document", "name": "thesis", "extras": ["dev", "notebooks", "plotly"] },
    { "dir": "thesis/thesis-analysis", "repo": "me/thesis-analysis", "kind": "analysis", "documents": ["thesis"] },
    { "dir": "paper", "repo": "me/paper", "kind": "document", "name": "paper" }
  ]
}
```

A workspace still described by a schema-2 `workspace.toml` is converted by
`/project-workspace:setup-project-workspace` (`migrate`, dry run first); until then every other
step refuses and says so.

## Migrating a workspace made from project-workspace-template

Before 2026-10-12 a workspace held exactly one document, with its analysis repo beside it
(`<doc>-writing/`, `<doc>-analysis/`), a root `pyproject.toml` and one root `.venv`; its
`workspace.toml` has a `[workspace]` table and no `schema` key. Run
`/project-workspace:setup-project-workspace` in it: it offers `migrate`, which nests the
analysis repo inside the document repo (repairing its linked git worktrees), gives it its own
venv, writes `.claude/workspace.json`, and backs up whatever it removes from the root to
`.setup/migrate-backup/`. A root `pyproject.toml` that other things depend on stops it rather
than being deleted. The decision is
[`docs/adr/0001-project-workspace-nested-documents.md`](../../docs/adr/0001-project-workspace-nested-documents.md).

A workspace older still, carrying its own skill copies in `.claude/skills/`, deletes those five
directories (`setup-doc-workspace`, `adapt-existing-document`, `adapt-existing-analysis`,
`setup-doc-publish`, `setup-observer`) first: left in place, both copies show up and the old one
never gets fixes.
