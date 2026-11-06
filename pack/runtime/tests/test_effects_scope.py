"""Build contract 3 effects rules (stage-1 batch-2 reviews): the scale of proportions, signed metrics, pooled and
model-based reported values, hypothesis status against run.excluded, "not printed" claims against recorded tables,
and the two meanings of capabilities.json run.excluded[].arms.
   python -m unittest discover -s pack/runtime/tests"""
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_agent_package import REPO, make_project  # noqa: E402
from test_effects import QUOTE, effects_doc  # noqa: E402

sys.dont_write_bytecode = True  # no __pycache__ inside pack/skills: the app embeds that folder
sys.path.insert(0, str(REPO / "pack/skills/export/agent"))
sys.path.insert(0, str(REPO / "pack/skills/build"))
import effects_core  # noqa: E402
import study_core  # noqa: E402
import effects  # noqa: E402
import capabilities  # noqa: E402

CHECK = REPO / "pack/skills/build/effects.py"
CAPS = REPO / "pack/skills/build/capabilities.py"
SHARE_QUOTE = "Neg. Emotions 12.106 1.293 9.671 14.593; sharing rose from 40% to 52%."


def share_effect(**est):
    """Vlasceanu-like: a risk difference printed in percentage points, computed by the replay as a proportion."""
    e = effects_doc()["effects"][0]
    e["compute"] = {"op": "proportion_difference", "field": "answer", "success": ["yes"]}
    e["reported"] = {"estimates": [dict({"metric": "risk_difference", "value": 12.106, "evidenceIds": ["e-share"]},
                                        **est)], "missing": [], "evidenceIds": ["e-share"]}
    return e


def computed(metric, value, **more):
    return dict({"status": "computed", "metric": metric, "value": value}, **more)


class Compare(unittest.TestCase):
    """effects_core.compare (shared with HumanStudy-Bench)."""

    def test_percentage_points_are_converted_and_an_unknown_scale_is_not_compared(self):
        # before: 12.106 vs a perfect replay of 0.121 compared as "same metric" and missed
        e = share_effect(scale="percentage_points")
        c = effects_core.compare(e, computed("risk_difference", 0.121, scale="proportion"))
        self.assertTrue(c["withinTolerance"], c)
        self.assertAlmostEqual(c["reported"], 0.12106)
        self.assertIn("0-1 proportion scale", c["basis"])
        unknown = effects_core.compare(share_effect(), computed("risk_difference", 0.121))
        self.assertFalse(unknown["comparable"])
        self.assertTrue(unknown["scaleUnknown"])
        # an older file that says "percentage points" in the variant or the outcome scale is read that way
        legacy = share_effect(variant="posterior mean; percentage points")
        self.assertTrue(effects_core.compare(legacy, computed("risk_difference", 0.121))["withinTolerance"])
        # a package block on the percentage scale is converted too
        block = computed("risk_difference", 12.0, scale="percentage_points")
        self.assertTrue(effects_core.compare(e, block)["withinTolerance"])
        # a proportion is never beyond 1: the core check fails that contradiction
        root = make_project()
        self.addCleanup(shutil.rmtree, root, True)
        doc = effects_doc()
        doc["effects"][0]["reported"]["estimates"] = [{"metric": "risk_difference", "value": 59, "scale": "proportion"}]
        problems, _ = effects_core.check(root, doc)
        self.assertTrue(any("not on a 0-1 proportion scale" in p for p in problems), problems)

    def test_unsigned_metric_on_a_two_group_contrast_is_judged_only_with_a_sign_on_both_sides(self):
        e = effects_doc()["effects"][0]
        e["reported"] = {"estimates": [{"metric": "cramers_v", "value": 0.12}], "evidenceIds": ["e-result"]}
        # before: a reversed replay with V = .12 was "within tolerance" of the printed V = .12 (Hall)
        reversed_unsigned = effects_core.compare(e, computed("cramers_v", 0.12))
        self.assertIsNone(reversed_unsigned["withinTolerance"])
        self.assertFalse(reversed_unsigned["signChecked"])
        e["reported"]["estimates"][0]["signBasis"] = "knowledge .71 vs Gettier .60 (p. 18)"
        self.assertFalse(effects_core.compare(e, computed("cramers_v", -0.12, signed=True))["withinTolerance"])
        self.assertTrue(effects_core.compare(e, computed("cramers_v", 0.12, signed=True))["withinTolerance"])
        # an association (no treatment / reference) keeps the old behaviour
        e["contrast"] = {"kind": "association"}
        self.assertTrue(effects_core.compare(e, computed("cramers_v", 0.12))["withinTolerance"])

    def test_contingency_op_signs_phi_by_the_success_level(self):
        e = effects_doc()["effects"][0]
        e["compute"] = {"op": "contingency", "field": "answer", "groupBy": "condition", "success": ["yes"],
                        "groups": ["condition-harm", "condition-help"], "levels": ["no", "yes"]}
        rows = [{"condition": "condition-harm", "answer": "no"}] * 8 + [{"condition": "condition-harm", "answer": "yes"}] * 2 + \
               [{"condition": "condition-help", "answer": "yes"}] * 8 + [{"condition": "condition-help", "answer": "no"}] * 2
        block = effects_core.op_contingency(rows, e)
        self.assertTrue(block["signed"])
        self.assertLess(block["value"], 0, "harm (treatment) says yes less often: negative")
        del e["compute"]["success"]
        unsigned = effects_core.op_contingency(rows, e)
        self.assertFalse(unsigned["signed"])
        self.assertGreater(unsigned["value"], 0)

    def test_pooled_or_model_based_values_are_not_like_for_like(self):
        e = effects_doc()["effects"][0]
        e["reported"] = {"estimates": [{"metric": "mean_difference", "value": 2.255}], "evidenceIds": ["x"]}
        same = effects_core.compare(e, computed("mean_difference", 2.255))
        self.assertNotIn("likeForLike", same)
        e["reported"]["estimates"][0]["estimateType"] = "model-based"
        c = effects_core.compare(e, computed("mean_difference", 2.255))
        self.assertFalse(c["likeForLike"])
        self.assertTrue(c["basis"].startswith("not like-for-like"))
        del e["reported"]["estimates"][0]["estimateType"]
        e["reported"].update(scope="pooled", scopeNote="63 countries, hierarchical model (p. 8)")
        self.assertIn("63 countries", effects_core.compare(e, computed("mean_difference", 2.0))["basis"])
        # older files: the variant's own words ("Bayesian posterior", "random-effects") label it
        e["reported"] = {"estimates": [{"metric": "mean", "value": 10.3,
                                        "variant": "aggregate mean across countries (random-effects)"}]}
        self.assertFalse(effects_core.compare(e, computed("mean", 10.3))["likeForLike"])


