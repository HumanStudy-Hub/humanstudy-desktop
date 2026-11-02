"""capabilities.json and refusals (issue #45): a study declares what it can do; tools refuse the rest.
   python -m unittest discover -s pack/runtime/tests"""
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_agent_package import REPO, make_project, mcp, quote  # noqa: E402

CAPS = REPO / "pack/skills/build/capabilities.py"
CORE = REPO / "pack/skills/export/agent/study_core.py"
SERVER = REPO / "pack/skills/export/agent/mcp_server.py"


def caps(root, *args):
    return subprocess.run([sys.executable, str(CAPS), str(root), *args], capture_output=True, text=True, encoding="utf-8")


def core(root, *args):
    return subprocess.run([sys.executable, str(CORE), "--root", str(root), *args], capture_output=True, text=True, encoding="utf-8")


class Capabilities(unittest.TestCase):
    def project(self, ready=True):
        root = make_project(ready)
        self.addCleanup(shutil.rmtree, root, True)
        return root

    def test_derived_from_files_and_checked(self):
        root = self.project()
        run = caps(root)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        c = json.loads((root / "capabilities.json").read_text(encoding="utf-8"))
        self.assertEqual(c["run"]["status"], "yes")
        self.assertEqual(c["humanData"]["status"], "no")
        self.assertEqual(c["authorCode"]["status"], "no")
        self.assertIsNone(c["reproduced"]["package"])
        self.assertEqual(caps(root, "--check").returncode, 0)

    def test_blocked_study_cannot_run_and_says_why(self):
        root = self.project(ready=False)
        caps(root)
        c = json.loads((root / "capabilities.json").read_text(encoding="utf-8"))
        self.assertEqual(c["run"]["status"], "no")
        self.assertIn("iss-x", c["run"]["reason"])
        refused = core(root, "plan", "--n", "1")
        self.assertEqual(refused.returncode, 3, refused.stderr)
        body = json.loads(refused.stdout)
        self.assertEqual(body["status"], "refused")
        self.assertEqual(body["capability"], "run")
        self.assertTrue(body["next_steps"])

    def test_excluded_arms_are_refused_and_a_full_run_is_partial(self):
        root = self.project()
        (root / "capabilities.json").write_text(json.dumps({"schemaVersion": 1, "run": {"excluded": [
            {"what": "help condition", "reason": "picture stimulus", "arms": ["condition-help"]}]}}))
        caps(root)
        c = json.loads((root / "capabilities.json").read_text(encoding="utf-8"))
        self.assertEqual(c["run"]["status"], "partial", "the build agent's exclusions are kept")
        refused = core(root, "plan", "--n", "1", "--arm", "condition-help")
        self.assertEqual(refused.returncode, 3)
        self.assertIn("picture stimulus", json.loads(refused.stdout)["reason"])
        self.assertEqual(core(root, "plan", "--n", "1", "--arm", "condition-harm").returncode, 0)
        full = core(root, "run", "--cli", "%s -c \"print('yes')\"" % quote(sys.executable), "--n", "1", "--out", str(root / "run.json"))
        self.assertEqual(full.returncode, 0, full.stderr)
        result = json.loads((root / "run.json").read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "partial", "a run that skips an excluded part is partial")
        self.assertEqual(result["notRun"][0]["reason"], "picture stimulus")

    def test_mcp_refusal_is_a_structured_tool_result(self):
        root = self.project(ready=False)
        server = root / "scripts/mcp_server.py"
        server.parent.mkdir()
        shutil.copy(SERVER, server)
        shutil.copy(CORE, server.parent / "study_core.py")
        caps(root)
        res = mcp(server, [("capabilities", {}), ("plan_participants", {"n": 1})])
        self.assertEqual(json.loads(res[2]["result"]["content"][0]["text"])["run"]["status"], "no")
        out = res[3]["result"]
        self.assertTrue(out["isError"])
        self.assertEqual(json.loads(out["content"][0]["text"])["status"], "refused")

    def test_check_rejects_bad_failure_cases(self):
        root = self.project()
        caps(root)
        (root / "artifacts").mkdir()
        (root / "artifacts/failures.json").write_text(json.dumps([{"pattern": "made-up", "where": "x"}]))
        bad = caps(root, "--check")
        self.assertEqual(bad.returncode, 1)
        self.assertIn("pattern must be one of", bad.stdout)


if __name__ == "__main__":
    unittest.main()
