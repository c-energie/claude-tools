# second-brain

The context repo for the **cross-project layer** — the level above the per-project context
repos. Stamped from [c-energie/context-template](https://github.com/c-energie/context-template)
by `init-context` on {{DATE}}, then overlaid with the cross-project scaffold.

Sessions opened here (the managed clone lives at `~/.context/{{OWNER_REPO}}`) load this repo's
own context **plus**, read-only, the memory / glossary / thread index of every project named in
`context.json`'s `include` list. See `CLAUDE.md` for the rules that make that safe, and
`handoff/README.md` for how project-bound items travel back out.

- `memory.md` — the durable personal / cross-project layer
- `glossary.md` — vocabulary of this layer itself
- `threads/` — cross-pollination working notes
- `meetings/` — narrative write-ups (rarely used here)
- `handoff/` — outbox of items addressed to one project, drained in that project's session
- `pending/` — keeps its template meaning; largely unused while `"state": null`

## First things to do

1. **Fill the `include` list** in `context.json` — one `owner/repo` per project context repo
   whose memory this layer should see. It starts empty on purpose: an *accidental*
   cross-project load is the failure mode the whole contract exists to prevent, so every
   entry is added by hand.
2. **Write `memory.md`** — who you are across projects, and what is true above any one of them.
3. **Deny the projects' connectors** in `.claude/settings.json` if any project of yours uses
   Notion or Slack, so a session here can never write into the wrong workspace:
   `"permissions": { "deny": ["mcp__notion-[project]", "mcp__github-[project]"] }`.
