#!/usr/bin/env python3
"""Create a document workspace's member repos and wire them together.

The workspace (this repo) holds independent checkouts. The `full` layout has two:

    <workspace>/
    |-- <doc>-writing/    the LaTeX document  (from c-energie/writing-template, or your Overleaf project)
    |-- <doc>-analysis/   figures and tables  (from c-energie/analysis-template)
    |-- pyproject.toml    uv workspace root; the analysis repo is its one member
    `-- .venv/            the venv notebooks, tests and console scripts use

The `writing-only` layout has just the writing member, and no pyproject.toml or venv
unless doc-publish is wanted (the `publish-root` step).

Driven by the `setup-doc-workspace` skill, which does the interview and then calls the
steps below in order. Each step is also runnable by hand, and each refuses rather than
overwrites when its target already exists:

    check       prerequisites, with the install command for anything missing
    workspace   make sure this repo's `origin` is yours, not the template
    writing     create or adopt the document repo
    analysis    create the analysis repo and run its init.py   (full layout only)
    root        write pyproject.toml, workspace.toml, .python-version, the .gitignore block,
                fill CLAUDE.md
    publish-root  writing-only: a minimal pyproject.toml and .env so doc-publish installs
    add-analysis  writing-only -> full: create the analysis repo, rewire the root
    sync        uv sync at the root

Run with uv so no system Python is needed:

    uv run --no-project --python 3.12 path/to/setup_workspace.py --root <workspace> check

The script ships in the project-workspace@c-energie plugin, nowhere near the workspace, so
the skill passes --root (its ${CLAUDE_PROJECT_DIR}). Without it, the root is the nearest
directory at or above the current one holding workspace.toml, else the current directory.

Stdlib only.
"""
import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
import tomllib
from pathlib import Path


def default_root():
    """The nearest directory at or above the current one holding workspace.toml; before
    `root` has written it, the current directory."""
    here = Path.cwd().resolve()
    return next((d for d in (here, *here.parents) if (d / "workspace.toml").is_file()), here)


def set_root(root):
    global ROOT, STATE_FILE, IMPORT_DIR
    ROOT = Path(root).resolve()
    STATE_FILE = ROOT / "workspace.toml"
    IMPORT_DIR = ROOT / ".setup" / "import-source"


set_root(default_root())

ORG = "c-energie"
WORKSPACE_TEMPLATE = f"{ORG}/project-workspace-template"
WRITING_TEMPLATE = f"{ORG}/writing-template"
ANALYSIS_TEMPLATE = f"{ORG}/analysis-template"

# CLAUDE.md for a workspace with no analysis member. `root` puts it in place of the
# shipped CLAUDE.md, which describes the full layout.
WRITING_ONLY_CLAUDE_MD = Path(__file__).resolve().parent / "CLAUDE.writing-only.md"
# Where workspaces stamped before the move to the plugin (2026-10) carried that file. Their
# history still holds the versions their CLAUDE.md may have been filled from.
LEGACY_WRITING_ONLY_CLAUDE_MD = ".claude/skills/setup-doc-workspace/CLAUDE.writing-only.md"

# The .gitignore lines naming the members live between these markers, so a re-run (or a
# renamed member) replaces the block instead of appending a second one.
BLOCK_START = "# >>> members (managed by setup-doc-workspace) >>>"
BLOCK_END = "# <<< members <<<"

# Files carried from writing-template into an adopted Overleaf repo. Only the
# agent-facing ones: the layout of an existing document is adapted by hand, never
# overwritten (see the adapt-existing-document skill). AGENTS.md's "Agent skills" section
# points into docs/agents/, so those files travel with it or the pointers dangle.
OVERLAY_FILES = ("AGENTS.md", "CLAUDE.md",
                 "docs/agents/issue-tracker.md", "docs/agents/triage-labels.md",
                 "docs/agents/domain.md")

# Converts an import source that is a single document file (Word, ODT, Markdown, ...) to
# LaTeX. Run through `uv run --with`, never installed globally or into the workspace venv.
# 1.17 bundles pandoc 3.9.
PANDOC_PIN = "pypandoc_binary==1.17"
# What the first run pulls into uv's cache; said before converting.
PANDOC_DOWNLOAD = "about 230 MB"
# The wheel puts no `pandoc` on PATH, so the bundled binary is run through pypandoc.
RUN_PANDOC = ("import subprocess, sys, pypandoc; "
              "sys.exit(subprocess.call([pypandoc.get_pandoc_path(), *sys.argv[1:]]))")
# Extension -> pandoc reader, for the formats pandoc reads. Only .docx is tested.
PANDOC_READERS = {
    ".docx": "docx", ".odt": "odt", ".rtf": "rtf", ".epub": "epub",
    ".md": "markdown", ".markdown": "markdown", ".rst": "rst", ".org": "org",
    ".html": "html", ".htm": "html", ".ipynb": "ipynb", ".typ": "typst",
}

# `\caption{` or `\caption[short]{`, then "Figure 3:", "Fig. 12.", "Table 1 -" and the like.
# pandoc writes an en or em dash as -- or ---, so those count as separators too. A "." is
# one only when no digit follows, so "Figure 3.5 m wide" is left alone.
CAPTION_PREFIX = re.compile(
    r"(\\caption(?:\[[^\]]*\])?\{\s*)(?:fig(?:ure)?\.?|table)\s*\d+(?:\.\d+)*\s*(?::|-{1,3}|\.(?!\d)|–|—)\s*",
    re.IGNORECASE)
# What `gh repo clone` takes as OWNER/NAME.
REPO_NAME = re.compile(r"[\w.-]+/[\w.-]+")

