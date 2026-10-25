# claude-tools — the c-energie plugin catalog

**c-energie's** Claude Code / Cowork tooling, shipped as one marketplace: the **workspace
context system** (per-project memory that lives in the project's workspace, refreshed
mid-session and written back), its Notion and Slack delivery layers, and the shared diagram
store.

Every plugin ships from this one repo (single fetch — that is what makes installs work on
every surface, including Cowork, which cannot fetch a second private repo):

| Plugin | What it is |
| --- | --- |
| [`plugins/context-kit-core`](plugins/context-kit-core/) | Core layer: the workspace resolver, the SessionStart freshness check, the connection gate, `refresh-context`, `save-thread`, `curate-context`, connector setup |
| [`plugins/context-notion`](plugins/context-notion/) | Notion middle layer: config-driven actions / decisions / open questions, the pending queue, tidies, meeting synthesis and the `notion/` mirror |
| [`plugins/context-slack`](plugins/context-slack/) | Slack delivery layer: the per-person digest and the pending-queue nudge. Nothing here posts unprompted |
| [`plugins/diagrams`](plugins/diagrams/) | Diagram store: capture a diagram Claude just drew into a per-org git store, and build a single-file gallery over one or more of them |
| [`plugins/devhub`](plugins/devhub/) | dev-hub authoring: write or fix a repo's committed `devhub.toml`, and the dev-hub plugin behind it. Outside the context stack — useful in any repo |
| [`plugins/sandcastle`](plugins/sandcastle/) | Sandcastle harness authoring: write or repair a workspace's four agent prompts from that project's own standards. Outside the context stack |
| [`plugins/skills`](plugins/skills/) | Skills for writing skills: `author-setup-skill` scaffolds and audits an interactive setup skill to a fifteen-lesson recipe. Outside the context stack |
| [`plugins/project-workspace`](plugins/project-workspace/) | Document-workspace setup: create and wire the writing and analysis repos from the c-energie templates, adapt an existing document or analysis, add doc-publish. Enabled by the templates' own `.claude/settings.json`. Outside the context stack |

