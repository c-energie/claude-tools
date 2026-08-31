---
name: update-plugin
description: Change the context plugins themselves — add or edit a skill, hook or script in the c-energie/claude-tools marketplace repo (context-kit-core or context-notion) — then check the manifests, bump that plugin's version, commit and push. Use whenever the user asks to add, write, create, edit, rename, fix or delete a skill, slash command or hook, or to release a plugin. Triggers like "add a skill that does X", "write me a skill for X", "edit the refresh-context skill", "change the session-start hook", "the plugin is broken", "bump and release the plugin".
---

# Update the context plugins

Edits the plugins' **own source repo** — `c-energie/claude-tools`, a marketplace holding one
directory per plugin under `plugins/` — and releases the change: check, bump, commit, push.
Step 2 reads the current roster off the checkout, so this file never names a fixed set.

**This skill is deliberately auto-invocable** so that "add a skill that does X" lands here rather
than a loose file written into whatever repo happens to be open. Editing is fine to do on your own
initiative. **The push is not** — step 5 stops and asks, every time. That is the safety property
the repo-writing skills (`save-thread`, `curate-context`) get from `disable-model-invocation`,
kept here as an explicit gate instead of a blanket block.

**The trap this skill exists to avoid:** when a plugin is installed from the marketplace,
`${CLAUDE_PLUGIN_ROOT}` points at the *installed copy* under `~/.claude/plugins/`. It has no push
remote, and the plugin manager overwrites it on the next update. Edits made there look like they
worked and then vanish. Always go through step 1.

## 1. Find the plugin checkout

```bash
ROOT="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-repo.sh" --writable)"
```

Uses the current repo if its `origin` is `c-energie/claude-tools`, otherwise the managed clone at
`${CONTEXT_KIT_PLUGIN_DIR:-$HOME/c-energie/claude-tools}` (cloning if missing); un-shallows it so
the push can succeed, and pulls `--ff-only --autostash`. It prints the repo root on stdout and
exits non-zero with a reason if the repo can't be reached — if that happens, say so and stop
rather than editing the installed copy.

`$ROOT` is the **marketplace root** — where you commit and push. One plugin's own directory,
which is what the per-plugin scripts take, comes from the same resolver:

```bash
PLUGIN="$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-repo.sh" --plugin context-kit-core)"
```

Today's date: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dates.mjs" today`.

If `scripts/plugin-repo.sh` is missing from the installed plugin (packaging is only documented to
ship `skills/`, `commands/`, `agents/` and `hooks/`), fall back to
`git clone https://github.com/c-energie/claude-tools.git ~/c-energie/claude-tools` and work there.
(Not under `~/.context` — that root is for context repos, the data; this is a tool.)

## 2. Decide which plugin the change belongs to

