#!/usr/bin/env python3
"""Set up a project workspace and the documents in it.

A project workspace is a folder listing its documents in workspace.toml. Each document is a
document repo (LaTeX) with, optionally, its analysis repo nested inside it:

    <workspace>/
    |-- workspace.toml          schema = 2, one [[document]] per document
    |-- CLAUDE.md               generic rules, plus a managed table of the documents
    |-- thesis/                 a document repo (c-energie/writing-template, or Overleaf's sync repo)
    |   |-- layout.toml         present once it hosts its analysis repo
    |   `-- thesis-analysis/    the nested analysis repo, with its own .venv
    `-- paper/                  another document, writing only

There is no Python at the workspace root. Nothing about a document's analysis is recorded
here: its layout.toml says, and writing-template's setup-nested.sh writes it.

Driven by the setup-project-workspace, add-document and add-analysis skills. Each step is
also runnable by hand, and each refuses rather than overwrites when its target exists:

    check         prerequisites, with the install command for anything missing
    init          write workspace.toml and CLAUDE.md
    track         make the workspace a git repo (optional), and give it a GitHub remote
    add-document  create or adopt a document repo, and list it in workspace.toml
    add-analysis  nest an analysis repo in a document, through its setup-nested.sh
    document      which document a skill acts on, as JSON
    sync          uv sync a document's analysis venv with its recorded extras
    migrate       convert a schema-1 workspace (one document, side-by-side repos)

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
    `init` has written it, the current directory."""
    here = Path.cwd().resolve()
    return next((d for d in (here, *here.parents) if (d / "workspace.toml").is_file()), here)


def set_root(root):
    global ROOT, STATE_FILE, SETUP_DIR
    ROOT = Path(root).resolve()
    STATE_FILE = ROOT / "workspace.toml"
    SETUP_DIR = ROOT / ".setup"


set_root(default_root())

ORG = "c-energie"
WRITING_TEMPLATE = f"{ORG}/writing-template"
ANALYSIS_TEMPLATE = f"{ORG}/analysis-template"

SCHEMA = 2
# The workspace's CLAUDE.md. `init` writes it filled in; the documents table between the
# markers is rewritten whenever a document is added, and nothing outside them ever is.
WORKSPACE_CLAUDE_MD = Path(__file__).resolve().parent / "CLAUDE.workspace.md"
DOCS_START = "<!-- documents (managed by /project-workspace:add-document) -->"
DOCS_END = "<!-- /documents -->"

# The .gitignore lines naming the documents live between these markers, so a re-run (or a
# renamed document) replaces the block instead of appending a second one. Schema-1
# workspaces carry the old start marker; `migrate` swaps it.
BLOCK_START = "# >>> documents (managed by /project-workspace) >>>"
LEGACY_BLOCK_START = "# >>> members (managed by setup-doc-workspace) >>>"
BLOCK_END = "# <<< documents <<<"
LEGACY_BLOCK_END = "# <<< members <<<"
# The rest of a tracked workspace's .gitignore, written once by `track`.
GITIGNORE_REST = """\
# Setup scaffolding: import sources, executed notebooks, observer logs. Never commit it.
/.setup/

# Editors / OS
.idea/
.vscode/
.DS_Store
Thumbs.db
*.stackdump
"""

# Files carried from writing-template into an adopted Overleaf repo. Only the agent-facing
# ones and the nested-layout script: the layout of an existing document is adapted by hand,
# never overwritten (see the adapt-existing-document skill). AGENTS.md's "Agent skills"
# section points into docs/agents/, so those files travel with it or the pointers dangle.
# .gitattributes keeps setup-nested.sh LF, without which sh fails on its first line.
OVERLAY_FILES = ("AGENTS.md", "CLAUDE.md", "setup-nested.sh", ".gitattributes",
                 "docs/agents/issue-tracker.md", "docs/agents/triage-labels.md",
                 "docs/agents/domain.md")

# Converts an import source that is a single document file (Word, ODT, Markdown, ...) to
# LaTeX. Run through `uv run --with`, never installed globally or into a venv.
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
# A document's name and directory: one path segment, as a repo name allows.
DOC_NAME = re.compile(r"[A-Za-z0-9][\w.-]*")

