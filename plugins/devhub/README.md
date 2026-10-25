# devhub

Authoring skills for [dev-hub](https://github.com/c-energie/dev-hub) — the hub that renders each
cloned repo's committed `devhub.toml` as buttons, in that repo's drawer or on the hub's Project
tab.

Install from the `c-energie` catalog: `devhub@c-energie`. It needs nothing else — no workspace,
no Notion, no Slack. It is useful in **any** repo that wants a button in the hub, which is why it
is its own plugin rather than a skill inside the context stack.

| Skill | What it does |
| --- | --- |
| `devhub-feature` | Write or fix a repo's `devhub.toml` — and the dev-hub plugin behind it, when the options have to be computed at the moment someone looks |
| `devhub-catalogue` | Add the repo you are standing in to a followed `catalogue.toml`, so `devhub` clones it, runs its recipe, and shows its features anywhere at all |

## Why a plugin and not `~/.claude/skills/`

It lived in one person's `~/.claude/skills/` until 2026-08-31, which meant three things:

- **Cowork never saw it.** Sandbox sessions load the skills enabled for the claude.ai account, not
  `~/.claude/skills/`. A skill that only exists on one laptop is unavailable exactly where someone
  is most likely to be standing in an unfamiliar repo.
- **Nobody else had it.** A convention about a file format everyone commits should not be one
  person's local note.
- **It had no version, so it could not be updated.** Clients update on a plugin's version; a loose
  skill directory has none.

Same rule that put `diagrams` here: a marketplace is a permission boundary, a plugin is a topic
boundary. Same people, new topic — a new plugin in the existing catalog.

## What `devhub-feature` is actually for

`devhub.toml` is small, and the way it goes wrong is that it **parses cleanly and then refuses to
run**. The skill is five judgements, three of which have a specific failure of that kind:

- **static feature or plugin** — a plugin costs a subprocess every time the drawer opens, so it is
  only correct when the option list genuinely cannot be written down in advance
- **`scope`** — the repo's drawer for something done *to this checkout*, the Project tab for
  something done *for the project*; a plugin contributing to the Project tab must opt in with
  `workspace = true` or it is reported in its own drawer instead
- **the terminal-mode rule** — a terminal feature's line is handed to a shell, so free text and
  shell metacharacters are refused at **parse time**, in a plugin's terminal features too
- **templating** — an argv item that is *only* a placeholder disappears when unset; one inside a
  longer string is substituted in place, and that difference is the whole optional-argument mechanism
- **availability** — `"available": false` requires a `"reason"`, and the reason must be the remedy
  (`"NOTION_TOKEN is not set in .env"`), not the symptom (`"not configured"`)

`references/schema.md` and `references/plugin.md` carry every key and the `describe`/`run` contract.

## What `devhub-catalogue` is actually for

A `devhub.toml` renders nothing until the repo is **catalogued** — declared in a
`[repos."owner/repo"]` entry in a followed catalogue's `catalogue.toml`. There is no `devhub`
subcommand that adds one; it's a manual edit to a shared, committed file, so the skill's
judgement is mostly about not landing that edit in the wrong place or pushing it too eagerly:

- **which catalogue owns this repo** — a machine can follow more than one, and a repo may be
  declared by exactly one of them; `owner/.github` is the common convention, not a rule to assume
- **commit and push are two separate confirmations** — a local commit is easy to undo, a push
  reaches every teammate's machine on their next `devhub sync`

`references/catalogue-schema.md` carries every catalogue-level and per-repo key.

## Layout

```
plugins/devhub/
  skills/devhub-feature/
    SKILL.md
    references/schema.md              every key, every mode, every parameter kind
    references/plugin.md              the describe/run contract, and a skeleton to copy
  skills/devhub-catalogue/
    SKILL.md
    references/catalogue-schema.md    every catalogue.toml key
```

No scripts: `devhub` is its own CLI, installed separately (`uv tool install dev-hub`), and
`devhub validate` (with or without `--manifest`) is the check. Nothing here duplicates it.
