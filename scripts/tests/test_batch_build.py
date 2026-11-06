"""Batch builds: spending caps and results kept per run (scripts/batch_build.py). No agent is started.
   python -m unittest discover -s scripts/tests -p 'test_*.py'"""
import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import batch_build  # noqa: E402


class Caps(unittest.TestCase):
    def test_claude_gets_the_per_paper_cap(self):
        cmd = batch_build.agent_command("claude", "sonnet", 7.5)
        self.assertEqual(cmd[cmd.index("--max-budget-usd") + 1], "7.5")
        self.assertNotIn("--max-budget-usd", batch_build.agent_command("claude", "sonnet"))

    def test_total_cap_counts_running_papers_at_their_cap(self):
        b = batch_build.Budget(total=20, per_paper=8)
        self.assertTrue(b.reserve())
        self.assertTrue(b.reserve())        # 16 reserved
        self.assertFalse(b.reserve())       # 24 > 20
        b.settle(3.0)                        # one finished at $3: 3 spent + 8 reserved
        self.assertTrue(b.reserve())        # 3 + 8 + 8 = 19
        b.settle(None)                       # no cost reported: counted at its cap
        b.settle(1.0)
        self.assertEqual((b.spent, b.reserved), (12.0, 0.0))
        self.assertTrue(b.reserve())        # 12 + 8 = 20
        self.assertFalse(b.reserve())

    def test_no_total_never_skips(self):
        b = batch_build.Budget()
        self.assertTrue(all(b.reserve() for _ in range(50)))

    def test_total_without_per_paper_cap_is_refused(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            batch_build.main(["--pdfs", ".", "--work", ".", "--total-budget-usd", "10"])


class Results(unittest.TestCase):
    def setUp(self):
        self.work = Path(tempfile.mkdtemp(prefix="hs-batch-"))
        self.addCleanup(shutil.rmtree, self.work, True)

    def test_each_run_is_kept_and_merged(self):
        meta = {"agent": "claude", "model": "sonnet"}
        batch_build.write_results(self.work, [{"project": "a", "costUsd": 2.0, "programComplete": False},
                                              {"project": "b", "costUsd": 1.0, "programComplete": True}],
                                  meta, "20261106T100000Z")
        batch_build.write_results(self.work, [{"project": "a", "costUsd": 3.0, "programComplete": True},
                                              {"project": "b", "skipped": "already built"},
                                              {"project": "c", "skipped": "budget"}], meta, "20261106T120000Z")
        first = json.loads((self.work / "results-20261106T100000Z.json").read_text())
        self.assertEqual([r["costUsd"] for r in first["rows"]], [2.0, 1.0])
        self.assertTrue((self.work / "results-20261106T120000Z.csv").is_file())
        merged = json.loads((self.work / "results.json").read_text())
        rows = {r["project"]: r for r in merged["rows"]}
        self.assertEqual(rows["a"]["costUsd"], 3.0)                    # the newest build replaces
        self.assertEqual(rows["b"]["costUsd"], 1.0)                    # a skip keeps the earlier row
        self.assertEqual(rows["c"]["skipped"], "budget")
        self.assertEqual(merged["runs"], ["20261106T100000Z", "20261106T120000Z"])
        self.assertIn("project", (self.work / "results.csv").read_text().splitlines()[0])


if __name__ == "__main__":
    unittest.main()
