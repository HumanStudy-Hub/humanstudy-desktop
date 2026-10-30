"""effects.json: hypotheses linked to computable effects, every reported number quoted.
   python -m unittest discover -s pack/runtime/tests"""
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_agent_package import REPO, export, make_project, mcp  # noqa: E402
from test_human_data import Server  # noqa: E402

sys.dont_write_bytecode = True  # no __pycache__ inside pack/skills: the app embeds that folder
sys.path.insert(0, str(REPO / "pack/skills/export/agent"))
import effects_core  # noqa: E402
import study_core  # noqa: E402

CHECK = REPO / "pack/skills/build/effects.py"
QUOTE = "In the harm condition 82% said the chairman harmed the environment intentionally (n = 39); " \
        "in the help condition 23% said he helped intentionally (n = 39), chi2(1) = 27.2, p < .001."


def effects_doc():
    return {
        "schemaVersion": 1, "programId": "study-5", "topics": ["intentional action", "moral judgment"],
        "hypotheses": [{"id": "h1", "nodeId": "hypothesis", "status": "tested", "backgroundIds": ["background"],
                        "phenomena": ["side-effect effect"]}],
        "effects": [{
            "id": "harm_vs_help", "label": "Harm vs help: share judging the side effect intentional",
            "role": "test", "hypothesisIds": ["h1"], "studyId": "exp-1", "design": "between", "unit": "participant",
            "outcome": {"variableId": "intentionality", "type": "binary", "scale": "yes / no",
                        "higherMeans": "more participants say intentional"},
            "contrast": {"kind": "two_groups", "treatment": "condition-harm", "reference": "condition-help",
                         "conditionIds": ["condition-harm", "condition-help"], "valueMeans": "harm minus help"},
            "prediction": {"direction": "positive"},
            "analysisIds": ["analysis"], "resultIds": ["result-1"],
            "compute": {"op": "proportion_difference", "field": "answer", "success": ["yes"]},
            "reported": {"estimates": [],
                         "cells": {"condition-harm": {"n": 39, "percent": 82},
                                   "condition-help": {"n": 39, "percent": 23}},
                         "test": {"statistic": "chi_square", "value": 27.2, "df": 1, "p": 0.001, "pRelation": "<"},
                         "missing": ["sd"], "evidenceIds": ["e-result"]}}]}


