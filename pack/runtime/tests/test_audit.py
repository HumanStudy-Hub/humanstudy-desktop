"""audit.py: the audit book's automatic checks on a study folder, written to audit.json.
   python -m unittest discover -s pack/runtime/tests"""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
BUILD = REPO / "pack/skills/build"
AUDIT = BUILD / "audit.py"
BOOK_JSON = BUILD / "audit-book.json"
BOOK_MD = REPO / "docs/audit-book.md"

MATERIAL = "Imagine that you are one of the people in the room. How sure are you that the coin landed heads?"
SOURCE_TEXT = "Participants read the following text. " + MATERIAL + " They answered on a scale from 1 to 7."

INDEPENDENT = '''import sys
def build_prompt(study, condition, previous=None):
    return "Condition text for %s. How sure are you? Answer 1-7." % ("A" if condition == "a" else "B")
def parse_reply(study, condition, reply):
    digits = [c for c in reply if c.isdigit()]
    return int(digits[0]) if digits and 1 <= int(digits[0]) <= 7 else None
def run_sessions(llm, seed, n, arms=None):
    out = []
    for arm in arms or ["a", "b"]:
        for i in range(n):
            reply = llm(build_prompt("s1", arm))
            out.append({"arm": arm, "condition": arm, "participant": i, "reply": reply,
                        "answer": parse_reply("s1", arm, reply)})
    return out
if __name__ == "__main__" and "--smoke-test" in sys.argv:
    print("ok")
'''
# One shared conversation: every participant sees the replies of the ones before (incident I-02).
SHARED = INDEPENDENT.replace('''            reply = llm(build_prompt("s1", arm))''',
                             '''            history = " ".join(s["reply"] for s in out)
            reply = llm(history + " " + build_prompt("s1", arm))''')
# Several questions per participant, a different number per arm; sessions keep only parsed answers.
TRANSCRIPT = INDEPENDENT.replace('''def run_sessions(llm, seed, n, arms=None):
    out = []
    for arm in arms or ["a", "b"]:
        for i in range(n):
            reply = llm(build_prompt("s1", arm))
            out.append({"arm": arm, "condition": arm, "participant": i, "reply": reply,
                        "answer": parse_reply("s1", arm, reply)})
    return out''', '''def run_sessions(llm, seed, n, arms=None):
    out, shared = [], []
    for arm in arms or ["a", "b"]:
        for i in range(n):
            transcript = shared if SHARED_HISTORY else []
            answers = []
            for q in range(2 if arm == "a" else 3):
                reply = llm("\\n".join(transcript) + "\\n" + build_prompt("s1", arm))
                transcript.append("Q%d: %s" % (q, reply))
                answers.append(parse_reply("s1", arm, reply))
            out.append({"arm": arm, "condition": arm, "participant": i, "answers": answers})
    return out''')
EVALUATION = "def evaluate(sessions):\n    return {'status': 'ok', 'n': len(sessions)}\n"


def program(verbatim_value=MATERIAL):
    return {
        "schemaVersion": 2, "id": "audit-test", "title": "A test study", "intent": "reconstruct",
        "source": {"title": "A test study", "authors": "A. Author", "doi": "10.1234/test", "year": 2020,
                   "filename": "paper.pdf"},
        "studies": [{"id": "s1", "title": "Study 1", "type": "empirical"}],
        "evidence": [{"id": "e1", "path": "sources/materials.txt", "locator": {"line": 1},
                      "quote": "Participants read the following text.", "verification": "verified"}],
        "nodes": [
            {"id": "overview", "kind": "overview", "title": "Overview", "evidenceIds": ["e1"],
             "fields": [{"id": "summary", "label": "Summary", "value": "Participants rate a coin toss.",
                         "origin": "reported", "state": "confirmed", "evidenceIds": ["e1"]}]},
            {"id": "m1", "kind": "material", "title": "Vignette", "studyIds": ["s1"], "evidenceIds": ["e1"],
             "fields": [{"id": "text", "label": "Text", "value": verbatim_value, "origin": "verbatim",
                         "state": "confirmed", "evidenceIds": ["e1"]}]},
        ],
        "steps": [], "relations": [], "issues": [],
    }