MIN_PYTHON = (3, 11, 4)
# What `root` pins the workspace venv to in .python-version unless --python says otherwise.
# Unpinned, `uv sync` takes the newest interpreter allowed, and scientific stacks often have
# no wheels for it yet (#9). Matches the `--python 3.12` these scripts are run with.
WORKSPACE_PYTHON = "3.12"
# A --python value: a minor (`3.12`) or a patch release (`3.12.4`), as `uv python pin` takes.
PYTHON_PIN = re.compile(r"\d+\.\d+(?:\.\d+)?")

LAYOUTS = ("full", "writing-only")

DRY_RUN = False

# Child processes are read and fed as UTF-8, never the locale code page. Left to the
# default, Windows decodes with cp1252: the overlay AGENTS.md came out with every em dash
# as mojibake, and init.py's console output was garbled, with no error either time (#2).
UTF8 = {"encoding": "utf-8", "errors": "replace"}


# ---------------------------------------------------------------------------
# install commands, per platform
# ---------------------------------------------------------------------------

def _os():
    return {"win32": "windows", "darwin": "macos"}.get(sys.platform, "linux")


INSTALL = {
    "git": {
        "windows": "winget install --id Git.Git -e",
        "macos": "xcode-select --install   (or: brew install git)",
        "linux": "sudo apt install git   (or your distro's package manager)",
    },
    "gh": {
        "windows": "winget install --id GitHub.cli -e",
        "macos": "brew install gh",
        "linux": "sudo apt install gh   (see https://github.com/cli/cli/blob/trunk/docs/install_linux.md)",
    },
    "uv": {
        "windows": 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
                   "   (or: winget install --id astral-sh.uv -e, or: pip install uv)",
        "macos": "curl -LsSf https://astral.sh/uv/install.sh | sh   (or: brew install uv, or: pip install uv)",
        "linux": "curl -LsSf https://astral.sh/uv/install.sh | sh   (or: pip install uv)",
    },
    "latexmk": {
        "windows": "winget install --id MiKTeX.MiKTeX -e   (optional: Overleaf compiles without it)",
        "macos": "brew install --cask mactex-no-gui   (optional: Overleaf compiles without it)",
        "linux": "sudo apt install texlive-full latexmk   (optional: Overleaf compiles without it)",
    },
    "make": {
        "windows": "winget install --id ezwinports.make -e   (optional: only for local LaTeX builds)",
        "macos": "xcode-select --install   (optional: only for local LaTeX builds)",
        "linux": "sudo apt install make   (optional: only for local LaTeX builds)",
    },
    # Not checked on its own: shown when latexmk is on PATH but does not run. latexmk is a
    # Perl script; MiKTeX ships none, and Git's perl.exe is on PATH only inside Git Bash (#4).
    "perl": {
        "windows": "winget install --id StrawberryPerl.StrawberryPerl -e",
        "macos": "brew install perl",
        "linux": "sudo apt install perl",
    },
}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def say(msg=""):
    print(msg, flush=True)


def run(cmd, cwd=None, check=True, capture=False, env=None):
    where = f"  (in {Path(cwd).relative_to(ROOT) if cwd and Path(cwd).is_relative_to(ROOT) else cwd or '.'})"
    say(f"$ {' '.join(str(c) for c in cmd)}{where}")
    if DRY_RUN:
        return subprocess.CompletedProcess(cmd, 0, "", "")
    result = subprocess.run([str(c) for c in cmd], cwd=cwd, **UTF8,
                            capture_output=capture, env=env)
    if check and result.returncode != 0:
        if capture:
            say(result.stdout)
            say(result.stderr)
        sys.exit(f"\nFAILED ({result.returncode}): {' '.join(str(c) for c in cmd)}")
    return result


def quiet(cmd, cwd=None, raw=False, timeout=None):
    """Run for the answer, not the side effect. Never honours DRY_RUN: reads only.
    `raw` returns stdout and stderr as bytes, undecoded and with line endings intact.
    A missing command or a `timeout` comes back as a non-zero exit, not an exception."""
    try:
        return subprocess.run(cmd, cwd=cwd, capture_output=True, timeout=timeout,
                              **({} if raw else UTF8))
    except FileNotFoundError:
        return subprocess.CompletedProcess(cmd, 127, b"" if raw else "",
                                           b"not found" if raw else "not found")
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, b"" if raw else "",
                                           b"timed out" if raw else "timed out")


def write(path, text):
    say(f"  write {path.relative_to(ROOT)}")
    if not DRY_RUN:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")


def repo_exists(repo):
    return quiet(["gh", "repo", "view", repo, "--json", "name"]).returncode == 0


def wait_for_content(repo, timeout=90):
    """A repo generated from a template is filled asynchronously; cloning too early
    yields an empty checkout with no error."""
    if DRY_RUN:
        return
    deadline = time.time() + timeout
    while time.time() < deadline:
        if quiet(["gh", "api", f"repos/{repo}/commits?per_page=1"]).returncode == 0:
            return
        time.sleep(3)
    sys.exit(f"{repo} still has no commits after {timeout}s. Check it on GitHub, then re-run.")


def create_from_template(template, repo, visibility):
    if repo_exists(repo):
        say(f"{repo} already exists; using it as-is.")
    else:
        run(["gh", "repo", "create", repo, "--template", template, f"--{visibility}"])
    wait_for_content(repo)


def clone(repo, directory):
    target = ROOT / directory
    if target.exists() and any(target.iterdir()):
        if (target / ".git").exists():
            say(f"{directory}/ is already a checkout; leaving it alone.")
            return target
        sys.exit(f"{directory}/ exists and is not empty. Move it aside, then re-run.")
    run(["gh", "repo", "clone", repo, directory], cwd=ROOT)
    return target


