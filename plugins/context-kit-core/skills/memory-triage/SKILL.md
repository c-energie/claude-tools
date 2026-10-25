---
name: memory-triage
description: Drain Claude's own per-directory memory into the shared context layers — naming what belongs to the personal layer, promoting a project fact into the workspace's docs/memory.md, a code convention into a CLAUDE.md, and leaving genuinely machine-local notes alone. Triggers like "triage my memory", "drain claude's memory into the workspace", "what has claude remembered that should be shared", "my memories are scattered across projects", "promote my memories".
disable-model-invocation: true
---

# Drain native memory into the context ladder

Claude's own memory lives in `~/.claude/projects/[mangled-working-directory]/memory/` — keyed by
**working directory**, not by project, and committed nowhere. So one project spread over several
checkouts gets several stores that never see each other, and a preference stated once applies in
one folder and nowhere else.

That makes native memory a good **inbox** — the frictionless place a fact lands mid-task — and a
bad layer. This gives it a drain.

Where each fact belongs:

| Scope | Home | Shared with |
| --- | --- | --- |
| machine-local | leave it in native memory | nobody: this laptop, this path |
| repo | that repo's `CLAUDE.md` | anyone who clones the code |
| project | the workspace's `docs/memory.md` | the project's people |
| personal | the personal layer the user-level `~/.claude/CLAUDE.md` imports — **not promoted by this skill** | you |

> **Rewrites a durable layer and stamps files outside any repo — run only when asked.**
> `disable-model-invocation: true`, and it asks before every push.

## 1. Scan

```bash
ROOT="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs")"
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-triage.mjs" scan "$ROOT"
```

`ROOT` is the nearest `.claude/workspace.json`'s directory, and project facts go to
`$ROOT/docs/memory.md`, the file the workspace's `CLAUDE.md` imports. A non-zero exit
(`route=none` on stderr) means there is no workspace: say so and stop, since a project fact has
no project home to go to. The scan prints which file it means (`project facts go to:`); trust
that line rather than re-deriving it.

The scan reads **only the store for this working directory**, and this is the part to
understand before reading its output. It does not try to work out which other directories belong
to this project — guessing wrong files a fact under the wrong project, and there is no signal that
would make the guess safe. Nor does it read every store on the machine from anywhere: ADR 0002
retired the cross-project layer that did, so nothing committed says a repo is entitled to.

Entries already stamped `promotedTo` are skipped.

## 2. Judge each one — the type is a hint, not an answer

The script reports each entry's `type`, but `feedback` covers two different things and the
distinction is the whole job:

- *"Prefers prose discussion over multiple-choice questions"* — about **the person**. Personal.
- *"Wants the Acme docs to state only what works"* — about **a project**, in the same
  `type: feedback` clothing. That belongs in that project's repo. Promote it into the personal
  layer and a product's documentation convention becomes a fact about a human being.

The script flags entries whose summary names a project token from their own store path
(`AMBIGUOUS — names "acme"...`). Treat that as a prompt to look, not a verdict: it reads
the summary only, because the body of a good memory always names the episode the fact was
learned from, which is evidence for a general preference rather than a limit on its scope.

Watch for these too:

- **Machine-local stays put.** A laptop path, a `UV_LINK_MODE` workaround, where a binary
  lives — these are true of this machine and nowhere else. Promoting them pollutes a shared
  layer with something no one else can use.
- **A code convention is `CLAUDE.md`**, not `docs/memory.md`. Test runner, folder naming, build
  commands: they belong with the code they govern.

## 3. Promote — into this repo only

Write each promoted fact into **the repo this session is in**. Never into another repo, whatever
the clone on disk permits.

**In a workspace, "this repo" is the workspace's**, even when the session is in a member: a
project fact goes to `$ROOT/docs/memory.md`, never to a member's `.claude/memory.md`. Create
`docs/memory.md` if it is absent, and if the workspace's `CLAUDE.md` does not import it
(`@docs/memory.md`), offer that line rather than writing it — an unimported memory file is one no
session loads. A **code convention** still belongs to the `CLAUDE.md` of the member whose code it
governs.

A personal entry is therefore a finding, not a task: no repo this session can write to is the
personal layer. Name it, say it belongs in the file the user-level `~/.claude/CLAUDE.md` imports,
and leave it unstamped in native memory so it is still there to move by hand.

**Condense as you promote.** A native memory entry is written for one machine with its full
"why"; the destination is a durable layer that every session loads. Take the claim, drop the
episode.

## 4. Stamp the source

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-triage.mjs" mark "[the native memory file]" --to "[where it went]"
```

This adds one `promotedTo:` line to the entry's metadata so the next scan skips it. It refuses
to stamp twice.

The entry itself is left in place rather than deleted: it holds the reasoning behind the fact,
and the destination holds only the conclusion. Deleting is a separate decision — offer it if an
entry is now wrong, not merely promoted.

## 5. Commit — and ask before pushing

Stage only the file(s) you promoted into and commit, in the destination repo:

```bash
git -C "$ROOT" add docs/memory.md && git -C "$ROOT" commit -m "memory: promote from native memory"
```

Show the user the diff and **ask before pushing** — a durable
layer is loaded by every session, everyone's. Push (`git -C "$ROOT" push`) only on an explicit
yes; otherwise leave the commit local and say so.

## 6. Report

Say what moved where, what you deliberately left local and why, and what you could not place.
An entry nobody can classify should stay where it is and be named — a fact filed under a guess
is worse than one left in the inbox.

**Not this skill:** condensing the workspace's threads is `curate-context`; checking a
repo's config for silent drift is `context-doctor`; writing up the current session is
`save-thread`.
