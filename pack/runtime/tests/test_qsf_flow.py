"""Qualtrics survey files (qsf_flow.py): the reader follows the survey flow (Trash and unflowed blocks are never
shown, randomizers, display logic, forced vs requested, correct-answer validation, choice order), and the package
check keeps survey text participants never saw out of program.json, materials.json and the adapter.
Synthetic surveys only.
   python -m unittest discover -s pack/runtime/tests"""
from __future__ import annotations

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
import qsf_flow  # noqa: E402


def mc(qid, text, choices, order=None, **extra):
    payload = {
        "QuestionID": qid, "DataExportTag": qid.lower(), "QuestionType": "MC", "Selector": "SAVR",
        "SubSelector": "TX", "QuestionText": text,
        "Choices": {str(i + 1): {"Display": c} for i, c in enumerate(choices)},
        "ChoiceOrder": order or [str(i + 1) for i in range(len(choices))],
        "Validation": {"Settings": {"ForceResponse": "OFF", "Type": "None"}},
    }
    payload.update(extra)
    return payload


def db(qid, text, **extra):
    payload = {"QuestionID": qid, "DataExportTag": qid.lower(), "QuestionType": "DB", "Selector": "TB",
               "QuestionText": text, "Validation": {"Settings": {"Type": "None"}}}
    payload.update(extra)
    return payload


def selected(qid, choice):
    return {"LogicType": "Question", "QuestionID": qid, "Operator": "Selected",
            "LeftOperand": f"q://{qid}/SelectableChoice/{choice}", "Type": "Expression",
            "Description": "<span>ignored</span>"}


def block(bid, description, elements, kind="Standard", options=None):
    return {"ID": bid, "Type": kind, "Description": description, "Options": options or {},
            "BlockElements": [{"Type": "Page Break"} if e == "|" else {"Type": "Question", "QuestionID": e}
                              for e in elements]}


def survey(questions, blocks, flow, blocks_as_dict=True):
    elements = [{"Element": "SQ", "PrimaryAttribute": q["QuestionID"], "Payload": q} for q in questions]
    elements.append({"Element": "BL", "Payload": {str(i): b for i, b in enumerate(blocks)} if blocks_as_dict else blocks})
    if flow is not None:
        elements.append({"Element": "FL", "Payload": {"Type": "Root", "FlowID": "FL_1", "Flow": flow}})
    elements.append({"Element": "SO", "Payload": {"BackButton": "false"}})
    return {"SurveyEntry": {"SurveyID": "SV_1", "SurveyName": "Fixture"}, "SurveyElements": elements}


def custom(qid, choice, force="ON", message="The answer is incorrect. Please choose again."):
    return {"Settings": {"ForceResponse": force, "ForceResponseType": "ON", "Type": "CustomValidation",
                         "CustomValidation": {"Logic": {"0": {"0": selected(qid, choice), "Type": "If"},
                                                        "Type": "BooleanExpression"},
                                              "Message": {"messageID": "MS_1", "description": message}}}}


TRASH = "Unused screener: how serious were you in answering?"
OLD = "Old instructions kept in a block the flow never uses."
LIVE = "Scenario A: the operation succeeded."


