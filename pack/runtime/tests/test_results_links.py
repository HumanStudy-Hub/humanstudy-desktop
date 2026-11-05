"""Results coverage (check_results.py: results printed only in the text, the sample's make-up, the abstract's
findings, supplement tables) and evaluation links (effects.py: the computed block holds what `reported` claims).
   python -m unittest discover -s pack/runtime/tests"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_agent_package import REPO, make_project  # noqa: E402
from test_sources_tables import HAVE_PDF, make_pdf  # noqa: E402

sys.path.insert(0, str(REPO / "pack/skills/build"))
import check_results as cr  # noqa: E402
import effects  # noqa: E402

PROGRAM = REPO / "app/src/shared/sample-program.json"
INTRO = "Introduction\n\nEarlier work on moral judgment is reviewed here at some length before the method."
RESULTS = ("Results\n\n"
           "Men lied more often than women in the first game, b = 0.25, p = .048, and the effect held in the second "
           "game, b = 0.31, p = .021. Trust predicted giving, b = 0.12, p = .008, and so did age, b = 0.05, p = .330. "
           "Reciprocity interacted with framing, b = 0.40, p = .012, but not with stakes, b = 0.07, p = .410.")
SAMPLE = ("Method\n\nParticipants. We recruited 280 adults online; 58 men and 222 women took part (mean age = 33.8, "
          "SD = 12.4).")


def program(fields=(), characteristics=None):
    p = json.loads(PROGRAM.read_text(encoding="utf-8"))
    node = next(n for n in p["nodes"] if n["id"] == "result-1")
    node["fields"] = [f for f in node["fields"] if f["id"] == "result_kind"] + list(fields)
    if characteristics is not None:
        part = next(n for n in p["nodes"] if n.get("kind") == "participants")
        part["fields"] = [f for f in part["fields"] if f["id"] != "characteristics"] + [
            {"id": "characteristics", "label": "Characteristics", "origin": "reported", "state": "confirmed",
             "value": characteristics, "evidenceIds": part.get("evidenceIds", [])[:1]}]
    return p


def table_field(rows, columns=("Predictor", "b", "p"), label=None, source=None):
    value = {"title": "assembled from the text", "page": 2, "columns": list(columns), "rows": rows}
    if label:
        value["table"] = label
    if source:
        value["source"] = source
    return {"id": "text-stats", "label": "Text statistics", "origin": "reported" if not label else "verbatim",
            "state": "confirmed", "evidenceIds": ["e1"], "value": value}


def problems(pages, prog, effects_doc=None, record=None):
    record = record or {}
    spans, out = cr._skipped(record, pages)
    out += cr.text_problems(cr.text_coverage(pages, prog, effects_doc, spans))
    out += cr.abstract_problems(pages, prog, effects_doc, record)
    return [m for m, _ in out]


class TextCoverage(unittest.TestCase):
    def test_exact_p_values_in_the_text_must_be_recorded(self):
        pages = [INTRO, RESULTS]
        found = problems(pages, program())
        self.assertTrue(any("only 0 of the 6 exact p values" in m for m in found), found)
        self.assertTrue(any("results passages print numbers none of which is recorded" in m for m in found), found)
        rows = [["men", "0.25", ".048"], ["second", "0.31", ".021"], ["trust", "0.12", ".008"],
                ["age", "0.05", ".330"], ["framing", "0.40", ".012"], ["stakes", "0.07", ".410"]]
        self.assertEqual(problems(pages, program([table_field(rows)])), [])
        # the coefficient recorded but not its p value: the pair is not recorded
        bare = [[r[0], r[1], ""] for r in rows]
        found = problems(pages, program([table_field(bare)]))
        self.assertTrue(any("exact p values" in m for m in found), found)

    def test_effects_reported_counts_as_recorded(self):
        doc = {"effects": [{"id": "e%d" % i, "reported": {"estimates": [{"metric": "regression_coefficient", "value": b,
                                                                          "p": p}], "evidenceIds": ["x"]}}
                           for i, (b, p) in enumerate([(0.25, .048), (0.31, .021), (0.12, .008), (0.05, .33),
                                                       (0.40, .012), (0.07, .41)])]}
        self.assertEqual(problems([INTRO, RESULTS], program(), doc), [])

    def test_uppercase_p_and_pairs_recorded_together(self):
        text = ("Results\n\nIn the loss frame 72% vs 28% chose the risky option (P = 0.004); the same pattern held "
                "with 64% vs 31% in study 2 and 55% vs 22% among students, as the participants reported.")
        found = problems([INTRO, text], program())
        self.assertTrue(any("counts and percentage comparisons" in m for m in found), found)
        doc = {"effects": [{"id": "e%d" % i, "reported": {"cells": {"a": {"percent": a}, "b": {"percent": b}},
                                                           "test": {"statistic": "chi_square", "p": 0.004},
                                                           "evidenceIds": ["x"]}}
                           for i, (a, b) in enumerate([(72, 28), (64, 31), (55, 22)])]}
        self.assertEqual(problems([INTRO, text], program(), doc), [])

    def test_sample_make_up(self):
        found = problems([INTRO, SAMPLE], program())
        self.assertTrue(any("sample's sex or gender" in m for m in found), found)
        self.assertTrue(any("sample's age" in m for m in found), found)
        self.assertEqual(problems([INTRO, SAMPLE], program(characteristics="58 men, 222 women; mean age 33.8 "
                                                                         "(SD 12.4)")), [])

    def test_not_results_are_not_counted(self):
        text = ("Method\n\nA power analysis with G*Power showed that d = 0.50, p = .05 needs 64 per group. "
                "Smith et al. (2012) found d = 0.41, p = .030 in a similar task. The computer chose the left box "
                "with probability p = .80. Our models were pure model-based in 4 out of 11 algorithms, and in "
                "2019 (45%) of the sessions ran online. Choose A 64 (80%) Choose B 16 (20%) Choose C 12 (15%).")
        self.assertEqual(problems([INTRO, text], program()), [])

    def test_results_not_recorded_clears_a_passage_whose_quote_is_in_the_paper(self):
        payoff = ("Results\n\nThe payoff table gave M = 4.5, SD = 1.2 points per round, t(40) = 2.10, p = .042 "
                  "under the design.")
        found = problems([INTRO, payoff], program())
        self.assertTrue(any("results passages" in m for m in found), found)
        quote = "The payoff table gave M = 4.5, SD = 1.2 points per round"
        ok = {"resultsNotRecorded": [{"page": 2, "quote": quote, "reason": "a design value, not a result"}]}
        self.assertEqual(problems([INTRO, payoff], program(), record=ok), [])
        bad = {"resultsNotRecorded": [{"page": 2, "quote": "a sentence the paper does not print", "reason": "x y z"}]}
        found = problems([INTRO, payoff], program(), record=bad)
        self.assertTrue(any("is not the passage's exact text" in m for m in found), found)

    def test_results_not_recorded_clears_only_its_own_span_on_its_page(self):
        pages = [INTRO, RESULTS]
        def found(item):
            return problems(pages, program(), record={"resultsNotRecorded": [item]})
        base = problems(pages, program())
        self.assertTrue(any("exact p values" in m for m in base), base)
        # a short quote no statistic lies in clears nothing (not every number within 200 characters)
        short = found({"page": 2, "quote": "in the first game", "reason": "a design value of the game"})
        self.assertTrue(any("exact p values" in m for m in short), short)
        # a page is required: a quote with no page does not clear every page
        nopage = found({"page": None, "quote": RESULTS.split("\n\n")[1], "reason": "a design value of the game"})
        self.assertTrue(any("give the page the quote is printed on" in m for m in nopage), nopage)
        # a quote that prints p values is this paper's result unless the reason says what else it is
        whole = RESULTS.split("\n\n")[1]
        own = found({"page": 2, "quote": whole, "reason": "not needed for the replay"})
        self.assertTrue(any("prints a test result (b = 0.25)" in m for m in own), own)
        self.assertEqual(found({"page": 2, "quote": whole, "reason": "Smith et al. (2010), another study's result, "
                                                                     "cited"}), [])
        # only the statistic inside the quote is cleared: the p printed after it still counts
        part = found({"page": 2, "quote": "Men lied more often than women in the first game, b = 0.25",
                      "reason": "a design value of the first game"})
        self.assertTrue(any("exact p values" in m for m in part), part)

    def test_design_values_quoted_instruments_and_other_samples_are_not_results(self):
        lottery = ("Method\n\nDesign. In each round the computer drew a number with probability p = .50 of success. The "
                   "payoff was 10 points with p = .25, 20 points with p = .25, and 0 with p = .50. Each lottery paid out "
                   "with p = .80 or p = .20 depending on the arm. Agents cooperated with p = .3 in round 1, p = .5 in "
                   "round 2, p = .7 in round 3.")
        self.assertEqual(problems([INTRO, lottery], program()), [])
        # a test with its p value next to the word "chance" is still a result
        chance = ("Results\n\nChoices differed from chance, t(39) = 2.50, p = .017; ratings from the midpoint, t(39) = "
                  "3.10, p = .004; times from zero, t(39) = 2.2, p = .034; errors, t(39) = 2.9, p = .006; recall, "
                  "t(39) = 2.4, p = .021; and confidence, t(39) = 2.7, p = .010.")
        self.assertTrue(any("exact p values" in m for m in problems([INTRO, chance], program())))
        instrument = ("Method\n\nMaterials. Participants read: 'Option A gives a 30% vs 70% chance of winning; Option "
                      "B gives 50% vs 50%; Option C gives 10% vs 90%; Option D gives 80% versus 20%.'")
        self.assertEqual(problems([INTRO, instrument], program()), [])
        unquoted = ("Method\n\nMaterials. Option A gave 30% vs 70% odds of a prize. Option B gave 50% vs 50% and "
                    "option C gave 10% vs 90%, which participants judged; option D gave 80% versus 20% to everyone "
                    "who took part.")
        found = problems([INTRO, unquoted], program())
        self.assertTrue(any("percentage comparisons" in m for m in found), found)
        material = cr._flat("Option B gave 50% vs 50% and option C gave 10% vs 90%. Option D gave 80% versus 20%.")
        spans = cr._skipped({}, [INTRO, unquoted])[0]
        report = cr.text_coverage([INTRO, unquoted], program(), None, spans, material)
        self.assertEqual(cr.text_problems(report), [])
        population = ("Method\n\nThe town's population is 48% male and the national average age is 40.2 years. Our "
                      "participants were students.")
        self.assertEqual(problems([INTRO, population], program()), [])

    def test_a_p_is_a_design_probability_only_when_directly_governed(self):
        def flagged(sentences):
            return any("exact p values" in m or "results passages" in m
                       for m in problems([INTRO, "Results\n\n" + " ".join(sentences)], program()))
        letters = "ABCDEFG"
        # a bare "with", or a design word elsewhere in the sentence, does not make a p a design value
        self.assertTrue(flagged(["Condition %s raised giving relative to control, with p = .0%d." % (c, k)
                                 for k, c in enumerate(letters, 1)]))
        self.assertTrue(flagged(["Participants chose the risky gamble more often in frame %s, p = .0%d." % (c, k)
                                 for k, c in enumerate(letters, 1)]))
        # "in the first round" after a test's p, and "p = .x and p = .y, respectively", are results
        self.assertTrue(flagged(["Giving fell, t(80) = 2.%d, p = .0%d in the first round." % (k, k)
                                 for k in range(1, 8)]))
        self.assertTrue(flagged(["Effects A and B held, t(80) = 2.%d and t(80) = 3.%d, p = .0%d and p = .00%d, "
                                 "respectively." % (k, k, k, k) for k in range(1, 5)]))
        # governed: "with probability", "10 points with", "paid out with ... or", "of winning", "in round 2"
        design = ("Method\n\nEach option paid 10 points with p = .25, 20 tokens at p = .25, or $5 with p = .50. "
                  "The urn was drawn with a probability of .40, and the bonus came at probability p = .60. "
                  "The lottery paid out with p = .80 or p = .20. A ball had p = .30 of winning. Partners "
                  "cooperated with p = .3 in round 1 and p = .5 in round 2.")
        self.assertEqual(problems([INTRO, design], program()), [])

    def test_chance_pairs_are_design_values_only_beside_the_chance_word(self):
        observed = ("Results\n\nIn the loss frame 72% vs 45% chose the gamble. In the gain frame 62% vs 38% chance "
                    "of choosing it was observed. Overall 70% vs 30% probability of picking the safe option, and "
                    "55% vs 20% likelihood of switching.")
        self.assertTrue(any("percentage comparisons" in m for m in problems([INTRO, observed], program())))
        design = ("Method\n\nOption A gives a 30% vs 70% chance of a prize. Option B gives 50% vs 50% chances of "
                  "winning. Option C gives 10% vs 90% odds. Option D gives 80% versus 20% probability.")
        self.assertEqual(problems([INTRO, design], program()), [])

    def test_a_singular_reference_line_does_not_end_the_text(self):
        page = ("Method\n\nParticipants were 100 adults.\nReference\n\nResults\n\n"
                + " ".join("Condition %s raised giving, t(80) = 2.%d, p = .0%d." % (c, k, k)
                           for k, c in enumerate("ABCDEFG", 1)))
        self.assertTrue(any("exact p values" in m for m in problems([INTRO, page], program())))

    def test_results_not_recorded_reasons_must_name_what_the_quote_is(self):
        quote = "Men lied more often than women in the first game, b = 0.25, p = .048"
        def found(reason, text=RESULTS, q=quote):
            return problems([INTRO, text], program(),
                            record={"resultsNotRecorded": [{"page": 2, "quote": q, "reason": reason}]})
        for vague in ("the design of the study is irrelevant here", "prior research suggests otherwise, so not "
                      "ours", "a reference point for the reader", "not relevant to our hypothesis at all"):
            self.assertTrue(any("prints a test result" in m for m in found(vague)), vague)
        for specific in ("a design value of the game", "a power analysis for the sample", "the payoff of each "
                         "round", "another study's result", "cited from Smith (2010)", "Smith et al. report it"):
            self.assertFalse(any("prints a test result" in m for m in found(specific)), specific)
        self.assertTrue(any("reason must be text" in m for m in found({"a": "a power analysis value"})))
        # a quote printing p < .05, b = 0.25 with no df, or a 95% CI is a test result too
        for printed in ("Men lied more often than women in the first game, b = 0.25, p < .05",
                        "Men lied more often than women in the first game, b = 0.25",
                        "Men lied more often than women, 95% CI [0.1, 0.4]"):
            text = "Results\n\n" + printed + ". " + RESULTS.split("\n\n")[1]
            self.assertTrue(any("prints a test result" in m for m in found("not needed for the replay", text,
                                                                            printed)), printed)

    def test_table_rows_on_a_page_whose_table_is_reported_count_once(self):
        rows = ("Results\n\nTable 2 Choices by condition. In the control condition 64 (80%) chose the safe option and "
                "16 (20%) the risky one; in the treatment condition 50 (62%) chose safe and 30 (38%) risky; in the "
                "neutral condition 44 (55%) and 36 (45%).")
        self.assertTrue(cr.text_problems(cr.text_coverage([INTRO, rows], program(), None, [])))
        self.assertEqual(cr.text_problems(cr.text_coverage([INTRO, rows], program(), None, [], "", {2})), [])

    def test_numbered_references_heading_ends_the_text(self):
        cited = ("Smith, J. (2010). Effects p = .01 in trust, b = 0.3, p = .02. J Psych, 12, 1-20. Lee, K. (2012). "
                 "Null p = .03 b = 0.2 p = .04. Kim (2015) p = .05, p = .06, b = 0.1 p = .07.")
        for heading in ("7. References", "References and Notes", "REFERENCES", "Literature Cited"):
            page = "Results\n\nWe found nothing of note in this part of the study.\n\n%s\n\n%s" % (heading, cited)
            self.assertEqual(problems([INTRO, "Method\n\nParticipants were 100 adults.", page, "x", "y"],
                                      program()), [], heading)
        # a references line before the paper's own part begins cuts nothing
        early = "References\n\nSee the appendix.\n\n" + RESULTS
        self.assertTrue(any("exact p values" in m for m in problems([INTRO, early], program())))

    def test_passages_split_text_without_blank_lines(self):
        page = ("2.1 Results\nThe first line of a long paragraph that runs on and on across the column.\n"
                "It ends here.\nA new paragraph starts on the next line and runs across the column too.\n")
        blocks = cr._blocks(page)
        self.assertEqual(len(blocks), 3, blocks)


ABSTRACT = ("Abstract\n\nWe study white lies in two games with an online sample of adults from three countries. "
            "We found three major results: (i) men are more likely than women to tell an altruistic white lie, "
            "(ii) altruistic lies increased with the benefit to the other player, and (iii) Pareto white lies "
            "were not more common among older participants than among younger ones.\n\nKeywords: lying")


class AbstractResults(unittest.TestCase):
    def fields(self):
        return [{"id": "awl-gender", "label": "Altruistic white lies by gender", "origin": "reported",
                 "state": "confirmed", "evidenceIds": ["e1"], "value": "men 26% vs women 18%"},
                {"id": "trust", "label": "Trust rating", "origin": "reported", "state": "confirmed",
                 "evidenceIds": ["e1"], "value": "M = 3.2"}]

    def test_every_abstract_finding_is_mapped(self):
        pages = [ABSTRACT, INTRO]
        found = problems(pages, program())
        self.assertTrue(any("the abstract states results" in m for m in found), found)
        claims = {"abstractResults": [
            {"claim": "men are more likely than women to tell an altruistic white lie", "recordedIn": ["result-1.awl-gender"]},
            {"claim": "altruistic lies increased with the benefit to the other player",
             "notRecorded": "stated only in words, the paper prints no statistic for it"},
            {"claim": "Pareto white lies were not more common among older participants than among younger ones",
             "recordedIn": ["result-1.trust"]}]}
        found = problems(pages, program(self.fields()), record=claims)
        self.assertTrue(any("none of result-1.trust is about it" in m for m in found), found)
        claims["abstractResults"][2]["recordedIn"] = ["result-1.nope"]
        found = problems(pages, program(self.fields()), record=claims)
        self.assertTrue(any("recordedIn names what does not exist (result-1.nope)" in m for m in found), found)
        claims["abstractResults"][2] = {"claim": "Pareto white lies were not more common among older participants "
                                                 "than among younger ones", "notRecorded": "the paper prints no test of age"}
        self.assertEqual(problems(pages, program(self.fields()), record=claims), [])
        claims["abstractResults"].append({"claim": "women lie more", "notRecorded": "words the abstract does not print"})
        found = problems(pages, program(self.fields()), record=claims)
        self.assertTrue(any("not the abstract's own words" in m for m in found), found)

    def test_a_finding_an_effect_or_field_clearly_records_needs_no_claim(self):
        doc = {"effects": [{"id": "awl", "label": "Men vs women: altruistic white lie", "reported": {"evidenceIds": []}},
                           {"id": "benefit", "label": "Altruistic lies by the benefit to the other player",
                            "reported": {"evidenceIds": []}},
                           {"id": "age", "label": "Pareto white lies, older vs younger participants",
                            "reported": {"evidenceIds": []}}]}
        self.assertEqual(problems([ABSTRACT, INTRO], program(), doc), [])

    def test_background_sentences_are_not_findings(self):
        text = ("Abstract\n\nPrevious work has shown that people lie less when observed. In this paper we use a new "
                "die-roll task to measure lying in groups of four players who see each other's reports and payoffs "
                "over twenty rounds with changing stakes and feedback after every round of the game.\n\nKeywords: x")
        self.assertEqual(cr.abstract_findings(cr.abstract_text([text])), [])


@unittest.skipUnless(HAVE_PDF, "pdfplumber and pypdf (in the HumanStudy runtime) are needed")
class SupplementAndProject(unittest.TestCase):
    def project(self, prog, record=None, supplement=True, current=True):
        root = Path(tempfile.mkdtemp(prefix="results-links-"))
        self.addCleanup(shutil.rmtree, root, True)
        if current:   # a package with the shared reply reader: the coverage rules are problems (contract.py)
            (root / "package/study/task").mkdir(parents=True)
            (root / "package/study/task/replies.py").write_text("# the shared reply reader\n", encoding="utf-8")
        (root / "program.json").write_text(json.dumps(prog), encoding="utf-8")
        (root / "paper.pdf").write_bytes(make_pdf([[(72, 700, "A short paper with no results printed.")]]))
        (root / "sources/open").mkdir(parents=True)
        if supplement:
            rows = [(72, 700, "Table S1. Descriptive statistics of the items")]
            for i, (m, sd) in enumerate([("3.41", "1.02"), ("2.87", "0.95"), ("4.12", "0.77"), ("3.05", "1.21")]):
                rows += [(90, 680 - 14 * i, "Item %d" % (i + 1)), (250, 680 - 14 * i, m), (320, 680 - 14 * i, sd)]
            (root / "sources/open/supp.pdf").write_bytes(make_pdf([rows]))
        (root / "sources/SOURCE.json").write_text(json.dumps(record or {}), encoding="utf-8")
        return root

    def check(self, root):
        return [m for m, _ in cr.check(root / "program.json")["problems"]]

    def test_supplement_tables_are_listed_and_recorded(self):
        found = self.check(self.project(program()))
        self.assertTrue(any("supplement under sources/ prints result tables" in m and "Table S1" in m
                            for m in found), found)
        rows = [["Item 1", "3.41", "1.02"], ["Item 2", "2.87", "0.95"], ["Item 3", "4.12", "0.77"],
                ["Item 4", "3.05", "1.21"]]
        field = table_field(rows, ("Item", "M", "SD"), label="Table S1", source="sources/open/supp.pdf")
        self.assertEqual(self.check(self.project(program([field]))), [])
        field = table_field(rows[:1], ("Item", "M", "SD"), label="Table S1", source="sources/open/supp.pdf")
        found = self.check(self.project(program([field])))
        self.assertTrue(any("holds only 2 of the table's 8 numbers" in m for m in found), found)
        other = {"paperTables": [{"table": "S1", "source": "sources/open/supp.pdf", "kind": "other",
                                  "what": "pilot item wording check, not this paper's results"}]}
        self.assertEqual(self.check(self.project(program(), other)), [])
        whole = {"paperTables": [{"source": "sources/open/supp.pdf", "kind": "other",
                                  "what": "another paper by the same authors"}]}
        self.assertEqual(self.check(self.project(program(), whole)), [])

    def test_a_private_supplement_is_listed_as_a_reference_not_transcribed(self):
        for folder in ("private", "researcher"):
            root = self.project(program())
            (root / "sources" / folder).mkdir()
            (root / "sources/open/supp.pdf").rename(root / "sources" / folder / "supp.pdf")
            found = self.check(root)
            self.assertTrue(any("sources/private/ or sources/researcher/" in m and "Table S1" in m for m in found),
                            found)
            ref = {"paperTables": [{"table": "S1", "source": "sources/%s/supp.pdf" % folder, "page": 1,
                                    "kind": "result"}]}
            (root / "sources/SOURCE.json").write_text(json.dumps(ref), encoding="utf-8")
            self.assertEqual(self.check(root), [])

    @unittest.skipUnless(HAVE_PDF, "needs pypdf")
    def test_private_supplement_cells_copied_into_the_program_are_flagged(self):
        import check_materials
        rows = [["Item 1", "3.41", "1.02"], ["Item 2", "2.87", "0.95"], ["Item 3", "4.12", "0.77"],
                ["Item 4", "3.05", "1.21"]]
        field = table_field(rows, ("Item", "M", "SD"), label="Table S1", source="sources/private/supp.pdf")
        root = self.project(program([field]))
        (root / "sources/private").mkdir()
        (root / "sources/open/supp.pdf").rename(root / "sources/private/supp.pdf")
        found = [m for m, _ in check_materials.check(root)["problems"]]
        self.assertTrue(any("program.json copies the private material sources/private/supp.pdf" in m
                            for m in found), found)

    def test_an_older_build_gets_the_coverage_rules_as_warnings(self):
        report = cr.check(self.project(program(), current=False) / "program.json")
        self.assertEqual(report["problems"], [])
        self.assertTrue(any("Table S1" in m for m, _ in report["warnings"]), report["warnings"])
        # with the package given (the readiness gate), that package's own contract decides
        root = self.project(program())
        (root / "package/old/task").mkdir(parents=True)
        report = cr.check(root / "program.json", package=root / "package/old")
        self.assertEqual(report["problems"], [])
        self.assertTrue(any("Table S1" in m for m, _ in report["warnings"]), report["warnings"])
        report = cr.check(root / "program.json", package=root / "package/study")
        self.assertTrue(any("Table S1" in m for m, _ in report["problems"]), report)

    def test_project_without_results_text_or_supplement_passes(self):
        self.assertEqual(self.check(self.project(program(), supplement=False)), [])


# ---- effects.py: links ---------------------------------------------------------------------------------

def effect(eid="e1", reported=None, compute=None, **extra):
    e = {"id": eid, "studyId": "s1", "contrast": {"kind": "two_groups", "treatment": "a", "reference": "b"},
         "reported": dict({"evidenceIds": ["x"]}, **(reported or {})),
         "compute": compute or {"op": "mean_difference", "field": "answer"}}
    e.update(extra)
    return e


def links(effs, blocks=None, declarations=None, ran=True):
    return effects.link_problems({"effects": effs}, blocks or {}, declarations or {}, ran)


class Links(unittest.TestCase):
    def test_statistic_kind(self):
        r = {"estimates": [{"metric": "correlation", "value": 0.4}]}
        found = links([effect(reported=r, compute={"op": "paired_difference", "field": "x", "referenceField": "y"})])
        self.assertTrue(any("reported holds correlation" in m for m in found), found)
        self.assertEqual(links([effect(reported=r, compute={"op": "correlation", "field": "x", "withField": "y"})]), [])
        alias = {"op": "package", "key": "k", "compareAs": {"metric": "correlation", "reason": "the same r"}}
        self.assertEqual(links([effect(reported=r, compute=alias)], {"k": {"status": "computed", "metric": "t"}}), [])
        # a d with the cell means printed is compared through the means; without them it is not comparable
        d = {"estimates": [{"metric": "standardized_mean_difference", "value": 0.5}]}
        self.assertTrue(links([effect(reported=d)]))
        d["cells"] = {"a": {"n": 20, "mean": 3.1, "sd": 1.0}, "b": {"n": 20, "mean": 2.6, "sd": 1.1}}
        self.assertEqual(links([effect(reported=d)]), [])
        # only a test: the same test
        u = {"test": {"statistic": "U", "value": 120}}
        self.assertTrue(any("a U test" in m for m in links([effect(reported=u)])))
        self.assertEqual(links([effect(reported={"test": {"statistic": "t", "value": 2.1}})]), [])

    def test_package_blocks_need_a_visible_kind_or_a_declaration(self):
        r = {"estimates": [{"metric": "correlation", "value": 0.4}]}
        e = effect(reported=r, compute={"op": "package", "key": "k"})
        found = links([e], {"k": {"status": "not_ready"}})
        self.assertTrue(any("is not computed on the stand-in run" in m and "OUTPUT_KINDS" in m for m in found), found)
        self.assertEqual(links([e], {}, ran=False), [])   # the evaluation did not run: nothing to see
        self.assertEqual(links([e], {"k": {"status": "not_ready"}}, {"k": "r"}), [])
        self.assertTrue(links([e], {"k": {"status": "not_ready"}}, {"k": "mean sd t"}))
        self.assertEqual(links([e], {"k": {"status": "computed", "metric": "correlation"}}), [])
        found = links([e], {"k": {"status": "computed", "metric": "mean_difference", "test": {"statistic": "t"}}})
        self.assertTrue(any("holds mean_difference, t test" in m for m in found), found)

    def test_units(self):
        r = {"estimates": [{"metric": "mean", "value": 22}], "cells": {"a": {"n": 40, "percent": 22}}}
        e = effect(reported=r, compute={"op": "package", "key": "k"})
        found = links([e], {"k": {"status": "computed", "metric": "mean", "unit": "cents"}})
        self.assertTrue(any("computed value is in money" in m for m in found), found)
        self.assertEqual(links([e], {"k": {"status": "computed", "metric": "mean", "unit": "share of endowment"}}), [])
        e["outcome"] = {"type": "continuous", "scale": "percent of the endowment"}
        found = links([e], {"k": {"status": "not_ready"}}, {"k": {"kinds": "mean", "unit": "proportion"}})
        self.assertTrue(any("reported is a percent" in m for m in found), found)

    def test_one_value_per_effect(self):
        r = {"estimates": [{"metric": "correlation", "value": 0.4}, {"metric": "correlation", "value": 0.2}]}
        e = effect(reported=r, compute={"op": "correlation", "field": "x", "withField": "y"})
        self.assertTrue(any("reported holds 2 correlation values" in m for m in links([e])))
        r["estimates"][0]["variant"], r["estimates"][1]["variant"] = "Pearson (p. 4)", "Spearman (p. 5)"
        self.assertEqual(links([e]), [])

    def test_a_smaller_n_in_one_effect_states_the_exclusion(self):
        def cells(n):
            return {"a": {"n": 188, "mean": 1.0, "sd": 1.0}, "b": {"n": n, "mean": 0.5, "sd": 1.0}}
        effs = [effect("e%d" % i, {"cells": cells(n)}) for i, n in enumerate([188, 188, 188, 125])]
        found = links(effs)
        self.assertTrue(any("effect e3: arm b has n = 125 where the study's other effects have 188" in m
                            for m in found), found)
        effs[3]["compute"]["exclusion"] = "framing A had no 50/50 option in phase 2 (p. 7), left out here"
        self.assertEqual(links(effs), [])
        # compute.exclusion is a documented schema property; effects_core.py (a cross-repo copy) takes it as is
        schema = json.loads((REPO / "pack/schema/effects.schema.json").read_text(encoding="utf-8"))
        prop = schema["properties"]["effects"]["items"]["properties"]["compute"]["properties"]["exclusion"]
        self.assertEqual(prop["type"], "string")
        self.assertIn("evaluate()", prop["description"])
        # unequal arms of a between design are not an exclusion
        self.assertEqual(links([effect("e%d" % i, {"cells": cells(n)}) for i, n in enumerate([150, 120, 188])]), [])

    def test_one_malformed_effect_does_not_stop_the_n_check_of_the_others(self):
        from unittest import mock
        def cells(n):
            return {"a": {"n": 188, "mean": 1.0, "sd": 1.0}, "b": {"n": n, "mean": 0.5, "sd": 1.0}}
        effs = [effect("e%d" % i, {"cells": cells(n)}) for i, n in enumerate([188, 188, 188, 188, 125])]
        real = effects._n_by_arm
        def odd(e, by_arm):
            if e["id"] == "e0":
                raise TypeError("a malformed effect")
            return real(e, by_arm)
        with mock.patch.object(effects, "_n_by_arm", odd):
            found = links(effs)
        self.assertTrue(any("effect e4: arm b has n = 125" in m for m in found), found)

    def test_compute_keys_that_are_not_text(self):
        r = {"estimates": [{"metric": "correlation", "value": 0.4}]}
        # a list key never crashes; effects_core reports the malformed compute
        self.assertEqual(links([effect(reported=r, compute={"op": "package", "key": ["k"]})]), [])
        self.assertEqual(links([effect(reported=r, compute={"op": "package", "key": {"a": 1}})], {"k": {}}), [])
        # an int key is the child's text key: no false "not computed"
        e = effect(reported=r, compute={"op": "package", "key": 3})
        self.assertEqual(links([e], {"3": {"status": "computed", "metric": "correlation"}}), [])
        self.assertEqual(links([e], {"3": {"status": "not_ready"}}, {"3": "r"}), [])
        self.assertTrue(any("compute key '3' is not computed" in m for m in links([e], {"3": {"status": "not_ready"}})))
        # a population or compute that is not an object is read as none
        self.assertEqual(links([effect(reported=r, compute="x", population="human")]), [])
        # an effect of the wrong shape is left to effects_core; the others are still checked
        corr = {"op": "correlation", "field": "x", "withField": "y"}
        odd = [effect("odd%d" % i, reported=dict(r, **{k: v}), compute=corr, studyId=["s"]) for i, (k, v) in
               enumerate([("estimates", 5), ("estimates", "s"), ("missing", 5), ("cells", {"a": 5})])]
        bad = effect("bad", reported=r, compute={"op": "paired_difference", "field": "x", "referenceField": "y"})
        found = links(odd + [bad, effect("bad2", reported=r, compute=bad["compute"], outcome="share")])
        self.assertEqual(sorted(m.split(":")[0] for m in found), ["effect bad", "effect bad2"], found)

    def test_output_kinds_never_crashes_on_odd_source(self):
        pkg = Path(tempfile.mkdtemp(prefix="output-kinds-"))
        self.addCleanup(shutil.rmtree, pkg, True)
        (pkg / "evaluation").mkdir()
        for source in ("x = (" * 300 + ")" * 300, "OUTPUT_KINDS = {'a': 1}\x00", "OUTPUT_KINDS = {1: 'r', (1,): 'd', "
                       "None: 'x', 'k': 'mean'}\n", "OUTPUT_KINDS = {'a': " + "[" * 400 + "]" * 400 + "}\n"):
            (pkg / "evaluation/evaluation.py").write_text(source)
            kinds = effects.output_kinds(pkg)
            self.assertIsInstance(kinds, dict)
        self.assertEqual(effects.output_kinds(pkg), {})
        (pkg / "evaluation/evaluation.py").write_text("OUTPUT_KINDS = {1: 'r', (1,): 'd', None: 'x', 'k': 'mean'}\n")
        self.assertEqual(effects.output_kinds(pkg), {"1": "r", "k": "mean"})
        (pkg / "evaluation/evaluation.py").write_bytes(b"\xff\xfe not utf-8")
        self.assertEqual(effects.output_kinds(pkg), {})

    def test_output_kinds_is_read_without_running_the_module(self):
        pkg = Path(tempfile.mkdtemp(prefix="output-kinds-"))
        self.addCleanup(shutil.rmtree, pkg, True)
        (pkg / "evaluation").mkdir()
        (pkg / "evaluation/evaluation.py").write_text(
            "raise SystemExit('never imported')\nOUTPUT_KINDS = {'k': 'r', 'm': {'kinds': 'mean sd', 'unit': 'share'}}\n")
        self.assertEqual(effects.output_kinds(pkg), {"k": "r", "m": {"kinds": "mean sd", "unit": "share"}})
        metrics, tests, cells, units = effects._declared({"kinds": "mean sd t", "unit": "share"})
        self.assertEqual((metrics, tests, cells, units), ({"mean"}, {"t"}, {"mean", "sd"}, {"share"}))


class LinksEndToEnd(unittest.TestCase):
    def test_effects_py_reads_the_package_block_from_the_stand_in_run(self):
        from test_effects import QUOTE, effects_doc
        root = make_project()
        self.addCleanup(shutil.rmtree, root, True)
        prog = json.loads((root / "program.json").read_text(encoding="utf-8"))
        prog["evidence"].append({"id": "e-result", "sourceId": "paper", "locator": {"page": 2}, "quote": QUOTE})
        (root / "program.json").write_text(json.dumps(prog), encoding="utf-8")
        doc = effects_doc()
        doc["effects"][0]["compute"] = {"op": "package", "key": "harm_help"}
        (root / "effects.json").write_text(json.dumps(doc), encoding="utf-8")
        evaluation = root / "package/knobe/evaluation/evaluation.py"
        base = evaluation.read_text(encoding="utf-8")
        block = ("\ndef effect_estimates(evaluation):\n    return {'harm_help': {'status': 'computed', 'metric': "
                 "'%s', 'value': 0.1, 'cells': {'condition-harm': {'n': 2, %s}}}}\n")
        evaluation.write_text(base + block % ("mean_difference", "'mean': 0.5, 'sd': 0.1"), encoding="utf-8")
        check = REPO / "pack/skills/build/effects.py"
        run = subprocess.run([sys.executable, str(check), str(root)], capture_output=True, text=True, encoding="utf-8")
        # built without the shared reply reader: the link rule is a warning (contract.py), the check passes
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("WARN    effect", run.stdout)
        self.assertIn("reported holds a chi_square test", run.stdout)
        (root / "package/knobe/task/replies.py").write_text("# the shared reply reader\n", encoding="utf-8")
        run = subprocess.run([sys.executable, str(check), str(root)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(run.returncode, 1, run.stdout)
        self.assertIn("problem: effect", run.stdout)
        self.assertIn("reported holds a chi_square test", run.stdout)
        evaluation.write_text(base + block % ("risk_difference", "'k': 1, 'proportion': 0.5"), encoding="utf-8")
        run = subprocess.run([sys.executable, str(check), str(root)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)


if __name__ == "__main__":
    unittest.main()
