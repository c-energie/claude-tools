# The `~/.context` clone root

**Canonical copy.** `~/.context/CLAUDE.md` on a laptop is a short stub that keeps only the rules
a session must not act without, and points here for the rest. That file is not version
controlled — `~/.context` has no `.git` — which is why this one exists: everything below was
learned the hard way and had no history, no backup and no reviewer.

Keep the stub and this file in step. The stub is loaded by **every** session under
`~/.context/**`, including the project context repos, so anything moved into it is paid for
everywhere; anything moved out of it has to be safe for a session not to know.

---

## What this directory is

`~/.context` is the **managed clone root for context repos** — where the context tooling puts
every project context repo it resolves, one directory per GitHub owner. It is not itself a
checkout and there is nothing to build here.

```
~/.context/
  .context-repo              # "none" — this root deliberately has no context repo of its own
  <owner>/<repo>/            # one managed clone per project context repo
```

**The tools live somewhere else, and that is deliberate.** As of 2026-08-31 the two repos that
are *tooling* rather than *data* sit at `~/c-energie/`:

| Directory | Remote | What it is |
| --- | --- | --- |
| `~/c-energie/claude-tools/` | `c-energie/claude-tools` | The plugin marketplace (catalog `c-energie`): `plugins/context-kit-core`, `plugins/context-notion`, `plugins/context-slack`, `plugins/diagrams`, `plugins/devhub` |
| `~/c-energie/context-template/` | `c-energie/context-template` | GitHub **template repo** for per-project context repos (memory.md, glossary, threads, meetings, pending) |
| `~/.context/<owner>/<repo>/` | various | Managed clones of project **context repos** — data, one per project |

Commit and push in each directory separately.

**Why they were split.** Both kinds of thing used to live under this root, and the path did not
distinguish them: `~/.context/c-energie/context-kit` (a tool) sat beside
`~/.context/net-flex/context` (data), so anything walking the tree had to decide what a directory
*was* from its content — a context repo has `context.json` at its root, the marketplace has
`.claude-plugin/marketplace.json` — and the marketplace additionally needed a committed
`PROJECT_CONTEXT_REPO: none` so no session could load it as somebody's context.

**Those content tests all still stand, and must.** What a directory *is* is still decided by what
is in it, never by where it sits: `plugin-repo.sh` still checks for `marketplace.json`,
`claude-tools` still carries its `none` opt-out in its committed `.claude/settings.json`, and
anything else walking either tree needs the same belt and braces. The move does not replace those
checks — it stops the layout actively suggesting the wrong answer, so a reader's first guess and
the tooling's answer agree.

Both `~/c-energie/repo` and the old `~/.context/c-energie/repo` are resolved, and a clone found at
an earlier path is used **where it sits** — re-cloning beside an existing checkout is how one of
the two silently goes stale. `CONTEXT_KIT_PLUGIN_DIR` and `CONTEXT_TEMPLATE_DIR` override.

This root carries a `.context-repo` marker reading `none`, so the session-start hook stays silent
here. It is a **marker rather than a `.claude/settings.json` env block** on purpose: the resolver
reads markers from `$cwd` only, whereas an inherited `env` block could opt out every context repo
nested beneath this directory — silently, which is the failure mode the whole system is built to
avoid.

## The architecture in one pass

Five layers, and *which layer a fact lives in* is the design:

1. **`context-kit-core`** — generic machinery, no backend and no project knowledge. Resolves *a*
   project's context repo, loads it at SessionStart, refreshes it mid-session, writes threads back.
2. **`context-notion`** — Notion skills (actions / decisions / open questions / pending queue,
   tidies, the `notion/` mirror), driven entirely by the project's config.
3. **`context-slack`** — Slack delivery (per-person digest, pending nudge). Nothing posts unprompted.
4. **`diagrams`** — the diagram store: capture an SVG/HTML diagram into the project's per-org
   store repo (`state.diagrams.repo`, **no default**), and build a single-file gallery over it.
5. **The project's own context repo** (stamped from `context-template`) — holds *all* the specifics:
   database IDs, property schemas, the people roster, connection names, the store repo.

A hard-coded database ID, workspace name, diagram store or person in a plugin is the bug this
layering exists to prevent. Plugins know only the **keys** (`actions`, `decisionLog`,
`openQuestions`, `diagrams.repo`, …); values come from the context repo's `context.json` at
runtime. The contract is documented in `plugins/context-notion/README.md` (`state.notion`),
`skills/slack-config/SKILL.md` and `skills/diagrams-config/SKILL.md`.

