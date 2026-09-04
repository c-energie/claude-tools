# CLAUDE.md

## What this plugin is

The **dev-hub authoring** layer, `plugins/devhub` inside `c-energie/claude-tools`. Two skills:
`devhub-feature`, which writes a repo's committed `devhub.toml` and the dev-hub plugin behind it;
and `devhub-catalogue`, which declares that repo in a followed `catalogue.toml` so `devhub` will
clone it and render those features anywhere at all. A repo needs the second before the first does
anything visible.

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

**`c-energie/dev-hub` owns both formats; this plugin only teaches them.** Every rule in either
skill is a restatement of what `devhub validate` already enforces — `--manifest` for a repo's
`devhub.toml` (`devhub-feature`), no flag for a catalogue's `catalogue.toml` (`devhub-catalogue`).
Do not confuse the two commands in either skill's prose. So:

- **When dev-hub changes, this plugin is downstream.** A new key, a new mode, a relaxed rule —
  update `references/schema.md`, `references/plugin.md` or `references/catalogue-schema.md` from
  the CLI's own behaviour, then bump. Never the other way round: a skill that describes a key
  dev-hub does not have produces a file that fails validation, which is the exact failure both
  skills exist to prevent.
- **The check is `devhub validate`, not prose here.** Each skill's job is to get its judgements
  right *before* the file is written; validation is what proves it. Anything that must come out
  identically every time already lives in that CLI.

## Invariants

- **Both skills auto-trigger, and `devhub-catalogue`'s ask-gates are why that's still safe.**
  `devhub-feature` only writes files in the repo you're standing in and never commits.
  `devhub-catalogue` *does* commit and push to a catalogue repo — a shared, committed file every
  machine pulls — so instead of `disable-model-invocation: true` it carries the marketplace rule's
  other option: an explicit ask before the commit and a **separate** explicit ask before the push
  (steps 6–7 of its SKILL.md). Don't collapse those into one confirmation.
- **No angle brackets in the front-matter.** Both skills' bodies are full of `<owner/repo>` and
  that is fine; each `description` must stay clear of them or the ingester drops the field and the
  skill silently never appears.
- **The references are read on demand, not inlined.** `schema.md`, `plugin.md` and
  `catalogue-schema.md` are long and only one of them matters for any given job. Keep each
  SKILL.md the judgement, and its references the lookup.
- **No scripts, and no copies.** This plugin calls no `${CLAUDE_PLUGIN_ROOT}/scripts/…`, so it
  needs none of the shared copies (`context-repo.sh`, `dates.mjs`, `bash-bin.mjs`) that the context
  plugins carry, and `check-plugin.mjs`'s drift rule has nothing to bind here. `devhub-catalogue`
  orchestrates `devhub` + `git` directly, the same style as `devhub-feature` — adding a script that
  duplicates something either CLI already does is the thing to avoid.
