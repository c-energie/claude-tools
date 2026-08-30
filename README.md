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

Every step has a script, all of them in
[`plugins/context-kit-core/scripts/`](plugins/context-kit-core/scripts/), all safe to re-run,
and none of them writes to the network or to a Claude config without being asked:

| Step | Script | Skill over it |
| --- | --- | --- |
| Create the context repo (and, on the first run ever, the cross-project second brain) | `init-context.mjs <owner>/<project>-context --link . --yes` | `init-context` |
| Point a project repo at an existing context repo | `link-context.mjs <owner>/<project>-context --load` | `context-setup` |
| Opt a project out — it has no context repo, and the hook goes silent | `link-context.mjs none` | `context-setup` |
| Provision the MCP connections the project's `context.json` declares | `mcp/setup-connectors.mjs` | `setup-connectors` |
| Health-check the wiring afterwards | `context-doctor.mjs <path to context checkout>` | `context-doctor` |

Where to run them from: inside a session with the plugin installed, the scripts are at
`${CLAUDE_PLUGIN_ROOT}/scripts/…`; from a checkout of this marketplace, at
`plugins/context-kit-core/scripts/…` (`bash plugins/context-kit-core/scripts/plugin-repo.sh
--writable` finds the writable checkout). Asking for the skill by name does the same work with the
prompts and the checks around it — the scripts are what makes each step reproducible, not a
second way to do it.

The full narrative checklist lives in the
[context-template README](https://github.com/c-energie/context-template); the short form:

1. **Context repo** — stamp from the template and fill the placeholders:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init-context.mjs" <owner>/<project>-context            # plan only
   node "${CLAUDE_PLUGIN_ROOT}/scripts/init-context.mjs" <owner>/<project>-context --link . --yes
   ```
   Without `--yes` it prints the plan and touches nothing. `--link .` also does step 2 for the
   project you run it in.
2. **Point the project at it** — `PROJECT_CONTEXT_REPO` in the project's `.claude/settings.json`
   (laptop), a `context-project.json` marker attached to the Cowork project (sandbox) —
   JSON carrying `contextRepo` plus a `connections` map naming the MCP connection per
   provider, so the bootstrap read uses the right one of several scoped connectors. Rather than
   hand-editing that file, from the project's own directory:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/link-context.mjs" <owner>/<project>-context --load
   ```
   It verifies the repo resolves *before* writing, merges the key into `.claude/settings.json`
   without disturbing the rest (`--local` targets `settings.local.json`, `--force` re-points an
   already-linked project), and `--load` reads the context into the *running* session instead of
   the next one. The repo is an argument, never inferred from the git remote. There is
   deliberately no default: unconfigured sessions say so rather than loading another project's
   context. A project with no context repo of its own runs
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/link-context.mjs" none` and the session-start hook goes
   quiet for it — including the marker search.
3. **Connectors** — one scoped credential per provider per workspace (GitHub fine-grained PAT:
   single resource owner per token; Notion internal integration: pages must be shared with
   it), registered as MCP servers named `<provider>-<project>` in **both** `~/.claude.json`
   (Claude Code + Cowork sandboxes read this) and the desktop app's
   `claude_desktop_config.json` (chat reads this). From a project whose context repo is
   configured:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/mcp/setup-connectors.mjs"            # provision what's missing
   node "${CLAUDE_PLUGIN_ROOT}/scripts/mcp/setup-connectors.mjs" --check    # diagnose only
   node "${CLAUDE_PLUGIN_ROOT}/scripts/mcp/setup-connectors.mjs" --add slack
   ```
   It reads the project's `connections` block, compares it against what the machine actually
   has, and walks through the gaps — writing both configs, keeping the token in the OS
   credential store rather than in either file, and copying the runtime to `~/.mcp/` so the
   paths survive a plugin update. `mcp/setup.mjs` is the freeform variant with no `context.json`
   involved; the details are in
   [`scripts/mcp/README.md`](plugins/context-kit-core/scripts/mcp/README.md).
4. **Gate** — declare `connections` in `context.json`; skills use only the declared
   connection per provider. `setup-connectors.mjs` proposes and writes the block when it is
   missing; `{}` means "this project declares none, deliberately" and is left alone. Optional
   hard `deny` rules in other projects' laptop settings.
5. **Discover** — for Notion-backed projects, the `notion-discover` skill fills
   `context.json`'s `state` block from the live workspace.
6. **Verify** — the `context-setup` skill checks the whole chain in one pass, and
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/context-doctor.mjs" ~/.context/<owner>/<repo>` audits the
   context repo itself (`--fix` applies only the fixes whose correct value is derivable).