MIN_PYTHON = (3, 11, 4)
# What the add-analysis skill offers for an analysis venv's interpreter. Unpinned, `uv sync`
# takes the newest interpreter allowed, and scientific stacks often have no wheels for it
# yet (#9). Not a default of the step: an adopted analysis repo may pin its own.
ANALYSIS_PYTHON = "3.12"
# A --python value: a minor (`3.12`) or a patch release (`3.12.4`), as `uv python pin` takes.
PYTHON_PIN = re.compile(r"\d+\.\d+(?:\.\d+)?")

NESTED_LAYOUT = "writing-hosts-analysis"
# A line only a setup-nested.sh that can record a checkout already in place carries
# (writing-template#13, which also brought --python). A document repo's copy without it
# predates both flags: add-analysis and migrate replace it before relying on them.
NESTED_SCRIPT_MARKER = "MODE=in-place"
BACKENDS = ("plotly", "matplotlib")

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


def toml_value(value):
    """A string, list of strings or bool as TOML. json.dumps writes valid TOML for these."""
    return json.dumps(value)


def write_state(state):
    """workspace.toml: the schema, the workspace's name, then one [[document]] per document.
    Each document's keys in a fixed order, so a rewrite diffs only what changed."""
    lines = ["# Written by /project-workspace and read by its skills. Edit it by hand to",
             "# rename a document's directory or repo, or to drop a document from the list",
             "# (deleting its directory is up to you).", "",
             f"schema = {SCHEMA}", f"name = {toml_value(state['name'])}"]
    for doc in state.get("document", []):
        lines += ["", "[[document]]"]
        lines += [f"{key} = {toml_value(doc[key])}"
                  for key in ("name", "dir", "repo", "extras") if key in doc]
    write(STATE_FILE, "\n".join(lines) + "\n")


def read_state(required=True):
    """workspace.toml at the current schema, or {} when it is missing and not `required`.
    Stops on a schema-1 file: every step but `migrate` works on schema 2 only."""
    state = load_state()
    if not state:
        if required:
            sys.exit("workspace.toml missing: this is not a project workspace yet. "
                     "Run /project-workspace:setup-project-workspace first.")
        return {}
    if is_legacy(state):
        sys.exit("workspace.toml is from before documents were nested (schema 1). "
                 "Run the `migrate` step first (/project-workspace:setup-project-workspace).")
    if state.get("schema") != SCHEMA:
        sys.exit(f"workspace.toml has schema = {state.get('schema')!r}; this plugin reads "
                 f"{SCHEMA}. Update the plugin, or fix the file by hand.")
    state.setdefault("document", [])
    return state


def is_legacy(state):
    return "schema" not in state and "workspace" in state


def tracked():
    """Whether the workspace is a git repo of its own. Nothing records it but `.git`."""
    return (ROOT / ".git").exists()