def run_init(checkout, **answers):
    """Templates ship a self-deleting init.py. Give it the answers the skill already
    collected as flags (`doc_repo=` becomes `--doc-repo`), so it asks nothing. Piping
    them to stdin instead echoed every prompt, run together on one line, and tied setup
    to the order init.py asks in (#8). PYTHONIOENCODING makes the child print UTF-8, so
    init.py's em dashes reach the console intact (#2)."""
    init = checkout / "init.py"
    # A dry run only prints the clone, so a missing checkout says nothing about init.py:
    # testing for it there reported "already initialised" for a repo not yet created, and
    # the plan shown for confirmation left the init step out (#12). An existing checkout
    # is checked as usual, since there the answer on disk is the real one.
    pending_clone = DRY_RUN and not checkout.exists()
    if not init.exists() and not pending_clone:
        say(f"No init.py in {checkout.name}/ (already initialised); skipping.")
        return
    # --flag=value, never two words: a value starting with a dash ("-30% Emissions")
    # would otherwise be read by init.py's argparse as a flag of its own.
    flags = [f"--{name.replace('_', '-')}={value}" for name, value in answers.items()]
    run([sys.executable, "init.py", *flags], cwd=checkout,
        env=os.environ | {"PYTHONIOENCODING": "utf-8"})


def gh_raw(repo, path):
    """A template file's exact content. Decoded here, strictly, rather than by text mode:
    write() then reproduces it byte for byte (text mode would also fold CRLF), and a file
    that is not UTF-8 stops the step instead of being written out with U+FFFD in it."""
    result = quiet(["gh", "api", f"repos/{repo}/contents/{path}",
                    "-H", "Accept: application/vnd.github.raw"], raw=True)
    if result.returncode != 0:
        sys.exit(f"Could not read {path} from {repo}: "
                 f"{result.stderr.decode('utf-8', 'replace').strip()}")
    try:
        return result.stdout.decode("utf-8")
    except UnicodeDecodeError as exc:
        sys.exit(f"{path} from {repo} is not UTF-8 ({exc}); not copying it.")


def origin_url(path):
    result = quiet(["git", "remote", "get-url", "origin"], cwd=path)
    return result.stdout.strip() if result.returncode == 0 else ""


def load_state():
    if not STATE_FILE.exists():
        return {}
    return tomllib.loads(STATE_FILE.read_text(encoding="utf-8"))


def write_state(state):
    write(STATE_FILE, "# Written by setup-doc-workspace and read by the workspace skills.\n"
                      "# Edit it if you rename a member directory or repo.\n\n[workspace]\n"
                      + "".join(f"{k} = {json.dumps(v)}\n" for k, v in state.items()))


# ---------------------------------------------------------------------------
# steps
# ---------------------------------------------------------------------------

def cmd_check(args):
    os_name = _os()
    missing_required = False
    say(f"platform: {platform.system()} ({os_name})")

    py = sys.version_info[:3]
    ok = py >= MIN_PYTHON
    say(f"[{'ok' if ok else 'FAIL'}] python {'.'.join(map(str, py))} (need >= 3.11.4)")
    if not ok:
        missing_required = True
        say("       uv python install 3.12   then re-run this script with `uv run --python 3.12`")

    for tool, required in (("git", True), ("gh", True), ("uv", True),
                           ("latexmk", False), ("make", False)):
        found = shutil.which(tool)
        # Found is not enough for latexmk: MiKTeX's is a Perl script that, with no Perl on
        # PATH, prints "did not succeed" and exits non-zero, yet `which` finds it (#4). Run
        # it. A hung or failed latexmk is still optional, so this never touches the exit code.
        if found and tool == "latexmk" and quiet([found, "-v"], timeout=20).returncode != 0:
            say(f"[--] latexmk  (found but does not run; it needs Perl)  ->  {INSTALL['perl'][os_name]}")
            continue
        tag = "ok" if found else ("FAIL" if required else "--")
        say(f"[{tag}] {tool}{'' if found else '  ->  ' + INSTALL[tool][os_name]}")
        missing_required |= required and not found

    if shutil.which("gh"):
        auth = quiet(["gh", "auth", "status"])
        if auth.returncode == 0:
            login = quiet(["gh", "api", "user", "--jq", ".login"]).stdout.strip()
            say(f"[ok] gh authenticated as {login}")
        else:
            missing_required = True
            say("[FAIL] gh not authenticated  ->  gh auth login   (choose HTTPS, and let it configure git)")

    templates = [WRITING_TEMPLATE] + ([ANALYSIS_TEMPLATE] if args.layout == "full" else [])
    for repo in templates:
        if shutil.which("gh") and not repo_exists(repo):
            missing_required = True
            say(f"[FAIL] cannot see template {repo} with your gh login")

    say("\nAll required prerequisites present." if not missing_required
        else "\nInstall the FAIL items above, open a NEW terminal so PATH updates, then re-run.")
    return 1 if missing_required else 0


def cmd_workspace(args):
    origin = origin_url(ROOT)
    if origin and WORKSPACE_TEMPLATE.lower() not in origin.lower():
        say(f"origin is {origin}: already your own repo. Nothing to do.")
        return 0
    if not args.repo:
        say(f"origin is {origin or '(none)'}: this workspace is not yet its own repo.")
        say("Re-run with --repo OWNER/NAME to create it and point origin at it.")
        return 2
    if repo_exists(args.repo):
        sys.exit(f"{args.repo} already exists. Point origin at it by hand: "
                 f"git remote set-url origin https://github.com/{args.repo}.git")
    if origin:
        # Kept, not deleted: pulling template improvements later is `git pull template main`.
        run(["git", "remote", "rename", "origin", "template"], cwd=ROOT)
    has_commits = quiet(["git", "rev-parse", "HEAD"], cwd=ROOT).returncode == 0
    cmd = ["gh", "repo", "create", args.repo, f"--{args.visibility}",
           "--source", ".", "--remote", "origin"]
    run(cmd + (["--push"] if has_commits else []), cwd=ROOT)
    return 0


