# sandcastle

Authoring skills for the [Sandcastle harness](https://github.com/c-energie/sandcastle-harness) —
the agent-orchestration engine a workspace installs as `@c-energie/sandcastle-harness` and drives
with one `sandcastle.config.mts`.

Install from the `c-energie` catalog: `sandcastle@c-energie`. It needs nothing else — no context
repo, no Notion, no Slack.

| Skill | What it does |
| --- | --- |
| `sandcastle-install` | Install the harness into a workspace and get it to a verified, token-free green state — decide whether the root is an interdependent uv/npm workspace or a clone root, write the member table and prompt sets, wire the env, hand-write the Dockerfile, then prove it with smoke and preflight |
| `sandcastle-prompts` | Write or repair the five prompts in a workspace's `.sandcastle/` — implementer, per-issue reviewer, group reviewer, revision, planner — from that project's own CLAUDE.md, CODING_STANDARDS.md, test configuration and CI |
| `sandcastle-epic-prep` | Get issues across one or more repos ready for an `--epic` run — audit native blocked-by links against dependencies written only in text, find a parent the epic can start from, check membership and labels, then apply the missing links, parent and edits as one approved plan |

The two are a pair, in that order: `sandcastle-install` gets a workspace wired and verified,
`sandcastle-prompts` writes the briefs the agent is actually told the rules by. `sandcastle-epic-prep` comes after both, once there is a
backlog to run: `--epic` obeys only native GitHub links, and a backlog whose order lives in issue
text plans as a flat pile of ready tasks. Each is useful
without the others — a workspace already installed needs only the second; a workspace whose
prompts are fine but whose image will not build needs only the first.

## Why this exists

A harness install splits about 85/15. The 85% is the engine, and it is a versioned dependency
now. The 15% is per project: the config, the Dockerfile, and **the prompts**.

Both halves are judgement, and this README used to say otherwise — that the config was
"mechanical: a member table, an image name, some paths". A third install disproved it. The member
table encodes whether the members import each other at all, which decides the Dockerfile, whether
`importName` means anything, and which verification steps can ever pass; `dir` and `importName`
are not derivable from the folder names; and how many prompt sets the workspace wants is a claim
about how many *kinds* of repository it holds. None of that is mechanical, and none of it is
visible to the scaffolder, which has never seen the repo. That is what `sandcastle-install`
records.

The prompts are the other half, and they are the part that has already gone wrong. When the engine was first ported
into a second workspace, its prompts were drafted from the *workspace* `CLAUDE.md` alone and
missed most of the member's own `.sandcastle/CODING_STANDARDS.md`. The agent then produced work
that was correct against the rules it had been given and wrong against the rules that existed —
and the reviewer, reading the same incomplete prompts, approved it.

That is the failure `sandcastle-prompts` is built around. Its method is source-first: inventory every
governing document the project has, state which prompt carries each one, and name what was looked
for and not found. A project with no standards document is a fine answer; a project with one that
nobody noticed is the bug.

## Why a plugin and not part of the context stack

It reads no `context.json` and needs no context repo. It is useful in any workspace that has
installed the harness, which is a topic boundary of its own — the same reason `devhub` and
`diagrams` are separate plugins rather than skills inside `context-kit-core`.

Filing it under `context-kit-core` would put facts about the harness's placeholder contract and
its output blocks into the layer whose whole rule is that it knows nothing but generic context
machinery.

## Where the truth lives

`c-energie/sandcastle-harness` owns the contract; this plugin only teaches it.
`skills/sandcastle-prompts/references/contract.md` is a restatement of what
`src/sandbox.mts` renders and what `src/plan.mts` parses. **When the harness changes, this plugin
is downstream:** update that reference from the engine's own behaviour, then bump. Never the other
way round — a skill describing a placeholder the engine does not pass produces a prompt with a
literal `{{TYPO}}` in the middle of it, which is exactly the class of failure it exists to
prevent.

## Layout

```
plugins/sandcastle/
├── .claude-plugin/plugin.json
├── CLAUDE.md                                  the invariants
├── README.md                                  this file
├── scripts/epic-audit.mjs                     read-only audit of a backlog for --epic (ports the harness's textLinksIn)
└── skills/
    ├── sandcastle-install/SKILL.md            wiring and verifying a workspace
    ├── sandcastle-prompts/
    │   ├── SKILL.md                           the method
    │   └── references/contract.md             the five prompts, placeholders per pass, output blocks
    └── sandcastle-epic-prep/SKILL.md          native links, parent, members, then one approved plan
```