def read_layout(document_dir):
    """A document repo's layout.toml, or {}. Read only: setup-nested.sh owns it."""
    layout = document_dir / "layout.toml"
    if not layout.is_file():
        return {}
    try:
        return tomllib.loads(layout.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        sys.exit(f"{layout} is not valid TOML ({exc}). Fix it before going on.")


def analysis_dir_of(document_dir):
    """The nested analysis repo's directory, relative to the document repo, or None."""
    layout = read_layout(document_dir)
    if layout.get("layout") == NESTED_LAYOUT and layout.get("nested_dir"):
        return str(layout["nested_dir"]).rstrip("/")
    return None


def describe(doc):
    """What a skill needs to know about one document, every path absolute."""
    path = ROOT / doc["dir"]
    analysis = analysis_dir_of(path) if path.is_dir() else None
    return {"name": doc["name"], "dir": doc["dir"], "repo": doc["repo"],
            "path": path.as_posix(), "exists": path.is_dir(),
            "analysis_dir": analysis,
            "analysis_path": (path / analysis).as_posix() if analysis else None,
            "extras": doc.get("extras", [])}


def find_document(state, wanted=None, cwd=None):
    """The document a skill acts on: the one named (by name or directory); else the one
    the current directory is inside; else the only one. Stops, listing them, otherwise."""
    docs = state["document"]
    if wanted:
        for doc in docs:
            if wanted in (doc["name"], doc["dir"]):
                return doc
        sys.exit(f"No document {wanted!r} in workspace.toml. Documents: "
                 + (", ".join(d["name"] for d in docs) or "none yet"))
    here = Path(cwd or Path.cwd()).resolve()
    for doc in docs:
        if here == ROOT / doc["dir"] or (ROOT / doc["dir"]) in here.parents:
            return doc
    if len(docs) == 1:
        return docs[0]
    if not docs:
        sys.exit("workspace.toml lists no documents yet: run /project-workspace:add-document.")
    sys.exit("More than one document; name one with --document. Documents: "
             + ", ".join(d["name"] for d in docs))


def render_documents_table(state):
    rows = ["| Document | Directory | Repo | Analysis repo |", "|---|---|---|---|"]
    for doc in state["document"]:
        info = describe(doc)
        analysis = f"`{doc['dir']}/{info['analysis_dir']}/`" if info["analysis_dir"] else "—"
        rows.append(f"| {doc['name']} | `{doc['dir']}/` | `{doc['repo']}` | {analysis} |")
    if not state["document"]:
        rows.append("| _none yet: /project-workspace:add-document_ | | | |")
    return "\n".join([DOCS_START, *rows, DOCS_END])


def refresh_claude_md(state):
    """Write CLAUDE.md from the plugin's text if it is missing; otherwise rewrite only the
    documents table between its markers. A CLAUDE.md with no markers is the user's own and
    is left alone."""
    claude_md = ROOT / "CLAUDE.md"
    table = render_documents_table(state)
    if not claude_md.exists():
        text = WORKSPACE_CLAUDE_MD.read_text(encoding="utf-8").replace("<<WORKSPACE>>", state["name"])
        write(claude_md, replace_between(text, DOCS_START, DOCS_END, table))
        return
    text = claude_md.read_text(encoding="utf-8")
    if DOCS_START not in text or DOCS_END not in text:
        say("  kept  CLAUDE.md  (it has no documents table; not the plugin's text)")
        return
    new = replace_between(text, DOCS_START, DOCS_END, table)
    if new != text:
        write(claude_md, new)


def replace_between(text, start, end, block):
    head, _, rest = text.partition(start)
    _, _, tail = rest.partition(end)
    return head + block + tail


def write_document_block(state):
    """The .gitignore block naming every document, replaced in place if already there.
    Only in a tracked workspace; everything outside the markers is the user's and is kept."""
    if not tracked():
        return
    gitignore = ROOT / ".gitignore"
    text = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
    block = "\n".join([BLOCK_START,
                       "# Each document is its own repo with its own remote. Tracking one here",
                       "# would nest one history inside another.",
                       *(f"/{doc['dir']}/" for doc in state["document"]), BLOCK_END])
    for start, end in ((BLOCK_START, BLOCK_END), (LEGACY_BLOCK_START, LEGACY_BLOCK_END)):
        if start in text and end in text:
            new = replace_between(text, start, end, block)
            break
    else:
        new = block + "\n\n" + (text or GITIGNORE_REST)
    if new != text:
        write(gitignore, new)


def checked_python(value):
    """A --python value, or a parser error naming what is wrong with it."""
    if not PYTHON_PIN.fullmatch(value):
        raise argparse.ArgumentTypeError(f"{value!r}: give a version such as 3.12 or 3.12.4")
    # A minor pin is held to the minimum's minor: uv then picks a 3.11.x that fits.
    pin = tuple(int(n) for n in value.split("."))
    if pin < MIN_PYTHON[:len(pin)]:
        raise argparse.ArgumentTypeError(
            f"{value} is below the minimum, {'.'.join(map(str, MIN_PYTHON))}")
    return value


def checked_name(value):
    if not DOC_NAME.fullmatch(value):
        raise argparse.ArgumentTypeError(
            f"{value!r}: one path segment of letters, digits, '.', '_' and '-'")
    return value


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


def stage_import_source(source, import_dir):
    """Put the existing document somewhere the adapt-existing-document skill can read it
    from: `.setup/[document dir]/import-source/` at the workspace root. Never inside a
    document repo: it is scaffolding, deleted once the import is done."""
    shown = import_dir.relative_to(ROOT).as_posix() + "/"
    if not source:
        say(f"No --source given; copy the existing document into {shown} by hand.")
        return
    if import_dir.exists():
        say(f"{shown} already exists; leaving it alone.")
        return
    kind, where = classify_source(source)
    if kind == "document-file":
        convert_document(where, import_dir)
    elif kind in ("directory", "tex-file"):
        say(f"  copy  {where} -> {shown}")
        if not DRY_RUN:
            shutil.copytree(where, import_dir, ignore=shutil.ignore_patterns(".git"))
    else:
        if not DRY_RUN:
            import_dir.parent.mkdir(parents=True, exist_ok=True)
        run(["gh", "repo", "clone", where, str(import_dir)], cwd=ROOT)


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


def convert_document(path, import_dir):
    """Convert a single document file into [import_dir]/<stem>.tex, its images in
    media/ beside it. pandoc runs in that directory so the image paths it writes are
    relative. The only fix applied afterwards is stripping caption number prefixes: the
    rest is a checklist in adapt-existing-document, because it needs judgement."""
    tex = import_dir / f"{path.stem}.tex"
    say(f"  convert  {path.name} -> {tex.relative_to(ROOT).as_posix()}  "
        f"(pandoc via {PANDOC_PIN}; the first run downloads {PANDOC_DOWNLOAD})")
    if not DRY_RUN:
        import_dir.mkdir(parents=True)
    try:
        result = run(["uv", "run", "--no-project", "--with", PANDOC_PIN, "python", "-c", RUN_PANDOC,
                      "--from", PANDOC_READERS[path.suffix.lower()], "--to", "latex", "--standalone",
                      "--extract-media=media", "--output", tex.name, path.resolve()],
                     cwd=import_dir, check=False)
    except OSError as exc:      # uv itself missing
        result = subprocess.CompletedProcess([], 127, "", str(exc))
    if result.returncode != 0:
        # Removed, or a re-run would find it and leave the half-made import alone.
        shutil.rmtree(import_dir, ignore_errors=True)
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
                "moves the first section in (#3). The add-analysis proof waits for that."]
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

    if args.analysis:
        # setup-nested.sh is POSIX sh: Git Bash's on Windows, which need not be on PATH.
        sh = find_sh()
        say(f"[{'ok' if sh else 'FAIL'}] sh{'' if sh else '  ->  ' + INSTALL['git'][os_name] + '   (Git for Windows ships it)'}")
        missing_required |= not sh

    if shutil.which("gh"):
        auth = quiet(["gh", "auth", "status"])
        if auth.returncode == 0:
            login = quiet(["gh", "api", "user", "--jq", ".login"]).stdout.strip()
            say(f"[ok] gh authenticated as {login}")
        else:
            missing_required = True
            say("[FAIL] gh not authenticated  ->  gh auth login   (choose HTTPS, and let it configure git)")

    templates = [WRITING_TEMPLATE] + ([ANALYSIS_TEMPLATE] if args.analysis else [])
    for repo in templates:
        if shutil.which("gh") and not repo_exists(repo):
            missing_required = True
            say(f"[FAIL] cannot see template {repo} with your gh login")

    say("\nAll required prerequisites present." if not missing_required
        else "\nInstall the FAIL items above, open a NEW terminal so PATH updates, then re-run.")
    return 1 if missing_required else 0