class HypothesisStatus(unittest.TestCase):
    def setUp(self):
        self.root = make_project()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.program = json.loads((self.root / "program.json").read_text(encoding="utf-8"))
        self.program["evidence"].append({"id": "e-result", "sourceId": "paper", "locator": {"page": 2}, "quote": QUOTE})
        self.program["evidence"].append({"id": "e-share", "sourceId": "paper", "locator": {"page": 3},
                                         "quote": SHARE_QUOTE})
        for n in self.program["nodes"]:
            if n["id"] == "hypothesis":
                n["studyIds"] = ["exp-1"]
        (self.root / "program.json").write_text(json.dumps(self.program), encoding="utf-8")

    def caps(self, excluded):
        (self.root / "capabilities.json").write_text(json.dumps({"schemaVersion": 1, "run": {
            "status": "partial", "reason": "x", "excluded": excluded}}), encoding="utf-8")

    def rules(self, doc):
        return effects.contract_rules(self.root, doc, self.program)

    def test_core_accepts_partial_with_a_reason_and_untested_with_only_excluded_effects(self):
        doc = effects_doc()
        doc["hypotheses"][0]["status"] = "partial"
        problems, _ = effects_core.check(self.root, doc, self.program)
        self.assertTrue(any("partial hypothesis needs a reason" in p for p in problems), problems)
        doc["hypotheses"][0]["reason"] = "Study 2 runs only in the paper"
        self.assertEqual(effects_core.check(self.root, doc, self.program)[0], [])
        doc["hypotheses"][0].update(status="untested", untestedBecause="not-computable", reason="population arms")
        self.assertTrue(any("untested but effect(s) name it" in p for p in effects_core.check(self.root, doc, self.program)[0]))
        self.caps([{"what": "online vs lab", "reason": "population difference", "effects": ["harm_vs_help"]}])
        self.assertEqual(effects_core.check(self.root, doc, self.program)[0], [])

    def test_tested_needs_every_effect_computed_and_its_studies_covered(self):
        doc = effects_doc()
        self.assertEqual([r for r in self.rules(doc)[0] if "hypothesis" in r], [])
        # Arechar h1/h3, Holzmeister h-awareness: every effect excluded
        self.caps([{"what": "online vs lab", "reason": "population difference", "effects": ["harm_vs_help"]}])
        self.assertTrue(any("computes none of its effects" in r and "not-computable" in r for r in self.rules(doc)[0]))
        # Vlasceanu, Burton-Chellew: some excluded -> partial
        second = json.loads(json.dumps(doc["effects"][0]))
        second["id"] = "harm_vs_help_2"
        doc["effects"].append(second)
        found = self.rules(doc)[0]
        self.assertTrue(any("computes 1 of its 2 effects" in r and "partial" in r for r in found), found)
        doc["hypotheses"][0].update(status="partial", reason="one contrast is excluded")
        self.assertEqual([r for r in self.rules(doc)[0] if "hypothesis" in r], [])
        # Huber H1: stated for another study than the one its effect comes from
        self.caps([])
        doc = effects_doc()
        for n in self.program["nodes"]:
            if n["id"] == "hypothesis":
                n["studyIds"] = ["exp-2"]
        self.assertTrue(any("stated for exp-2" in r for r in self.rules(doc)[0]))

    def test_rules_block_from_build_contract_3_and_warn_before(self):
        doc = effects_doc()
        self.caps([{"what": "online vs lab", "reason": "population difference", "effects": ["harm_vs_help"]}])
        (self.root / "effects.json").write_text(json.dumps(doc), encoding="utf-8")
        study = self.root / "package/knobe/study.json"
        record = json.loads(study.read_text())
        older = subprocess.run([sys.executable, str(CHECK), str(self.root)], capture_output=True, text=True)
        self.assertIn("WARN", older.stdout)
        self.assertIn("older build: blocking from buildContract 3", older.stdout)
        self.assertNotIn("problem: hypothesis h1", older.stdout)
        study.write_text(json.dumps(dict(record, buildContract=3)))
        current = subprocess.run([sys.executable, str(CHECK), str(self.root)], capture_output=True, text=True)
        self.assertEqual(current.returncode, 1, current.stdout)
        self.assertIn("problem: hypothesis h1 (tested): the replay computes none of its effects", current.stdout)


