---
name: sandcastle-install
description: "Install the Sandcastle harness into a workspace and get it to a verified, token-free green state: decide whether the root is an interdependent uv/npm workspace or a clone root, write the member table and prompt sets, scaffold, wire the env, hand-write the Dockerfile, build, and prove it with smoke and preflight before a single token is spent. Use when a project is adopting @c-energie/sandcastle-harness, when npx sandcastle-init has just scaffolded a workspace, when a member table or sandcastle.config.mts needs writing or repairing, when a smoke test or preflight is failing, or when asked to set up, install, wire up or verify a Sandcastle workspace."
---

# sandcastle-install

Installing this harness is not `npm i` plus filling in a template. The install *is* a set of
judgements about the project, and the scaffolder cannot make them — it has never seen the repo.
Get one wrong and the failure arrives hours later as an agent working in a tree nothing reads, or
a suite that "passed" because it never ran.

This skill is the order those judgements have to be made in, and the traps between them. Every
step before the build is **free**: no container, no token, no network beyond the install. Do not
skip ahead to spend money on something a typecheck would have caught.

---

## 0. The question that decides everything else

**Is this root an interdependent workspace, or a clone root?** Answer it before writing a line of
config. Nearly every later decision follows from it, and the engine currently assumes the first.

| | **uv / npm workspace** | **clone root** |
| --- | --- | --- |
| What it is | One project whose members are packages of it | One directory per repo, mirroring GitHub |
| Do members import each other? | **Yes** | **No** |
| Shared venv / `node_modules` above them? | Yes | No |
| Is a lone member runnable? | No — that is why the image bakes the whole workspace | Yes, every one of them |
| Root manifest (`pyproject.toml`, root `package.json`) | Yes | **None** |

How to tell, in the root:

```bash
ls pyproject.toml package.json          # a root manifest means workspace
grep -l 'workspace' pyproject.toml 2>/dev/null   # [tool.uv.workspace] / [tool.poetry]
node -e "console.log(require('./package.json').workspaces ?? 'no npm workspaces')" 2>/dev/null
for d in */; do echo "$d $(ls $d/pyproject.toml $d/package.json 2>/dev/null | tr '\n' ' ')"; done
```

A root with **no manifest of its own** and a manifest inside each child is a clone root.

**If it is a clone root, read `## Clone roots` at the bottom before going further.** The engine
models the workspace case; a clone root works, but four of its assumptions become cost rather
than benefit, and two of them currently fail outright.

---

## 1. Install

```bash
npm i -D @c-energie/sandcastle-harness@github:c-energie/sandcastle-harness#vX.Y.Z \
  "@ai-hero/sandcastle@^0.12.0" tsx typescript @types/node
npm ls @c-energie/sandcastle-harness    # must print the tag you asked for
```

- **Pin the same tag every other consumer is on.** Consumers on different tags is the silent
  divergence this package exists to kill, and it has already happened once. `npm ls` in each
  workspace says which it is on.
- **`--allow-git=all` may be required.** A machine with `allow-git = "none"` in its npm config
  refuses a git dependency with `EALLOWGIT`, with no hint that a flag would fix it.
- A blocked `esbuild` postinstall is usually harmless — esbuild ships prebuilt platform binaries
  as optional deps. Confirm rather than assume: `npx tsx -e 'console.log(1)'`.

There must be a root `package.json` with `"type": "module"` before `sandcastle-init` will be
happy. If the root has none, `npm init -y` one and set `"type"` and `"private": true`.

---

## 2. Scaffold — and do not ask it for help

```bash
npx sandcastle-init --name "<workspace>" --owner <org> --member <member>
```

> **`sandcastle-init --help` is not a flag. It scaffolds.** It writes eleven files into whatever
> directory you are standing in, from a command that reads as read-only — and because it never
> overwrites, a later correct invocation will decline to replace what the accidental one wrote.
> If it has already happened, delete the files and re-run, or edit them by hand.

It writes `sandcastle.config.mts`, `.sandcastle/{Dockerfile,.dockerignore,.env.example,.gitignore,tsconfig.json}`,
four prompt stubs and the npm scripts. It prints what it kept.

---

## 3. The member table

One entry per repository an agent can be pointed at. The key is what `--member` takes.

```ts
members: {
  "<key>": {
    owner: "<github-owner>",   // no default, deliberately
    repo: "<repo-name>",       // not always the folder name
    dir: "src/<key>",          // OPTIONAL — see below
    promptSet: "<set>",
    importName: null,          // see below
  },
},
```

**`dir` — where it lives ON THE HOST, relative to the root.** It defaults to the member key.
Members sitting directly under the root therefore set **nothing**; only a nested layout sets it
(`dir: "src/<key>"`). Both are already in use, so do not assume either from another workspace.

**`importName` — the installed package that must resolve INTO the mount**, or `null`.

