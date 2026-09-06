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

Nothing else is accepted: bare is the roster, one topic argument is the scaffold.

### 3a. Preview first, always

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/teaching-workspace.mjs" scaffold "$ROOT" "[the topic]"
```

Plan is the default and it **writes nothing**. Show the user every path it would create, the
two it deliberately would not, and the `context.json` block it would add. Then ask.

### 3b. Ask for the audience — do not pick one

The plan will refuse to write without `--audience`, and that refusal is the feature. `working`,
`team` or `external`: the same vocabulary a thread's front-matter uses, and this workspace's
audience is also the default audience for any thread it produces.

**Absent is absent.** A script must not invent a classification of who may read something — a
`working` chosen by a tool is indistinguishable from one a person chose, and only one of those is
true. Ask, and take the answer.

### 3c. Resolve for writing, then write

Only now, and only after the user has agreed:

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --writable)"
node "${CLAUDE_PLUGIN_ROOT}/scripts/teaching-workspace.mjs" scaffold "$ROOT" "[the topic]" \
  --audience [working|team|external] --yes
```

`--writable` deepens the shallow clone so a later push can succeed. It is the only network
operation this skill performs, it belongs to this path alone, and it happens **after** consent —
never on the roster path.

What it creates: the four directories `teach` expects, a workspace `NOTES.md` carrying the
standing instructions, a `teaching/README.md` **once per repo**, and the declaration in
`context.json`. A `.gitkeep` goes in each directory because git does not track directories, and a
workspace that vanishes at the first commit is not in the repo in any sense that matters.

Three things about that write are deliberate and should survive review:

- **`MISSION.md` and `RESOURCES.md` are not created.** `teach` treats an unpopulated mission as
  its signal to interview the user, and an absent resources file as its signal to go and vet
  sources. A helpful-looking stub reads as populated and suppresses both — the two behaviours
  that make its output grounded rather than invented. Their absence is the feature.
- **An existing topic is reused, never suffixed.** One mission per workspace is `teach`'s whole
  model, so `deep-learning-2` is almost always a mistake. Say plainly that you handed back the
  existing workspace, and hand back its paste line. Existing files are never overwritten.
- **The mission path is declared before `teach` writes it**, so the roster and `context-doctor`
  will report it as unresolved until the first teaching session. Say so once, so it does not read
  as a fault later. It is the honest state of a workspace that is prepared but not yet started.

## 4. Hand over the paste line

`teach` resolves its own relative paths against its installed directory, so a workspace named any
other way risks the course being written into the plugin cache instead of the repo. **Always name
the workspace absolutely**, every time, and print it rather than describing it:

```
/mattpocock-skills:teach [absolute path to teaching/[topic-slug]]
```

The script prints this line already built. **Print it; do not paraphrase it and do not relativise
it.** Then say which files belong in that workspace — `lessons/`, `reference/`,
`learning-records/`, `assets/`, and the `MISSION.md` and `RESOURCES.md` that `teach` itself will
write — so the person knows what they are about to fill.

Then stop. Do not attempt to invoke `teach` — it cannot be invoked by a skill, by design.

## Writing

Asks before the first write. Commits only when asked, and **never pushes unasked**. The roster
path writes nothing at all.

If the user wants the workspace committed, commit the scaffold and the `context.json`
declaration together: the directories and the block that declares them are one change, and a
declaration without its directory is precisely what `context-doctor` reports as drift.

---

Not this skill: `/mattpocock-skills:teach` does the teaching itself — the mission interview,
the resource vetting, the lessons — and only a person can start it. `save-thread` is how a lesson
that bears on the project becomes a thread. `assistant-lesson` writes the *other* kind of lesson,
the cross-project `LESSONS.md` entry, and nothing here is ever promoted into it automatically.
`context-setup` and `init-context` are the fixes when no context repo resolves, and
`context-doctor` is what reports drift in a `teaching` block.
