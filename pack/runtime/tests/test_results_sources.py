"""Build checks: printed tables and reported numbers are data (check_results.py), and every source
file is recorded with hash and license (sources.py, required by check_package.py).
   python -m unittest discover -s pack/runtime/tests"""
import copy
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
BUILD = REPO / "pack/skills/build"
PROGRAM = REPO / "app/src/shared/sample-program.json"
sys.path.insert(0, str(BUILD))
import check_results  # noqa: E402
import check_verbatim  # noqa: E402
import sources  # noqa: E402


def program_with(result_fields, evidence):
    p = json.loads(PROGRAM.read_text(encoding="utf-8"))
    p["evidence"] += evidence
    node = next(n for n in p["nodes"] if n["id"] == "result-1")
    node["fields"] = [f for f in node["fields"] if f["id"] == "result_kind"] + result_fields
    node["evidenceIds"] = [e["id"] for e in evidence]
    return p


TABLE_QUOTE = ("Table 2. Mean estimates. Item 1 65.7 48.5 2.31 Item 2 41.0 37.2 0.84 Item 3 72.4 51.9 3.02 "
               "Item 4 55.1 49.0 1.12")
EVIDENCE = [{"id": "ev-t2", "path": "paper.pdf", "locator": {"page": 7}, "quote": TABLE_QUOTE}]
TABLE = {"id": "table-2", "label": "Table 2: mean estimates", "origin": "verbatim", "state": "confirmed",
         "evidenceIds": ["ev-t2"],
         "value": {"table": "Table 2", "title": "Mean estimates", "page": 7,
                   "columns": ["Item", "Choice 1: M", "Choice 2: M", "t"],
                   "rows": [["Item 1", "65.7", "48.5", "2.31"], ["Item 2", "41.0", "37.2", ".84"],
                            ["Item 3", "72.4", "51.9", "3.02"], ["Item 4", "55.1", "49.0", "1.12"]]}}


class CheckResults(unittest.TestCase):
    def run_check(self, program, pages=None):
        root = Path(tempfile.mkdtemp(prefix="check-results-"))
        self.addCleanup(shutil.rmtree, root, True)
        (root / "program.json").write_text(json.dumps(program), encoding="utf-8")
        if pages is not None:
            (root / "paper.pdf").write_bytes(b"%PDF-1.4 stub")
            original = check_results.Pdf

            class FakePdf:
                def __init__(self, path):
                    pass

                def load(self):
                    return pages
            check_results.Pdf = FakePdf
            self.addCleanup(setattr, check_results, "Pdf", original)
        return [m for m, _ in check_results.check(root / "program.json")["problems"]]

    def test_numbers_only_in_a_quote_are_flagged_and_a_table_field_clears_them(self):
        prose = {"id": "descriptives", "label": "Descriptives", "origin": "reported", "state": "confirmed",
                 "evidenceIds": ["ev-t2"], "value": "Item means are in Table 2 (raw table text in the quote)."}
        found = self.run_check(program_with([prose], EVIDENCE))
        self.assertTrue(any(m.startswith("result-1: ") and "only in evidence quotes" in m for m in found), found)
        self.assertTrue(any(m.startswith("ev-t2 (p. 7): quote reads like a printed table") for m in found), found)
        self.assertEqual(self.run_check(program_with([prose, TABLE], EVIDENCE)), [])

    def test_table_shape(self):
        bad = copy.deepcopy(TABLE)
        bad["origin"] = "reported"
        bad["value"]["rows"][0] = ["Item 1", "65.7", "48.5"]          # a cell short
        bad["value"]["rows"][1][2] = None                              # unreadable, but not labelled
        bad["value"]["uncertain"] = [{"row": 9, "column": 1, "reason": "x"}]
        found = self.run_check(program_with([bad], EVIDENCE))
        for expected in ["row 0 has 3 cells for 4 columns", "row 1 column 2 is null but not listed in uncertain",
                         "does not name a cell", "printed Table 2 has origin 'reported'"]:
            self.assertTrue(any(expected in m for m in found), (expected, found))
        good = copy.deepcopy(TABLE)
        good["value"]["rows"][1][2] = None
        good["value"]["uncertain"] = [{"row": 1, "column": 2, "reason": "smudged in the scan"}]
        good["evidenceIds"] = ["ev-t2"]
        ev = [dict(EVIDENCE[0], quote="Table 2. Mean estimates")]
        self.assertEqual(self.run_check(program_with([good], ev)), [])

    def test_table_assembled_from_the_text_has_no_label_and_may_be_reported(self):
        built = copy.deepcopy(TABLE)
        built["origin"] = "reported"
        del built["value"]["table"]
        built["value"]["title"] = "Item means, assembled from the text"
        self.assertEqual(self.run_check(program_with([built], EVIDENCE)), [])

    def test_printed_caption_needs_a_table_field_with_that_label(self):
        pages = ["Intro text that is long enough to count as a text layer on this page.\n",
                 "Results are long enough to count as a text layer.\nTABLE II\nMean ratings\nTable 2 shows the means.\n"]
        ev = [dict(EVIDENCE[0], quote="Table 2. Mean estimates")]
        found = self.run_check(program_with([], ev), pages)
        self.assertEqual(found, ["p. 2 prints Table 2, but no field holds it as a table"])
        self.assertEqual(self.run_check(program_with([TABLE], ev), pages), [])

    def test_labels_pages_and_years_are_not_numbers(self):
        self.assertEqual(check_results.numbers("In Study 2 (Table 3, p. 14; Smith, 1990) M = 4.25, SD = .80"),
                         [4.25, 0.8])
        self.assertEqual(check_results.label_key("TABLE IV"), "table 4")


    def test_exported_references_render_a_table_as_markdown(self):
        sys.path.insert(0, str(REPO / "pack/skills/export/agent"))
        import study_core
        value = copy.deepcopy(TABLE["value"])
        value["rows"][1][2] = None
        value["uncertain"] = [{"row": 1, "column": 2, "reason": "smudged"}]
        lines = study_core.text(value).splitlines()
        self.assertEqual(lines[0], "Table 2 Mean estimates (p. 7)")
        self.assertIn("| Item | Choice 1: M | Choice 2: M | t |", lines)
        self.assertIn("| Item 2 | 41.0 | ? | .84 |", lines)
        self.assertEqual(lines[-1], "? row 1, column 2: smudged")


