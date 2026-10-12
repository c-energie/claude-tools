#!/usr/bin/env python3
"""Copy an existing analysis project into a document's analysis repo. The source is read, never written.

Driven by the `adapt-existing-analysis` skill. Three steps; `copy` and `verify` are safe
to re-run, and `plan` refuses to overwrite a plan that may hold agreed placements:

    plan     inventory the source (every file, with its SHA-256) and write a placement plan
             to .setup/analysis-import/plan.json -- one `dest` per file, edited before copying.
             --document picks whose analysis repo (see setup_workspace.py `document`).
             --include GLOB (repeatable) scopes it to part of a larger project: files
             matching no glob are still inventoried, but planned as `dest: null`.
             A source's own copy of doc_analysis is planned as `dest: null` too, and
             imports of doc_analysis modules the template lacks are printed as warnings.
             The source's requires-python / .python-version are printed, with a warning
             when the analysis repo's .python-version falls outside requires-python (or,
             without one, names another minor than the source's .python-version)
    copy     copy every planned file to its `dest` inside the analysis repo
    verify   re-hash the source against the inventory, and re-list every file in it
             (ignored ones included): exit 1 if anything changed, appeared or vanished

Nothing here opens a source file for writing, deletes, moves or renames one, or runs a
git command that changes the source checkout. `copy` refuses to start if the source no
longer matches the inventory, and refuses any `dest` that resolves outside the analysis
repo -- so the source cannot be a destination either.

Run with uv so no system Python is needed:

    uv run --no-project --python 3.12 path/to/copy_analysis.py --root <workspace> plan --source ../old-analysis

The script ships in the project-workspace@c-energie plugin, so the skill passes --root (its
${CLAUDE_PROJECT_DIR}). Without it, the root is the nearest directory at or above the
current one holding workspace.toml, else the current directory.

Stdlib only.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path, PurePosixPath


def default_root():
    """The nearest directory at or above the current one holding workspace.toml, else the
    current directory."""
    here = Path.cwd().resolve()
    return next((d for d in (here, *here.parents) if (d / "workspace.toml").is_file()), here)


def set_root(root):
    global ROOT, STATE_FILE, WORK_DIR, PLAN, CLONE_DIR
    ROOT = Path(root).resolve()
    STATE_FILE = ROOT / "workspace.toml"
    WORK_DIR = ROOT / ".setup" / "analysis-import"
    PLAN = WORK_DIR / "plan.json"
    CLONE_DIR = ROOT / ".setup" / "analysis-source"


set_root(default_root())

SKIP_DIRS = {".git", ".venv", "venv", "env", "__pycache__", ".ipynb_checkpoints",
             ".pytest_cache", ".mypy_cache", ".idea", ".vscode", "node_modules", "build", "dist"}
# Bigger than this is probably data or output, which belongs wherever the data lives rather
# than in a git repo. Planned as skipped; the user can still give it a dest.
LARGE = 1_000_000
# Where a source that began as a fork of analysis-template keeps its own doc_analysis.
# The analysis repo already has one, and a second copy -- older, divergent API -- would
# collide with it by name (#15). Planned as skipped; still hashed, so verify covers it.
BUNDLED_PACKAGES = (PurePosixPath("src/doc_analysis"), PurePosixPath("doc_analysis"))
BUNDLED_WHY = "the template provides doc_analysis"
# `import doc_analysis.<x>` and `from doc_analysis.<x>[.<y>] import ...`, one per line.
# `from doc_analysis import <x>` is not matched: <x> may be any name the package exports,
# so it says nothing reliable about which modules the source expected.
FORK_IMPORT = re.compile(r"^\s*(?:import|from)\s+doc_analysis\.(\w+)", re.MULTILINE)
# One requires-python clause: `>=3.11.4`, `<3.14`, `==3.12.*`, `~=3.10`.
SPEC_CLAUSE = re.compile(r"\s*(~=|==|!=|<=|>=|<|>)\s*(\d+(?:\.\d+)*)(\.\*)?\s*")
# A plain version pin, as `uv python pin` writes one: `3.12` or `3.12.4`.
PIN = re.compile(r"\d+\.\d+(?:\.\d+)?")
# Pads a version to three parts as the top of a range: 3.12 -> 3.12.<any patch>.
PATCH_MAX = 10**9
# What a re-pin is followed by; the adapt skill spells it out the same way.
SETUP_SCRIPT = Path(__file__).resolve().parents[1] / "setup-project-workspace" / "setup_workspace.py"
RESYNC = f'uv run --no-project --python 3.12 "{SETUP_SCRIPT.as_posix()}" sync --document [name]'

# Which document, and where its analysis repo is, is setup_workspace.py's to answer: one
# rule for every skill. Imported from beside it, as the plugin ships both.
sys.path.insert(0, str(SETUP_SCRIPT.parent))
import setup_workspace  # noqa: E402


def say(msg=""):
    print(msg, flush=True)


def git(source, *args):
    """Read-only git queries against the source. Only ever called with ls-files,
    rev-parse and status; --no-optional-locks stops `status` refreshing .git/index."""
    result = subprocess.run(["git", "--no-optional-locks", "-C", str(source), *args],
                            capture_output=True)
    return result.stdout if result.returncode == 0 else None


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def document_info(document=None):
    """setup_workspace.py's description of the document acted on: the one named, else the
    one the current directory is inside, else the only one."""
    setup_workspace.set_root(ROOT)
    state = setup_workspace.read_state()
    return setup_workspace.describe(setup_workspace.find_document(state, document))


def analysis_root(override=None, document=None):
    if override:
        return (ROOT / override).resolve()
    info = document_info(document)
    if not info["analysis_path"]:
        sys.exit(f"{info['name']} has no analysis repo yet: run /project-workspace:add-analysis first.")
    return Path(info["analysis_path"]).resolve()


def writing_sections(document=None):
    """Leaf directories under the document's Sections/, to suggest notebook folders from."""
    if not STATE_FILE.exists():
        return []
    sections = Path(document_info(document)["path"]) / "Sections"
    if not sections.is_dir():
        return []
    return sorted(p.relative_to(sections).as_posix() for p in sections.rglob("*")
                  if p.is_dir() and p.name not in ("Figures", "Tables")
                  and not any(c.is_dir() and c.name not in ("Figures", "Tables") for c in p.iterdir()))


