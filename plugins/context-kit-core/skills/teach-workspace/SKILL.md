---
name: teach-workspace
description: List the teaching workspaces a context repo declares, and prepare a new one for the teach skill to work in. Triggers like "what am I learning", "list my teaching workspaces", "which topics have I started", "set up a workspace for learning [topic]", "prepare a teach workspace".
disable-model-invocation: true
---

# Teaching workspaces in a context repo

Prepares a place for `teach` to work, inside the context repo **this session has already
resolved**, and lists the ones that already exist.

**It does not teach.** `/mattpocock-skills:teach` does that, and it is
`disable-model-invocation: true`, so no skill and no agent can start it — only a person typing
it. This skill therefore ends by printing a line to paste.

## What a teaching workspace is

One topic, one mission, one directory under a fixed `teaching/` parent:

```
teaching/[topic-slug]/
  lessons/           reference/           learning-records/           assets/
  NOTES.md
```

The fixed parent is load-bearing. `teach` writes `lessons/*.html`; a context repo already has
`assistants/[role]/LESSONS.md`, which means something completely unrelated and is the only file a
supervisor may read. `teaching/` is what keeps the two senses of the word from ever meeting. See
`CONTEXT.md` at the marketplace root, which defines both.

**Which repo a workspace lands in is decided by which repo you opened the session in.** There is
no repo argument. A session in a shared project context repo produces a workspace that project's
people can read; a session in the personal cross-project repo produces a private one. That is the
whole audience decision, and it is made by choosing where you stand.

## 1. Resolve the repo

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --no-pull)"
```

`--no-pull` deliberately: the roster is a **read**, it should be instant, and the session-start
hook already pulled this repo. Nothing on this path touches the network.

If that exits non-zero, do not guess a repo and do not scan `~/.context` for a likely one —
loading the wrong project's context is the failure the whole system exists to prevent. The
script classifies the reason for you:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/teaching-workspace.mjs" resolve --json
```

Three refusals, three different fixes. **Never flatten them into one message:**

| status | what is true | what to say |
| --- | --- | --- |
| `opted-out` | This project deliberately has no context repo (`none`). | A setting, not a fault. If it was meant, nothing here applies. If not, remove the `none` and run `context-setup`. |
| `unconfigured` | This project never said which repo it uses. | Run `context-setup` to link one, or `init-context` to create one. |
| `unreachable` | A repo is configured but the checkout would not resolve. | The link, not the workspaces — check auth and connectivity, then run `context-doctor`. |

## 2. Bare invocation — the roster

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/teaching-workspace.mjs" roster "$ROOT"
```

`--json` for the structured form. It reports slug, mission path and audience for every workspace
the repo **declares** in `context.json`'s `teaching` block.

Declared, never discovered. The roster is not `ls teaching/`. Same rule as `include`,
`assistants` and `connections`, for a narrower reason than those: nothing loads this block at
session start, so it is not load-safety that requires the declaration but `audience` — a fact
about who may read a workspace that a directory cannot express.

Read the report back as it is. Three things in it are deliberate and should not be tidied away:

- **"none declared yet" is not "no repo".** A repo that resolved and declares nothing is fine and
  says so distinctly. Only one of those two empty rosters has a problem in it.
- **An absent audience is absent, not `working`.** It means nobody has classified that workspace.
- **A flagged declaration is a report, not a task.** A missing directory, an unresolvable mission
  path, an unrecognised audience: `context-doctor` reports the same three and neither fixes them,
  because none has a derivable correct value. Say what is flagged; do not repair it unasked.

## 3. With a topic — prepare a workspace

Naming a topic scaffolds (or reuses) that topic's workspace and hands back the paste line. That
path asks before its first write, resolves the checkout for **writing**, and is documented in
step 4 below.

Nothing else is accepted: bare is the roster, one topic argument is the scaffold.

## 4. Hand over the paste line

`teach` resolves its own relative paths against its installed directory, so a workspace named any
other way risks the course being written into the plugin cache instead of the repo. **Always name
the workspace absolutely**, every time, and print it rather than describing it:

```
/mattpocock-skills:teach [absolute path to teaching/[topic-slug]]
```

Then stop. Do not attempt to invoke `teach` — it cannot be invoked by a skill, by design.

## Writing

Asks before the first write. Commits only when asked, and **never pushes unasked**. The roster
path writes nothing at all.

---

Not this skill: `/mattpocock-skills:teach` does the teaching itself — the mission interview,
the resource vetting, the lessons — and only a person can start it. `save-thread` is how a lesson
that bears on the project becomes a thread. `assistant-lesson` writes the *other* kind of lesson,
the cross-project `LESSONS.md` entry, and nothing here is ever promoted into it automatically.
`context-setup` and `init-context` are the fixes when no context repo resolves, and
`context-doctor` is what reports drift in a `teaching` block.