- It is the **package name, not the repo name**, and assuming otherwise is a real bug that has
  been hit: `bots` installs `notebots`, `dev-hub` installs `dev_hub`, `secret-sync` installs
  `secret_sync`, `thesis-analysis` installs `doc_analysis`. Read it out of the manifest.
- Set it **only when there is an editable install to redirect** — i.e. a shared environment above
  the members. With no shared venv there is nothing for it to prove, and it must be `null`.
- `null` is a legitimate answer, not a gap: the import check is skipped and says so.

**`testCommand`** — what engages the member's suite. It runs with **cwd = the member's own root**
(the symlink, i.e. the mount). Return `undefined` for a member with no suite; that is skipped, not
failed.

```ts
testCommand: (ctx) => {
  switch (ctx.member) {
    case "<python-member>": return "uv run --frozen pytest -q";
    case "<node-member>":   return "npm run check";
    default:                return undefined;   // no suite here
  }
},
```

Watch for a **hybrid member** — one repo with two suites in two languages (a Python package plus a
Worker, say). `testCommand` is one string, so it covers one half. Say so in a comment *and* carry
the other half in the implementer prompt, or a run will report "the suite passed" having tested
half the repo.

**`manifestFile`** — drop it unless one manifest's age genuinely says whether the image is stale.
For a clone root, or anything whose dependencies are not installed at build time, it is noise.

Then, before anything else:

```bash
npm run sandcastle:typecheck
```

The member names are a real type. A bad table fails here in a second rather than mid-run.

---

## 4. Prompt sets — one per KIND of repo

The stubs are generic and the harness warns every time it falls back to one. Writing them is the
judgement half of the install; **use the `sandcastle-prompts` skill**, which interviews the
project's own documents rather than guessing.

What this skill adds is the shape of the decision: **a prompt set is per kind of repository, not
per workspace.** A workspace of three Python packages, two Node repos and two content repos wants
three sets, because they differ in what an agent must run, what it must read first, and what it
must not invent — a pytest instruction reaching a repo with no Python is precisely the failure the
stub warning describes.

```ts
promptSets: {
  python:  { prompt: ".sandcastle/prompts/python/prompt.md",  review: "...", groupReview: "..." },
  node:    { prompt: ".sandcastle/prompts/node/prompt.md",    review: "...", groupReview: "..." },
  content: { prompt: ".sandcastle/prompts/content/prompt.md", review: "...", groupReview: "..." },
},
```

Two traps worth naming here because they are invisible in a diff:

- **Nested standards.** A member whose sub-directories each carry their own authoritative
  `CLAUDE.md` cannot be summarised into a prompt. Have the prompt name them **by path, as required
  reading**. Drafting from the root document alone produces work that is correct against the rules
  the agent was given and wrong against the rules that exist — and a reviewer reading the same
  half approves it.
- **`{{REPO}}` is already `owner/repo`.** A prompt that writes `myorg/{{REPO}}` renders
  `myorg/myorg/repo` and fails every issue read. A dry run will not show it — it prints the
  placeholder map, not the rendered bodies. Grep for it:

```bash
grep -rn '/{{REPO}}' .sandcastle/
```

---

## 5. Wire the environment

```bash
npm run sandcastle:check     # what setup WOULD do; non-zero just means work outstanding
npm run sandcastle:setup     # member .env manifests + /.sandcastle/ in each .git/info/exclude
cp .sandcastle/.env.example .sandcastle/.env
claude setup-token           # interactive; paste the result into .sandcastle/.env
npm run sandcastle:check     # now: 0 outstanding
```

- **Real values live in the ROOT `.sandcastle/.env`, once.** Each member gets a key *manifest* —
  key names, empty values — because Sandcastle iterates only the keys that file names. A member
  file with values in it is a secret in a shared repository.
- `setup` appends `/.sandcastle/` to each member's `.git/info/exclude`: per-checkout, untracked,
  tracked content unchanged. Verify it:

```bash
git -C <member> status --porcelain | grep -i sandcastle   # must print nothing
```

- **Reusing credentials from another install:** the Claude token is account-level and reuses
  freely. `GH_TOKEN` often does **not** — a fine-grained PAT (~93 chars, `github_pat_`) is scoped
  to **one owner**, so a token from a workspace under a different owner will fail every
  `gh --repo` call. Check the owner before copying.

---

## 6. The Dockerfile is a template, not a default

The scaffolded Dockerfile assumes a **uv workspace**: it copies `pyproject.toml`, `uv.lock` and
`.python-version`, runs `uv sync --all-packages --all-extras`, and sets `VIRTUAL_ENV` so one venv
above the members serves all of them. If that is not this project, **it must be rewritten**, and
the comment explaining why belongs in the file.

Keep, whatever the shape:

- `FROM sandcastle-base:node22-uv` — git, gh, claude, node, uv.
- The **build stamp** (`.image-built`). `.dockerignore` strips every `.git`, so without it the
  baked members are dateless and a stale image reads to the planner as a backlog decision.