def cmd_writing(args):
    if args.mode == "adapt":
        # The Overleaf project's own GitHub-sync repo becomes the document repo, history
        # and Overleaf link intact. Overleaf must create it; nothing here can.
        if not repo_exists(args.repo):
            sys.exit(f"{args.repo} does not exist yet. In Overleaf: Menu -> GitHub -> "
                     f"create a repository named {args.repo.split('/')[-1]}, then re-run.")
        wait_for_content(args.repo)
        checkout = clone(args.repo, args.dir)
        overlay(checkout)
    else:
        create_from_template(WRITING_TEMPLATE, args.repo, args.visibility)
        checkout = clone(args.repo, args.dir)
        run_init(checkout, title=args.title, author=args.author)
        if args.mode == "import":
            stage_import_source(args.source)
    say(f"\nDocument repo ready at {args.dir}/. Nothing has been committed in it.")
    return 0


def overlay(checkout):
    """Bring the template's agent instructions and ignore rules into an adopted repo,
    without touching any of the document."""
    for name in OVERLAY_FILES:
        target = checkout / name
        if target.exists():
            say(f"  kept  {checkout.name}/{name}  (exists)")
            continue
        write(target, gh_raw(WRITING_TEMPLATE, name))

    template_lines = gh_raw(WRITING_TEMPLATE, ".gitignore").splitlines()
    gitignore = checkout / ".gitignore"
    existing = gitignore.read_text(encoding="utf-8").splitlines() if gitignore.exists() else []
    have = {line.strip() for line in existing}
    new = [line for line in template_lines
           if line.strip() and not line.startswith("#") and line.strip() not in have]
    if new:
        text = "\n".join(existing + ["", "# ---- from c-energie/writing-template ----"] + new) + "\n"
        write(gitignore, text.lstrip("\n"))
    else:
        say(f"  kept  {checkout.name}/.gitignore  (already covers the template's rules)")


def stage_import_source(source):
    """Put the existing document somewhere the adapt-existing-document skill can read it
    from. Never inside a member: it is scaffolding, deleted once the import is done."""
    if not source:
        say("No --source given; copy the existing document into .setup/import-source/ by hand.")
        return
    if IMPORT_DIR.exists():
        say(f".setup/import-source/ already exists; leaving it alone.")
        return
    kind, where = classify_source(source)
    if kind == "document-file":
        convert_document(where)
    elif kind in ("directory", "tex-file"):
        say(f"  copy  {where} -> .setup/import-source/")
        if not DRY_RUN:
            shutil.copytree(where, IMPORT_DIR, ignore=shutil.ignore_patterns(".git"))
    else:
        if not DRY_RUN:
            IMPORT_DIR.parent.mkdir(parents=True, exist_ok=True)
        run(["gh", "repo", "clone", where, str(IMPORT_DIR)], cwd=ROOT)


def classify_source(source):
    """What an import `--source` names, as (kind, where):

        ("directory", path)       copied as it is
        ("tex-file", parent)      a .tex file stands for its directory, so what it \\inputs comes too
        ("document-file", path)   converted to LaTeX by pandoc
        ("repo", source)          anything else: handed to `gh repo clone`

    Stops on a file pandoc cannot read, and on a missing path that names a document,
    which would otherwise reach `gh repo clone` and fail there with a confusing error."""
    path = Path(source).expanduser()
    suffix = path.suffix.lower()
    if path.is_dir():
        return "directory", path
    if path.is_file():
        if suffix == ".tex":
            return "tex-file", path.parent
        if suffix in PANDOC_READERS:
            return "document-file", path
        sys.exit(f"{path} is not a format the import can read. Export it to .docx (or "
                 f"another of: {', '.join(PANDOC_READERS)}), or give the folder or "
                 f"OWNER/NAME repo that holds the LaTeX source.")
    # A repo can be named like a file (someone/example.org): only a bare OWNER/NAME is one.
    if (suffix == ".tex" or suffix in PANDOC_READERS) and not REPO_NAME.fullmatch(source):
        sys.exit(f"{path} does not exist. Download the document to this machine first: "
                 f"a SharePoint or OneDrive link will not work.")
    return "repo", source


def convert_document(path):
    """Convert a single document file into .setup/import-source/<stem>.tex, its images in
    media/ beside it. pandoc runs in that directory so the image paths it writes are
    relative. The only fix applied afterwards is stripping caption number prefixes: the
    rest is a checklist in adapt-existing-document, because it needs judgement."""
    tex = IMPORT_DIR / f"{path.stem}.tex"
    say(f"  convert  {path.name} -> .setup/import-source/{tex.name}  "
        f"(pandoc via {PANDOC_PIN}; the first run downloads {PANDOC_DOWNLOAD})")
    if not DRY_RUN:
        IMPORT_DIR.mkdir(parents=True)
    try:
        result = run(["uv", "run", "--no-project", "--with", PANDOC_PIN, "python", "-c", RUN_PANDOC,
                      "--from", PANDOC_READERS[path.suffix.lower()], "--to", "latex", "--standalone",
                      "--extract-media=media", "--output", tex.name, path.resolve()],
                     cwd=IMPORT_DIR, check=False)
    except OSError as exc:      # uv itself missing
        result = subprocess.CompletedProcess([], 127, "", str(exc))
    if result.returncode != 0:
        # Removed, or a re-run would find it and leave the half-made import alone.
        shutil.rmtree(IMPORT_DIR, ignore_errors=True)
        sys.exit(f"\nFAILED ({result.returncode}): pandoc could not convert {path.name}.")
    if DRY_RUN:
        say("  then strip Figure/Table number prefixes from its captions")
        return
    text, count = strip_caption_prefixes(tex.read_text(encoding="utf-8"))
    if count:
        write(tex, text)
    say(f"  stripped a Figure/Table number prefix from {count} caption(s)")