def find_sh():
    """A POSIX sh: on PATH, else the one beside Git for Windows' git.exe (Git/bin/sh.exe),
    which a PowerShell or cmd session does not have on PATH."""
    found = shutil.which("sh")
    if found:
        return found
    git = shutil.which("git")
    if not git:
        return None
    for parent in Path(git).resolve().parents:
        for candidate in (parent / "bin" / "sh.exe", parent / "usr" / "bin" / "sh.exe"):
            if candidate.is_file():
                return str(candidate)
    return None


def cmd_init(args):
    """Make this folder a project workspace: workspace.toml and CLAUDE.md. Safe to re-run."""
    state = load_state()
    if is_legacy(state):
        sys.exit("workspace.toml is from before documents were nested (schema 1): run "
                 "`migrate` instead of `init`.")
    if state:
        state = read_state()
        say(f"workspace.toml exists (name = {state['name']!r}, "
            f"{len(state['document'])} document(s)); keeping it.")
    else:
        state = {"name": args.name or ROOT.name, "document": []}
        write_state(state)
    refresh_claude_md(state)
    write_document_block(state)
    say(f"\nProject workspace ready at {ROOT}. "
        + ("It is a git repo." if tracked() else "It is not a git repo (`track` makes it one)."))
    return 0


def cmd_track(args):
    """Optional: make the workspace a git repo, ignoring every document, and give it a
    GitHub remote if --repo is given. It never commits."""
    state = read_state()
    if not tracked():
        run(["git", "init"], cwd=ROOT)
    write_document_block(state)
    if not args.repo:
        origin = origin_url(ROOT)
        say(f"origin is {origin}." if origin else
            "No origin. Re-run with --repo OWNER/NAME to create one on GitHub.")
        return 0
    origin = origin_url(ROOT)
    if origin:
        say(f"origin is already {origin}; leaving it.")
        return 0
    if repo_exists(args.repo):
        sys.exit(f"{args.repo} already exists. Point origin at it by hand: "
                 f"git remote add origin https://github.com/{args.repo}.git")
    has_commits = quiet(["git", "rev-parse", "HEAD"], cwd=ROOT).returncode == 0
    cmd = ["gh", "repo", "create", args.repo, f"--{args.visibility}",
           "--source", ".", "--remote", "origin"]
    run(cmd + (["--push"] if has_commits else []), cwd=ROOT)
    return 0