**First, list the plugins that actually exist.** Read the roster off the checkout rather than
trusting any written list — including the one below:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/list-plugins.mjs" "$ROOT" --brief   # one line per plugin
node "${CLAUDE_PLUGIN_ROOT}/scripts/list-plugins.mjs" "$ROOT"           # ...plus each one's skills
```

`--brief` is the roster: every plugin, its version and how many skills it has. Without it, each
plugin's skills are listed too, flagged `[no-auto]` (`disable-model-invocation: true`) and
`[reference]` (`user-invocable: false`) — use that to check whether the job is **already
someone's**, since editing an existing skill beats adding a near-duplicate that then competes
with it for the same trigger phrases. `--json` gives the same data machine-readably.

A hand-written roster in this file is the thing to avoid: it listed two plugins for the whole time
`context-slack` had been shipping, and a resolver fix following it would have left that plugin's
copy of `context-repo.sh` behind.

**Then place the change by layer.** This is the judgement the marketplace layout adds, and getting
it wrong is how the layering rots. The rule is *which facts a change is allowed to know*:

- **`context-kit-core`** — generic context machinery with no backend: loading, refreshing and
  writing *a* project's context repo, the resolvers, the session-start hook, connector setup.
  Nothing here may name a project, a workspace, or a database.
- **`context-notion`** — the Notion middle layer: skills driven entirely by each project's
  `context.json` (`state.notion`). Database IDs, property schemas and rosters live in the
  **project's context repo**, never in the plugin.
- **`context-slack`** — the Slack delivery layer: skills driven by `connections.slack`,
  `defaults.slackChannel` and the roster's `slackMemberId`. No channel, member ID or workspace
  name in the plugin. **Everything here is `disable-model-invocation: true`, without exception** —
  a Slack message is visible the instant it lands and cannot be recalled, so a new skill that
  posts inherits that blanket block rather than a per-skill judgement.
- **Neither** — anything specific to one project or one workspace belongs in that project's own
  context repo, not in a plugin. Say so rather than filing it under the closest plugin.

If the roster shows a plugin this list does not describe, the same test still decides it: name the
facts the change needs, and put it in the layer allowed to know them.

## 3. Make the change

Read the neighbouring files first and match them — these are conventions the repo already holds,
not suggestions. Each plugin has its own `CLAUDE.md` stating its invariants; read that one.

### Adding or editing a skill (`plugins/[plugin]/skills/[name]/SKILL.md`)

- The directory name and the front-matter `name` **must match**.
- `description` is what makes the skill auto-trigger: say what it does *and* list natural trigger
  phrases. One line, no wrapping.
- **No angle brackets in any front-matter value.** The ingester reads them as a tag and silently
  drops the field — this stranded an earlier plugin at 13/15 skills in Cowork (July 2026). Use
  `[placeholder]` or `{placeholder}` in front-matter. Body text is fine.
- Set `disable-model-invocation: true` on anything that **writes outside the session** — commits
  to a shared repo, posts to a channel. Those run only when the user names them.
- Set `user-invocable: false` for reference-only skills that are background knowledge rather than
  a task (`context-access` and `notion-config` are the two).
- End with a **"Not this skill:"** line pointing at the neighbouring skills that own the adjacent
  jobs, so the model routes correctly.

### Where things belong

- **Nothing project-specific in a plugin.** Database IDs, people and workspace names come from the
  project's `context.json` at runtime; the plugin only knows the *keys*. A hard-coded ID is the
  bug this whole layering exists to prevent.
- **Anything that must come out identically every time** (date maths, due-date buckets, mirror
  rendering, index rebuilds) belongs in a `scripts/*.mjs`, not in prose. Scripts are
  dependency-free Node ESM and take `--today` where dates are involved, so their output can be
  pinned. context-notion's shared helpers live in its `scripts/lib.mjs`.
- **Reference scripts by their full path under `${CLAUDE_PLUGIN_ROOT}`** — never a relative path.
  `check-plugin.mjs` verifies every such path exists, and a skill can only reference scripts in
  **its own** plugin: plugins cannot reach into each other's install directories.
- **Some scripts are deliberate copies, and `check-plugin.mjs` enforces it.** A skill can only
  reference `${CLAUDE_PLUGIN_ROOT}/scripts/...` in its *own* plugin, so anything a skill calls at
  runtime is duplicated: `context-repo.sh` and `dates.mjs` in all three, `lib.mjs` and
  `pending-parse.mjs` in context-notion and context-slack. Fix the **origin** first, then copy it
  over the others, keeping only each copy's header banner. The linter compares below that banner
  and errors on any other difference, naming the direction to copy.

  The origin is decided by **layer, not by who uses it most**: `context-repo.sh` and `dates.mjs`
  originate in **context-kit-core** because both are generic — a script with no backend in it
  belongs to core even when Notion skills are its heaviest callers. `lib.mjs` and
  `pending-parse.mjs` originate in **context-notion**, the only layer entitled to know
  `state.notion`, Notion user IDs and the queue format. Putting generic machinery in a backend
  layer is the same layering error as a hard-coded database ID, just pointing the other way.
- **A script no skill calls does not need a copy.** `check-plugin.mjs` and `bump-version.mjs`
  take the target plugin's directory as an argument and run from the checkout, so they live in
  context-kit-core alone — run them as
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-plugin.mjs" "$PLUGIN"` whichever plugin `$PLUGIN` is.
  They were duplicated once and drifted; don't re-add copies.
- New `.sh` files must be **LF**, per the root `.gitattributes`.
- If the new skill is **recurring**, add a line to context-notion's `weekly-review` — that file is
  the source of truth for what runs each week, and a recurring skill missing from it simply never
  runs. Most skills are on-demand; only add it if it genuinely belongs in the weekly cadence.
- Update the plugin's `README.md` skills table and layout tree, and — if the change touches an
  invariant — its `CLAUDE.md`.
- `marketplace.json` at the repo root names every plugin with a relative source. Keep it to
  source / category / tags: a `version` or `description` there **silently overrides**
  `plugin.json`. There is no root-level linter, so hand-verify it after any edit.

### Editing hooks (`plugins/context-kit-core/hooks/`)

A hook runs on **every session** where the plugin is enabled. It must never prompt, never hang,
and never block: `exit 0` on every path, `GIT_TERMINAL_PROMPT=0` on any git call, and degrade to
a short "unavailable" message rather than an error. `load-context.sh` carries an inline duplicate
of `scripts/context-repo.sh` as a fallback for the case where packaging drops `scripts/` — if you
change the resolver, change both, and keep the opt-out sentinel list in step across all four
places that know it.

## 4. Check before you bump

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-plugin.mjs" "$PLUGIN"
```

Run it **per plugin, on that plugin's own directory** — and on both if the change touched both.
It catches the silent failures: front-matter angle brackets, a `name` that doesn't match its
directory, a missing `description`, a `${CLAUDE_PLUGIN_ROOT}` path pointing at a file that isn't
there, CRLF in a `.sh`, and a `version`/`description` in a `marketplace.json` entry that would
override `plugin.json`. **Exit 1 means fix it before committing** — every one of these installs
cleanly and then just doesn't work. Warnings are judgement calls; read them and decide.

Where practical, also run the scripts you touched — there is no test suite, so running them is
the check. For the hook, run it both ways (session mode and `--refresh`) against a configured
project and an unconfigured one.

## 5. Bump the version

```bash
NEW="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/bump-version.mjs" "$PLUGIN" patch)"
```

`patch` for a fix or a wording change, `minor` for a new skill or a new capability, `major` for a
breaking change. The script writes that plugin's **`.claude-plugin/plugin.json` only**, preserving
its formatting, and refuses to run if a `marketplace.json` `plugins[]` entry declares a `version`
— that override silently wins and is what stranded an install on an old release in July 2026.
Do not hand-edit the version anywhere else. **Bump each plugin you actually changed**, and only
those: the two version numbers move independently.

**Always bump — but once per release, not once per edit.** Clients update on the version, so an
unbumped change reaches nobody. If the version has already been bumped for a change that has not
been pushed yet, leave it alone rather than bumping twice; `bump-version.mjs` with no bump
argument prints the current version so you can check.

## 6. Show the change, then ask before pushing

**Stop here and ask the user.** Show what changed — `git -C "$ROOT" status --short` and a diff
summary — and get an explicit yes before the push. This is a shared repo people install from: an
unwanted commit is public and awkward to walk back, and the user may want to review a skill's
wording before it lands. Never fold the push into an earlier step's command chain.

Committing locally without pushing is fine to offer if they want to look first.

Once they agree, stage only what you touched and include the new version in the message, as
`[area]: [what changed]; [plugin] v[NEW]`:

```bash
git -C "$ROOT" add [paths]
git -C "$ROOT" commit -m "skills: [what changed]; context-kit-core v$NEW"
git -C "$ROOT" push
```

Small edits go straight to `main`; open a PR instead for a change that alters how installed
skills behave. Report the files changed, the new version(s), and the pushed commit.

## 7. Tell the user what they still have to do

- **This session is still running the old code.** Skill and hook changes take effect on the next
  session, after the client picks up the new version.
- To pull it: `/plugin marketplace update c-energie` in Claude Code. In **Cowork** there is no
  `/plugin` command — update from the plugin UI.
- Note the marketplace-name trap if an update doesn't land: a client that registers a marketplace
  by *repository* name rather than by its declared `name` produces a different `plugin@marketplace`
  key than the one a repo's `.claude/settings.json` `enabledPlugins` block names. Here the two
  differ on purpose: the repo is `claude-tools`, the catalog it declares is `c-energie`.
- **`X@context-kit` is dead.** The catalog was renamed from `context-kit` to `c-energie` on
  2026-08-31 (and the repo from `context-kit` to `claude-tools`), and its `version` went to
  `1.0.0` to mark exactly that. A stale id enables nothing and is *silently ignored* rather than
  rejected, so it looks identical to a plugin that failed to load. `context-doctor` knows the
  retired name and flags it; `--fix` rewrites it.

**Not this skill:** writing up work into a project's shared *context* repo is `save-thread` and
`curate-context` — a different repo entirely.
