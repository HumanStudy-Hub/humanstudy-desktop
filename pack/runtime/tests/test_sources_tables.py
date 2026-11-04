"""Tables without a text layer and lost minus signs (paper_tables.py, check_results.py), and how the build used
its downloaded files: analysis code, survey versions, questions to the researcher (check_source_use.py).
   python -m unittest discover -s pack/runtime/tests"""
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
import check_source_use as su  # noqa: E402
import paper_tables as pt  # noqa: E402

try:
    import pdfplumber  # noqa: F401
    import pypdf  # noqa: F401
    HAVE_PDF = True
except ImportError:
    HAVE_PDF = False


def make_pdf(pages):
    """A minimal valid PDF; each page is a list of (x, y, text) lines in Helvetica 10 pt, written in that order
    (so a two-column page lists the left column first, as typeset papers do)."""
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", None]
    kids = []
    for lines in pages:
        esc = lambda t: t.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = " ".join("BT /F1 10 Tf %d %d Td (%s) Tj ET" % (x, y, esc(t)) for x, y, t in lines)
        kids.append(len(objs) + 1)
        objs.append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R /Resources << /Font << "
                    "/F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>" % (len(objs) + 2))
        objs.append("<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
    objs[1] = "<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join("%d 0 R" % k for k in kids), len(kids))
    out, offs = b"%PDF-1.4\n", []
    for i, o in enumerate(objs):
        offs.append(len(out))
        out += ("%d 0 obj\n%s\nendobj\n" % (i + 1, o)).encode("latin-1")
    xref = len(out)
    out += ("xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)).encode()
    out += b"".join(("%010d 00000 n \n" % o).encode() for o in offs)
    out += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)).encode()
    return out


# Page 1: a two-column results page. Tables 1 and 2 are only mentioned (drawn as images: no caption, no rows in
# the text layer); "Table 12S" is a supplementary table; the right column breaks "95% CI [-0.16, 0.54]" after the
# minus. Page 2: a table with a real text layer.
PAGE_RESULTS = [(72, 700, "In Table 1 and 2, we summarized the results"),
                (72, 688, "of the first phase. See Table 12S for more."),
                (330, 700, "h = 0.19, 95% CI [-"),
                (330, 688, "0.16, 0.54]. The other three differences")]
PAGE_TABLE = [(72, 700, "Table 5. Means and standard deviations for each condition."),
              (90, 680, "Evaluation"), (200, 680, "1.81"), (250, 680, "0.84"), (300, 680, "1.76"), (350, 680, "0.79"),
              (90, 668, "Responsibility"), (200, 668, "5.88"), (250, 668, "1.02"), (300, 668, "6.13"), (350, 668, "0.97"),
              (90, 656, "Norms"), (200, 656, "4.03"), (250, 656, "0.68"), (300, 656, "4.06"), (350, 656, "0.62")]
PAGE_PROSE = [(72, 700, "Discussion. The participants in both phases chose as the original study predicted.")]


def tmpdir(test, prefix):
    root = Path(tempfile.mkdtemp(prefix=prefix))
    test.addCleanup(shutil.rmtree, root, True)
    return root