def strip_caption_prefixes(tex):
    """Strip a leading figure/table number from every caption: LaTeX numbers them itself,
    so a converted "Figure 3: Demand" would print as "Figure 3: Figure 3: Demand".
    Returns the new text and how many captions changed."""
    return CAPTION_PREFIX.subn(r"\1", tex)


def cmd_analysis(args):
    writing = ROOT / args.writing_dir
    if not writing.is_dir():
        sys.exit(f"{args.writing_dir}/ does not exist. Run the `writing` step first.")
    make_analysis(args, writing)
    say(f"\nAnalysis repo ready at {args.dir}/, with .env pointing DOC_REPO at {args.writing_dir}/.")
    return 0


def make_analysis(args, writing):
    create_from_template(ANALYSIS_TEMPLATE, args.repo, args.visibility)
    checkout = clone(args.repo, args.dir)
    # DOC_REPO is absolute because .env is per-machine and read from wherever the cwd
    # happens to be.
    run_init(checkout, distribution=args.distribution, author=args.author,
             doc_repo=writing.as_posix(), backend=args.backend)


def analysis_distribution(analysis_dir):
    """The analysis repo's distribution name, which its init.py wrote into pyproject.toml.
    "DIST" on a dry run whose checkout does not exist yet."""
    analysis_pyproject = ROOT / analysis_dir / "pyproject.toml"
    if not analysis_pyproject.exists():
        if DRY_RUN:
            return "DIST"
        sys.exit(f"{analysis_dir}/pyproject.toml missing. Run the `analysis` step first.")
    dist = tomllib.loads(analysis_pyproject.read_text(encoding="utf-8"))["project"]["name"]
    if dist == "PACKAGE-NAME":
        sys.exit(f"{analysis_dir}/ is not initialised (its init.py has not run).")
    return dist


PYPROJECT = """\
# The workspace root: a uv workspace whose one member is the analysis repo. Run
# `uv sync` HERE, not inside the member, so the whole workspace shares one .venv.
#
# The document repo ({writing}/) is deliberately NOT a member. It is LaTeX, has no
# Python, and the analysis repo locates it through DOC_REPO in {analysis}/.env.
#
# Pass every extra you want on EVERY sync: `uv sync` removes the ones you leave out.
#
#   uv sync --extra dev --extra notebooks --extra {backend}

[project]
name = "{name}-workspace"
version = "0.0.0"
description = "Workspace root for {name}. Not a distributable package."
requires-python = ">=3.11.4"
dependencies = ["{dist}"]

[tool.uv]
package = false

[project.optional-dependencies]
# Pass-throughs to the member's own extras, so the familiar flags read the same here.
dev = ["{dist}[dev]"]
notebooks = ["{dist}[notebooks]"]
{backend} = ["{dist}[{backend}]"]
{more}
[tool.uv.workspace]
members = ["{analysis}"]

[tool.uv.sources]
{dist} = {{ workspace = true }}
"""


PYPROJECT_WRITING_ONLY = """\
# The workspace root of a writing-only workspace. It exists only to install doc-publish:
# the document repo ({writing}/) is LaTeX, has no Python, and is not a member. doc-publish
# finds it through DOC_REPO in the .env beside this file, so run it from HERE.
#
# Pass every extra you want on EVERY sync: `uv sync` removes the ones you leave out.
#
#   uv sync --extra publish

[project]
name = "{name}-workspace"
version = "0.0.0"
description = "Workspace root for {name}. Not a distributable package."
requires-python = ">=3.11.4"
dependencies = []

[project.optional-dependencies]
publish = ["doc-publish"]

[tool.uv]
package = false

[tool.uv.sources]
doc-publish = {{ git = "https://github.com/c-energie/doc-publish.git" }}
"""


def base_extras(backend):
    """The extras every full workspace installs; PYPROJECT declares each of them."""
    return ["dev", "notebooks", backend]


def full_pyproject(name, dist, backend, writing, analysis, extras=()):
    """The full layout's root pyproject.toml. An extra beyond the three it always has
    passes through to the analysis repo's extra of the same name."""
    more = "".join(f'{e} = ["{dist}[{e}]"]\n'
                   for e in dict.fromkeys(extras) if e not in base_extras(backend))
    return PYPROJECT.format(name=name, dist=dist, backend=backend, writing=writing,
                            analysis=analysis, more=more)


def write_member_block(members):
    """The .gitignore block naming the members, replaced in place if already there.
    Everything outside the markers is the user's and is kept."""
    gitignore = ROOT / ".gitignore"
    text = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
    block = "\n".join([BLOCK_START,
                       "# Each member is its own repo with its own remote. Tracking them here",
                       "# would nest one history inside another.",
                       *(f"/{m}/" for m in members), BLOCK_END])
    if BLOCK_START in text and BLOCK_END in text:
        head, _, rest = text.partition(BLOCK_START)
        _, _, tail = rest.partition(BLOCK_END)
        new = head + block + tail
    else:
        new = block + "\n\n" + text
    if new != text:
        write(gitignore, new)


def fill_claude_md(content, state):
    """Fill CLAUDE.md's <<...>> placeholders from workspace.toml's values, and drop the
    "not set up yet" notice, which stops being true once `root` has run."""
    for token, key in (("<<WORKSPACE>>", "name"), ("<<WRITING_DIR>>", "writing_dir"),
                       ("<<WRITING_REPO>>", "writing_repo"),
                       ("<<ANALYSIS_DIR>>", "analysis_dir"),
                       ("<<ANALYSIS_REPO>>", "analysis_repo"), ("<<BACKEND>>", "backend")):
        if state.get(key):
            content = content.replace(token, state[key])
    head, sep, rest = content.partition("<!-- setup-banner -->")
    if sep:
        content = head + rest.partition("<!-- /setup-banner -->\n")[2]
    return content


