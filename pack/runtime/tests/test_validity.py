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
    current = False   # True: the package carries the shared reply reader (built under the current contract)

    def project(self, fields=(), adapter_text=None, issues=(), pages=PAGES):
        root = Path(tempfile.mkdtemp(prefix="check-validity-"))
        self.addCleanup(shutil.rmtree, root, True)
        p = json.loads(PROGRAM.read_text(encoding="utf-8"))
        task = next(n for n in p["nodes"] if n["id"] == "task")
        task["fields"] += [copy.deepcopy(f) for f in fields]
        p["issues"] += [copy.deepcopy(i) for i in issues]
        p["evidence"] += [{"id": "e-hist", "path": "paper.pdf", "locator": {"page": 2},
                           "quote": "A table of all their previous choices stayed on the screen."},
                          {"id": "e-form", "path": "paper.pdf", "locator": {"page": 2},
                           "quote": "All twelve items were displayed on one page."},
                          {"id": "e-excl", "path": "paper.pdf", "locator": {"page": 2},
                           "quote": "Participants with any missing response were excluded from the analysis."},
                          {"id": "e-cross", "path": "paper.pdf", "locator": {"page": 2},
                           "quote": "A fixation cross was displayed on the screen and removed after 500 ms."},
                          {"id": "e-rec", "path": "paper.pdf", "locator": {"page": 2},
                           "quote": "Responses were recorded with a keypress. Past research has shown that learning is slow."},
                          {"id": "e-last", "path": "paper.pdf", "locator": {"page": 2},
                           "quote": "After each choice, the outcome of the previous trial was displayed for 1 s."},
                          {"id": "e-a-screen", "path": "paper.pdf", "locator": {"page": 2},
                           "quote": "Stimuli were presented on a screen at 60 cm; each trial was shown on one screen."}]
        (root / "program.json").write_text(json.dumps(p), encoding="utf-8")
        (root / "paper.pdf").write_bytes(b"%PDF-1.4 stub")
        pkg = root / "package/x"
        (pkg / "task").mkdir(parents=True)
        (pkg / "task/adapter.py").write_text(adapter_text or adapter(), encoding="utf-8")
        if self.current:
            shutil.copy2(BUILD / "package_files/replies.py", pkg / "task/replies.py")
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
        mem = [self.memory("full-log", evidence=["e-hist"])]
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
        self.assertTrue(any("not-told[1]: no term is a content word of the printed statement" in m for m in found), found)
        self.assertTrue(any("not-told[2]: needs `withheld`" in m for m in found), found)
        # a frame word of the statement ("told") grounds nothing; a term must be a word of what was withheld
        gamed = dict(ENTRY, terms=["told", "participants"])
        unrelated = dict(ENTRY, terms=["blue key"], withheld="the payout schedule")
        long_term = dict(ENTRY, terms=["they had to learn that the red key"])
        found = self.problems(self.project([self.not_told([gamed, unrelated, long_term])]))
        self.assertTrue(any("not-told[0]: no term is a content word" in m for m in found), found)
        self.assertTrue(any("not-told[1]: no term shares a word with `withheld`" in m for m in found), found)
        self.assertTrue(any("not-told[2]: terms are short phrases" in m for m in found), found)
        # notApplicable on a sentence about the participants needs a check issue the researcher sees
        dodge = dict(ENTRY, terms=[], withheld="", notApplicable="describes the computational model")
        found = self.problems(self.project([self.not_told([dodge])]))
        self.assertTrue(any("marked not applicable, but the statement is about the participants" in m for m in found), found)
        # "researchers" or "et al" elsewhere in the sentence does not make it about someone else
        for text in ("Participants were not told the researchers' hypothesis that the red key paid more often.",
                     "Following Smith et al. (2019), participants were not told that the red key paid more often."):
            entry = dict(dodge, statement=text)
            found = self.problems(self.project([self.not_told([entry])], pages=[PAGES[0], text]))
            self.assertTrue(any("marked not applicable, but" in m for m in found), (text, found))
        blind = "The experimenters were not told which condition each participant was in."
        found = self.problems(self.project([self.not_told([dict(dodge, statement=blind)])], pages=[PAGES[0], blind]))
        self.assertFalse(any("marked not applicable, but" in m for m in found), found)
        na = dict(ENTRY, terms=[], withheld="", notApplicable="about the experimenters")
        confirm = {"id": "i-na", "title": "Not applicable", "severity": "check", "reason": "r", "impact": "i",
                   "suggestedAction": "s", "evidenceIds": [], "nodeId": "task", "fieldId": "not-told"}
        report = check_validity.check(self.project([self.not_told([na])], issues=[confirm]))
        self.assertFalse(any("not-told" in m for m, _ in report["problems"]), report["problems"])
        self.assertTrue(any("not applicable: about the experimenters" in n for n in report["notes"]), report["notes"])

    def test_memory_design_is_a_recorded_decision_that_matches_the_prompts(self):
        nt = self.not_told([ENTRY])
        found = self.problems(self.project([nt]))
        self.assertTrue(any("records no `replay-memory` decision" in m for m in found), found)
        found = self.problems(self.project([nt, self.memory("full-log")], issues=[self.MEMORY_ISSUE]))
        self.assertTrue(any("(design 'full-log') is not what participants saw" in m for m in found), found)
        # any evidence id does not do: the quote must say participants saw their earlier trials
        found = self.problems(self.project([nt, self.memory("full-log", evidence=["e-form"])], issues=[self.MEMORY_ISSUE]))
        self.assertTrue(any("(design 'full-log') is not what participants saw" in m for m in found), found)
        # "other" over prompts that carry every trial is a full log too
        found = self.problems(self.project([nt, self.memory("other")], issues=[self.MEMORY_ISSUE]))
        self.assertTrue(any("(design 'other') is not what participants saw" in m for m in found), found)
        self.assertEqual(self.problems(self.project([nt, self.memory("full-log", evidence=["e-hist"])],
                                                    issues=[self.MEMORY_ISSUE])), [])
        # a questionnaire whose items share a page: same-screen, with a quote that says so
        self.assertEqual(self.problems(self.project([nt, self.memory("same-screen", evidence=["e-form"])],
                                                    issues=[self.MEMORY_ISSUE])), [])
        found = self.problems(self.project([nt, self.memory("same-screen")], issues=[self.MEMORY_ISSUE]))
        self.assertTrue(any("same-screen" in m and "needs evidence" in m for m in found), found)
        # a methods sentence that merely mentions a screen, or "recorded"/"past", is not that evidence
        found = self.problems(self.project([nt, self.memory("same-screen", evidence=["e-cross"])], issues=[self.MEMORY_ISSUE]))
        self.assertTrue(any("same-screen" in m and "needs evidence" in m for m in found), found)
        for ev in ("e-rec", "e-last"):   # last-trial feedback does not justify a full log
            found = self.problems(self.project([nt, self.memory("full-log", evidence=[ev])], issues=[self.MEMORY_ISSUE]))
            self.assertTrue(any("(design 'full-log') is not what participants saw" in m for m in found), (ev, found))
        found = self.problems(self.project([nt, self.memory("same-screen", evidence=["e-a-screen"])],
                                           issues=[self.MEMORY_ISSUE]))
        self.assertTrue(any("same-screen" in m and "needs evidence" in m for m in found), found)
        found = self.problems(self.project([nt, self.memory("last-trial")], issues=[self.MEMORY_ISSUE]))
        self.assertTrue(any("design is 'last-trial' but the prompts carry every earlier trial" in m for m in found), found)
        found = self.problems(self.project([nt, self.memory("full-log")]))
        self.assertTrue(any("needs its decision issue" in m for m in found), found)
        self.assertEqual(self.problems(self.project([nt, self.memory("full-log", origin="researcher")],
                                                    issues=[self.MEMORY_ISSUE])), [])

    def test_unparsed_rule_reads_parse_status_only_and_accepts_the_papers_rule(self):
        mem = [self.not_told([ENTRY]), self.memory("full-log", evidence=["e-hist"])]
        ok = adapter(valid='"complete": all(len(k) > 0 for k in ("a", "b"))  # valid = all( in a comment')
        self.assertEqual(self.problems(self.project(mem, ok, issues=[self.MEMORY_ISSUE])), [])
        dodge = adapter(valid='"ok": not any(t["key"] is None for t in trials)')
        code = Path(tempfile.mkdtemp(prefix="check-validity-")) / "evaluation.py"
        self.addCleanup(shutil.rmtree, code.parent, True)
        code.write_text("rows = [{'risky': None}]\nassert all(r['risky'] is not None for r in rows)\n"
                        "abort = all(not r['valid'] for r in rows)\nmeans = all(x is not None for x in (1, 2))\n"
                        "s = {'valid': all(r['risky'] is not None for r in rows)}\n", encoding="utf-8")
        self.assertEqual([n for n, _ in check_validity.drops_participant(code)], [5])   # not asserts or all(not ...)
        found = self.problems(self.project(mem, dodge, issues=[self.MEMORY_ISSUE]))
        self.assertTrue(any("one unparsed reply drops the whole participant" in m for m in found), found)
        cited = adapter(valid='\n            # exclusion: e-excl\n            "valid": all(t["parsed"] for t in trials)')
        self.assertEqual(self.problems(self.project(mem, cited, issues=[self.MEMORY_ISSUE])), [])
        wrong = adapter(valid='\n            # exclusion: e-cross\n            "valid": all(t["parsed"] for t in trials)')
        found = self.problems(self.project(mem, wrong, issues=[self.MEMORY_ISSUE]))
        self.assertTrue(any("one unparsed reply drops the whole participant" in m for m in found), found)

    def test_a_hanging_adapter_fails_and_sleeps_are_skipped(self):
        mem = [self.not_told([ENTRY]), self.memory("full-log", evidence=["e-hist"])]
        slow = adapter(blocked="import time; time.sleep(3600)")
        self.assertEqual(self.problems(self.project(mem, slow, issues=[self.MEMORY_ISSUE])), [])
        hang = adapter(blocked="while True: pass")
        root = self.project(mem, hang, issues=[self.MEMORY_ISSUE])
        original = check_validity.prompts_of
        check_validity.prompts_of = lambda pkg: original(pkg, timeout=5)
        self.addCleanup(setattr, check_validity, "prompts_of", original)
        found = self.problems(root)
        self.assertTrue(any("did not finish" in m for m in found), found)

    def test_every_named_arm_is_run(self):
        text = adapter().replace("    pass\n    out = []", "    if arms and arms[0] == 'hint':\n"
                                 "        llm('Hint: the red key pays more often.')\n    out = []")
        mem = [self.not_told([ENTRY]), self.memory("full-log", evidence=["e-hist"])]
        root = self.project(mem, text, issues=[self.MEMORY_ISSUE])
        self.assertEqual(self.problems(root), [])
        (root / "package/x/study.json").write_text(json.dumps({"runnableArms": ["c", "hint"]}), encoding="utf-8")
        found = self.problems(root)
        self.assertTrue(any("tells participants what they were not told (red key)" in m for m in found), found)
        # an arm only the adapter declares, or task.json conditions keyed by name
        (root / "package/x/study.json").unlink()
        adapter_file = root / "package/x/task/adapter.py"
        adapter_file.write_text("ARMS = ['c', 'hint']\n" + text, encoding="utf-8")
        self.assertTrue(any("(red key)" in m for m in self.problems(root)))
        adapter_file.write_text(text, encoding="utf-8")
        (root / "package/x/task/task.json").write_text(json.dumps({"conditions": {"c": {}, "hint": {}}}), encoding="utf-8")
        self.assertTrue(any("(red key)" in m for m in self.problems(root)))

    def test_static_reading_skips_the_papers_quotes_and_wrapped_verbatim_lines_are_exempt(self):
        pkg = self.project([self.not_told([ENTRY])]) / "package/x"
        (pkg / "materials").mkdir()
        (pkg / "materials/materials.json").write_text(json.dumps(
            {"items": [{"text": "Press a key.", "quote": "the red key pays more often", "source": "p. 2"}]}),
            encoding="utf-8")
        self.assertFalse(any("red key" in t for t in check_validity.static_texts(pkg)))
        pieces = check_validity.participant_text({"nodes": [{"id": "m", "kind": "material", "fields": [
            {"id": "instructions", "origin": "verbatim", "value": "At the end we will tell you whether the red key "
                                                                 "pays more often than the blue one."}]}]})
        self.assertEqual(check_validity.authored("whether the red key pays", pieces), "")

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
        field = {"id": "briefing", "label": "Briefing", "origin": "unknown", "state": "missing",
                 "evidenceIds": [], "value": None}
        issue = {"id": "i-instr", "title": "Instructions not printed", "severity": "check", "reason": "r",
                 "impact": "i", "suggestedAction": "s", "evidenceIds": [], "nodeId": "task", "fieldId": "briefing"}
        found = self.problems(self.project([self.not_told([ENTRY]), field], issues=[issue]))
        self.assertTrue(any("missing participant instructions has severity 'check'" in m for m in found), found)
        self.assertFalse(any("no `decision` issue" in m for m in found), found)   # one problem per field
        found = self.problems(self.project([self.not_told([ENTRY]), field]))
        self.assertTrue(any("missing participant instructions have no `decision` issue" in m for m in found), found)
        found = self.problems(self.project([self.not_told([ENTRY]), field], issues=[dict(issue, severity="decision")]))
        self.assertFalse(any("missing participant instructions" in m for m in found), found)
        # an issue on the node without a fieldId counts too
        node_level = dict(issue, fieldId=None)
        found = self.problems(self.project([self.not_told([ENTRY]), field], issues=[node_level]))
        self.assertTrue(any("severity 'check'" in m for m in found), found)
        # blocking only when the adapter refuses to run without the text
        blocking = [dict(issue, severity="blocking")]
        found = self.problems(self.project([self.not_told([ENTRY]), field], issues=blocking))
        self.assertTrue(any("severity 'blocking'" in m for m in found), found)
        refuses = adapter(blocked='raise RuntimeError("the briefing is not printed")')
        found = self.problems(self.project([self.not_told([ENTRY]), field], refuses, issues=blocking))
        self.assertFalse(any("missing participant instructions" in m for m in found), found)