def cmd_add_document(args):
    """Create or adopt one document repo inside the workspace, and list it."""
    state = read_state()
    name = args.name or args.dir
    for doc in state["document"]:
        if doc["name"] == name or doc["dir"] == args.dir:
            if (doc["name"], doc["dir"], doc["repo"]) != (name, args.dir, args.repo):
                sys.exit(f"workspace.toml already lists document {doc['name']!r} in "
                         f"{doc['dir']}/ from {doc['repo']}; refusing to replace it.")
    checkout = ROOT / args.dir
    if checkout.exists() and any(checkout.iterdir()) and not (checkout / ".git").exists():
        sys.exit(f"{args.dir}/ exists and is not empty. Move it aside, then re-run.")

    if args.mode == "adapt":
        # The Overleaf project's own GitHub-sync repo (or a repo already made from
        # writing-template) becomes the document repo, history intact. Nothing here creates it.
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
            stage_import_source(args.source, SETUP_DIR / args.dir / "import-source")

    if not any(doc["dir"] == args.dir for doc in state["document"]):
        state["document"].append({"name": name, "dir": args.dir, "repo": args.repo})
        write_state(state)
    refresh_claude_md(state)
    write_document_block(state)
    say(f"\nDocument {name!r} ready at {args.dir}/. Nothing has been committed in it.")
    return 0


def cmd_add_analysis(args):
    """Nest an analysis repo in one document, through that document's own setup-nested.sh:
    create it from analysis-template, adopt one with --from, or restore it from layout.toml.
    The document repo carries the script (writing-template ships it; `add-document --mode
    adapt` copies it in), so one implementation serves this skill and a lone checkout."""
    state = read_state()
    doc = find_document(state, args.document)
    document = ROOT / doc["dir"]
    if not document.is_dir():
        sys.exit(f"{doc['dir']}/ does not exist. Clone it back first: "
                 f"gh repo clone {doc['repo']} {doc['dir']}")
    install_setup_nested(document, fetch_setup_nested(document))
    sh = find_sh()
    if not sh:
        sys.exit("No POSIX sh found. On Windows it comes with Git for Windows: "
                 + INSTALL["git"]["windows"])

    flags = ["--backend", args.backend]
    for flag, value in (("--from", args.source), ("--dir", args.dir), ("--owner", args.owner),
                        ("--name", args.repo_name), ("--python", args.python)):
        if value:
            flags += [flag, value]
    if args.public:
        flags.append("--public")
    init_flags = [f"--{k}={v}" for k, v in (("distribution", args.distribution),
                                            ("author", args.author)) if v]
    run([sh, "setup-nested.sh", *flags, *(["--", *init_flags] if init_flags else [])],
        cwd=document, env=os.environ | {"PYTHONIOENCODING": "utf-8"})

    extras = list(dict.fromkeys(["dev", "notebooks", args.backend, *doc.get("extras", [])]))
    if doc.get("extras") != extras:
        doc["extras"] = extras
        write_state(state)
    refresh_claude_md(state)
    analysis = analysis_dir_of(document) if not DRY_RUN else (args.dir or "ANALYSIS_DIR")
    say("\nDocument checks:")
    for problem in document_problems(document) or ["ok: every Sections/<Name>/Figures/ "
                                                   "is in \\graphicspath"]:
        say(f"  {problem}")
    say(f"\nAnalysis repo ready at {doc['dir']}/{analysis}/, with its own venv. "
        "Next: the plotly check and the proof (add-analysis, §4).")
    return 0


def setup_nested_state(document):
    """'current', 'missing' or 'outdated': the document repo's copy of setup-nested.sh."""
    script = document / "setup-nested.sh"
    if not script.is_file():
        return "missing"
    text = script.read_text(encoding="utf-8", errors="replace")
    return "current" if NESTED_SCRIPT_MARKER in text else "outdated"