@unittest.skipUnless(HAVE_PDF, "pdfplumber and pypdf (in the HumanStudy runtime) are needed")
class PaperTables(unittest.TestCase):
    def pdf(self, pages):
        path = tmpdir(self, "paper-tables-") / "paper.pdf"
        path.write_bytes(make_pdf(pages))
        return path

    def test_inventory_finds_mentioned_tables_without_text_and_skips_supplement(self):
        tables = {t["table"]: t for t in pt.table_inventory(self.pdf([PAGE_RESULTS, PAGE_TABLE]))}
        self.assertEqual(set(tables), {"1", "2", "5"})
        self.assertTrue(tables["1"]["needs_page_image"])
        self.assertEqual(tables["1"]["mentioned_on"], [1])
        self.assertIsNone(tables["1"]["caption_page"])
        self.assertTrue(tables["5"]["text_layer"])
        self.assertFalse(tables["5"]["needs_page_image"])
        self.assertEqual(tables["5"]["caption_page"], 2)

    def test_sign_loss_finds_the_line_end_minus_only(self):
        spots = pt.sign_loss(self.pdf([PAGE_RESULTS, PAGE_TABLE]))
        self.assertEqual([(s["page"], s["printed"]) for s in spots], [(1, "-0.16")])

    def test_render_writes_the_pages_of_image_tables(self):
        try:
            import pypdfium2  # noqa: F401
        except ImportError:
            self.skipTest("pypdfium2 not installed")
        pdf = self.pdf([PAGE_RESULTS, PAGE_TABLE])
        out = pdf.parent / "pages"
        run = subprocess.run([sys.executable, str(BUILD / "paper_tables.py"), str(pdf), "--render", str(out)],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        report = json.loads(run.stdout)
        self.assertEqual([Path(p).name for p in report["rendered"]], ["page-01.png", "page-02.png"])
        self.assertEqual((out / "page-01.png").read_bytes()[:8], b"\x89PNG\r\n\x1a\n")


class PaperTablesText(unittest.TestCase):
    """The text rules, on page texts given directly."""

    def texts(self, layout_pages, plain_pages=None):
        original = pt.page_texts
        pt.page_texts = lambda pdf, layout: layout_pages if layout else (plain_pages or layout_pages)
        self.addCleanup(setattr, pt, "page_texts", original)

    def test_split_true_minus_is_found_but_not_a_subtraction(self):
        self.texts(["the effect was b = − 0.011, and n − 1 degrees of freedom"])
        self.assertEqual([s["printed"] for s in pt.sign_loss("x.pdf")], ["-0.011"])

    def test_two_column_sign_loss_only_flags_the_continued_number(self):
        layout = ("left column text here and more words      h = 0.19, 95% CI [-\n"
                  "more left column words go on here          0.16, 0.54]. Another result\n\n"
                  "still the left column of the page          had h = 0.33, 95% CI [0.30, 0.94].\n")
        plain = ("left column text here and more words more left column words go on here still the left column of "
                 "the page\nh = 0.19, 95% CI [-\n0.16, 0.54]. Another result had h = 0.33, 95% CI [0.30, 0.94].\n")
        self.texts([layout], [plain])
        self.assertEqual([s["printed"] for s in pt.sign_loss("x.pdf")], ["-0.16"])

    def test_caption_sentence_is_not_a_caption(self):
        self.assertIsNone(pt.CAPTION_RE.search("   Table 3 presents the means and standard deviations"))
        self.assertTrue(pt.CAPTION_RE.search("Table 3. Means and standard deviations"))

    def test_supplementary_tables_and_caption_styles(self):
        page = ("We report it in Supplementary Table 3 and in Extended Data Table 4, and Table 8 in S1 Appendix.\n"
                "The results are in Table 1 of the main text.\n"
                " Table 1. Mean ratings by condition\n"
                "   Self    4.68   7.07\n   Other   5.10   6.80\n   Total   5.33   7.04\n"
                "Table 2 | Design of the study\n")
        self.texts([page, "Table 5 – Means and standard deviations\n"])
        tables = {t["table"]: t for t in pt.table_inventory("x.pdf")}
        self.assertEqual(set(tables), {"1", "2", "5"})
        self.assertTrue(tables["1"]["text_layer"])
        self.assertFalse(tables["2"]["needs_page_image"])   # a design table
        self.assertTrue(tables["5"]["needs_page_image"])    # results caption, no rows

    def test_mentioned_table_without_result_words_is_not_demanded(self):
        self.texts(["The stimuli are listed in Table 2.\n"])
        self.assertEqual([t["needs_page_image"] for t in pt.table_inventory("x.pdf")], [False])


def program_with(fields, evidence=()):
    p = json.loads(PROGRAM.read_text(encoding="utf-8"))
    p["evidence"] += list(evidence)
    node = next(n for n in p["nodes"] if n["id"] == "result-1")
    node["fields"] = [f for f in node["fields"] if f["id"] == "result_kind"] + list(fields)
    return p


def field(fid, value, **extra):
    return dict({"id": fid, "label": fid, "origin": "reported", "state": "confirmed", "evidenceIds": ["ev-res"],
                 "value": value}, **extra)


EV = {"id": "ev-res", "path": "paper.pdf", "locator": {"page": 1}, "quote": "h = 0.19"}
TABLE_1 = {"id": "table-1", "label": "Table 1", "origin": "verbatim", "state": "confirmed", "evidenceIds": ["ev-res"],
           "value": {"table": "Table 1", "page": 1, "columns": ["Framing", "A", "B"], "rows": [["Gain", "18", "62"]]}}
TABLE_2 = {"id": "table-2", "label": "Table 2", "origin": "verbatim", "state": "missing", "evidenceIds": ["ev-res"],
           "value": {"table": "Table 2", "page": 1, "columns": [], "rows": []}}


@unittest.skipUnless(HAVE_PDF, "pdfplumber and pypdf (in the HumanStudy runtime) are needed")
class ResultsImageTablesAndSigns(unittest.TestCase):
    def run_check(self, fields, evidence=(EV,), record=None, pages=(PAGE_RESULTS, PAGE_PROSE)):
        root = tmpdir(self, "check-results-image-")
        (root / "paper.pdf").write_bytes(make_pdf(list(pages)))
        (root / "program.json").write_text(json.dumps(program_with(fields, evidence)), encoding="utf-8")
        if record is not None:
            (root / "sources").mkdir()
            (root / "sources/SOURCE.json").write_text(json.dumps(record), encoding="utf-8")
        return [m for m, _ in check_results.check(root / "program.json")["problems"]]

    def test_image_tables_need_a_table_field_or_a_paper_tables_entry(self):
        signed = field("h-ci", [-0.16, 0.54])
        found = self.run_check([signed])
        self.assertEqual(len([m for m in found if "has no rows in the PDF's text layer" in m]), 2, found)
        self.assertTrue(any(m.startswith("Table 1 (mentioned on p. 1)") for m in found), found)
        # Table 1 transcribed from the rendered page, Table 2 unreadable (missing, with its issue elsewhere)
        self.assertEqual(self.run_check([signed, TABLE_1, TABLE_2]), [])
        record = {"paperTables": [{"table": "2", "page": 1, "kind": "other", "what": "the design of the framings"}]}
        self.assertEqual(self.run_check([signed, TABLE_1], record=record), [])
        record["paperTables"][0]["what"] = ""
        self.assertTrue(any("paperTables Table 2" in m for m in self.run_check([signed, TABLE_1], record=record)))

    def test_number_recorded_without_its_minus_fails_until_signed_or_checked(self):
        unsigned = [field("h", 0.19), field("h-ci", [0.16, 0.54]), TABLE_1, TABLE_2]
        found = self.run_check(unsigned)
        self.assertTrue(any("prints -0.16 on p. 1" in m and "without its sign" in m for m in found), found)
        self.assertEqual(self.run_check([field("h", 0.19), field("h-ci", "[−0.16, 0.54]"), TABLE_1, TABLE_2]), [])
        checked = dict(EV, note="rendered page checked")
        self.assertEqual(self.run_check(unsigned, evidence=(checked,)), [])
        record = {"signChecks": [{"page": 1, "value": 0.16, "note": "rendered page checked"}]}
        self.assertEqual(self.run_check(unsigned, record=record), [])
        record = {"signChecks": [{"page": 1, "value": 0.54, "note": "rendered page checked"}]}
        self.assertTrue(self.run_check(unsigned, record=record), "a check of another number does not clear it")

    def test_project_without_image_tables_or_signs_is_unchanged(self):
        self.assertEqual(self.run_check([field("m", 4.5)], pages=(PAGE_PROSE, PAGE_PROSE)), [])


class ResultsImpossibleValues(unittest.TestCase):
    def found(self, fields):
        root = tmpdir(self, "check-results-impossible-")
        (root / "program.json").write_text(json.dumps(program_with(fields, [EV])), encoding="utf-8")
        return [m for m, _ in check_results.check(root / "program.json")["problems"]]

    def test_impossible_values_fail(self):
        found = self.found([field("a", {"d": 0.64, "ci95": [0.71, 1.08]}),
                            field("b", {"cohens_f": 0.08, "cohens_f_ci90": [0.15, 0.02]}),
                            field("c", {"t": 2.1, "p": 1.3}),
                            field("h", 0.5), field("h_ci", [0.1, 0.3]),
                            field("ok", {"mean_diff": 0.75, "cohens_d": 0.64, "ci95": [0.21, 1.08]})])
        problem = next(m for m in found if "impossible values" in m)
        for expected in ["d = 0.64 lies outside", "lower limit is above", "not a probability",
                         "h = 0.5 lies outside its CI"]:
            self.assertIn(expected, problem)
        self.assertNotIn("result-1.ok", problem)

    def test_ratio_next_to_log_ci_and_mean_next_to_difference_ci_pass(self):
        self.assertEqual(self.found([field("a", {"or": 2.47, "ci": [0.31, 1.49]}),
                                     field("b", {"value": 4.5, "ci": [0.1, 0.9]}),
                                     field("c", {"city": [5, 2]})]), [])


RMD = """---
title: analysis
---

Load the data.

```{r}
# Remove the first row as it contains useless information
df <- df[-1, ]
```

```{r}
# There were coding errors in Status quo B. These errors were corrected using the following chunk.
df$B <- recode(df$B, `3` = 4, `4` = 3)
prop.test(x = c(10, 20), n = c(50, 50), correct = FALSE)
```

## 6. Data Analysis (After Exclusion)
"""


class SourceUse(unittest.TestCase):
    def project(self, files=None, record=None, issues=None, nodes=None, evidence=None):
        root = tmpdir(self, "source-use-")
        for rel, text in (files or {}).items():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_text(text, encoding="utf-8")
        (root / "sources").mkdir(exist_ok=True)
        (root / "sources/SOURCE.json").write_text(json.dumps(record or {}), encoding="utf-8")
        program = {"source": {"filename": "paper.pdf"}, "nodes": nodes or [], "evidence": evidence or [],
                   "issues": issues or []}
        (root / "program.json").write_text(json.dumps(program), encoding="utf-8")
        return root

    def write_record(self, root, record):
        (root / "sources/SOURCE.json").write_text(json.dumps(record), encoding="utf-8")

    def msgs(self, root):
        return [m for m, _ in su.problems(root)]

    # 1. analysis code
    def test_signal_lines_find_recodes_and_skip_headings(self):
        root = self.project({"sources/open/a.Rmd": RMD})
        lines = dict(su.signal_lines(root / "sources/open/a.Rmd"))
        self.assertTrue(any("coding errors" in t for t in lines.values()))
        self.assertTrue(any("recode(" in t for t in lines.values()))
        self.assertFalse(any("Data Analysis" in t for t in lines.values()))
        self.assertFalse(any("correct = FALSE" in t for t in lines.values()))

    def test_downloaded_code_must_be_recorded_and_cover_every_recode(self):
        root = self.project({"sources/open/a.Rmd": RMD})
        self.assertTrue(any("nothing is recorded from sources/open/a.Rmd" in m for m in self.msgs(root)))
        recode = {"source": "sources/open/a.Rmd", "lines": "13-14", "quote": "df$B <- recode(df$B, `3` = 4, `4` = 3)",
                  "what": "framing B options 3 and 4 are recoded", "use": "carried over",
                  "where": "evaluation/evaluation.py RECODE"}
        self.write_record(root, {"analysisCode": [recode]})
        found = self.msgs(root)
        self.assertEqual(len(found), 1, found)
        self.assertIn("line 8", found[0])
        drop = {"source": "sources/open/a.Rmd", "lines": 8, "quote": "# Remove the first row",
                "what": "drops the export's second header row", "use": "not applicable",
                "reason": "the replay has no export header rows"}
        self.write_record(root, {"analysisCode": [recode, drop]})
        self.assertEqual(self.msgs(root), [])
        self.write_record(root, {"analysisCode": [dict(recode, lines="1-3"), drop]})
        self.assertTrue(any("does not occur at lines 1-3" in m for m in self.msgs(root)))

    def test_private_code_gives_lines_without_a_quote(self):
        root = self.project({"sources/private/a.R": "# exclude participants who failed the attention check\nx <- 1\n"})
        entry = {"source": "sources/private/a.R", "lines": 1, "quote": "# exclude participants",
                 "what": "excludes failed attention checks", "use": "carried over", "where": "evaluation exclusion step"}
        self.write_record(root, {"analysisCode": [entry]})
        self.assertTrue(any("without a quote" in m for m in self.msgs(root)))
        del entry["quote"]
        self.write_record(root, {"analysisCode": [entry]})
        self.assertEqual(self.msgs(root), [])

    def test_listed_but_not_downloaded_code_fails(self):
        searches = [{"where": "OSF", "query": "Data and code folder, Analysis subfolder", "url": "https://osf.io/x/",
                     "date": "2026-11-01", "result": "analysis scripts listed; not downloaded (not needed)"}]
        root = self.project(record={"searches": searches})
        self.assertTrue(any("no analysis file is under sources/" in m for m in self.msgs(root)))
        self.write_record(root, {"searches": searches, "analysisCode": [{"source": "not fetched", "reason": "not needed"}]})
        self.assertTrue(self.msgs(root))
        self.write_record(root, {"searches": searches, "analysisCode": [
            {"source": "not fetched", "reason": "only inside a zip with participant data"}]})
        self.assertEqual(self.msgs(root), [])

    def test_psychopy_script_is_not_analysis_code_and_stata_recodes_count(self):
        root = self.project({"sources/open/experiment.py": "from psychopy import visual\n# remove the fixation cross\n",
                             "sources/open/analysis.py": "from scipy import stats\nstats.ttest_ind(a, b, equal_var=False)\n",
                             "sources/open/a.do": 'recode part 1=0 if ParticipantNumber=="14"\n* standard errors clustered\nregress y x\n'})
        self.assertFalse(su.is_analysis_code(root / "sources/open/experiment.py"))
        self.assertTrue(su.is_analysis_code(root / "sources/open/analysis.py"))
        self.assertEqual([n for n, _ in su.signal_lines(root / "sources/open/a.do")], [1])
        self.assertIsNone(su.CODE_LISTED.search("ran paper_tables.py and sources.py; cran.r-project.org"))
        self.assertTrue(su.CODE_LISTED.search("listing shows analysis.R and data.csv"))

    # 2. survey versions
    def test_two_survey_files_need_a_comparison_and_a_no_version_supplies_no_text(self):
        files = {"sources/open/Survey_v3.qsf": "{}", "sources/open/Survey_v3.docx": "x",
                 "sources/open/prereg-design.docx": "x"}
        root = self.project(files)
        self.assertEqual(su.survey_files(su._files(root)), ["sources/open/Survey_v3.docx", "sources/open/Survey_v3.qsf"])
        self.assertTrue(any("surveyVersions does not compare" in m for m in self.msgs(root) if "survey" in m))
        versions = [{"path": "sources/open/Survey_v3.docx", "matchesPaper": "yes", "usedFor": "every screen",
                     "compared": "two scenarios in fixed order as the paper says"},
                    {"path": "sources/open/Survey_v3.qsf", "matchesPaper": "no", "usedFor": "not used",
                     "compared": "four scenarios in random order, not as the paper says"}]
        self.write_record(root, {"surveyVersions": versions})
        self.assertEqual([m for m in self.msgs(root) if "survey" in m], [])
        evidence = [{"id": "ev-qsf", "path": "sources/open/Survey_v3.qsf", "locator": {"section": "Q1"}},
                    {"id": "ev-doc", "path": "sources/open/Survey_v3.docx", "locator": {"page": 1}}]
        node = {"id": "mat-s1", "kind": "material", "studyIds": ["phase1"], "fields": [
            {"id": "text", "origin": "verbatim", "evidenceIds": ["ev-qsf"]},
            {"id": "intro", "origin": "verbatim", "evidenceIds": ["ev-doc"]}]}
        program = json.loads((root / "program.json").read_text())
        program.update(nodes=[node], evidence=evidence)
        (root / "program.json").write_text(json.dumps(program))
        self.assertTrue(any("mat-s1.text takes participant text from sources/open/Survey_v3.qsf" in m
                            for m in self.msgs(root)))

    # 3. questions
    def test_question_needs_every_download_checked_and_is_not_asked_when_answered(self):
        issues = [{"id": "version", "title": "Two or four scenarios?", "severity": "decision"},
                  {"id": "need-consent", "title": "Needs the original consent screen?", "severity": "decision"},
                  {"id": "table-3", "title": "Table 3 not printed", "severity": "decision"}]
        root = self.project({"sources/open/Survey.qsf": "{}", "sources/private/Survey.docx": "x"}, issues=issues)
        found = [m for m in self.msgs(root) if m.startswith("questions")]
        self.assertEqual(len(found), 1, found)
        self.assertIn("'version' (no record)", found[0])
        self.assertNotIn("need-consent", found[0])
        self.assertNotIn("table-3", found[0])
        checked = {"issue": "version", "sourcesChecked": [{"paths": ["sources/open/Survey.qsf"], "answers": False,
                                                           "found": "four scenarios in the export"}]}
        self.write_record(root, {"questionsChecked": [checked]})
        self.assertTrue(any("not checked: sources/private/Survey.docx" in m for m in self.msgs(root)))
        checked["sourcesChecked"].append({"path": "sources/private/Survey.docx", "answers": True,
                                          "found": "two scenarios, as the paper says"})
        self.write_record(root, {"questionsChecked": [checked]})
        self.assertTrue(any("a downloaded file answers 'version'" in m for m in self.msgs(root)))
        checked["sourcesChecked"][1]["answers"] = False
        self.write_record(root, {"questionsChecked": [checked]})
        self.assertEqual([m for m in self.msgs(root) if m.startswith("questions")], [])

    def test_decision_from_sources_must_quote_an_open_file(self):
        root = self.project({"sources/open/Survey.txt": "Participants saw two different scenarios."})
        decision = {"what": "phase 1 shows two scenarios", "path": "sources/open/Survey.txt",
                    "locator": {"page": 1}, "quote": "three different scenarios"}
        self.write_record(root, {"decisionsFromSources": [decision]})
        self.assertTrue(any("quote does not occur" in m for m in self.msgs(root)))
        decision["quote"] = "two different scenarios"
        self.write_record(root, {"decisionsFromSources": [decision]})
        self.assertEqual(self.msgs(root), [])

    def test_project_without_downloads_is_unchanged(self):
        issues = [{"id": "order", "title": "Which order did participants see?", "severity": "decision"}]
        root = self.project({"sources/researcher/s4.txt": "supplied text"}, issues=issues)
        self.assertEqual(self.msgs(root), [])
        run = subprocess.run([sys.executable, str(BUILD / "check_source_use.py"), str(root)],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("PASS", run.stdout)


if __name__ == "__main__":
    unittest.main()