def make_study(adapter=INDEPENDENT, verbatim_value=MATERIAL, extra=None):
    root = Path(tempfile.mkdtemp(prefix="audit-test-")) / "study"
    (root / "sources").mkdir(parents=True)
    (root / "program.json").write_text(json.dumps(program(verbatim_value)), encoding="utf-8")
    (root / "sources/materials.txt").write_text(SOURCE_TEXT, encoding="utf-8")
    pkg = root / "package/test"
    for sub in ("task", "evaluation", "materials", "source"):
        (pkg / sub).mkdir(parents=True)
    (pkg / "task/adapter.py").write_text(adapter, encoding="utf-8")
    (pkg / "task/task.json").write_text(json.dumps({"arms": ["a", "b"], "programBindings": {
        "programId": "audit-test", "stepIds": [], "recordNodeIds": [], "analysisNodeIds": []}}), encoding="utf-8")
    (pkg / "evaluation/evaluation.py").write_text(EVALUATION, encoding="utf-8")
    (pkg / "materials/materials.json").write_text("{}", encoding="utf-8")
    (pkg / "source/paper_metadata.json").write_text(json.dumps({"title": "A test study"}), encoding="utf-8")
    (pkg / "study.json").write_text(json.dumps({"overview": "A coin-toss rating study.",
                                                "readiness": {"status": "ready", "blocking": []},
                                                "programRef": {"path": "../../program.json", "id": "audit-test"}}),
                                    encoding="utf-8")
    for rel, text in (extra or {}).items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding="utf-8")
    return root


def run_audit(root, *args):
    out = root.parent / "out"
    run = subprocess.run([sys.executable, str(AUDIT), str(root), "--out", str(out), "--workdir", str(root.parent / "work"),
                          "--no-export", *args], capture_output=True, text=True, timeout=300)
    report = json.loads((out / root.name / "audit.json").read_text(encoding="utf-8"))
    return run, {i["id"]: i for i in report["items"]}, report


class AuditBookTest(unittest.TestCase):
    def test_json_matches_the_book(self):
        book = json.loads(BOOK_JSON.read_text(encoding="utf-8"))
        self.assertEqual(book["book"], "audit-book/0.1")
        ids = [i["id"] for i in book["items"]]
        self.assertEqual(len(ids), len(set(ids)))
        if BOOK_MD.is_file():
            self.assertEqual(ids, re.findall(r"^\| ([A-Z]\d+) \|", BOOK_MD.read_text(encoding="utf-8"), re.M))
        for item in book["items"]:
            self.assertIn(item["severity"], ("S1", "S2", "S3"))
            self.assertTrue(item["methods"] and item["check"] and item["evidence"], item["id"])


