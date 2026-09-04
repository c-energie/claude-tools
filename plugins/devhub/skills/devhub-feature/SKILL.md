---
name: devhub-feature
description: "Give the repo you are standing in a feature in dev-hub — a button that runs something, hands off to a terminal, opens a report, or opens a link, in that repo's drawer or on the hub's Project tab — by writing or updating its devhub.toml, and a plugin when the options have to be computed. Use when asked to add a dev-hub feature or button for a repo, to add a project-level or workspace feature, to make a repo's tooling reachable from the hub, to write or fix a devhub.toml, to write a dev-hub plugin, or when a declared feature is missing, greyed out, on the wrong tab, or refusing to run."
---

# devhub-feature

Write a repo's `devhub.toml` — the committed declaration of *what this repo can do*, which
dev-hub renders as buttons: in that repo's drawer in the Repos tab, or on the hub's Project
tab when the thing is done for the project rather than to the repo.

The file is small. What decides whether it works is five judgements, and three of them have
a specific way of going wrong that produces a manifest which parses cleanly and then
refuses to run. Do not skip to writing the file.

## What this does not do

It writes files in **one repo**. It does not add that repo to a catalogue, edit any
catalogue, commit anything, or install dev-hub. A repo's features only appear if the repo
is **catalogued by a catalogue this machine follows** *and* cloned — check with
`devhub features <owner/repo>` before concluding your manifest is broken. If it says the
repo isn't in the catalogue, that's `devhub-catalogue`'s job, not a manifest bug. A repo
that moved to another org's catalogue shows nothing until `devhub follow <that/catalogue>`.

## 1. Static or plugin?

This is the first decision and the one most often got wrong in the expensive direction.

**Static `[[feature]]`** — you can write the options down now. Four meeting periods, a
handful of report kinds, a flag. No process, no toolchain needed; a docs-only repo can
carry static features.

**A `[plugin]`** — only when something must be **computed at the moment someone looks**:

- the option list is not knowable in advance (*which* topics are stale, *which* meetings
  have no summary, which branches exist), or
- availability depends on the repo's environment (an unset key, an empty queue) — things
  dev-hub cannot see and a file cannot state.

A plugin costs a subprocess **every time the drawer opens**. If the answer is a fixed list,
a static feature is not a compromise, it is the correct answer. A repo may have both.

## 2. Which shelf: the repo's drawer, or the Project tab?

`scope` decides where the button lives, and nothing else:

- **`scope = "repo"`** (the default; omit it) — something you do **to this checkout**.
  Rebuild its graph, re-run its tests, open its report. It appears in the repo's drawer in
  the Repos tab.
- **`scope = "workspace"`** — something you do **for the project as a whole**. Synthesise a
  meeting, run the weekly review, open the board. It appears on the hub's **Project tab**,
  gathered together with what every other cloned repo declares for the project.

Ask: *would someone go looking for this under this repo's name?* Writing up a meeting is
not "a thing I do to the context repo", even though the context repo is where the files
live — so it belongs on the Project tab.

Moving the shelf changes nothing else. This repo still owns the feature, it still runs in
**this checkout** with this repo's environment, the catalogue's `features = false` still
switches it off, and it still runs from `devhub feature <owner/repo> <id>`. That is why
there is no other way to declare a project-level feature: put it in the repo whose
directory the command actually needs to run in.

Two consequences worth knowing before you write:

- A project feature usually wants **computed options** — *which* meetings have no summary
  yet — which is one of the few honest reasons to reach for a plugin (§1). A plugin
  contributing to the Project tab must opt in with `[plugin] workspace = true`, because
  that tab spans every cloned repo and would otherwise run one subprocess per repo. A
  plugin that describes workspace features without the opt-in is reported in its own
  drawer; it does not silently appear nowhere.
- A repo's drawer says how many of its features went to the Project tab, so if a button is
  "missing", read that line before suspecting the manifest.

## 3. Pick the mode by what the thing needs

| mode | for | costs |
|---|---|---|
| `job` | anything non-interactive. **The default.** | streams into the hub's console |
| `terminal` | anything TTY-bound: a `claude` session, hidden prompts, a REPL | opens a real window; **no free text, ever** |
| `open` | it produces a file worth looking at | two presses: Run, then Open |
| `url` | a link | nothing runs |

