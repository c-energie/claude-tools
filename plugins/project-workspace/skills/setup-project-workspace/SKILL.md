---
name: setup-project-workspace
description: Make a folder a project workspace — .claude/workspace.json and CLAUDE.md, optionally its own git repo with an allowlist .gitignore — then hand off to add-document; adopt an existing folder of clones that has no manifest; add a code repo as a member; restore every member on a fresh clone; or migrate a workspace still described by workspace.toml (schema 2, or the single-document schema 1) into workspace.json. Use when the user asks to set up a project workspace, start a thesis or paper workspace, turn a folder of repos into a workspace, add a code repo to the workspace, restore or re-clone the workspace on another machine, track the workspace in git, convert or migrate workspace.toml, or migrate a workspace made from project-workspace-template.
---

# Set up a project workspace

**First, invoke `/project-workspace:setup-observer`** (once per session): it records where this
guide and reality disagree, so the maintainer can fix the guide.

A **project workspace** is a folder listing its **members** in `.claude/workspace.json`.
Each **document** is a document repo with, optionally, an analysis repo nested inside it:

```
<workspace>/
|-- .claude/workspace.json  schema 1; name, repo, one members entry per repo
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

Look at the root:

- **`.claude/workspace.json` with `members`** → already set up. Say what it lists
  (`SETUP document --all`), offer `track` if `.git` is missing, and otherwise route: a new
  document → add-document, analysis for one → add-analysis, a code repo →
  [Adding a code repo](#adding-a-code-repo). Members listed but missing on disk (a fresh
  clone of the root) → [Restoring the members](#restoring-the-members). A `workspace.toml` still beside it
  is a leftover: `SETUP migrate` says so, and it is deleted by hand once compared.
- **`workspace.toml` with `schema = 2`** (and no `workspace.json`, or one without `members`) →
  [Converting workspace.toml](#converting-workspacetoml). Every other step refuses until then.
- **`workspace.toml` with `[workspace]` and no `schema`** → made from
  `project-workspace-template`, one document with its repos side by side:
  [Migrating](#migrating) instead.
- **Neither, but subdirectories that are git checkouts** → a folder of clones built by hand:
  [Adopting a folder of clones](#adopting-a-folder-of-clones).
- **Neither** → a new workspace: §1 onwards.
- **A malformed `workspace.json`** → every step stops naming the file and the parse error.
  Fix it by hand with the user: other plugins own keys in it, so nothing rewrites it whole.

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
   root files and the workspace's own folders only, ignoring every member — what it buys is
   restoring the set of members on a second machine (`restore`). If yes: **a GitHub repo for
   it?** owner (default the `gh` login), name (default the workspace name; for an **org
   root** — a folder named for the GitHub org its members belong to, as `~/c-energie` —
   `[org]/workspace`, which `track` and `adopt` print), visibility (default private). Confirm
   before creating it: it is outward-facing.

## 3. Make it

```bash
SETUP init --name <name>
SETUP track [--repo <owner>/<name> --visibility private]     # only on a yes
```

`init` writes `.claude/workspace.json` (`schema: 1`, the name, no members yet) and `CLAUDE.md`
from `CLAUDE.workspace.md` beside this file. A `workspace.json` already there (setup-connectors
may have made one) keeps every key it has and gains only `schema`, `name` and `members`. A
`CLAUDE.md` already there is kept; only its documents table, between the
`<!-- documents ... -->` markers, is ever rewritten.

**`.gitignore`: `init` edits it too when the root is already a git repo**, and `adopt`,
`track`, `add-document`, `add-member` and `migrate` do whenever it is one, each saying so
(`.gitignore: rewriting the managed block ...`). The managed block is an **allowlist**: `/*/`
ignores every top-level directory, `!/.claude/`, `!/docs/`, `!/.context/`, `!/teaching/` (and
any folder the root already tracks files in) let the workspace's own back in, and every member
not nested in another is then named as well (`/<dir>/`). Root files are never ignored. So a
repo cloned in by hand, before `add-member` records it, can never be committed into the root.
A line the user already has outside the block is not repeated — the step prints
`note .gitignore already ...` instead. Everything outside the block is the user's and kept. `track` runs `git init` first; with `--repo` it creates the GitHub repo as `origin`
(and pushes if there are commits), and records it as `repo` in `workspace.json` (an existing
GitHub `origin` is recorded the same way).

## 4. Hand off

Ask: **add a document now?** On a yes, invoke **`/project-workspace:add-document`**; it
offers add-analysis at its end. On a no, say both skills can be run any time from this
folder.

If tracked, propose the first commit at the root — `.claude/workspace.json`, `CLAUDE.md`,
`.gitignore` — and ask before committing and before pushing.

## Adopting a folder of clones

A folder of checkouts with no manifest (built by hand, #33) is adopted as it stands: nothing
is cloned, moved or committed.

1. `SETUP adopt` proposes one member per immediate subdirectory that is a git checkout
   (hidden ones skipped), and **writes nothing**. Each member's `repo` is its `origin`
   (OWNER/NAME for GitHub; any other URL as it is); its `kind` comes from its content, never
   its name: a `layout.toml`, `Sections/` or a root-level `.tex` file is a `document`;
   analysis-template's `doc_analysis` package beside a `pyproject.toml` is an `analysis`
   repo (at the root, `documents: []`: it feeds no document); anything else is `code`. A
   document whose `layout.toml` names a nested analysis repo is followed by it as an
   `analysis` member feeding it. Walk the user through every line and every `note`.
2. A wrong kind is corrected with `--kind DIR=KIND` (repeatable); re-run until it is right.
3. On an explicit yes: `SETUP adopt --yes [--name <name>] [--kind ...]`. It writes
   `.claude/workspace.json` (merged into one setup-connectors made), `CLAUDE.md` if there is
   none, and in a tracked root the `.gitignore` block. Then §2's track question and §4.

**The side-by-side shape** (#33): one document checkout and an analysis checkout beside it,
which a root `pyproject.toml` makes a uv workspace member — a workspace from before
2026-10-12 that never had a `workspace.toml`. `adopt` records it as it is and says so; the
root `pyproject.toml`, `uv.lock` and `.venv` are untouched. Then offer the nesting
migration: `SETUP --dry-run migrate` shows the same plan as [Migrating](#migrating) (from
step 1 there; the root venv's extras are not recorded anywhere, so the analysis venv gets
`dev`, `notebooks` and the backend — add others with `SETUP sync --extra`), and its stop for
a load-bearing root `pyproject.toml` (#34) holds: that root is never deleted.

## Adding a code repo

A repo that is neither a document nor an analysis repo (a tool, a library, a model):

```bash
SETUP add-member --repo <owner>/<name> [--dir <dir>]
```

It clones the repo (`gh` for OWNER/NAME, `git` for any other URL or path) into `<dir>`
(default the repo's name) and records it as a `code` member. A repo already a member, or a
directory already a member's, is refused; a checkout already in `<dir>` is recorded only if
its `origin` is that repo. Documents go through `/project-workspace:add-document` and analysis
repos through `/project-workspace:add-analysis` instead: they do more than clone.

## Restoring the members

On a fresh clone of a tracked workspace root, `members` lists repos that are not on disk:

```bash
SETUP --dry-run restore     # the plan
SETUP restore
```

It clones every member missing on disk — parents first — and leaves every one present
untouched. An analysis repo nested in a document is restored by that document's own
`setup-nested.sh` (as add-analysis restores it, venv included), never cloned here. A
workspace analysis (one in no document) is cloned and its venv synced with the extras its
member records; with none recorded, its venv is left for `SETUP sync --analysis <dir>
--extra ...`. A member with no `repo`, or a non-checkout folder in its place, is listed as
not restored (exit 1). Then prove each analysis repo as add-analysis §4 (§6 for a workspace
analysis) does.

## Converting workspace.toml

A schema-2 `workspace.toml` lists `[[document]]`s; `.claude/workspace.json` replaced it
(ADR 0002). Converting moves nothing and touches nothing at the root but the two manifests,
`CLAUDE.md`'s documents table and the `.gitignore` members block — a root `pyproject.toml`
is never removed.

1. Show the plan: `SETUP --dry-run migrate`. It prints every line it will act on and the
   whole `workspace.json` it will write. Walk the user through it: every document is there
   with its `name`, `repo` and `extras` (and any other key it had); each document hosting an
   analysis repo (its `layout.toml` says so) is followed by an `analysis` member feeding it;
   a top-level `workspace.toml` key with no place in `workspace.json` is listed as not carried
   over. A document not on disk has its nested analysis recorded only once `add-analysis`
   restores it.
2. On an explicit yes: `SETUP migrate`. It writes `workspace.json` first, then backs up
   `workspace.toml` to `.setup/migrate-backup/` and removes it.
3. If `CLAUDE.md` still names `workspace.toml` outside its table (the plan says so), that text
   is the user's: offer to update it, with them.
4. If tracked, propose the commit at the root — `.claude/workspace.json`, the removal of
   `workspace.toml`, `CLAUDE.md`, `.gitignore` — asking before committing and pushing. Delete
   the backup once the user is satisfied.

A `workspace.json` that already lists `members` next to a `workspace.toml` is refused, not
merged: compare the two with the user and delete the TOML by hand.

## Migrating

A schema-1 workspace has one document: `<doc>-writing/` and, in the `full` layout,
`<doc>-analysis/` beside it, a root `pyproject.toml` making the analysis repo a uv member,
and one root `.venv`. Migrating nests the analysis repo inside the document repo
(`writing-hosts-analysis`), gives it its own venv, and leaves no Python at the root. It never
renames a repo or a document directory: Overleaf's sync and IDE configs point at them.

1. `SETUP check --analysis`, then show the plan: `SETUP --dry-run migrate`. Walk the user
   through every line. Stops it reports (a target taken, an analysis repo with no `origin`)
   are fixed first. One stop is not a fix but a different route: a root `pyproject.toml`
   that is load-bearing beyond the analysis repo — other uv workspace members, sources from
   outside, extras of its own — is never deleted (#34). Then nest by hand, as the stop says,
   and repoint the root's member path.
2. Ask them to **close Jupyter, IDEs and terminals inside the analysis repo and the root
   `.venv`**: Windows will not move or delete an open directory.
3. On an explicit yes: `SETUP migrate`. First, before anything moves, it adds or updates the
   document repo's `setup-nested.sh` from writing-template if it is missing or predates
   in-place `--dir` (a `gh` failure there stops it with nothing changed). It then moves the
   analysis checkout in (its `.env` travels unchanged: the document repo has not moved, so a
   `DOC_REPO` there is still right), runs `git worktree repair` for every linked worktree the
   analysis repo had (the move leaves their links naming the old path, #35), runs
   `setup-nested.sh --dir <analysis>`, syncs the new venv with the old `extras`, and backs up
   `pyproject.toml`, `uv.lock`, `.python-version`, `workspace.toml` and `CLAUDE.md` to
   `.setup/migrate-backup/` before replacing or removing them. It writes
   `.claude/workspace.json` with the document and its analysis repo as members.
4. Merge anything of the user's from `.setup/migrate-backup/CLAUDE.md` into the new
   `CLAUDE.md`, with them. Then delete the backups.
5. Re-point anything at the old venv: the IDE interpreter and notebook kernel are now
   `<doc>-writing/<doc>-analysis/.venv`. Prove it as add-analysis §4 does.
6. Commits, asking before each: in the document repo, `layout.toml`, `.gitignore`,
   `setup-nested.sh`/`.gitattributes` if added; in the analysis repo, `.python-version`; at
   the root (if tracked), `.claude/workspace.json`, `CLAUDE.md`, `.gitignore` and the removals
   (`workspace.toml` among them).

A migrate that stops before `workspace.json` is written is resumed by re-running it. One
that stops after (in `setup-nested.sh` or the sync) is finished with
`SETUP add-analysis --dir <analysis> --backend <backend>` and `SETUP sync --document <name>`; `SETUP migrate`
then lists the root leftovers to back up and delete.

Not this skill: a document → `/project-workspace:add-document`; an analysis repo →
`/project-workspace:add-analysis`; publishing → `/project-workspace:setup-doc-publish`.