Install: add this repo as a marketplace (`/plugin marketplace add c-energie/claude-tools`, or
Cowork's plugin UI), then install `context-kit-core@c-energie` and — as the project needs
them — `context-notion@c-energie`, `context-slack@c-energie`, `diagrams@c-energie`,
`devhub@c-energie`, `sandcastle@c-energie`, `skills@c-energie`, `project-workspace@c-energie`.

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
read no `workspace.json` and are useful in any repo. The catalog is the org's tooling, not one system's. A repo that
needs both lists both marketplaces in its `extraKnownMarketplaces`; no plugin is ever duplicated
across catalogs.

Two consequences worth stating outright:

- **Read on this catalog covers skill code only.** It is not a grant over anything a plugin
  *reaches* — notably the per-org diagram stores, which are separate repos with their own access,
  named per project in its workspace and never defaulted.
- **`X@context-kit` is dead.** This repo was `c-energie/context-kit` and this catalog was
  `context-kit` at `0.1.0` until 2026-08-31. GitHub redirects the old clone URL, so git keeps
  working — but a stale `enabledPlugins` id does not, and it fails *silently*: the loader ignores
  an unknown catalog rather than reporting it, so it looks exactly like a plugin that crashed on
  load. Catalog `version` `1.0.0` is the marker of that cut. `context-doctor` knows the retired
  name and flags it (`--fix` rewrites it).

## Setting up a new project, end to end

A project's context lives in its **workspace** (ADR 0002, `docs/adr/0002-workspace-replaces-context-repo.md`):
the git repo at its root, marked by `.claude/workspace.json`, whose `CLAUDE.md` imports
`@docs/memory.md`. Context repos, `PROJECT_CONTEXT_REPO`, `init-context` and `context-setup`
were retired in #60.

| Step | Script | Skill over it |
| --- | --- | --- |
| Make the folder a workspace (or adopt a folder of clones) | | `project-workspace:setup-project-workspace` |
| Provision the MCP connections its `workspace.json` declares | `mcp/setup-connectors.mjs` | `setup-connectors` |
| Fill `state.notion` for a Notion-backed project | | `context-notion:notion-discover` |
| Health-check the wiring afterwards | `context-doctor.mjs <workspace dir>` | `context-doctor` |

The core scripts are in [`plugins/context-kit-core/scripts/`](plugins/context-kit-core/scripts/),
all safe to re-run, and none of them writes to the network or to a Claude config without being
asked. Inside a session with the plugin installed, they are at `${CLAUDE_PLUGIN_ROOT}/scripts/…`;
from a checkout of this marketplace, at `plugins/context-kit-core/scripts/…`
(`bash plugins/context-kit-core/scripts/plugin-repo.sh --writable` finds the writable checkout).
Asking for the skill by name does the same work with the prompts and the checks around it.

**`${CLAUDE_PLUGIN_ROOT}` is not a shell variable.** The plugin loader substitutes it into skill
text and hook commands before either runs, and does so *per plugin*, so it resolves for a skill
calling a script inside its own plugin, and expands to **nothing** in a terminal, where
`node "${CLAUDE_PLUGIN_ROOT}/scripts/context-doctor.mjs"` quietly becomes
`node /scripts/context-doctor.mjs`. Setting it by hand is not the fix: one value cannot be right
for several plugins at once, and it would shadow the correct one the loader injects. From a
shell, name the directory instead, or ask the resolver, which answers with the source checkout
rather than the read-only installed copy:

```bash
PLUGIN="$(bash plugins/context-kit-core/scripts/plugin-repo.sh --plugin context-kit-core)"
node "$PLUGIN/scripts/context-doctor.mjs" ~/gh-orgs/corson94/thesis
```

**Optionally, `just`.** A root `justfile` wraps the connector steps so none of those paths have to
be typed. Recipes name a workspace by its directory, and run from anywhere inside this checkout:

```bash
just connector-check ~/gh-orgs/corson94/thesis          # diagnose, changes nothing
just connector-add   ~/gh-orgs/corson94/thesis github   # declare the provider in workspace.json
just connector       ~/gh-orgs/corson94/thesis          # provision, prompting for the credential
```

Convenience only, and today it covers the connector steps alone. `just` is not installed by
default (`winget install --id Casey.Just`) and Cowork sandboxes cannot install it, so **nothing in
this repo may depend on a recipe**: each one is a thin pass-through to the same script, and the
scripts stay the reproducible route. `just connector` needs a real terminal: the credential is read
from a hidden prompt so it never reaches a conversation or a shell history, which also means it
cannot be driven by an agent.

The short form:

1. **Workspace.** `project-workspace:setup-project-workspace` writes `.claude/workspace.json`
   and `CLAUDE.md`, optionally makes the root a git repo of its own, and lists the member
   repos. Anyone cloning a workspace gets its context, so a workspace repo holding meetings or
   the Notion queue must be private even when its members are public.
2. **Connectors.** One scoped credential per provider per workspace (GitHub fine-grained PAT:
   single resource owner per token; Notion internal integration: pages must be shared with
   it), registered as MCP servers named `<provider>-<project>` in the desktop app's
   `claude_desktop_config.json`, the **host registry**, which serves the chat app *and* Cowork
   (the host runs the servers and bridges them into the sandbox, so the token never enters it).
   Claude Code does not read that file: it is given each server **per repo**
   (`claude mcp add-json [name] '[entry]' -s local`, or a committed `.mcp.json`), so a session
   carries only the connections its own project declares rather than every connector on the
   machine. From inside the workspace:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/mcp/setup-connectors.mjs"            # provision what's missing
   node "${CLAUDE_PLUGIN_ROOT}/scripts/mcp/setup-connectors.mjs" --check    # diagnose only
   node "${CLAUDE_PLUGIN_ROOT}/scripts/mcp/setup-connectors.mjs" --add slack
   ```
   It reads the workspace's `connections` block, compares it against what the machine actually
   has, and walks through the gaps, writing both configs, keeping the token in the OS
   credential store rather than in either file, and copying the runtime to `~/.mcp/` so the
   paths survive a plugin update. `mcp/setup.mjs` is the freeform variant with no
   `workspace.json` involved; the details are in
   [`scripts/mcp/README.md`](plugins/context-kit-core/scripts/mcp/README.md).
3. **Gate.** Declare `connections` in `workspace.json`; skills use only what it declares for a
   provider, and `connection-gate.mjs` denies the rest on every MCP call rather than trusting
   them to. A provider may name one connection, or several keyed by resource owner: a
   fine-grained GitHub PAT has a single owner, so a project spanning two needs two connectors
   (`--add github:[owner]`). `setup-connectors.mjs` proposes and writes the block when it is
   missing; `{}` means "this project declares none, deliberately" and is left alone. For
   Cowork, upload the workspace's `.claude/workspace.json` to the project.
4. **Discover.** For Notion-backed projects, the `notion-discover` skill fills
   `workspace.json`'s `state.notion` block from the live Notion workspace.
5. **Verify.** `node "${CLAUDE_PLUGIN_ROOT}/scripts/context-doctor.mjs" <workspace dir>` audits
   the workspace (`--fix` applies only the fixes whose correct value is derivable).