def cmd_root(args):
    existing = load_state().get("workspace", {})
    # A workspace.toml from before layouts existed is a full one.
    previous = existing.get("layout") or ("full" if "analysis_dir" in existing else None)
    if previous and previous != args.layout:
        # Moving between layouts is its own step, `add-analysis` (#18).
        sys.exit(f"workspace.toml already records layout = {previous!r}; "
                 f"refusing to rewrite it as {args.layout!r}.")
    state = {
        "name": args.name,
        "layout": args.layout,
        "writing_dir": args.writing_dir, "writing_repo": args.writing_repo,
        "writing_mode": args.writing_mode,
    }
    members = [args.writing_dir]
    if args.layout == "full":
        state |= {
            "analysis_dir": args.analysis_dir, "analysis_repo": args.analysis_repo,
            "backend": args.backend,
            # What `sync` installs. /project-workspace:setup-doc-publish appends "publish" here.
            "extras": base_extras(args.backend),
        }
        members.append(args.analysis_dir)
        dist = state["analysis_distribution"] = analysis_distribution(args.analysis_dir)

        pyproject = ROOT / "pyproject.toml"
        if pyproject.exists():
            say("  kept  pyproject.toml  (exists; edit it by hand, or delete it and re-run)")
        else:
            write(pyproject, full_pyproject(args.name, dist, args.backend,
                                            args.writing_dir, args.analysis_dir))
    else:
        # Nothing to install until doc-publish is wanted: `publish-root` appends "publish".
        state["extras"] = existing.get("extras", [])

    write_state(state)

    python_version = ROOT / ".python-version"
    if python_version.exists():
        say(f"  kept  .python-version  (exists; `uv python pin {args.python}` changes it)")
    else:
        write(python_version, args.python + "\n")

    write_member_block(members)

    claude_md = ROOT / "CLAUDE.md"
    if claude_md.exists():
        before = claude_md.read_text(encoding="utf-8")
        content = before
        if args.layout == "writing-only":
            # Swapped only while CLAUDE.md is still the unfilled template: once filled
            # in, it may hold the user's own edits.
            if "<!-- setup-banner -->" in content:
                content = WRITING_ONLY_CLAUDE_MD.read_text(encoding="utf-8")
            else:
                say("  kept  CLAUDE.md  (already filled in; not swapped for the writing-only text)")
        content = fill_claude_md(content, state)
        if content != before:
            write(claude_md, content)
    return 0


def cmd_publish_root(args):
    """What doc-publish needs in a writing-only workspace. A full workspace gets it
    through the analysis repo's `publish` extra instead."""
    state = load_state().get("workspace", {})
    if not state:
        sys.exit("workspace.toml missing. Run the `root` step first.")
    if state.get("layout", "full") != "writing-only":
        sys.exit("This workspace has an analysis member: doc-publish installs through its "
                 "`publish` extra (see /project-workspace:setup-doc-publish), not this step.")
    writing = ROOT / state["writing_dir"]
    if not writing.is_dir():
        sys.exit(f"{state['writing_dir']}/ does not exist. Run the `writing` step first.")

    pyproject = ROOT / "pyproject.toml"
    if pyproject.exists():
        say("  kept  pyproject.toml  (exists; it needs a `publish` extra that installs doc-publish)")
    else:
        write(pyproject, PYPROJECT_WRITING_ONLY.format(name=state["name"],
                                                       writing=state["writing_dir"]))

    # Per-machine and gitignored, like the analysis repo's .env in the full layout. It may
    # come to hold a Notion token, so an existing one is never rewritten.
    env = ROOT / ".env"
    if env.exists():
        has_doc_repo = any(line.split("=", 1)[0].strip() == "DOC_REPO"
                           for line in env.read_text(encoding="utf-8").splitlines())
        say("  kept  .env  (exists" + ("" if has_doc_repo else
            f"; it has no DOC_REPO, add: DOC_REPO={writing.as_posix()}") + ")")
    else:
        write(env, "# Per-machine; never commit. doc-publish reads the nearest .env above the cwd.\n"
                   f"DOC_REPO={writing.as_posix()}\n")

    if "publish" not in state.get("extras", []):
        state["extras"] = state.get("extras", []) + ["publish"]
        write_state(state)
    return 0