def list_files(source):
    """Relative POSIX paths of the source's files: git-tracked plus untracked-not-ignored
    in a checkout (ignored files are outputs and environments), everything else otherwise."""
    tracked = git(source, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    if tracked is not None:
        names = [n for n in tracked.decode("utf-8").split("\0") if n]
    else:
        names = [p.relative_to(source).as_posix() for p in source.rglob("*") if p.is_file()]
    return sorted(n for n in names
                  if not set(PurePosixPath(n).parts[:-1]) & SKIP_DIRS and (source / n).is_file())


def every_file(source):
    """Every file under the source but .git, ignored ones included: a run of a copied
    notebook that writes a cache or an output back into the source shows up here, where
    the hashed inventory (tracked files only) cannot see it."""
    return sorted(p.relative_to(source).as_posix() for p in source.rglob("*")
                  if p.is_file() and ".git" not in p.relative_to(source).parts)


def glob_regex(glob):
    """A --include glob as a regex over POSIX paths relative to the source. `*` and `?`
    stop at `/`; `**` crosses it, and `**/` also matches no directory at all, so
    `**/*.ipynb` finds a top-level notebook too. Backslashes are read as `/`: on Windows
    a user types `results\\**`. fnmatch is not used because its `*` crosses `/`, which
    would make `*.ipynb` pull in every notebook in the tree rather than the top level."""
    parts, i, glob = [], 0, glob.replace("\\", "/").strip("/")
    while i < len(glob):
        if glob.startswith("**/", i):
            parts.append("(?:.*/)?")
            i += 3
        elif glob.startswith("**", i):
            parts.append(".*")
            i += 2
        elif glob[i] == "*":
            parts.append("[^/]*")
            i += 1
        elif glob[i] == "?":
            parts.append("[^/]")
            i += 1
        else:
            parts.append(re.escape(glob[i]))
            i += 1
    return re.compile("".join(parts))


def included(rel, pattern):
    """True when the glob matches the file or one of its directories: `results`,
    `results/` and `results/**` all take the whole folder, so a user naming a folder
    gets the folder rather than nothing."""
    path = PurePosixPath(rel)
    candidates = [rel] + [p.as_posix() for p in path.parents if p.parts]
    return any(pattern.fullmatch(c) for c in candidates)


def default_dest(rel, size):
    """Notebooks to notebooks/unsorted/, everything else to imported/, large files and
    .env files skipped. The skill replaces these with the agreed placement before `copy`."""
    path = PurePosixPath(rel)
    if path.name.startswith(".env"):
        return None, "secret"
    if path.suffix == ".ipynb":
        inner = PurePosixPath(*path.parts[1:]) if path.parts[0] == "notebooks" and len(path.parts) > 1 else path
        return f"notebooks/unsorted/{inner}", "notebook"
    kind = "code" if path.suffix == ".py" else "other"
    return (None if size > LARGE else f"imported/{rel}"), kind


def bundled_doc_analysis(rel):
    """True for a file inside the source's own doc_analysis package."""
    path = PurePosixPath(rel)
    return any(path.is_relative_to(pkg) for pkg in BUNDLED_PACKAGES)


def template_modules(target):
    """Module and subpackage names in the analysis repo's doc_analysis, or None when it
    is not there to read. Read from disk rather than imported: this script runs outside
    the workspace venv (`uv run --no-project`), and the analysis repo's src/ is what the
    venv installs editable anyway."""
    package = target / "src" / "doc_analysis"
    if not package.is_dir():
        return None
    return {p.stem for p in package.glob("*.py") if p.stem != "__init__"} \
        | {p.name for p in package.iterdir() if p.is_dir() and (p / "__init__.py").exists()}


def code_text(path):
    """A .py file's text, or a notebook's code cells joined; '' if it cannot be read."""
    text = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix != ".ipynb":
        return text
    try:
        cells = json.loads(text).get("cells", [])
    except (json.JSONDecodeError, AttributeError):
        return ""
    return "\n".join("".join(c["source"]) if isinstance(c.get("source"), list) else c.get("source", "")
                     for c in cells if c.get("cell_type") == "code")


def fork_only_imports(source, files, modules):
    """(file, module) for each import of a doc_analysis module the template does not
    have -- e.g. a fork's `doc_analysis.values` -- in the files planned for copying. The
    copy would fail on that import at run time, with nothing pointing back at the fork."""
    found = []
    for entry in files:
        if not entry["dest"] or PurePosixPath(entry["src"]).suffix not in (".py", ".ipynb"):
            continue
        names = sorted(set(FORK_IMPORT.findall(code_text(source / entry["src"]))) - modules)
        found += [(entry["src"], name) for name in names]
    return found


def source_python(source):
    """The source's own interpreter bounds: its pyproject.toml `requires-python` and its
    .python-version, each None when absent or unreadable."""
    requires = None
    pyproject = source / "pyproject.toml"
    if pyproject.is_file():
        try:
            requires = tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"]["requires-python"]
        except (tomllib.TOMLDecodeError, KeyError, TypeError, UnicodeDecodeError):
            pass
    if not isinstance(requires, str):
        requires = None
    return {"requires_python": requires, "python_version": read_pin(source / ".python-version")}


def read_pin(path):
    """The version a .python-version names (its first word), or None."""
    if not path.is_file():
        return None
    words = path.read_text(encoding="utf-8", errors="replace").split()
    return words[0] if words else None


def _span(parts):
    """A version prefix as the closed range of three-part versions it covers."""
    parts = tuple(parts)[:3]
    return parts + (0,) * (3 - len(parts)), parts + (PATCH_MAX,) * (3 - len(parts))


def pin_fits(pin, requires):
    """True when some release of `pin` (3.12 means any 3.12.x) satisfies `requires`, False
    when none can, None when either is not something this reads. Each clause is checked
    on its own, so a range no version satisfies (`>=3.12.4, <3.12.2`) still fits; and uv
    takes the newest patch it finds, which a patch-level upper bound may exclude."""
    if not PIN.fullmatch(pin.strip()):
        return None
    lo, hi = _span(int(p) for p in pin.strip().split("."))
    for clause in requires.split(","):
        match = SPEC_CLAUSE.fullmatch(clause)
        if not match:
            return None
        op, number, wildcard = match.groups()
        parts = tuple(int(p) for p in number.split("."))
        if (wildcard and op not in ("==", "!=")) or (op == "~=" and len(parts) < 2):
            return None
        # `==3.12.*` covers every 3.12.x; `==3.12` only 3.12.0.
        at_lo, at_hi = _span(parts) if wildcard else (_span(parts)[0],) * 2
        if op == "~=":
            # ~=3.10 is >=3.10, ==3.*
            prefix_lo, prefix_hi = _span(parts[:-1])
            ok = hi >= at_lo and prefix_lo <= hi and lo <= prefix_hi
        elif op == "==":
            ok = at_lo <= hi and lo <= at_hi
        elif op == "!=":
            # Fails only when the exclusion covers every release of the pin.
            ok = not (at_lo <= lo and hi <= at_hi)
        else:
            ok = {">=": hi >= at_lo, ">": hi > at_lo, "<=": lo <= at_lo, "<": lo < at_lo}[op]
        if not ok:
            return False
    return True


def python_report(found, pin):
    """What `plan` says about the source's interpreter bounds against the analysis repo's pin.
    An imported stack brings its own upper bound, and a venv already built on a newer
    interpreter cannot install it (#9)."""
    requires, version = found["requires_python"], found["python_version"]
    if not (requires or version):
        return []
    lines = ["Source Python: " + ", ".join(
        part for part in (requires and f"requires-python {requires}",
                          version and f".python-version {version}") if part)]
    fix = f"re-pin with `uv python pin <version>` in the analysis repo, then `{RESYNC}`, before `copy`"
    if not requires:
        # Only a .python-version: the source was run on that minor, so check against it.
        requires = "==" + ".".join(version.split(".")[:2]) + ".*"
    if pin is None:
        return lines + [f"  WARNING: the analysis repo has no .python-version; {fix}"]
    fits = pin_fits(pin, requires)
    if fits is None:
        return lines + [f"  could not check the analysis repo's pin {pin} against it; compare by hand"]
    if not fits:
        return lines + [f"  WARNING: the analysis repo's pin {pin} is outside it; {fix}"]
    return lines + [f"  the analysis repo's pin {pin} fits"]


def load_plan():
    if not PLAN.exists():
        sys.exit(f"No plan at {PLAN.relative_to(ROOT)}: run `plan --source ...` first.")
    return json.loads(PLAN.read_text(encoding="utf-8"))


def changed_sources(plan):
    """Every inventoried source file that is missing or no longer matches its hash."""
    source = Path(plan["source"])
    problems = []
    now = set(every_file(source))
    before = set(plan["all_files"])
    problems += [f"new      {rel}" for rel in sorted(now - before)]
    problems += [f"gone     {rel}" for rel in sorted(before - now)]
    for entry in plan["files"]:
        path = source / entry["src"]
        if not path.is_file():
            problems.append(f"missing  {entry['src']}")
        elif sha256(path) != entry["sha256"]:
            problems.append(f"changed  {entry['src']}")
    return problems


# ---------------------------------------------------------------------------
# steps
# ---------------------------------------------------------------------------

def cmd_plan(args):
    if PLAN.exists():
        sys.exit(f"{PLAN.relative_to(ROOT)} exists and may hold agreed placements. Edit it, "
                 f"or delete it to plan from scratch.")
    local = Path(args.source).expanduser()
    if local.is_dir():
        source = local.resolve()
    else:
        if CLONE_DIR.exists():
            sys.exit(".setup/analysis-source/ already holds a clone, maybe of another repo. "
                     "Delete it (it is only a clone) or pass its path as --source.")
        else:
            say(f"$ gh repo clone {args.source} .setup/analysis-source")
            if subprocess.run(["gh", "repo", "clone", args.source, str(CLONE_DIR)]).returncode:
                sys.exit(f"Could not clone {args.source}; give a local path instead.")
        source = CLONE_DIR.resolve()
    target = analysis_root(args.analysis_dir, args.document)
    if source == target or source.is_relative_to(target) or target.is_relative_to(source):
        sys.exit(f"Source {source} and the analysis repo {target} overlap; they must be separate.")

    # Every file is inventoried and hashed whether or not it is included: the excluded
    # ones stay in the plan as `dest: null`, so `verify` still proves the whole source
    # untouched, and the user can still give one a dest by hand.
    include = args.include or []
    patterns = [glob_regex(g) for g in include]
    files, matched = [], set()
    for rel in list_files(source):
        size = (source / rel).stat().st_size
        dest, kind = default_dest(rel, size)
        entry = {"src": rel, "dest": dest, "kind": kind, "bytes": size,
                 "sha256": sha256(source / rel)}
        if include:
            hits = {g for g, rx in zip(include, patterns) if included(rel, rx)}
            matched |= hits
            if not hits:
                entry["dest"], entry["why"] = None, "not included"
        # After --include, so an included fork package is still skipped: copying it would
        # collide with the template's doc_analysis whatever the user asked for.
        if bundled_doc_analysis(rel):
            entry["dest"], entry["why"] = None, BUNDLED_WHY
        files.append(entry)
    modules = template_modules(target)
    fork_imports = fork_only_imports(source, files, modules) if modules is not None else []
    found = source_python(source)
    head = git(source, "rev-parse", "HEAD")
    status = git(source, "status", "--porcelain")
    plan = {
        "source": str(source),
        "analysis_dir": str(target),
        "source_git_head": head.decode().strip() if head else None,
        "source_git_status": status.decode() if status is not None else None,
        "sections": writing_sections(args.document),
        "include": include,
        "source_python": found,
        "all_files": every_file(source),
        "files": files,
    }
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    PLAN.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8", newline="\n")

    say(f"Inventoried {len(files)} file(s) in {source}")
    for kind in ("notebook", "code", "other", "secret"):
        say(f"  {sum(f['kind'] == kind for f in files):4d} {kind}")
    bundled = sum(f.get("why") == BUNDLED_WHY for f in files)
    if include:
        excluded = sum(f.get("why") == "not included" for f in files)
        say(f"  {len(files) - excluded - bundled:4d} included by --include {' '.join(include)}")
        say(f"  {excluded:4d} excluded (dest null, \"not included\"; still hashed for verify)")
        # A glob that matched nothing is almost always a typo or a path relative to the
        # wrong directory; without this the import would quietly lack that folder.
        for glob in include:
            if glob not in matched:
                say(f"  WARNING: --include {glob} matched no file (globs are relative to the source)")
    if bundled:
        say(f"  {bundled:4d} in the source's own doc_analysis (dest null: {BUNDLED_WHY}; "
            f"still hashed for verify)")
    skipped = [f for f in files if f["dest"] is None and f.get("why") not in ("not included", BUNDLED_WHY)]
    for entry in skipped:
        why = ("a secret; copy it by hand if the copy needs it" if entry["kind"] == "secret"
               else f"{entry['bytes']:,} bytes: data or output? give it a dest to copy it")
        say(f"  skip {entry['src']}  ({why})")
    if modules is None:
        say(f"  WARNING: no {target / 'src' / 'doc_analysis'} to compare against; "
            f"fork-only doc_analysis imports were not checked")
    for src, name in fork_imports:
        say(f"  WARNING: {src} imports doc_analysis.{name}: fork-only module; "
            f"port it or keep it in your private extra")
    for line in python_report(found, read_pin(target / ".python-version")):
        say(line)
    if plan["sections"]:
        say("Document sections (suggested notebook folders):")
        for section in plan["sections"]:
            say(f"  notebooks/{section}/")
    say(f"Wrote {PLAN.relative_to(ROOT)}. Set each file's `dest` (relative to the analysis "
        f"repo, or null to skip), then run `copy`.")
    return 0


def cmd_copy(args):
    plan = load_plan()
    source, target = Path(plan["source"]), Path(plan["analysis_dir"])
    problems = changed_sources(plan)
    if problems:
        say("The source no longer matches the inventory; nothing copied:")
        for line in problems:
            say(f"  {line}")
        return 1

    conflicts, copied, present = [], 0, 0
    for entry in plan["files"]:
        if not entry["dest"]:
            continue
        dest = (target / entry["dest"]).resolve()
        if not dest.is_relative_to(target) or dest.is_relative_to(source):
            sys.exit(f"dest {entry['dest']!r} resolves outside the analysis repo; fix the plan.")
        if dest.exists():
            if sha256(dest) == entry["sha256"]:
                present += 1
            else:
                conflicts.append(entry)
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / entry["src"], dest)
        copied += 1
        say(f"  copy  {entry['src']}  ->  {entry['dest']}")

    say(f"Copied {copied}, already present {present}, conflicts {len(conflicts)}.")
    for entry in conflicts:
        say(f"  conflict  {entry['dest']} exists with different content (left as is; "
            f"from {entry['src']})")
    return 1 if conflicts else 0