class Rules(unittest.TestCase):
    def setUp(self):
        self.root = make_project()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.program = json.loads((self.root / "program.json").read_text(encoding="utf-8"))
        for n in self.program["nodes"]:
            if n["id"] == "hypothesis":
                n["studyIds"] = ["exp-1"]      # the fixture's one effect covers its hypothesis

    def rules(self, *effs):
        doc = effects_doc()
        doc["effects"] = list(effs)
        return effects.contract_rules(self.root, doc, self.program)

    def test_scale(self):
        found = self.rules(share_effect())[0]
        self.assertTrue(any("beyond -1..1 is not a 0-1 proportion" in r for r in found), found)
        found = self.rules(share_effect(value=0.12))[0]
        self.assertTrue(any("say the scale" in r for r in found), found)
        self.assertEqual([r for r in self.rules(share_effect(scale="percentage_points"))[0] if "scale" in r], [])

    def test_sign(self):
        e = effects_doc()["effects"][0]
        e["reported"] = {"estimates": [{"metric": "cramers_v", "value": 0.12}], "evidenceIds": ["e-result"]}
        e["compute"] = {"op": "contingency", "field": "answer"}
        found = self.rules(e)[0]
        self.assertTrue(any("add `signBasis`" in r for r in found), found)
        self.assertTrue(any("add compute.success" in r for r in found), found)
        e["reported"]["estimates"][0]["signBasis"] = "harm 82% vs help 23%"
        e["compute"]["success"] = ["yes"]
        self.assertEqual([r for r in self.rules(e)[0] if "sign" in r], [])
        blocks = {"k": {"status": "computed", "metric": "cramers_v", "signed": False}}
        e["compute"] = {"op": "package", "key": "k"}
        self.assertTrue(effects.block_sign_rules({"effects": [e]}, blocks))
        blocks["k"]["signed"] = True
        self.assertEqual(effects.block_sign_rules({"effects": [e]}, blocks), [])

    def test_scope(self):
        e = effects_doc()["effects"][0]
        e["contrast"] = {"kind": "single_group", "treatment": "condition-harm"}
        e["reported"] = {"cells": {"condition-harm": {"percent": 13.8}}, "evidenceIds": ["e-result"],
                         "missing": ["pooled across countries; no US-only figure is printed"],
                         "estimates": [{"metric": "mean", "value": 10.3, "variant": "random-effects aggregate"}]}
        found = self.rules(e)[0]
        self.assertTrue(any("look pooled" in r for r in found), found)
        self.assertTrue(any("estimateType" in r for r in found), found)
        (self.root / "package/knobe/task/task.json").write_text(json.dumps({"conditions": [{"id": "condition-harm"}]}))
        e["reported"].update(scope="pooled", scopeNote="61 countries")
        e["reported"]["estimates"][0]["estimateType"] = "model-based"
        found = self.rules(e)[0]
        self.assertEqual(len(found), 1, found)
        self.assertIn("stored under the replayed arm(s) condition-harm", found[0])

    def test_not_printed_claim_against_a_recorded_table(self):
        table = {"table": "Table 14", "page": 16, "columns": ["Row", "Integrated (n = 298)", "Segregated (n = 296)"],
                 "rows": [["AD", "20 (6.7%)", "188 (63.1%)"], ["Mean [SD]", "4.13 [1.82]", "4.15 [1.80]"]]}
        for n in self.program["nodes"]:
            if n["id"] == "result-1":
                n.setdefault("fields", []).append({"id": "table-14", "label": "Table 14", "value": table,
                                                    "origin": "verbatim", "state": "confirmed"})
        e = effects_doc()["effects"][0]
        e["reported"]["missing"] = ["n of each group after exclusions is not printed",
                                    "The difference is not printed; only the two means are"]
        found = self.rules(e)[0]
        self.assertEqual(len(found), 1, found)
        self.assertIn("Table 14 (p. 16), recorded in program.json result-1.table-14, prints n", found[0])
        e["reported"]["missing"] = ["cell means are not printed for this contrast"]
        self.assertIn("prints means", self.rules(e)[0][0])
        e["reported"]["missing"] = ["Table 14 prints n before exclusions; the n after excluding AC/BD is not printed"]
        self.assertEqual(self.rules(e)[0], [])

    def test_direction_words_in_the_quotes_of_one_prediction(self):
        self.program["evidence"] += [
            {"id": "p1", "quote": "Joint presentation decreases the likelihood to accept the first bet."},
            {"id": "p2", "quote": "Joint presentation increases the likelihood to accept the first bet."}]
        e = effects_doc()["effects"][0]
        e["prediction"] = {"direction": "negative", "evidenceIds": ["p1", "p2"]}
        warnings = self.rules(e)[1]
        self.assertTrue(any("rests on quotes that say both" in w for w in warnings), warnings)
        e["prediction"]["evidenceIds"] = ["p1"]
        self.assertEqual(self.rules(e)[1], [])


