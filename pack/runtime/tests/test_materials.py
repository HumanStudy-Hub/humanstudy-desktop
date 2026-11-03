"""Materials the paper does not print (check_materials.py): schema-enough items are filled from the paper's
description and do not block; needs-original items are never invented, come only from openly licensed sources
or the researcher, and the researcher's own materials never leave the project (community and agent exports).
   python -m unittest discover -s pack/runtime/tests"""
import copy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[3]
BUILD = REPO / "pack/skills/build"
FIXTURE = json.loads((Path(__file__).resolve().parent / "fixtures/materials/program.json").read_text(encoding="utf-8"))
sys.path.insert(0, str(BUILD))
sys.path.insert(0, str(REPO / "pack/skills/export"))
import check_materials  # noqa: E402
import check_program  # noqa: E402
import check_validity  # noqa: E402
import community  # noqa: E402
import sources  # noqa: E402

INSTRUCTIONS = ("Welcome to the investment study. On each screen you will see the past thirty dividends of two "
                "stocks. Please choose the stock you would like to invest in by typing LEFT or RIGHT.")


class Materials(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="materials-test-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / "paper.pdf").write_bytes(b"%PDF-1.4 stand-in")
        self.program = copy.deepcopy(FIXTURE)

    # helpers
    def field(self, fid):
        return next(f for n in self.program["nodes"] for f in n["fields"] if f["id"] == fid)

    def material(self, fid):
        return self.field(fid)["extensions"]["material"]

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def check(self, record=True):
        self.write("program.json", json.dumps(self.program))
        if record:
            (self.root / "sources").mkdir(exist_ok=True)
            data = sources.build(self.root)
            (self.root / "sources/SOURCE.json").write_text(json.dumps(data), encoding="utf-8")
        return check_materials.check(self.root)

    def problems(self, **kw):
        return [m for m, _ in self.check(**kw)["problems"]]

    def supply(self):
        """The researcher pasted the instruction screens: saved under sources/researcher/, referenced by the field."""
        self.write("sources/researcher/s1-instructions.txt", INSTRUCTIONS)
        f = self.field("instruction-text")
        f.update({"origin": "researcher", "state": "confirmed", "value": {"file": "sources/researcher/s1-instructions.txt"}})
        f["extensions"]["material"].update({"status": "supplied", "file": "sources/researcher/s1-instructions.txt"})
        self.program["issues"] = []

    # the fixture
    def test_fixture_passes_program_and_materials_checks(self):
        self.assertEqual(check_program.check(self.program), [])
        report = self.check()
        self.assertEqual(report["problems"], [])
        self.assertEqual({(i["kind"], i["status"]) for i in report["items"]},
                         {("schema-enough", "filled"), ("needs-original", "pending")})

    # schema-enough cannot be a way to invent wording
    def test_wording_is_never_schema_enough(self):
        f = self.field("instruction-text")
        f.update({"origin": "derived", "state": "confirmed", "derivation": "written from the Methods description",
                  "value": "Choose the stock you would like to invest in."})
        f["extensions"]["material"] = {"kind": "schema-enough", "what": "Study 1 instruction screens",
                                       "basis": "the Methods description", "mentioned": "p. 3"}
        self.program["issues"] = []
        self.assertTrue(any("never schema-enough" in p for p in self.problems()), self.problems())

    def test_prose_under_a_neutral_name_is_caught(self):
        f = self.field("dividend-sequences")
        f["value"] = {"draws": 30, "screen": "You will now see two stocks. Each has paid dividends in the past. "
                                             "Look at them carefully and decide where your money goes."}
        self.assertTrue(any("holds prose" in p for p in self.problems()), self.problems())

    def test_many_short_invented_lines_add_up_to_prose(self):
        self.field("dividend-sequences")["value"] = {"draws": 30, "lines": [
            "Welcome to the investment game today", "Look at both stocks very carefully",
            "Then pick the one you prefer most"]}
        self.assertTrue(any("holds prose" in p for p in self.problems()), self.problems())

    def test_numbers_and_printed_phrases_are_structure(self):
        f = self.field("dividend-sequences")
        f["value"] = {"left": [3.1, 7.4, 12.0] * 10, "note": "the two stocks were shown side by side"}
        self.assertEqual(self.problems(), [])

    def test_schema_enough_needs_evidence_a_value_and_no_blocking_issue(self):
        f = self.field("dividend-sequences")
        f["evidenceIds"] = []
        self.assertTrue(any("needs the evidence" in p for p in self.problems()))
        f["evidenceIds"] = ["ev-dist"]
        f["value"] = None
        self.assertTrue(any("has no value" in p for p in self.problems()))
        f["value"] = {"draws": 30}
        f["origin"] = "verbatim"
        self.assertTrue(any("origin derived or implementation" in p for p in self.problems()))
        f["origin"] = "derived"
        self.program["issues"].append({"id": "i-seq", "title": "Sequences", "severity": "blocking", "reason": "r",
                                       "impact": "i", "suggestedAction": "a", "nodeId": "m1",
                                       "fieldId": "dividend-sequences", "evidenceIds": []})
        self.assertTrue(any("blocks a schema-enough item" in p for p in self.problems()))

    # needs-original: never invented
    def test_pending_item_holds_no_text_and_its_issue_names_it(self):
        f = self.field("instruction-text")
        f["value"] = "Please choose a stock."
        self.assertTrue(any("state missing and no value" in p for p in self.problems()))
        f["value"] = None
        self.program["issues"][0]["title"] = "Instruction wording is not printed"
        self.assertTrue(any("no issue title" in p for p in self.problems()), "the status must say what is needed")
        self.program["issues"][0]["severity"] = "check"
        self.assertTrue(any("no blocking or decision issue" in p for p in self.problems()))

    def test_verbatim_claim_without_a_source_fails(self):
        f = self.field("instruction-text")
        f.update({"origin": "verbatim", "state": "confirmed", "value": INSTRUCTIONS})
        self.program["issues"] = []
        found = self.problems()
        self.assertTrue(any("claims printed text" in p for p in found) and any("state missing" in p for p in found), found)

    def test_open_source_needs_an_open_license_and_no_participant_data(self):
        self.write("sources/open/instructions.txt", INSTRUCTIONS)
        self.program["evidence"].append({"id": "ev-open", "path": "sources/open/instructions.txt",
                                         "locator": {"page": 1}, "quote": INSTRUCTIONS})
        f = self.field("instruction-text")
        f.update({"origin": "verbatim", "state": "confirmed", "value": INSTRUCTIONS, "evidenceIds": ["ev-open"]})
        f["extensions"]["material"].update({"status": "found-open", "search": [
            {"where": "OSF project the paper links", "url": "https://osf.io/abcde", "license": "CC-BY-4.0", "found": True}]})
        self.program["issues"] = []
        self.assertTrue(any("open license" in p for p in self.problems()), "license unknown: not usable")
        self.write("program.json", json.dumps(self.program))
        data = sources.build(self.root, {"sources/open/instructions.txt": "CC-BY-4.0"},
                             {"sources/open/instructions.txt": "OSF project page: License CC-By Attribution 4.0"})
        (self.root / "sources/SOURCE.json").write_text(json.dumps(data), encoding="utf-8")
        self.assertEqual(check_materials.check(self.root)["problems"], [])
        # a file of participant responses is never a source of materials, licensed or not
        self.write("sources/open/study01_data.csv", "subject,choice\n1,left\n")
        self.program["evidence"][-1]["path"] = "sources/open/study01_data.csv"
        self.write("program.json", json.dumps(self.program))
        data = sources.build(self.root, {"sources/open/study01_data.csv": "CC-BY-4.0"},
                             {"sources/open/study01_data.csv": "OSF: CC-By 4.0"})
        (self.root / "sources/SOURCE.json").write_text(json.dumps(data), encoding="utf-8")
        self.assertTrue(any("participant data" in m for m, _ in check_materials.check(self.root)["problems"]))

    def test_stand_in_and_left_out_need_the_researchers_answer(self):
        f = self.field("instruction-text")
        f.update({"origin": "implementation", "state": "confirmed", "value": "Choose LEFT or RIGHT."})
        f["extensions"]["material"]["status"] = "stand-in"
        self.program["issues"] = []
        found = self.problems()
        self.assertTrue(any("must say it is one" in p for p in found) and any("acceptance" in p for p in found), found)
        f["label"] = "Instruction screen text (stand-in accepted by the researcher)"
        f["extensions"]["material"]["answer"] = "use a labelled stand-in"
        self.assertEqual(self.problems(), [])
        # left out: no value, and capabilities.json excludes it
        f.update({"origin": "unknown", "state": "missing", "value": None})
        f["extensions"]["material"].update({"status": "left-out", "answer": "leave the instructions out"})
        self.program["issues"] = [dict(FIXTURE["issues"][0], title="Left out by the researcher: Study 1 instruction screens")]
        self.write("capabilities.json", json.dumps({"schemaVersion": 1, "run": {"excluded": []}}))
        self.assertTrue(any("run.excluded does not name it" in p for p in self.problems()))
        self.write("capabilities.json", json.dumps({"schemaVersion": 1, "run": {"excluded": [
            {"what": "Study 1 instruction screens", "field": "m1.instruction-text", "reason": "left out by the researcher"}]}}))
        self.assertEqual(self.problems(), [])

    # researcher-supplied materials stay in the researcher's project
    def test_supplied_material_is_a_reference_recorded_as_researcher_supplied(self):
        self.supply()
        self.assertEqual(self.problems(), [])
        record = json.loads((self.root / "sources/SOURCE.json").read_text(encoding="utf-8"))
        entry = next(f for f in record["files"] if f["path"] == "sources/researcher/s1-instructions.txt")
        self.assertEqual(entry["license"], "researcher-supplied")
        # --license cannot relabel it as open
        data = sources.build(self.root, {"sources/researcher/s1-instructions.txt": "CC-BY-4.0"})
        self.assertEqual(next(f for f in data["files"] if f["path"].startswith("sources/researcher/"))["license"],
                         "researcher-supplied")

    def test_supplied_text_copied_anywhere_published_fails(self):
        self.supply()
        self.field("instruction-text")["value"] = INSTRUCTIONS
        found = self.problems()
        self.assertTrue(any("holds the researcher's text" in p for p in found), found)
        self.assertTrue(any("program.json copies researcher-supplied text" in p for p in found), found)
        self.supply()
        self.write("package/p/materials/materials.json", json.dumps({"s1": {"instructions": INSTRUCTIONS}}))
        self.assertTrue(any("materials.json copies researcher-supplied text" in p for p in self.problems()))
        self.write("package/p/materials/materials.json", "{}")
        self.write("package/p/task/adapter.py", 'INTRO = "%s"\n' % INSTRUCTIONS.replace(". ", ".\\n"))
        self.assertTrue(any("adapter.py copies researcher-supplied text" in p for p in self.problems()))

    def test_supplied_file_outside_the_researcher_folder_fails(self):
        self.supply()
        self.write("sources/s1-instructions.txt", INSTRUCTIONS)
        self.material("instruction-text")["file"] = "sources/s1-instructions.txt"
        self.assertTrue(any("must be a file under sources/researcher/" in p for p in self.problems()))

    def test_validity_reads_supplied_text_as_participant_material(self):
        self.supply()
        self.write("program.json", json.dumps(self.program))
        pieces = check_validity.participant_text(self.program, self.root)
        self.assertTrue(any("past thirty dividends" in p for p in pieces), pieces)
        self.assertFalse(any("past thirty dividends" in p for p in check_validity.participant_text(self.program)))

    def test_community_export_leaves_researcher_materials_out_and_refuses_a_leak(self):
        self.supply()
        self.check()
        self.write("sources/open/si.txt", "Open supplement text.")
        result = community.export(self.root, self.root / "exports/community.zip")
        names = zipfile.ZipFile(result["file"]).namelist()
        self.assertIn("sources/open/si.txt", names)
        self.assertFalse([n for n in names if "researcher" in n], names)
        # a copy of the text in a published file stops the export
        self.write("artifacts/study-overview.html", "<p>%s</p>" % INSTRUCTIONS)
        with self.assertRaises(ValueError):
            community.export(self.root, self.root / "exports/community-2.zip")
        self.assertFalse((self.root / "exports/community-2.zip").exists())

    def test_cli_prints_pass_and_counts(self):
        self.check()
        run = subprocess.run([sys.executable, str(BUILD / "check_materials.py"), str(self.root)],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stdout)
        self.assertIn("needs-original/pending 1", run.stdout)
        self.assertIn("schema-enough 1", run.stdout)
        self.assertIn("PASS materials", run.stdout)

    def test_unclassified_missing_material_is_a_note_not_a_failure(self):
        del self.field("instruction-text")["extensions"]
        report = self.check()
        self.assertEqual(report["problems"], [])
        self.assertTrue(any("classify it" in n for n in report["notes"]))


if __name__ == "__main__":
    unittest.main()
