# catalogue.toml — every key

Lives at a catalogue repo's root (a repo like `owner/.github`), committed and identical for every
machine that follows it. Unknown keys anywhere are a **parse error**, not ignored — the whole
reason `devhub validate` exists. Every problem in the file is reported at once, and CI runs the
same check on every push/PR to a catalogue repo.

Nothing sensitive belongs in this file — it is configuration, not credential storage. Listing a
repo here grants nothing; GitHub permissions are the real gate, and a repo a machine cannot clone
reports "no access" cleanly rather than failing.

## Top level

| key | required | notes |
|---|---|---|
| `schema` | yes | `1` |
| `min_tool_version` | no | the org's floor for `devhub` itself. A machine below it refuses to run rather than mis-parsing an unknown key. Bump only when a catalogue feature genuinely needs a newer build. |
| `[org]` | no | facts about the *machine*, not any one repo — `name`, `secret_sync`, `roster`, `context`, `context_kit`, `theme`. Declared once across every catalogue a machine follows and inherited by the others; a second catalogue followed alongside one that already declares `[org]` should not repeat it. |
| `[profiles]` | no | named convenience groupings of `owner/repo` strings, shown by the tool. Not access control. |
| `[repos."owner/repo"]` | no, any number | one per catalogued repo — see below |

## `[repos."owner/repo"]`

| key | required | notes |
|---|---|---|
| `description` | yes | one line, for a stranger deciding whether to clone it |
| `toolchain` | no | `uv` \| `pnpm` \| `npm` \| `none` \| `mixed`. Omit to auto-detect on clone — only set it when detection would guess wrong or you want it explicit. |
| `extras` / `groups` | no, `uv` only | passed through to the repo's `uv` install |
| `tags` | no | free-text list; drives `[profiles]` membership and filtering, not access |
| `secrets` | no | `true` if the repo is listed in the org's secret-roster (see the `secrets-declare` skill) |
| `manual_steps` | no | list of stable strings, one per manual setup step. Rewording an existing string **deliberately re-opens** that step as undone on every machine once step-tracking lands — don't edit one casually |
| `subdirs` | `mixed` only | a nested `[repos."owner/repo".subdirs]` table, subdirectory name → toolchain, for a repo whose parts need different toolchains |

## Rules

- Exactly one followed catalogue may declare a given `owner/repo` — a second declaration is
  refused outright once catalogues are merged on a machine that follows both.
- `[org]` keys are machine-wide, not per-catalogue: declared once anywhere a machine follows,
  inherited by every catalogue followed alongside it. A second catalogue should not repeat them.
- A file with just `schema = 1` is valid and declares nothing.

## Validate

```
devhub validate <path/to/catalogue.toml>
```

Different from a repo's own manifest check — `devhub validate --manifest` validates a repo's
`devhub.toml`, not a catalogue.
