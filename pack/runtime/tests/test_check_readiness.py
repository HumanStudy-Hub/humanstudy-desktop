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
CHECKS = ["program", "sources", "package", "validity", "verbatim", "results", "effects", "materials"]

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

    def test_package_code_cannot_swap_a_checker_before_it_is_loaded(self):
        """Where sandbox_run does not confine files (Windows, Linux), package code that runs in the smoke test
        could overwrite a checker that is imported later; every checker is loaded before any package code."""
        build = Path(tempfile.mkdtemp(prefix="readiness-checker-"))
        self.addCleanup(shutil.rmtree, build, True)
        shutil.copytree(REPO / "pack/skills", build / "skills")
        shutil.copytree(REPO / "pack/schema", build / "schema")
        # Rewrite every checker file: a module imported later would switch the whole report off.
        patch = "\nimport sys as _s\n_m = _s.modules.get('__main__')\nif _m is not None and hasattr(_m, 'summary'):\n    _m.summary = lambda msgs: None\n"
        adapter = ("import glob\nfor _f in glob.glob(%r) + glob.glob(%r):\n    try:\n        open(_f, 'a').write(%r)\n"
                   "    except OSError:\n        pass\n" % (str(build / "skills/build/*.py"), str(build / "skills/export/agent/*.py"),
                                                       patch)) + ADAPTER
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
        root = self.project(program=p, adapter=adapter,
                            extra={"sources/materials.txt": "Participants read the following text. "
                                   "How sure are you that the coin landed heads?"})
        report, problems = readiness(root, checker=build / "skills/build/check_readiness.py")
        self.assertIn("verbatim", problems, report)

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


# A declared arm that crashes when run on its own (check_validity.py `arms` rule)
CRASHING_ARM = ADAPTER.replace("    out = []\n", "    out = []\n    if arms == ['b']:\n        {}['missing']\n") + "ARMS = ['a', 'b']\n"
SEARCHES = [{"where": "OSF", "query": "Analysis folder", "url": "https://osf.io/x/", "date": "2026-11-01",
             "result": "analysis scripts listed; not downloaded (not needed)"}]


def newer_rule_project(make):
    """Only findings of the rules added with the shared reply reader: a crashing declared arm (validity), an
    impossible p value (results), analysis code listed but not downloaded (check_source_use.py, package)."""
    p = json.loads(json.dumps(PROGRAM))
    for n in p["nodes"]:
        if n["kind"] == "procedure":
            n["fields"].append({"id": "not-told", "label": "What participants were not told", "origin": "reported",
                                "state": "confirmed", "value": [], "evidenceIds": ["e1"]})
    result = next(n for n in p["nodes"] if n["kind"] == "result")
    result["fields"].append({"id": "test", "label": "Test", "origin": "reported", "state": "confirmed",
                             "value": {"t": 2.1, "p": 1.3}, "evidenceIds": ["e1"]})
    root = make(program=p, adapter=CRASHING_ARM)
    record = json.loads((root / "sources/SOURCE.json").read_text(encoding="utf-8"))
    record["searches"] = SEARCHES
    (root / "sources/SOURCE.json").write_text(json.dumps(record), encoding="utf-8")
    return root


