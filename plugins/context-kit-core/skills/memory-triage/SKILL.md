---
name: memory-triage
description: Drain Claude's own per-directory memory into the shared context layers — promoting a preference into the personal layer, a project fact into the workspace's docs/memory.md (or the context repo outside a workspace), a transferable claim into an assistant's LESSONS.md, and leaving genuinely machine-local notes alone. Triggers like "triage my memory", "drain claude's memory into the context repo", "what has claude remembered that should be shared", "my memories are scattered across projects", "promote my memories".
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
| project | the workspace's `docs/memory.md` — outside a workspace, the context repo's `memory.md` | the project's people |
| role, across projects | `assistants/[role]/LESSONS.md` | every project with that role, via its supervisor |
| personal | the cross-project layer's `memory.md` | you |

> **Rewrites a durable layer and stamps files outside any repo — run only when asked.**
> `disable-model-invocation: true`, and it asks before every push.

## 1. Scan

```bash
ROOT="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/workspace.mjs" --no-pull)"
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-triage.mjs" scan "$ROOT"
```

`workspace.mjs` names its route on stderr. **`route=workspace`**: `ROOT` is the nearest
`.claude/workspace.json`'s directory and project facts go to `$ROOT/docs/memory.md` — the file
the workspace's `CLAUDE.md` imports. **`route=context-repo`**: no workspace, and everything below
applies to the context repo's `memory.md` exactly as before. The scan prints which file it means
(`project facts go to:`); trust that line rather than re-deriving it.

The scan is **asymmetric**, and this is the part to understand before reading its output:

- **In a project repo** it reads only the store for this working directory. It does not try to
  work out which other directories belong to this project — guessing wrong files a fact under
  the wrong project, and there is no signal that would make the guess safe.
- **In the cross-project layer** (a repo whose `context.json` declares `include`) it reads
  *every* store on the machine but surfaces only personal-layer entries. Those belong to the
  person rather than to the folder they were captured in, so no mapping is needed.
- **A workspace is always a project here**, never the cross-project layer: ADR 0002 retires
  `include`, so nothing in `workspace.json` says a workspace is entitled to read every store.

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

- **A transferable claim is a lesson, not a memory.** "Prefer one generic config-driven
  implementation" is exactly what `assistants/[role]/LESSONS.md` is for — route it to
  `assistant-lesson` rather than into `memory.md`.
- **Machine-local stays put.** A laptop path, a `UV_LINK_MODE` workaround, where a binary
  lives — these are true of this machine and nowhere else. Promoting them pollutes a shared
  layer with something no one else can use.
- **A code convention is `CLAUDE.md`**, not the context repo. Test runner, folder naming, build
  commands: they belong with the code they govern.

## 3. Promote — into this repo only

Write each promoted fact into **the repo this session is in**. Never into another repo, whatever
the clone on disk permits: from the cross-project layer, included repos are read-only.

**In a workspace, "this repo" is the workspace's**, even when the session is in a member: a
project fact goes to `$ROOT/docs/memory.md`, never to a member's `.claude/memory.md`. Create
`docs/memory.md` if it is absent, and if the workspace's `CLAUDE.md` does not import it
(`@docs/memory.md`), offer that line rather than writing it — an unimported memory file is one no
session loads. A **code convention** still belongs to the `CLAUDE.md` of the member whose code it
governs.

A personal entry found from a *project* session is therefore a finding, not a task. It needs no
handoff — the cross-project layer reads every store, so a run there will pick it up. Say so and
move on.

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

(`memory.md` outside a workspace.) Show the user the diff and **ask before pushing** — a durable
layer is loaded by every session, everyone's. Push (`git -C "$ROOT" push`) only on an explicit
yes; otherwise leave the commit local and say so.

## 6. Report

Say what moved where, what you deliberately left local and why, and what you could not place.
An entry nobody can classify should stay where it is and be named — a fact filed under a guess
is worse than one left in the inbox.

**Not this skill:** recording a transferable lesson for a supervisor is `assistant-lesson`;
condensing a context repo's own threads is `curate-context`; checking a repo's config for silent
drift is `context-doctor`; adopting a role is `assistant`.
