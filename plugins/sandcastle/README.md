# sandcastle

Authoring skills for the [Sandcastle harness](https://github.com/c-energie/sandcastle-harness) —
the agent-orchestration engine a workspace installs as `@c-energie/sandcastle-harness` and drives
with one `sandcastle.config.mts`.

Install from the `c-energie` catalog: `sandcastle@c-energie`. It needs nothing else — no context
repo, no Notion, no Slack.

| Skill | What it does |
| --- | --- |
| `sandcastle-prompts` | Write or repair the four prompts in a workspace's `.sandcastle/` — implementer, per-issue reviewer, group reviewer, planner — from that project's own CLAUDE.md, CODING_STANDARDS.md, test configuration and CI |

## Why this exists

A harness install splits about 85/15. The 85% is the engine, and it is a versioned dependency
now. The 15% is per project: the config, the Dockerfile, and **the prompts**.

The config is mechanical — a member table, an image name, some paths. The prompts are the
judgement, and they are the part that has already gone wrong. When the engine was first ported
into a second workspace, its prompts were drafted from the *workspace* `CLAUDE.md` alone and
missed most of the member's own `.sandcastle/CODING_STANDARDS.md`. The agent then produced work
that was correct against the rules it had been given and wrong against the rules that existed —
and the reviewer, reading the same incomplete prompts, approved it.

That is the failure this skill is built around. Its method is source-first: inventory every
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
└── skills/sandcastle-prompts/
    ├── SKILL.md                               the method
    └── references/contract.md                 placeholders and output blocks
```
