# handoff/

Items produced in a second-brain session that belong to **one project** — an insight that
should become a thread over there, an action for a project, a decision to log properly.
Sessions here cannot (and must not) write into a project's repo or its structured-state
backend, so the item is parked here, addressed, and carried over by hand the next time that
project's own session is open.

Not `pending/`: that folder keeps its plugin-defined meaning (staging for a structured-state
backend that was unreachable). This one is a mailbox between projects.

## Format

One file per item, `YYYY-MM-DD-short-topic.md`, YAML front-matter, **no angle brackets in any
front-matter value** (skill ingesters read them as tags and silently drop the field):

```markdown
---
title: One-line summary of the item
project: owner/project-context
kind: action | decision | open-question | thread-seed
date: 2026-01-31
---

The item itself: enough context that the receiving session needs nothing from this repo.
Convert relative dates to absolute.
```

`project` is the target context repo's `owner/repo` name, exactly as it appears in
`context.json`'s `include` list.

## Draining

In the target project's session: act on the item there (create the thread, log the action or
decision to that project's backend), then move the file to `handoff/done/` in this repo and
commit, updating `INDEX.md`. An item still sitting here is by definition not yet in the
project it belongs to.
