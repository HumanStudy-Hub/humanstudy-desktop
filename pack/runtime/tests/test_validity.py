"""Build checks of issue #61: the package replays what participants experienced (check_validity.py),
effects carry N and a sign that agrees with their cells (effects.py), verbatim text is not copied from the
column-aligned text (check_verbatim.py), a skipped table's reason is true (check_results.py), and a
printed license is recorded (sources.py).
   python -m unittest discover -s pack/runtime/tests"""
import copy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[3]
BUILD = REPO / "pack/skills/build"
PROGRAM = REPO / "app/src/shared/sample-program.json"
sys.path.insert(0, str(BUILD))
import check_quotes  # noqa: E402
import check_results  # noqa: E402
import check_validity  # noqa: E402
import check_verbatim  # noqa: E402
import effects  # noqa: E402
import sources  # noqa: E402

NOT_TOLD = ("Participants were not told which key was correct; they had to learn that the red key paid "
            "more often than the blue key.")
PAGES = ["front matter long enough to be a text layer of a page", "Method. " + NOT_TOLD + " Each block had 40 trials."]
ENTRY = {"statement": NOT_TOLD, "page": 2, "withheld": "that the red key pays more often", "terms": ["red key", "pays more"]}

ADAPTER = '''
import sys
LEGEND = %(legend)r


def build_prompt(study, condition, history=(), trial=1):
    return "\\n\\n".join([%(instructions)r, LEGEND, "\\n".join(history), "Trial %%d. Press RED or BLUE." %% trial])


def parse_reply(study, condition, reply):
    return reply.strip().upper() if reply.strip().upper() in ("RED", "BLUE") else None


def run_sessions(llm, seed, n, arms=None):
    %(blocked)s
    out = []
    for i in range(n):
        history, trials = [], []
        for t in range(1, 31):
            key = parse_reply("s", "c", llm(build_prompt("s", "c", history, t)))
            history.append("%%d: %%s" %% (t, key))
            trials.append({"key": key, "parsed": key is not None})
        out.append({"condition": "c", "arm": "c", "trials": trials, %(valid)s})
    return out


if "--smoke-test" in sys.argv:
    print("ok")
'''


def adapter(legend="", instructions="Press a key on each trial.", blocked="", valid='"n": 30'):
    return ADAPTER % {"legend": legend, "instructions": instructions, "blocked": blocked or "pass", "valid": valid}


class FakePdfMixin:
    def fake_pdf(self, module, pages):
        class FakePdf:
            def __init__(self, path):
                pass

            def load(self):
                return pages
        original = module.Pdf
        module.Pdf = FakePdf
        self.addCleanup(setattr, module, "Pdf", original)


