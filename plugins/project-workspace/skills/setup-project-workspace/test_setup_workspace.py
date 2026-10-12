"""Tests for setup_workspace.py's import staging. Stdlib only: no pandoc, no network.

    uv run --no-project --python 3.12 -m unittest discover -s plugins/project-workspace/skills/setup-project-workspace
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
        return sw.tomllib.loads(self.read("workspace.toml"))

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
    def test_writes_schema_2_and_claude_md(self):
        self.call("init", "--name", "w")
        self.assertEqual(self.state(), {"schema": 2, "name": "w"})
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
        self.assertEqual(len(self.state()["document"]), 1)
        self.assertEqual(self.read("CLAUDE.md"), "mine\n")

    def test_schema_1_is_sent_to_migrate(self):
        (self.tmp / "workspace.toml").write_text('[workspace]\nname = "w"\n', encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            self.call("init")
        self.assertIn("migrate", str(caught.exception))


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
        self.assertEqual(self.state()["document"],
                         [{"name": "thesis", "dir": "thesis", "repo": "o/thesis"}])
        self.created.assert_called_once_with(sw.WRITING_TEMPLATE, "o/thesis", "private")

    def test_several_documents_and_the_claude_md_table(self):
        self.add_document()
        self.add_document("--dir", "p", "--name", "paper", repo="o/paper")
        self.assertEqual([d["name"] for d in self.state()["document"]], ["thesis", "paper"])
        claude = self.read("CLAUDE.md")
        self.assertIn("| thesis | `thesis/` | `o/thesis` | — |", claude)
        self.assertIn("| paper | `p/` | `o/paper` | — |", claude)
        self.assertNotIn("_none yet", claude)

    def test_re_run_changes_nothing(self):
        self.add_document()
        before = self.read("workspace.toml"), self.read("CLAUDE.md")
        self.add_document()
        self.assertEqual(before, (self.read("workspace.toml"), self.read("CLAUDE.md")))

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
        (self.tmp / "workspace.toml").unlink()
        with self.assertRaises(SystemExit):
            self.add_document()


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
        state = {"document": self.state_["document"][:1]}
        self.assertEqual(sw.find_document(state, cwd=self.tmp)["name"], "thesis")

    def test_analysis_comes_from_layout_toml(self):
        (self.tmp / "thesis" / "layout.toml").write_text(
            'layout = "writing-hosts-analysis"\nnested_dir = "thesis-analysis"\n', encoding="utf-8")
        info = sw.describe(self.state_["document"][0])
        self.assertEqual(info["analysis_dir"], "thesis-analysis")
        self.assertEqual(info["analysis_path"], (self.tmp / "thesis" / "thesis-analysis").as_posix())
        self.assertIsNone(sw.describe(self.state_["document"][1])["analysis_dir"])


class AddAnalysis(Workspace):
    """add-analysis hands the work to the document's own setup-nested.sh."""

    def setUp(self):
        super().setUp()
        self.call("init", "--name", "w")
        self.add_document()
        (self.tmp / "thesis" / "setup-nested.sh").write_text("#!/bin/sh\n", encoding="utf-8")

    def add(self, *flags):
        def nested(cmd, cwd=None, **kw):
            (self.tmp / "thesis" / "layout.toml").write_text(
                'layout = "writing-hosts-analysis"\nnested_dir = "thesis-analysis"\n',
                encoding="utf-8")
        with mock.patch.object(sw, "run", side_effect=nested) as run, \
                mock.patch.object(sw, "find_sh", return_value="/bin/sh"), \
                mock.patch.object(sw, "gh_raw", return_value="#!/bin/sh\n"):
            self.call("add-analysis", *flags)
        return run

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
        self.assertEqual(self.state()["document"][0]["extras"], ["dev", "notebooks", "matplotlib"])
        self.assertIn("`thesis/thesis-analysis/`", self.read("CLAUDE.md"))

    def test_a_document_without_the_script_gets_it(self):
        (self.tmp / "thesis" / "setup-nested.sh").unlink()
        self.add()
        self.assertTrue((self.tmp / "thesis" / "setup-nested.sh").exists())
        self.assertTrue((self.tmp / "thesis" / ".gitattributes").exists())

    def test_bad_python_is_refused(self):
        with self.assertRaises(SystemExit):
            self.add("--python", "3.9")


class Sync(Workspace):
    def setUp(self):
        super().setUp()
        self.call("init", "--name", "w")
        self.add_document()

    def test_passes_recorded_extras_in_the_analysis_repo(self):
        (self.tmp / "thesis" / "layout.toml").write_text(
            'layout = "writing-hosts-analysis"\nnested_dir = "a"\n', encoding="utf-8")
        state = sw.read_state()
        state["document"][0]["extras"] = ["dev", "plotly"]
        sw.write_state(state)
        with mock.patch.object(sw, "run") as run:
            self.call("sync", "--extra", "publish")
        self.assertEqual(run.call_args.args[0],
                         ["uv", "sync", "--extra", "dev", "--extra", "plotly", "--extra", "publish"])
        self.assertEqual(run.call_args.kwargs["cwd"], self.tmp / "thesis" / "a")
        self.assertEqual(self.state()["document"][0]["extras"], ["dev", "plotly", "publish"])

    def test_no_analysis_repo_stops(self):
        with self.assertRaises(SystemExit):
            self.call("sync")


class Migrate(Workspace):
    """Schema 1 -> 2: the analysis repo moves inside the document, the root loses its
    Python, and everything removed is backed up first."""

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

    def migrate(self, *flags, legacy=LEGACY_FULL):
        (self.tmp / "workspace.toml").write_text(legacy, encoding="utf-8")

        def nested(cmd, cwd=None, **kw):
            # uv looks upward for a workspace root: the old one must be gone by now.
            self.root_pyproject_seen = (self.tmp / "pyproject.toml").exists()
            if "setup-nested.sh" in cmd:
                (self.tmp / "thesis-writing" / "layout.toml").write_text(
                    'layout = "writing-hosts-analysis"\nnested_dir = "thesis-analysis"\n',
                    encoding="utf-8")
        with mock.patch.object(sw, "run", side_effect=nested) as run, \
                mock.patch.object(sw, "find_sh", return_value="/bin/sh"), \
                mock.patch.object(sw, "origin_url", return_value="https://x/a.git"):
            self.call(*flags, "migrate")
        return run

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

    def test_writes_schema_2_with_one_document_and_its_extras(self):
        self.migrate()
        self.assertEqual(self.state(), {"schema": 2, "name": "thesis", "document": [{
            "name": "thesis", "dir": "thesis-writing", "repo": "o/thesis-writing",
            "extras": ["dev", "notebooks", "plotly", "publish"]}]})

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
        self.assertEqual(self.state()["document"], [{"name": "p", "dir": "thesis-writing",
                                                     "repo": "o/w"}])
        self.assertFalse((self.tmp / "pyproject.toml").exists())

    def test_schema_2_reports_leftovers(self):
        self.migrate()
        (self.tmp / "uv.lock").write_text("", encoding="utf-8")
        self.call("migrate")
        self.assertIn("uv.lock", self.out)


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
        self.assertEqual(seen, {"root": self.tmp, "state": self.tmp / "workspace.toml",
                                "setup": self.tmp / ".setup"})


if __name__ == "__main__":
    unittest.main()
