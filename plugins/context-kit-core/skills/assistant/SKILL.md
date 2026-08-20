---
name: assistant
description: List the role assistants a context repo has, or adopt one — a software developer, a financial assistant, an executive assistant — loading its persona, its own memory, the cross-project doctrine it has been given, and its thread history, so the rest of the session is worked in that role. Also scaffolds a new assistant on first use. Triggers like "what assistants do I have", "list my assistants", "which roles are set up here", "be my software developer assistant", "switch to the financial assistant", "adopt the executive assistant", "which assistants do I have", "set up a new assistant", "assistant off".
---

# Adopt a role assistant

A context repo can host several **assistants** — one per role — each with its own durable
memory and its own slice of the thread history. This skill loads one and adopts it for the
rest of the session.

An assistant is a **persona plus a memory slice**, not a subagent. Claude Code subagents are
static files and one-shot delegations; an assistant needs to be a conversation you stay in.
The cost of that choice is stated in step 4.

## 1. Find the repo and the roster

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/context-repo.sh" --no-pull)"
node "${CLAUDE_PLUGIN_ROOT}/scripts/assistants.mjs" roster "$ROOT"
```

`--no-pull` because adopting a persona is a read. If the resolver exits non-zero the problem is
the link, not the assistant — route to `context-setup`.

**No role named, or `list` asked for?** Print the roster and STOP. `roster` shows each
declared role, which of its four files exist, and the registry description where the repo has a
registry. That is a complete answer on its own: someone asking what they have is not
necessarily about to adopt one, and pushing them to choose turns a lookup into a decision.
Offer to adopt one, then wait.

Never guess a role. Adopting the wrong persona silently colours everything that follows.

## 2. Resolve the name

```bash
ROLE="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/assistants.mjs" resolve "$ROOT" --role "[what they said]")"
```

Role names are canonical and committed. The resolver accepts a registered **alias** — "dev"
for `software-dev` — and prints the canonical name; it exits 1 on anything unregistered. A
name that resolves nowhere is not a typo to fix silently: `software-dev` here and `dev` in
another repo would become two half-empty supervisors that never merge, and nothing would
report it. Ask, or add it to the registry deliberately.

The registry lives in whichever repo declares `roles` in its `context.json` — the cross-project
layer. A repo with no registry accepts any kebab-case name, which is fine for a single repo and
a liability once a supervisor exists.

## 3. Load the slice

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/assistants.mjs" paths "$ROOT" --role "$ROLE"
```

Read whichever of the four exist:

| File | What it is | How to treat it |
| --- | --- | --- |
| `PERSONA.md` | how this assistant thinks | adopt it |
| `memory.md` | its durable, project-specific layer | authoritative |
| `DOCTRINE.md` | cross-project doctrine distilled by the supervisor | authoritative, but **never** cite it as the source of a new lesson |
| `LESSONS.md` | what this assistant has sent upward | context, not instruction |

Then its thread history: threads named `YYYY-MM-DD-asst-[role]-topic.md`, or carrying
`assistant: [role]` in front-matter. Read `threads/INDEX.md` for the list rather than opening
every file; open the ones that matter.

**Nothing here is declared missing quietly.** Say which of the four you actually found. An
assistant with no `PERSONA.md` is a memory slice with no personality, and the user should know
that is what they are talking to.

## 4. Adopt it, and say what that does not mean

Work the rest of the session in the role. State plainly, once, what has been adopted and from
where.

**`/assistant off` is advisory.** It restates the base instructions and stops the role framing,
but a persona read into the main session cannot be unread — `DOCTRINE.md` and the assistant's
memory stay in context. If someone needs a genuinely clean slate, that is a new session, and
saying so is more honest than implying the toggle is real.

## 5. Scaffolding a new assistant

If the role resolves but `assistants/[role]/` does not exist, **offer** to create it — the
scaffold is a write, so ask first. Create the directory and:

- **`PERSONA.md`** — written with the user, not generated from the role name. What this
  assistant knows, how it should argue, what it should refuse to do.
- **`memory.md`** — the durable layer, with a `_Last reviewed:_` line dated today
  (`node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" today`).
- **`LESSONS.md`** — a heading and the abstraction rule, ready for `/assistant-lesson`.
- Add the role to `context.json`'s `assistants` block. Declared, never discovered: a folder
  someone happened to create is not an assistant, for the same reason `include` is never read
  off the filesystem.

Also write **`assistants/README.md`** if it is absent — a short summary of the four-file
contract, taken from the `assistant-contract` reference skill. That copy is for **humans who do
not have this plugin**: a colleague can read the repo but has no context-kit, and still needs to
know what these files are before appending a lesson by hand. Keep it a summary that names the
skill as canonical, not a second source of truth.

The contract itself is NOT kept in `c-energie/context-template`. The plugin is the layer with a
distribution mechanism — a marketplace update reaches every repo that enables it, including
repos never stamped from the template. Anything in the template only ever reaches repos created
after it changed.

Do **not** create `DOCTRINE.md`. It is machine-written, arriving from a supervisor via a
`handoff/` item; an empty one invites hand-editing, which is what it exists to prevent.

Scaffolding does not commit. Leave that to the user's normal flow.

**Background:** the four-file contract, and why each rule exists, is `assistant-contract`.

**Not this skill:** recording a transferable lesson for the supervisor is `assistant-lesson`;
distilling lessons across projects is `supervisor-sweep` and `supervisor-distil`; writing up
the session as an ordinary thread is `save-thread`; wiring a project to its context repo is
`context-setup`; checking a repo's config is `context-doctor`.