class Validity(FakePdfMixin, unittest.TestCase):
    def project(self, fields=(), adapter_text=None, issues=(), pages=PAGES):
        root = Path(tempfile.mkdtemp(prefix="check-validity-"))
        self.addCleanup(shutil.rmtree, root, True)
        p = json.loads(PROGRAM.read_text(encoding="utf-8"))
        task = next(n for n in p["nodes"] if n["id"] == "task")
        task["fields"] += [copy.deepcopy(f) for f in fields]
        p["issues"] += [copy.deepcopy(i) for i in issues]
        (root / "program.json").write_text(json.dumps(p), encoding="utf-8")
        (root / "paper.pdf").write_bytes(b"%PDF-1.4 stub")
        pkg = root / "package/x"
        (pkg / "task").mkdir(parents=True)
        (pkg / "task/adapter.py").write_text(adapter_text or adapter(), encoding="utf-8")
        self.fake_pdf(check_quotes, pages)
        return root

    def problems(self, root):
        return [m for m, _ in check_validity.check(root)["problems"]]

    @staticmethod
    def not_told(entries):
        return {"id": "not-told", "label": "What participants were not told", "origin": "reported",
                "state": "confirmed", "evidenceIds": [], "value": entries}

    MEMORY_ISSUE = {"id": "i-mem", "title": "Memory", "severity": "decision", "reason": "r", "impact": "i",
                    "suggestedAction": "s", "evidenceIds": [], "nodeId": "task", "fieldId": "replay-memory"}

    @staticmethod
    def memory(design, origin="implementation", evidence=()):
        return {"id": "replay-memory", "label": "Memory", "origin": origin, "state": "decision",
                "evidenceIds": list(evidence),
                "value": {"design": design, "shows": "x", "participantsSaw": "y", "expectedImpact": "z"}}

    def test_statements_are_found_once_per_passage(self):
        hits = check_validity.statements(PAGES + ["The experimenters were not told the condition."])
        self.assertEqual([h[0] for h in hits], [2])
        self.assertIn("were not told", hits[0][1])

    def test_missing_field_and_unlisted_statement_are_problems(self):
        found = self.problems(self.project())
        self.assertTrue(any("no `not-told` field" in m for m in found), found)
        self.assertTrue(any("p. 2 says" in m and "no not-told entry lists it" in m for m in found), found)

    def test_a_leak_in_build_written_text_is_caught_and_verbatim_text_is_not(self):
        mem = [self.memory("full-log", evidence=["e-1"])]
        clean = self.project([self.not_told([ENTRY])] + mem, issues=[self.MEMORY_ISSUE])
        self.assertEqual(self.problems(clean), [])
        leak = self.project([self.not_told([ENTRY])] + mem, adapter(legend="Hint: the red key pays more often."),
                            issues=[self.MEMORY_ISSUE])
        found = self.problems(leak)
        self.assertTrue(any("tells participants what they were not told (red key)" in m for m in found), found)
        # the same words inside the paper's own participant material (transcribed verbatim) are not a leak
        printed = {"id": "instructions", "label": "Instructions", "origin": "verbatim", "state": "confirmed",
                   "evidenceIds": [], "value": "At the end we will tell you whether the red key pays more often."}
        root = self.project([self.not_told([ENTRY]), printed] + mem,
                            adapter(instructions="At the end we will tell you whether the red key pays more often."),
                            issues=[self.MEMORY_ISSUE])
        self.assertEqual(self.problems(root), [])

    def test_entries_must_be_grounded_in_the_page(self):
        moved = dict(ENTRY, page=9)
        wrong_terms = dict(ENTRY, terms=["zzz unrelated"])
        empty = {"statement": NOT_TOLD, "page": 2}
        found = self.problems(self.project([self.not_told([moved, wrong_terms, empty])]))
        self.assertTrue(any("not-told[0]: the statement is not on p. 9" in m for m in found), found)
        self.assertTrue(any("not-told[1]: no term is a word of the printed statement" in m for m in found), found)
        self.assertTrue(any("not-told[2]: needs `withheld`" in m for m in found), found)
        na = dict(ENTRY, terms=[], withheld="", notApplicable="about the experimenters")
        found = self.problems(self.project([self.not_told([na])]))
        self.assertFalse(any("not-told" in m for m in found), found)

    def test_memory_design_is_a_recorded_decision_that_matches_the_prompts(self):
        nt = self.not_told([ENTRY])
        found = self.problems(self.project([nt]))
        self.assertTrue(any("records no `replay-memory` decision" in m for m in found), found)
        found = self.problems(self.project([nt, self.memory("full-log")], issues=[self.MEMORY_ISSUE]))
        self.assertTrue(any("full-log is not what participants saw" in m for m in found), found)
        found = self.problems(self.project([nt, self.memory("last-trial")], issues=[self.MEMORY_ISSUE]))
        self.assertTrue(any("design is 'last-trial' but the prompts carry every earlier trial" in m for m in found), found)
        found = self.problems(self.project([nt, self.memory("full-log")]))
        self.assertTrue(any("needs its decision issue" in m for m in found), found)
        self.assertEqual(self.problems(self.project([nt, self.memory("full-log", origin="researcher")],
                                                    issues=[self.MEMORY_ISSUE])), [])

    def test_blocked_adapters_are_read_statically_and_valid_all_is_a_problem(self):
        text = adapter(legend="Hint: the red key pays more often.", blocked='raise RuntimeError("blocked")',
                       valid='"valid": all(t["parsed"] for t in trials)')
        report = check_validity.check(self.project([self.not_told([ENTRY])], text))
        found = [m for m, _ in report["problems"]]
        self.assertIn("string literals", report["method"])
        self.assertTrue(any("tells participants what they were not told" in m for m in found), found)
        self.assertTrue(any("one unparsed reply drops the whole participant" in m for m in found), found)
        self.assertTrue(any("records no `replay-memory` decision" in m for m in found), found)

    def test_missing_instructions_are_a_decision(self):
        field = {"id": "instructions", "label": "Instructions", "origin": "unknown", "state": "missing",
                 "evidenceIds": [], "value": None}
        issue = {"id": "i-instr", "title": "Instructions not printed", "severity": "blocking", "reason": "r",
                 "impact": "i", "suggestedAction": "s", "evidenceIds": [], "nodeId": "task", "fieldId": "instructions"}
        found = self.problems(self.project([self.not_told([ENTRY]), field], issues=[issue]))
        self.assertTrue(any("missing participant instructions has severity 'blocking'" in m for m in found), found)
        found = self.problems(self.project([self.not_told([ENTRY]), field], issues=[dict(issue, severity="decision")]))
        self.assertFalse(any("missing participant instructions" in m for m in found), found)


