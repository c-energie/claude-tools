---
name: setup-diagram-store
description: Connect a project to its org's diagram store — create or adopt the private store repo, name it in .diagrams.json or context.json, prove a save and a gallery build. Use when diagram-store.mjs where finds no store named or the store not cloned, or the user asks to set up a diagram store.
---

# Set up a diagram store

**First, invoke `/diagrams:setup-observer`** (once per session): it records where this guide and
reality disagree, so the maintainer can fix the guide.

Read `diagrams-config` for the contract: the three rungs that can name a store, why there is no
default, and the org-boundary check. This skill ends with the store named on one rung and
cloned:

```
<project repo>/.diagrams.json   { "repo": "acme-co/diagrams" }     ← or context.json state.diagrams (a workspace.json: by hand, for now)
~/acme-co/diagrams/             the store checkout (private repo)
|-- README.md  .gitattributes  .gitignore
|-- index.jsonl                 empty, append-only
`-- taxonomy.json               only if the user asked for a starter
```

All mechanical work is done by one script:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-diagram-store.mjs" --root "${CLAUDE_PROJECT_DIR}" <step> [flags]
```

Abbreviated `SETUP <step>`. Every step is safe to re-run and ends on one line: `OK …` when its
criterion holds; `REFUSED: …` (exit 2), a guardrail — relay the message to the user and stop;
`FAILED: …` (exit 1) — fix the cause and re-run. `--dry-run` (before the step) prints every write
and command and performs none; `check` and `prove` only read, so it changes nothing for them.

## 1. Where things stand

```bash
SETUP check
```

Exit 0 needs git, gh, node and a `gh` login (`gh auth login` if not; open a new terminal after
installing anything). Act on its last line:

- **`STATE set-up`** → run `SETUP prove` and stop.
- **`STATE named-not-cloned`** → §2 questions 1–3 only, then §3 (`adopt`, or `local` with `--dir`).
- **`STATE named-refused`** → a config names a store the resolver refuses (another org without
  `crossOrg`, a malformed `repo`). Show the user the message; the fix is a hand edit with them.
- **`STATE unnamed`** → a new setup: §2.

A `NOTE DIAGRAMS_STORE=…` line means that env var is set for this shell. It overrides any config
and does not count as a setup: ask the user to unset it before §3.

## 2. Interview

Ask a few at a time; defaults in brackets.

