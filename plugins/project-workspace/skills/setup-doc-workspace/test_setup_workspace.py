"""Tests for setup_workspace.py's import staging. Stdlib only: no pandoc, no network.

    uv run --no-project --python 3.12 -m unittest discover -s plugins/project-workspace/skills/setup-doc-workspace
"""
import contextlib
import io
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import setup_workspace as sw


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
        import_dir = tmp / ".setup" / "import-source"
        out = io.StringIO()
        with mock.patch.object(sw, "DRY_RUN", True), \
                mock.patch.object(sw, "IMPORT_DIR", import_dir), \
                mock.patch.object(sw, "ROOT", tmp), \
                mock.patch.object(sw.subprocess, "run") as subprocess_run, \
                contextlib.redirect_stdout(out):
            sw.stage_import_source(str(docx))
        printed = out.getvalue()
        self.assertIn("uv run --no-project --with pypandoc_binary==1.17", printed)
        self.assertIn("--extract-media=media", printed)
        self.assertIn("--standalone", printed)
        self.assertIn(sw.PANDOC_DOWNLOAD, printed)
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


class RootPinsPython(unittest.TestCase):
    """`root` pins the workspace interpreter: unpinned, `uv sync` takes the newest one
    allowed, and scientific stacks often have no wheels for it yet (#9)."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        (self.tmp / "CLAUDE.md").write_text("<!-- setup-banner -->\nx\n<!-- /setup-banner -->\n",
                                            encoding="utf-8")

    def root(self, *flags, python=None):
        out = io.StringIO()
        with mock.patch.object(sw, "ROOT", self.tmp), \
                mock.patch.object(sw, "STATE_FILE", self.tmp / "workspace.toml"), \
                mock.patch.object(sw, "DRY_RUN", False), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            sw.main([*flags, "root", "--name", "w", "--layout", "writing-only",
                     "--writing-dir", "w-writing", "--writing-repo", "o/w-writing",
                     "--writing-mode", "fresh", *(["--python", python] if python else [])])
        return out.getvalue()

    def test_writes_python_version(self):
        self.root()
        self.assertEqual((self.tmp / ".python-version").read_text(encoding="utf-8"), "3.12\n")

    def test_keeps_an_existing_pin(self):
        (self.tmp / ".python-version").write_text("3.11\n", encoding="utf-8")
        printed = self.root()
        self.assertEqual((self.tmp / ".python-version").read_text(encoding="utf-8"), "3.11\n")
        self.assertIn("kept  .python-version", printed)

    def test_python_flag_sets_the_pin(self):
        self.root(python="3.11")
        self.assertEqual((self.tmp / ".python-version").read_text(encoding="utf-8"), "3.11\n")

    def test_python_flag_accepts_a_patch(self):
        self.root(python="3.12.4")
        self.assertEqual((self.tmp / ".python-version").read_text(encoding="utf-8"), "3.12.4\n")

    def test_python_flag_below_the_minimum_stops(self):
        with self.assertRaises(SystemExit):
            self.root(python="3.10")
        self.assertFalse((self.tmp / ".python-version").exists())

    def test_python_flag_not_a_version_stops(self):
        with self.assertRaises(SystemExit):
            self.root(python="latest")

    def test_existing_pin_that_differs_from_the_flag_is_kept_and_named(self):
        (self.tmp / ".python-version").write_text("3.13\n", encoding="utf-8")
        printed = self.root(python="3.11")
        self.assertEqual((self.tmp / ".python-version").read_text(encoding="utf-8"), "3.13\n")
        self.assertIn("uv python pin 3.11", printed)

    def test_dry_run_writes_nothing(self):
        printed = self.root("--dry-run")
        self.assertIn("write .python-version", printed)
        self.assertFalse((self.tmp / ".python-version").exists())
        self.assertFalse((self.tmp / "workspace.toml").exists())


FULL_CLAUDE_MD = ("<!-- setup-banner -->\nbanner\n<!-- /setup-banner -->\n"
                  "# <<WORKSPACE>>: <<WRITING_DIR>> (<<WRITING_REPO>>) + "
                  "<<ANALYSIS_DIR>> (<<ANALYSIS_REPO>>), <<BACKEND>>\n")


class AddAnalysis(unittest.TestCase):
    """`add-analysis` turns a writing-only workspace into a full one without recreating
    the writing repo (#18). GitHub and the analysis template's init.py are mocked: the
    clone is faked as a checkout whose pyproject.toml init.py has already filled in."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        (self.tmp / "CLAUDE.md").write_text(
            sw.WRITING_ONLY_CLAUDE_MD.read_text(encoding="utf-8"), encoding="utf-8")
        (self.tmp / ".gitignore").write_text(".venv/\n", encoding="utf-8")
        (self.tmp / "w-writing" / "Sections" / "Intro" / "Figures").mkdir(parents=True)
        (self.tmp / "w-writing" / "document_settings.sty").write_text(
            "\\graphicspath{%\n  {Sections/Intro/Figures/}%\n}\n", encoding="utf-8")
        self.patch()
        self.call("root", "--name", "w", "--layout", "writing-only",
                  "--writing-dir", "w-writing", "--writing-repo", "o/w-writing",
                  "--writing-mode", "fresh")

    def patch(self):
        for name, value in (("ROOT", self.tmp), ("STATE_FILE", self.tmp / "workspace.toml"),
                            ("DRY_RUN", False)):
            patcher = mock.patch.object(sw, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def call(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            sw.main(list(argv))
        return out.getvalue()

    def fake_clone(self, repo, directory):
        checkout = self.tmp / directory
        (checkout / ".git").mkdir(parents=True, exist_ok=True)
        (checkout / "pyproject.toml").write_text('[project]\nname = "w-analysis"\n',
                                                 encoding="utf-8")
        return checkout

    def add(self, *flags, analysis_dir="w-analysis", analysis_repo="o/w-analysis"):
        self.created = mock.MagicMock()
        self.init = mock.MagicMock()
        with mock.patch.object(sw, "create_from_template", self.created), \
                mock.patch.object(sw, "clone", side_effect=self.fake_clone) as clone, \
                mock.patch.object(sw, "run_init", self.init), \
                mock.patch.object(sw, "gh_raw", return_value=FULL_CLAUDE_MD):
            self.clone = clone
            return self.call(*flags, "add-analysis", "--repo", analysis_repo,
                             "--dir", analysis_dir, "--distribution", "w-analysis",
                             "--author", "A")

    def state(self):
        return sw.tomllib.loads((self.tmp / "workspace.toml").read_text(encoding="utf-8"))["workspace"]

    def read(self, name):
        return (self.tmp / name).read_text(encoding="utf-8")

    def test_records_the_full_layout(self):
        self.add()
        state = self.state()
        self.assertEqual(state["layout"], "full")
        self.assertEqual(state["analysis_dir"], "w-analysis")
        self.assertEqual(state["analysis_repo"], "o/w-analysis")
        self.assertEqual(state["analysis_distribution"], "w-analysis")
        self.assertEqual(state["backend"], "plotly")
        self.assertEqual(state["extras"], ["dev", "notebooks", "plotly"])
        self.assertEqual(state["writing_dir"], "w-writing")
        self.assertEqual(state["writing_mode"], "fresh")

    def test_creates_the_analysis_repo_with_doc_repo_at_the_writing_member(self):
        self.add()
        self.created.assert_called_once_with(sw.ANALYSIS_TEMPLATE, "o/w-analysis", "private")
        self.assertEqual(self.init.call_args.kwargs["doc_repo"],
                         (self.tmp / "w-writing").as_posix())

    def test_root_pyproject_lists_the_member(self):
        self.add()
        pyproject = sw.tomllib.loads(self.read("pyproject.toml"))
        self.assertEqual(pyproject["tool"]["uv"]["workspace"]["members"], ["w-analysis"])
        self.assertEqual(pyproject["project"]["dependencies"], ["w-analysis"])

    def test_gitignore_block_covers_both_members_and_keeps_the_rest(self):
        self.add()
        text = self.read(".gitignore")
        self.assertIn("/w-writing/\n/w-analysis/\n", text)
        self.assertEqual(text.count(sw.BLOCK_START), 1)
        self.assertIn(".venv/", text)

    def test_unedited_writing_only_claude_md_becomes_the_full_one(self):
        self.add()
        self.assertEqual(self.read("CLAUDE.md"),
                         "# w: w-writing (o/w-writing) + w-analysis (o/w-analysis), plotly\n")

    def test_edited_claude_md_is_kept_and_named(self):
        (self.tmp / "CLAUDE.md").write_text("my own notes\n", encoding="utf-8")
        printed = self.add()
        self.assertEqual(self.read("CLAUDE.md"), "my own notes\n")
        self.assertIn("kept  CLAUDE.md", printed)

    def test_publish_root_pyproject_is_replaced_and_publish_carried_over(self):
        self.call("publish-root")
        printed = self.add()
        pyproject = sw.tomllib.loads(self.read("pyproject.toml"))
        self.assertEqual(pyproject["tool"]["uv"]["workspace"]["members"], ["w-analysis"])
        self.assertEqual(pyproject["project"]["optional-dependencies"]["publish"],
                         ["w-analysis[publish]"])
        self.assertEqual(self.state()["extras"], ["dev", "notebooks", "plotly", "publish"])
        # The root .env may hold a Notion token: kept, and the move it needs is named.
        self.assertTrue((self.tmp / ".env").exists())
        self.assertIn("w-analysis/.env", printed)

    def test_edited_root_pyproject_stops_before_any_repo_is_created(self):
        (self.tmp / "pyproject.toml").write_text("[project]\nname = 'mine'\n", encoding="utf-8")
        with self.assertRaises(SystemExit):
            self.add()
        self.created.assert_not_called()
        self.assertEqual(self.state()["layout"], "writing-only")

    def test_missing_workspace_toml_stops(self):
        (self.tmp / "workspace.toml").unlink()
        with self.assertRaises(SystemExit):
            self.add()
        self.created.assert_not_called()

    def test_re_run_changes_nothing(self):
        self.add()
        before = {p: self.read(p) for p in ("workspace.toml", "pyproject.toml",
                                            ".gitignore", "CLAUDE.md")}
        self.add()
        self.assertEqual(before, {p: self.read(p) for p in before})

    def test_full_workspace_with_another_analysis_member_stops(self):
        self.add()
        with self.assertRaises(SystemExit):
            self.add(analysis_dir="other-analysis", analysis_repo="o/other-analysis")
        self.created.assert_not_called()

    def test_no_sections_is_reported(self):
        shutil.rmtree(self.tmp / "w-writing" / "Sections")
        printed = self.add()
        self.assertIn("no Sections/", printed)

    def test_figure_dir_missing_from_graphicspath_is_reported(self):
        (self.tmp / "w-writing" / "Sections" / "Method" / "Figures").mkdir(parents=True)
        printed = self.add()
        self.assertIn("Sections/Method/Figures/ is not in", printed)
        self.assertNotIn("Sections/Intro/Figures/ is not", printed)

    def test_section_without_figures_is_one_reminder(self):
        (self.tmp / "w-writing" / "Sections" / "Method").mkdir()
        printed = self.add()
        self.assertIn("no Figures/ yet in Method", printed)
        self.assertNotIn("Sections/Method/Figures/ is not in", printed)

    def test_dry_run_writes_nothing(self):
        before = self.read("workspace.toml")
        with mock.patch.object(self, "fake_clone", lambda repo, directory: self.tmp / directory):
            printed = self.add("--dry-run")
        self.assertEqual(self.read("workspace.toml"), before)
        self.assertFalse((self.tmp / "pyproject.toml").exists())
        self.assertIn("write pyproject.toml", printed)

    def test_missing_claude_md_gets_the_full_one(self):
        (self.tmp / "CLAUDE.md").unlink()
        self.add()
        self.assertIn("w-analysis (o/w-analysis)", self.read("CLAUDE.md"))

    def test_invalid_root_pyproject_stops_cleanly(self):
        (self.tmp / "pyproject.toml").write_text("[project\n", encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            self.add()
        self.assertIn("not valid TOML", str(caught.exception))
        self.created.assert_not_called()

    def test_non_empty_analysis_dir_stops_before_any_repo_is_created(self):
        (self.tmp / "w-analysis").mkdir()
        (self.tmp / "w-analysis" / "stray.txt").write_text("x", encoding="utf-8")
        with self.assertRaises(SystemExit):
            self.add()
        self.created.assert_not_called()

    def test_template_fetch_failure_stops_before_any_repo_is_created(self):
        with mock.patch.object(sw, "gh_raw", side_effect=SystemExit("no network")), \
                mock.patch.object(sw, "create_from_template") as created, \
                self.assertRaises(SystemExit):
            self.call("add-analysis", "--repo", "o/w-analysis", "--dir", "w-analysis",
                      "--distribution", "w-analysis", "--author", "A")
        created.assert_not_called()
        self.assertEqual(self.state()["layout"], "writing-only")


class FindsTheRoot(unittest.TestCase):
    """The script ships in a plugin, so the root comes from --root or the current directory,
    never from where the script sits."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        saved = sw.ROOT
        self.addCleanup(sw.set_root, saved)

    def test_walks_up_to_workspace_toml(self):
        (self.tmp / "workspace.toml").write_text("", encoding="utf-8")
        (self.tmp / "doc-writing" / "Sections").mkdir(parents=True)
        with mock.patch.object(sw.Path, "cwd", return_value=self.tmp / "doc-writing" / "Sections"):
            self.assertEqual(sw.default_root(), self.tmp)

    def test_current_directory_before_setup(self):
        with mock.patch.object(sw.Path, "cwd", return_value=self.tmp):
            self.assertEqual(sw.default_root(), self.tmp)

    def test_root_flag_moves_every_root_path(self):
        seen = {}
        step = lambda args: seen.update(root=sw.ROOT, state=sw.STATE_FILE, imports=sw.IMPORT_DIR)
        with mock.patch.object(sw, "cmd_check", step):
            sw.main(["--root", str(self.tmp), "check"])
        self.assertEqual(seen, {"root": self.tmp, "state": self.tmp / "workspace.toml",
                                "imports": self.tmp / ".setup" / "import-source"})


if __name__ == "__main__":
    unittest.main()
