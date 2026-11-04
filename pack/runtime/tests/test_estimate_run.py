"""estimate_run.py: the run size of a package at the paper's N, from the prompts check_validity.py captures.
   python -m unittest discover -s pack/runtime/tests"""
import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "pack/skills/build"))
import estimate_run  # noqa: E402

ADAPTER = '''
ARMS = ["a", "b"]


def run_sessions(llm, seed, n, arms=None):
    out = []
    for arm in (arms or ARMS):
        for i in range(n):
            for t in range(4 if arm == "a" else 2):
                llm("Screen %d. " % t + "x" * 396)
            out.append({"arm": arm, "condition": arm})
    return out
'''


class EstimateRun(unittest.TestCase):
    def package(self, text=ADAPTER, task=None):
        root = Path(tempfile.mkdtemp(prefix="estimate-run-"))
        self.addCleanup(shutil.rmtree, root, True)
        pkg = root / "package/x"
        (pkg / "task").mkdir(parents=True)
        (pkg / "task/adapter.py").write_text(text, encoding="utf-8")
        (pkg / "task/task.json").write_text(json.dumps(task or {"conditions": ["a", "b"]}), encoding="utf-8")
        return pkg

    def run_main(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = estimate_run.main(list(args))
        return code, out.getvalue()

    def test_scales_the_stand_in_run_per_arm_to_n(self):
        code, text = self.run_main(str(self.package()), "--n", "100")
        self.assertEqual(code, 0, text)
        e = json.loads(text[text.index("{"):text.rindex("}") + 1])
        self.assertEqual(e["callsPerSession"], 3.0)          # (4 + 2) / 2 arms
        self.assertEqual(e["modelCalls"], 300)
        self.assertEqual(e["inputTokens"], 300 * 406 // 4)     # 406 characters per prompt, characters / 4
        self.assertEqual(e["outputTokens"], 300 * estimate_run.OUTPUT_TOKENS_PER_CALL)
        self.assertAlmostEqual(e["costUsd"], round(30450 / 1e6 * 1 + 45000 / 1e6 * 5, 2))
        self.assertFalse(e["relay"]["fits"])                  # 300 calls x 4,096 reserved output tokens
        self.assertIn("Run size: 100 participants, about 300 model calls (3.0 per session)", text)
        self.assertIn("does not fit one run of the hosted model relay", text)

    def test_a_small_run_fits_and_an_output_limit_counts(self):
        code, text = self.run_main(str(self.package()), "--n", "4", "--max-tokens", "200",
                                   "--price-in", "3", "--price-out", "15")
        self.assertEqual(code, 0, text)
        self.assertIn("fits one run of the hosted model relay", text)
        self.assertIn("at $3 / $15 per million", text)

    def test_relay_reservation_and_pairs(self):
        capture = {"runs": [{"arms": ["a"], "calls": 10, "sessions": 1, "n": 1, "lengths": [100] * 10,
                             "bodyChars": 1000}]}
        e = estimate_run.estimate(capture, 10, agents=2)
        per_call = estimate_run.BODY_FRAME + estimate_run.RELAY_PER_MESSAGE + estimate_run.RELAY_DEFAULT_MAX_TOKENS
        self.assertEqual(e["relay"]["reservedTokens"], 10 * (1000 + 10 * per_call))
        self.assertEqual(e["relay"]["sessionsPerRun"], estimate_run.RELAY_TOKEN_CAP // (1000 + 10 * per_call))
        self.assertIn("20 participants in 10 sessions", estimate_run.run_size_line(e))
        self.assertIsNone(estimate_run.estimate({"runs": [{"arms": ["a"], "calls": 0}]}, 10))

    def test_cell_sizes_per_condition_and_paper_n(self):
        pkg = self.package(task={"conditions": [{"id": "a", "paper_n": 30}, {"id": "b", "paper_n": 10}]})
        self.assertEqual(estimate_run.total_sessions(pkg, "paper"), {"a": 30, "b": 10})
        self.assertEqual(estimate_run.total_sessions(pkg, "a=30, b=10"), {"a": 30, "b": 10})
        self.assertEqual(estimate_run.total_sessions(pkg, "40"), 40)
        for bad in ("a=x", "=3", "many"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                estimate_run.total_sessions(pkg, bad)
        with self.assertRaises(ValueError):   # paper_n missing on a condition
            estimate_run.total_sessions(self.package(task={"conditions": [{"id": "a", "paper_n": 3}, {"id": "b"}]}),
                                        "paper")
        code, text = self.run_main(str(pkg), "--n", "paper")
        self.assertEqual(code, 0, text)
        e = json.loads(text[text.index("{"):text.rindex("}") + 1])
        self.assertEqual((e["sessions"], e["modelCalls"]), (40, 30 * 4 + 10 * 2))   # each arm by its own n
        self.assertEqual(e["cellSizes"], {"a": 30, "b": 10})
        code, text = self.run_main(str(pkg), "--n", "a=3,zz")
        self.assertEqual(code, 1)
        self.assertIn("PROBLEM --n is a number", text)

    def test_no_calls_is_reported(self):
        code, text = self.run_main(str(self.package("def run_sessions(llm, seed, n, arms=None):\n    return []\n")),
                                   "--n", "10")
        self.assertEqual(code, 1)
        self.assertIn("produced no model calls", text)


if __name__ == "__main__":
    unittest.main()