1. **Store repo** [`check`'s `suggestion`, e.g. `acme-co/diagrams`]. A suggestion, never an
   assumption: confirm it. One store per org.
2. **Mode** — from `check`'s suggestion line:

   | Answer | Mode | Effect |
   |---|---|---|
   | The store exists on GitHub | `adopt` | clone it |
   | It does not exist yet | `fresh` | create it **private**, then stamp and push |
   | It is already cloned on this machine | `local` | check the checkout's origin; nothing else |

3. **Checkout directory** [`~/[owner]/[repo]`]. Another place is `--dir` on `store`, `stamp` and
   `push-store`, **plus** `DIAGRAM_STORE_DIR` set permanently on this machine — the config is
   shared and never records a path, so every later session finds the checkout through that
   variable. Set it before §4: Windows `setx DIAGRAM_STORE_DIR "<dir>"`, else an `export` line in
   the shell profile; then open a new terminal and restart Claude Code.
4. **Where to name it** — `check`'s `target` line. No context repo → `repo-file`. With one, ask:
   `repo-file` ties the store to this repo (committed with it, works without context-kit);
   `context` names it for the whole project. Recommend `repo-file` when unsure.
5. **Project name** (`repo-file` only) [the repo directory's name].
6. **A starter `taxonomy.json`?** [no] — absent honestly means "no vocabulary agreed yet".
7. **Cross-org** — only if the store's owner differs from `check`'s `origin` (or the context
   repo's owner). Explain that diagrams saved here become readable by that org, and ask. Only an
   explicit yes means `--cross-org`.

Read the whole plan back as a table — repo, mode, dir, target, project, taxonomy, cross-org, and
which steps are outward — and get an explicit yes before §3.

## 3. The store

```bash
SETUP --dry-run store --mode <mode> --repo <owner>/<repo> [--dir <dir>]
SETUP store --mode <mode> --repo <owner>/<repo> [--dir <dir>]
```

`fresh` creates a GitHub repo — outward; the plan's yes covered it. Done at
`OK <dir> is a checkout of <repo>`. Its refusals, each with the fix in the message:

- `--dir` is a checkout of another repo, a non-empty non-git directory, a git repo with commits
  and no origin, or inside the project or another work tree — pick another `--dir`.
- an empty git repo with no origin (a half-finished `fresh`) — delete it, re-run.
- `fresh` on a repo that exists — use `adopt`; `adopt` on one that does not — use `fresh`.
- the store is **public** — it should be private. Only on the user's explicit say-so, re-run
  with `--public-ok`.

If auto mode blocks `fresh`, the user runs these three lines, then re-runs `SETUP store` to verify:

```
! mkdir -p "<dir>"
! git init -b main "<dir>"
! gh repo create <owner>/<repo> --private --source "<dir>" --remote origin
```

Then, for `fresh` and for an adopted store missing its house files, ask before running:

```bash
SETUP stamp --dir <dir> [--taxonomy]
```

Writes only what is missing and commits only those files. Done at
`OK <dir> has README.md, .gitattributes, .gitignore, index.jsonl, committed`. A
`FAILED: not tracked by git: …` names house files that exist but are uncommitted (the user's own,
or gitignored): commit them with the user, re-run. Then ask before pushing:

```bash
SETUP push-store --dir <dir>
```

Done at `OK <dir> matches its upstream`. Fallback: `! git -C "<dir>" push -u origin HEAD`.

## 4. Name it

```bash
SETUP --dry-run config --target <repo-file|context> --repo <owner>/<repo> [--project <name>] [--cross-org]
SETUP config --target <repo-file|context> --repo <owner>/<repo> [--project <name>] [--cross-org]
```

Show the dry run's file content first. Done at `OK <root> resolves to <repo> via …, checkout
<dir>` — the file just written names the store and the checkout exists. Refusals: a config that
already names another repo, or names this one but cannot work (no `repo`, or cross-org without
`crossOrg`) — a hand edit, with the user; `repo-file` from a directory that is not its repo's root
(re-run with the `--root` it names); `context` with no context repo, a `.diagrams.json` that
would shadow it, or a context repo behind its remote (pull first); a cross-org store without
`--cross-org`; `DIAGRAMS_STORE` set. `FAILED: … no checkout at …` means `DIAGRAM_STORE_DIR` is
missing (§2 question 3).

Then, asking before each:

```bash
SETUP commit-config --target <target>     # commits that one file only
SETUP push-config --target <target>       # outward: pushes only that commit
```

Each prints `OK … <repo dir>`. `push-config` refuses when other commits are unpushed on the
branch — pushing would publish them too; that push is the user's to make. Fallback when auto mode
blocks it: `! git -C "<repo dir>" push`. If the user would rather commit `.diagrams.json` with
other work, skip both and say it is uncommitted.

## 5. Prove

```bash
SETUP prove
```

From the project root and from a subdirectory of it, runs `where`, a `save-diagram --dry-run` of
a probe SVG, and a gallery build to a temp file, and checks `index.jsonl` is unchanged. Done at
`OK <repo> resolves, saves (dry run) and builds from 2 working directories`. A `NOTE … one
working directory only` means the root has no subdirectory; say so.

Then tell the user `/diagrams:save-diagram` and `/diagrams:browse-diagrams` are ready.

**Not this skill:** saving a diagram is `save-diagram`; looking through the store is
`browse-diagrams`; a project with no context repo that wants one is
`context-kit-core:context-setup` or `init-context`.