def cmd_add_analysis(args):
    """Move a writing-only workspace to the full layout (#18): create the analysis repo
    against the writing member already here, then rewire the root to match. The writing
    repo is not recreated or touched. What can be checked up front is checked before the
    analysis repo is created; a re-run reuses that repo and redoes only what is missing."""
    state = load_state().get("workspace", {})
    if not state:
        sys.exit("workspace.toml missing: this workspace is not set up. "
                 "Run /project-workspace:setup-doc-workspace from the start instead.")
    if state.get("layout", "full") == "full":
        wanted = {"analysis_dir": args.dir, "analysis_repo": args.repo, "backend": args.backend}
        differs = {k: state.get(k) for k, v in wanted.items() if state.get(k) != v}
        if differs:
            sys.exit("workspace.toml already records the full layout with "
                     + ", ".join(f"{k} = {v!r}" for k, v in differs.items())
                     + "; refusing to replace its analysis member.")
    writing = ROOT / state["writing_dir"]
    if not writing.is_dir():
        sys.exit(f"{state['writing_dir']}/ does not exist. Clone it back first: "
                 f"gh repo clone {state['writing_repo']} {state['writing_dir']}")

    pyproject = ROOT / "pyproject.toml"
    publish_root = PYPROJECT_WRITING_ONLY.format(name=state["name"], writing=state["writing_dir"])
    if pyproject.exists():
        text = pyproject.read_text(encoding="utf-8")
        try:
            uv = tomllib.loads(text).get("tool", {}).get("uv", {})
        except tomllib.TOMLDecodeError as exc:
            sys.exit(f"pyproject.toml is not valid TOML ({exc}). Fix or delete it, then re-run.")
        if uv.get("workspace", {}).get("members") == [args.dir]:
            replace_pyproject = False
        elif text == publish_root:
            replace_pyproject = True    # publish-root's, unedited: its `publish` extra carries over
        else:
            sys.exit("pyproject.toml exists and is not the one `publish-root` writes, so it "
                     "may hold your own edits. Delete it (its extras are kept in "
                     "workspace.toml) or make it list the member by hand, then re-run.")
    else:
        replace_pyproject = True

    checkout = ROOT / args.dir
    if checkout.exists() and any(checkout.iterdir()) and not (checkout / ".git").exists():
        sys.exit(f"{args.dir}/ exists and is not empty. Move it aside, then re-run.")

    # Fetched now, so a gh failure stops the step before the analysis repo exists rather
    # than after workspace.toml already says "full".
    claude_md = ROOT / "CLAUDE.md"
    current = claude_md.read_text(encoding="utf-8") if claude_md.exists() else None
    swap_claude_md = current is None or current in writing_only_claude_mds(state)
    full_claude_md = gh_raw(WORKSPACE_TEMPLATE, "CLAUDE.md") if swap_claude_md else None

    make_analysis(args, writing)

    dist = analysis_distribution(args.dir)
    extras = state.get("extras", [])
    if state.get("layout") == "writing-only":
        extras = list(dict.fromkeys([*base_extras(args.backend), *extras]))
    # Dropped and re-added rather than updated, so workspace.toml lists its keys in the
    # same order as one `root` writes for the full layout.
    state = {k: v for k, v in state.items()
             if k not in ("analysis_dir", "analysis_repo", "backend", "extras",
                          "analysis_distribution")}
    state |= {"layout": "full", "analysis_dir": args.dir, "analysis_repo": args.repo,
              "backend": args.backend, "extras": extras, "analysis_distribution": dist}

    if replace_pyproject:
        write(pyproject, full_pyproject(state["name"], dist, args.backend,
                                        state["writing_dir"], args.dir, extras))
    else:
        say("  kept  pyproject.toml  (already lists the member)")
    write_state(state)
    write_member_block([state["writing_dir"], args.dir])

    if (ROOT / ".env").exists():
        say(f"  kept  .env  (doc-publish now runs from {args.dir}/ and reads {args.dir}/.env: "
            f"move anything there but DOC_REPO, a Notion token say, then delete this one)")

    if swap_claude_md:
        write(claude_md, fill_claude_md(full_claude_md, state))
    elif f"{args.dir}/" in current:
        say(f"  kept  CLAUDE.md  (already names {args.dir}/)")
    else:
        say(f"  kept  CLAUDE.md  (edited since setup, so not swapped for the full layout's; "
            f"merge in https://github.com/{WORKSPACE_TEMPLATE}/blob/main/CLAUDE.md by hand)")

    say("\nDocument checks:")
    for problem in document_problems(writing) or ["ok: every Sections/<Name>/Figures/ "
                                                  "is in \\graphicspath"]:
        say(f"  {problem}")
    say(f"\nAnalysis repo ready at {args.dir}/. Next: `sync`, then the §7 proof.")
    return 0


def writing_only_claude_mds(state):
    """CLAUDE.md as `root` would have filled it for a writing-only workspace: from the
    template beside this script, and from every version a pre-plugin workspace carried in
    its own history. A template updated since setup must not make an untouched CLAUDE.md
    look edited."""
    texts = [WRITING_ONLY_CLAUDE_MD.read_text(encoding="utf-8")]
    path = LEGACY_WRITING_ONLY_CLAUDE_MD
    for commit in quiet(["git", "log", "--format=%H", "--", path], cwd=ROOT).stdout.split():
        shown = quiet(["git", "show", f"{commit}:{path}"], cwd=ROOT)
        if shown.returncode == 0:
            texts.append(shown.stdout)
    return {fill_claude_md(text, state) for text in texts}


def graphicspath_entries(writing):
    """Every directory listed by a \\graphicspath in the writing repo's root-level .sty and
    .tex files, as written there. Only those: doc-publish reads no others."""
    entries = []
    for path in sorted([*writing.glob("*.sty"), *writing.glob("*.tex")]):
        text = re.sub(r"(?<!\\)%.*", "", path.read_text(encoding="utf-8", errors="replace"))
        for match in re.finditer(r"\\graphicspath\s*\{", text):
            depth, i = 1, match.end()
            while depth and i < len(text):
                depth += {"{": 1, "}": -1}.get(text[i], 0)
                i += 1
            entries += [e.strip() for e in re.findall(r"\{([^{}]*)\}", text[match.end():i - 1])]
    return entries


def document_problems(writing):
    """What stops a generated figure landing in, or showing up in, the document. A
    writing-only document may never have needed Sections/<Name>/Figures/ (#3)."""
    sections = writing / "Sections"
    if not sections.is_dir():
        return ["no Sections/ yet: document_repo() raises until /project-workspace:adapt-existing-document "
                "moves the first section in (#3). The §7 proof waits for that."]
    entries = {e.removeprefix("./").rstrip("/") + "/" for e in graphicspath_entries(writing)}
    if not entries:
        return ["no \\graphicspath in a root-level .sty or .tex: generated figures will not "
                "resolve. See /project-workspace:adapt-existing-document, step 3."]
    missing = [s.name for s in sorted(sections.iterdir())
               if s.is_dir() and f"Sections/{s.name}/Figures/" not in entries]
    problems = [f"Sections/{name}/Figures/ is not in \\graphicspath: a figure saved for "
                f"{name} will not resolve. Add it (/project-workspace:adapt-existing-document, step 3)."
                for name in missing if (sections / name / "Figures").is_dir()]
    unstarted = [name for name in missing if not (sections / name / "Figures").is_dir()]
    if unstarted:
        problems.append(f"no Figures/ yet in {', '.join(unstarted)}: add its \\graphicspath "
                        f"entry before a section's first generated figure.")
    return problems