class AuditTest(unittest.TestCase):
    def tearDown(self):
        for root in getattr(self, "roots", []):
            shutil.rmtree(root.parent, ignore_errors=True)

    def study(self, **kw):
        root = make_study(**kw)
        self.roots = getattr(self, "roots", []) + [root]
        return root

    def test_report_format_and_honest_na(self):
        run, items, report = run_audit(self.study())
        self.assertEqual(report["book"], "audit-book/0.1")
        book = json.loads(BOOK_JSON.read_text(encoding="utf-8"))
        self.assertEqual(sorted(items), sorted(i["id"] for i in book["items"]))
        for i in items.values():
            self.assertIn(i["result"], ("pass", "concern", "fail", "n/a"))
            if i["result"] in ("concern", "fail"):
                self.assertTrue(i["evidence"], i["id"])
        self.assertEqual(items["X3"]["result"], "n/a")
        self.assertIn("needs agent", items["X3"]["note"])
        self.assertIn("needs human", items["A4"]["note"])
        self.assertEqual(items["X1"]["result"], "pass", items["X1"])
        self.assertEqual(items["P1"]["result"], "pass", items["P1"])
        self.assertEqual(items["P5"]["result"], "pass", items["P5"])
        self.assertEqual(items["T2"]["result"], "pass", items["T2"])

    def test_invented_verbatim_text_fails_and_sets_exit_code(self):
        run, items, _ = run_audit(self.study(verbatim_value="How confident are you that the die showed six?"),
                                  "--only", "X1")
        self.assertEqual(items["X1"]["result"], "fail")
        self.assertIn("program.json#node:m1.text", items["X1"]["evidence"])
        self.assertEqual(run.returncode, 1)

    def test_table_fields_are_checked_cell_by_cell(self):
        # A text layer prints a table cell by cell, in an order that is not the table's: joined into one
        # string, a correctly transcribed table was "not found". Each cell must still be on the page.
        page = (SOURCE_TEXT + " Table 2 Mean confidence by condition Condition Mean rating Heads framing 4.2 "
                "Tails framing 3.1 Note. Ratings on a scale from 1 to 7.")
        table = {"table": "table-2", "title": "Table 2 Mean confidence by condition",
                 "columns": ["Condition", "Mean rating"],
                 "rows": [["Heads framing", "4.2"], ["Tails framing", "3.1"]],
                 "notes": ["Note. Ratings on a scale from 1 to 7."]}
        _, items, _ = run_audit(self.study(verbatim_value=table, extra={"sources/materials.txt": page}), "--only", "X1")
        self.assertEqual(items["X1"]["result"], "pass", items["X1"])
        self.assertIn("1 table(s) found cell by cell", items["X1"]["note"])
        reworded = json.loads(json.dumps(table))
        reworded["rows"][1][0] = "Tails condition"  # a reworded cell
        _, items, _ = run_audit(self.study(verbatim_value=reworded, extra={"sources/materials.txt": page}), "--only", "X1")
        self.assertNotEqual(items["X1"]["result"], "pass", items["X1"])
        self.assertIn("program.json#node:m1.text", items["X1"]["evidence"])
        self.assertEqual(items["X1"]["result"], "concern", items["X1"])
        invented = json.loads(json.dumps(table))
        invented["rows"].append(["Edge framing", "5.0"])  # a row the paper does not have
        _, items, _ = run_audit(self.study(verbatim_value=invented, extra={"sources/materials.txt": page}), "--only", "X1")
        self.assertEqual(items["X1"]["result"], "concern", items["X1"])
        # Text cells all match, so only the number and row checks can see these.
        for change in (lambda t: t["rows"][1].__setitem__(1, "3.7"),            # a wrong number
                       lambda t: t["rows"].append(["Tails framing", "4.9"]),     # an invented row of page words
                       lambda t: t["columns"].__setitem__(1, "M")):              # a header the page does not print
            altered = json.loads(json.dumps(table))
            change(altered)
            _, items, _ = run_audit(self.study(verbatim_value=altered, extra={"sources/materials.txt": page}), "--only", "X1")
            self.assertEqual(items["X1"]["result"], "concern", (altered, items["X1"]))
            self.assertIn("program.json#node:m1.text: table", items["X1"]["evidence"])

    def test_shared_context_between_participants_fails(self):
        run, items, _ = run_audit(self.study(adapter=SHARED), "--only", "P1")
        self.assertEqual(items["P1"]["result"], "fail", items["P1"])
        self.assertEqual(run.returncode, 1)

    def test_multi_question_participants_are_attributed(self):
        _, items, _ = run_audit(self.study(adapter="SHARED_HISTORY = False\n" + TRANSCRIPT), "--only", "P1")
        self.assertEqual(items["P1"]["result"], "pass", items["P1"])
        self.assertIn("reply-free first prompt", items["P1"]["note"])
        _, items, _ = run_audit(self.study(adapter="SHARED_HISTORY = True\n" + TRANSCRIPT), "--only", "P1")
        self.assertNotEqual(items["P1"]["result"], "pass", items["P1"])

    def test_unparseable_replies_are_counted(self):
        _, items, _ = run_audit(self.study(), "--only", "P6")
        self.assertEqual(items["P6"]["result"], "pass", items["P6"])
        defaulting = INDEPENDENT.replace("else None", "else 4")
        _, items, _ = run_audit(self.study(adapter=defaulting), "--only", "P6")
        self.assertEqual(items["P6"]["result"], "concern", items["P6"])

    def test_local_paths_and_data_files_are_found(self):
        root = self.study(extra={"package/test/notes.md": "data from /Users/someone/Desktop/x\n",
                                 "package/test/human/raw.csv": "id,answer\n1,4\n"})
        _, items, _ = run_audit(root, "--only", "T2,A6")
        self.assertEqual(items["T2"]["result"], "fail")
        self.assertIn("package/test/notes.md:1", items["T2"]["evidence"])
        self.assertEqual(items["A6"]["result"], "fail")


if __name__ == "__main__":
    unittest.main()