TRIALS_ADAPTER = '''
ARMS = %(arms)r


def run_sessions(llm, seed, n, arms=None):
    out = []
    for arm in (arms or ARMS):
        %(pre)s
        for i in range(n):
            history = []
            for t in range(1, 13):
                prompt = %(prompt)s
                key = llm(prompt).strip().upper()
                history.append("Trial %%d: you pressed %%s" %% (t, key))
            out.append({"arm": arm, "condition": arm})
    return out
'''
SCREEN = '"Choose a key on each trial; each choice may win points.\\nTrial %d. Press RED or BLUE." % t'


def trials(prompt=SCREEN, arms=("left_first", "right_first"), pre="pass"):
    return TRIALS_ADAPTER % {"arms": list(arms), "prompt": prompt, "pre": pre}


class PromptMemoryAndIds(Validity):
    """Bench's hard rules on the captured prompts: no claimed screens that are not sent, a design that carries
    memory carries something, no internal ids, and every condition runs on its own. They block a package built
    under the current contract (task/replies.py); PromptRulesOlderBuild covers the warnings of an older one."""
    current = True

    def found(self, design, text, evidence=(), issues=(), **kw):
        fields = [self.not_told([ENTRY]), self.memory(design, evidence=evidence)]
        return self.problems(self.project(fields, text, issues=[self.MEMORY_ISSUE] + list(issues), **kw))

    def test_a_claim_of_earlier_screens_needs_them_in_the_prompt(self):
        claim = '"Your earlier answers are shown above.\\n" + ' + SCREEN
        found = self.found("none", trials(claim))
        self.assertTrue(any("prompts say earlier screens or answers are shown" in m for m in found), found)
        with_log = '("Your earlier answers are shown above.\\n" + "\\n".join(history) + "\\n" if history else "") + ' + SCREEN
        found = self.found("full-log", trials(with_log), evidence=["e-hist"])
        self.assertFalse(any("earlier screens or answers are shown" in m for m in found), found)
        # the current screen's own wording is not a claim
        self.assertEqual(self.found("none", trials('"Answer the question above.\\n" + ' + SCREEN)), [])

    def test_a_design_that_carries_memory_must_carry_something(self):
        found = self.found("last-trial", trials())
        self.assertTrue(any("design last-trial carries memory, but no later prompt" in m for m in found), found)
        # design none (with its decision issue) stays allowed
        self.assertEqual(self.found("none", trials()), [])
        last = '("Last trial: you pressed " + history[-1].split()[-1] + "\\n" if history else "") + ' + SCREEN
        self.assertEqual(self.found("last-trial", trials(last)), [])
        total = '("Points so far: %d\\n" % (5 * len(history)) if history else "") + ' + SCREEN
        self.assertEqual(self.found("summary", trials(total)), [])

    def test_internal_identifiers_are_not_shown(self):
        found = self.found("none", trials('"Condition: " + arm + "\\n" + ' + SCREEN))
        self.assertTrue(any("internal identifiers" in m and "'left_first'" in m for m in found), found)
        found = self.found("none", trials('"QID14\\n" + ' + SCREEN))
        self.assertTrue(any("'QID14'" in m for m in found), found)
        # a screen id from materials.json, unless the materials print it as text the participant reads
        root = self.project([self.not_told([ENTRY]), self.memory("none")], trials('"[intro-screen-2]\\n" + ' + SCREEN),
                            issues=[self.MEMORY_ISSUE])
        (root / "package/x/materials").mkdir()
        mats = root / "package/x/materials/materials.json"
        mats.write_text(json.dumps({"screens": [{"id": "intro-screen-2", "text": "Press RED or BLUE."}]}), encoding="utf-8")
        self.assertTrue(any("'intro-screen-2'" in m for m in self.problems(root)))
        mats.write_text(json.dumps({"screens": [{"id": "intro-screen-2", "text": "See [intro-screen-2] below."}]}),
                        encoding="utf-8")
        self.assertFalse(any("internal identifiers" in m for m in self.problems(root)))

    def test_every_condition_runs_alone_or_refuses_under_a_blocking_issue(self):
        crash = trials(pre='if arms and arm == "right_first": {}["missing"]')
        found = self.found("none", crash)
        self.assertTrue(any("run_sessions(arms=['right_first'], n=2) raised KeyError" in m and "a crash" in m
                            for m in found), found)
        refuse = trials(pre='if arms and arm == "right_first": raise RuntimeError("needs sources/researcher/x.txt")')
        found = self.found("none", refuse)
        self.assertTrue(any("raised RuntimeError" in m for m in found), found)
        blocking = {"id": "i-x", "title": "Needs the original x", "severity": "blocking", "reason": "r", "impact": "i",
                    "suggestedAction": "s", "evidenceIds": [], "nodeId": "task", "fieldId": "replay-memory"}
        self.assertFalse(any("run_sessions(" in m for m in self.found("none", refuse, issues=[blocking])))
        # a pair design that needs an even n is run with n=2
        pairs = trials(pre='if n % 2: raise ValueError("pairs need an even n")')
        self.assertFalse(any("run_sessions(arms=" in m for m in self.found("none", pairs)))