def cmd_sync(args):
    state = load_state().get("workspace", {})
    if not (ROOT / "pyproject.toml").exists():
        if state.get("layout") == "writing-only":
            say("Writing-only workspace with no pyproject.toml: nothing to install. "
                "Run `publish-root` first if you want doc-publish.")
            return 0
        sys.exit("pyproject.toml missing. Run the `root` step first.")
    default = [] if state.get("layout") == "writing-only" else base_extras("plotly")
    extras = state.get("extras", default) + (args.extra or [])
    cmd = ["uv", "sync"]
    for extra in dict.fromkeys(extras):
        cmd += ["--extra", extra]
    run(cmd, cwd=ROOT)
    return 0


# ---------------------------------------------------------------------------

def main(argv=None):
    global DRY_RUN
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="print what would run; change nothing")
    ap.add_argument("--root", help="the workspace root (default: the nearest directory holding "
                    "workspace.toml, else the current one)")
    sub = ap.add_subparsers(dest="step", required=True)

    p = sub.add_parser("check")
    p.add_argument("--layout", choices=LAYOUTS, default="full",
                   help="writing-only does not need the analysis template")

    p = sub.add_parser("workspace")
    p.add_argument("--repo", help="OWNER/NAME for this workspace's own repo")
    p.add_argument("--visibility", choices=("private", "public"), default="private")

    p = sub.add_parser("writing")
    p.add_argument("--mode", choices=("adapt", "import", "fresh"), required=True)
    p.add_argument("--repo", required=True)
    p.add_argument("--dir", required=True)
    p.add_argument("--title")
    p.add_argument("--author")
    p.add_argument("--source", help="import mode: OWNER/NAME, a local folder or .tex file, or a "
                        "document file (.docx, .odt, .md, ...) to convert with pandoc")
    p.add_argument("--visibility", choices=("private", "public"), default="private")

    p = sub.add_parser("analysis")
    p.add_argument("--repo", required=True)
    p.add_argument("--dir", required=True)
    p.add_argument("--writing-dir", required=True)
    p.add_argument("--distribution", required=True)
    p.add_argument("--author", required=True)
    p.add_argument("--backend", choices=("plotly", "matplotlib"), default="plotly")
    p.add_argument("--visibility", choices=("private", "public"), default="private")

    p = sub.add_parser("root")
    p.add_argument("--name", required=True)
    p.add_argument("--writing-dir", required=True)
    p.add_argument("--writing-repo", required=True)
    p.add_argument("--writing-mode", choices=("adapt", "import", "fresh"), required=True)
    p.add_argument("--layout", choices=LAYOUTS, default="full")
    p.add_argument("--analysis-dir", help="required for --layout full")
    p.add_argument("--analysis-repo", help="required for --layout full")
    p.add_argument("--backend", choices=("plotly", "matplotlib"),
                   help="--layout full only (default plotly)")
    p.add_argument("--python", default=WORKSPACE_PYTHON,
                   help=f"the venv's interpreter, written to .python-version "
                        f"(default {WORKSPACE_PYTHON})")

    sub.add_parser("publish-root")

    p = sub.add_parser("add-analysis", help="writing-only -> full")
    p.add_argument("--repo", required=True)
    p.add_argument("--dir", required=True)
    p.add_argument("--distribution", required=True)
    p.add_argument("--author", required=True)
    p.add_argument("--backend", choices=("plotly", "matplotlib"), default="plotly")
    p.add_argument("--visibility", choices=("private", "public"), default="private")

    p = sub.add_parser("sync")
    p.add_argument("--extra", action="append", help="an extra beyond workspace.toml's `extras`")

    args = ap.parse_args(argv)
    DRY_RUN = args.dry_run
    if args.root:
        set_root(args.root)
    if args.step == "writing" and args.mode != "adapt" and not (args.title and args.author):
        ap.error("--title and --author are required unless --mode adapt")
    if args.step == "root":
        if not PYTHON_PIN.fullmatch(args.python):
            ap.error(f"--python {args.python!r}: give a version such as 3.12 or 3.12.4")
        # A minor pin is held to the minimum's minor: uv then picks a 3.11.x that fits.
        pin = tuple(int(n) for n in args.python.split("."))
        if pin < MIN_PYTHON[:len(pin)]:
            ap.error(f"--python {args.python} is below the minimum, "
                     f"{'.'.join(map(str, MIN_PYTHON))}")
        if args.layout == "full":
            if not (args.analysis_dir and args.analysis_repo):
                ap.error("--analysis-dir and --analysis-repo are required for --layout full")
            args.backend = args.backend or "plotly"
        elif args.analysis_dir or args.analysis_repo or args.backend:
            ap.error("--analysis-dir, --analysis-repo and --backend do not apply to "
                     "--layout writing-only")

    return {"check": cmd_check, "workspace": cmd_workspace, "writing": cmd_writing,
            "analysis": cmd_analysis, "root": cmd_root, "publish-root": cmd_publish_root,
            "add-analysis": cmd_add_analysis, "sync": cmd_sync}[args.step](args)


if __name__ == "__main__":
    sys.exit(main())
