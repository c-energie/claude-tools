# context-kit (marketplace)

The c-energie plugin marketplace for the **context-repo system**: per-project memory that
Claude sessions load at start, refresh mid-session, and write back — plus a Notion middle
layer driven entirely by each project's configuration.

Two plugins, both shipped from this one repo (single fetch — that is what makes installs
work on every surface, including Cowork, which cannot fetch a second private repo):

| Plugin | What it is |
| --- | --- |
| [`plugins/context-kit`](plugins/context-kit/) | Core layer: SessionStart context loading (with visible status line), the context-repo resolvers, `refresh-context`, `save-thread` |
| [`plugins/context-notion`](plugins/context-notion/) | Notion middle layer: config-driven actions / decisions / open questions + the pending queue |

Install: add this repo as a marketplace (`/plugin marketplace add c-energie/context-kit`, or
Cowork's plugin UI), then install `context-kit@context-kit` and — for Notion-backed
projects — `context-notion@context-kit`.

Each plugin's README documents its own behaviour, including how a project selects its
context repo (env var → `.claude` settings files → `.context-repo`/`context-repo.txt`
marker → default) and the `context.json` contract. New context repos start from
[c-energie/context-template](https://github.com/c-energie/context-template).