class CheckVerbatim(unittest.TestCase):
    PAGE = ("Method. Participants and procedure. Forty participants (22 female, 16 male) completed the task. "
            "We predicted that losses loom larger than gains. Table 2. Mean estimates. Item 1 65.7 48.5 Item 2 41.0")

    def statuses(self, fields, pages=None, verification=None):
        root = Path(tempfile.mkdtemp(prefix="check-verbatim-"))
        self.addCleanup(shutil.rmtree, root, True)
        ev = dict(EVIDENCE[0], quote="Table 2. Mean estimates", **({"verification": verification} if verification else {}))
        p = program_with(fields, [ev])
        (root / "program.json").write_text(json.dumps(p), encoding="utf-8")
        (root / "paper.pdf").write_bytes(b"%PDF-1.4 stub")
        page = self.PAGE
        doc = pages or ["front matter long enough to be a text layer of a page", "", "", "", "", "", page]

        class FakePdf:
            def __init__(self, path):
                pass

            def load(self):
                return doc
        original = check_verbatim.check_quotes.Pdf
        check_verbatim.check_quotes.Pdf = FakePdf
        self.addCleanup(setattr, check_verbatim.check_quotes, "Pdf", original)
        report = check_verbatim.check(root / "program.json")
        return {r["field"].split(".", 1)[1]: r["status"] for r in report["results"] if r["field"].startswith("result-1.")}

    def field(self, fid, value, origin="verbatim"):
        return {"id": fid, "label": fid, "origin": origin, "state": "confirmed", "evidenceIds": ["ev-t2"], "value": value}

    def test_verbatim_fields_must_be_the_printed_words(self):
        got = self.statuses([
            self.field("exact", "Forty participants (22 female, 16 male) completed the task."),
            self.field("number-for-word", "40 participants (22 female, 16 male) completed the task."),
            self.field("invented", "Stimuli were generated by sampling skewed distributions at random."),
            self.field("paraphrase", "Losses were predicted to loom larger.", origin="reported"),
            dict(TABLE, value=dict(TABLE["value"], rows=[["Item 1", "65.7", "48.5", ""], ["Item 2", "41.0", "", ""]],
                                   columns=["Item", "M", "M", "t"], title="Mean estimates"))])
        self.assertEqual(got, {"exact": "found", "number-for-word": "close", "invented": "not_found", "table-2": "found"})


    def test_page_breaks_ocr_noise_and_noisy_tables(self):
        pages = ["front matter long enough to be a text layer of a page", "", "", "", "", "",
                 "Each subject read that the council must decide upon which they",
                 "282 ROSS ET AL. must vote, and opponents argue it will dram money from domestic priorities."]
        spans = self.field("spans", "the council must decide upon which they must vote")
        ocr = self.field("ocr", "opponents argue it will drain money from domestic priorities.")
        noisy = dict(TABLE, value={"table": "Table 2", "page": 7, "columns": ["Story", "Sign release (n = 53)"],
                                    "rows": [["Supermarket", "75.6"], ["Term paper", "67.4"]]})
        pages[6] = "Table 2. Story Sign re1ease (n = 53) Supermarket 75.6 Term paper 67.4 " + pages[6]
        got = self.statuses([spans, ocr, noisy], pages)
        self.assertEqual(got, {"spans": "found", "ocr": "close", "table-2": "table_text_layer"})
        self.assertEqual(self.statuses([ocr], pages, verification="unverified"), {"ocr": "close_unverified"})

    def test_bad_inputs_do_not_crash(self):
        bad = copy.deepcopy(TABLE)
        bad["value"]["uncertain"] = 5
        ev = [dict(EVIDENCE[0], quote=5, locator=None)]
        found = CheckResults.run_check(self, program_with([bad], ev))
        self.assertTrue(any("uncertain must be a list" in m for m in found), found)
        self.assertEqual(check_results.numbers("1,234 participants; F(1,312) = 4.5"), [1234.0, 1.0, 312.0, 4.5])
        root = Path(tempfile.mkdtemp(prefix="check-verbatim-"))
        self.addCleanup(shutil.rmtree, root, True)
        (root / "program.json").write_text(json.dumps(program_with([self.field("x", "some words here")], ev)))
        self.assertEqual(check_verbatim.check(root / "program.json")["results"][0]["field"], "result-1.x")


