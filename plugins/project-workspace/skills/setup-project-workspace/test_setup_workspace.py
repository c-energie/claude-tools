"""Tests for setup_workspace.py. Stdlib only: no pandoc, no network. The worktree-repair
test drives a real throwaway git repository, so git must be on PATH.

    uv run --no-project --python 3.12 -m unittest discover -s plugins/project-workspace/skills/setup-project-workspace
"""
import contextlib
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import setup_workspace as sw

FIXTURES = Path(__file__).resolve().parent / "fixtures"


class StripCaptionPrefixes(unittest.TestCase):
    def strip(self, caption):
        text, count = sw.strip_caption_prefixes(f"\\caption{{{caption}}}")
        return text.removeprefix("\\caption{").removesuffix("}"), count

    def test_figure_colon(self):
        self.assertEqual(self.strip("Figure 3: X"), ("X", 1))

    def test_fig_dot_dot(self):
        self.assertEqual(self.strip("Fig. 12. X"), ("X", 1))

    def test_table_dash(self):
        self.assertEqual(self.strip("Table 1 - X"), ("X", 1))

    def test_case_insensitive_and_no_dot(self):
        self.assertEqual(self.strip("FIG 4: X"), ("X", 1))

    def test_pandoc_en_dash(self):
        self.assertEqual(self.strip("Figure 2 -- X"), ("X", 1))

    def test_decimal_in_caption_text_unchanged(self):
        self.assertEqual(self.strip("Figure 3.5 m wide"), ("Figure 3.5 m wide", 0))

    def test_no_prefix_unchanged(self):
        self.assertEqual(self.strip("Annual demand"), ("Annual demand", 0))

    def test_mid_text_mention_unchanged(self):
        self.assertEqual(self.strip("As in Figure 3: demand"), ("As in Figure 3: demand", 0))

    def test_text_outside_captions_unchanged(self):
        tex = "Figure 1: is discussed here.\n"
        self.assertEqual(sw.strip_caption_prefixes(tex), (tex, 0))

    def test_short_caption_option(self):
        tex = "\\caption[Short]{Figure 1: Long}"
        self.assertEqual(sw.strip_caption_prefixes(tex), ("\\caption[Short]{Long}", 1))

    def test_counts_every_caption(self):
        tex = ("\\caption{Figure 1: A}\n\\caption{B}\n"
               "\\caption{Table 2. C}\n\\caption{ Fig. 3: D}\n")
        out, count = sw.strip_caption_prefixes(tex)
        self.assertEqual(count, 3)
        self.assertEqual(out, "\\caption{A}\n\\caption{B}\n\\caption{C}\n\\caption{ D}\n")


