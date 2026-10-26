"""The standalone humanstudy skill is generated from the pack and works without the app.
   python -m unittest discover -s scripts/tests -p 'test_*.py'"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GEN = REPO / "scripts/build_standalone_skill.py"


class StandaloneSkill(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hs-standalone-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        run = subprocess.run([sys.executable, str(GEN), "--out", str(self.tmp / "humanstudy"), "--zip"],
                             capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.hs = self.tmp / "humanstudy"

    def run_py(self, *args, cwd):
        return subprocess.run([sys.executable, *map(str, args)], capture_output=True, text=True,
                              encoding="utf-8", cwd=str(cwd), timeout=300)

    def test_skill_is_complete_and_free_of_app_paths(self):
        text = (self.hs / "SKILL.md").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\nname: humanstudy\ndescription: "))
        build = (self.hs / "references/build.md").read_text(encoding="utf-8")
        self.assertIn("$HS/scripts/build/check_program.py", build)
        self.assertNotIn("## 4. Views", build)
        self.assertIn("Every human participant in the original is an agent participant",
                      (self.hs / "references/rules.md").read_text(encoding="utf-8"))
        self.assertTrue((self.tmp / "humanstudy.zip").is_file())

    def test_checks_and_export_run_from_the_skill_in_a_plain_project(self):
        project = self.tmp / "project"
        project.mkdir()
        shutil.copy(REPO / "app/src/shared/sample-program.json", project / "program.json")
        check = self.run_py(self.hs / "scripts/build/check_program.py", "program.json", cwd=project)
        self.assertIn("PASS", check.stdout + check.stderr)
        export = self.run_py(self.hs / "scripts/export/agent_package.py", "--output", "exports/agent", cwd=project)
        self.assertEqual(export.returncode, 0, export.stdout + export.stderr)
        overview = self.run_py(self.hs / "scripts/export/agent/study_core.py", "--root", ".", "overview", cwd=project)
        self.assertEqual(json.loads(overview.stdout)["id"], "study-5")


if __name__ == "__main__":
    unittest.main()
