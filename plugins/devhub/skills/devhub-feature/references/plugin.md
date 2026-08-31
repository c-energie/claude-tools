# The plugin contract

A plugin is a **command in the repo's own environment**, not an import. dev-hub's engine is
stdlib-only by design and lives in its own venv; your plugin gets the repo's dependencies,
its venv and its tests, and a plugin that raises is a failed job rather than a dead hub.

```toml
[plugin]
entry     = ["uv", "run", "notes-hub"]
workspace = true          # only if you describe scope = "workspace" features; see below
```

`entry` is an **explicit argv** — no name-plus-toolchain inference, so a repo with any
toolchain or none can name one. dev-hub appends the subcommand and runs it with the
checkout as the working directory.

## `describe`

dev-hub runs `<entry> describe` **every time the drawer opens** — and, if you take the
Project tab opt-in below, every time that tab loads — uncached, because "which topics are
stale" is only true at the moment you look. Print JSON on stdout:

```json
{"schema": 1, "features": [
  {"id": "summarise",
   "title": "Summarise 3 stale topics",
   "description": "Fold and rebuild the summaries that are out of date.",
   "mode": "job",
   "param": [{"name": "topic", "kind": "choice", "label": "Topic",
              "options": ["Grant deadlines", "Reading list"]}]},

  {"id": "capture", "title": "Capture health", "description": "Check the worker.",
   "mode": "job",
   "available": false, "reason": "NOTION_TOKEN is not set in .env"}
]}
```

Same keys as a static feature (see `schema.md`), with three differences:

| | |
|---|---|
| `argv` | **forbidden.** dev-hub runs your feature through you. Otherwise `describe` would be a way to run anything — only without the file a reviewer can read. |
| `available` / `reason` | yours to set. `available: false` **requires** a non-empty `reason`. |
| `runs` | optional bool, default `mode != "url"`. Set `false` on an `open` feature that only shows a file something else wrote. |

`"scope": "workspace"` works here exactly as it does in a manifest, and computed options are
the usual reason a project feature needs a plugin at all — *which* meetings have no summary
yet is not something a file can state. See **The Project tab opt-in** below: a plugin that
describes workspace features must set `workspace = true`, or dev-hub never asks it.

A flag parameter needs no `arg` here — it reaches you as `--param name=true`.

**Keep `describe` fast and side-effect-free.** It is bounded at 20 seconds and it runs on
every drawer open. Do not use it to fetch, build, or write anything.

## The Project tab opt-in

The Repos tab asks *one* plugin — the drawer you opened. The Project tab spans **every
cloned repo**, so asking them all would put one subprocess per repo in front of the page.
It therefore asks only the plugins that said they had something to contribute:

```toml
[plugin]
entry     = ["uv", "run", "notes-hub"]
workspace = true
```

- Without it, your `scope: "workspace"` features are never asked for, and dev-hub says so in
  **your repo's drawer** — a feature landing on neither shelf is the silent failure the
  strict keys exist to prevent, so it is reported rather than swallowed.
- `workspace = true` with no `entry` is a parse error: there is nothing to ask.
- It costs nothing if all your described features are repo-scoped, but do not set it
  speculatively — it is what buys the subprocess.

Everything else is unchanged: same `describe`, same `run`, same strictness. Your one
`describe` answers for both shelves.

## `run`

```
<entry> run <id> --param name=value --param other=true
```

Print freely; the hub's console renders everything you and your child processes print.
Exit non-zero to fail the job. Booleans arrive as the strings `true` / `false`.

## What happens when a plugin misbehaves

Your answer is parsed exactly as strictly as a manifest — crossing a process boundary is
not evidence of correctness. Each of these costs **your** features and leaves the
manifest's static ones standing, with a warning above them in the drawer:

- exiting non-zero → *"`… describe` exited N: <last stderr line>"*
- printing anything that is not a JSON object → reported, never raised
- taking longer than the timeout → reported
- a feature naming its own `argv`, or a bad key, or `available: false` with no reason
- re-declaring an id the manifest already owns → **one feature, one owner**; the whole
  dynamic set is dropped rather than guessing which wins
- describing `scope: "workspace"` features without `[plugin] workspace = true` → they are
  named in the drawer with the key to add; the rest of your features still work

So: print JSON to **stdout** and diagnostics to **stderr**. A stray `print()` for debugging
is what turns a working plugin into "did not print JSON".

## Skeleton

```python
"""dev-hub plugin: `describe` says what is possible now, `run` does it."""
import json, os, sys


def stale_topics() -> list[str]:
    ...   # the thing only this repo's code can know


def describe() -> dict:
    if not os.environ.get("NOTION_TOKEN"):
        return {"schema": 1, "features": [{
            "id": "summarise", "title": "Summarise notes",
            "description": "Fold and rebuild the summaries that are out of date.",
            "mode": "job",
            "available": False, "reason": "NOTION_TOKEN is not set in .env",
        }]}

    topics = stale_topics()
    return {"schema": 1, "features": [{
        "id": "summarise",
        "title": f"Summarise {len(topics)} stale topics" if topics else "Summarise notes",
        "description": "Fold and rebuild the summaries that are out of date.",
        "mode": "job",
        "available": bool(topics),
        "reason": "" if topics else "nothing is stale right now",
        "param": [{"name": "topic", "kind": "choice", "label": "Topic",
                   "options": topics}] if topics else [],
    }]}


def main() -> int:
    command, rest = sys.argv[1], sys.argv[2:]
    if command == "describe":
        print(json.dumps(describe()))          # stdout is the protocol
        return 0
    if command == "run":
        feature_id, args = rest[0], rest[1:]
        values = dict(a.split("=", 1) for a in args if a != "--param")
        print(f"summarising {values.get('topic', 'everything')}…", flush=True)
        ...                                     # anything printed here reaches the console
        return 0
    print(f"unknown command {command!r}", file=sys.stderr)   # stderr, not stdout
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
```

Expose it as a console script (`[project.scripts] notes-hub = "pkg.devhub_plugin:main"`)
so `entry` stays `["uv", "run", "notes-hub"]` rather than naming a file path.

## Proving it

```
<entry> describe | python -m json.tool     # valid JSON, nothing else on stdout
devhub features <owner/repo>               # what dev-hub actually makes of it
devhub features --project                  # workspace features: proves the opt-in works
devhub feature  <owner/repo> <id> --param name=value
```

The first command is the one people skip, and "nothing else on stdout" is the failure it
catches.
