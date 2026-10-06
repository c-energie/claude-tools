#!/usr/bin/env python3
"""Evidence for the setup-observer skill: a machine baseline, the failed-command record, redaction.

    baseline   record this machine (OS, tool versions, relevant env vars, repo state)
               into .setup/observer/baseline.json and open the deviation log
    events     list the failed commands the skill's hook recorded, and which of them the
               deviation log does not mention yet (exit 1 while any are unaccounted)
    owners     print the repos reports may be filed on, from observer.toml
    redact     strip personal details (home path, user and host names, git email, tokens)
               from draft files, in place, before anything is filed on GitHub

The hook itself is a one-line shell append (see SKILL.md frontmatter), so failures are
recorded even before uv or Python exist on the machine; this script only reads them.

    uv run --no-project --python 3.12 .claude/skills/setup-observer/observe.py baseline

This file and SKILL.md are verbatim copies of the master in the skills@c-energie plugin
(assets/setup-observer/); edit observer.toml beside them, which holds everything specific to
this repo. Stdlib only.
"""
import argparse
import datetime
import getpass
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

# .claude/skills/setup-observer/observe.py -> the repo root
ROOT = Path(__file__).resolve().parents[3]
OBS = ROOT / ".setup" / "observer"
LOG = OBS / "log.md"
EVENTS = OBS / "events.jsonl"
BASELINE = OBS / "baseline.json"
CONFIG = Path(__file__).with_name("observer.toml")

TOOLS = {
    "git": ["git", "--version"], "gh": ["gh", "--version"], "uv": ["uv", "--version"],
    "python": ["python", "--version"], "python3": ["python3", "--version"],
    "node": ["node", "--version"], "claude": ["claude", "--version"],
}
ENV_VARS = ("VIRTUAL_ENV", "CONDA_PREFIX", "PYTHONPATH", "UV_PYTHON", "UV_PROJECT_ENVIRONMENT")

TOKEN = re.compile(r"\b(ghp_|gho_|ghu_|ghs_|github_pat_|sk-ant-|sk-|ntn_|secret_|xox[abpr]-)"
                   r"[A-Za-z0-9_\-]{8,}")


def config():
    """observer.toml: tools, env_vars, secret_vars, state_files, [[owners]]. Missing keys
    fall back to empty, so a bare file still gives a useful baseline."""
    if not CONFIG.exists():
        print(f"note: {CONFIG.name} not found beside observe.py; using defaults only")
        return {}
    return tomllib.loads(CONFIG.read_text(encoding="utf-8"))


def probe(cmd):
    if shutil.which(cmd[0]) is None:
        return None
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"error: {exc}"
    text = (out.stdout or out.stderr).strip()
    return text.splitlines()[0] if text else f"exit {out.returncode}"


def cmd_baseline(args):
    cfg = config()
    tools = {**TOOLS, **{name: [name, "--version"] for name in cfg.get("tools", [])}}
    secret = set(cfg.get("secret_vars", []))
    env_vars = (*ENV_VARS, *cfg.get("env_vars", []), *secret)
    OBS.mkdir(parents=True, exist_ok=True)
    gh_auth = subprocess.run(["gh", "auth", "status"], capture_output=True, text=True) \
        if shutil.which("gh") else None
    state = {name: (ROOT / name).exists() for name in cfg.get("state_files", [])}
    baseline = {
        "taken": datetime.datetime.now().isoformat(timespec="seconds"),
        "invoked_by": args.skill,
        "os": platform.platform(), "machine": platform.machine(),
        "python_running_this": sys.version.split()[0],
        "tools": {name: probe(cmd) for name, cmd in tools.items()},
        "gh_auth_ok": gh_auth.returncode == 0 if gh_auth else None,
        "env": {k: ("<set>" if k in secret else os.environ[k])
                for k in dict.fromkeys(env_vars) if k in os.environ},
        "state_files": state,
        "members": sorted(p.name for p in ROOT.iterdir()
                          if p.is_dir() and (p / ".git").exists()),
    }
    BASELINE.write_text(json.dumps(baseline, indent=2) + "\n", encoding="utf-8")
    stamp = f"\n## Session {baseline['taken']} — {args.skill}\n\n"
    if not LOG.exists():
        LOG.write_text("# Setup deviations\n\nWritten by setup-observer. One `### D<n>` entry "
                       "per deviation; failed-command events are referenced as `E<n>`.\n"
                       + stamp, encoding="utf-8")
    else:
        with LOG.open("a", encoding="utf-8") as handle:
            handle.write(stamp)
    print(f"Baseline written to {BASELINE.relative_to(ROOT)}")
    for name, version in baseline["tools"].items():
        print(f"  {name:8s} {version or 'not found'}")
    print(f"  gh auth  {baseline['gh_auth_ok']}")
    for key, value in baseline["env"].items():
        print(f"  ${key} = {value}   <- already set before setup")
    print(f"  present: {', '.join(k for k, v in state.items() if v) or 'none of the state files'}; "
          f"nested repos: {', '.join(baseline['members']) or 'none'}")
    return 0


