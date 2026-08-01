# context-kit

The **core layer** of a three-layer plugin architecture for project context in Claude Code /
Cowork. This plugin knows nothing about any particular project or workspace — it is the
machinery for loading, refreshing and writing a project's **context repo**.

```
┌─────────────────────────────────────────────────────────────┐
│ Project layer — one context repo per project                │
│   e.g. net-flex/context, c-energie/thesis-context           │
│   memory.md, glossary, threads/, meetings/, pending/,       │
│   context.json (config the layers below read)               │
│   Created from the c-energie/context-template repo.         │
├─────────────────────────────────────────────────────────────┤
│ Middle layer — structured-state backend (PLANNED)           │
│   A Notion-layer plugin: generic add-action / log-decision /│
│   query / mirror-sync skills, parameterised by each         │
│   project's context.json (database IDs, property schemas,   │
│   roster). One install serves every Notion-backed project — │
│   grid-flex and a thesis alike. An Obsidian or other        │
│   backend could implement the same contracts later.         │
├─────────────────────────────────────────────────────────────┤
│ Core layer — THIS PLUGIN                                    │
│   SessionStart hook (memory.md + thread pointers),          │
│   context-repo resolver, refresh-context, save-thread       │
└─────────────────────────────────────────────────────────────┘
```

Which context repo a session loads is per-project:

```json
{ "env": { "FLEXSENSE_CONTEXT_REPO": "c-energie/thesis-context" } }
```

in the project's `.claude/settings.json`. Default `net-flex/context`; managed clones land at
`~/.context/<owner>-<repo>` (the default remote keeps its historical `~/.flexsense/context`);
`FLEXSENSE_CONTEXT_DIR` pins the location outright. Private repos authenticate via the OS git
helper, else `FLEXSENSE_GIT_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`, else `gh auth token`.

> The `FLEXSENSE_*` env-var names are inherited from this machinery's origin in
> `net-flex/flexsense-plugin` and kept so existing setups and the template keep working.
> Renaming them (with back-compat) is an open TODO.

## Skills

| Skill | What it does |
| --- | --- |
| `refresh-context` | Re-pull the project's context repo mid-session and report what changed |
| `save-thread` | 🔒 Write up the current work as a `threads/` entry and push (never self-triggers) |

The SessionStart hook loads `memory.md` + thread pointers automatically, with a STALE banner
when the refresh fails — a silently stale context is the one failure mode that actively
misleads.

## Port status (from net-flex/flexsense-plugin)

Ported: the hook, both resolvers (`context-repo.sh`, `plugin-repo.sh`), `dates.mjs`,
`thread-index.mjs`, `check-plugin.mjs`, `bump-version.mjs`, `refresh-context`, `save-thread`.

Still to port here: `curate-context`, `context-access` (the Cowork GitHub-API route),
an `update-plugin` analogue for this repo.

To the **Notion middle layer** (not here): `add-pending`/`process-pending` + `pending-parse.mjs`
(roster-dependent), `mirror-render.mjs`, and generalised versions of the flexsense Notion skills
(`add-action`, `log-decision`, `update-action`, `query-decisions`, mirror sync, tidies) reading
each project's `context.json` instead of a baked-in `flexsense.json`.

`net-flex/flexsense-plugin` remains the FlexSense project layer (roster, Slack digest,
weekly-review, FlexSense's Notion specifics) and keeps its own copy of the core machinery
until the FlexSense team migrates to installing context-kit alongside it — don't enable both
hooks at once, or the context loads twice.

## Working on this repo

No build, no tests: `node scripts/check-plugin.mjs .` is CI, run it before any commit. Bump
`.claude-plugin/plugin.json` via `node scripts/bump-version.mjs . patch|minor|major` — version
lives there **only** (a version in `marketplace.json`'s `plugins[]` overrides it silently).
`*.sh` stay LF. No angle brackets in any YAML front-matter value. The hook must exit 0 on
every path. `hooks/load-context.sh` carries an inline duplicate of `context-repo.sh` for
installs where packaging drops `scripts/` — change both or neither.
