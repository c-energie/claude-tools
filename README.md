# context-kit (marketplace)

The c-energie plugin marketplace for the **context-repo system**: per-project memory that
Claude sessions load at start, refresh mid-session, and write back — plus delivery layers
(Notion, Slack) driven entirely by each project's configuration.

Three plugins, all shipped from this one repo (single fetch — that is what makes installs
work on every surface, including Cowork, which cannot fetch a second private repo):

| Plugin | What it is |
| --- | --- |
| [`plugins/context-kit-core`](plugins/context-kit-core/) | Core layer: SessionStart context loading (with visible status line), the context-repo resolvers, `refresh-context`, `save-thread`, `curate-context`, connector setup |
| [`plugins/context-notion`](plugins/context-notion/) | Notion middle layer: config-driven actions / decisions / open questions, the pending queue, tidies, meeting synthesis and the `notion/` mirror |
| [`plugins/context-slack`](plugins/context-slack/) | Slack delivery layer: the per-person digest and the pending-queue nudge. Nothing here posts unprompted |

Install: add this repo as a marketplace (`/plugin marketplace add c-energie/context-kit`, or
Cowork's plugin UI), then install `context-kit-core@context-kit` and — as the project needs
them — `context-notion@context-kit` and `context-slack@context-kit`.

## Setting up a new project, end to end

The full checklist lives in the
[context-template README](https://github.com/c-energie/context-template); the short form:

1. **Context repo** — stamp from the template, fill the placeholders.
2. **Point the project at it** — `PROJECT_CONTEXT_REPO` in the project's `.claude/settings.json`
   (laptop), a `context-project.json` marker attached to the Cowork project (sandbox) —
   JSON carrying `contextRepo` plus a `connections` map naming the MCP connection per
   provider, so the bootstrap read uses the right one of several scoped connectors. There is
   deliberately no default: unconfigured sessions say so rather than loading another
   project's context. A project with no context repo of its own sets the value to `none`
   (`node plugins/context-kit-core/scripts/link-context.mjs none`) and the session-start hook
   goes quiet for it — including the marker search.
3. **Connectors** — one scoped credential per provider per workspace (GitHub fine-grained PAT:
   single resource owner per token; Notion internal integration: pages must be shared with
   it), registered as MCP servers named `<provider>-<project>` in **both** `~/.claude.json`
   (Claude Code + Cowork sandboxes read this) and the desktop app's
   `claude_desktop_config.json` (chat reads this).
4. **Gate** — declare `connections` in `context.json`; skills use only the declared
   connection per provider. Optional hard `deny` rules in other projects' laptop settings.
5. **Discover** — for Notion-backed projects, the `notion-discover` skill fills
   `context.json`'s `state` block from the live workspace.
6. **Verify** — the `context-setup` skill checks the whole chain in one pass.