class Effects(unittest.TestCase):
    def setUp(self):
        self.root = make_project()
        self.addCleanup(shutil.rmtree, self.root, True)
        program = json.loads((self.root / "program.json").read_text(encoding="utf-8"))
        program["evidence"].append({"id": "e-result", "sourceId": "paper", "locator": {"page": 2},
                                    "quote": QUOTE})
        (self.root / "program.json").write_text(json.dumps(program), encoding="utf-8")
        self.write(effects_doc())

    def write(self, doc):
        (self.root / "effects.json").write_text(json.dumps(doc), encoding="utf-8")

    def check(self):
        return subprocess.run([sys.executable, str(CHECK), str(self.root)], capture_output=True, text=True,
                              encoding="utf-8")

    def test_valid_file_passes_and_schema_agrees(self):
        run = self.check()
        self.assertEqual(run.returncode, 0, run.stdout)
        self.assertIn("PASS (1 hypotheses, 1 effects)", run.stdout)
        schema = json.loads((REPO / "pack/schema/effects.schema.json").read_text(encoding="utf-8"))
        self.assertEqual(schema["properties"]["schemaVersion"]["const"], effects_core.SCHEMA_VERSION)
        self.assertEqual(schema["properties"]["effects"]["items"]["properties"]["compute"]["properties"]["op"]["enum"],
                         list(effects_core.OPS))

    def test_unquoted_numbers_and_unlisted_hypotheses_are_problems(self):
        doc = effects_doc()
        doc["effects"][0]["reported"]["cells"]["condition-harm"]["n"] = 40  # not what the paper prints
        doc["hypotheses"] = []
        doc["effects"][0]["contrast"]["conditionIds"] = ["nope"]
        self.write(doc)
        run = self.check()
        self.assertEqual(run.returncode, 1)
        self.assertIn("cells.condition-harm.n = 40 is not written in its cited quotes", run.stdout)
        self.assertIn("program hypothesis hypothesis", run.stdout)
        self.assertIn("'nope' is not a program node", run.stdout)

    def test_model_results_name_their_population_and_own_phenomena(self):
        doc = effects_doc()
        doc["effects"][0]["population"] = {"kind": "ai-model"}
        doc["effects"][0]["phenomena"] = ["Knobe effect"]
        problems, _ = effects_core.check(self.root, doc)
        self.assertTrue(any("population.models" in p for p in problems))
        self.assertEqual(effects_core.phenomena_of(doc["effects"][0], doc["hypotheses"]), ["Knobe effect"])
        del doc["effects"][0]["phenomena"]
        self.assertEqual(effects_core.phenomena_of(doc["effects"][0], doc["hypotheses"]), ["side-effect effect"])

    def test_ops_must_read_fields_ai_sessions_carry(self):
        doc = effects_doc()
        doc["effects"][0]["compute"]["field"] = "parsed.answer"  # only a human loader would write this
        self.write(doc)
        run = self.check()
        self.assertEqual(run.returncode, 1, run.stdout)
        self.assertIn("reads 'parsed.answer', which AI-participant sessions do not carry", run.stdout)

    def test_untested_needs_a_reason_and_graph_reaches_program_nodes(self):
        doc = effects_doc()
        doc["hypotheses"][0].update(status="untested")
        self.write(doc)
        problems, _ = effects_core.check(self.root)
        self.assertTrue(any("untestedBecause" in p for p in problems))
        self.assertTrue(any("untested but effect" in p for p in problems))
        program = json.loads((self.root / "program.json").read_text(encoding="utf-8"))
        program["nodes"].append({"id": "result-orphan", "kind": "result", "title": "Unlinked", "studyIds": ["exp-1"],
                                 "fields": [], "evidenceIds": []})
        g = effects_core.graph(effects_doc(), program)
        for nid in ["hypothesis", "intentionality", "condition-harm", "analysis", "result-1"]:
            self.assertIn(nid, g["reached"])
        self.assertEqual(g["unlinked"], ["result-orphan"])

    def test_same_block_for_any_sessions_and_compared_with_the_paper(self):
        sessions = [{"condition": "condition-harm", "answer": "yes"}] * 8 + [{"condition": "condition-harm", "answer": "no"}] * 2 \
            + [{"condition": "condition-help", "answer": "yes"}] * 2 + [{"condition": "condition-help", "answer": "no"}] * 8
        block = effects_core.compute(effects_doc(), sessions, source="human")[0]
        self.assertEqual((block["status"], block["metric"], block["source"]), ("computed", "risk_difference", "human"))
        self.assertAlmostEqual(block["value"], 0.6)
        self.assertEqual(block["table"]["counts"], [[8, 2], [2, 8]])
        self.assertAlmostEqual(block["test"]["value"], 7.2)
        self.assertAlmostEqual(block["test"]["p"], 0.00729, places=4)
        c = effects_core.compare(effects_doc()["effects"][0], block)
        self.assertEqual(c["basis"], "difference of the reported proportions")
        self.assertTrue(c["withinTolerance"])  # 0.6 vs 0.59

    def test_runs_return_effect_blocks_and_mcp_lists_effects(self):
        run = export(self.root, "--mcp")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("effects.json: hypotheses, effects and quoted numbers check", run.stdout)
        skill = self.root / "exports/agent/study-5"
        self.assertTrue((skill / "effects.json").is_file())
        self.assertIn("## Effects", (skill / "SKILL.md").read_text(encoding="utf-8"))
        res = mcp(skill / "scripts/mcp_server.py", [
            ("list_effects", {"phenomenon": "side-effect"}),
            ("score_replies", {"n": 2, "replies": ["Yes.", "yes", "No", "no way"]})])
        listed = json.loads(res[2]["result"]["content"][0]["text"])
        self.assertEqual([e["id"] for e in listed["effects"]], ["harm_vs_help"])
        self.assertIn("statement", listed["effects"][0]["hypotheses"][0])
        self.assertEqual(listed["effects"][0]["reportedSource"], "p. 2")
        scored = json.loads(res[3]["result"]["content"][0]["text"])
        self.assertEqual(scored["effects"][0]["source"], "agent")
        self.assertEqual(scored["effects"][0]["value"], 1.0)

    def test_reproduce_uses_effects_json(self):
        data = (b"condition,answer\n" + b"condition-harm,yes\n" * 8 + b"condition-harm,no\n" * 2
                + b"condition-help,yes\n" * 2 + b"condition-help,no\n" * 8)
        server = Server({"/d.csv": data})
        self.addCleanup(server.close)
        import hashlib
        human = self.root / "package/knobe/human"
        human.mkdir()
        (human / "human_sessions.py").write_text(
            "import csv, os\nSOURCE = 'test'\nEXCLUSIONS = 'none'\nNOT_MAPPED = []\n"
            "def load(d):\n    with open(os.path.join(d, 'd.csv'), newline='') as f:\n        return list(csv.DictReader(f))\n")
        (human / "key.json").write_text(json.dumps({"schemaVersion": 1, "loader": "human_sessions.py",
            "sample": "original", "files": [{"path": "d.csv", "sha256": hashlib.sha256(data).hexdigest(),
                                             "role": "data", "url": server.url + "/d.csv"}]}))
        rep = study_core.Study(str(self.root)).reproduce_paper()
        self.assertEqual((rep["source"], rep["verdict"], rep["recovered"]), ("effects.json", "pass", [1, 1]))
        self.assertEqual(rep["effects"][0]["cells"]["condition-harm"], {"n": 10, "k": 8, "proportion": 0.8})


if __name__ == "__main__":
    unittest.main()
