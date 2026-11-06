"""Claims that material is "not printed / not public" against the sources the build holds; search completeness;
survey files read verbatim (pictures, opt-out boxes, display logic); licences of loose supplements and of the batch
list. Synthetic projects only; no network (the one request function is replaced by canned answers).
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
sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_materials  # noqa: E402
import check_source_use  # noqa: E402
import check_verbatim  # noqa: E402
import fetch_source  # noqa: E402
import qsf_flow  # noqa: E402
import sources  # noqa: E402
from test_fetch_source import Scripted  # noqa: E402
from test_qsf_flow import block, db, mc, selected, survey  # noqa: E402

QSF = "sources/open/survey.qsf"
CUP = '<img src="https://example.qualtrics.com/ControlPanel/Graphic.php?IM=IM_cup" alt="cup">'
INTRO = "Imagine you are shopping for a set of dinnerware at a clearance sale in town."
POLICY = "How much do you support a carbon tax on fossil fuel companies in your country?"


def slider(qid, text, labels, na=None):
    q = {"QuestionID": qid, "DataExportTag": qid.lower(), "QuestionType": "Slider", "Selector": "HSLIDER",
         "QuestionText": text, "Choices": {"1": {"Display": "Support"}}, "ChoiceOrder": ["1"],
         "Configuration": {"CSSliderMin": 0, "CSSliderMax": 100, "GridLines": 4, "NotApplicable": bool(na)},
         "Labels": {str(i + 1): {"Display": t} for i, t in enumerate(labels)},
         "Validation": {"Settings": {"Type": "None"}}}
    if na:
        q["Labels"]["NA"] = {"Display": na}
    return q


def qsf_fixture():
    questions = [
        db("QID1", "<p>%s</p>%s" % (INTRO, CUP)),
        slider("QID2", POLICY, ["Not at all", "Somewhat", "Very much"], na="Not Applicable"),
        mc("QID3", "Did you donate to any climate organisation during the past twelve months of this year?",
           ["Yes", "No"]),
        db("QID4", "Please tell us which climate organisation you donated to and how much money you gave in total.",
           DisplayLogic={"0": {"0": selected("QID3", "1"), "Type": "If"}, "Type": "BooleanExpression"}),
    ]
    blocks = [block("BL_1", "Main", ["QID1", "|", "QID2", "|", "QID3", "|", "QID4"])]
    flow = [{"Type": "Block", "ID": "BL_1", "FlowID": "FL_2"}]
    return survey(questions, blocks, flow)


class Project(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="claims-test-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.program = {"id": "p", "source": {"title": "A study", "filename": "paper.pdf"},
                        "nodes": [{"id": "m", "kind": "material", "fields": []}], "steps": [], "issues": [],
                        "evidence": [{"id": "ev-qsf", "path": QSF, "locator": {"qid": "QID2"}}]}
        self.write(QSF, qsf_fixture())
        self.write("package/paper/task/task.json", {"conditions": [{"id": "a"}]})
        self.write("package/paper/task/adapter.py", "def run_sessions(llm, seed, n, arms=None):\n    return []\n")
        self.write("package/paper/task/replies.py", "# the shared reply reader: current contract\n")

    def write(self, rel, data):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(data, bytes):
            path.write_bytes(data)
        else:
            path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")

    def save(self, materials=None, fields=None):
        if fields is not None:
            self.program["nodes"][0]["fields"] = fields
        self.write("program.json", self.program)
        if materials is not None:
            self.write("package/paper/materials/materials.json", materials)


class Survey(Project):
    """qsf_flow.py: pictures, opt-out boxes and display logic a transcription drops without saying so."""

    def test_slider_anchors_are_the_numbered_labels_and_na_is_an_opt_out(self):
        questions = qsf_flow._questions(qsf_fixture())
        q = qsf_flow._question(questions["QID2"], questions, [])
        self.assertEqual(q["scale"]["labels"], ["Not at all", "Somewhat", "Very much"])
        self.assertEqual(q["scale"]["not_applicable"], "Not Applicable")

    def test_picture_dropped_without_saying_so_fails_and_a_declared_one_passes(self):
        self.save({"source": QSF, "screens": [{"id": "intro", "text": INTRO}]})
        found = [m for m, _ in qsf_flow.problems(self.root)]
        self.assertTrue(any("QID1" in m and "picture" in m.lower() for m in found), found)
        self.save({"source": QSF, "screens": [{"id": "intro", "text": INTRO, "images": "missing: the cup picture"}]})
        self.assertFalse([m for m, _ in qsf_flow.problems(self.root) if "QID1" in m])

    def test_opt_out_listed_as_an_anchor_fails(self):
        self.save({"source": QSF, "screens": [{"id": "policy", "qid": "QID2", "text": POLICY,
                                               "anchors": ["Not Applicable", "Not at all", "Somewhat", "Very much"]}]})
        found = [m for m, _ in qsf_flow.problems(self.root)]
        self.assertTrue(any("Not Applicable" in m and "anchors" in m for m in found), found)
        self.save({"source": QSF, "screens": [{"id": "policy", "qid": "QID2", "text": POLICY,
                                               "anchors": ["Not at all", "Somewhat", "Very much"]}]})
        self.assertFalse([m for m, _ in qsf_flow.problems(self.root) if "Not Applicable" in m])

    def test_display_logic_asked_in_the_same_prompt_fails(self):
        q3 = "Did you donate to any climate organisation during the past twelve months of this year?"
        q4 = "Please tell us which climate organisation you donated to and how much money you gave in total."
        self.save({"source": QSF, "questions": [{"id": "donated", "text": q3}, {"id": "which", "text": q4}]})
        found = [m for m, _ in qsf_flow.problems(self.root)]
        self.assertTrue(any("QID4" in m and "same prompt" in m for m in found), found)


class Verbatim(Project):
    """check_verbatim.py reads .qsf question and choice text, and reports an opt-out shown as an anchor."""

    def test_qsf_text_is_checked_and_opt_out_as_anchor_fails(self):
        field = {"id": "policy", "origin": "verbatim", "state": "confirmed", "evidenceIds": ["ev-qsf"],
                 "value": {"text": POLICY, "anchors": ["Not at all", "Somewhat", "Very much"]}}
        self.save(fields=[field])
        statuses = {r["field"]: r["status"] for r in check_verbatim.check(self.root / "program.json")["results"]}
        self.assertEqual(statuses["m.policy"], "found")
        field["value"] = {"text": POLICY.replace("support", "back"), "anchors": ["Not at all", "Very much"]}
        self.save(fields=[field])
        statuses = {r["field"]: r["status"] for r in check_verbatim.check(self.root / "program.json")["results"]}
        self.assertNotEqual(statuses["m.policy"], "found")
        field["value"] = {"text": POLICY, "anchors": ["Not Applicable", "Not at all", "Somewhat", "Very much"]}
        self.save(fields=[field])
        statuses = {r["field"]: r["status"] for r in check_verbatim.check(self.root / "program.json")["results"]}
        self.assertEqual(statuses["m.policy"], "opt_out_as_anchor")

    def test_a_reference_to_a_file_is_not_a_transcription(self):
        field = {"id": "survey", "origin": "verbatim", "state": "confirmed", "evidenceIds": ["ev-qsf"],
                 "value": {"file": QSF}}
        self.save(fields=[field])
        statuses = {r["field"]: r["status"] for r in check_verbatim.check(self.root / "program.json")["results"]}
        self.assertEqual(statuses["m.survey"], "reference")


class Claims(Project):
    """check_source_use.py: a "not printed / not public" claim must survive the sources the build holds."""

    def failures(self, *items):
        self.write("artifacts/failures.json", list(items))

    def filler(self):
        for i, topic in enumerate(["payment of participants", "the lottery draw", "exclusion of late answers",
                                   "the consent form", "the attention check", "the recruitment platform"]):
            self.write("sources/open/notes%d.txt" % i, "This page describes %s for the study and the sample." % topic)

    def test_claim_contradicted_by_a_source_needs_a_record_of_that_page(self):
        self.filler()
        self.save(fields=[])
        self.failures({"pattern": "materials-not-public", "where": "Dinnerware intro screen",
                       "what": "The dinnerware shopping clearance sale introduction is not public."})
        found = [m for m, _ in check_source_use.problems(self.root) if m.startswith("claims:")]
        self.assertTrue(any("failures[0]" in m and QSF in m for m in found), found)
        page = next(m for m in found if "failures[0]" in m).split(QSF + " p. ")[1].split(" ")[0]
        record = {"claimsChecked": [{"claim": "failures[0]", "sourcesChecked": [
            {"path": QSF, "pages": page, "prints": False, "found": "only the shopping scenario, no sale screen"}]}]}
        self.write("sources/SOURCE.json", record)
        self.assertFalse([m for m, _ in check_source_use.problems(self.root) if "failures[0]" in m])
        record["claimsChecked"][0]["sourcesChecked"][0]["prints"] = True
        self.write("sources/SOURCE.json", record)
        self.assertTrue([m for m, _ in check_source_use.problems(self.root) if "prints what" in m])

    def test_unrelated_claim_passes(self):
        self.filler()
        self.save(fields=[])
        self.failures({"pattern": "materials-not-public", "where": "Debriefing",
                       "what": "The debriefing wording for the lottery payment is not printed."})
        self.assertEqual([m for m, _ in check_source_use.problems(self.root) if m.startswith("claims:")], [])

    def test_unread_pages_block_a_claim_until_recorded(self):
        pages = {"paper.pdf": ["text " * 30, "", "text " * 30], QSF: ["question text " * 10]}
        self.assertEqual(check_source_use.unread_pages(pages), {"paper.pdf": [2]})
        self.save(fields=[])
        self.failures({"pattern": "materials-not-public", "where": "Instruction screenshots",
                       "what": "The instruction screens are not printed."})
        original = check_source_use.source_pages
        check_source_use.source_pages = lambda root: pages
        self.addCleanup(setattr, check_source_use, "source_pages", original)
        found = [m for m, _ in check_source_use.problems(self.root) if "no text layer" in m]
        self.assertTrue(found and "paper.pdf pp. 2" in found[0], found)
        self.write("sources/SOURCE.json", {"pagesRead": [{"path": "paper.pdf", "pages": "2", "how": "rendered",
                                                          "holds": "a figure of the payoff table"}]})
        self.assertFalse([m for m, _ in check_source_use.problems(self.root) if "no text layer" in m])

    def test_located_open_material_not_imported_contradicts_a_gap(self):
        self.save(fields=[])
        self.failures({"pattern": "materials-not-public", "where": "Design materials",
                       "what": "The materials of the other 44 designs are not public."})
        self.write("sources/SOURCE.json", {"searches": [
            {"where": "OSF project", "url": "https://osf.io/abcde/",
             "result": "found 45 design folders (CC-BY 4.0); only design XUW82 was imported"}]})
        found = [m for m, _ in check_source_use.problems(self.root)]
        self.assertTrue(any("located and not imported" in m for m in found), found)


class Searches(Project):
    """check_materials.py: what a search could not read, OSF components listed, author data recorded."""

    def setUp(self):
        super().setUp()
        self.write("paper.pdf", b"%PDF-1.4 stand-in")
        self.save(fields=[])

    def findings(self):
        report = check_materials.check(self.root, self.root / "package/paper")
        return [m for m, _ in report["problems"]]

    def test_refused_page_recorded_as_nothing_found_fails(self):
        self.write("sources/SOURCE.json", {"searches": [
            {"where": "journal original site", "url": "https://journal.example.org/15/151029/",
             "result": "nothing: HTTP 403, no supplement or data links found"}]})
        self.assertTrue(any("could not be read" in m for m in self.findings()))
        self.write("sources/SOURCE.json", {"searches": [
            {"where": "journal original site", "url": "https://journal.example.org/15/151029/",
             "result": "not checked: HTTP 403"}]})
        self.assertFalse(any("could not be read" in m for m in self.findings()))
        self.assertTrue(check_materials.unread_search("not checked: HTTP 403"))

    def osf_record(self, listing=None, **extra):
        record = {"files": [{"path": "sources/open/survey.qsf", "license": "CC-BY-4.0",
                             "licenseEvidence": "OSF licence lookup", "url": "https://osf.io/download/qqqqq/",
                             "sha256": "aa" * 32}],
                  "licenceLookups": [{"url": "https://osf.io/qqqqq/", "license": "CC-BY-4.0",
                                      "projects": [{"id": "comp1", "type": "nodes"}]}]}
        if listing is not None:
            record["osfListings"] = [listing]
        record.update(extra)
        self.write("sources/SOURCE.json", record)

    def test_every_file_of_a_used_osf_component_is_listed(self):
        self.osf_record()
        self.assertTrue(any("OSF component comp1" in m for m in self.findings()))
        listing = {"node": "comp1", "files": [
            {"name": "survey.qsf", "path": "/survey.qsf", "use": "fetched"},
            {"name": "Appendix C sample survey.pdf", "path": "/Appendix C sample survey.pdf"},
            {"name": "data.csv", "path": "/data.csv", "data": True, "use": "not fetched (participant data)",
             "reason": "its name"}]}
        self.osf_record(listing)
        found = self.findings()
        self.assertTrue(any("no use or no reason" in m and "Appendix C" in m for m in found), found)
        self.assertTrue(any("authorData" in m for m in found), "listed data must be recorded as existing")
        listing["files"][1].update({"use": "not fetched", "reason": "an earlier pilot's survey, not this study's"})
        self.osf_record(listing, authorData={"exists": True, "where": "https://osf.io/comp1/", "fetched": False})
        self.assertEqual([m for m in self.findings() if "comp1" in m or "authorData" in m], [])
        listing["files"][2]["use"] = "fetched"
        self.osf_record(listing, authorData={"exists": True, "where": "https://osf.io/comp1/", "fetched": True})
        found = self.findings()
        self.assertTrue(any("participant data were fetched" in m for m in found))
        self.assertTrue(any("authorData says" in m for m in found))

    def test_unlicensed_supplement_in_the_sources_root_is_private(self):
        text = "Josie went on vacation to France and bought a small painting at the market there."
        self.write("sources/supplement.txt", text)
        self.write("sources/SOURCE.json", {"files": [{"path": "sources/supplement.txt", "license": "unknown"}]})
        self.write("package/paper/materials/materials.json", {"items": [text]})
        found = self.findings()
        self.assertTrue(any("sources/supplement.txt is in sources/ but not in" in m for m in found), found)
        self.assertTrue(any("copies the private material sources/supplement.txt" in m for m in found), found)
        self.assertIn("sources/supplement.txt", check_materials.private_paths(self.root))
        # an older-contract project gets a warning only
        (self.root / "package/paper/task/replies.py").unlink()
        report = check_materials.check(self.root, self.root / "package/paper")
        self.assertTrue(any("is in sources/ but not in" in m for m, _ in report["warnings"]))


class Licences(Project):
    def test_supplement_of_a_cc_by_article_is_noted_and_kept_unknown(self):
        self.write("paper.pdf", b"%PDF-1.4 stand-in")
        self.write("sources/esm.pdf", b"%PDF-1.4 supplement")
        self.save(fields=[])
        with contextlib.redirect_stdout(io.StringIO()):
            sources.main([str(self.root), "--license", "paper.pdf=CC-BY-4.0"])
        record = json.loads((self.root / "sources/SOURCE.json").read_text())
        esm = next(f for f in record["files"] if f["path"] == "sources/esm.pdf")
        self.assertEqual(esm["license"], "unknown")
        self.assertTrue(esm["licenseNote"].startswith("supplement of CC BY article, no own licence"))
        qsf = next(f for f in record["files"] if f["path"] == QSF)
        self.assertNotIn("licenseNote", qsf, "files under sources/open/ carry their own licence")

    def test_batch_list_disagreeing_with_source_json_is_flagged(self):
        batch = self.root.parent / ("batch-" + self.root.name)
        project = batch / "runs" / "paper2020x"
        shutil.copytree(self.root, project)
        self.addCleanup(shutil.rmtree, batch, True)
        (project / "paper.pdf").write_bytes(b"%PDF-1.4 stand-in")
        (project / "sources/esm.pdf").write_bytes(b"%PDF-1.4 supplement")
        (batch / "SOURCES.json").write_text(json.dumps([
            {"slug": "paper2020x", "materialsLicence": "ESM under article CC BY; OSF qqqqq: NO licence stated",
             "supplements": ["esm.pdf"]}]), encoding="utf-8")
        with contextlib.redirect_stdout(io.StringIO()):
            sources.main([str(project), "--license", "paper.pdf=CC-BY-4.0", "--license", QSF + "=CC-BY-4.0"])
        data = json.loads((project / "sources/SOURCE.json").read_text())
        for f in data["files"]:
            if f["path"] == QSF:
                f["url"] = "https://osf.io/download/qqqqq/"
        data["licenceLookups"] = [{"url": "https://osf.io/qqqqq/", "projects": [{"id": "qqqqq"}]}]
        (project / "sources/SOURCE.json").write_text(json.dumps(data), encoding="utf-8")
        found = [m for m, _ in sources.problems(project)]
        self.assertTrue(any("sources/esm.pdf with license unknown" in m for m in found), found)
        self.assertTrue(any(QSF + " as CC-BY-4.0" in m and "NO licence" in m for m in found), found)
        for f in data["files"]:
            f["batchLicence"] = "the list is wrong: checked the file and its page"
        (project / "sources/SOURCE.json").write_text(json.dumps(data), encoding="utf-8")
        self.assertFalse([m for m, _ in sources.problems(project) if "batch list" in m])


def osf_folder_page(items, next_url=None):
    return json.dumps({"data": items, "links": {"next": next_url}}).encode()


def osf_item(name, path, kind="file", sha=None, related=None):
    item = {"attributes": {"kind": kind, "name": name, "materialized_path": path, "size": 10,
                           "extra": {"hashes": {"sha256": sha}} if sha else {}}}
    if related:
        item["relationships"] = {"files": {"links": {"related": {"href": related}}}}
    return item


class Listing(unittest.TestCase):
    """fetch_source.py --list: every file of a component, metadata only; data are marked, never fetched."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="listing-test-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / "paper.pdf").write_bytes(b"%PDF-1.4 stand-in")
        (self.root / "program.json").write_text(json.dumps({"evidence": []}), encoding="utf-8")
        self.addCleanup(setattr, fetch_source, "_open", fetch_source._open)

    def test_lists_every_folder_and_page_and_marks_data(self):
        base = "https://api.osf.io/v2/nodes/comp1/files/osfstorage/"
        held = "ab" * 32
        fetch_source._open = Scripted({
            "https://api.osf.io/v2/files/comp1/": [404],
            base + "?page[size]=100": [osf_folder_page(
                [osf_item("survey.qsf", "/survey.qsf", sha=held.upper()),
                 osf_item("Data", "/Data/", kind="folder", related=base + "data1/")],
                next_url=base + "?page=2")],
            base + "?page=2": [osf_folder_page([osf_item("Appendix C.pdf", "/Appendix C.pdf", sha="cd" * 32)])],
            base + "data1/": [osf_folder_page([osf_item("study1.csv", "/Data/study1.csv"),
                                               osf_item("codebook notes.pdf", "/Data/codebook notes.pdf")])]})
        record = fetch_source.osf_listing("https://osf.io/comp1/")
        names = {f["name"]: f for f in record["files"]}
        self.assertEqual(set(names), {"survey.qsf", "Appendix C.pdf", "study1.csv", "codebook notes.pdf"})
        self.assertTrue(names["study1.csv"]["data"])
        self.assertTrue(names["codebook notes.pdf"]["data"], "a file in a data folder is data")
        self.assertNotIn("use", names["Appendix C.pdf"])
        self.assertEqual(record["listed"], "complete")
        self.assertFalse(any("download" in r.full_url for r in fetch_source._open.requests), "metadata only")
        (self.root / "sources/open").mkdir(parents=True)
        (self.root / "sources/SOURCE.json").write_text(json.dumps({"files": [
            {"path": "sources/open/survey.qsf", "sha256": held}]}), encoding="utf-8")
        data = fetch_source.record_listing(self.root, record)
        listed = {f["name"]: f for f in data["osfListings"][0]["files"]}
        self.assertEqual((listed["survey.qsf"]["use"], listed["survey.qsf"]["file"]), ("fetched", "sources/open/survey.qsf"))
        # a second listing keeps what the build said about a file
        listed["Appendix C.pdf"].update({"use": "not fetched", "reason": "another site's copy"})
        (self.root / "sources/SOURCE.json").write_text(json.dumps(data), encoding="utf-8")
        again = fetch_source.record_listing(self.root, fetch_source.osf_listing("https://osf.io/comp1/"))
        self.assertEqual(len(again["osfListings"]), 1)
        self.assertEqual({f["name"]: f.get("reason") for f in again["osfListings"][0]["files"]}["Appendix C.pdf"],
                         "another site's copy")

    def test_a_component_without_public_files_is_refused(self):
        fetch_source._open = Scripted({"https://api.osf.io/v2/files/gone1/": [404],
                                       "https://api.osf.io/v2/nodes/gone1/files/osfstorage/?page[size]=100": [404]})
        with self.assertRaisesRegex(ValueError, "no public files"):
            fetch_source.osf_listing("https://osf.io/gone1/")
        with self.assertRaisesRegex(ValueError, "--list"):
            fetch_source.osf_listing("https://example.org/x/")


if __name__ == "__main__":
    unittest.main()
