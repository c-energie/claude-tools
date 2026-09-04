---
name: devhub-catalogue
description: "Add the repo you are standing in to a followed dev-hub catalogue.toml, so devhub will clone it, run its recipe, and show its devhub.toml features. Use when 'devhub features owner/repo' reports the repo is not in the catalogue, or when asked to catalogue this repo, add it to the catalogue, or register a new repo with dev-hub."
---

# devhub-catalogue

Write the `[repos."owner/repo"]` entry a repo needs before `devhub` will clone it, run its
recipe, or show its `devhub.toml` features anywhere. There is no `devhub` subcommand that does
this — it is a manual edit to a catalogue repo's `catalogue.toml`, committed and pushed like any
other change to a file every teammate's machine pulls.

## What this does not do

It never writes the repo's own `devhub.toml` — that is `devhub-feature`'s job, and it runs first
if this repo has no features declared yet. It never creates a new catalogue repo and never
invents an `[org]` table. It edits exactly one `[repos."owner/repo"]` entry in a catalogue that
already exists and is already followed.

## 1. Find the owning catalogue

`devhub follow` lists every catalogue this machine follows; one is marked `(primary)`. A repo
can be declared by exactly one of them — declaring it in two is refused outright once catalogues
are merged — so if more than one is followed, work out which one *owns* this repo's org before
writing anything.

The fast guess is `owner/.github`, but verify it, don't assume it: open the candidate
catalogue's `catalogue.toml` and check its `[org]` block and its existing `[repos.*]` entries are
for the same owner as the repo you're standing in. If nothing followed matches, or more than one
plausibly could, ask rather than guess — a repo landing in the wrong catalogue is a second,
harder-to-undo mistake, since moving it later needs a matching removal in the old one.

Also check the repo isn't **already** declared, in this catalogue or another followed one —
`devhub features <owner/repo>` erroring "not in the catalogue" is the normal trigger for this
skill, but confirm by reading the file rather than assuming the error means it's absent
everywhere.

## 2. Locate its local clone

A catalogue repo is a normal git repo — `devhub` does not manage its clone the way it manages
catalogued repos (`devhub clone` only takes repos already *in* a catalogue's `[repos]` table).
By convention it sits at `<devhub root>/<owner>/<repo>`, the same convention every catalogued
repo clones into; `devhub status --json`'s `.root` field gives the root. If it isn't there, ask
the user where it lives, or whether to `git clone` it fresh — don't guess a second path and edit
the wrong copy.

## 3. Read the catalogue's own rules first

Every catalogue's header comment states its schema and local conventions — required keys,
"nothing sensitive", how existing entries group and order themselves (alphabetical-ish under a
`# ---- owner` banner is common but not universal). Read it before writing; it is more current
than any doc in this skill. `references/catalogue-schema.md` here has the general shape `devhub
validate` enforces, for whatever a header comment leaves unsaid.

## 4. Write the entry

Minimum: `description`. `toolchain` is optional — `devhub` auto-detects it on clone
(`uv.lock`/`pyproject.toml` → `uv`, `pnpm-lock.yaml` → `pnpm`, `package-lock.json` → `npm`,
none of those → `none`) — so only set it explicitly if auto-detection would guess wrong, or the
repo mixes toolchains across subdirectories, which auto-detect can't express: `toolchain =
"mixed"` with a `[repos."owner/repo".subdirs]` table naming each subdir's toolchain. Leave
`tags`, `secrets`, `manual_steps` and `extras`/`groups` out unless there's a concrete reason to
set them — see `references/catalogue-schema.md` for what each means. Match the file's existing
style:
description tone, quoting, and where new entries are inserted (usually appended to the relevant
`# ----` section, not alphabetically forced if the file isn't already strict about it).

## 5. Validate before touching git

```
devhub validate <path-to-catalogue.toml>
```

No `--manifest` flag here — that validates a repo's own `devhub.toml`, a different file from a
different command (step 6 of `devhub-feature`). Unknown keys are a parse error and every problem
is reported at once; fix all of them before committing.

## 6. Commit — ask first

This is a shared, committed file every machine pulls. Show the diff, then ask before committing:

```
git -C <catalogue-clone> add catalogue.toml
git -C <catalogue-clone> commit -m "catalogue: add <owner/repo>"
```

## 7. Push — ask again, separately

**Stop after the commit and wait for an explicit yes before pushing.** This is a second,
distinct confirmation from step 6's — do not treat the earlier commit approval as covering it,
and do not push in the same turn as the commit. A push lands on every teammate's machine on
their next `devhub sync`, where a local-only commit does not; nothing downstream needs it done
immediately, so there is no reason to rush it.

```
git -C <catalogue-clone> push
```

## 8. Prove it landed

```
devhub sync                        # pulls the catalogue; exits 1 if ANY catalogued repo is
                                    # dirty/behind — that's normal cross-org noise, not a
                                    # signal this step failed
devhub features <owner/repo>       # confirms the repo is now visible, and that its
                                    # devhub.toml (if any) parsed
```

If `devhub features` still reports the repo isn't catalogued, `devhub sync` likely hasn't picked
up the push yet, or the entry landed in a catalogue this machine doesn't follow — re-check step 1.

## References

- `references/catalogue-schema.md` — every catalogue-level and per-repo key `devhub validate`
  accepts, for filling in a field the file's own header comment doesn't explain.

**Not this skill:** writing the repo's own `devhub.toml` — the features dev-hub renders once the
repo *is* catalogued — is `devhub-feature`. Creating a brand-new catalogue repo, or changing an
`[org]` table's identity (`secret_sync`, `roster`, `context`, `theme`), is a manual job, not
this skill's.
