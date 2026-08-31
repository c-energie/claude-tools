# devhub.toml — every key

Lives at the repo root, committed with the repo. Unknown keys anywhere are a **parse
error**, not ignored — a control that silently does nothing is the failure this rule exists
to prevent. Every problem in the file is collected and reported at once.

A manifest that does not parse is reported **in that repo's drawer only**. It never breaks
the Repos tab, the hub, or another repo.

## Top level

| key | required | notes |
|---|---|---|
| `schema` | yes | `1`. A **higher** number makes dev-hub say "run `uv tool upgrade dev-hub`" instead of reporting keys it does not know — that is what the field is for. |
| `[[feature]]` | no | static features, any number |
| `[plugin]` | no | `entry` and `workspace` — see `plugin.md` |

A file with `schema = 1` and nothing else is valid and declares nothing.

## `[[feature]]`

| key | required | notes |
|---|---|---|
| `id` | yes | lowercase letters, digits, `-`. Unique across the file *and* the plugin. |
| `title` | yes | the button's label |
| `description` | yes | the line under it. Write it for a stranger — it is all the context anyone gets. |
| `mode` | yes | `job` \| `terminal` \| `open` \| `url` |
| `scope` | no | `repo` (default) \| `workspace`. Which shelf the button lives on — see below. |
| `argv` | mode-dependent | non-empty list of non-empty strings. Required for `job`/`terminal`; optional for `open`; forbidden for `url`. |
| `artifact` | `open` only | relative path inside the checkout. No absolute path, no drive, no `..` — it is served to a browser and the path is re-checked against the resolved checkout at serve time. |
| `url` | `url` only | must start `http://` or `https://` |
| `requires_tool` | no | one program name, checked with `which`. Greys the button out and says so. |
| `[[feature.param]]` | no | see below |

### `scope`: which shelf

| value | where it appears | for |
|---|---|---|
| `repo` (default) | this repo's drawer in the Repos tab | something you do **to this checkout** |
| `workspace` | the hub's **Project tab**, pooled with every other cloned repo's | something you do **for the project** |

The shelf is the *only* difference. The declaring repo still owns the feature, it still runs
in that repo's checkout, the catalogue veto still reaches it, and `devhub feature <repo>
<id>` still runs it. A repo may declare both kinds; its drawer reports how many went to the
Project tab rather than dropping them silently.

`devhub features --project` lists exactly what that tab shows. Both listings mark the shelf
as `[mode, project]`.

### Per mode

- **`job`** — needs `argv`. Runs as a subprocess in the checkout, streaming into the hub's
  console. One job at a time across the whole hub, shared with clone/sync. No shell: a
  parameter value is one argv item and can never become a command.
- **`terminal`** — needs `argv`. dev-hub composes one line and opens a real terminal, always
  showing the line with a copy button as the fallback. **Refused at parse time:** any `text`
  parameter, and `"` `'` `` ` `` `$` in the `argv`, in any choice's options, in a flag's
  `arg`, or in the plugin entry.
- **`open`** — needs `artifact`; `argv` optional. With `argv`: Run, then Open once the file
  exists. Without: Open only. `artifact_ready` is a plain file check, so a templated
  artifact path never shows an Open button.
- **`url`** — needs `url`. No `argv`, no parameters: the link is fixed.

## `[[feature.param]]`

Nested inside the feature it belongs to.

| key | required | notes |
|---|---|---|
| `name` | yes | lowercase, digits, `-`, `_`. Unique within the feature. |
| `kind` | yes | `choice` \| `flag` \| `text` |
| `label` | no | defaults to `name`; it is what the control is called |
| `options` | `choice` only | non-empty list. Renders a `<select>`. |
| `default` | no | choice → must be one of `options` (defaults to the first); flag → bool (default `false`); text → string (default `""`, and it may not start with `-`) |
| `arg` | static `flag` only | what the flag expands to, e.g. `"--stale"`. Required for a static flag; **not allowed** on a plugin's flag, which reaches the plugin as `--param name=true`. |

### Rules that produce errors

- a placeholder naming no declared parameter
- a static parameter never used in `argv` or `artifact`
- a `text` parameter on a `terminal` feature
- a `choice` whose `default` is not in its `options`
- a `scope` that is neither `repo` nor `workspace`
- two parameters with the same name; two features with the same `id`

### Rules that apply at run time

- a `choice` value not in `options` → refused
- a `text` value starting with `-` → refused
- an undeclared parameter name → refused

## Catalogue veto

None of this appears if the catalogue says no:

```toml
[org]
features = false          # every repo, org-wide

[repos."owner/name"]
features = false          # this repo
```

Any followed catalogue setting it false wins — a veto cannot contradict. If features vanish
with no error in the drawer, check this before debugging the manifest.

## A complete example

```toml
schema = 1

[[feature]]
id          = "summarise-notes"
title       = "Summarise notes"
description = "Fold and rebuild the topic summaries that are out of date."
mode        = "job"
argv        = ["uv", "run", "notes-summarise", "{topic}", "{stale}"]

  [[feature.param]]
  name  = "topic"
  kind  = "text"
  label = "Topic"

  [[feature.param]]
  name    = "stale"
  kind    = "flag"
  label   = "Only what is stale"
  arg     = "--stale"
  default = true

[[feature]]
id            = "synthesise-meeting"
title         = "Synthesise a meeting"
description   = "Write a meeting up and log its decisions, actions and open questions."
scope         = "workspace"      # the Project tab: done for the project, not to this repo
mode          = "terminal"
requires_tool = "claude"
argv          = ["claude", "/context-notion:synthesise-meeting {period}"]

  [[feature.param]]
  name    = "period"
  kind    = "choice"
  label   = "Period"
  options = ["today", "yesterday", "this week", "last week"]
  default = "today"
```