def fixture():
    questions = [
        db("QID1", "<p>Please read <strong>carefully</strong>.</p><p>A <u>new</u> page&nbsp;follows.</p>"),
        db("QID2", "Scenario A: the operation <b>succeeded</b>."),
        mc("QID3", "Who decided?", ["Physician", "Patient"], Validation=custom("QID3", "2"),
           Randomization={"Advanced": None, "Type": "All", "TotalRandSubset": ""}),
        mc("QID4", "Have you seen this before?", ["Yes", "No"], order=["2", "1"],
           Validation={"Settings": {"ForceResponse": "ON", "ForceResponseType": "ON", "Type": "None"}}),
        {"QuestionID": "QID5", "DataExportTag": "where", "QuestionType": "TE", "Selector": "SL",
         "QuestionText": "Where?", "Choices": {"1": {"Display": "Click to write Choice 1"}},
         "Validation": {"Settings": {"ForceResponse": "ON", "ForceResponseType": "RequestResponse", "Type": "None"}},
         "DisplayLogic": {"0": {"0": selected("QID4", "1"), "Type": "If"}, "Type": "BooleanExpression",
                          "inPage": True}},
        db("QID6", "Scenario B: the operation failed."),
        mc("QID7", TRASH, ["1 (Not at all)", "5 (Very much)"]),
        db("QID8", "An orphan question that belongs to no block at all."),
        db("QID9", OLD),
        {"QuestionID": "QID10", "DataExportTag": "timer", "QuestionType": "Timing", "Selector": "PageTimer",
         "QuestionText": "Timing"},
    ]
    blocks = [
        block("BL_trash", "Trash / Unused Questions", ["QID7"], kind="Trash"),
        block("BL_intro", "Intro", ["QID1", "QID10"], kind="Default"),
        block("BL_a", "Condition A", ["QID2", "QID3", "|", "QID4", "QID5"]),
        block("BL_b", "Condition B", ["QID6"]),
        block("BL_old", "Old", ["QID9"]),
    ]
    flow = [
        {"Type": "EmbeddedData", "FlowID": "FL_2", "EmbeddedData": [{"Field": "PROLIFIC_PID", "Type": "Recipient"}]},
        {"Type": "Block", "ID": "BL_intro", "FlowID": "FL_3"},
        {"Type": "Branch", "FlowID": "FL_4", "Description": "Bots",
         "BranchLogic": {"0": {"0": {"LogicType": "EmbeddedField", "LeftOperand": "Q_RecaptchaScore",
                                     "Operator": "LessThanOrEqual", "RightOperand": "0.5", "Type": "Expression"},
                               "Type": "If"}, "Type": "BooleanExpression"},
         "Flow": [{"Type": "EndSurvey", "FlowID": "FL_5"}]},
        {"Type": "BlockRandomizer", "FlowID": "FL_6", "SubSet": 1, "EvenPresentation": True, "Flow": [
            {"Type": "Group", "FlowID": "FL_7", "Description": "Arm A", "Flow": [
                {"Type": "EmbeddedData", "FlowID": "FL_8", "EmbeddedData": [{"Field": "arm", "Type": "Custom", "Value": "A"}]},
                {"Type": "Standard", "ID": "BL_a", "FlowID": "FL_9"}]},
            {"Type": "Standard", "ID": "BL_b", "FlowID": "FL_10"}]},
    ]
    return survey(questions, blocks, flow)


