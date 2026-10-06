# claude-tools — the c-energie plugin catalog

**c-energie's** Claude Code / Cowork tooling, shipped as one marketplace: the
**context-repo system** (per-project memory that sessions load at start, refresh mid-session
and write back), its Notion and Slack delivery layers, and the shared diagram store.

Every plugin ships from this one repo (single fetch — that is what makes installs work on
every surface, including Cowork, which cannot fetch a second private repo):

| Plugin | What it is |
| --- | --- |
| [`plugins/context-kit-core`](plugins/context-kit-core/) | Core layer: SessionStart context loading (with visible status line), the context-repo resolvers, `refresh-context`, `save-thread`, `curate-context`, connector setup |
| [`plugins/context-notion`](plugins/context-notion/) | Notion middle layer: config-driven actions / decisions / open questions, the pending queue, tidies, meeting synthesis and the `notion/` mirror |
| [`plugins/context-slack`](plugins/context-slack/) | Slack delivery layer: the per-person digest and the pending-queue nudge. Nothing here posts unprompted |
| [`plugins/diagrams`](plugins/diagrams/) | Diagram store: capture a diagram Claude just drew into a per-org git store, and build a single-file gallery over one or more of them |
| [`plugins/devhub`](plugins/devhub/) | dev-hub authoring: write or fix a repo's committed `devhub.toml`, and the dev-hub plugin behind it. Outside the context stack — useful in any repo |
| [`plugins/sandcastle`](plugins/sandcastle/) | Sandcastle harness authoring: write or repair a workspace's four agent prompts from that project's own standards. Outside the context stack |
| [`plugins/skills`](plugins/skills/) | Skills for writing skills: `author-setup-skill` scaffolds and audits an interactive setup skill to a fifteen-lesson recipe. Outside the context stack |

Install: add this repo as a marketplace (`/plugin marketplace add c-energie/claude-tools`, or
Cowork's plugin UI), then install `context-kit-core@c-energie` and — as the project needs
them — `context-notion@c-energie`, `context-slack@c-energie`, `diagrams@c-energie`,
`devhub@c-energie`, `sandcastle@c-energie`, `skills@c-energie`.

## One catalog per org

**The catalog is named `c-energie`, not `claude-tools`** — identifiers read
`context-kit-core@c-energie`. That is deliberate, and it is the rule for where a new plugin
goes:

> **A separate GitHub org gets a separate catalog. The same people plus a new topic gets a new
> plugin in this one.**

A marketplace is a **permission** boundary: read on this repo is what a person gets, and it is
all-or-nothing across every plugin in it. A plugin is a **topic** boundary, and costs nothing to
add. So `diagrams`, `devhub` and `sandcastle` — new topics for the same people — are plugins here, while
`net-flex`, a different org with a different membership, gets its own `net-flex/claude-tools`.
Note that a plugin here need not belong to the context stack at all: `devhub` and `sandcastle`
read no `context.json` and are useful in any repo. The catalog is the org's tooling, not one system's. A repo that
needs both lists both marketplaces in its `extraKnownMarketplaces`; no plugin is ever duplicated
across catalogs.

Two consequences worth stating outright:

- **Read on this catalog covers skill code only.** It is not a grant over anything a plugin
  *reaches* — notably the per-org diagram stores, which are separate repos with their own access,
  named per project in `context.json` and never defaulted.
- **`X@context-kit` is dead.** This repo was `c-energie/context-kit` and this catalog was
  `context-kit` at `0.1.0` until 2026-08-31. GitHub redirects the old clone URL, so git keeps
  working — but a stale `enabledPlugins` id does not, and it fails *silently*: the loader ignores
  an unknown catalog rather than reporting it, so it looks exactly like a plugin that crashed on
  load. Catalog `version` `1.0.0` is the marker of that cut. `context-doctor` knows the retired
  name and flags it (`--fix` rewrites it).

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

**`${CLAUDE_PLUGIN_ROOT}` is not a shell variable.** The plugin loader substitutes it into skill
text and hook commands before either runs, and does so *per plugin* — so it resolves for a skill
calling a script inside its own plugin, and expands to **nothing** in a terminal, where
`node "${CLAUDE_PLUGIN_ROOT}/scripts/init-context.mjs"` quietly becomes
`node /scripts/init-context.mjs`. Setting it by hand is not the fix: one value cannot be right for
three plugins at once, and it would shadow the correct one the loader injects. From a shell, name
the directory instead — `plugins/context-kit-core/scripts/…` inside a checkout, or ask the
resolver, which answers with the source checkout rather than the read-only installed copy:

```bash
PLUGIN="$(bash plugins/context-kit-core/scripts/plugin-repo.sh --plugin context-kit-core)"
node "$PLUGIN/scripts/init-context.mjs" <owner>/<project>-context
```

**Optionally, `just`.** A root `justfile` wraps the connector steps so none of those paths have to
be typed. Recipes name a context repo as `<owner>/<repo>`, matching the `~/.context` clone layout,
and run from anywhere inside this checkout:

```bash
just connector-check corson94/thesis-context          # diagnose, changes nothing
just connector-add   corson94/thesis-context github   # declare the provider in context.json
just connector       corson94/thesis-context          # provision, prompting for the credential
```

Convenience only, and today it covers the connector steps alone. `just` is not installed by
default (`winget install --id Casey.Just`) and Cowork sandboxes cannot install it, so **nothing in
this repo may depend on a recipe** — each one is a thin pass-through to the same script, and the
scripts stay the reproducible route. `just connector` needs a real terminal: the credential is read
from a hidden prompt so it never reaches a conversation or a shell history, which also means it
cannot be driven by an agent.

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
   it), registered as MCP servers named `<provider>-<project>` in the desktop app's
   `claude_desktop_config.json` — the **host registry**, which serves the chat app *and*
   Cowork (the host runs the servers and bridges them into the sandbox, so the token never
   enters it). Claude Code does not read that file: it is given each server **per repo**
   (`claude mcp add-json [name] '[entry]' -s local`, or a committed `.mcp.json`), so a session
   carries only the connections its own project declares rather than every connector on the
   machine. From a project whose context repo is configured:
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
4. **Gate** — declare `connections` in `context.json`; skills use only what it declares for a
   provider, and `connection-gate.mjs` denies the rest on every MCP call rather than trusting
   them to. A provider may name one connection, or several keyed by resource owner — a
   fine-grained GitHub PAT has a single owner, so a project spanning two needs two connectors
   (`--add github:[owner]`). `setup-connectors.mjs` proposes and writes the block when it is
   missing; `{}` means "this project declares none, deliberately" and is left alone. Optional
   hard `deny` rules in other projects' laptop settings.
5. **Discover** — for Notion-backed projects, the `notion-discover` skill fills
   `context.json`'s `state` block from the live workspace.
6. **Verify** — the `context-setup` skill checks the whole chain in one pass, and
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/context-doctor.mjs" ~/.context/<owner>/<repo>` audits the
   context repo itself (`--fix` applies only the fixes whose correct value is derivable).