def fetch_setup_nested(document):
    """writing-template's setup-nested.sh when the document's copy is missing or outdated,
    else None. Fetched before anything changes, so a gh failure stops a step cleanly."""
    if setup_nested_state(document) == "current":
        return None
    return gh_raw(WRITING_TEMPLATE, "setup-nested.sh")


def install_setup_nested(document, text):
    """Write a fetched setup-nested.sh into the document repo, plus the .gitattributes that
    keeps it LF if there is none. Both are the document repo's files, to commit there."""
    if text is None:
        return
    state = setup_nested_state(document)
    write(document / "setup-nested.sh", text)
    if not (document / ".gitattributes").exists():
        write(document / ".gitattributes", gh_raw(WRITING_TEMPLATE, ".gitattributes"))
    say(f"  ({'updated an outdated' if state == 'outdated' else 'added'} setup-nested.sh in "
        f"{document.name}/: commit it there; it restores the analysis repo on a fresh clone)")


def cmd_document(args):
    """Print the document a skill should act on, or every document with --all, as JSON."""
    state = read_state()
    if args.all:
        print(json.dumps([describe(doc) for doc in state["document"]], indent=2))
    else:
        print(json.dumps(describe(find_document(state, args.document)), indent=2))
    return 0


def cmd_sync(args):
    """uv sync in a document's analysis repo, passing every extra workspace.toml records
    for it: a bare `uv sync` removes the extras it is not given. --extra adds one and
    records it."""
    state = read_state()
    doc = find_document(state, args.document)
    info = describe(doc)
    if not info["analysis_path"]:
        sys.exit(f"{doc['name']} has no analysis repo, so no venv: nothing to sync. "
                 "(doc-publish for it runs through uvx; see /project-workspace:setup-doc-publish.)")
    extras = list(dict.fromkeys([*doc.get("extras", []), *(args.extra or [])]))
    if not extras:
        sys.exit(f"workspace.toml records no extras for {doc['name']}. Pass them: "
                 "--extra dev --extra notebooks --extra plotly")
    if extras != doc.get("extras"):
        doc["extras"] = extras
        write_state(state)
    cmd = ["uv", "sync"]
    for extra in extras:
        cmd += ["--extra", extra]
    run(cmd, cwd=Path(info["analysis_path"]))
    return 0


# ---------------------------------------------------------------------------
# migrate: schema 1 (one document, side-by-side members, root venv) -> schema 2
# ---------------------------------------------------------------------------

# What schema 1 kept at the root and schema 2 does not. Backed up to .setup/migrate-backup/
# before deletion, never just deleted: either may hold the user's own edits.
LEGACY_ROOT_FILES = ("pyproject.toml", "uv.lock", ".python-version")


def migrate_plan(legacy):
    """Everything `migrate` will do, as a list of lines, and the stops that prevent it."""
    layout = legacy.get("layout") or ("full" if "analysis_dir" in legacy else "writing-only")
    writing = legacy.get("writing_dir")
    stops, plan = [], []
    if not writing or not (ROOT / writing / ".git").exists():
        stops.append(f"the document repo {writing or '(writing_dir unset)'}/ is not a checkout here")
    analysis = legacy.get("analysis_dir") if layout == "full" else None
    if analysis:
        source = ROOT / analysis
        target = ROOT / writing / analysis
        if not (source / ".git").exists():
            if (target / ".git").exists():
                plan.append(f"{analysis}/ is already inside {writing}/; not moved again")
            else:
                stops.append(f"the analysis repo {analysis}/ is not a checkout here")
        else:
            if target.exists():
                stops.append(f"{writing}/{analysis} already exists; cannot move {analysis}/ there")
            if not origin_url(source):
                stops.append(f"{analysis}/ has no origin remote; nested_remote needs one")
            plan.append(f"move {analysis}/ -> {writing}/{analysis}/  (close Jupyter, IDEs and "
                        "terminals inside it first: Windows will not move an open directory)")
        nested = setup_nested_state(ROOT / writing) if writing else "current"
        if nested != "current":
            plan.append(f"{'update the outdated' if nested == 'outdated' else 'add'} "
                        f"{writing}/setup-nested.sh from {WRITING_TEMPLATE} first (commit it "
                        "there): only a current one can record a checkout in place")
        plan.append(f"run {writing}/setup-nested.sh --dir {analysis}: gitignore it, write "
                    f"layout.toml, build its own .venv")
        plan.append(f"uv sync there with the extras {legacy.get('extras', [])}")
    for name in LEGACY_ROOT_FILES:
        if (ROOT / name).exists():
            plan.append(f"back up and remove {name}  (-> .setup/migrate-backup/)")
    if (ROOT / ".venv").exists():
        plan.append("delete the root .venv")
    if (ROOT / ".env").exists():
        plan.append("keep the root .env; doc-publish settings in it move per document "
                    "(/project-workspace:setup-doc-publish)")
    plan.append("rewrite workspace.toml as schema 2, listing one document")
    plan.append("back up CLAUDE.md and write the plugin's workspace text in its place")
    if tracked():
        plan.append("rewrite the .gitignore member block as a documents block")
    return layout, plan, stops