class EffectRules(unittest.TestCase):
    def setUp(self):
        self.program = json.loads(PROGRAM.read_text(encoding="utf-8"))
        self.program["evidence"].append({"id": "e-r", "quote": "LAC participants chose the risky option less often "
                                         "(M = .394) than GSC participants (M = .497), t(39) = 2.04, dz = 0.322."})
        self.program["evidence"].append({"id": "e-n", "quote": "Forty participants (N = 40) took part."})

    def effect(self, **rep):
        base = {"estimates": [{"metric": "standardized_mean_difference", "value": -0.322}],
                "cells": {"LAC": {"mean": 0.394}, "GSC": {"mean": 0.497}}, "n": 40, "evidenceIds": ["e-r", "e-n"]}
        base.update(rep)
        return {"effects": [{"id": "e1", "studyId": "exp-1", "contrast": {"kind": "paired", "treatment": "LAC",
                                                                           "reference": "GSC"},
                             "prediction": {"direction": "negative"}, "reported": base}]}

    def rules(self, doc):
        return effects.build_rules(doc, self.program)

    def test_sign_follows_the_cells_not_the_printed_absolute_value(self):
        self.assertEqual(self.rules(self.effect()), [])
        unsigned = self.effect(estimates=[{"metric": "standardized_mean_difference", "value": 0.322}])
        found = self.rules(unsigned)
        self.assertTrue(any("cells give LAC - GSC = -0.103" in m for m in found), found)

    def test_without_cells_an_unsigned_value_needs_its_basis(self):
        doc = self.effect(cells={}, estimates=[{"metric": "standardized_mean_difference", "value": -0.322}])
        self.assertTrue(any("signBasis" in m for m in self.rules(doc)))
        doc["effects"][0]["reported"]["estimates"][0]["signBasis"] = "LAC participants chose the risky option less often"
        self.assertEqual(self.rules(doc), [])
        # a value the paper prints with its minus sign needs no basis
        self.program["evidence"][-2]["quote"] += " d = -0.40."
        doc = self.effect(cells={}, estimates=[{"metric": "standardized_mean_difference", "value": -0.4}])
        self.assertEqual(self.rules(doc), [])

    def test_printed_n_is_required_unless_missing_says_why(self):
        found = self.rules(self.effect(n=None))
        self.assertTrue(any("its quotes print N (40)" in m for m in found), found)
        doc = self.effect(n=None, evidenceIds=["e-r"])
        participant = next(n for n in self.program["nodes"] if n["kind"] == "participants")
        participant["fields"].append({"id": "n-analysed", "label": "N", "origin": "reported", "state": "confirmed",
                                      "evidenceIds": [], "value": "40 (no exclusions)"})
        found = self.rules(doc)
        self.assertTrue(any("program.json records the study's sample" in m for m in found), found)
        doc["effects"][0]["reported"]["missing"] = ["N of this subgroup is not printed"]
        self.assertEqual(self.rules(doc), [])


