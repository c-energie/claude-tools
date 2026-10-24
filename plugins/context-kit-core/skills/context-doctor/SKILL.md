---
name: context-doctor
description: Health-check a workspace or a context repo for the drift and misconfiguration that never announces itself — a dead plugin id, a stale template stamp, an index missing threads, front-matter the ingester discards, a pending queue nobody drained, a member not cloned, a public workspace repo holding meetings. Reports everything and can fix the config keys whose correct value is derivable. Triggers like "check my context repo", "check my workspace", "context doctor", "is my context set up right", "why is this thread not showing up", "audit the context config", "what is wrong with my context repo".
---

# Check a workspace's or a context repo's health

Every failure this looks for is **silent**. A plugin id that names nothing still parses; a
thread whose front-matter contains an angle bracket loses its title and says nothing; `threads/INDEX.md` that is merely out of date
reads exactly like a complete one. Nothing in a session reports any of it, so it accumulates.

This skill runs the checks and hands you the findings. It is **diagnosis, not curation** — it
never rewrites prose.

## 1. Find the checkout

```bash
ROOT="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" --no-pull)"
```

The nearest `.claude/workspace.json` above the working directory, else — while unmigrated
projects remain — the context repo `context-repo.sh` resolves. `--no-pull` because a diagnostic
has no business autostashing a working tree it was asked to inspect. If the resolver exits
non-zero, the problem is the *link*, not the repo's health — that is `context-setup`, so route
there rather than guessing at a path.

The doctor decides for itself which kind of root it was given: a directory holding
`context.json` and no `.claude/workspace.json` is a context repo and gets today's checks
unchanged; anything else is checked as the nearest workspace. The first line of the report (and
`mode` in `--json`) says which ran.

## 2. Run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/context-doctor.mjs" "$ROOT"
```

Useful flags:

- `--json` — the same findings machine-readably.
- `--today 2026-08-18` — pin the date so ages are reproducible.

**In a workspace** it checks `workspace.json` itself (parses, `schema` 1, `repo`, every
`members[]` entry on disk, `connections`' shape), that `CLAUDE.md` imports `@docs/memory.md`,
the threads and `INDEX.md` in `docs/threads/`, and `.context/pending/` for stale items. A member
that is not cloned is a `note` — normal on a fresh clone — with the `gh repo clone` to run. The
checks for keys a workspace retired (`template`, the marker) do not run there.

**A `visibility` warning is the one to raise first in a workspace.** A PUBLIC workspace repo
holding `docs/meetings/` or `.context/pending/` gives those to anyone who clones it (ADR 0002):
the workspace repo must be private even when its members are public. This is the doctor's only
network call (`gh repo view`), made only when one of those directories exists; if `gh` cannot
answer, a `note` says the visibility was NOT checked — report that as unchecked, never as fine.

Findings come at three levels: `err` is actively broken or actively misleading, `warn` is worth
a look, `note` is context rather than a defect.

**The `autoload` note is the one to read out loud.** If `CONTEXT_KIT_AUTOLOAD` is off — in the
environment, or in the user-level `~/.claude/settings.json` that sets it — the SessionStart hook
loads nothing in *any* project on this machine, including one whose configuration is perfect. It is
a deliberate setting rather than a defect, hence a note, but it presents exactly as a plugin that
failed to load, so say so first when someone is here asking why their context did not appear.
`refresh-context` still loads on an off machine; that and removing the flag are the only two routes.
`context-setup` owns the fuller diagnosis.

**Exit 2 means it could not run** (bad argument, no such directory) — that is not a clean bill
of health, and must never be reported as one. Likewise a `note` saying enabledPlugins ids were
NOT verified means exactly that: the marketplace was unreadable, so the check did not happen.

## 3. Report, then ask before fixing

Give the user the findings grouped by level, in their own words — not a paste of the output.
For anything not automatically fixable, say what the fix is: rebuild the index with
`thread-index.mjs`, run `curate-context` for a drifting `memory.md`.

If the run reports fixable findings, **ask before applying them**:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/context-doctor.mjs" "$ROOT" --fix
```

`--fix` never writes `workspace.json` — every key there has another writing owner — so in a
workspace it can only fix `.claude/settings.json`. It writes **only JSON keys, and only where the correct value is derivable** from something
already in the repo — a plugin id that resolves to exactly one real plugin, or a
`PROJECT_CONTEXT_REPO` that disagrees with the `contextRepo` sitting next to it. It never
touches markdown, and it never writes a value it would have to guess. That envelope is the
safety property: a context repo is hand-written prose existing in exactly one copy.

It does **not** commit. Show the diff, and leave committing to the user or to their normal flow.
Settings are read at session start, so a settings fix lands next session.

## 4. What it deliberately does not check

- **Whether a declared connection actually works.** `connections` naming an MCP server that is
  absent is a live-session question — `context-setup` owns the connector gate.
- **Anything backend-specific.** `state.notion` shapes belong to context-notion, not to core;
  this plugin is not allowed to know them. **One exception, deliberately thin:** a
  `state.notion.schemas` line containing `is_datetime` is reported as a `warn`
  (`notion-dates`). Older `notion-discover` runs stamped that key into every date property's
  schema line; it is right for the hosted `notion-create-pages` tool and a 400 through
  `API-post-page`. The doctor only spots the retired token, the way it spots a retired catalog
  name. It says nothing about what the line *should* be (context-notion's `notion-config` owns
  that rule) and never fixes it: the user edits the line.
- **Whether the content is any good.** Staleness is measured in dates, never in judgement.

**Not this skill:** wiring a project to its context repo, or diagnosing why the context did not
load at all, is `context-setup`; re-pulling and re-reading mid-session is `refresh-context`;
condensing threads and promoting facts into `memory.md` is `curate-context`.