class ExcludedArms(unittest.TestCase):
    def setUp(self):
        self.root = make_project()
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / "package/knobe/task/task.json").write_text(json.dumps({"conditions": [
            {"id": "condition-harm"}, {"id": "condition-help"}, {"id": "picture", "status": "blocked"}]}))
        doc = effects_doc()
        blocked = json.loads(json.dumps(doc["effects"][0]))
        blocked.update(id="picture_vs_help", contrast=dict(blocked["contrast"], treatment="picture"))
        doc["effects"].append(blocked)
        (self.root / "effects.json").write_text(json.dumps(doc))

    def caps(self, excluded, contract=None):
        (self.root / "capabilities.json").write_text(json.dumps({
            "schemaVersion": 1, "read": {"status": "yes"}, "humanData": {"status": "no", "reason": "x"},
            "authorCode": {"status": "no", "reason": "x"}, "profiles": {"status": "no", "reason": "x"},
            "reproduced": {"package": None, "author": None},
            "run": {"status": "partial", "reason": "x", "excluded": excluded}}))
        study = self.root / "package/knobe/study.json"
        record = json.loads(study.read_text())
        record.pop("buildContract", None)
        study.write_text(json.dumps(dict(record, **({"buildContract": contract} if contract else {}))))
        return subprocess.run([sys.executable, str(CAPS), str(self.root), "--check"], capture_output=True, text=True)

    def test_content_exclusions_listing_every_runnable_arm_fail_from_contract_3(self):
        # Hall / Vlasceanu: a questionnaire left out, written as `arms` = every arm the package runs
        content = [{"what": "demographics", "reason": "not analysed", "arms": ["condition-harm", "condition-help"]},
                   {"what": "picture arm", "reason": "picture stimulus", "arms": ["picture"],
                    "effects": ["picture_vs_help"]}]
        older = self.caps(content)
        self.assertEqual(older.returncode, 0, older.stdout)
        self.assertIn("WARN run.excluded `arms` together list every arm the package runs", older.stdout)
        current = self.caps(content, contract=3)
        self.assertEqual(current.returncode, 1, current.stdout)
        self.assertIn("FAIL run.excluded[0] (demographics): `arms` lists condition-harm, condition-help", current.stdout)
        content[0]["affectsArms"] = content[0].pop("arms")
        fixed = self.caps(content, contract=3)
        self.assertEqual(fixed.returncode, 0, fixed.stdout)

    def test_a_blocked_effect_is_listed_in_excluded_effects(self):
        # McCarthy: the conceptual-replication arms are blocked but their effect is not excluded
        missing = [{"what": "picture arm", "reason": "picture stimulus", "arms": ["picture"]}]
        self.assertIn("WARN effect picture_vs_help cannot be computed", self.caps(missing).stdout)
        current = self.caps(missing, contract=3)
        self.assertEqual(current.returncode, 1)
        self.assertIn("FAIL effect picture_vs_help cannot be computed (arm picture cannot be run)", current.stdout)

    def test_study_core_refuses_only_arms_that_cannot_run(self):
        self.caps([{"what": "demographics", "reason": "not analysed", "arms": ["condition-harm", "condition-help"]},
                   {"what": "timers", "reason": "no clock", "affectsArms": ["condition-harm"]},
                   {"what": "picture arm", "reason": "picture stimulus", "arms": ["picture"]}])
        st = study_core.Study(self.root)
        self.assertEqual(st.refused_arms(), {"picture": "picture stimulus"})
        st.require_arms(["condition-harm"])          # an older build's content entry no longer refuses its only arms
        with self.assertRaises(study_core.Refusal):
            st.require_arms(["picture"])
        self.assertEqual([x["what"] for x in st.affected(["condition-harm"])], ["demographics", "timers"])
        self.assertEqual([x["what"] for x in st.affected(["condition-help"])], ["demographics"])
        # without task.json conditions every `arms` entry is refused, as before
        (self.root / "package/knobe/task/task.json").write_text("{}")
        with self.assertRaises(study_core.Refusal):
            study_core.Study(self.root).require_arms(["condition-harm"])