class VerbatimSplits(FakePdfMixin, unittest.TestCase):
    PAGE = "That number may not have direct correspondence with the final amount, press the lateral key."

    def statuses(self, values, other_layers):
        root = Path(tempfile.mkdtemp(prefix="check-verbatim-"))
        self.addCleanup(shutil.rmtree, root, True)
        p = json.loads(PROGRAM.read_text(encoding="utf-8"))
        p["evidence"].append({"id": "ev-1", "path": "paper.pdf", "locator": {"page": 1}, "quote": "x"})
        node = next(n for n in p["nodes"] if n["id"] == "material-1-harm")
        node["fields"] = [{"id": k, "label": k, "origin": "verbatim", "state": "confirmed", "evidenceIds": ["ev-1"],
                           "value": v} for k, v in values.items()]
        (root / "program.json").write_text(json.dumps(p), encoding="utf-8")
        (root / "paper.pdf").write_bytes(b"%PDF-1.4 stub")
        primary = self.PAGE.replace("lateral", "l ateral")   # one reader splits a word
        self.fake_pdf(check_quotes, [primary])
        original = check_verbatim.raw_layers
        check_verbatim.raw_layers = lambda path: other_layers
        self.addCleanup(setattr, check_verbatim, "raw_layers", original)
        report = check_verbatim.check(root / "program.json")
        return {r["field"].split(".", 1)[1]: r["status"] for r in report["results"]
                if r["field"].startswith("material-1-harm.")}

    def test_words_split_by_the_layout_text_are_problems(self):
        values = {"split": "That number may not have direct correspon dence with the final amount",
                  "split-like-one-reader": "press the l ateral key", "wide": "That number  may not have direct",
                  "good": "That number may not have direct correspondence with the final amount"}
        got = self.statuses(values, [[self.PAGE]])
        self.assertEqual(got, {"split": "layout_split", "split-like-one-reader": "layout_split",
                               "wide": "layout_split", "good": "found"})

    def test_a_reader_that_drops_spaces_is_ignored(self):
        merged = "".join(w if i % 2 else " " + w for i, w in enumerate(self.PAGE.split())) * 3
        merged += " averyveryverylongmergedtoken anotherveryverylongmergedone" * 3
        got = self.statuses({"good": "That number may not have direct correspondence"}, [[merged]])
        self.assertEqual(got, {"good": "found"})


