"""The package and readiness checks never crash on a malformed sources/SOURCE.json, program.json or task.json:
fetch_source.problems, check_source_use.problems, qsf_flow.problems, check_replies.problems and check_results.check
are fed wrong types (non-dicts, lists of strings, numbers where lists belong) and must return, not raise.
   python -m unittest discover -s pack/runtime/tests"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "pack/skills/build"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_replies  # noqa: E402
import check_results  # noqa: E402
import check_source_use  # noqa: E402
import fetch_source  # noqa: E402
import qsf_flow  # noqa: E402
from test_sources_tables import HAVE_PDF, PAGE_RESULTS, make_pdf  # noqa: E402

BAD = [None, 1, "x", [], ["a", "b"], [1, None], {"a": 1}, True]
SOURCE_KEYS = ["files", "licenceLookups", "analysisCode", "searches", "surveyVersions", "questionsChecked",
               "decisionsFromSources", "signChecks", "paperTables"]
PROGRAM_KEYS = ["nodes", "evidence", "issues", "steps", "source"]
QSFS = [{"SurveyElements": "x"}, {"SurveyEntry": {}, "SurveyElements": [1, "a", {"Element": "FL", "Payload": "x"}]},
        {"SurveyEntry": {}, "SurveyElements": [{"Element": "BL", "Payload": [1]}, {"Element": "SQ", "Payload": None},
                                               {"Element": "FL", "Payload": {"Flow": [1, {"Type": "Block"}]}}]}]


def cases():
    q_issue = {"issues": [{"id": "q", "title": "Which?", "severity": "decision"}]}
    for b in BAD:
        yield b, {}, None
        yield {}, b, b
        for k in SOURCE_KEYS:
            yield {k: b}, {}, None
            yield {k: [b]}, {}, None
        for k in ("path", "license", "sha256", "licenseEvidence", "url"):
            yield {"files": [{"path": "sources/open/a.R", k: b}]}, {}, None
        for k in ("file", "license", "licenseFrom", "url"):
            yield ({"files": [{"path": "sources/open/a.R", "sha256": "ab"}],
                    "licenceLookups": [{"file": {"sha256": "ab"}, "license": "CC-BY-4.0", k: b}]}, {}, None)
        for k in ("source", "lines", "quote", "what", "use", "where", "reason"):
            yield {"analysisCode": [{"source": "sources/open/a.R", "lines": "1-2", k: b}]}, {}, None
        for k in PROGRAM_KEYS:
            yield {}, {k: b}, None
            yield {}, {k: [b]}, None
        for k in ("id", "kind", "fields", "evidenceIds", "studyIds"):
            yield {}, {"nodes": [{"id": "r", "kind": "result", "fields": [{"id": "f", "value": 1}], k: b}]}, None
        for k in ("id", "value", "evidenceIds", "extensions", "state", "origin"):
            table = {"table": "Table 1", "columns": ["a"], "rows": [[1]]}
            yield {}, {"nodes": [{"id": "r", "kind": "result", "fields": [{"id": "f", "value": table, k: b}]}]}, None
        for k in ("id", "path", "locator", "quote", "note"):
            ev = {"id": "e", "path": "paper.pdf", "locator": {"page": 1}, "quote": "1 2 3 4 5 6 7 8 9 10 11",
                  "note": "rendered page checked", k: b}
            yield {}, {"evidence": [ev], "nodes": [{"id": "r", "kind": "result", "evidenceIds": ["e"],
                                                   "fields": [{"id": "f", "value": 0.16, "evidenceIds": ["e"]}]}]}, None
        for k in ("issue", "sourcesChecked"):
            yield {"questionsChecked": [{"issue": "q", "sourcesChecked": [{"paths": ["sources/open/a.R"]}], k: b}]}, \
                q_issue, None
        for k in ("paths", "path", "found", "answers"):
            yield {"questionsChecked": [{"issue": "q", "sourcesChecked": [{"paths": ["sources/open/a.R"], k: b}]}]}, \
                q_issue, None
        for k in ("title", "severity", "id"):
            yield {}, {"issues": [{"id": "q", "title": "Which?", "severity": "decision", k: b}]}, None
        yield {}, {}, {"conditions": b, "arms": b}


class MalformedRecords(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="malformed-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / "sources/open").mkdir(parents=True)
        (self.root / "sources/open/a.R").write_text("# exclude outliers\nx <- recode(y)\n", encoding="utf-8")
        if HAVE_PDF:
            (self.root / "paper.pdf").write_bytes(make_pdf([PAGE_RESULTS]))
        self.pkg = self.root / "package/p"
        (self.pkg / "task").mkdir(parents=True)
        (self.pkg / "materials").mkdir()
        # imports replies without the copy: check_replies reports it without running package code
        (self.pkg / "task/adapter.py").write_text("import replies\n", encoding="utf-8")

    def write(self, source, program, task, qsf):
        if isinstance(source, dict) and "files" not in source:
            source = dict(source, files=[{"path": "sources/open/a.R", "url": "https://osf.io/download/a/"},
                                         {"path": "sources/open/s.qsf", "url": "https://osf.io/download/s/"}])
        (self.root / "sources/open/s.qsf").write_text(json.dumps(qsf), encoding="utf-8")
        (self.root / "sources/SOURCE.json").write_text(json.dumps(source), encoding="utf-8")
        (self.root / "program.json").write_text(json.dumps(program), encoding="utf-8")
        (self.pkg / "task/task.json").write_text(json.dumps(task), encoding="utf-8")
        (self.pkg / "materials/materials.json").write_text(json.dumps(task), encoding="utf-8")

    def test_wrong_types_never_raise(self):
        checks = [("fetch_source", lambda: fetch_source.problems(self.root)),
                  ("fetch_source --check", lambda: fetch_source.problems(self.root, standalone=True)),
                  ("check_source_use", lambda: check_source_use.problems(self.root)),
                  ("qsf_flow", lambda: qsf_flow.problems(self.root)),
                  ("check_replies", lambda: check_replies.problems(self.root, self.pkg)),
                  ("check_results", lambda: check_results.check(self.root / "program.json"))]
        for i, (source, program, task) in enumerate(cases()):
            for qsf in [{}] + (QSFS if i % 9 == 0 else []):
                self.write(source, program, task, qsf)
                for name, run in checks:
                    with self.subTest(check=name, source=source, program=program, task=task, qsf=qsf):
                        found = run()
                        if name == "check_source_use":   # its own guard turns a crash into "could not run"
                            self.assertFalse([m for m, _ in found if "could not run" in m])

    def test_check_results_locator_and_path_forms(self):
        """A string or list locator, and a "./paper.pdf" path, are read, never crash the sign check."""
        for locator in ("p. 1", [1], None, {"page": "1"}):
            ev = {"id": "e", "path": "./paper.pdf", "locator": locator, "quote": "h = 0.19",
                  "note": "rendered page checked"}
            program = {"schemaVersion": 2, "id": "x", "source": {"filename": "paper.pdf"}, "evidence": [ev],
                       "nodes": [{"id": "r", "kind": "result", "fields": [
                           {"id": "f", "value": {"ci": [0.16, 0.54]}, "evidenceIds": ["e"], "origin": "verbatim"}]}]}
            (self.root / "program.json").write_text(json.dumps(program), encoding="utf-8")
            check_results.check(self.root / "program.json")
        if HAVE_PDF:   # "./paper.pdf" is the paper: its checked page excuses the lost minus
            ev = dict(ev, locator={"page": 1})
            program["evidence"] = [ev]
            (self.root / "program.json").write_text(json.dumps(program), encoding="utf-8")
            found = [m for m, _ in check_results.check(self.root / "program.json")["problems"]]
            self.assertFalse([m for m in found if "minus sign" in m], found)
            program["evidence"] = [dict(ev, path="../paper.pdf")]
            (self.root / "program.json").write_text(json.dumps(program), encoding="utf-8")
            found = [m for m, _ in check_results.check(self.root / "program.json")["problems"]]
            self.assertTrue([m for m in found if "minus sign" in m], found)


class ConsoleEncoding(unittest.TestCase):
    def test_check_package_output_survives_a_console_without_utf8(self):
        import os
        import subprocess
        env = dict(os.environ, PYTHONIOENCODING="ascii")
        env.pop("PYTHONUTF8", None)
        run = subprocess.run([sys.executable, "-B", str(REPO / "pack/skills/build/check_package.py"),
                              str(Path(tempfile.gettempdir()) / "nowhere-\u00e9\u2212\u4e2d")],
                             capture_output=True, env=env)
        self.assertEqual(run.returncode, 1, run.stderr)
        self.assertIn(b"FAIL", run.stdout)
        self.assertNotIn(b"UnicodeEncodeError", run.stderr)


if __name__ == "__main__":
    unittest.main()