def cmd_verify(args):
    plan = load_plan()
    problems = changed_sources(plan)
    status = git(Path(plan["source"]), "status", "--porcelain")
    if plan["source_git_status"] is not None and status is not None \
            and status.decode() != plan["source_git_status"]:
        problems.append("git status of the source differs from when it was inventoried")
    target = Path(plan["analysis_dir"])
    missing = [e["dest"] for e in plan["files"] if e["dest"] and not (target / e["dest"]).exists()]
    for line in problems:
        say(f"  SOURCE {line}")
    for dest in missing:
        say(f"  not copied yet  {dest}")
    if problems:
        say(f"FAIL: the source at {plan['source']} changed. Restore it from git or a backup "
            f"before going on.")
        return 1
    say(f"OK: all {len(plan['files'])} source file(s) unchanged"
        + (f"; {len(missing)} planned file(s) not copied yet." if missing else "."))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", help="the workspace root (default: the nearest directory holding "
                    "workspace.toml, else the current one)")
    sub = ap.add_subparsers(dest="step", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--source", required=True, help="local path, or OWNER/NAME to clone")
    p.add_argument("--document", help="the document whose analysis repo to copy into "
                   "(default: the one the current directory is inside, else the only one)")
    p.add_argument("--analysis-dir", help="override: the analysis repo, relative to the root")
    p.add_argument("--include", action="append", metavar="GLOB",
                   help="repeatable; plan only files matching a glob (relative to the source, "
                        "e.g. 'results/**' or 'notebooks/2024*.ipynb') or inside a folder it "
                        "matches. Every other file is inventoried with dest null.")
    sub.add_parser("copy")
    sub.add_parser("verify")
    args = ap.parse_args(argv)
    if args.root:
        set_root(args.root)
    return {"plan": cmd_plan, "copy": cmd_copy, "verify": cmd_verify}[args.step](args)


if __name__ == "__main__":
    sys.exit(main())
