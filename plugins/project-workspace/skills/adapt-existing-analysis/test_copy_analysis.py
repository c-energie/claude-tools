"""Tests for copy_analysis.py's interpreter check. Stdlib only.

    uv run --no-project --python 3.12 -m unittest discover -s plugins/project-workspace/skills/adapt-existing-analysis
"""
import shutil
import tempfile
import unittest
from pathlib import Path

import copy_analysis as ca


class PinFits(unittest.TestCase):
    """Whether some patch release of the workspace pin satisfies the source's
    requires-python; None when the specifier is not one this can read (#9)."""

    def test_inside_a_bounded_range(self):
        self.assertTrue(ca.pin_fits("3.12", ">=3.11.4, <3.14"))

    def test_above_the_upper_bound(self):
        self.assertFalse(ca.pin_fits("3.14", ">=3.11.4, <3.14"))

    def test_below_the_lower_bound(self):
        self.assertFalse(ca.pin_fits("3.10", ">=3.11"))

    def test_lower_bound_on_a_patch_of_the_pinned_minor(self):
        self.assertTrue(ca.pin_fits("3.12", ">=3.12.4"))

    def test_upper_bound_on_a_patch_of_the_pinned_minor(self):
        self.assertTrue(ca.pin_fits("3.12", "<3.12.4"))

    def test_less_or_equal_minor(self):
        self.assertTrue(ca.pin_fits("3.12", "<=3.12"))
        self.assertFalse(ca.pin_fits("3.13", "<=3.12"))

    def test_exact_wildcard(self):
        self.assertTrue(ca.pin_fits("3.11", "==3.11.*"))
        self.assertFalse(ca.pin_fits("3.12", "==3.11.*"))

    def test_compatible_release(self):
        self.assertTrue(ca.pin_fits("3.12", "~=3.10"))
        self.assertFalse(ca.pin_fits("3.9", "~=3.10"))

    def test_wildcard_exclusion_of_the_pinned_minor(self):
        self.assertFalse(ca.pin_fits("3.12", "!=3.12.*"))
        self.assertFalse(ca.pin_fits("3.12", ">=3.11, !=3.12.*"))
        self.assertTrue(ca.pin_fits("3.12", "!=3.11.*"))

    def test_exclusion_of_one_patch(self):
        self.assertTrue(ca.pin_fits("3.12", "!=3.12.1"))
        self.assertFalse(ca.pin_fits("3.12.1", "!=3.12.1"))

    def test_patch_pin(self):
        self.assertFalse(ca.pin_fits("3.12.1", ">=3.12.4"))

    def test_unreadable_specifier(self):
        self.assertIsNone(ca.pin_fits("3.12", ">=3.11; python_version"))
        self.assertIsNone(ca.pin_fits("cpython@3.12", ">=3.11"))


class SourcePython(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)

    def test_reads_requires_python_and_python_version(self):
        (self.tmp / "pyproject.toml").write_text(
            '[project]\nname = "x"\nrequires-python = ">=3.11.4, <3.14"\n', encoding="utf-8")
        (self.tmp / ".python-version").write_text("3.13\n", encoding="utf-8")
        self.assertEqual(ca.source_python(self.tmp),
                         {"requires_python": ">=3.11.4, <3.14", "python_version": "3.13"})

    def test_neither_present(self):
        self.assertEqual(ca.source_python(self.tmp),
                         {"requires_python": None, "python_version": None})

    def test_non_string_requires_python_is_ignored(self):
        (self.tmp / "pyproject.toml").write_text("[project]\nrequires-python = 3\n", encoding="utf-8")
        self.assertEqual(ca.source_python(self.tmp)["requires_python"], None)

    def test_unparseable_pyproject_is_ignored(self):
        (self.tmp / "pyproject.toml").write_text("not toml [", encoding="utf-8")
        self.assertEqual(ca.source_python(self.tmp)["requires_python"], None)


class PythonReport(unittest.TestCase):
    def report(self, requires, version, pin):
        return "\n".join(ca.python_report({"requires_python": requires, "python_version": version}, pin))

    def test_pin_inside_the_range(self):
        text = self.report(">=3.11.4, <3.14", "3.13", "3.12")
        self.assertIn("requires-python >=3.11.4, <3.14", text)
        self.assertIn(".python-version 3.13", text)
        self.assertNotIn("WARNING", text)

    def test_pin_outside_the_range_says_how_to_re_pin(self):
        text = self.report(">=3.11.4, <3.14", None, "3.14")
        self.assertIn("WARNING", text)
        self.assertIn("uv python pin", text)
        self.assertIn(ca.RESYNC, text)
        self.assertTrue(ca.SETUP_SCRIPT.is_file(), "RESYNC names a script that is not there")
        self.assertNotIn("SETUP", text)

    def test_no_workspace_pin(self):
        text = self.report(">=3.11", None, None)
        self.assertIn("WARNING", text)
        self.assertIn(".python-version", text)

    def test_unreadable_specifier_is_left_to_the_reader(self):
        text = self.report(">=3.11; extra", None, "3.12")
        self.assertIn("could not check", text)

    def test_only_a_python_version_that_differs(self):
        text = self.report(None, "3.11", "3.12")
        self.assertIn("WARNING", text)
        self.assertIn("3.11", text)

    def test_only_a_python_version_that_matches(self):
        self.assertNotIn("WARNING", self.report(None, "3.12.4", "3.12"))

    def test_source_says_nothing(self):
        self.assertEqual(ca.python_report({"requires_python": None, "python_version": None}, "3.12"), [])


if __name__ == "__main__":
    unittest.main()