All plugins ship from the **one** repo with relative `source` paths in
`.claude-plugin/marketplace.json`, because Cowork cannot fetch a second private repo — one fetch
has to deliver everything.

### One catalog per org

The catalog declares `name: "c-energie"` — the **org**, not the repo — so identifiers read
`context-kit-core@c-energie`. A marketplace is a **permission** boundary (read on the repo,
all-or-nothing across its plugins); a plugin is a **topic** boundary that costs nothing to add.
Hence: *a separate GitHub org gets a separate catalog; the same people plus a new topic gets a new
plugin in the existing one.* `diagrams` was the case that decided it.

**A plugin in the catalog need not be part of the context stack.** `devhub` (dev-hub manifest
authoring, moved out of `~/.claude/skills/` on 2026-08-31) reads no `context.json` and serves any
repo at all. The five layers above describe the *context system*; the catalog is the org's
tooling, which is a larger set.

Both the repo and the catalog were named `context-kit` until 2026-08-31; the catalog `version`
went to `1.0.0` to mark that the old identifiers are dead. A stale `X@context-kit` in some repo's
`enabledPlugins` is **silently ignored** by the loader rather than reported, so it presents as a
plugin that crashed on load — `context-doctor` carries the retired name and flags it, and `--fix`
rewrites the ids.

### How a session finds its context repo

`hooks/load-context.sh` and `scripts/context-repo.sh` resolve, in order: `PROJECT_CONTEXT_REPO` env →
`.claude/settings.local.json` → `.claude/settings.json` → marker files (`context-project.json`,
`.context-repo`, `context-repo.txt`) in the project, `docs/`, `/mnt/project`, `~/mnt/...` → a bounded
`find` over the mount areas only. Then: managed clone at `~/.context/<owner>/<repo>` (or
`PROJECT_CONTEXT_DIR`), pull `--ff-only --autostash` capped at `CONTEXT_GIT_TIMEOUT` (30s).

Note what is **not** searched: the marker lookup only ever reads `$cwd` and a fixed list of mount
paths, and the bounded `find` covers `~/mnt` and `/mnt` alone — never the working tree, and never
this directory's children. A session opened at `~/.context` therefore cannot adopt a nested
project's marker by accident.

That clone path was a flat `<owner>-<repo>` slug until 2026-08-11 — ambiguous (`net-flex-context`
reads equally as `net-flex/context` or `net/flex-context`) and unlike GitHub's own layout. There is
deliberately **no migration**: a clone under the old name is simply not found, so the repo is
re-cloned at the new path and the stale directory is left to be deleted by hand.

**There is deliberately no default repo**, and the three outcomes must stay distinguishable:
*configured* (loads), *unconfigured* (says so loudly and tells the model to hunt for a marker), and
*opted out* — `none`/`off`/`false`/`no`/`-`/`disabled`, which exits silently. Conflating opt-out with
unconfigured, or falling back to some other project's repo, is the exact failure the system exists to
prevent. **A deliberate cross-project layer reading every repo under this root is a different
thing from an accidental wrong-context load** — but it has to be an explicit mode, never something
a session inherits from its working directory.

The same rule, for the same reason, governs `state.diagrams.repo`: no default, because a default
would let one org's project write into another org's diagram store.

## Working on the tooling

Everything about *building* the plugins — the commands, the release discipline, the skill and
hook rules, and the data-integrity invariants each backend depends on — lives with the code, and
is therefore loaded only by a session that is actually in the checkout. Those files are
authoritative and must be read before editing a plugin:

| File | What only it says |
| --- | --- |
| `claude-tools/CLAUDE.md` | release discipline (check, bump, the deliberately copied scripts) and the skill-authoring rules that fail silently |
| `claude-tools/plugins/*/CLAUDE.md` | one per plugin: its commands, and its own invariants — the Notion ID and schema traps, Slack's blanket block, the diagram index |
| `claude-tools/plugins/context-kit-core/README.md` | the `include` contract and the payload the SessionStart hook builds |

Resolve the checkout with `bash scripts/plugin-repo.sh --writable`; it may sit at
`~/c-energie/claude-tools` or at the older `~/.context/c-energie/context-kit`, and whichever is
found is used **where it sits**.

**None of that is repeated here, on purpose.** It moved out on 2026-08-31: the stub is loaded by
*every* session under `~/.context/**` — the project context repos included, where plugin-
development instruction applies to none of them. It was carrying about 9 KB of it into every
session that never touched a plugin.