class Schema(unittest.TestCase):
    def test_new_fields_validate(self):
        import jsonschema
        schema = json.loads((REPO / "pack/schema/effects.schema.json").read_text(encoding="utf-8"))
        doc = effects_doc()
        doc["hypotheses"][0].update(status="partial", reason="Study 2 not replayed")
        rep = doc["effects"][0]["reported"]
        rep.update(scope="pooled", scopeNote="61 countries")
        rep["estimates"] = [{"metric": "risk_difference", "value": 59, "scale": "percentage_points",
                             "estimateType": "descriptive"}]
        jsonschema.validate(doc, schema)
        hyp = schema["properties"]["hypotheses"]["items"]["properties"]["status"]["enum"]
        self.assertEqual(hyp, list(effects_core.HYPOTHESIS_STATUSES))
        for bad in ({"status": "partial", "reason": ""}, {"status": "partial"}):
            broken = json.loads(json.dumps(doc))
            broken["hypotheses"][0] = dict({k: v for k, v in broken["hypotheses"][0].items() if k != "reason"}, **bad)
            with self.assertRaises(jsonschema.ValidationError):
                jsonschema.validate(broken, schema)
        broken = json.loads(json.dumps(doc))
        del broken["effects"][0]["reported"]["scopeNote"]
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate(broken, schema)
        broken["effects"][0]["reported"]["scopeNote"] = "x"
        broken["effects"][0]["reported"]["estimates"][0]["scale"] = "percent"
        with self.assertRaises(jsonschema.ValidationError):
            jsonschema.validate(broken, schema)


if __name__ == "__main__":
    unittest.main()
