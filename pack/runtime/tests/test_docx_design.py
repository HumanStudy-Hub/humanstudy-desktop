"""Word copies (docx_text.py) and the design disclosures (design_checks.py): licence doubts are not researcher
questions, a blocked condition says what is missing, the layout is recorded and a derived one is a departure.
   python -m unittest discover -s pack/runtime/tests"""
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
sys.path.insert(0, str(BUILD))
import design_checks  # noqa: E402
import docx_text  # noqa: E402

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
BR = "<w:r><w:br/></w:r>"
QUALTRICS_PAGE_BREAK = ('<w:tbl><w:tr><w:tc><w:p><w:pPr><w:rPr><w:color w:val="cccccc"/></w:rPr></w:pPr>'
                        '<w:r><w:t>Page Break</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl>')


def docx(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("word/document.xml", "<w:document %s><w:body>%s</w:body></w:document>" % (W, body))
    return path


def p(*runs, ppr=""):
    return "<w:p>%s" % ppr + "".join(runs) + "</w:p>"


def r(text):
    return '<w:r><w:t xml:space="preserve">%s</w:t></w:r>' % text


def tmp(test):
    root = Path(tempfile.mkdtemp(prefix="docx-design-"))
    test.addCleanup(shutil.rmtree, root, True)
    return root


def project(test, materials=None, program=None, task=None, record=None, replies=False, docx_body=None):
    root = tmp(test)
    pkg = root / "package" / "paper"
    for d in ("task", "materials"):
        (pkg / d).mkdir(parents=True)
    (pkg / "materials/materials.json").write_text(json.dumps(materials or {}))
    (pkg / "task/task.json").write_text(json.dumps(task or {"conditions": [{"id": "control"}]}))
    (pkg / "task/adapter.py").write_text("from replies import ask\n" if replies else "def run_sessions(*a): return []\n")
    (root / "program.json").write_text(json.dumps(program or {"id": "p", "nodes": [], "issues": []}))
    (root / "sources").mkdir()
    (root / "sources/SOURCE.json").write_text(json.dumps(record or {}))
    if docx_body is not None:
        docx(root / "sources/open/survey.docx", docx_body)
    return root, pkg


class WordReader(unittest.TestCase):
    def test_keeps_breaks_and_ends_pages_at_page_break_markers(self):
        body = (p(r("Start of Block: Scenario 1")) + p(r("sc1 Scenario 1"), BR, BR, r("In this study we ask."))
                + p(r("1) Improving automobile safety"), BR, r("2) Improving highways"))
                + p(r("Which car was available?"), ppr='<w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>')
                + QUALTRICS_PAGE_BREAK + p(r("Q &amp; A"), '<w:r><w:br w:type="page"/></w:r>', r("Last page"))
                + p(r("Thanks"), ppr="<w:pPr><w:pageBreakBefore/></w:pPr>"))
        record = docx_text.read(docx(tmp(self) / "s.docx", body))
        self.assertEqual(record["pages"], [["sc1 Scenario 1", "In this study we ask.", "1) Improving automobile safety",
                                            "2) Improving highways", "Which car was available?"], ["Q & A"],
                                           ["Last page"], ["Thanks"]])
        self.assertEqual(record["export_lines"], ["Start of Block: Scenario 1"])

    def test_blocks_and_text_boxes(self):
        box = ('<w:p><w:r><mc:AlternateContent><mc:Choice><w:txbxContent>' + p(r("Boxed")) +
               '</w:txbxContent></mc:Choice><mc:Fallback><w:txbxContent>' + p(r("Boxed")) +
               '</w:txbxContent></mc:Fallback></mc:AlternateContent></w:r></w:p>')
        body = (p(r("Consent text")) + p(r("End of Block: Consent")) + p(r("Start of Block: Intro"))
                + p(r("Take a page break now.")) + box)
        record = docx_text.read(docx(tmp(self) / "b.docx", body))
        self.assertEqual(record["pages"], [["Consent text"], ["Take a page break now.", "Boxed"]])

    def test_cli_prints_pages_and_writes_json(self):
        root = tmp(self)
        path = docx(root / "s.docx", p(r("One")) + QUALTRICS_PAGE_BREAK + p(r("Two")))
        run = subprocess.run([sys.executable, "-B", str(BUILD / "docx_text.py"), str(path), "--json",
                              str(root / "out/s.json")], capture_output=True, text=True)
        self.assertEqual((run.returncode, run.stdout), (0, "One\n--- page break ---\nTwo\n"), run.stderr)
        self.assertEqual(json.loads((root / "out/s.json").read_text())["pages"], [["One"], ["Two"]])


class WordReaderLimits(unittest.TestCase):
    """A broken or hostile .docx never crashes the check or takes long to read."""

    def broken(self, path, method=None, flags=None):
        data = bytearray(path.read_bytes())
        central = data.find(b"PK\x01\x02")
        if method is not None:      # the compression method of the local and the central header
            data[8:10] = data[central + 10:central + 12] = method.to_bytes(2, "little")
        if flags is not None:       # bit 0: the entry is encrypted
            data[6:8] = data[central + 8:central + 10] = flags.to_bytes(2, "little")
        path.write_bytes(bytes(data))

    def test_unreadable_word_file_is_one_finding(self):
        for kind in ("compression", "encrypted", "not a zip"):
            root, pkg = project(self, docx_body=p(r("x")))
            path = root / "sources/open/survey.docx"
            if kind == "compression":
                self.broken(path, method=99)
            elif kind == "encrypted":
                self.broken(path, flags=1)
            else:
                path.write_bytes(b"<html>a login page</html>")
            found = docx_text.problems(root, pkg)
            self.assertEqual(len(found), 1, (kind, found))
            self.assertIn("cannot be read", found[0][0])
            self.assertIn("sources/open/survey.docx", found[0][0])

    def test_malformed_program_and_materials_are_read_as_no_text(self):
        for program in ({"nodes": 5}, {"nodes": [{"fields": 5}]}, {"nodes": [5, {"id": "a", "fields": [5, {
                "origin": "verbatim", "value": {"x": ["Page Break"]}}]}]}):
            root, pkg = project(self, program=program, docx_body=p(r("x")))
            (pkg / "materials/materials.json").write_text("[1, null, {\"text\": 5}]")
            found = docx_text.problems(root, pkg)
            self.assertTrue(all("cannot be read" not in m for m, _ in found), found)

    def test_oversized_document_is_refused(self):
        root, pkg = project(self, docx_body=p(r("x")))
        from unittest import mock
        with mock.patch.object(docx_text, "MAX_DOCUMENT_BYTES", 10):
            with self.assertRaises(ValueError):
                docx_text.read(root / "sources/open/survey.docx")
            found = docx_text.problems(root, pkg)
        self.assertTrue(any("cannot be read" in m and "MB" in m for m, _ in found), found)

    def test_unclosed_tags_read_in_linear_time(self):
        import time
        path = tmp(self) / "x.docx"
        for xml in ("<w:pPr>x" * 20000, "<w:pPr x" * 20000, "<w:t x" * 20000, "<mc:Fallback>x" * 20000,
                    "<w:p " * 20000, "<w:br " * 20000):
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("word/document.xml", xml)
            start = time.monotonic()
            docx_text.read(path)
            self.assertLess(time.monotonic() - start, 2.0, xml[:12])

    def test_properties_with_a_revision_inside_still_end_at_their_own_close(self):
        change = "<w:pPr><w:pageBreakBefore/><w:pPrChange><w:pPr><w:jc/></w:pPr></w:pPrChange></w:pPr>"
        body = p(r("One")) + p(r("Two"), ppr=change) + p(r("Three"))
        self.assertEqual(docx_text.read(docx(tmp(self) / "c.docx", body))["pages"], [["One"], ["Two", "Three"]])


class WordCheck(unittest.TestCase):
    BODY = p(r("Scenario 1"), BR, BR, r("In this study we are interested"))

    def test_without_a_word_source_nothing_is_checked(self):
        root, pkg = project(self, materials={"screens": [{"text": "Which car? Page Break"}]})
        self.assertEqual(docx_text.problems(root, pkg), [])

    def test_export_markup_in_materials_or_a_verbatim_field_fails(self):
        root, pkg = project(self, materials={"screens": [{"id": "s1", "text": "Which car was available? Page Break",
                                                          "note": "Page Break line dropped"}]}, docx_body=self.BODY)
        found = docx_text.problems(root, pkg)
        self.assertTrue(any("'Page Break'" in m and "materials.json" in m for m, _ in found), found)
        program = {"nodes": [{"id": "intro", "fields": [{"id": "welcome", "origin": "verbatim",
                                                          "value": "Start of Block: Intro\nWelcome"}]}]}
        root, pkg = project(self, program=program, docx_body=self.BODY)
        self.assertTrue(any("Start of Block:" in m and "intro.welcome" in m for m, _ in docx_text.problems(root, pkg)))
        # A field the build wrote is not checked as participant text; a note is never participant text.
        program["nodes"][0]["fields"][0]["origin"] = "implementation"
        root, pkg = project(self, program=program, docx_body=self.BODY,
                            materials={"screens": [{"text": "Take a page break now.", "note": "Page Break dropped"}]})
        self.assertEqual(docx_text.problems(root, pkg), [])

    def test_lines_run_together_fail(self):
        root, pkg = project(self, materials={"screens": [{"text": "Scenario 1In this study we are interested"}]},
                            docx_body=self.BODY)
        found = docx_text.problems(root, pkg)
        self.assertTrue(any("runs two lines" in m and "Scenario 1In this" in m for m, _ in found), found)
        root, pkg = project(self, materials={"screens": [{"text": "Scenario 1\n\nIn this study we are interested"}]},
                            docx_body=self.BODY)
        self.assertEqual(docx_text.problems(root, pkg), [])
        run = subprocess.run([sys.executable, "-B", str(BUILD / "docx_text.py"), "--check", str(root)],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("PASS", run.stdout)


REPORTED = {"layout": "one statement per screen", "origin": "reported", "evidence": "p. 4"}


def msgs(root, pkg=None):
    return [m for m, _ in design_checks.problems(root, pkg)]


class Design(unittest.TestCase):
    def test_project_without_the_inputs_passes(self):
        root, pkg = project(self)
        self.assertEqual(msgs(root, pkg), [])
        run = subprocess.run([sys.executable, "-B", str(BUILD / "design_checks.py"), str(root)],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("PASS", run.stdout)

    def test_licence_question_is_a_hub_policy_item(self):
        issues = [{"id": "consent", "title": "Can you upload the consent screen?", "severity": "decision"},
                  {"id": "si-rights", "title": "May the item lists from the journal supplement be published?",
                   "severity": "decision"}]
        root, pkg = project(self, program={"nodes": [], "issues": issues})
        found = msgs(root, pkg)
        self.assertEqual(len(found), 1, found)
        self.assertIn("issue 'si-rights' asks the researcher about a licence", found[0])
        for question, flagged in (("Should participants be licensed drivers?", False),
                                  ("Should we redistribute the endowment?", False),
                                  ("Can the donations be made public to the other players?", False),
                                  ("Should the 7-point scale run from left to right?", False),
                                  ("Should the questionnaire show the items in the order published in the appendix?",
                                   False),
                                  ("Should the item about rights of minorities use the survey wording?", False),
                                  ("Is the supplement covered by a licence?", True)):
            with self.subTest(question=question):
                self.assertIs(design_checks.is_licence_question(question), flagged)

    def test_licence_policy_entries(self):
        root, pkg = project(self, record={"licencePolicy": [
            {"path": "sources/private/si.pdf", "licence": "none stated", "evidence": "x", "use": ""}]})
        text = " ".join(msgs(root, pkg))
        for part in ("path must name a file", "'evidence'", "the use"):
            self.assertIn(part, text)
        (root / "sources/private").mkdir()
        (root / "sources/private/si.pdf").write_bytes(b"%PDF-1.4")
        (root / "sources/SOURCE.json").write_text(json.dumps({"licencePolicy": [
            {"path": "sources/private/si.pdf", "licence": "none stated",
             "evidence": "the journal's supplement page states no licence", "use": "researcher-own-use-only"}]}))
        self.assertEqual(msgs(root, pkg), [])

    def test_blocked_condition_names_what_is_missing_and_what_it_blocks(self):
        vague = {"id": "study3", "status": "blocked", "blocked_reason": "The instruction and scale are not printed."}
        root, pkg = project(self, task={"conditions": [vague]})
        self.assertTrue(any("study3" in m and "what is missing" in m for m in msgs(root, pkg)))
        root, pkg = project(self, task={"conditions": [{"id": "study3"}], "blocked_arms": [vague]})
        self.assertTrue(any("study3" in m for m in msgs(root, pkg)))
        exact = dict(vague, blocked_missing=["Study 3 rating instruction"],
                     blocked_results=["bullshit sensitivity (profound minus mundane ratings)"])
        root, pkg = project(self, task={"conditions": [exact]})
        self.assertEqual(msgs(root, pkg), [])

    def test_layout_is_recorded_and_a_derived_one_is_a_departure(self):
        root, pkg = project(self, replies=True)   # current build contract: presentation required
        self.assertTrue(any("needs 'presentation'" in m for m in msgs(root, pkg)))
        root, pkg = project(self, replies=False)   # an older package: not required
        self.assertEqual(msgs(root, pkg), [])
        derived = {"layout": "one statement per screen", "origin": "derived"}
        root, pkg = project(self, task={"conditions": [], "presentation": derived})
        self.assertTrue(any("records the departure" in m for m in msgs(root, pkg)))
        issue = {"id": "presentation-layout", "title": "Layout not stated: one statement per screen chosen",
                 "severity": "decision", "reason": "no source says", "impact": "small", "suggestedAction": "confirm",
                 "evidenceIds": []}
        root, pkg = project(self, task={"conditions": [], "presentation": derived},
                            program={"nodes": [], "issues": [issue]})
        self.assertEqual(msgs(root, pkg), [])
        root, pkg = project(self, task={"conditions": [], "presentation": dict(REPORTED, evidence="")})
        self.assertTrue(any("gives no evidence" in m for m in msgs(root, pkg)))
        root, pkg = project(self, task={"conditions": [], "presentation": REPORTED}, replies=True)
        self.assertEqual(msgs(root, pkg), [])


if __name__ == "__main__":
    unittest.main()