def cmd_migrate(args):
    state = load_state()
    if not state:
        sys.exit("workspace.toml missing: nothing to migrate. Use `init`.")
    if not is_legacy(state):
        say(f"workspace.toml is already schema {state.get('schema')}; nothing to migrate.")
        leftovers = [n for n in (*LEGACY_ROOT_FILES, ".venv") if (ROOT / n).exists()]
        if leftovers:
            say(f"Left at the root from schema 1: {', '.join(leftovers)}. A migrate that "
                "stopped part-way leaves these; once `add-analysis` and `sync` have run for "
                "the document, back them up and delete them.")
        return 0
    legacy = state["workspace"]
    layout, plan, stops = migrate_plan(legacy)
    say(f"Migrating the {layout} workspace {legacy.get('name')!r}:")
    for line in plan:
        say(f"  - {line}")
    if stops:
        sys.exit("\nCannot migrate:\n" + "\n".join(f"  - {s}" for s in stops))
    if DRY_RUN:
        return 0

    writing = legacy["writing_dir"]
    document = ROOT / writing
    backup = SETUP_DIR / "migrate-backup"
    # The root pin becomes the analysis repo's. A re-run after a stop finds it backed up.
    python = None
    for pin in (ROOT / ".python-version", backup / ".python-version"):
        if pin.exists():
            python = pin.read_text(encoding="utf-8").strip() or None
            break

    # A document repo's setup-nested.sh from before in-place --dir would refuse the moved
    # checkout after everything below had changed: fetched now, while a failure costs nothing,
    # and installed before the move.
    if layout == "full" and legacy.get("analysis_dir"):
        install_setup_nested(document, fetch_setup_nested(document))

    # Replaced, not merged: the old text describes the side-by-side layout. Out of the way
    # first, so every step below that refreshes CLAUDE.md writes the new one.
    claude_md = ROOT / "CLAUDE.md"
    if claude_md.exists():
        backup_file(claude_md, backup)
        claude_md.unlink()

    analysis = legacy.get("analysis_dir") if layout == "full" else None
    if analysis:
        # The root venv goes first: it is what an IDE or kernel most often holds open.
        remove_tree(ROOT / ".venv")
        if (ROOT / analysis / ".git").exists():
            say(f"  move  {analysis}/ -> {writing}/{analysis}/")
            try:
                shutil.move(str(ROOT / analysis), str(document / analysis))
            except OSError as exc:
                sys.exit(f"Could not move {analysis}/ ({exc}). Close whatever has it open, "
                         "then re-run `migrate`: nothing else has changed yet.")
        # Before any uv runs in the analysis repo: uv looks upward for a workspace root, and
        # would find the old one here and sync into it.
        remove_legacy_root(backup)
        args_ns = argparse.Namespace(
            document=None, source=None, dir=analysis, owner=None, repo_name=None, public=False,
            backend=legacy.get("backend", "plotly"), python=python, distribution=None,
            author=None)
        # add-analysis reads schema 2, so workspace.toml is rewritten first.
        new_state = {"name": legacy.get("name") or ROOT.name,
                     "document": [{"name": legacy.get("name") or writing, "dir": writing,
                                   "repo": legacy.get("writing_repo", ""),
                                   "extras": legacy.get("extras", [])}]}
        backup_file(STATE_FILE, backup)
        write_state(new_state)
        cmd_add_analysis(args_ns)
        state = read_state()
        cmd_sync(argparse.Namespace(document=None, extra=None))
    else:
        backup_file(STATE_FILE, backup)
        state = {"name": legacy.get("name") or ROOT.name,
                 "document": [{"name": legacy.get("name") or writing, "dir": writing,
                               "repo": legacy.get("writing_repo", "")}]}
        write_state(state)

    remove_legacy_root(backup)
    refresh_claude_md(state)
    write_document_block(state)
    say(f"\nMigrated. Backups are in .setup/migrate-backup/: merge anything of yours from the "
        f"old CLAUDE.md into the new one, then delete them."
        + ("\nCommit at the root: workspace.toml, CLAUDE.md, .gitignore, and the removals."
           if tracked() else ""))
    return 0