@unittest.skipUnless(has_jsonschema(), "needs jsonschema (the research runtime has it)")
class OlderBuildWarnings(unittest.TestCase):
    """A package built before the shared reply reader (no task/replies.py) keeps its ready status: the newer
    rules are warnings. The same findings on a current-contract package are problems."""

    def setUp(self):
        self.roots = []

    def tearDown(self):
        for root in self.roots:
            shutil.rmtree(root.parent, ignore_errors=True)

    def project(self, **kw):
        root = make_project(**kw)
        self.roots.append(root)
        return root

    def test_an_older_build_with_only_newer_rule_findings_is_ready_with_warnings(self):
        report, problems = readiness(newer_rule_project(self.project))
        self.assertEqual(problems, {}, report)
        self.assertEqual(report["checks"], {name: "pass" for name in CHECKS})
        warned = {w["check"]: w["reason"] for w in report["warnings"]}
        self.assertIn("raised KeyError", warned.get("validity", ""), report)
        self.assertIn("not a probability", warned.get("results", ""), report)
        self.assertIn("no analysis file is under sources/", warned.get("package", ""), report)
        self.assertTrue(all("\n" not in w["reason"] and len(w["reason"]) <= 320 for w in report["warnings"]))

    def test_the_same_findings_block_a_current_contract_package(self):
        root = newer_rule_project(self.project)
        shutil.copy2(BUILD / "package_files/replies.py", root / "package/fixture/task/replies.py")
        report, problems = readiness(root)
        for check in ("validity", "results", "package"):
            self.assertIn(check, problems, report)
        self.assertIn("sources used", problems["package"])
        # a contract 2 package: only the note that the rules added with contract 3 are warnings
        self.assertEqual([w["check"] for w in report["warnings"]], ["contract"])
        self.assertIn("build contract below 3", report["warnings"][0]["reason"])

    def test_a_ready_older_package_carries_only_the_contract_warning(self):
        report, problems = readiness(self.project())
        self.assertEqual(problems, {})
        self.assertEqual(report["warnings"], [{"check": "contract", "reason": "older build: newer build rules are "
                                               "warnings; rebuild with the current build skill to make them blocking"}])

    def test_a_contract_3_package_has_no_contract_warning(self):
        root = newer_rule_project(self.project)
        shutil.copy2(BUILD / "package_files/replies.py", root / "package/fixture/task/replies.py")
        study = root / "package/fixture/study.json"
        study.write_text(json.dumps(dict(json.loads(study.read_text(encoding="utf-8")), buildContract=3)),
                         encoding="utf-8")
        report, problems = readiness(root)
        for check in ("validity", "results", "package"):
            self.assertIn(check, problems, report)
        self.assertNotIn("contract", [w["check"] for w in report["warnings"]])

    def test_leaving_replies_out_does_not_dodge_the_newer_rules(self):
        root = newer_rule_project(self.project)
        study = root / "package/fixture/study.json"
        study.write_text(json.dumps(dict(json.loads(study.read_text(encoding="utf-8")), buildContract=2)),
                         encoding="utf-8")
        report, problems = readiness(root)
        for check in ("validity", "results", "package"):
            self.assertIn(check, problems, report)
        self.assertNotIn("older build: newer build rules are warnings; rebuild with the current build skill to make "
                         "them blocking", [w["reason"] for w in report["warnings"]])


