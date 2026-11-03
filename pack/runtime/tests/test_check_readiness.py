"""check_readiness.py: the app's readiness gate runs every build check the skill requires.
   python -m unittest discover -s pack/runtime/tests"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
BUILD = REPO / "pack/skills/build"
READINESS = BUILD / "check_readiness.py"
PROGRAM = json.loads((REPO / "app/src/main/fixtures/complete-program.json").read_text(encoding="utf-8"))
CHECKS = ["program", "sources", "package", "validity", "verbatim", "results", "effects"]

ADAPTER = '''import sys
def build_prompt(study, condition):
    return "How sure are you? Answer 1-7."
def run_sessions(llm, seed, n, arms=None):
    out = []
    for arm in arms or ["a", "b"]:
        for i in range(n):
            reply = llm(build_prompt("s1", arm))
            out.append({"arm": arm, "participant": i, "reply": reply})
    return out
if __name__ == "__main__" and "--smoke-test" in sys.argv:
    print("ok")
'''


def has_jsonschema():
    try:
        import jsonschema  # noqa: F401
        return True
    except ImportError:
        return False


def make_project(program=None, adapter=ADAPTER, effects=True, extra=None):
    """A small project that passes every build check: the shared complete-program fixture, a stand-in paper,
    sources/SOURCE.json written by sources.py, a slim package and an effects.json with nothing to test."""
    p = json.loads(json.dumps(program or PROGRAM))
    if program is None:
        for n in p["nodes"]:
            if n["kind"] == "procedure":
                n["fields"].append({"id": "not-told", "label": "What participants were not told", "origin": "reported",
                                    "state": "confirmed", "value": [], "evidenceIds": ["e1"]})
    root = Path(tempfile.mkdtemp(prefix="readiness-test-")) / "study"
    files = {
        "program.json": json.dumps(p), "paper.pdf": "%PDF-1.4 stand-in",
        "package/fixture/study.json": json.dumps({"title": "Fixture", "programRef": {"path": "../../program.json", "id": p["id"]}}),
        "package/fixture/source/paper_metadata.json": "{}",
        "package/fixture/materials/materials.json": "{}",
        "package/fixture/task/task.json": json.dumps({"arms": ["a", "b"], "programBindings": {
            "programId": p["id"], "stepIds": [s["id"] for s in p["steps"]],
            "recordNodeIds": [n["id"] for n in p["nodes"] if n["kind"] in ("record", "variable")],
            "analysisNodeIds": [n["id"] for n in p["nodes"] if n["kind"] == "analysis"]}}),
        "package/fixture/task/adapter.py": adapter,
        "package/fixture/evaluation/evaluation.py": "def evaluate(sessions):\n    return {'n': len(sessions)}\n",
    }
    if effects:
        files["effects.json"] = json.dumps({"schemaVersion": 2, "programId": p["id"], "topics": ["test"],
                                            "hypotheses": [], "effects": []})
    files.update(extra or {})
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding="utf-8")
    subprocess.run([sys.executable, str(BUILD / "sources.py"), str(root)], check=True, capture_output=True)
    return root


def readiness(root, slug="fixture", checker=READINESS):
    run = subprocess.run([sys.executable, "-I", "-B", str(checker), str(root), slug], capture_output=True,
                         text=True, timeout=600)
    assert run.returncode == 0, run.stderr
    report = json.loads(run.stdout)
    return report, {p["check"]: p["reason"] for p in report["problems"]}


@unittest.skipUnless(has_jsonschema(), "needs jsonschema (the research runtime has it)")
class ReadinessTest(unittest.TestCase):
    def setUp(self):
        self.roots = []

    def tearDown(self):
        for root in self.roots:
            shutil.rmtree(root.parent, ignore_errors=True)

    def project(self, **kw):
        root = make_project(**kw)
        self.roots.append(root)
        return root

    def test_a_package_passing_every_check_is_ready(self):
        report, problems = readiness(self.project())
        self.assertEqual(problems, {})
        self.assertEqual(report["checks"], {name: "pass" for name in CHECKS})

    def test_each_required_check_blocks_with_a_one_line_reason(self):
        cases = {}
        # check_validity.py: no `not-told` field recorded
        cases["validity"] = self.project(program=PROGRAM)
        # sources.py --check: the paper changed after SOURCE.json recorded it
        root = self.project()
        (root / "paper.pdf").write_text("%PDF-1.4 another paper", encoding="utf-8")
        cases["sources"] = root
        # effects.py: no effects.json
        cases["effects"] = self.project(effects=False)
        # check_package.py: the smoke test fails
        cases["package"] = self.project(adapter=ADAPTER.replace('print("ok")', 'raise SystemExit(3)'))
        for check, root in cases.items():
            report, problems = readiness(root)
            self.assertIn(check, problems, report)
            self.assertEqual(report["checks"][check], "fail")
            self.assertNotIn("\n", problems[check])
            self.assertLessEqual(len(problems[check]), 320)
        # check_package.py also stops on SOURCE.json; that rule is reported once, under sources
        self.assertNotIn("package", readiness(cases["sources"])[1])

    def test_verbatim_and_results_block(self):
        p = json.loads(json.dumps(PROGRAM))
        for n in p["nodes"]:
            if n["kind"] == "procedure":
                n["fields"].append({"id": "not-told", "label": "What participants were not told", "origin": "reported",
                                    "state": "confirmed", "value": [], "evidenceIds": ["e1"]})
        p["evidence"].append({"id": "e2", "path": "sources/materials.txt", "locator": {"page": 1},
                              "quote": "Participants read the following text."})
        p["nodes"].append({"id": "m1", "kind": "material", "title": "Vignette", "studyIds": ["s1"], "evidenceIds": ["e2"],
                           "fields": [{"id": "text", "label": "Text", "origin": "verbatim", "state": "confirmed",
                                       "value": "Participants were paid ten dollars for an hour of their time.",
                                       "evidenceIds": ["e2"]}]})
        root = self.project(program=p, extra={"sources/materials.txt": "Participants read the following text. "
                                              "How sure are you that the coin landed heads?"})
        report, problems = readiness(root)
        self.assertIn("verbatim", problems, report)

        p = json.loads(json.dumps(PROGRAM))
        for n in p["nodes"]:
            if n["kind"] == "procedure":
                n["fields"].append({"id": "not-told", "label": "What participants were not told", "origin": "reported",
                                    "state": "confirmed", "value": [], "evidenceIds": ["e1"]})
        p["evidence"].append({"id": "e3", "path": "paper.pdf", "locator": {"page": 1},
                              "quote": "Ratings were higher in the harm condition, M = 4.21, SD = 1.37, t(38) = 2.51, p = .016."})
        result = next(n for n in p["nodes"] if n["kind"] == "result")
        result["evidenceIds"] = result.get("evidenceIds", []) + ["e3"]
        report, problems = readiness(self.project(program=p))
        self.assertIn("results", problems, report)

    def test_the_projects_own_checker_copies_do_not_decide(self):
        root = self.project(program=PROGRAM)  # fails check_validity.py
        hostile = root / ".opencode/skills/build"
        hostile.mkdir(parents=True)
        for name in ("check_validity.py", "check_program.py", "sources.py", "effects.py"):
            (hostile / name).write_text("def check(*a, **k):\n    return {'problems': []}\n"
                                        "def problems(*a):\n    return []\n", encoding="utf-8")
        (root / "schema").mkdir()
        (root / "schema/human-program.schema.json").write_text("{}", encoding="utf-8")
        _, problems = readiness(root)
        self.assertIn("validity", problems)

    def test_package_code_runs_only_confined(self):
        """Every import of the adapter happens in a sandbox_run child (HUMANSTUDY_SANDBOX=1), never in the
        checker's own process."""
        log = Path(tempfile.mkdtemp(prefix="readiness-log-")) / "unconfined.txt"
        self.addCleanup(shutil.rmtree, log.parent, True)
        adapter = ("import os\nif os.environ.get('HUMANSTUDY_SANDBOX') != '1':\n"
                   "    open(%r, 'a').write('imported outside sandbox_run\\n')\n" % str(log)) + ADAPTER
        report, problems = readiness(self.project(adapter=adapter))
        self.assertFalse(log.exists(), "package code ran outside sandbox_run.py")
        self.assertEqual(problems, {}, report)

    def test_a_check_that_crashes_blocks(self):
        root = self.project()
        (root / "effects.json").write_text("{not json", encoding="utf-8")
        report, problems = readiness(root)
        self.assertIn("effects", problems, report)

    def test_usage_and_missing_package(self):
        root = self.project()
        report, problems = readiness(root, slug="absent")
        self.assertIn("package", problems)
        for bad in ("../x", ".", ""):
            run = subprocess.run([sys.executable, str(READINESS), str(root), bad], capture_output=True, text=True)
            self.assertEqual(run.returncode, 1)


if __name__ == "__main__":
    unittest.main()