def remove_legacy_root(backup):
    """Back up and remove the root pyproject.toml, uv.lock and .python-version, and delete
    the root .venv: schema 2 has no Python at the root."""
    for name in LEGACY_ROOT_FILES:
        if (ROOT / name).exists():
            backup_file(ROOT / name, backup)
            say(f"  remove {name}")
            (ROOT / name).unlink()
    remove_tree(ROOT / ".venv")


def backup_file(path, backup):
    say(f"  back up {path.relative_to(ROOT)} -> {backup.relative_to(ROOT)}/")
    if not DRY_RUN:
        backup.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, backup / path.name)


def remove_tree(path):
    if path.exists():
        say(f"  delete {path.relative_to(ROOT)}/")
        if not DRY_RUN:
            shutil.rmtree(path)


# ---------------------------------------------------------------------------

def main(argv=None):
    global DRY_RUN
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="print what would run; change nothing")
    ap.add_argument("--root", help="the workspace root (default: the nearest directory holding "
                    "workspace.toml, else the current one)")
    sub = ap.add_subparsers(dest="step", required=True)

    p = sub.add_parser("check")
    p.add_argument("--analysis", action="store_true",
                   help="also what add-analysis needs: sh, and the analysis template")

    p = sub.add_parser("init")
    p.add_argument("--name", help="the workspace's name (default: this folder's)")

    p = sub.add_parser("track")
    p.add_argument("--repo", help="OWNER/NAME to create on GitHub as this workspace's origin")
    p.add_argument("--visibility", choices=("private", "public"), default="private")

    p = sub.add_parser("add-document")
    p.add_argument("--mode", choices=("adapt", "import", "fresh"), required=True)
    p.add_argument("--repo", required=True)
    p.add_argument("--dir", type=checked_name, help="default: the repo's name")
    p.add_argument("--name", type=checked_name, help="default: the directory's name")
    p.add_argument("--title")
    p.add_argument("--author")
    p.add_argument("--source", help="import mode: OWNER/NAME, a local folder or .tex file, or a "
                        "document file (.docx, .odt, .md, ...) to convert with pandoc")
    p.add_argument("--visibility", choices=("private", "public"), default="private")

    p = sub.add_parser("add-analysis")
    p.add_argument("--document", help="name or directory (default: see `document`)")
    p.add_argument("--from", dest="source", help="adopt this repo (anything git clone takes)")
    p.add_argument("--dir", help="inside the document repo (default: [document repo]-analysis)")
    p.add_argument("--owner")
    p.add_argument("--repo-name", help="the new repo's name (default: [document repo]-analysis)")
    p.add_argument("--public", action="store_true")
    p.add_argument("--backend", choices=BACKENDS, default="plotly")
    p.add_argument("--python", type=checked_python,
                   help=f"written to the analysis repo's .python-version (offer {ANALYSIS_PYTHON}; "
                        "left out, an existing pin is kept)")
    p.add_argument("--distribution", help="the analysis repo's distribution name")
    p.add_argument("--author")

    p = sub.add_parser("document")
    p.add_argument("--document", help="name or directory")
    p.add_argument("--all", action="store_true", help="every document")

    p = sub.add_parser("sync")
    p.add_argument("--document", help="name or directory")
    p.add_argument("--extra", action="append", help="an extra to add, and record")

    sub.add_parser("migrate")

    args = ap.parse_args(argv)
    DRY_RUN = args.dry_run
    if args.root:
        set_root(args.root)
    if args.step == "add-document":
        if args.mode != "adapt" and not (args.title and args.author):
            ap.error("--title and --author are required unless --mode adapt")
        if not REPO_NAME.fullmatch(args.repo):
            ap.error(f"--repo {args.repo!r}: give OWNER/NAME")
        if not args.dir:
            try:
                args.dir = checked_name(args.repo.split("/")[-1])
            except argparse.ArgumentTypeError as exc:
                ap.error(f"--dir: {exc}")

    return {"check": cmd_check, "init": cmd_init, "track": cmd_track,
            "add-document": cmd_add_document, "add-analysis": cmd_add_analysis,
            "document": cmd_document, "sync": cmd_sync, "migrate": cmd_migrate}[args.step](args)


if __name__ == "__main__":
    sys.exit(main())