**The terminal rule is the trap.** A terminal feature's line is handed to a shell
(`powershell -Command <line>`), so dev-hub refuses free text at **parse time** — a
`text` parameter on a terminal feature is an error, not a warning, and so is a `"`, `'`,
`` ` `` or `$` anywhere in its `argv`, its choices, or the plugin entry behind it. This
applies to a plugin's terminal features too; being code does not buy an exemption.

If your terminal feature wants a typed string, you have exactly two honest options: make it
a `choice` with a fixed list, or make it `job` mode. Do not try to escape your way out.

`open` mode's two presses are deliberate: a `window.open` after an awaited job has lost its
user activation and a popup blocker eats it. Declare the `artifact` before it exists — the
Open button appears once the file does.

## 4. Templating: how a value reaches the command

Placeholders are `{name}` and follow one rule with two halves:

- An argv item that is **only** a placeholder **disappears** when its text is empty or its
  flag is off. That is how an optional argument stays optional.
- A placeholder **inside a longer string** is substituted in place. That is how a prompt or
  a `--since={period}` is built.

```toml
argv = ["uv", "run", "notes-summarise", "{topic}", "{stale}"]   # both drop when unset
argv = ["claude", "/context-notion:synthesise-meeting {period}"]  # substituted in place
```

Two rules that bite:

- **Every parameter a static feature declares must appear in its `argv` or `artifact`.** A
  control wired to nothing is a parse error. (A plugin's parameters are exempt — they reach
  it as `--param name=value` by construction.)
- **A `text` value may not start with `-`**, at runtime *or* as a default. If you want a
  flag, declare a `flag`; do not invite someone to type one.

## 5. Availability: say why, or the button lies

dev-hub only knows two things: whether a **recipe step failed**, and whether
`requires_tool` is on PATH. An open manual step does not block, and a repo with nothing
recorded is treated as fine — dev-hub knows of no failure, so it claims none.

Everything else is yours. A plugin returns `"available": false` with a `"reason"`, and the
reason is **required** — a control that is off without saying why is worse than one that is
missing. Write the remedy, not the symptom: `"NOTION_TOKEN is not set in .env"`, not
`"not configured"`.

## 6. Write it, then prove it

```
devhub validate --manifest        # standalone: no catalogue, no machine, no clone needed
```

Put that line in the repo's CI. Unknown keys are errors by design, and every problem is
reported at once, so one run fixes a batch.

Then **actually run it** — the GUI takes exactly this path, so if it works here it works
there, and if you skip this you are guessing:

```
devhub features <owner/repo>            # what dev-hub sees, including from the plugin
devhub features --project               # the Project tab's set, across every cloned repo
devhub feature  <owner/repo> <id> --param name=value
```

`devhub feature` prints the composed command before running it. Read that line. It is the
fastest way to see that an empty text dropped its argv item, or that a choice landed inside
the string you meant.

Both listings mark the shelf — `[terminal, project]` — so one run tells you whether `scope`
landed. A project feature that shows up in `devhub features <owner/repo>` but not in
`devhub features --project` is a plugin missing its `workspace = true`.

## References

- `references/schema.md` — every key, every mode, every parameter kind, and the errors each
  produces. Read before writing a manifest with more than one feature.
- `references/plugin.md` — the `describe` / `run` contract and a plugin skeleton to copy.
  Read before writing any plugin.

## The one thing to remember about trust

dev-hub composes the argv; the browser only ever names a repo and a feature id. Your
manifest may name a command because installing this repo already ran its build hooks —
that is the whole justification, and it is why the *parameter* rules above are strict while
the `argv` itself is free. Do not design a feature that takes a command as a parameter. If
you find yourself wanting to, you want a plugin, where the repo's own code decides.

**Not this skill:** wiring a project to its context repo, or changing the context plugins
themselves, is `context-kit-core`'s `context-setup` and `update-plugin`. Declaring which
credentials a repo uses is the `secrets-declare` skill. Adding this repo to a catalogue so
`devhub` clones it and shows these features at all is `devhub-catalogue`. This one only writes
the `devhub.toml` (and its plugin) of the repo you are standing in — it never commits, and
never touches a catalogue.
