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
import re
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

    SEARCHES = [{"where": "OSF search by DOI and title", "query": "materials fixture", "url": "https://osf.io/search",
                 "date": "2026-11-03", "result": "nothing"}]

    def record(self, licenses=None, evidence=None, extra=None, searches=True):
        self.write("program.json", json.dumps(self.program))
        (self.root / "sources").mkdir(exist_ok=True)
        data = sources.build(self.root, licenses, evidence, extra)
        if searches:
            data["searches"] = self.SEARCHES
        else:
            data.pop("searches", None)
        (self.root / "sources/SOURCE.json").write_text(json.dumps(data), encoding="utf-8")

    def check(self, record=True, **kw):
        self.write("program.json", json.dumps(self.program))
        if record:
            self.record(**kw)
        return check_materials.check(self.root)

    def problems(self, **kw):
        return [m for m, _ in self.check(**kw)["problems"]]

    def supply(self):
        """The researcher pasted the instruction screens: saved under sources/researcher/, referenced by the field."""
        self.write("sources/researcher/s1-instructions.txt", INSTRUCTIONS)
        f = self.field("instruction-text")
        f.update({"origin": "researcher", "state": "confirmed", "value": {"file": "sources/researcher/s1-instructions.txt"}})
        f["extensions"]["material"].update({"status": "supplied", "file": "sources/researcher/s1-instructions.txt",
                                            "answer": "pasted the instruction screens"})
        self.program["issues"] = []

    # the fixture
    def test_fixture_passes_program_and_materials_checks(self):
        self.assertEqual(check_program.check(self.program), [])
        self.assertEqual(check_program.schema_problems(self.program, BUILD / "check_program.py"), [])
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

    def test_prose_split_into_short_chunks_keys_or_cjk_is_caught(self):
        f = self.field("dividend-sequences")
        f["value"] = {"draws": 30, "lines": ["Welcome to", "the investment", "game; look at", "both stocks and",
                                             "then choose", "the better one"]}
        self.assertTrue(any("holds prose" in p for p in self.problems()), "chunks of fewer than four words")
        f["value"] = {"Welcome to the investment game, look at both stocks and then choose the better one": 30}
        self.assertTrue(any("holds prose" in p for p in self.problems()), "prose in a dictionary key")
        f["value"] = {"draws": 30, "screen": "欢迎参加投资游戏请仔细观察两只股票然后选择你想投资的那一只"}
        self.assertTrue(any("holds prose" in p for p in self.problems()), "Chinese text is not one word")

    def test_unlabelled_material_written_by_the_build_is_caught(self):
        f = self.field("instruction-text")
        del f["extensions"]
        f.update({"origin": "implementation", "state": "check", "value": INSTRUCTIONS})
        self.program["issues"] = []
        self.assertTrue(any("participant material with no source" in p for p in self.problems()))

    def test_odd_input_does_not_crash(self):
        self.field("dividend-sequences")["evidenceIds"] = 7
        self.field("dividend-sequences")["extensions"] = "x"
        self.program["evidence"].append({"id": ["bad"], "path": "paper.pdf"})
        self.write("program.json", json.dumps(self.program))
        self.write("sources/SOURCE.json", "[1, 2]")
        self.write("capabilities.json", json.dumps({"run": [1]}))
        check_materials.check(self.root)

    def test_invented_word_lists_anchors_and_feedback_are_caught(self):
        f = self.field("dividend-sequences")
        f["value"] = {"list": ["bed", "rest", "awake", "tired", "dream", "wake", "snooze", "blanket", "doze", "slumber",
                               "yawn", "drowsy", "nap"]}
        self.assertTrue(any("holds prose" in p for p in self.problems()), "single invented words add up")
        f["label"] = "Target words (12)"
        self.assertTrue(any("never schema-enough" in p for p in self.problems()))
        f["label"] = "Response scale (7-point)"
        f["value"] = {"anchors": ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"]}
        self.assertTrue(any("never schema-enough" in p for p in self.problems()), "anchors are wording")
        f["label"] = "Outcome after each choice"
        f["value"] = {"win": "Congratulations, you earned {x} points this round"}
        self.assertTrue(any("holds prose" in p for p in self.problems()), "one sentence is prose")

    def test_wording_without_a_source_fails_even_in_an_older_program(self):
        for fid in ("dividend-sequences", "instruction-text"):
            self.field(fid).pop("extensions")
        f = self.field("instruction-text")
        f.update({"label": "Debriefing text", "origin": "researcher", "state": "check", "value": INSTRUCTIONS})
        self.program["issues"] = []
        self.assertTrue(any("participant material with no source" in p for p in self.problems()), "origin researcher")
        f["origin"] = "unknown"
        self.assertTrue(any("participant material with no source" in p for p in self.problems()), "origin unknown")
        # disclosed for the researcher's decision: a note in an older program
        f.update({"origin": "implementation", "state": "decision"})
        self.program["issues"] = [dict(FIXTURE["issues"][0], title="Debriefing text written for the replay")]
        report = self.check()
        self.assertEqual(report["problems"], [])
        self.assertTrue(any("participant material with no source" in n for n in report["notes"]))

    def test_structure_stated_by_the_researcher(self):
        f = self.field("dividend-sequences")
        f.update({"origin": "researcher", "evidenceIds": [], "value": {"order": "random per participant"}})
        self.assertTrue(any("asked and answer" in p for p in self.problems()))
        f["extensions"]["material"].update({"asked": "2026-11-03", "answer": "decisions were in random order"})
        self.assertEqual(self.problems(), [])

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
        self.assertTrue(any("not 'verbatim'" in p for p in self.problems()))
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
        self.assertTrue(any("claims a source" in p for p in found) and any("state missing" in p for p in found), found)

    def open_item(self, rel="sources/open/instructions.txt"):
        self.write(rel, INSTRUCTIONS)
        self.program["evidence"].append({"id": "ev-open", "path": rel, "locator": {"page": 1}, "quote": INSTRUCTIONS})
        f = self.field("instruction-text")
        f.update({"origin": "verbatim", "state": "confirmed", "value": INSTRUCTIONS, "evidenceIds": ["ev-open"]})
        f["extensions"]["material"].update({"status": "found-open", "search": [
            {"where": "OSF project linked on p. 11", "url": "https://osf.io/abcde/files/instructions.txt", "found": True}]})
        self.program["issues"] = []
        return rel

    def provenance(self, rel, license="CC-BY-4.0", evidence="OSF project page: License CC-By Attribution 4.0"):
        return dict(licenses={rel: license}, evidence={rel: evidence},
                    extra={"url": {rel: "https://osf.io/abcde/files/instructions.txt"},
                           "linkedToPaper": {rel: "OSF project linked from the paper, p. 11"},
                           "version": {rel: "OSF files as of 2026-11-03"}})

    def test_open_source_needs_its_full_record_and_an_open_license(self):
        rel = self.open_item()
        found = self.problems()
        self.assertTrue(any("lacks url, license, linkedToPaper, version" in p or "lacks url" in p for p in found), found)
        self.assertTrue(any("without an open license" in p for p in found), found)
        self.assertEqual(self.problems(**self.provenance(rel)), [])
        # a license named without saying where it is stated is not enough
        self.assertTrue(any("without an open license" in p for p in self.problems(**self.provenance(rel, evidence="ok"))))
        # no record of where the build searched
        self.assertTrue(any("no `searches`" in p for p in self.problems(searches=False, **self.provenance(rel))))

    def test_open_source_value_must_occur_in_the_file(self):
        rel = self.open_item()
        self.field("instruction-text")["value"] = "Welcome. Please pick the stock that you think will pay the most money."
        self.assertTrue(any("does not occur in" in p for p in self.problems(**self.provenance(rel))))

    def test_open_source_without_an_open_license_goes_private(self):
        rel = self.open_item()
        self.assertTrue(any("without an open license" in p for p in self.problems(
            **self.provenance(rel, license="unknown", evidence="no license stated on the OSF page"))))
        # the same file kept under sources/private/ is usable, as a reference, in this project only
        (self.root / rel).unlink()
        priv = "sources/private/instructions.txt"
        self.write(priv, INSTRUCTIONS)
        f = self.field("instruction-text")
        f.update({"value": {"file": priv}, "evidenceIds": ["ev-instr"]})
        f["extensions"]["material"].update({"status": "found-private", "file": priv})
        self.program["evidence"] = [e for e in self.program["evidence"] if e["id"] != "ev-open"]
        self.assertEqual(self.problems(**self.provenance(priv, license="unknown", evidence="no license stated")), [])
        record = json.loads((self.root / "sources/SOURCE.json").read_text(encoding="utf-8"))
        self.assertTrue(next(x for x in record["files"] if x["path"] == priv)["private"])
        self.assertIn(priv, check_materials.private_paths(self.root))
        f["value"] = INSTRUCTIONS
        self.assertTrue(any("holds the material's text" in p for p in self.problems(
            **self.provenance(priv, license="unknown", evidence="none"))))

    def test_open_source_short_strings_and_keys_must_be_in_the_file(self):
        rel = self.open_item()
        self.field("instruction-text")["value"] = ["Please choose", "carefully now", "press space"]
        self.assertTrue(any("does not occur in" in p for p in self.problems(**self.provenance(rel))))
        self.field("instruction-text")["value"] = {"Read every word of this before you go on": INSTRUCTIONS}
        self.assertTrue(any("does not occur in" in p for p in self.problems(**self.provenance(rel))))
        # a structural single-word key around file text is fine
        self.field("instruction-text")["value"] = {"text": INSTRUCTIONS}
        self.assertFalse(any("does not occur in" in p for p in self.problems(**self.provenance(rel))))

    def test_license_evidence_saying_there_is_none_is_refused(self):
        rel = self.open_item()
        self.assertTrue(any("without an open license" in p for p in self.problems(
            **self.provenance(rel, evidence="OSF page: no license stated"))))

    def test_found_private_needs_its_search_entry(self):
        priv = "sources/private/instructions.txt"
        self.write(priv, INSTRUCTIONS)
        f = self.field("instruction-text")
        f.update({"origin": "verbatim", "state": "confirmed", "value": {"file": priv}})
        f["extensions"]["material"].update({"status": "found-private", "file": priv})
        self.program["issues"] = []
        prov = self.provenance(priv, license="unknown", evidence="none stated")
        self.assertTrue(any("found-private needs the search entry" in p for p in self.problems(**prov)))
        f["extensions"]["material"]["search"].append(
            {"where": "OSF project", "url": "https://osf.io/abcde/files/instructions.txt", "found": True})
        self.assertEqual(self.problems(**prov), [])

    def test_participant_data_is_never_a_source(self):
        # by name
        self.write("sources/open/study01_data.csv", "a,b\n1,2\n")
        self.assertTrue(any("participant data" in p for p in self.problems()))
        (self.root / "sources/open/study01_data.csv").unlink()
        # renamed, found by its columns
        self.write("sources/open/stimuli.csv", "subject,trial_index,rt,choice\n1,1,532,left\n")
        self.assertTrue(any("participant data" in p and "columns" in p for p in self.problems()))
        (self.root / "sources/open/stimuli.csv").unlink()
        self.write("sources/open/sequences.csv", "pp,trial,latency_ms,resp_key\n1,1,532,f\n")
        self.assertTrue(any("participant data" in p and "columns" in p for p in self.problems()))
        (self.root / "sources/open/sequences.csv").unlink()
        # JSON records of responses, and data dropped anywhere under sources/
        self.write("sources/open/sequences.json", json.dumps([{"participant": 1, "trial": 1, "choice": "A", "rt": 512}]))
        self.assertTrue(any("sequences.json looks like participant data" in p for p in self.problems()))
        (self.root / "sources/open/sequences.json").unlink()
        self.write("sources/osf/raw_data.csv", "x\n1\n")
        self.assertTrue(any("raw_data.csv looks like participant data" in p for p in self.problems()))
        (self.root / "sources/osf/raw_data.csv").unlink()
        # a path that climbs out of sources/ into human-data/
        self.write("human-data/s1.csv", "pp,latency_ms\n1,500\n")
        self.program["evidence"].append({"id": "ev-up", "path": "sources/../human-data/s1.csv", "locator": {"page": 1}})
        self.field("dividend-sequences")["evidenceIds"].append("ev-up")
        self.assertTrue(any("cites human-data/s1.csv" in p for p in self.problems()))
        self.field("dividend-sequences")["evidenceIds"].remove("ev-up")
        # cited from human-data/
        self.write("human-data/trials.csv", "participant,trial,choice,rt\n1,1,A,500\n")
        self.program["evidence"].append({"id": "ev-hd", "path": "human-data/trials.csv", "locator": {"page": 1}})
        self.field("dividend-sequences")["evidenceIds"].append("ev-hd")
        self.assertTrue(any("cites human-data/trials.csv" in p for p in self.problems()))
        self.field("dividend-sequences")["evidenceIds"].remove("ev-hd")
        # cited as the basis of a schema-enough sequence
        self.write("sources/osf/s1.csv", "participant_id,response\n1,2\n")
        self.program["evidence"].append({"id": "ev-data", "path": "sources/osf/s1.csv", "locator": {"page": 1}, "quote": "x"})
        self.field("dividend-sequences")["evidenceIds"].append("ev-data")
        self.assertTrue(any("cites sources/osf/s1.csv" in p for p in self.problems()))

    def test_stand_in_and_left_out_need_the_researchers_answer(self):
        f = self.field("instruction-text")
        f.update({"origin": "implementation", "state": "confirmed", "value": "Choose LEFT or RIGHT."})
        f["extensions"]["material"]["status"] = "stand-in"
        self.program["issues"] = []
        found = self.problems()
        self.assertTrue(any("says so in its label" in p for p in found) and any("asked (the date) and answer" in p for p in found), found)
        f["label"] = "Instruction screen text (stand-in accepted by the researcher)"
        f["extensions"]["material"]["answer"] = "use a labelled stand-in"
        self.assertEqual(self.problems(), [])
        f["extensions"]["material"]["asked"] = None
        self.assertTrue(any("asked (the date) and answer are required" in p for p in self.problems()),
                        "no acceptance without the question")
        f["extensions"]["material"]["asked"] = "2026-11-03"
        # left out: no value, and capabilities.json excludes it
        f.update({"origin": "unknown", "state": "missing", "value": None})
        f["extensions"]["material"].update({"status": "left-out", "answer": "leave the instructions out"})
        self.program["issues"] = [dict(FIXTURE["issues"][0], title="Left out by the researcher: Study 1 instruction screens")]
        self.assertTrue(any("run.excluded does not name it" in p for p in self.problems()), "capabilities.json absent")
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
        self.assertTrue(any("holds the material's text" in p for p in found), found)
        self.assertTrue(any("program.json copies the private material" in p for p in found), found)
        self.supply()
        self.write("package/p/materials/materials.json", json.dumps({"s1": {"instructions": INSTRUCTIONS}}))
        self.assertTrue(any("materials.json copies the private material" in p for p in self.problems()))
        self.write("package/p/materials/materials.json", "{}")
        self.write("package/p/task/adapter.py", 'INTRO = "%s"\n' % INSTRUCTIONS.replace(". ", ".\\n"))
        self.assertTrue(any("adapter.py copies the private material" in p for p in self.problems()))
        self.write("package/p/task/adapter.py", "pass\n")
        # an identical copy of the file, and a copy inside a Word document whose words are split into runs
        self.write("package/p/materials/s1.txt", INSTRUCTIONS)
        self.assertTrue(any("s1.txt copies the private material" in p for p in self.problems()))
        (self.root / "package/p/materials/s1.txt").unlink()
        runs = "".join("<w:r><w:t>%s</w:t></w:r>" % w for w in re.findall(r"\S+\s*", INSTRUCTIONS))
        with zipfile.ZipFile(self.root / "package/p/materials/s1.docx", "w") as z:
            z.writestr("word/document.xml", "<w:document><w:body><w:p>%s</w:p></w:body></w:document>" % runs)
        self.assertTrue(any("s1.docx copies the private material" in p for p in self.problems()))

    def test_supplied_file_outside_the_researcher_folder_fails(self):
        self.supply()
        self.write("sources/s1-instructions.txt", INSTRUCTIONS)
        self.material("instruction-text")["file"] = "sources/s1-instructions.txt"
        self.assertTrue(any("must be a file under sources/researcher/" in p for p in self.problems()))

    def test_numbered_and_tabular_items_are_found_without_their_numbers(self):
        self.supply()
        self.write("sources/researcher/s1-instructions.txt", "1. I often feel lonely at night\n2. I sleep well\n")
        self.write("package/p/materials/materials.json", json.dumps({"q": "I often feel lonely at night"}))
        self.assertTrue(any("copies the private material" in p for p in self.problems()))
        (self.root / "sources/researcher/s1-instructions.txt").unlink()
        self.write("sources/researcher/items.csv", "id,text\n1,I often feel lonely at night\n")
        self.material("instruction-text")["file"] = "sources/researcher/items.csv"
        self.field("instruction-text")["value"] = {"file": "sources/researcher/items.csv"}
        self.assertTrue(any("copies the private material" in p for p in self.problems()))

    def test_private_text_in_json_keys_is_found(self):
        self.supply()
        self.write("package/p/materials/materials.json", json.dumps({"screens": {INSTRUCTIONS: "s1"}}))
        self.assertTrue(any("materials.json copies the private material" in p for p in self.problems()))

    def test_private_file_without_readable_text_needs_a_text_copy(self):
        self.supply()
        (self.root / "sources/researcher/scan.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00")
        self.assertTrue(any("no readable text" in p for p in self.problems()))
        self.write("sources/researcher/scan.txt", "The words on the scanned instruction sheet, as supplied.")
        self.assertFalse(any("no readable text" in p for p in self.problems()))

    def test_researcher_answer_does_not_excuse_wording(self):
        self.program["nodes"][0]["fields"].append({
            "id": "welcome-screen", "label": "Welcome screen", "origin": "researcher", "state": "confirmed",
            "value": INSTRUCTIONS, "evidenceIds": [], "extensions": {"material": {
                "kind": "schema-enough", "what": "Study 1 welcome screen", "mentioned": "p. 3",
                "asked": "2026-11-03", "answer": INSTRUCTIONS}}})
        found = self.problems()
        self.assertTrue(any("never schema-enough" in p for p in found) and any("holds prose" in p for p in found), found)

    def test_short_scale_items_are_found(self):
        self.supply()
        self.write("sources/researcher/s1-instructions.txt", "I feel calm right now\nI worry about the future a lot\n")
        self.write("package/p/materials/materials.json", json.dumps({"items": [{"id": "q7", "text": "I worry about the future a lot"}]}))
        self.assertTrue(any("materials.json copies the private material" in p for p in self.problems()))

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
        record = json.loads(zipfile.ZipFile(result["file"]).read("sources/SOURCE.json"))
        self.assertFalse([f for f in record["files"] if "researcher" in f["path"]], "not even their records")
        # a simulation log that copies the text is left out and listed
        self.write("artifacts/simulations/r1/sessions.jsonl", json.dumps({"prompt": INSTRUCTIONS}) + "\n")
        result = community.export(self.root, self.root / "exports/community-2.zip")
        archive = zipfile.ZipFile(result["file"])
        self.assertNotIn("artifacts/simulations/r1/sessions.jsonl", archive.namelist())
        self.assertEqual([o["path"] for o in json.loads(archive.read("CONTRIBUTION.json"))["omitted"]],
                         ["artifacts/simulations/r1/sessions.jsonl"])
        # a copy in the program or the package stops the export
        self.write("package/p/materials/materials.json", json.dumps({"intro": INSTRUCTIONS}))
        with self.assertRaises(ValueError):
            community.export(self.root, self.root / "exports/community-3.zip")
        self.assertFalse((self.root / "exports/community-3.zip").exists())

    def test_cli_prints_pass_and_counts(self):
        self.check()
        run = subprocess.run([sys.executable, str(BUILD / "check_materials.py"), str(self.root)],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stdout)
        self.assertIn("needs-original/pending 1", run.stdout)
        self.assertIn("schema-enough 1", run.stdout)
        self.assertIn("PASS materials", run.stdout)

    def test_unclassified_missing_material_fails_a_new_build_and_is_a_note_in_an_older_one(self):
        del self.field("instruction-text")["extensions"]
        self.assertTrue(any("classify it" in p for p in self.problems()), "the program uses the rule: classify all")
        del self.field("dividend-sequences")["extensions"]
        report = self.check()
        self.assertEqual(report["problems"], [], "an older program keeps passing the readiness gate")
        self.assertTrue(any("classify it" in n for n in report["notes"]))


if __name__ == "__main__":
    unittest.main()