class Sources(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="sources-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        shutil.copy(PROGRAM, self.root / "program.json")
        (self.root / "paper.pdf").write_bytes(b"%PDF-1.4 the paper")
        (self.root / "sources").mkdir()
        (self.root / "sources/supplement.pdf").write_bytes(b"%PDF-1.4 supplement")

    def cli(self, *args):
        return subprocess.run([sys.executable, str(BUILD / "sources.py"), str(self.root), *args],
                              capture_output=True, text=True, encoding="utf-8")

    def test_writes_hashes_and_unknown_licenses_and_keeps_stated_ones(self):
        self.assertEqual(self.cli("--check").returncode, 1, "missing record fails")
        run = self.cli("--license", "paper.pdf=CC-BY-4.0", "--license-evidence", "paper.pdf=p. 1 footer")
        self.assertEqual(run.returncode, 0, run.stderr)
        data = json.loads((self.root / "sources/SOURCE.json").read_text(encoding="utf-8"))
        files = {f["path"]: f for f in data["files"]}
        self.assertEqual(list(files), ["paper.pdf", "sources/supplement.pdf"])
        self.assertEqual(files["paper.pdf"]["sha256"], hashlib.sha256(b"%PDF-1.4 the paper").hexdigest())
        self.assertEqual(files["paper.pdf"]["bytes"], len(b"%PDF-1.4 the paper"))
        self.assertEqual(files["sources/supplement.pdf"]["license"], "unknown")
        self.assertEqual(data["pdf"]["sha256"], files["paper.pdf"]["sha256"])
        self.assertEqual((data["pdf"]["license"], data["pdf"]["licenseEvidence"]), ("CC-BY-4.0", "p. 1 footer"))
        self.assertEqual(data["paper"]["title"], "Intentional Action and Side-Effects in Ordinary Language")
        self.assertEqual(self.cli("--check").returncode, 0)

        (self.root / "sources/supplement.pdf").write_bytes(b"changed")
        (self.root / "sources/data.csv").write_text("a,b\n")
        run = self.cli("--check")
        self.assertEqual(run.returncode, 1)
        self.assertIn("SHA-256 of sources/supplement.pdf changed", run.stdout)
        self.assertIn("does not record sources/data.csv", run.stdout)
        self.assertEqual(self.cli().returncode, 0)
        data = json.loads((self.root / "sources/SOURCE.json").read_text(encoding="utf-8"))
        self.assertEqual(data["pdf"]["license"], "CC-BY-4.0", "a rerun keeps the recorded license")
        self.assertEqual(self.cli("--check").returncode, 0)

    def test_a_missing_paper_is_a_problem(self):
        (self.root / "paper.pdf").unlink()
        self.assertEqual(self.cli().returncode, 0)
        run = self.cli("--check")
        self.assertEqual(run.returncode, 1)
        self.assertIn("is not in the project folder", run.stdout)

    def test_package_check_requires_the_record(self):
        p = json.loads(PROGRAM.read_text(encoding="utf-8"))
        pkg = self.root / "package/knobe"
        for sub in ["task", "evaluation", "materials", "source"]:
            (pkg / sub).mkdir(parents=True)
        (pkg / "study.json").write_text(json.dumps({"programRef": {"path": "../../program.json", "id": p["id"]}}))
        (pkg / "source/paper_metadata.json").write_text("{}")
        (pkg / "materials/materials.json").write_text("{}")
        (pkg / "task/task.json").write_text(json.dumps({"programBindings": {
            "programId": p["id"], "stepIds": [s["id"] for s in p["steps"]],
            "recordNodeIds": [n["id"] for n in p["nodes"] if n["kind"] in ("record", "variable")],
            "analysisNodeIds": [n["id"] for n in p["nodes"] if n["kind"] == "analysis"]}}))
        (pkg / "task/adapter.py").write_text("import sys\nif '--smoke-test' in sys.argv: print('ok')\n")
        (pkg / "evaluation/evaluation.py").write_text("def evaluate(sessions):\n    return {}\n")
        check = lambda: subprocess.run([sys.executable, str(BUILD / "check_package.py"), str(pkg)],
                                       capture_output=True, text=True, encoding="utf-8")
        run = check()
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("sources/SOURCE.json is missing", run.stdout + run.stderr)
        self.assertEqual(self.cli().returncode, 0)
        run = check()
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("ok   sources/SOURCE.json records every source file", run.stdout)


if __name__ == "__main__":
    unittest.main()