- **`RUN chmod -R u+w`** — folders from a Windows host arrive mode 555 and `COPY` preserves it.
- `WORKDIR /home/agent/workspace` and the `sleep infinity` entrypoint.

Copy members one COPY per member when there is no host-side `src/` to copy wholesale. Note that
the **container** layout `<ws>/src/<member>` is fixed regardless of the host layout, so `src/` in
the image may correspond to no directory on disk.

Build, then verify:

```bash
npm run sandcastle:build-base     # once per machine
npm run sandcastle:build-image
```

> If `build-image` produces no output and never exits, it has most likely **already built** and
> hung afterwards. Check with `docker images`, and fall back to driving docker directly:
> `docker build -f .sandcastle/Dockerfile -t <image> --build-arg AGENT_UID=1000 --build-arg AGENT_GID=1000 .`

---

## 7. Prove it without spending a token

```bash
npm run sandcastle:smoke     -- --member <m>
npm run sandcastle:preflight -- --member <m>
```

The smoke test drives **plain `docker run`**, so a failure there is an image fault with Sandcastle
out of the picture. The preflight builds the sandbox a real run builds — same image, same mounted
worktree, same hooks, same env — and is the only thing that sees the two failures that are
otherwise **silent**: whether the `onSandboxReady` hooks actually ran, and whether the token
reaches the container.

Run them for **one member of every prompt set**; a set's prompts are only resolved when a member
using it is named.

### One failure to expect, and what it means

- **`the suite could not run` on a Node member, from a Windows host.** The mounted checkout's
  `node_modules/.bin` shims are Windows shims that exec `node.exe`, which does not exist in a
  Linux container, and npm does not rebuild them. `uv` *does* rebuild for the platform, so Python
  members are unaffected. Do **not** "fix" it by running `npm ci` in the mount — that is the
  user's live checkout and it would overwrite their host `node_modules`. Either give the member an
  environment the image owns, or leave `testCommand` undefined and say so.

What you will see instead of a failure, on a workspace with no Python: `interpreter at <python>`
reported as **SKIP** by the smoke test and as a `note` by the preflight. The two facts used to be
one check — `test -d <ws>/src && test -x <python>` — which no venv-less workspace could pass and no
config could disable. They are separate assertions now, and the interpreter is asserted only when
some member declares an `importName` or the config sets `python` itself.

### Then a dry run, per prompt set

```bash
npm run sandcastle -- --member <m> --issue <n> --dry-run
```

Check: no prompt path resolves into `node_modules` (that means the file is missing and a stub was
substituted), no `WARNING  Using the harness's GENERIC stub`, `{{REPO}}` renders `owner/repo`
exactly once, and the hook command reads sensibly.

Only then run for real — without `--pr` the first time, so the branch stays local.

---

## Clone roots

A clone root works, but the engine models the interdependent case and four assumptions rest on one
premise, stated in the Dockerfile template itself: *"a lone member is usually not runnable."* For a
clone root that is false, and each becomes cost:

| Assumption | Effect on a clone root |
| --- | --- |
| Every member baked in (enforced by `preflight` and `smoke`) | Every image carries every repo to satisfy a check whose premise does not hold |
| Container path `<ws>/src/<member>` | `src/` is manufactured and matches nothing on the host |
| One `python` for the whole workspace | Wrong wherever members have their own, or none |
| `importName` + editable install + symlink verification | No shared venv, so nothing to redirect and nothing to prove |

So, concretely:

- Omit `dir` (members are directly under the root; it defaults to the key).
- `importName: null` on **every** member.
- Drop `manifestFile`.
- Rewrite the Dockerfile: no `uv sync`, no `VIRTUAL_ENV`, one COPY per member into `./src/<member>/`.
- Expect `interpreter at <python>` to be skipped rather than asserted — with no `importName`
  anywhere and no `python` in the config, there is no interpreter for it to be about.
- Dependencies resolve inside the sandbox on first use (`uv run`, `npm`), which costs time on each
  run and needs network.

**Record what you hit.** The engine is the right place to fix these, and a workspace that works
around one silently is a workspace whose next reader repeats the work.

---

## Running the suite in a Linux container finds host-masked bugs

Worth knowing before you dismiss a first-run failure as an install problem. The first time one
project's own linter ran under Linux rather than Windows, it reported two correct files as
missing: a path-extraction regex admitted a backslash, and `\` is a separator on Windows and an
ordinary filename character on Linux. It had passed on every developer machine for months.

When a suite fails in the container and passes on the host, **check whether the container is
right** before assuming the harness is wrong.

---

**Not this skill:** writing the four prompts is `sandcastle-prompts` — it interviews the project's
own `CLAUDE.md` and standards documents, which is the part that has gone wrong when done by hand.
Changing the engine itself — the runner, the config seam, a pin strategy — is a change to
`c-energie/sandcastle-harness` and belongs in that repository.