class SkippedTables(FakePdfMixin, unittest.TestCase):
    def problems(self, layout, caption="Table A1\nParameter correlations across conditions"):
        root = Path(tempfile.mkdtemp(prefix="check-results-"))
        self.addCleanup(shutil.rmtree, root, True)
        p = json.loads(PROGRAM.read_text(encoding="utf-8"))
        node = next(n for n in p["nodes"] if n["id"] == "result-1")
        node["fields"].append({"id": "table-a1", "label": "Table A1", "origin": "unknown", "state": "missing",
                               "evidenceIds": [], "value": {"table": "Table A1", "page": 2, "columns": [], "rows": []}})
        (root / "program.json").write_text(json.dumps(p), encoding="utf-8")
        (root / "paper.pdf").write_bytes(b"%PDF-1.4 stub")
        self.fake_pdf(check_results, ["front matter long enough to be a text layer of a page",
                                      caption + "\n" + layout])
        original = check_results.layout_page
        check_results.layout_page = lambda path, number: layout
        self.addCleanup(setattr, check_results, "layout_page", original)
        return [m for m, _ in check_results.check(root / "program.json")["problems"]]

    GRID = "\n".join(["theta  -.19   -.71   .76  -.24", "lambda  [-.47, .11]   .12   .05",
                      "alpha  [-.89, -.53]  [-.20, .41]  -.47"])

    def test_a_clean_table_marked_missing_is_a_problem(self):
        found = self.problems(self.GRID)
        self.assertTrue(any("Table A1 is marked missing, but p. 2 has a clean text layer" in m for m in found), found)

    def test_prose_with_statistics_and_cited_supplementary_tables_are_not(self):
        prose = "\n".join(["we found r(578) = 0.198, p < 0.001 and r(573) = 0.159, p < 0.001 in the sample"] * 4)
        self.assertFalse(any("marked missing" in m for m in self.problems(prose)))
        found = self.problems(self.GRID, caption="Detailed correlations are in Supplementary\nTable A1.")
        self.assertFalse(any("marked missing" in m for m in found), found)


class PrintedLicense(FakePdfMixin, unittest.TestCase):
    def test_statements_about_the_paper_are_read_and_others_are_not(self):
        self.assertEqual(sources.spdx("Creative Commons Attribution 4.0 International License, which permits"), "CC-BY-4.0")
        self.assertEqual(sources.spdx("CC-BY-NC-ND 4.0 International license"), "CC-BY-NC-ND-4.0")
        self.assertEqual(sources.spdx("Creative Commons Attribution License, which permits"), "CC-BY")
        self.assertEqual(sources.spdx("Creative Commons Attribution License 4.0 (CC BY)"), "CC-BY-4.0")
        cases = [
            ("Open Access This article is licensed under a Creative Commons Attribution 4.0 International License, "
             "which permits use.", "CC-BY-4.0"),
            ("It is made available under a CC-BY-NC-ND 4.0 International license.", "CC-BY-NC-ND-4.0"),
            ("Figure 2 is adapted from Smith (2019), licensed under CC BY 4.0.", None),
            ("Copies can be used for personal research under the following conditions.", None)]
        for text, want in cases:
            self.fake_pdf(check_quotes, ["front page", text])
            got = sources.printed_license(Path("paper.pdf"))
            self.assertEqual(got[0] if got else None, want, text)
            if got:
                self.assertTrue(got[1].startswith("p. 2: "), got)

    def test_unknown_is_replaced_and_check_fails_while_unknown(self):
        root = Path(tempfile.mkdtemp(prefix="sources-"))
        self.addCleanup(shutil.rmtree, root, True)
        shutil.copy(PROGRAM, root / "program.json")
        (root / "paper.pdf").write_bytes(b"%PDF-1.4 the paper")
        self.fake_pdf(check_quotes, ["Open Access This article is licensed under a Creative Commons Attribution 4.0 "
                                     "International License, which permits use."])
        (root / "sources").mkdir()
        data = sources.build(root)
        self.assertEqual((data["pdf"]["license"], data["pdf"]["licenseEvidence"][:5]), ("CC-BY-4.0", "p. 1:"))
        data["files"][0]["license"] = data["pdf"]["license"] = "unknown"
        (root / "sources/SOURCE.json").write_text(json.dumps(data), encoding="utf-8")
        found = [m for m, _ in sources.problems(root)]
        self.assertTrue(any("recorded as license unknown, but it prints one (CC-BY-4.0)" in m for m in found), found)
        explicit = sources.build(root, {"paper.pdf": "CC-BY-NC-4.0"}, {"paper.pdf": "p. 1 footer"})
        self.assertEqual(explicit["pdf"]["license"], "CC-BY-NC-4.0", "--license overrides the printed one")


if __name__ == "__main__":
    unittest.main()