class ContractSigns(unittest.TestCase):
    """contract.py: a package counts as current when its project shows the current build skill's work, even
    without task/replies.py."""

    def setUp(self):
        sys.path.insert(0, str(BUILD))
        self.addCleanup(sys.path.remove, str(BUILD))
        import contract
        self.contract = contract
        self.root = Path(tempfile.mkdtemp(prefix="contract-test-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.pkg = self.root / "package/slug"
        (self.pkg / "materials").mkdir(parents=True)
        (self.root / "sources").mkdir()
        (self.pkg / "study.json").write_text('{"title": "x"}', encoding="utf-8")
        (self.root / "program.json").write_text('{"schemaVersion": 2}', encoding="utf-8")
        (self.pkg / "materials/materials.json").write_text("{}", encoding="utf-8")
        self.source({"files": [{"path": "paper.pdf", "sha256": "ab"}], "searches": []})

    def source(self, record):
        (self.root / "sources/SOURCE.json").write_text(json.dumps(record), encoding="utf-8")

    def test_the_rules_of_contract_3_block_only_from_build_contract_3(self):
        for marked, level, strict in (('{"buildContract": 3}', 3, True), ('{"buildContract": 4}', 4, True),
                                      ('{"buildContract": 2}', 2, False), ('{"buildContract": "3"}', 0, False),
                                      ('{"buildContract": true}', 0, False), ("{bad", 0, False), ("{}", 0, False)):
            (self.pkg / "study.json").write_text(marked, encoding="utf-8")
            self.assertEqual(self.contract.build_contract(self.pkg), level, marked)
            self.assertEqual(self.contract.strict(self.pkg), strict, marked)
            self.assertEqual(self.contract.project_strict(self.root), strict, marked)
            self.assertEqual(self.contract.rules_level(self.root, self.pkg), strict, marked)
        self.assertFalse(self.contract.strict(None))

    def test_an_older_project_is_not_current(self):
        self.assertFalse(self.contract.current_contract(self.pkg))
        self.assertEqual(self.contract.new_build_signs(self.pkg), [])
        for marked in ('{"buildContract": 1}', '{"buildContract": true}', '{"buildContract": "2"}', "[]", "{bad"):
            (self.pkg / "study.json").write_text(marked, encoding="utf-8")
            self.assertFalse(self.contract.current_contract(self.pkg), marked)

    def test_only_the_build_stamp_makes_it_current(self):
        (self.pkg / "study.json").write_text('{"buildContract": 2}', encoding="utf-8")
        self.assertTrue(self.contract.current_contract(self.pkg))
        (self.pkg / "study.json").write_text("{}", encoding="utf-8")
        # records an older build's warnings ask for never flip it: clearing one warning keeps the others warnings
        for key in ("licenceLookups", "paperTables", "signChecks", "analysisCode", "surveyVersions",
                    "questionsChecked", "decisionsFromSources", "abstractResults", "resultsNotRecorded"):
            self.source({"files": [], key: [{"x": 1}]})
            self.assertFalse(self.contract.current_contract(self.pkg), key)
        self.source({"files": [{"path": "sources/open/a.qsf", "retrieved": "2026-11-04", "finalUrl": "https://x"}]})
        self.assertFalse(self.contract.current_contract(self.pkg))
        (self.root / "program.json").write_text('{"items": [{"qsfReachability": "not-shown"}]}', encoding="utf-8")
        self.assertFalse(self.contract.current_contract(self.pkg))


class ResultsByPackage(unittest.TestCase):
    """check_results.check(..., package=): the slug's own package decides, not any package of the project."""

    def test_the_checked_package_decides(self):
        sys.path.insert(0, str(BUILD))
        self.addCleanup(sys.path.remove, str(BUILD))
        import check_results
        p = json.loads(json.dumps(PROGRAM))
        result = next(n for n in p["nodes"] if n["kind"] == "result")
        result["fields"].append({"id": "test", "label": "Test", "origin": "reported", "state": "confirmed",
                                 "value": {"t": 2.1, "p": 1.3}, "evidenceIds": ["e1"]})
        root = make_project(program=p, extra={"package/newer/study.json": '{"buildContract": 2}'})
        self.addCleanup(shutil.rmtree, root.parent, True)
        older = check_results.check(root / "program.json", package=root / "package/fixture")
        newer = check_results.check(root / "program.json", package=root / "package/newer")
        cli = check_results.check(root / "program.json")
        self.assertTrue(any("not a probability" in m for m, _ in older["warnings"]), older)
        self.assertFalse(any("not a probability" in m for m, _ in older["problems"]), older)
        self.assertTrue(any("not a probability" in m for m, _ in newer["problems"]), newer)
        self.assertTrue(any("not a probability" in m for m, _ in cli["problems"]), cli)


class WarningList(unittest.TestCase):
    def test_truncated_warnings_say_how_many_more(self):
        sys.path.insert(0, str(BUILD))
        self.addCleanup(sys.path.remove, str(BUILD))
        import check_readiness
        listed = check_readiness.listed_warnings("results", [("w%d" % i, "fix") for i in range(25)])
        self.assertEqual(len(listed), check_readiness.WARNINGS_MAX + 1)
        self.assertEqual(listed[-1], {"check": "results", "reason": "and 5 more"})
        self.assertEqual(len(check_readiness.listed_warnings("results", ["a", "b"])), 2)


class CheckPackageGate(unittest.TestCase):
    """check_package.py: downloaded-source, source-use and survey findings fail a current-contract package and
    print `warn` lines (and PASS) for an older one."""

    def setUp(self):
        sys.path.insert(0, str(BUILD))
        self.addCleanup(sys.path.remove, str(BUILD))
        import check_package
        import contract
        import fetch_source
        import qsf_flow
        self.mods = (check_package, contract, fetch_source, qsf_flow)
        self.root = make_project()
        self.addCleanup(shutil.rmtree, self.root.parent, True)

    def run_package(self, current, fetched=(), survey=(), strict=False, validity=None, extra_args=()):
        import contextlib
        import io
        from unittest import mock
        import check_validity
        check_package, contract, fetch_source, qsf_flow = self.mods
        out = io.StringIO()
        report = validity or {"problems": [], "warnings": [], "notes": [], "method": None, "analysis": None}
        with mock.patch.object(contract, "current_contract", lambda p: current), \
                mock.patch.object(contract, "strict", lambda p: strict), \
                mock.patch.object(check_validity, "check", lambda *a, **k: report), \
                mock.patch.object(fetch_source, "problems", lambda *a, **k: list(fetched)), \
                mock.patch.object(qsf_flow, "findings", lambda *a, **k: (list(survey), [])), \
                mock.patch.object(check_package, "reply_checks", lambda p: ([], "ok   replies (not under test)")), \
                mock.patch.object(sys, "argv", ["check_package.py", str(self.root / "package/fixture")]
                                  + list(extra_args)), \
                contextlib.redirect_stdout(out):
            try:
                check_package.main()
                code = 0
            except SystemExit as exc:
                code = exc.code
        return code, out.getvalue()

    def test_fetched_source_findings(self):
        bad = [("sources/SOURCE.json: sources/open/x.csv has no licence", "record it")]
        code, out = self.run_package(False, fetched=bad)
        self.assertEqual(code, 0, out)
        self.assertIn("warn  sources/SOURCE.json: sources/open/x.csv has no licence  [fix: record it]", out)
        self.assertIn("PASS package checks", out)
        code, out = self.run_package(True, fetched=bad)
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL sources used:", out)

    def test_survey_findings(self):
        bad = [("survey text participants never saw: QID9 of x.qsf", "remove it")]
        code, out = self.run_package(False, survey=bad)
        self.assertEqual(code, 0, out)
        self.assertIn("warn  survey text participants never saw", out)
        self.assertIn("PASS package checks", out)
        code, out = self.run_package(True, survey=bad)
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL survey files (qsf_flow.py):", out)

    def test_compiled_python_warns_below_contract_3_and_fails_from_it(self):
        cache = self.root / "package/fixture/task/__pycache__"
        cache.mkdir(parents=True)
        (cache / "replies.cpython-312.pyc").write_bytes(b"x")
        code, out = self.run_package(True, strict=False)
        self.assertEqual(code, 0, out)
        self.assertIn("warn  compiled Python in the package: task/__pycache__ (older build: blocking from "
                      "buildContract 3)", out)
        code, out = self.run_package(True, strict=True)
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL compiled Python in the package: task/__pycache__", out)

    def test_a_validity_failure_does_not_hide_the_later_checks(self):
        validity = {"problems": [("a prompt tells participants the hypothesis", "remove it")], "warnings": [],
                    "notes": [], "method": None, "analysis": None}
        survey = [("survey text participants never saw: QID9 of x.qsf", "remove it")]
        code, out = self.run_package(True, survey=survey, validity=validity)
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL package validity (check_validity.py):", out)
        self.assertIn("FAIL survey files (qsf_flow.py):", out)
        self.assertIn("ok   Word sources", out)
        self.assertIn("FAIL 2 check(s) failed", out)
        # check_readiness.py runs check_validity.py itself: check_package skips it, the rest still runs
        code, out = self.run_package(True, survey=survey, validity=validity, extra_args=["--no-validity"])
        self.assertEqual(code, 1, out)
        self.assertNotIn("package validity (check_validity.py)", out)
        self.assertIn("note package validity skipped", out)
        self.assertIn("FAIL survey files (qsf_flow.py):", out)

    def test_readiness_reads_every_failure_of_check_package(self):
        import check_readiness
        from types import SimpleNamespace
        out = ("ok   required files present\nFAIL package validity (check_validity.py):\n  x\n"
               "FAIL survey files (qsf_flow.py):\n  QID9 never shown  [fix: remove it]\n"
               "FAIL reading replies (check_replies.py, recorded_answers.py):\n  smoke test: arm a crashed  [fix: f]\n"
               "FAIL 3 check(s) failed\n")
        found = check_readiness.package_failure(SimpleNamespace(returncode=1, stdout=out, stderr=""))
        self.assertEqual(found, ["survey files (qsf_flow.py): QID9 never shown",
                                 "reading replies (check_replies.py, recorded_answers.py): smoke test: arm a crashed"])
        only_validity = "FAIL package validity (check_validity.py):\n  x\nFAIL 1 check(s) failed\n"
        self.assertEqual(check_readiness.package_failure(SimpleNamespace(returncode=1, stdout=only_validity,
                                                                         stderr="")), [])

    def test_a_word_or_design_check_that_raises_is_one_finding_not_a_traceback(self):
        from unittest import mock
        import docx_text

        def boom(*a, **k):
            raise NotImplementedError("That compression method is not supported")
        with mock.patch.object(docx_text, "problems", boom):
            code, out = self.run_package(False)
            self.assertEqual(code, 0, out)
            self.assertIn("warn  docx_text.py could not finish (NotImplementedError: That compression method", out)
            self.assertIn("PASS package checks", out)
            code, out = self.run_package(True)
            self.assertEqual(code, 1, out)
            self.assertIn("docx_text.py could not finish", out)
            self.assertNotIn("Traceback", out)


if __name__ == "__main__":
    unittest.main()


class Timeouts(unittest.TestCase):
    """check_package.py runs its confined steps one after another; the readiness and app limits outlast them."""

    def test_package_timeout_covers_every_confined_step_and_the_app_waits_longer(self):
        import re
        sys.path.insert(0, str(BUILD))
        try:
            import check_readiness
            import check_replies
            import check_validity
            import recorded_answers
        finally:
            sys.path.remove(str(BUILD))
        # check_package.py --no-validity: smoke, replies, answers (check_validity runs once, as the validity check)
        steps = 120 + check_replies.SMOKE_TIMEOUT + recorded_answers.CHECK_TIMEOUT
        self.assertGreater(check_readiness.PACKAGE_TIMEOUT, steps)
        self.assertGreaterEqual(check_readiness.PACKAGE_TIMEOUT, 700)
        self.assertIn('"--no-validity"', (BUILD / "check_readiness.py").read_text(encoding="utf-8"))
        source = (REPO / "app/src/main/scientific-readiness.ts").read_text(encoding="utf-8")
        minutes = int(re.search(r"SCIENTIFIC_TIMEOUT_MS = (\d+) \* 60_000", source).group(1))
        # check_package, then check_validity's capture (300 s) and analysis run, and the effects field check (300 s)
        self.assertGreater(minutes * 60, check_readiness.PACKAGE_TIMEOUT + 300 + check_validity.PROBE_TIMEOUT + 300)
