# Project workspaces: documents are nested, one venv per analysis repo

A project workspace holds several documents, so the old layout — document repo and analysis repo as siblings at the workspace root, the analysis repo a uv member of a root `pyproject.toml` sharing one root `.venv` — no longer fits: every analysis repo ships the import package `doc_analysis`, so two of them cannot share a venv, and N sibling pairs at one root say nothing about which belongs to which. We decided each document is its document repo with its analysis repo nested inside it (`writing-hosts-analysis`, made by writing-template's `setup-nested.sh`), each analysis repo owns its venv, and the project workspace root has no Python at all — `workspace.toml` lists documents and nothing about their analysis, which lives in each document's `layout.toml`.

## Considered Options

- **Sibling pairs, one root venv**: rejected — the `doc_analysis` collision caps a workspace at one analysis repo.
- **Sibling pairs, a venv per pair**: workable, but a document would not travel on its own, and `DOC_REPO` would still need a per-machine `.env`; nesting derives it from the committed `layout.toml`.
- **Reimplementing nesting in the plugin**: rejected — `setup-nested.sh` is already committed in every document repo and restores a fresh clone; two implementations would drift.

## Consequences

- Existing schema-1 workspaces need the `migrate` step; it moves the analysis checkout into the document repo but never renames a repo or a document directory.
- doc-publish for a document without an analysis repo runs through `uvx`, since there is no root venv to install it into.
- `project-workspace-template` is retired: the plugin, installed by the user, writes the workspace files itself, and the workspace being a git repo is optional.