class Reader(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="qsf-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_flow_order_randomizer_branch_and_embedded_data(self):
        report = qsf_flow.read_survey(fixture())
        flow = report["flow"]
        self.assertEqual([n["type"] for n in flow], ["embedded_data", "block", "branch", "randomizer"])
        self.assertIsNone(flow[0]["fields"][0]["value"])
        self.assertIn("panel", flow[0]["fields"][0]["set_by"])
        self.assertEqual(flow[2]["condition"], "embedded data Q_RecaptchaScore ≤ 0.5")
        self.assertEqual(flow[2]["elements"][0]["type"], "end_survey")
        rand = flow[3]
        self.assertEqual((rand["present"], rand["of"], rand["evenly"]), (1, 2, True))
        self.assertIn("evenly presented", rand["summary"])
        group = rand["elements"][0]
        self.assertEqual(group["elements"][0]["fields"][0], {"field": "arm", "value": "A", "set_by": "the survey flow"})
        self.assertEqual(report["block_order"], ["BL_intro", "BL_a", "BL_b"])
        self.assertIs(report["survey"]["options"]["back_button"], False)

    def test_trash_and_unflowed_blocks_are_not_reachable(self):
        report = qsf_flow.read_survey(fixture())
        blocks = {b["id"]: b["reason"] for b in report["not_reachable"]["blocks"]}
        self.assertEqual(set(blocks), {"BL_trash", "BL_old"})
        self.assertIn("Trash", blocks["BL_trash"])
        self.assertIn("not in the survey flow", blocks["BL_old"])
        questions = {q["qid"]: q["reason"] for q in report["not_reachable"]["questions"]}
        self.assertEqual(set(questions), {"QID7", "QID8", "QID9"})
        self.assertIn("no block", questions["QID8"])
        shown = {q["qid"] for b in report["blocks"].values() for q in b["questions"]}
        self.assertNotIn("QID7", shown)
        self.assertLessEqual({"QID1", "QID3", "QID5"}, shown)

    def test_question_details(self):
        report = qsf_flow.read_survey(fixture())
        self.assertEqual([p["questions"] for p in report["blocks"]["BL_a"]["pages"]], [["QID2", "QID3"], ["QID4", "QID5"]])
        q = {x["qid"]: x for b in report["blocks"].values() for x in b["questions"]}
        self.assertIn("**carefully**", q["QID1"]["text"])
        self.assertIn("<u>new</u>", q["QID1"]["text"])
        self.assertEqual(" ".join(q["QID1"]["text_plain"].split()), "Please read carefully. A new page follows.")
        check = q["QID3"]["validation"]
        self.assertEqual(check["response"], "forced")
        self.assertEqual(check["correct_choices"], [{"id": "2", "text": "Patient"}])
        self.assertEqual(check["message_description"], "The answer is incorrect. Please choose again.")
        self.assertEqual(q["QID3"]["choice_randomisation"]["type"], "all")
        self.assertEqual([c["text"] for c in q["QID4"]["choices"]], ["No", "Yes"])  # ChoiceOrder = display order
        self.assertNotIn("display_logic", q["QID4"])
        where = q["QID5"]
        self.assertEqual(where["validation"]["response"], "requested")
        self.assertIs(where["display_logic"]["in_page"], True)
        self.assertEqual(where["display_logic"]["depends_on_questions"], ["QID4"])
        self.assertIn('"Yes" is selected', where["display_logic"]["condition"])
        self.assertNotIn("choices", where)  # text-entry placeholders are not options
        self.assertIs(q["QID10"]["participant_visible"], False)

    def test_forced_requested_and_optional(self):
        questions = [
            mc("QID1", "Asked but optional to answer here?", ["a b", "c d"],
               Validation={"Settings": {"ForceResponse": "ON", "ForceResponseType": "RequestResponse", "Type": "None"}}),
            mc("QID2", "Remembered type but off here?", ["a b", "c d"],
               Validation={"Settings": {"ForceResponse": "OFF", "ForceResponseType": "RequestResponse", "Type": "None"}}),
            mc("QID3", "Required answer here?", ["a b", "c d"],
               Validation={"Settings": {"ForceResponse": "ON", "ForceResponseType": "ON", "Type": "None"}}),
            {"QuestionID": "QID4", "DataExportTag": "country", "QuestionType": "TE", "Selector": "SL",
             "QuestionText": "Which country?", "SearchSource": {"AllowFreeResponse": "false"},
             "Validation": {"Settings": {"ForceResponse": "OFF", "Type": "None"}}},
        ]
        report = qsf_flow.read_survey(survey(questions, [block("BL_1", "Trash sorting task", ["QID1", "QID2", "QID3", "QID4"])],
                                             [{"Type": "Standard", "ID": "BL_1", "FlowID": "FL_2"}]))
        self.assertEqual(report["block_order"], ["BL_1"])  # a block named "Trash ..." is not the Trash block
        q = {x["qid"]: x for x in report["blocks"]["BL_1"]["questions"]}
        self.assertEqual([q[i]["validation"]["response"] for i in ("QID1", "QID2", "QID3")],
                         ["requested", "optional", "forced"])
        self.assertIs(q["QID4"]["autocomplete"]["free_response"], False)

    def test_correct_answer_checks_include_checks_that_are_not_forced(self):
        options = ["Equally to every region", "By population", "By need"]
        questions = [mc("QID80", "How is the budget allocated?", options, Validation=custom("QID80", "1", "OFF", "Wrong")),
                     mc("QID83", "How is the budget allocated now?", options, Validation=custom("QID83", "3", "ON")),
                     mc("QID56", "Which allocation do you choose?", options)]
        data = survey(questions, [block("BL_1", "Quiz", ["QID80", "QID83", "QID56"])],
                      [{"Type": "Block", "ID": "BL_1", "FlowID": "FL_2"}])
        checks = qsf_flow.correct_answer_checks(qsf_flow.read_survey(data))
        self.assertEqual([(c["qid"], c["response"], c["correct"]) for c in checks],
                         [("QID80", "optional", ["Equally to every region"]), ("QID83", "forced", ["By need"])])
        self.assertEqual(checks[0]["options"], options)

    def test_advanced_block_randomisation_and_undisplayed(self):
        questions = [db("QID1", "Intro text here."), mc("QID2", "Choice question?", ["a b", "c d"]),
                     mc("QID3", "Preference question?", ["e f", "g h"]), db("QID4", "Final question text."),
                     db("QID5", "Never displayed question text.")]
        options = {"RandomizeQuestions": "Advanced", "Randomization": {"Advanced": {
            "FixedOrder": ["QID1", "{~Randomized~}", "{~Randomized~}", "QID4"], "RandomizeAll": ["QID2", "QID3"],
            "RandomSubSet": [], "Undisplayed": ["QID5"], "TotalRandSubset": 0, "QuestionsPerPage": "3"},
            "EvenPresentation": False}}
        data = survey(questions, [block("BL_1", "S1", ["QID1", "QID2", "QID3", "|", "QID4", "QID5"], options=options)],
                      [{"Type": "Standard", "ID": "BL_1", "FlowID": "FL_2"}], blocks_as_dict=False)
        report = qsf_flow.read_survey(data)
        b = report["blocks"]["BL_1"]
        self.assertEqual(b["question_randomisation"]["randomize_all"], ["QID2", "QID3"])
        self.assertEqual([p["questions"] for p in b["pages"]], [["QID1", "QID2", "QID3"], ["QID4"]])
        self.assertEqual(b["pages"][0]["randomised"], ["QID2", "QID3"])
        self.assertEqual([q["qid"] for q in report["not_reachable"]["questions"]], ["QID5"])
        self.assertIn("undisplayed", report["not_reachable"]["questions"][0]["reason"])

    def test_trash_block_named_in_flow_and_unknown_elements(self):
        flow = [{"Type": "Block", "ID": "BL_t", "FlowID": "FL_2"}, {"Type": "WebService", "FlowID": "FL_3"},
                {"Type": "Block", "ID": "BL_missing", "FlowID": "FL_4"}]
        report = qsf_flow.read_survey(survey([db("QID1", "Trash text that is never shown.")],
                                             [block("BL_t", "Trash / Unused Questions", ["QID1"], "Trash")], flow))
        self.assertEqual(report["blocks"], {})
        self.assertEqual(report["not_reachable"]["questions"][0]["qid"], "QID1")
        self.assertTrue(any("WebService" in n for n in report["notes"]))
        self.assertTrue(any("BL_missing" in n for n in report["notes"]))

    def test_malformed_exports_do_not_crash(self):
        data = survey([db("QID1", "Some text here.")], [{"ID": "BL_1", "Type": "Standard", "BlockElements": None,
                                                         "Options": {"RandomizeQuestions": "Advanced", "Randomization": []}}],
                      [{"Type": "Standard", "ID": "BL_1", "FlowID": "FL_2"}])
        self.assertEqual(qsf_flow.read_survey(data)["blocks"]["BL_1"]["questions"], [])
        data["SurveyElements"] = [e if e.get("Element") != "FL" else {"Element": "FL", "Payload": None}
                                  for e in data["SurveyElements"]]
        self.assertEqual(qsf_flow.read_survey(data)["flow"], [])

    def test_rejects_files_that_are_not_survey_exports(self):
        data = self.tmp / "responses.qsf"
        data.write_text("ResponseId,Q1\nR_1,3\n")
        with self.assertRaises(qsf_flow.NotASurveyExport):
            qsf_flow.load_qsf(data)
        (self.tmp / "list.qsf").write_text("[1, 2]")
        with self.assertRaises(qsf_flow.NotASurveyExport):
            qsf_flow.load_qsf(self.tmp / "list.qsf")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(qsf_flow.main([str(data)]), 2)

    def test_cli_writes_json_and_outline(self):
        path = self.tmp / "survey.qsf"
        path.write_text(json.dumps(fixture()))
        out = self.tmp / ".humanstudy/tmp/survey.flow.json"
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(qsf_flow.main([str(path), "--json", str(out)]), 0)
        self.assertEqual(json.loads(out.read_text())["block_order"], ["BL_intro", "BL_a", "BL_b"])
        text = buf.getvalue()
        self.assertIn("correct answer required: Patient", text)
        self.assertIn("Never shown to participants", text)
        self.assertIn("Trash / Unused Questions", text)
        self.assertIn("options (base order, shuffled per participant): Physician | Patient", text)


class PackageCheck(unittest.TestCase):
    """problems(root): the desktop project layout (program.json, sources/, package/<slug>/)."""

    QSF = "sources/open/survey.qsf"

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="qsf-project-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.pkg = self.root / "package/paper"
        self.program = {"id": "p", "nodes": [{"id": "m", "kind": "material", "fields": []}], "steps": [],
                        "evidence": [{"id": "ev-qsf", "path": self.QSF, "locator": {"pointer": "QID2"}},
                                     {"id": "ev-paper", "path": "paper.pdf", "locator": {"page": 3}}]}
        self.write(self.QSF, fixture())
        self.write("package/paper/task/task.json", {"conditions": [{"id": "a"}]})
        self.adapter("def run_sessions(llm, seed, n, arms=None):\n    return []\n")

    def write(self, rel, data):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")

    def adapter(self, code):
        self.write("package/paper/task/adapter.py", code)

    def check(self, materials=None, fields=None):
        if fields is not None:
            self.program["nodes"][0]["fields"] = fields
        self.write("program.json", self.program)
        self.write("package/paper/materials/materials.json", materials if materials is not None else {})
        return qsf_flow.problems(self.root)

    def test_project_without_qsf_passes(self):
        (self.root / self.QSF).unlink()
        self.assertEqual(self.check({"screens": [{"id": "s", "source": self.QSF, "text": TRASH}]}), [])
        self.assertEqual(qsf_flow.problems(self.root / "nowhere"), [])

    def test_export_without_flow_passes(self):
        self.write(self.QSF, {"SurveyElements": [{"Element": "SQ", "Payload": db("QID1", TRASH)}]})
        self.assertEqual(self.check({"source": self.QSF, "text": TRASH}), [])

    def test_reachable_text_passes(self):
        materials = {"source": self.QSF, "screens": [
            {"id": "s1", "text": LIVE, "options": ["Physician", "Patient"]}, {"id": "s2", "text": "Who decided?"}],
            "notShown": [{"qid": "QID7", "text": TRASH}]}
        field = {"id": "scenario", "value": LIVE, "origin": "verbatim", "evidenceIds": ["ev-qsf"]}
        self.adapter(f'SCREEN = "{LIVE}"\n')
        self.assertEqual(self.check(materials, [field]), [])

    def test_unreachable_text_in_program_field_fails(self):
        field = {"id": "instructions", "value": {"text": OLD}, "origin": "verbatim", "evidenceIds": ["ev-qsf"]}
        found = self.check(fields=[field])
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0][0].startswith("program.json m.instructions uses survey text from QID9"))
        self.assertIn("not-shown", found[0][1])
        # The same text cited to the paper is not survey text.
        field["evidenceIds"] = ["ev-paper"]
        self.assertEqual(self.check(fields=[field]), [])

    def test_unreachable_text_in_materials_fails(self):
        found = self.check({"screens": [
            {"id": "s1", "sourceFile": "../../" + self.QSF, "text": LIVE},
            {"id": "s2", "source": {"path": self.QSF}, "text": TRASH, "options": ["1 (Not at all)"]},
            {"id": "s3", "evidenceIds": ["ev-paper"], "text": OLD},
            {"id": "s4", "sourceId": "survey.qsf", "path": "materials/pic.png", "text": OLD}]})
        messages = [m for m, _ in found]
        self.assertEqual(len(messages), 2, messages)
        self.assertTrue(any("screens[1]" in m and "QID7" in m and "Trash" in m for m in messages))
        self.assertTrue(any("screens[3]" in m and "QID9" in m for m in messages))
        # Scope through evidenceIds.
        found = self.check({"screens": [{"id": "s1", "evidenceIds": ["ev-qsf"], "text": OLD}]})
        self.assertEqual(len(found), 1)

    def test_unreachable_text_in_adapter_literal_fails(self):
        self.adapter(f'SCREEN = "{OLD}"\nOTHER = "{LIVE}"\n')
        found = self.check()
        self.assertEqual(len(found), 1)
        self.assertTrue(found[0][0].startswith("package/paper/task/adapter.py line 1"))
        self.assertIn("QID9", found[0][0])

    def test_private_and_researcher_qsf_are_checked_too(self):
        (self.root / self.QSF).unlink()
        self.write("sources/researcher/survey.qsf", fixture())
        self.adapter(f'SCREEN = "{TRASH}"\n')
        found = self.check()
        self.assertTrue(any("sources/researcher/survey.qsf" in m for m, _ in found))

    def test_marked_not_shown_item_used_by_the_run_fails(self):
        materials = {"source": self.QSF, "screens": [
            {"id": "s.trash", "qsfReachability": "not-shown", "text": TRASH},
            {"id": "s.status", "status": "unused", "text": TRASH}]}
        self.adapter('def run(ask):\n    ask("s.trash")\n')
        messages = [m for m, _ in self.check(materials)]
        self.assertTrue(any("'s.trash'" in m and "still use" in m for m in messages))
        self.assertTrue(any("screens[1]" in m and "QID7" in m for m in messages))  # only the marker exempts text
        # By question id, from task.json or the program steps.
        self.adapter("")
        materials = {"source": self.QSF, "screens": [{"id": "w1", "qsfId": "QID7", "qsfReachability": "not-shown",
                                                      "text": TRASH}], "notShown": ["QID9"]}
        self.write("package/paper/task/task.json", {"screens": ["QID7"]})
        self.program["steps"] = [{"id": "st", "kind": "action", "title": "Old", "inputIds": ["QID9"]}]
        messages = [m for m, _ in self.check(materials)]
        self.assertTrue(any("'QID7'" in m for m in messages) and any("'QID9'" in m for m in messages))
        # Marked and unused passes.
        self.write("package/paper/task/task.json", {"screens": []})
        self.program["steps"] = []
        self.assertEqual(self.check(materials), [])

    def test_marked_program_field_used_by_the_run_fails(self):
        field = {"id": "old", "value": OLD, "evidenceIds": ["ev-qsf"], "qsfId": "QID9", "qsfReachability": "not-shown"}
        self.assertEqual(self.check(fields=[field]), [])
        self.adapter('KEYS = ["QID9"]\n')
        self.assertTrue(any("'QID9'" in m for m, _ in self.check(fields=[field])))

    def test_mixed_items(self):
        mixed = {"id": "m", "origin": "verbatim", "state": "confirmed", "source": self.QSF, "text": LIVE,
                 "options": [TRASH]}
        self.assertTrue(self.check({"screens": [mixed]}))
        self.assertEqual(self.check({"screens": [dict(mixed, qsfReachability="mixed", state="check")]}), [])
        unchecked = [m for m, _ in self.check({"screens": [dict(mixed, qsfReachability="mixed")]})]
        self.assertTrue(any('without state "check"' in m for m in unchecked))
        only_trash = {"id": "t", "state": "check", "qsfReachability": "mixed", "source": self.QSF, "text": TRASH}
        self.assertTrue(any("holds no text participants saw" in m for m, _ in self.check({"screens": [only_trash]})))

    def test_duplicates_short_strings_and_metadata_pass(self):
        data = fixture()
        # A Trash copy of reachable text, as Qualtrics keeps when a question is duplicated.
        data["SurveyElements"].insert(0, {"Element": "SQ", "Payload": db("QID11", LIVE)})
        for element in data["SurveyElements"]:
            if element["Element"] == "BL":
                element["Payload"]["0"]["BlockElements"].append({"Type": "Question", "QuestionID": "QID11"})
        self.write(self.QSF, data)
        materials = {"source": self.QSF, "note": TRASH, "screens": [
            {"id": "s1", "text": "Please read this first. " + LIVE},
            {"id": "s2", "text": "Who decided?", "options": ["1 (Not at all)"]}]}
        self.assertEqual(self.check(materials), [])

    def test_cli_check(self):
        self.adapter(f'SCREEN = "{OLD}"\n')
        self.check()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(qsf_flow.main(["--check", str(self.root)]), 1)
        self.assertIn("PROBLEM", buf.getvalue())
        self.assertIn("FAIL", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
