# CLAUDE.md

## What this plugin is

The **dev-hub authoring** layer, `plugins/devhub` inside `c-energie/claude-tools`. One skill,
`devhub-feature`, which writes a repo's committed `devhub.toml` and the dev-hub plugin behind it.

It is deliberately **outside the context stack**. It reads no `context.json`, needs no context
repo, and is useful in any repo at all — a docs repo with two static features has as much use for
it as a context repo does. Filing it under `context-kit-core` because both are "tooling" would put
a fact about dev-hub's manifest format in the layer whose whole rule is that it knows nothing but
generic context machinery.

Moved out of one person's `~/.claude/skills/` on 2026-08-31. That location is invisible to Cowork
(sandbox sessions load the skills enabled for the claude.ai account), invisible to everyone else,
and carries no version, so it could never be updated — three reasons a shared convention about a
committed file format does not belong there.

## Where the truth lives

**`c-energie/dev-hub` owns the format; this plugin only teaches it.** Every rule in the skill is a
restatement of what `devhub validate --manifest` already enforces. So:

- **When dev-hub changes, this plugin is downstream.** A new key, a new mode, a relaxed rule —
  update `references/schema.md` or `references/plugin.md` from the CLI's own behaviour, then bump.
  Never the other way round: a skill that describes a key dev-hub does not have produces a manifest
  that fails validation, which is the exact failure the skill exists to prevent.
- **The check is `devhub validate --manifest`, not prose here.** The skill's job is to get the five
  judgements right *before* the file is written; validation is what proves it. Anything that must
  come out identically every time already lives in that CLI.

## Invariants

- **The skill auto-triggers and that is correct** — it writes files in the repo you are standing
  in, and it **never commits, never edits a catalogue, never installs dev-hub**. Those boundaries
  are stated in the skill's own "What this does not do" section; a change that crosses one of them
  needs `disable-model-invocation: true` or an explicit ask-gate, per the marketplace rule.
- **No angle brackets in the front-matter.** The body is full of `<owner/repo>` and that is fine;
  the `description` must stay clear of them or the ingester drops the field and the skill silently
  never appears.
- **The references are read on demand, not inlined.** `schema.md` and `plugin.md` are long and only
  one of them matters for any given job. Keep the SKILL.md the judgement, and the references the
  lookup.
- **No scripts, and no copies.** This plugin calls no `${CLAUDE_PLUGIN_ROOT}/scripts/…`, so it
  needs none of the shared copies (`context-repo.sh`, `dates.mjs`, `bash-bin.mjs`) that the context
  plugins carry, and `check-plugin.mjs`'s drift rule has nothing to bind here. Adding a script that
  duplicates something `devhub` already does is the thing to avoid.