class ClassifySource(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def touch(self, name):
        path = self.tmp / name
        path.write_text("x", encoding="utf-8")
        return path

    def test_owner_name_is_a_repo(self):
        self.assertEqual(sw.classify_source("someone/old-thesis"), ("repo", "someone/old-thesis"))

    def test_repo_named_like_a_file_is_still_a_repo(self):
        self.assertEqual(sw.classify_source("someone/example.org"), ("repo", "someone/example.org"))

    def test_existing_directory(self):
        self.assertEqual(sw.classify_source(str(self.tmp)), ("directory", self.tmp))

    def test_tex_file_resolves_to_its_parent(self):
        tex = self.touch("main.tex")
        self.assertEqual(sw.classify_source(str(tex)), ("tex-file", self.tmp))

    def test_docx_is_a_document_file(self):
        docx = self.touch("Draft.docx")
        self.assertEqual(sw.classify_source(str(docx)), ("document-file", docx))

    def test_md_is_a_document_file(self):
        md = self.touch("notes.md")
        self.assertEqual(sw.classify_source(str(md)), ("document-file", md))

    def test_unreadable_extension_stops(self):
        doc = self.touch("old.doc")
        with self.assertRaises(SystemExit) as caught:
            sw.classify_source(str(doc))
        message = str(caught.exception)
        self.assertIn("old.doc", message)
        self.assertIn(".docx", message)

    def test_missing_document_path_stops_rather_than_cloning(self):
        with self.assertRaises(SystemExit) as caught:
            sw.classify_source(str(self.tmp / "gone.docx"))
        self.assertIn("gone.docx", str(caught.exception))


class StageDocumentDryRun(unittest.TestCase):
    def test_prints_pinned_command_and_writes_nothing(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        docx = tmp / "Draft.docx"
        docx.write_bytes(b"not really a docx")
        import_dir = tmp / ".setup" / "thesis" / "import-source"
        out = io.StringIO()
        with mock.patch.object(sw, "DRY_RUN", True), \
                mock.patch.object(sw, "ROOT", tmp), \
                mock.patch.object(sw.subprocess, "run") as subprocess_run, \
                contextlib.redirect_stdout(out):
            sw.stage_import_source(str(docx), import_dir)
        printed = out.getvalue()
        self.assertIn("uv run --no-project --with pypandoc_binary==1.17", printed)
        self.assertIn("--extract-media=media", printed)
        self.assertIn("--standalone", printed)
        self.assertIn(sw.PANDOC_DOWNLOAD, printed)
        self.assertIn(".setup/thesis/import-source/Draft.tex", printed)
        subprocess_run.assert_not_called()
        self.assertFalse((tmp / ".setup").exists())


class RunInit(unittest.TestCase):
    """init.py gets its answers as flags, never on stdin: piped answers echoed every
    prompt run together on one line, and tied setup to the order init.py asks in (#8)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def run_init(self, checkout, dry_run, **values):
        out = io.StringIO()
        with mock.patch.object(sw, "DRY_RUN", dry_run), \
                mock.patch.object(sw, "ROOT", self.tmp), \
                mock.patch.object(sw.subprocess, "run") as subprocess_run, \
                contextlib.redirect_stdout(out):
            subprocess_run.return_value = sw.subprocess.CompletedProcess([], 0, "", "")
            sw.run_init(checkout, **values)
        return out.getvalue(), subprocess_run

    def test_passes_flags_and_no_stdin(self):
        checkout = self.tmp / "document"
        checkout.mkdir()
        (checkout / "init.py").write_text("", encoding="utf-8")
        _, subprocess_run = self.run_init(checkout, False, title="-30% T", author="Zoë A")
        cmd = subprocess_run.call_args.args[0]
        # --flag=value: a value starting with a dash is not mistaken for a flag.
        self.assertEqual(cmd[1:], ["init.py", "--title=-30% T", "--author=Zoë A"])
        self.assertIsNone(subprocess_run.call_args.kwargs.get("input"))
        self.assertEqual(subprocess_run.call_args.kwargs["env"]["PYTHONIOENCODING"], "utf-8")

    def test_dry_run_prints_the_flags_for_a_checkout_not_yet_cloned(self):
        printed, subprocess_run = self.run_init(
            self.tmp / "analysis", True, distribution="x-analysis", author="A",
            doc_repo="/w/document", backend="plotly")
        self.assertIn("init.py --distribution=x-analysis --author=A "
                      "--doc-repo=/w/document --backend=plotly", printed)
        subprocess_run.assert_not_called()

    def test_already_initialised_is_skipped(self):
        checkout = self.tmp / "document"
        checkout.mkdir()
        printed, subprocess_run = self.run_init(checkout, False, title="T", author="A")
        self.assertIn("already initialised", printed)
        subprocess_run.assert_not_called()




class Workspace(unittest.TestCase):
    """A temporary project workspace, with GitHub and setup-nested.sh mocked out."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        saved = sw.ROOT
        self.addCleanup(sw.set_root, saved)
        sw.set_root(self.tmp)
        patcher = mock.patch.object(sw, "DRY_RUN", False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def call(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = sw.main(["--root", str(self.tmp), *argv])
        self.out = out.getvalue()
        return code

    def read(self, name):
        return (self.tmp / name).read_text(encoding="utf-8")

    def state(self):
        return json.loads((self.tmp / ".claude" / "workspace.json").read_text(encoding="utf-8-sig"))

    def docs(self):
        return [m for m in self.state()["members"] if m["kind"] == "document"]

    def write_json(self, body):
        (self.tmp / ".claude").mkdir(exist_ok=True)
        (self.tmp / ".claude" / "workspace.json").write_text(
            body if isinstance(body, str) else json.dumps(body, indent=2), encoding="utf-8",
            newline="")

    def fake_clone(self, repo, directory):
        checkout = self.tmp / directory
        (checkout / ".git").mkdir(parents=True, exist_ok=True)
        return checkout

    def add_document(self, *flags, repo="o/thesis", mode="fresh"):
        with mock.patch.object(sw, "create_from_template") as created, \
                mock.patch.object(sw, "clone", side_effect=self.fake_clone), \
                mock.patch.object(sw, "run_init"), \
                mock.patch.object(sw, "repo_exists", return_value=True), \
                mock.patch.object(sw, "wait_for_content"), \
                mock.patch.object(sw, "gh_raw", return_value="template text\n"):
            self.created = created
            extra = [] if mode == "adapt" else ["--title", "T", "--author", "A"]
            return self.call("add-document", "--mode", mode, "--repo", repo, *extra, *flags)


class Init(Workspace):
    def test_writes_workspace_json_and_claude_md(self):
        self.call("init", "--name", "w")
        self.assertEqual(self.read(".claude/workspace.json"),
                         '{\n  "schema": 1,\n  "name": "w",\n  "members": []\n}\n')
        self.assertFalse((self.tmp / "workspace.toml").exists())
        claude = self.read("CLAUDE.md")
        self.assertIn("The `w` project workspace", claude)
        self.assertIn("_none yet", claude)

    def test_name_defaults_to_the_folder(self):
        self.call("init")
        self.assertEqual(self.state()["name"], self.tmp.name)

    def test_untracked_workspace_gets_no_gitignore(self):
        self.call("init")
        self.assertFalse((self.tmp / ".gitignore").exists())

    def test_re_run_keeps_documents_and_an_own_claude_md(self):
        self.call("init")
        self.add_document()
        (self.tmp / "CLAUDE.md").write_text("mine\n", encoding="utf-8")
        self.call("init")
        self.assertEqual(len(self.docs()), 1)
        self.assertEqual(self.read("CLAUDE.md"), "mine\n")

    def test_schema_1_is_sent_to_migrate(self):
        (self.tmp / "workspace.toml").write_text('[workspace]\nname = "w"\n', encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            self.call("init")
        self.assertIn("migrate", str(caught.exception))

    def test_a_workspace_json_made_by_another_owner_gains_ours_and_keeps_its_own(self):
        # setup-connectors may write `connections` first; its formatting is not ours to touch.
        theirs = '{\n  "connections": { "github": ["o"] }\n}\n'
        self.write_json(theirs)
        self.call("init", "--name", "w")
        text = self.read(".claude/workspace.json")
        self.assertIn('  "connections": { "github": ["o"] },\n', text)
        self.assertEqual(self.state(), {"connections": {"github": ["o"]}, "schema": 1,
                                        "name": "w", "members": []})

    def test_tracked_init_says_when_it_skips_a_duplicate_ignore_line(self):
        # #37: init edits .gitignore in a tracked root, and must not repeat the user's lines.
        (self.tmp / ".git").mkdir()
        (self.tmp / ".gitignore").write_text("thesis/\n", encoding="utf-8")
        self.call("init")
        self.add_document()
        text = self.read(".gitignore")
        self.assertNotIn("/thesis/", text)
        self.assertIn("already ignores thesis/", self.out)
        self.assertEqual(text.count("thesis/"), 1)


class Track(Workspace):
    def test_git_init_and_a_documents_block(self):
        self.call("init")
        self.add_document()
        with mock.patch.object(sw, "run", side_effect=lambda cmd, cwd=None, **kw:
                               (self.tmp / ".git").mkdir()):
            self.call("track")
        text = self.read(".gitignore")
        self.assertIn(f"{sw.BLOCK_START}\n", text)
        self.assertIn("/thesis/\n", text)
        self.assertIn("/.setup/", text)

    def test_tracked_block_follows_new_documents_and_keeps_the_rest(self):
        (self.tmp / ".git").mkdir()
        self.call("init")
        (self.tmp / ".gitignore").write_text(self.read(".gitignore") + "mine/\n", encoding="utf-8")
        self.add_document()
        self.add_document(repo="o/paper")
        text = self.read(".gitignore")
        self.assertEqual(text.count(sw.BLOCK_START), 1)
        self.assertIn("/thesis/\n/paper/\n", text)
        self.assertIn("mine/", text)


class AddDocument(Workspace):
    def setUp(self):
        super().setUp()
        self.call("init", "--name", "w")

    def test_lists_the_document_dir_defaulting_to_the_repo_name(self):
        self.add_document()
        self.assertEqual(self.state()["members"],
                         [{"dir": "thesis", "repo": "o/thesis", "kind": "document",
                           "name": "thesis"}])
        self.created.assert_called_once_with(sw.WRITING_TEMPLATE, "o/thesis", "private")

    def test_several_documents_and_the_claude_md_table(self):
        self.add_document()
        self.add_document("--dir", "p", "--name", "paper", repo="o/paper")
        self.assertEqual([d["name"] for d in self.docs()], ["thesis", "paper"])
        claude = self.read("CLAUDE.md")
        self.assertIn("| thesis | `thesis/` | `o/thesis` | — |", claude)
        self.assertIn("| paper | `p/` | `o/paper` | — |", claude)
        self.assertNotIn("_none yet", claude)

    def test_re_run_changes_nothing(self):
        self.add_document()
        before = self.read(".claude/workspace.json"), self.read("CLAUDE.md")
        self.add_document()
        self.assertEqual(before, (self.read(".claude/workspace.json"), self.read("CLAUDE.md")))

    def test_same_dir_from_another_repo_stops(self):
        self.add_document()
        with self.assertRaises(SystemExit):
            self.add_document("--dir", "thesis", repo="o/other")

    def test_adapt_overlays_setup_nested_sh(self):
        self.add_document(mode="adapt")
        self.assertEqual(self.read("thesis/setup-nested.sh"), "template text\n")
        self.created.assert_not_called()

    def test_import_stages_per_document(self):
        source = self.tmp / "old"
        source.mkdir()
        (source / "main.tex").write_text("x", encoding="utf-8")
        self.add_document("--source", str(source), mode="import")
        self.assertTrue((self.tmp / ".setup" / "thesis" / "import-source" / "main.tex").exists())

    def test_needs_init_first(self):
        (self.tmp / ".claude" / "workspace.json").unlink()
        with self.assertRaises(SystemExit):
            self.add_document()

    def test_a_dir_held_by_another_kind_of_member_stops(self):
        state = self.state()
        state["members"].append({"dir": "thesis", "repo": "o/tool", "kind": "code"})
        self.write_json(state)
        with self.assertRaises(SystemExit) as caught:
            self.add_document()
        self.assertIn("code member", str(caught.exception))


class FakeGh:
    """Stands in for `quiet`: answers the `gh` reads create_from_template makes about one
    existing repo. `template` is what templateRepository holds; `files` are at its root."""

    def __init__(self, template=None, files=(), view_fails=False):
        self.template, self.files, self.view_fails = template, set(files), view_fails

    def __call__(self, cmd, **kwargs):
        def answer(code, out=""):
            return subprocess.CompletedProcess(cmd, code, out, "")
        if cmd[:3] == ["gh", "repo", "view"] and cmd[-1] == "name":
            return answer(0, '{"name": "thesis"}')
        if cmd[:3] == ["gh", "repo", "view"]:
            if self.view_fails:
                return answer(1)
            return answer(0, json.dumps({"templateRepository": self.template}))
        if cmd[:2] == ["gh", "api"] and "/contents/" in cmd[2]:
            return answer(0 if cmd[2].split("/contents/")[1] in self.files else 1)
        raise AssertionError(f"unexpected command: {cmd}")


class CreateFromTemplate(Workspace):
    """Fresh mode takes an existing repo only if writing-template made it (#40)."""

    def create(self, gh, exists=True):
        out = io.StringIO()
        with mock.patch.object(sw, "repo_exists", return_value=exists), \
                mock.patch.object(sw, "quiet", side_effect=gh), \
                mock.patch.object(sw, "run") as run, \
                mock.patch.object(sw, "wait_for_content"), \
                contextlib.redirect_stdout(out):
            sw.create_from_template(sw.WRITING_TEMPLATE, "o/thesis", "private")
        return out.getvalue(), run

    def test_missing_repo_is_created_from_the_template(self):
        _, run = self.create(FakeGh(), exists=False)
        run.assert_called_once_with(["gh", "repo", "create", "o/thesis", "--template",
                                     sw.WRITING_TEMPLATE, "--private"])

    def test_repo_made_from_the_template_is_used_as_is(self):
        printed, run = self.create(FakeGh(template={"nameWithOwner": sw.WRITING_TEMPLATE}))
        self.assertIn("using it as-is", printed)
        run.assert_not_called()

    def test_template_given_as_name_and_owner_counts(self):
        owner, name = sw.WRITING_TEMPLATE.split("/")
        printed, run = self.create(FakeGh(template={"name": name, "owner": {"login": owner}}))
        self.assertIn("using it as-is", printed)

    def test_no_template_but_the_marker_files_is_used_as_is(self):
        printed, run = self.create(FakeGh(files={"main.tex", "document_settings.sty"}))
        self.assertIn("using it as-is", printed)
        run.assert_not_called()

    def test_failed_template_lookup_falls_back_to_the_markers(self):
        printed, _ = self.create(FakeGh(view_fails=True,
                                        files={"main.tex", "document_settings.sty"}))
        self.assertIn("using it as-is", printed)

    def test_unrelated_repo_stops(self):
        with self.assertRaises(SystemExit) as caught:
            self.create(FakeGh(files={"pyproject.toml"}))
        message = str(caught.exception)
        self.assertIn("o/thesis already exists and was not made from", message)
        self.assertIn("--mode adapt", message)

    def test_one_marker_alone_is_not_enough(self):
        with self.assertRaises(SystemExit):
            self.create(FakeGh(files={"main.tex"}))

    def test_made_from_another_template_stops_whatever_its_files(self):
        with self.assertRaises(SystemExit):
            self.create(FakeGh(template={"nameWithOwner": "c-energie/analysis-template"},
                               files={"main.tex", "document_settings.sty"}))

    def test_dry_run_stops_too(self):
        # Reads are honest under --dry-run, so the plan shown for confirmation fails
        # where the real run would, not after the user has said yes.
        with mock.patch.object(sw, "DRY_RUN", True), self.assertRaises(SystemExit):
            self.create(FakeGh())

    def test_add_document_on_an_unrelated_repo_clones_and_writes_nothing(self):
        self.call("init", "--name", "w")
        before = self.read(".claude/workspace.json"), self.read("CLAUDE.md")
        with mock.patch.object(sw, "repo_exists", return_value=True), \
                mock.patch.object(sw, "quiet", side_effect=FakeGh()), \
                mock.patch.object(sw, "clone") as clone, \
                mock.patch.object(sw, "run_init") as run_init, \
                self.assertRaises(SystemExit):
            self.call("add-document", "--mode", "fresh", "--repo", "o/thesis",
                      "--title", "T", "--author", "A")
        clone.assert_not_called()
        run_init.assert_not_called()
        self.assertEqual(before, (self.read(".claude/workspace.json"), self.read("CLAUDE.md")))
        self.assertFalse((self.tmp / "thesis").exists())


class FindDocument(Workspace):
    def setUp(self):
        super().setUp()
        self.call("init", "--name", "w")
        self.add_document()
        self.add_document(repo="o/paper")
        self.state_ = sw.read_state()

    def test_by_name(self):
        self.assertEqual(sw.find_document(self.state_, "paper")["dir"], "paper")

    def test_by_current_directory(self):
        inside = self.tmp / "paper" / "Sections"
        inside.mkdir(parents=True)
        self.assertEqual(sw.find_document(self.state_, cwd=inside)["name"], "paper")

    def test_ambiguous_stops_listing_them(self):
        with self.assertRaises(SystemExit) as caught:
            sw.find_document(self.state_, cwd=self.tmp)
        self.assertIn("thesis, paper", str(caught.exception))

    def test_only_one_needs_no_name(self):
        state = {"members": sw.documents(self.state_)[:1]}
        self.assertEqual(sw.find_document(state, cwd=self.tmp)["name"], "thesis")

    def test_analysis_comes_from_layout_toml(self):
        (self.tmp / "thesis" / "layout.toml").write_text(
            'layout = "writing-hosts-analysis"\nnested_dir = "thesis-analysis"\n', encoding="utf-8")
        thesis, paper = sw.documents(self.state_)
        info = sw.describe(thesis)
        self.assertEqual(info["analysis_dir"], "thesis-analysis")
        self.assertEqual(info["analysis_path"], (self.tmp / "thesis" / "thesis-analysis").as_posix())
        self.assertIsNone(sw.describe(paper)["analysis_dir"])

    def test_a_document_without_a_name_is_named_by_its_dir(self):
        self.assertEqual(sw.describe({"dir": "x", "repo": "o/x", "kind": "document"})["name"], "x")


class NestsAnAnalysis(Workspace):
    """A workspace with one document, whose setup-nested.sh is stubbed to write layout.toml."""

    def setUp(self):
        super().setUp()
        self.call("init", "--name", "w")
        self.add_document()
        (self.tmp / "thesis" / "setup-nested.sh").write_text("#!/bin/sh\n", encoding="utf-8")

    def add(self, *flags):
        def nested(cmd, cwd=None, **kw):
            (self.tmp / "thesis" / "layout.toml").write_text(
                'layout = "writing-hosts-analysis"\nnested_dir = "thesis-analysis"\n'
                'nested_remote = "https://github.com/o/thesis-analysis.git"\n',
                encoding="utf-8")
        with mock.patch.object(sw, "run", side_effect=nested) as run, \
                mock.patch.object(sw, "find_sh", return_value="/bin/sh"), \
                mock.patch.object(sw, "gh_raw", return_value="#!/bin/sh\n"):
            self.call("add-analysis", *flags)
        return run


class AddAnalysis(NestsAnAnalysis):
    """add-analysis hands the work to the document's own setup-nested.sh."""

    def test_runs_setup_nested_in_the_document_with_init_answers_after_dashes(self):
        run = self.add("--python", "3.12", "--distribution", "t-analysis", "--author", "A")
        cmd = run.call_args.args[0]
        self.assertEqual(cmd[:2], ["/bin/sh", "setup-nested.sh"])
        self.assertEqual(run.call_args.kwargs["cwd"], self.tmp / "thesis")
        self.assertIn("--python", cmd)
        self.assertEqual(cmd[cmd.index("--") + 1:], ["--distribution=t-analysis", "--author=A"])

    def test_no_python_flag_unless_given(self):
        cmd = self.add().call_args.args[0]
        self.assertNotIn("--python", cmd)
        self.assertNotIn("--", cmd)

    def test_records_extras_and_the_table_shows_the_analysis(self):
        self.add("--backend", "matplotlib")
        self.assertEqual(self.docs()[0]["extras"], ["dev", "notebooks", "matplotlib"])
        self.assertIn("`thesis/thesis-analysis/`", self.read("CLAUDE.md"))

    def test_records_the_nested_analysis_as_a_member_feeding_its_document(self):
        self.add()
        self.assertEqual(self.state()["members"][1], {
            "dir": "thesis/thesis-analysis", "repo": "o/thesis-analysis", "kind": "analysis",
            "documents": ["thesis"]})
        # A re-run records it once, and the tracked .gitignore lists only the document.
        self.add()
        self.assertEqual(len(self.state()["members"]), 2)

    def test_a_bare_analysis_dir_is_not_given_the_documents_origin(self):
        (self.tmp / "thesis" / "thesis-analysis").mkdir()
        with mock.patch.object(sw, "origin_url", return_value="https://github.com/o/thesis.git"):
            self.add()
        self.assertEqual(self.state()["members"][1]["repo"], "o/thesis-analysis")

    def test_an_existing_analysis_member_keeps_its_other_fields(self):
        state = self.state()
        state["members"].append({"dir": "thesis/thesis-analysis", "kind": "analysis",
                                 "documents": ["paper"], "mine": 1})
        self.write_json(state)
        self.add()
        member = self.state()["members"][1]
        self.assertEqual(member["documents"], ["paper", "thesis"])
        self.assertEqual(member["mine"], 1)
        self.assertEqual(member["repo"], "o/thesis-analysis")

    def test_a_document_without_the_script_gets_it(self):
        (self.tmp / "thesis" / "setup-nested.sh").unlink()
        self.add()
        self.assertTrue((self.tmp / "thesis" / "setup-nested.sh").exists())
        self.assertTrue((self.tmp / "thesis" / ".gitattributes").exists())

    def test_an_outdated_script_is_replaced(self):
        # setUp's copy has no in-place support; gh_raw stands in for the template's.
        self.add()
        self.assertIn("updated an outdated setup-nested.sh", self.out)

    def test_a_current_script_is_kept(self):
        (self.tmp / "thesis" / "setup-nested.sh").write_text("# mine\nMODE=in-place\n",
                                                             encoding="utf-8")
        self.add()
        self.assertEqual(self.read("thesis/setup-nested.sh"), "# mine\nMODE=in-place\n")

    def test_bad_python_is_refused(self):
        with self.assertRaises(SystemExit):
            self.add("--python", "3.9")


class AddAnalysisDocRepoEnv(NestsAnAnalysis):
    """An adopted or restored analysis repo carries the doc_analysis it was made with. One
    from before analysis-template #12 has no layout.py, cannot find its document from
    layout.toml, and needs DOC_REPO in its .env (#38)."""

    def add(self, *flags, lookup=False, env=None):
        checkout = self.tmp / "thesis" / "thesis-analysis"
        (checkout / ".git").mkdir(parents=True, exist_ok=True)
        (checkout / "src" / "doc_analysis").mkdir(parents=True, exist_ok=True)
        if lookup:
            (checkout / "src" / "doc_analysis" / "layout.py").write_text("", encoding="utf-8")
        if env is not None:
            (checkout / ".env").write_bytes(env.encode("utf-8"))
        return super().add("--from", "https://github.com/o/thesis-analysis.git", *flags)

    def env(self):
        return (self.tmp / "thesis" / "thesis-analysis" / ".env").read_bytes().decode("utf-8")

    def test_a_repo_without_the_layout_lookup_gets_doc_repo(self):
        self.add()
        self.assertEqual(self.env(), f"DOC_REPO={(self.tmp / 'thesis').as_posix()}\n")
        self.assertIn("predates analysis-template #12", self.out)
        self.assertIn("template sync", self.out)

    def test_a_repo_with_the_layout_lookup_gets_no_env(self):
        self.add(lookup=True)
        self.assertFalse((self.tmp / "thesis" / "thesis-analysis" / ".env").exists())
        self.assertNotIn("DOC_REPO", self.out)

    def test_other_lines_of_an_existing_env_are_kept(self):
        self.add(env="NOTION_TOKEN=x\r\n# mine\r\nWIKI=y")
        self.assertEqual(self.env(), "NOTION_TOKEN=x\r\n# mine\r\nWIKI=y\r\n"
                         f"DOC_REPO={(self.tmp / 'thesis').as_posix()}\r\n")

    def test_an_existing_doc_repo_is_not_overwritten(self):
        self.add(env="A=1\nDOC_REPO=/somewhere/else\n")
        self.assertEqual(self.env(), "A=1\nDOC_REPO=/somewhere/else\n")
        self.assertIn("already sets DOC_REPO", self.out)

    def test_dry_run_writes_no_env_but_says_it_would(self):
        with mock.patch.object(sw, "find_sh", return_value="/bin/sh"), \
                mock.patch.object(sw, "gh_raw", return_value="#!/bin/sh\n"):
            self.call("--dry-run", "add-analysis", "--from",
                      "https://github.com/o/thesis-analysis.git")
        self.assertFalse((self.tmp / "thesis" / "thesis-analysis").exists())
        self.assertIn("would write DOC_REPO=", self.out)


class Sync(Workspace):
    def setUp(self):
        super().setUp()
        self.call("init", "--name", "w")
        self.add_document()

    def test_passes_recorded_extras_in_the_analysis_repo(self):
        (self.tmp / "thesis" / "layout.toml").write_text(
            'layout = "writing-hosts-analysis"\nnested_dir = "a"\n', encoding="utf-8")
        (self.tmp / "thesis" / "a").mkdir()
        state = sw.read_state()
        sw.documents(state)[0]["extras"] = ["dev", "plotly"]
        sw.write_state(state)
        with mock.patch.object(sw, "run") as run:
            self.call("sync", "--extra", "publish")
        self.assertEqual(run.call_args.args[0],
                         ["uv", "sync", "--extra", "dev", "--extra", "plotly", "--extra", "publish"])
        self.assertEqual(run.call_args.kwargs["cwd"], self.tmp / "thesis" / "a")
        self.assertEqual(self.docs()[0]["extras"], ["dev", "plotly", "publish"])

    def test_no_analysis_repo_stops(self):
        with self.assertRaises(SystemExit):
            self.call("sync")


class WorkspaceAnalysis(Workspace):
    """A workspace analysis (#41): an analysis repo that is a member in its own right, in no
    document repo, feeding zero or more documents. GitHub, the clone and every command run
    are mocked; the clone leaves an init.py, as analysis-template's checkout has one."""

    def setUp(self):
        super().setUp()
        self.call("init", "--name", "w")
        self.add_document()
        state = self.state()
        state["repo"] = "o/w"
        self.write_json(state)

    def fake_clone(self, repo, directory):
        checkout = super().fake_clone(repo, directory)
        (checkout / "init.py").write_text("# analysis-template\n", encoding="utf-8")
        return checkout

    def add(self, *flags):
        with mock.patch.object(sw, "create_from_template") as created, \
                mock.patch.object(sw, "clone", side_effect=self.fake_clone) as cloned, \
                mock.patch.object(sw, "origin_url", return_value="https://github.com/o/x.git"), \
                mock.patch.object(sw, "run") as ran:
            # Before the call: a refusal raises out of it, and must not leave the last run's.
            self.created, self.cloned, self.ran = created, cloned, ran
            return self.call("add-analysis", "--workspace", *flags)

    def commands(self):
        return [(c.args[0], c.kwargs.get("cwd")) for c in self.ran.call_args_list]

    def member(self, directory="x"):
        return next(m for m in self.state()["members"] if m["dir"] == directory)

    def nest_analysis_in_thesis(self):
        """thesis hosts thesis/a, as setup-nested.sh and add-analysis leave it."""
        (self.tmp / "thesis" / "layout.toml").write_text(
            'layout = "writing-hosts-analysis"\nnested_dir = "a"\n', encoding="utf-8")
        (self.tmp / "thesis" / "a").mkdir()
        state = self.state()
        state["members"][0]["extras"] = ["dev", "notebooks", "plotly"]
        state["members"].append({"dir": "thesis/a", "repo": "o/a", "kind": "analysis",
                                 "documents": ["thesis"]})
        self.write_json(state)


class AddWorkspaceAnalysis(WorkspaceAnalysis):
    def test_dry_run_prints_the_plan_and_writes_nothing(self):
        before = {n: self.read(n) for n in (".claude/workspace.json", "CLAUDE.md")}
        with mock.patch.object(sw, "repo_exists", return_value=False), \
                mock.patch.object(sw, "quiet", side_effect=AssertionError("no gh read needed")):
            self.assertEqual(self.call("--dry-run", "add-analysis", "--workspace",
                                       "--repo-name", "x"), 0)
        self.assertIn("gh repo create o/x --template c-energie/analysis-template --private",
                      self.out)
        self.assertIn("gh repo clone o/x x", self.out)
        self.assertIn("write x/.python-version", self.out)
        self.assertIn("init.py --backend=plotly --doc-repo=", self.out)
        self.assertIn("uv sync --extra dev --extra notebooks --extra plotly  (in x)", self.out)
        self.assertIn("write .claude/workspace.json", self.out)
        self.assertEqual({n: self.read(n) for n in before}, before)
        self.assertFalse((self.tmp / "x").exists())

    def test_without_repo_name_it_stops_and_says_why(self):
        with self.assertRaises(SystemExit) as stop:
            self.add()
        self.assertIn("needs --repo-name", str(stop.exception.code))
        with self.assertRaises(SystemExit) as stop:
            self.add("--dir", "x")
        self.assertIn("needs --repo-name", str(stop.exception.code))
        self.created.assert_not_called()

    def test_creates_it_with_its_own_venv_and_records_the_member(self):
        self.assertEqual(self.add("--repo-name", "x", "--distribution", "x-analysis",
                                  "--author", "A"), 0)
        self.created.assert_called_once_with(sw.ANALYSIS_TEMPLATE, "o/x", "private",
                                             otherwise=mock.ANY)
        self.cloned.assert_called_once_with("o/x", "x")
        self.assertEqual(self.read("x/.python-version"), "3.12\n")
        (init, init_cwd), (sync, sync_cwd) = self.commands()
        self.assertEqual(init[1:], ["init.py", "--backend=plotly", "--doc-repo=",
                                    "--distribution=x-analysis", "--author=A"])
        self.assertEqual((init_cwd, sync_cwd), (self.tmp / "x", self.tmp / "x"))
        self.assertEqual(sync, ["uv", "sync", "--extra", "dev", "--extra", "notebooks",
                                "--extra", "plotly"])
        self.assertEqual(self.member(), {"dir": "x", "repo": "o/x", "kind": "analysis",
                                         "documents": [], "extras": ["dev", "notebooks", "plotly"]})

    def test_flags_choose_owner_visibility_dir_backend_and_python(self):
        self.add("--repo-name", "x", "--owner", "me", "--public", "--dir", "analyses/x",
                 "--backend", "matplotlib", "--python", "3.11")
        self.created.assert_called_once_with(sw.ANALYSIS_TEMPLATE, "me/x", "public",
                                             otherwise=mock.ANY)
        self.cloned.assert_called_once_with("me/x", "analyses/x")
        self.assertEqual(self.read("analyses/x/.python-version"), "3.11\n")
        self.assertEqual(self.member("analyses/x")["extras"], ["dev", "notebooks", "matplotlib"])

    def test_owner_defaults_to_the_gh_login_without_a_workspace_repo(self):
        state = self.state()
        del state["repo"]
        self.write_json(state)
        login = subprocess.CompletedProcess([], 0, "someone\n", "")
        with mock.patch.object(sw, "quiet", return_value=login):
            self.add("--repo-name", "x")
        self.assertEqual(self.member()["repo"], "someone/x")

    def test_a_re_run_records_it_once(self):
        self.add("--repo-name", "x")
        shutil.rmtree(self.tmp / "x")
        self.add("--repo-name", "x")
        self.assertEqual([m["dir"] for m in self.state()["members"]], ["thesis", "x"])

    def test_a_dir_inside_a_document_or_held_by_a_member_is_refused(self):
        for flags, why in ((("--dir", "thesis/x"), "nested analysis"),
                           (("--dir", "thesis"), "the document member thesis/"),
                           (("--dir", "../x"), "relative path inside")):
            with self.assertRaises(SystemExit) as stop:
                self.add("--repo-name", "x", *flags)
            self.assertIn(why, str(stop.exception.code))
        self.created.assert_not_called()

    def test_nested_mode_flags_are_refused(self):
        with self.assertRaises(SystemExit) as stop:
            self.add("--repo-name", "x", "--document", "thesis")
        self.assertIn("a workspace analysis is in none", str(stop.exception.code))

    def test_the_claude_md_analyses_table_lists_it_and_the_documents_it_feeds(self):
        self.assertNotIn("| Analysis | Repo | Documents fed |", self.read("CLAUDE.md"))
        self.add("--repo-name", "x")
        self.assertIn("| `x/` | `o/x` | none yet |", self.read("CLAUDE.md"))
        self.call("attach-analysis", "--analysis", "x", "--document", "thesis")
        self.assertIn("| `x/` | `o/x` | `thesis/` |", self.read("CLAUDE.md"))

    def test_a_tracked_workspace_ignores_it(self):
        (self.tmp / ".git").mkdir()
        with mock.patch.object(sw, "root_tracked_dirs", return_value=[]):
            self.add("--repo-name", "x")
        self.assertIn("/x/\n", self.read(".gitignore"))


class RestoreWorkspaceAnalysis(WorkspaceAnalysis):
    def setUp(self):
        super().setUp()
        self.add("--repo-name", "x")
        shutil.rmtree(self.tmp / "x")

    def test_re_running_workspace_mode_clones_it_back_and_syncs_it(self):
        before = self.read(".claude/workspace.json")
        self.assertEqual(self.add("--repo-name", "x"), 0)
        self.created.assert_not_called()
        self.cloned.assert_called_once_with("o/x", "x")
        self.assertEqual(self.commands(), [(["uv", "sync", "--extra", "dev", "--extra",
                                             "notebooks", "--extra", "plotly"], self.tmp / "x")])
        self.assertEqual(self.read(".claude/workspace.json"), before)

    def test_its_dir_alone_identifies_it(self):
        self.add("--dir", "x")
        self.cloned.assert_called_once_with("o/x", "x")

    def test_create_flags_are_refused_on_a_restore(self):
        with self.assertRaises(SystemExit) as stop:
            self.add("--repo-name", "x", "--python", "3.12")
        self.assertIn("--python do not apply", str(stop.exception.code))
        self.cloned.assert_not_called()

    def test_a_present_checkout_is_left_alone(self):
        self.fake_clone("o/x", "x")
        self.add("--repo-name", "x")
        self.cloned.assert_not_called()
        self.ran.assert_not_called()
        self.assertIn("nothing to restore", self.out)

    def test_the_restore_step_clones_and_syncs_it_too(self):
        with mock.patch.object(sw, "clone", side_effect=self.fake_clone) as cloned, \
                mock.patch.object(sw, "run") as ran:
            self.assertEqual(self.call("restore"), 0)
        cloned.assert_called_once_with("o/x", "x")
        self.assertEqual(ran.call_args.args[0][:2], ["uv", "sync"])
        self.assertEqual(ran.call_args.kwargs["cwd"], self.tmp / "x")


class AttachAnalysis(WorkspaceAnalysis):
    def setUp(self):
        super().setUp()
        self.add("--repo-name", "x")
        self.add_document(repo="o/paper")

    def attach(self, *flags, step="attach-analysis"):
        return self.call(step, "--analysis", "x", *flags)

    def test_attach_adds_the_document_once(self):
        self.attach("--document", "thesis")
        after = self.read(".claude/workspace.json")
        self.assertEqual(self.member()["documents"], ["thesis"])
        self.attach("--document", "thesis")
        self.assertIn("already feeds thesis/; nothing changed", self.out)
        self.assertEqual(self.read(".claude/workspace.json"), after)

    def test_it_can_feed_several_and_detach_removes_one(self):
        self.attach("--document", "thesis")
        self.attach("--document", "paper")
        self.assertEqual(self.member()["documents"], ["thesis", "paper"])
        self.attach("--document", "thesis", step="detach-analysis")
        self.assertEqual(self.member()["documents"], ["paper"])
        self.attach("--document", "thesis", step="detach-analysis")
        self.assertIn("does not feed thesis/; nothing changed", self.out)

    def test_an_unknown_or_non_document_dir_is_refused(self):
        state = self.state()
        state["members"].append({"dir": "tool", "repo": "o/tool", "kind": "code"})
        self.write_json(state)
        before = self.read(".claude/workspace.json")
        for document, why in (("nope", "names no member"),
                              ("tool", "is the code member tool/, not a document"),
                              ("x", "is the analysis member x/, not a document")):
            with self.assertRaises(SystemExit) as stop:
                self.attach("--document", document)
            self.assertIn(why, str(stop.exception.code))
        self.assertEqual(self.read(".claude/workspace.json"), before)

    def test_an_unknown_analysis_or_a_nested_one_is_refused(self):
        self.nest_analysis_in_thesis()
        with self.assertRaises(SystemExit) as stop:
            self.call("attach-analysis", "--analysis", "nope", "--document", "thesis")
        self.assertIn("No workspace analysis 'nope'", str(stop.exception.code))
        with self.assertRaises(SystemExit) as stop:
            self.call("attach-analysis", "--analysis", "thesis/a", "--document", "paper")
        self.assertIn("nested in thesis/", str(stop.exception.code))

    def test_a_document_with_a_nested_analysis_can_also_be_fed(self):
        self.nest_analysis_in_thesis()
        self.attach("--document", "thesis")
        self.assertEqual(self.member()["documents"], ["thesis"])
        self.assertEqual(self.member("thesis/a")["documents"], ["thesis"])

    def test_a_document_is_recorded_by_its_dir_when_named(self):
        state = self.state()
        state["members"][0]["name"] = "My Thesis"
        self.write_json(state)
        self.attach("--document", "My Thesis")
        self.assertEqual(self.member()["documents"], ["thesis"])

    def test_dry_run_writes_nothing(self):
        before = self.read(".claude/workspace.json")
        self.call("--dry-run", "attach-analysis", "--analysis", "x", "--document", "thesis")
        self.assertIn("write .claude/workspace.json", self.out)
        self.assertEqual(self.read(".claude/workspace.json"), before)

    def test_unknown_member_fields_survive(self):
        state = self.state()
        self.member_of(state)["mine"] = 1
        self.write_json(state)
        self.attach("--document", "thesis")
        self.assertEqual(self.member()["mine"], 1)

    def member_of(self, state):
        return next(m for m in state["members"] if m["dir"] == "x")


class DocumentNamesItsWorkspaceAnalyses(AttachAnalysis):
    """#64: setup-doc-publish picks doc-publish's home, and whether every command needs
    `--document`, from the workspace analyses `document` reports -- never by reading
    workspace.json's members itself."""

    def shown(self, *flags):
        self.call("document", *flags)
        return json.loads(self.out)

    def test_an_analysis_feeding_one_document_is_listed_with_that_count(self):
        self.attach("--document", "thesis")
        fed = self.shown("--document", "thesis")["workspace_analyses"]
        self.assertEqual([(m["dir"], m["documents"]) for m in fed], [("x", ["thesis"])])
        self.assertEqual(fed[0]["path"], (self.tmp / "x").as_posix())
        self.assertEqual(self.shown("--document", "paper")["workspace_analyses"], [])

    def test_one_feeding_several_lists_them_all_from_each_document(self):
        self.attach("--document", "thesis")
        self.attach("--document", "paper")
        for name in ("thesis", "paper"):
            fed = self.shown("--document", name)["workspace_analyses"]
            self.assertEqual(fed[0]["documents"], ["thesis", "paper"])

    def test_a_nested_analysis_is_not_one_of_them(self):
        # It is describe()'s analysis_path: listed here too, it would read as a second home.
        self.nest_analysis_in_thesis()
        info = self.shown("--document", "thesis")
        self.assertEqual(info["analysis_dir"], "a")
        self.assertEqual(info["workspace_analyses"], [])

    def test_all_carries_it_for_every_document(self):
        self.attach("--document", "paper")
        listed = {d["dir"]: d["workspace_analyses"] for d in self.shown("--all")}
        self.assertEqual(listed["thesis"], [])
        self.assertEqual([m["dir"] for m in listed["paper"]], ["x"])


class SyncEveryAnalysis(WorkspaceAnalysis):
    def setUp(self):
        super().setUp()
        self.add("--repo-name", "x", "--backend", "matplotlib")
        self.nest_analysis_in_thesis()

    def sync(self, *flags):
        with mock.patch.object(sw, "run") as ran:
            code = self.call("sync", *flags)
        return code, [(c.args[0], c.kwargs["cwd"]) for c in ran.call_args_list]

    def test_bare_sync_syncs_nested_and_workspace_each_with_its_extras(self):
        code, ran = self.sync()
        self.assertEqual(code, 0)
        self.assertEqual(ran, [
            (["uv", "sync", "--extra", "dev", "--extra", "notebooks", "--extra", "plotly"],
             self.tmp / "thesis" / "a"),
            (["uv", "sync", "--extra", "dev", "--extra", "notebooks", "--extra", "matplotlib"],
             self.tmp / "x")])

    def test_analysis_names_one_and_extra_is_recorded_on_its_member(self):
        code, ran = self.sync("--analysis", "x", "--extra", "marimo")
        self.assertEqual(ran, [(["uv", "sync", "--extra", "dev", "--extra", "notebooks",
                                 "--extra", "matplotlib", "--extra", "marimo"], self.tmp / "x")])
        self.assertEqual(self.member()["extras"], ["dev", "notebooks", "matplotlib", "marimo"])
        self.assertEqual(self.docs()[0]["extras"], ["dev", "notebooks", "plotly"])

    def test_one_missing_on_disk_is_reported_and_the_rest_synced(self):
        shutil.rmtree(self.tmp / "x")
        code, ran = self.sync()
        self.assertEqual(code, 1)
        self.assertEqual([cwd for _, cwd in ran], [self.tmp / "thesis" / "a"])
        self.assertIn("x/: x/ is not on disk", self.out)


class MigrateSchema1(Workspace):
    """Schema 1 -> workspace.json: the analysis repo moves inside the document, the root
    loses its Python, and everything removed is backed up first."""

    LEGACY_FULL = ('[workspace]\nname = "thesis"\nlayout = "full"\nwriting_dir = "thesis-writing"\n'
                   'writing_repo = "o/thesis-writing"\nwriting_mode = "adapt"\n'
                   'analysis_dir = "thesis-analysis"\nanalysis_repo = "o/thesis-analysis"\n'
                   'backend = "plotly"\nextras = ["dev", "notebooks", "plotly", "publish"]\n')

    def setUp(self):
        super().setUp()
        for d in ("thesis-writing", "thesis-analysis"):
            (self.tmp / d / ".git").mkdir(parents=True)
        (self.tmp / "thesis-writing" / "setup-nested.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (self.tmp / "thesis-analysis" / ".env").write_text("DOC_REPO=/old\nNOTION_TOKEN=x\n",
                                                           encoding="utf-8")
        (self.tmp / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
        (self.tmp / ".python-version").write_text("3.12\n", encoding="utf-8")
        (self.tmp / ".venv").mkdir()
        (self.tmp / "CLAUDE.md").write_text("old\n", encoding="utf-8")

    CURRENT_SCRIPT = "#!/bin/sh\nMODE=in-place\n"

    def migrate(self, *flags, legacy=LEGACY_FULL, gh_raw=None):
        (self.tmp / "workspace.toml").write_text(legacy, encoding="utf-8")

        def fetched(repo, path):
            # Where the analysis checkout is when the template is read: still beside.
            self.analysis_beside_at_fetch = (self.tmp / "thesis-analysis").exists()
            return self.CURRENT_SCRIPT if path == "setup-nested.sh" else "*.sh text eol=lf\n"

        def nested(cmd, cwd=None, **kw):
            # uv looks upward for a workspace root: the old one must be gone by now.
            self.root_pyproject_seen = (self.tmp / "pyproject.toml").exists()
            if cmd[:3] == ["git", "worktree", "repair"]:
                return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
            if "setup-nested.sh" in cmd:
                (self.tmp / "thesis-writing" / "layout.toml").write_text(
                    'layout = "writing-hosts-analysis"\nnested_dir = "thesis-analysis"\n',
                    encoding="utf-8")
        with mock.patch.object(sw, "run", side_effect=nested) as run, \
                mock.patch.object(sw, "find_sh", return_value="/bin/sh"), \
                mock.patch.object(sw, "gh_raw", side_effect=gh_raw or fetched), \
                mock.patch.object(sw, "origin_url", return_value="https://x/a.git"):
            self.call(*flags, "migrate")
        return run

    def test_outdated_setup_nested_is_replaced_before_the_move(self):
        self.migrate()
        self.assertTrue(self.analysis_beside_at_fetch)
        self.assertEqual(self.read("thesis-writing/setup-nested.sh"), self.CURRENT_SCRIPT)
        self.assertTrue((self.tmp / "thesis-writing" / ".gitattributes").exists())

    def test_outdated_setup_nested_is_in_the_plan(self):
        self.migrate("--dry-run")
        self.assertIn("update the outdated thesis-writing/setup-nested.sh", self.out)
        self.assertEqual(self.read("thesis-writing/setup-nested.sh"), "#!/bin/sh\n")

    def test_template_fetch_failure_stops_before_anything_changes(self):
        with self.assertRaises(SystemExit):
            self.migrate(gh_raw=mock.Mock(side_effect=SystemExit("no network")))
        self.assertTrue((self.tmp / "thesis-analysis" / ".git").exists())
        self.assertTrue((self.tmp / "pyproject.toml").exists())
        self.assertTrue((self.tmp / ".venv").exists())
        self.assertEqual(self.read("CLAUDE.md"), "old\n")
        self.assertIn("[workspace]", self.read("workspace.toml"))

    def test_current_setup_nested_is_left_alone(self):
        (self.tmp / "thesis-writing" / "setup-nested.sh").write_text(
            "#!/bin/sh\n# mine\nMODE=in-place\n", encoding="utf-8")
        self.migrate(gh_raw=mock.Mock(side_effect=AssertionError("fetched a current script")))
        self.assertIn("# mine", self.read("thesis-writing/setup-nested.sh"))

    def test_moves_analysis_inside_and_runs_setup_nested_in_place(self):
        run = self.migrate()
        self.assertTrue((self.tmp / "thesis-writing" / "thesis-analysis" / ".git").exists())
        self.assertFalse((self.tmp / "thesis-analysis").exists())
        nested = run.call_args_list[0].args[0]
        self.assertEqual(nested[:4], ["/bin/sh", "setup-nested.sh", "--backend", "plotly"])
        self.assertIn("--dir", nested)
        self.assertEqual(nested[nested.index("--python") + 1], "3.12")
        sync = run.call_args_list[1].args[0]
        self.assertEqual(sync[-2:], ["--extra", "publish"])

    def test_root_pyproject_is_gone_before_uv_runs_in_the_analysis_repo(self):
        self.migrate()
        self.assertFalse(self.root_pyproject_seen)

    def test_writes_workspace_json_with_the_document_its_extras_and_its_analysis(self):
        self.migrate()
        self.assertEqual(self.state(), {"schema": 1, "name": "thesis", "members": [
            {"dir": "thesis-writing", "repo": "o/thesis-writing", "kind": "document",
             "name": "thesis", "extras": ["dev", "notebooks", "plotly", "publish"]},
            {"dir": "thesis-writing/thesis-analysis", "repo": "https://x/a.git",
             "kind": "analysis", "documents": ["thesis-writing"]}]})
        self.assertFalse((self.tmp / "workspace.toml").exists())

    def test_root_python_is_backed_up_and_removed(self):
        self.migrate()
        for name in ("pyproject.toml", ".python-version", ".venv"):
            self.assertFalse((self.tmp / name).exists(), name)
        backup = self.tmp / ".setup" / "migrate-backup"
        self.assertTrue((backup / "pyproject.toml").exists())
        self.assertEqual((backup / "CLAUDE.md").read_text(encoding="utf-8"), "old\n")
        self.assertIn("[workspace]", (backup / "workspace.toml").read_text(encoding="utf-8"))

    def test_analysis_env_travels_unchanged(self):
        # The document repo does not move, so its DOC_REPO is still right, and doc-publish
        # (which reads no layout.toml) still needs it.
        self.migrate()
        env = self.read("thesis-writing/thesis-analysis/.env")
        self.assertEqual(env, "DOC_REPO=/old\nNOTION_TOKEN=x\n")

    def test_claude_md_is_the_plugin_text(self):
        self.migrate()
        self.assertIn("`thesis-writing/thesis-analysis/`", self.read("CLAUDE.md"))

    def test_legacy_gitignore_block_is_replaced(self):
        (self.tmp / ".git").mkdir()
        (self.tmp / ".gitignore").write_text(
            f"{sw.LEGACY_BLOCK_START}\n/thesis-writing/\n/thesis-analysis/\n{sw.LEGACY_BLOCK_END}\n"
            ".venv/\n", encoding="utf-8")
        self.migrate()
        text = self.read(".gitignore")
        self.assertNotIn(sw.LEGACY_BLOCK_START, text)
        self.assertIn("/thesis-writing/\n" + sw.BLOCK_END, text)
        self.assertNotIn("/thesis-analysis/", text)
        self.assertIn(".venv/", text)

    def test_dry_run_changes_nothing(self):
        run = self.migrate("--dry-run")
        run.assert_not_called()
        self.assertTrue((self.tmp / "thesis-analysis").exists())
        self.assertTrue((self.tmp / "pyproject.toml").exists())
        self.assertIn("move thesis-analysis/", self.out)

    def test_target_taken_stops_before_anything_changes(self):
        (self.tmp / "thesis-writing" / "thesis-analysis").mkdir()
        with self.assertRaises(SystemExit):
            self.migrate()
        self.assertTrue((self.tmp / "pyproject.toml").exists())
        self.assertIn("[workspace]", self.read("workspace.toml"))

    def test_writing_only(self):
        shutil.rmtree(self.tmp / "thesis-analysis")
        run = self.migrate(legacy='[workspace]\nname = "p"\nlayout = "writing-only"\n'
                                  'writing_dir = "thesis-writing"\nwriting_repo = "o/w"\n'
                                  'extras = ["publish"]\n')
        run.assert_not_called()
        self.assertEqual(self.state()["members"], [{"dir": "thesis-writing", "repo": "o/w",
                                                    "kind": "document", "name": "p"}])
        self.assertFalse((self.tmp / "pyproject.toml").exists())

    def test_a_migrated_workspace_reports_leftovers(self):
        self.migrate()
        (self.tmp / "uv.lock").write_text("", encoding="utf-8")
        self.call("migrate")
        self.assertIn("uv.lock", self.out)

    def test_a_load_bearing_root_pyproject_stops_before_anything_changes(self):
        # #34: a root uv workspace with members outside the analysis repo, sources from
        # elsewhere, and extras of its own is not schema 1's to delete.
        pyproject = ('[project]\nname = "w"\n[project.optional-dependencies]\ntooling = ["x"]\n'
                     '[tool.uv.workspace]\nmembers = ["thesis-analysis", "../other/src/*"]\n'
                     '[tool.uv.sources]\nlib = { git = "https://example.org/lib" }\n')
        (self.tmp / "pyproject.toml").write_text(pyproject, encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            self.migrate()
        message = str(caught.exception)
        for reason in ("../other/src/*", "lib", "tooling"):
            self.assertIn(reason, message)
        self.assertEqual(self.read("pyproject.toml"), pyproject)
        self.assertTrue((self.tmp / "thesis-analysis" / ".git").exists())
        self.assertIn("[workspace]", self.read("workspace.toml"))

    def test_a_root_pyproject_for_the_analysis_repo_alone_is_not_load_bearing(self):
        (self.tmp / "pyproject.toml").write_text(
            '[project]\nname = "w"\n[tool.uv.workspace]\nmembers = ["./thesis-analysis/"]\n'
            '[tool.uv.sources]\nthesis-analysis = { workspace = true }\n', encoding="utf-8")
        self.migrate()
        self.assertFalse((self.tmp / "pyproject.toml").exists())

    def test_moving_the_analysis_repo_repairs_its_linked_worktrees(self):
        # #35: a real repository, since what breaks is git's own bookkeeping of the paths.
        analysis = self.tmp / "thesis-analysis"
        shutil.rmtree(analysis)
        git = lambda *a, cwd=analysis: subprocess.run(
            ["git", "-c", "user.name=t", "-c", "user.email=t@t", *a], cwd=cwd,
            capture_output=True, text=True, check=True)
        analysis.mkdir()
        git("init", "-q")
        git("commit", "-q", "--allow-empty", "-m", "x")
        git("remote", "add", "origin", "https://github.com/o/thesis-analysis.git")
        git("worktree", "add", "-q", str(analysis / ".claude" / "worktrees" / "wt"))
        outside = self.tmp / ".setup" / "wt-outside"
        git("worktree", "add", "-q", str(outside))
        self.migrate("--dry-run")
        self.assertIn("repair its 2 linked git worktree(s)", self.out)
        self.migrate()
        moved = self.tmp / "thesis-writing" / "thesis-analysis"
        for wt in (moved / ".claude" / "worktrees" / "wt", outside):
            status = subprocess.run(["git", "status", "--short"], cwd=wt,
                                    capture_output=True, text=True)
            self.assertEqual(status.returncode, 0, f"{wt}: {status.stderr}")


class MigrateSchema2(Workspace):
    """workspace.toml schema 2 -> .claude/workspace.json: nothing moves, every document and
    extra survives, a nested analysis becomes an analysis member, and the TOML goes."""

    def place(self, fixture, analysis_in_first=True):
        """The fixture's workspace.toml at the root, each document a checkout, the first
        hosting a nested analysis repo as setup-nested.sh records one."""
        text = (FIXTURES / fixture).read_text(encoding="utf-8")
        (self.tmp / "workspace.toml").write_text(text, encoding="utf-8")
        toml = sw.tomllib.loads(text)
        for i, doc in enumerate(toml["document"]):
            (self.tmp / doc["dir"] / ".git").mkdir(parents=True)
            if i == 0 and analysis_in_first:
                (self.tmp / doc["dir"] / "layout.toml").write_text(
                    'layout = "writing-hosts-analysis"\nnested_dir = "analysis"\n'
                    f'nested_remote = "git@github.com:o/{doc["dir"]}-analysis.git"\n',
                    encoding="utf-8")
        return toml

    def expected(self, toml):
        """What the conversion must say, worked out from the TOML independently: every key
        of every [[document]] kept, an analysis member after the first."""
        members = []
        for i, doc in enumerate(toml["document"]):
            members.append({"dir": doc["dir"], "repo": doc["repo"], "kind": "document",
                            "name": doc.get("name", doc["dir"]), **doc})
            if i == 0:
                members.append({"dir": f"{doc['dir']}/analysis", "repo": f"o/{doc['dir']}-analysis",
                                "kind": "analysis", "documents": [doc["dir"]]})
        return {"schema": 1, "name": toml["name"], "members": members}

    def dry_run_json(self):
        """The workspace.json the dry run printed, parsed back."""
        lines = self.out.split(" will read")[1].split("\n")[1:]
        return json.loads("\n".join(line[4:] for line in lines if line.startswith("    ")))

    def test_fixtures_convert_with_no_lost_document_extra_or_analysis(self):
        for fixture in ("smeter-validation-workspace.toml", "corson94-thesis.toml"):
            with self.subTest(fixture):
                for child in self.tmp.iterdir():
                    shutil.rmtree(child) if child.is_dir() else child.unlink()
                toml = self.place(fixture)
                self.call("--dry-run", "migrate")
                self.assertEqual(self.dry_run_json(), self.expected(toml))
                self.assertFalse((self.tmp / ".claude").exists(), "the dry run wrote")
                self.assertTrue((self.tmp / "workspace.toml").exists())
                self.call("migrate")
                self.assertEqual(self.state(), self.expected(toml))
                self.assertFalse((self.tmp / "workspace.toml").exists())
                backup = self.tmp / ".setup" / "migrate-backup" / "workspace.toml"
                self.assertEqual(backup.read_text(encoding="utf-8"),
                                 (FIXTURES / fixture).read_text(encoding="utf-8"))

    def test_dry_run_output(self):
        self.place("corson94-thesis.toml")
        (self.tmp / "paper" / "extra").mkdir()
        self.call("--dry-run", "migrate")
        self.assertIn("Converting workspace.toml (schema 2, 2 document(s)) into "
                      ".claude/workspace.json:\n"
                      "  - write .claude/workspace.json: 2 document member(s), 1 analysis member(s)\n"
                      "  - record thesis/analysis/ as an analysis member feeding thesis/ "
                      "(from its layout.toml)\n"
                      "  - back up workspace.toml (-> .setup/migrate-backup/), then remove it\n",
                      self.out)
        self.assertIn(
            "    {\n"
            '      "schema": 1,\n'
            '      "name": "thesis",\n'
            '      "members": [\n'
            # Longer than a line allows, so one key to a line, as json-block.mjs renders it.
            "        {\n"
            '          "dir": "thesis",\n'
            '          "repo": "corson94/thesis-writing",\n'
            '          "kind": "document",\n'
            '          "name": "thesis",\n'
            '          "extras": ["dev", "notebooks", "matplotlib", "publish"]\n'
            "        },\n"
            '        { "dir": "thesis/analysis", "repo": "o/thesis-analysis", "kind": "analysis", '
            '"documents": ["thesis"] },\n'
            '        { "dir": "paper", "repo": "corson94/paper-flex", "kind": "document", '
            '"name": "paper-flex" }\n'
            "      ]\n"
            "    }\n", self.out)

    def test_nothing_else_at_the_root_is_touched(self):
        # #34: schema 2 has no Python at the root, so a pyproject.toml there is something else's.
        self.place("corson94-thesis.toml")
        for name in ("pyproject.toml", "uv.lock", ".python-version"):
            (self.tmp / name).write_text("mine\n", encoding="utf-8")
        (self.tmp / ".venv").mkdir()
        self.call("migrate")
        for name in ("pyproject.toml", "uv.lock", ".python-version"):
            self.assertEqual(self.read(name), "mine\n")
        self.assertTrue((self.tmp / ".venv").is_dir())

    def test_unknown_document_keys_travel_and_unknown_top_level_keys_are_reported(self):
        (self.tmp / "thesis" / ".git").mkdir(parents=True)
        (self.tmp / "workspace.toml").write_text(
            'schema = 2\nname = "w"\nowner = "me"\n[[document]]\nname = "t"\ndir = "thesis"\n'
            'repo = "o/t"\nnotes = "kept"\n', encoding="utf-8")
        self.call("migrate")
        self.assertEqual(self.docs(), [{"dir": "thesis", "repo": "o/t", "kind": "document",
                                        "name": "t", "notes": "kept"}])
        self.assertIn("not carried over: workspace.toml's `owner`", self.out)
        self.assertNotIn("owner", self.state())

    def test_an_existing_workspace_json_without_members_is_merged_into(self):
        self.place("corson94-thesis.toml", analysis_in_first=False)
        theirs = ('{\n    "_comment_connections": "hand-written",\n'
                  '    "connections": {"github": ["o"]}\n}\n')
        self.write_json(theirs)
        self.call("migrate")
        text = self.read(".claude/workspace.json")
        self.assertTrue(text.startswith(theirs[:-3]), text)
        self.assertIn('\n    "schema": 1,\n', text, "the file's own indent is used")
        self.assertEqual(self.state()["connections"], {"github": ["o"]})

    def test_both_manifests_listing_members_is_refused(self):
        self.place("corson94-thesis.toml")
        self.write_json({"schema": 1, "name": "w", "members": [{"dir": "x", "repo": "o/x",
                                                               "kind": "code"}]})
        with self.assertRaises(SystemExit) as caught:
            self.call("migrate")
        self.assertIn("refusing to merge", str(caught.exception))
        self.assertTrue((self.tmp / "workspace.toml").exists())

    def test_claude_md_naming_the_toml_is_flagged_not_rewritten(self):
        self.place("corson94-thesis.toml")
        old = f"workspace.toml lists them.\n{sw.DOCS_START}\n{sw.DOCS_END}\n"
        (self.tmp / "CLAUDE.md").write_text(old, encoding="utf-8")
        self.call("migrate")
        self.assertIn("CLAUDE.md still names workspace.toml", self.out)
        self.assertTrue(self.read("CLAUDE.md").startswith("workspace.toml lists them.\n"))
        self.assertIn("| paper-flex | `paper/` |", self.read("CLAUDE.md"))

    def test_a_second_run_has_nothing_to_do(self):
        self.place("corson94-thesis.toml")
        self.call("migrate")
        before = self.read(".claude/workspace.json")
        self.call("migrate")
        self.assertIn("is the manifest already", self.out)
        self.assertEqual(self.read(".claude/workspace.json"), before)


class TomlStillTheManifest(Workspace):
    """With workspace.toml and no workspace.json, every step but `migrate` and `check`
    refuses in one line naming `migrate`: there is no dual-writing."""

    STEPS = (("init",), ("track",), ("document", "--all"), ("sync",),
             ("add-document", "--mode", "adapt", "--repo", "o/x"), ("add-analysis",),
             ("adopt",), ("add-member", "--repo", "o/x"), ("restore",))

    def test_every_step_refuses_and_names_migrate(self):
        for toml in ('schema = 2\nname = "w"\n[[document]]\nname = "t"\ndir = "t"\nrepo = "o/t"\n',
                     '[workspace]\nname = "w"\nwriting_dir = "t"\n'):
            (self.tmp / "workspace.toml").write_text(toml, encoding="utf-8")
            for step in self.STEPS:
                with self.subTest(step=step[0], toml=toml[:10]), \
                        mock.patch.object(sw, "run") as run, \
                        self.assertRaises(SystemExit) as caught:
                    self.call(*step)
                message = str(caught.exception)
                self.assertIn("migrate", message)
                self.assertEqual(len(message.splitlines()), 1)
                run.assert_not_called()
            self.assertFalse((self.tmp / ".claude").exists())
            self.assertFalse((self.tmp / "CLAUDE.md").exists())

    def test_a_workspace_json_with_connections_only_does_not_count(self):
        (self.tmp / "workspace.toml").write_text('schema = 2\nname = "w"\n', encoding="utf-8")
        self.write_json({"connections": {}})
        with self.assertRaises(SystemExit) as caught:
            self.call("document", "--all")
        self.assertIn("migrate", str(caught.exception))


class UnknownKeysSurvive(Workspace):
    """workspace.json's other keys belong to other plugins, and member entries carry fields
    only later code defines: every write keeps them, and other blocks byte for byte."""

    HAND = ('{\r\n'
            '  "_comment_connections": "which orgs the gate allows",\r\n'
            '  "connections": {"github":   ["o"]},\r\n'
            '  "schema": 1,\r\n'
            '  "name": "w",\r\n'
            '  "members": [{"dir": "tool", "repo": "o/tool", "kind": "code", "pinned": "v2"}],\r\n'
            '  "state": {"notion": {"db": "x"}},\r\n'
            '  "future": [1, 2]\r\n'
            '}\r\n')

    def test_every_write_keeps_them(self):
        self.write_json(self.HAND)
        (self.tmp / ".git").mkdir()
        self.add_document()
        (self.tmp / "thesis" / "setup-nested.sh").write_text("MODE=in-place\n", encoding="utf-8")

        def nested(cmd, cwd=None, **kw):
            (self.tmp / "thesis" / "layout.toml").write_text(
                'layout = "writing-hosts-analysis"\nnested_dir = "a"\n', encoding="utf-8")
            (self.tmp / "thesis" / "a").mkdir(exist_ok=True)
        with mock.patch.object(sw, "run", side_effect=nested), \
                mock.patch.object(sw, "find_sh", return_value="/bin/sh"):
            self.call("add-analysis")
            self.call("sync", "--extra", "publish")
        with mock.patch.object(sw, "origin_url", return_value="git@github.com:o/w.git"):
            self.call("track")
        self.call("init")
        state = self.state()
        self.assertEqual(state["members"][0], {"dir": "tool", "repo": "o/tool", "kind": "code",
                                               "pinned": "v2"})
        self.assertEqual(state["repo"], "o/w")
        self.assertEqual(state["future"], [1, 2])
        text = (self.tmp / ".claude" / "workspace.json").read_bytes().decode("utf-8")
        self.assertTrue(text.startswith(self.HAND[:self.HAND.index('"members"')]))
        for line in self.HAND.splitlines(keepends=True):
            if not line.lstrip().startswith(('"members"', '"future"', "}")):
                self.assertIn(line, text, "a block this script does not own was reformatted")
        self.assertNotIn("\n", text.replace("\r\n", ""), "line endings were mixed")
        # The tracked .gitignore ignores the code member too: every member is its own repo.
        self.assertIn("/tool/\n/thesis/\n", self.read(".gitignore"))

    def test_a_bom_is_kept(self):
        self.write_json("\ufeff" + '{"schema": 1, "name": "w", "members": []}\n')
        self.add_document()
        raw = (self.tmp / ".claude" / "workspace.json").read_text(encoding="utf-8")
        self.assertTrue(raw.startswith("\ufeff{"))
        self.assertEqual(len(self.docs()), 1)


class JsonBlockWriter(unittest.TestCase):
    """upsert_json_key: json-block.mjs's guarantee, ported -- one value span changes."""

    def test_replaces_only_the_value(self):
        raw = '{\n  "a": {"x":1},\n  "members": [],\n  "b": "}{"\n}\n'
        new = sw.upsert_json_key(raw, "members", [{"dir": "d"}])
        self.assertEqual(new, '{\n  "a": {"x":1},\n  "members": [{ "dir": "d" }],\n  "b": "}{"\n}\n')

    def test_appends_a_missing_key_last(self):
        self.assertEqual(sw.upsert_json_key('{\n\t"a": 1\n}\n', "name", "w"),
                         '{\n\t"a": 1,\n\t"name": "w"\n}\n')

    def test_into_an_empty_object(self):
        self.assertEqual(sw.upsert_json_key("{}\n", "schema", 1), '{\n  "schema": 1\n}\n')

    def test_long_values_go_one_entry_to_a_line(self):
        members = [{"dir": f"member-{i}", "repo": f"owner/member-{i}", "kind": "code"}
                   for i in range(3)]
        new = sw.upsert_json_key('{\n  "members": []\n}\n', "members", members)
        self.assertEqual(new.count("\n"), 7)
        self.assertEqual(json.loads(new)["members"], members)

    def test_a_nested_key_of_the_same_name_is_not_the_top_level_one(self):
        raw = '{"state": {"members": 1}}'
        self.assertEqual(json.loads(sw.upsert_json_key(raw, "members", []))["state"],
                         {"members": 1})


class FindsTheRoot(unittest.TestCase):
    """The script ships in a plugin, so the root comes from --root or the current directory,
    never from where the script sits."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        saved = sw.ROOT
        self.addCleanup(sw.set_root, saved)

    # The cases workspace.test.mjs holds context-kit-core's findWorkspace() to (#47): this is
    # its Python port, and two walks that disagree would act on two different workspaces.
    def workspace(self, d, body=None):
        (d / ".claude").mkdir(parents=True, exist_ok=True)
        (d / ".claude" / "workspace.json").write_text(
            body if isinstance(body, str) else json.dumps(body or {"schema": 1, "members": []}),
            encoding="utf-8")
        return d

    def root_from(self, cwd):
        cwd.mkdir(parents=True, exist_ok=True)
        with mock.patch.object(sw.Path, "cwd", return_value=cwd):
            return sw.default_root()

    def test_three_levels_below_a_workspace_json_that_root_is_found(self):
        self.workspace(self.tmp)
        self.assertEqual(self.root_from(self.tmp / "a" / "b" / "c"), self.tmp)

    def test_the_walk_does_not_stop_at_a_member_clones_git(self):
        self.workspace(self.tmp)
        (self.tmp / "thesis" / ".git").mkdir(parents=True)
        self.assertEqual(self.root_from(self.tmp / "thesis" / "chapters"), self.tmp)

    def test_nested_workspaces_the_inner_wins_and_nothing_merges(self):
        outer = self.workspace(self.tmp, {"schema": 1, "name": "outer", "connections": {"x": 1}})
        inner = self.workspace(outer / "projects" / "inner", {"schema": 1, "name": "inner"})
        self.assertEqual(self.root_from(inner / "src"), inner)
        found = sw.find_workspace(inner / "src")
        self.assertEqual(found["config"], {"schema": 1, "name": "inner"}, "levels never merge")
        self.assertEqual(self.root_from(outer / "projects"), outer)

    def test_a_malformed_workspace_json_is_reported_with_its_path_and_error(self):
        for case, body in enumerate(('{ "schema": 1, "name": ', "[1, 2]")):
            with self.subTest(body):
                root = self.workspace(self.tmp / f"case{case}", body)
                found = sw.find_workspace(root / "sub")
                self.assertIsNone(found["root"])
                self.assertEqual(found["file"], root / ".claude" / "workspace.json")
                self.assertTrue(found["error"])
                with mock.patch.object(sw.Path, "cwd", return_value=root), \
                        self.assertRaises(SystemExit) as caught:
                    sw.set_root(sw.default_root())
                    sw.main(["document", "--all"])
                message = str(caught.exception)
                self.assertIn(str(root / ".claude" / "workspace.json"), message)
                self.assertIn("malformed", message)
                self.assertIn(found["error"], message)

    def test_a_malformed_inner_workspace_never_falls_through_to_the_outer(self):
        outer = self.workspace(self.tmp)
        inner = self.workspace(outer / "inner", "not json")
        self.assertEqual(self.root_from(inner / "sub"), inner)
        self.assertIsNone(sw.find_workspace(inner)["root"])

    def test_a_directory_named_workspace_json_is_malformed_not_skipped(self):
        outer = self.workspace(self.tmp)
        (outer / "inner" / ".claude" / "workspace.json").mkdir(parents=True)
        self.assertEqual(self.root_from(outer / "inner"), outer / "inner")
        self.assertIsNone(sw.find_workspace(outer / "inner")["root"])

    def test_unknown_keys_reach_the_caller_untouched(self):
        body = {"schema": 1, "future": {"x": 1}, "members": [
            {"dir": "a", "repo": "o/a", "kind": "analysis", "documents": ["t"], "extra": True}]}
        self.workspace(self.tmp, body)
        self.assertEqual(sw.find_workspace(self.tmp)["config"], body)

    def test_the_nearer_of_a_workspace_json_and_a_workspace_toml_wins(self):
        self.workspace(self.tmp)
        (self.tmp / "old").mkdir()
        (self.tmp / "old" / "workspace.toml").write_text("schema = 2\n", encoding="utf-8")
        self.assertEqual(self.root_from(self.tmp / "old" / "thesis"), self.tmp / "old")
        self.workspace(self.tmp / "old" / "thesis")
        self.assertEqual(self.root_from(self.tmp / "old" / "thesis"), self.tmp / "old" / "thesis")

    def test_walks_up_to_an_unmigrated_workspace_toml(self):
        (self.tmp / "workspace.toml").write_text("", encoding="utf-8")
        (self.tmp / "thesis" / "Sections").mkdir(parents=True)
        with mock.patch.object(sw.Path, "cwd", return_value=self.tmp / "thesis" / "Sections"):
            self.assertEqual(sw.default_root(), self.tmp)

    def test_current_directory_before_setup(self):
        with mock.patch.object(sw.Path, "cwd", return_value=self.tmp):
            self.assertEqual(sw.default_root(), self.tmp)

    def test_root_flag_moves_every_root_path(self):
        seen = {}
        step = lambda args: seen.update(root=sw.ROOT, state=sw.STATE_FILE, setup=sw.SETUP_DIR)
        with mock.patch.object(sw, "cmd_check", step):
            sw.main(["--root", str(self.tmp), "check"])
        self.assertEqual(seen, {"root": self.tmp, "state": self.tmp / ".claude" / "workspace.json",
                                "setup": self.tmp / ".setup"})


def git(*args, cwd):
    """git with an identity and a branch name of its own, so no global config is needed."""
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t",
                           "-c", "init.defaultBranch=main", *args],
                          cwd=cwd, capture_output=True, text=True, check=True)


# What each kind of checkout holds, as far as `adopt` looks: content, never the name.
DOCUMENT_FILES = {"main.tex": "\\documentclass{article}\n",
                  "setup-nested.sh": "#!/bin/sh\nMODE=in-place\n"}
NESTED_LAYOUT = 'layout = "writing-hosts-analysis"\nnested_dir = "thesis-analysis"\n'
ANALYSIS_FILES = {"pyproject.toml": '[project]\nname = "a"\n',
                  "src/doc_analysis/__init__.py": ""}
CODE_FILES = {"README.md": "a tool\n"}


class FolderOfClones(Workspace):
    """Real repositories whose origins are local bare repos: nothing reaches the network,
    and what is read back -- origins, clones, ignore rules -- is git's own answer."""

    def setUp(self):
        super().setUp()
        self.origins = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.origins, ignore_errors=True)

    def origin(self, name, files):
        """A bare repo holding `files` in one commit; its path, as a member records it."""
        work = self.origins / f"{name}-work"
        for path, text in files.items():
            (work / path).parent.mkdir(parents=True, exist_ok=True)
            (work / path).write_text(text, encoding="utf-8")
        git("init", "-q", cwd=work)
        git("add", "-A", cwd=work)
        git("commit", "-q", "-m", "x", cwd=work)
        bare = self.origins / f"{name}.git"
        git("clone", "-q", "--bare", str(work), str(bare), cwd=self.origins)
        return str(bare)

    def clone_from(self, origin, directory):
        git("clone", "-q", origin, str(self.tmp / directory), cwd=self.tmp)

    def folder(self):
        """thesis (a document hosting thesis-analysis), paper (a document), tool (code) and
        study (an analysis repo of its own): four checkouts, five members."""
        self.repos = {
            "thesis": self.origin("thesis", {**DOCUMENT_FILES, "layout.toml": NESTED_LAYOUT,
                                             ".gitignore": "/thesis-analysis/\n"}),
            "thesis-analysis": self.origin("thesis-analysis", ANALYSIS_FILES),
            "paper": self.origin("paper", {"Sections/Intro/intro.tex": "x\n"}),
            "tool": self.origin("tool", CODE_FILES),
            "study": self.origin("study", ANALYSIS_FILES),
        }
        for name in ("thesis", "paper", "tool", "study"):
            self.clone_from(self.repos[name], name)
        self.clone_from(self.repos["thesis-analysis"], "thesis/thesis-analysis")

    def expected_members(self):
        r = self.repos
        return [
            {"dir": "paper", "repo": r["paper"], "kind": "document", "name": "paper"},
            {"dir": "study", "repo": r["study"], "kind": "analysis", "documents": []},
            {"dir": "thesis", "repo": r["thesis"], "kind": "document", "name": "thesis"},
            {"dir": "thesis/thesis-analysis", "repo": r["thesis-analysis"], "kind": "analysis",
             "documents": ["thesis"]},
            {"dir": "tool", "repo": r["tool"], "kind": "code"},
        ]


class Adopt(FolderOfClones):
    def test_proposes_every_checkout_and_writes_nothing_without_yes(self):
        self.folder()
        self.assertEqual(self.call("adopt"), 0)
        for line in ("- thesis/  document", "- thesis/thesis-analysis/  analysis",
                     "feeds thesis/", "- paper/  document", "- tool/  code",
                     "- study/  analysis", "feeds no document", "Nothing written"):
            self.assertIn(line, self.out)
        self.assertFalse((self.tmp / ".claude").exists())
        self.assertFalse((self.tmp / "CLAUDE.md").exists())

    def test_yes_writes_the_members_it_proposed(self):
        self.folder()
        self.call("adopt", "--name", "w", "--yes")
        state = self.state()
        self.assertEqual(state["members"], self.expected_members())
        self.assertEqual((state["schema"], state["name"]), (1, "w"))
        self.assertIn("| thesis | `thesis/` |", self.read("CLAUDE.md"))

    def test_a_wrong_kind_is_corrected_with_kind(self):
        self.folder()
        self.call("adopt", "--kind", "tool=analysis", "--yes")
        tool = next(m for m in self.state()["members"] if m["dir"] == "tool")
        self.assertEqual(tool, {"dir": "tool", "repo": self.repos["tool"], "kind": "analysis",
                                "documents": []})

    def test_a_kind_naming_no_checkout_or_no_kind_stops(self):
        self.folder()
        for flag in ("nothing=code", "tool=library"):
            with self.subTest(flag=flag), self.assertRaises(SystemExit):
                self.call("adopt", "--kind", flag, "--yes")
        self.assertFalse((self.tmp / ".claude").exists())

    def test_an_adopted_root_is_not_adopted_again(self):
        self.folder()
        self.call("adopt", "--yes")
        with self.assertRaises(SystemExit) as caught:
            self.call("adopt", "--yes")
        self.assertIn("add-member", str(caught.exception))

    def test_a_workspace_json_with_connections_only_is_merged_into(self):
        self.folder()
        self.write_json('{\n  "connections": { "github": ["o"] }\n}\n')
        self.call("adopt", "--yes")
        self.assertIn('  "connections": { "github": ["o"] },\n', self.read(".claude/workspace.json"))
        self.assertEqual(len(self.state()["members"]), 5)

    def test_a_checkout_without_origin_is_noted(self):
        (self.tmp / "scratch").mkdir()
        git("init", "-q", cwd=self.tmp / "scratch")
        self.call("adopt", "--yes")
        self.assertIn("scratch/ has no origin", self.out)
        self.assertEqual(self.state()["members"], [{"dir": "scratch", "repo": "", "kind": "code"}])

    def test_a_nested_checkout_layout_toml_does_not_name_is_noted_not_recorded(self):
        self.repos = {"paper": self.origin("paper", DOCUMENT_FILES),
                      "extra": self.origin("extra", ANALYSIS_FILES)}
        self.clone_from(self.repos["paper"], "paper")
        self.clone_from(self.repos["extra"], "paper/extra")
        self.call("adopt", "--yes")
        self.assertIn("paper/extra/ is a checkout its layout.toml does not name", self.out)
        self.assertEqual([m["dir"] for m in self.state()["members"]], ["paper"])

    def test_hidden_directories_and_plain_folders_are_not_members(self):
        self.folder()
        (self.tmp / ".setup" / "x" / ".git").mkdir(parents=True)
        (self.tmp / "notes").mkdir()
        self.call("adopt", "--yes")
        self.assertEqual(len(self.state()["members"]), 5)

    def test_nothing_to_adopt_stops(self):
        with self.assertRaises(SystemExit) as caught:
            self.call("adopt")
        self.assertIn("init", str(caught.exception))


class AdoptSideBySide(FolderOfClones):
    """#33: a hand-built schema-1 folder -- sibling document and analysis checkouts, a root
    pyproject.toml making the analysis repo a uv member, no manifest -- is adopted as it is,
    then offered the nesting migration, which keeps #34's stop."""

    ROOT_PYPROJECT = ('[project]\nname = "root"\n[tool.uv.workspace]\n'
                      'members = ["thesis-analysis"]\n'
                      '[tool.uv.sources]\na = { workspace = true }\n')

    def setUp(self):
        super().setUp()
        self.repos = {"thesis-writing": self.origin("thesis-writing", DOCUMENT_FILES),
                      "thesis-analysis": self.origin("thesis-analysis", ANALYSIS_FILES)}
        for name, origin in self.repos.items():
            self.clone_from(origin, name)
        (self.tmp / ".venv").mkdir()

    def adopt(self, pyproject=ROOT_PYPROJECT):
        (self.tmp / "pyproject.toml").write_text(pyproject, encoding="utf-8")
        self.call("adopt", "--yes")

    def migrate(self, *flags):
        def nested(cmd, cwd=None, **kw):
            self.root_pyproject_seen = (self.tmp / "pyproject.toml").exists()
            if "setup-nested.sh" in cmd:
                (self.tmp / "thesis-writing" / "layout.toml").write_text(
                    NESTED_LAYOUT, encoding="utf-8")
        with mock.patch.object(sw, "run", side_effect=nested) as run, \
                mock.patch.object(sw, "find_sh", return_value="/bin/sh"), \
                mock.patch.object(sw, "gh_raw", side_effect=AssertionError("no fetch")):
            self.call(*flags, "migrate")
        return run

    def test_adopted_as_it_is_and_offered_the_nesting_migration(self):
        self.adopt()
        self.assertEqual(self.state()["members"], [
            {"dir": "thesis-analysis", "repo": self.repos["thesis-analysis"], "kind": "analysis",
             "documents": []},
            {"dir": "thesis-writing", "repo": self.repos["thesis-writing"], "kind": "document",
             "name": "thesis-writing"}])
        self.assertIn("--dry-run migrate", self.out)
        self.assertEqual(self.read("pyproject.toml"), self.ROOT_PYPROJECT)
        self.assertTrue((self.tmp / ".venv").is_dir())

    def test_the_migration_plan_names_the_move_and_the_member(self):
        self.adopt()
        run = self.migrate("--dry-run")
        run.assert_not_called()
        self.assertIn("move thesis-analysis/ -> thesis-writing/thesis-analysis/", self.out)
        self.assertIn("re-point the analysis member", self.out)
        self.assertTrue((self.tmp / "thesis-analysis" / ".git").exists())

    def test_migrating_nests_it_and_re_points_the_member(self):
        self.adopt()
        self.migrate()
        self.assertTrue((self.tmp / "thesis-writing" / "thesis-analysis" / ".git").exists())
        self.assertFalse(self.root_pyproject_seen)
        analysis = next(m for m in self.state()["members"] if m["kind"] == "analysis")
        self.assertEqual(analysis, {"dir": "thesis-writing/thesis-analysis",
                                    "repo": self.repos["thesis-analysis"], "kind": "analysis",
                                    "documents": ["thesis-writing"]})
        self.assertEqual(len(self.state()["members"]), 2)
        self.assertEqual(self.read(".setup/migrate-backup/pyproject.toml"), self.ROOT_PYPROJECT)
        self.call("migrate")
        self.assertIn("nothing to migrate", self.out)

    def test_a_load_bearing_root_pyproject_survives(self):
        # #34: other uv members live in the root's workspace; deleting it broke them.
        load_bearing = self.ROOT_PYPROJECT.replace('["thesis-analysis"]',
                                                   '["thesis-analysis", "other"]')
        self.adopt(load_bearing)
        with self.assertRaises(SystemExit) as caught:
            self.migrate()
        self.assertIn("load-bearing", str(caught.exception))
        self.assertEqual(self.read("pyproject.toml"), load_bearing)
        self.assertTrue((self.tmp / "thesis-analysis" / ".git").exists())

    def test_a_root_level_analysis_with_no_root_pyproject_is_no_document_mode(self):
        self.call("adopt", "--yes")
        self.assertNotIn("nesting migration", self.out)
        self.migrate()
        self.assertIn("nothing to migrate", self.out)
        self.assertTrue((self.tmp / "thesis-analysis" / ".git").exists())


class AddMember(FolderOfClones):
    def setUp(self):
        super().setUp()
        self.call("init", "--name", "w")

    def test_clones_and_records_a_code_repo(self):
        tool = self.origin("tool", CODE_FILES)
        self.call("add-member", "--repo", tool)
        self.assertEqual(self.read("tool/README.md"), "a tool\n")
        self.assertEqual(self.state()["members"], [{"dir": "tool", "repo": tool, "kind": "code"}])

    def test_owner_name_is_cloned_by_gh(self):
        with mock.patch.object(sw, "run") as run:
            self.call("add-member", "--repo", "o/tool", "--dir", "t")
        self.assertEqual(run.call_args.args[0], ["gh", "repo", "clone", "o/tool", "t"])
        self.assertEqual(self.state()["members"], [{"dir": "t", "repo": "o/tool", "kind": "code"}])

    def test_re_adding_the_same_repo_is_refused(self):
        with mock.patch.object(sw, "run"):
            self.call("add-member", "--repo", "o/tool")
            for repo, flags in (("o/tool", ()), ("https://github.com/O/tool.git", ("--dir", "x"))):
                with self.subTest(repo=repo), self.assertRaises(SystemExit) as caught:
                    self.call("add-member", "--repo", repo, *flags)
                self.assertIn("already a member", str(caught.exception))
        self.assertEqual(len(self.state()["members"]), 1)

    def test_a_dir_taken_by_another_member_is_refused(self):
        with mock.patch.object(sw, "run"):
            self.call("add-member", "--repo", "o/tool")
            with self.assertRaises(SystemExit):
                self.call("add-member", "--repo", "p/tool")

    def test_a_checkout_of_another_repo_in_the_dir_is_refused(self):
        self.clone_from(self.origin("other", CODE_FILES), "tool")
        with self.assertRaises(SystemExit) as caught:
            self.call("add-member", "--repo", self.origin("tool", CODE_FILES))
        self.assertIn("already a checkout of", str(caught.exception))
        self.assertEqual(self.state()["members"], [])


class Restore(FolderOfClones):
    """A fresh clone of the root has workspace.json and no members on disk."""

    def setUp(self):
        super().setUp()
        self.folder()
        self.call("adopt", "--yes")

    def restore(self, *flags):
        def run(cmd, cwd=None, **kw):
            if "setup-nested.sh" in cmd:
                # The document's own script restores what its layout.toml names.
                git("clone", "-q", self.repos["thesis-analysis"], "thesis-analysis", cwd=cwd)
                return
            return subprocess.run([str(c) for c in cmd], cwd=cwd, capture_output=True,
                                  text=True, check=True)
        with mock.patch.object(sw, "run", side_effect=run) as ran, \
                mock.patch.object(sw, "find_sh", return_value="/bin/sh"):
            code = self.call(*flags, "restore")
        return code, ran

    def test_clones_every_missing_member_and_leaves_present_ones(self):
        for name in ("thesis", "paper", "study"):
            shutil.rmtree(self.tmp / name)
        (self.tmp / "tool" / "mine.txt").write_text("uncommitted\n", encoding="utf-8")
        code, ran = self.restore()
        self.assertEqual(code, 0)
        for name in ("thesis", "thesis/thesis-analysis", "paper", "study"):
            self.assertTrue((self.tmp / name / ".git").exists(), name)
        self.assertEqual(self.read("tool/mine.txt"), "uncommitted\n")
        self.assertIn("present  tool/", self.out)
        self.assertNotIn(["git", "clone", self.repos["tool"], "tool"],
                         [c.args[0] for c in ran.call_args_list])

    def test_the_nested_analysis_goes_through_setup_nested(self):
        shutil.rmtree(self.tmp / "thesis")
        _, ran = self.restore()
        nested = [c for c in ran.call_args_list if "setup-nested.sh" in c.args[0]]
        self.assertEqual(len(nested), 1)
        self.assertEqual(nested[0].kwargs["cwd"], self.tmp / "thesis")

    def test_a_restored_repo_older_than_template_12_gets_doc_repo(self):
        # ANALYSIS_FILES has no doc_analysis/layout.py: an analysis repo made before #12.
        shutil.rmtree(self.tmp / "thesis")
        self.restore()
        env = self.tmp / "thesis" / "thesis-analysis" / ".env"
        self.assertEqual(env.read_text(encoding="utf-8"),
                         f"DOC_REPO={(self.tmp / 'thesis').as_posix()}\n")

    def test_dry_run_clones_nothing(self):
        shutil.rmtree(self.tmp / "thesis")
        with mock.patch.object(sw.subprocess, "run", wraps=sw.subprocess.run):
            self.call("--dry-run", "restore")
        self.assertIn(f"git clone {self.repos['thesis']} thesis", self.out)
        self.assertIn("then restore thesis/thesis-analysis/", self.out)
        self.assertFalse((self.tmp / "thesis").exists())

    def test_nothing_missing_changes_nothing(self):
        before = self.read(".claude/workspace.json")
        code, ran = self.restore()
        self.assertEqual(code, 0)
        self.assertIn("Nothing was missing", self.out)
        ran.assert_not_called()
        self.assertEqual(self.read(".claude/workspace.json"), before)

    def test_a_member_with_no_repo_is_reported(self):
        state = self.state()
        state["members"].append({"dir": "lost", "repo": "", "kind": "code"})
        self.write_json(state)
        code, _ = self.restore()
        self.assertEqual(code, 1)
        self.assertIn("lost/ records no repo", self.out)


class RootGitignore(FolderOfClones):
    """The root .gitignore is an allowlist: root files and the workspace's own folders are
    tracked, every other top-level directory -- every member above all -- is not."""

    def setUp(self):
        super().setUp()
        git("init", "-q", cwd=self.tmp)
        self.call("init", "--name", "w")
        with mock.patch.object(sw, "run"):
            self.call("add-member", "--repo", "o/tool")

    def ignored(self, path):
        return subprocess.run(["git", "check-ignore", "-q", path], cwd=self.tmp).returncode == 0

    def test_members_and_strays_are_ignored_and_the_workspaces_own_are_not(self):
        for path in ("tool/x", "cloned-by-hand/x"):
            self.assertTrue(self.ignored(path), path)
        for path in (".claude/workspace.json", "CLAUDE.md", ".gitignore", "docs/memory.md",
                     ".context/pending/x.md", "teaching/a/b.md"):
            self.assertFalse(self.ignored(path), path)
        self.assertIn(".gitignore: rewriting the managed block", self.out)

    def test_twice_adds_no_duplicate_lines(self):
        before = self.read(".gitignore")
        self.call("init")
        self.assertEqual(self.read(".gitignore"), before)
        lines = [l for l in before.splitlines() if l and not l.startswith("#")]
        self.assertEqual(len(lines), len(set(lines)))

    def test_a_folder_the_root_already_tracks_stays_tracked(self):
        (self.tmp / "notes").mkdir()
        (self.tmp / "notes" / "a.md").write_text("x\n", encoding="utf-8")
        # Committed before the allowlist existed: forced past it, as that history was.
        git("add", "-f", "notes/a.md", cwd=self.tmp)
        self.call("init")
        self.assertIn("!/notes/\n", self.read(".gitignore"))
        self.assertFalse(self.ignored("notes/b.md"))

    def test_a_line_the_user_already_has_is_not_repeated(self):
        (self.tmp / ".gitignore").write_text(self.read(".gitignore") + "!/docs/\n", encoding="utf-8")
        self.call("init")
        self.assertEqual(self.read(".gitignore").count("!/docs/"), 1)
        self.assertIn("already has `!/docs/`", self.out)


class OrgRoot(Workspace):
    def test_an_org_clone_root_is_offered_org_slash_workspace(self):
        root = self.tmp / "c-energie"
        root.mkdir()
        sw.set_root(root)
        sw.write_state({"schema": 1, "name": "c-energie",
                        "members": [{"dir": "tool", "repo": "c-energie/tool", "kind": "code"}]})
        out = io.StringIO()
        with mock.patch.object(sw, "run", side_effect=lambda *a, **k: (root / ".git").mkdir()), \
                contextlib.redirect_stdout(out):
            sw.main(["--root", str(root), "track"])
        self.assertIn("the name to offer is c-energie/workspace", out.getvalue())

    def test_any_other_root_is_not(self):
        sw.write_state({"schema": 1, "name": "w",
                        "members": [{"dir": "t", "repo": "c-energie/t", "kind": "code"}]})
        self.assertIsNone(sw.org_workspace_repo(sw.read_state()))


if __name__ == "__main__":
    unittest.main()