class PromptRulesOlderBuild(Validity):
    """A package built before the shared reply reader: the newer prompt rules are warnings, and it still passes."""

    def report(self, design, text, evidence=(), issues=()):
        fields = [self.not_told([ENTRY]), self.memory(design, evidence=evidence)]
        return check_validity.check(self.project(fields, text, issues=[self.MEMORY_ISSUE] + list(issues)))

    def assertWarnsOnly(self, report, phrase):
        self.assertFalse(report["currentContract"])
        self.assertEqual(report["problems"], [])
        self.assertTrue(any(phrase in m for m, _ in report["warnings"]), report["warnings"])
        self.assertTrue(all(fix for _, fix in report["warnings"]))

    def test_claim_of_earlier_screens_warns(self):
        claim = '"Your earlier answers are shown above.\\n" + ' + SCREEN
        self.assertWarnsOnly(self.report("none", trials(claim)), "prompts say earlier screens or answers are shown")

    def test_carrying_design_with_nothing_carried_warns(self):
        self.assertWarnsOnly(self.report("last-trial", trials()), "design last-trial carries memory, but no later prompt")

    def test_internal_identifiers_warn(self):
        report = self.report("none", trials('"Condition: " + arm + "\\n" + ' + SCREEN))
        self.assertWarnsOnly(report, "internal identifiers")

    def test_crashing_arm_warns(self):
        crash = trials(pre='if arms and arm == "right_first": {}["missing"]')
        self.assertWarnsOnly(self.report("none", crash), "raised KeyError")
        refuse = trials(pre='if arms and arm == "right_first": raise RuntimeError("needs sources/researcher/x.txt")')
        self.assertWarnsOnly(self.report("none", refuse), "raised RuntimeError")

    def test_cli_prints_warn_and_pass(self):
        fields = [self.not_told([ENTRY]), self.memory("none")]
        root = self.project(fields, trials('"QID14\\n" + ' + SCREEN), issues=[self.MEMORY_ISSUE])
        import contextlib
        import io
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = check_validity.main([str(root)])
        self.assertEqual(code, 0, out.getvalue())
        self.assertIn("WARN    participant prompts contain internal identifiers", out.getvalue())
        self.assertIn("PASS package validity", out.getvalue())
        self.assertNotIn("PROBLEM", out.getvalue())


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

    def test_a_printed_zero_does_not_sign_a_tiny_negative_value(self):
        self.assertFalse(effects._printed_signed(-1e-11, ["b = 0"]))
        self.assertFalse(effects._printed_signed(-1.9e-11, ["p = -5.3e-11"]))
        self.assertTrue(effects._printed_signed(-1.9e-11, ["b = −1.9e−11"]))
        self.assertTrue(effects._printed_signed(-0.322, ["d = -0.322"]))

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
        # printed N for the whole sample, a subgroup effect: missing says why, so no N is forced on it
        self.assertEqual(self.rules(self.effect(n=None, missing=["N of the LAC subgroup is not printed"])), [])
        # an N the quotes do not print or account for is not this effect's N; `missing` does not excuse it
        found = self.rules(self.effect(n=81))
        self.assertTrue(any("reported.n = 81, but its quotes print N = 40" in m for m in found), found)
        found = self.rules(self.effect(n=81, missing=["SDs n/a"]))
        self.assertTrue(any("reported.n = 81" in m for m in found), found)
        # an N the quotes account for: a per-group N times the arms, total minus printed exclusions, df + 1
        self.assertTrue(any("reported.n = 80" in m for m in self.rules(self.effect(n=80))))   # no "per group"
        self.program["evidence"][-1]["quote"] = "Forty participants (N = 40) per group took part."
        self.assertEqual(self.rules(self.effect(n=80)), [])
        self.program["evidence"][-1]["quote"] = "Of the 48 participants, 8 were excluded."
        self.assertEqual(self.rules(self.effect(n=40)), [])
        self.program["evidence"][-1]["quote"] = "N = 48 participants completed 8 blocks each."
        self.assertTrue(any("reported.n = 38" in m for m in self.rules(self.effect(n=38))))
        self.assertEqual(self.rules(self.effect(n=None, missing=["SDs n/a"]))[:1],
                         [m for m in self.rules(self.effect(n=None)) if "print N" in m][:1])

    def test_a_ci_must_contain_its_value(self):
        found = self.rules(self.effect(estimates=[{"metric": "standardized_mean_difference", "value": -0.322,
                                                   "ci": [0.01, 0.63]}]))
        self.assertTrue(any("does not contain the value" in m for m in found), found)
        self.assertEqual(self.rules(self.effect(estimates=[{"metric": "standardized_mean_difference",
                                                            "value": -0.322, "ci": [-0.63, -0.01]}])), [])


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
        got = self.statuses(values, [[self.PAGE], [self.PAGE]])
        self.assertEqual(got, {"split": "layout_split", "split-like-one-reader": "layout_split",
                               "wide": "layout_split", "good": "found"})
        # one reader each way is a tie, not evidence; two spaces after a full stop are not column padding
        got = self.statuses({"split-like-one-reader": "press the l ateral key"}, [[self.PAGE]])
        self.assertEqual(got, {"split-like-one-reader": "found"})
        self.assertEqual(check_verbatim.wide_spaces("the final amount.  That number"), [])

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

    def test_another_tables_rows_on_the_same_page_do_not_count(self):
        layout = "Table 2\nResults\n" + self.GRID + "\nTable A1\nParameter correlations (image)\n"
        found = self.problems(layout, caption="Table 2\nResults\nTable A1\nParameter correlations")
        self.assertFalse(any("marked missing" in m for m in found), found)
        layout = "Table 2\nResults\nTable A1\nParameter correlations\n" + self.GRID
        found = self.problems(layout, caption="Table 2\nResults\nTable A1\nParameter correlations")
        self.assertTrue(any("Table A1 is marked missing" in m for m in found), found)

    def test_captions_below_their_tables(self):
        layout = self.GRID + "\nTable 2\nResults\nTable A1\nParameter correlations (image)\n"
        found = self.problems(layout, caption="Table 2\nResults\nTable A1\nParameter correlations")
        self.assertFalse(any("marked missing" in m for m in found), found)
        layout = self.GRID + "\nTable 2\nResults\n" + self.GRID + "\nTable A1\nCorrelations"
        found = self.problems(layout, caption="Table 2\nResults\nTable A1\nCorrelations")
        self.assertTrue(any("Table A1 is marked missing" in m for m in found), found)

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
            ("Copies can be used for personal research under the following conditions.", None),
            ("Our preregistration, materials and scripts are on OSF and licensed under CC BY 4.0.", None),
            ("The responses are distributed under a CC0 license.", None),
            ("This is an open access article under the CC BY-NC-ND license "
             "(http://creativecommons.org/licenses/by-nc-nd/4.0/).", "CC-BY-NC-ND-4.0")]
        for text, want in cases:
            self.fake_pdf(check_quotes, ["front page", text])
            got = sources.printed_license(Path("paper.pdf"))
            self.assertEqual(got[0] if got else None, want, text)
            if got:
                self.assertTrue(got[1].startswith("p. 2: "), got)
        self.fake_pdf(check_quotes, ["front page", "Our preregistration is open access under CC BY 4.0."])
        got = sources.printed_license(Path("paper.pdf"))
        self.assertTrue(got is None or "Our" in got[1], got)   # the sentence keeps its first character

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