def read_events():
    """The hook appends raw hook payloads; parse them leniently, one or more per line."""
    if not EVENTS.exists():
        return []
    decoder, events = json.JSONDecoder(), []
    text = EVENTS.read_text(encoding="utf-8", errors="replace")
    pos = 0
    while pos < len(text):
        while pos < len(text) and text[pos].isspace():
            pos += 1
        if pos >= len(text):
            break
        try:
            obj, pos = decoder.raw_decode(text, pos)
            events.append(obj)
        except json.JSONDecodeError:
            nxt = text.find("\n", pos)
            pos = len(text) if nxt == -1 else nxt + 1
    return events


def summary(event):
    tool_input = event.get("tool_input") or {}
    command = tool_input.get("command") or json.dumps(tool_input)[:200]
    response = event.get("tool_response")
    detail = event.get("error") or (response.get("stderr") if isinstance(response, dict) else response) or ""
    detail = str(detail).strip().splitlines()
    return command.strip().splitlines()[0][:160], (detail[-1][:200] if detail else "")


def cmd_events(args):
    events = read_events()
    log = LOG.read_text(encoding="utf-8") if LOG.exists() else ""
    unaccounted = 0
    for n, event in enumerate(events, 1):
        ref = f"E{n}"
        seen = re.search(rf"\b{ref}\b", log) is not None
        unaccounted += not seen
        command, detail = summary(event)
        print(f"{'  ' if seen else '! '}{ref} [{event.get('tool_name', '?')}] {command}")
        if detail:
            print(f"      {detail}")
    print(f"{len(events)} failed command(s); {unaccounted} not yet in {LOG.relative_to(ROOT)}.")
    return 1 if unaccounted else 0


def cmd_owners(args):
    owners = config().get("owners", [])
    if not owners:
        print(f"No [[owners]] in {CONFIG.name}: every deviation is 'upstream' or 'this machine "
              "only' until one is added.")
        return 1
    for row in owners:
        print(f"  {row.get('repo', '?'):40s} {row.get('covers', '')}")
    print("  upstream                                 a third-party tool's own bug; owned by a "
          "repo above only if the guide should work around it")
    print("  this machine only                        unique to this machine; no guide change would help")
    return 0


def personal_values():
    values = {}
    home = Path.home()
    forms = {str(home), home.as_posix()}
    if home.drive:  # Git Bash spells C:\Users\x as /c/Users/x
        forms.add("/" + home.drive[0].lower() + home.as_posix()[len(home.drive):])
    for form in forms:
        values[form] = "~"
    user = getpass.getuser()
    host = platform.node()
    email = subprocess.run(["git", "config", "user.email"], capture_output=True,
                           text=True).stdout.strip() if shutil.which("git") else ""
    for value, mask in ((user, "<user>"), (host, "<host>"), (email, "<email>")):
        if value and len(value) > 2:
            values[value] = mask
    return values


def cmd_redact(args):
    values = personal_values()
    for name in args.files:
        path = Path(name)
        text = original = path.read_text(encoding="utf-8")
        # Longest first, so a home path is masked before the user name inside it.
        for value in sorted(values, key=len, reverse=True):
            text = re.sub(re.escape(value), values[value], text, flags=re.IGNORECASE)
        text = TOKEN.sub("<token>", text)
        if text != original:
            path.write_text(text, encoding="utf-8")
        print(f"{name}: {'redacted' if text != original else 'nothing to redact'}")
    print("Now read each draft yourself for anything else private: data paths, project or "
          "people's names, organisation details.")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="step", required=True)
    p = sub.add_parser("baseline")
    p.add_argument("--skill", default="unknown", help="the setup skill that invoked the observer")
    sub.add_parser("events")
    sub.add_parser("owners")
    p = sub.add_parser("redact")
    p.add_argument("files", nargs="+")
    args = ap.parse_args(argv)
    return {"baseline": cmd_baseline, "events": cmd_events, "owners": cmd_owners,
            "redact": cmd_redact}[args.step](args)


if __name__ == "__main__":
    sys.exit(main())
