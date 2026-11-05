"""The shared reply reader (pack/skills/build/package_files/replies.py, a byte copy of HumanStudy-Bench's),
the answer-aware smoke test and the keyed-check rule (check_replies.py), and every answer reaching the session
record (recorded_answers.py). Package code runs only confined (sandbox_run.py), as in the app.
   python -m unittest discover -s pack/runtime/tests"""
import importlib.util
import json
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[3]
BUILD = REPO / "pack/skills/build"
REPLIES = BUILD / "package_files/replies.py"
sys.path.insert(0, str(BUILD))
sys.path.insert(0, str(REPO / "pack/skills/simulate"))
import check_replies  # noqa: E402
import recorded_answers  # noqa: E402
import sandbox_run  # noqa: E402
import simkit  # noqa: E402

spec = importlib.util.spec_from_file_location("replies_under_test", REPLIES)
replies = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = replies
spec.loader.exec_module(replies)
Question, ask, parse, render_options = replies.Question, replies.ask, replies.parse, replies.render_options

NICE = Question("tog", options=["Be nice", "Be fair"])

# The desktop pattern: module-level build_prompt/parse_reply (the simulate skill can call them) built on the
# same Question objects run_sessions asks with replies.ask; parse_reply delegates to replies.split_reply/parse.
ADAPTER = '''import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from replies import Question, ask, parse, render_questions, smoke_main, split_reply  # noqa: E402

ARMS = ["control", "treatment"]


def questions(study, condition, screen):
    if screen == "check":
        return [Question("check", text="What is 2 + 2?", options=["3", "4"], key="4")]
    return [Question("choice", text="Pick one.", options=["Left", "Right"]),
            Question("comment", text="Any comments?", kind="text", required=False)]


def build_prompt(study, condition, screen="decision"):
    return render_questions(questions(study, condition, screen))


def parse_reply(study, condition, reply, screen="decision"):
    qs = questions(study, condition, screen)
    pieces = {qs[0].id: reply} if len(qs) == 1 else split_reply(reply, qs)
    return {q.id: parse(pieces.get(q.id, ""), q) for q in qs}


def run_sessions(llm, seed, n, arms=None):
    sessions = []
    for arm in [a for a in ARMS if arms is None or a in arms]:
        for index in range(n):
            session = {"condition": arm, "arm": arm, "session_id": "%s-%d" % (arm, index), "status": "completed",
                       "unparsed": []}
            check = questions("s1", arm, "check")
            page = ask(llm, build_prompt("s1", arm, "check"), check)
            if not page.ok:
                session.update(status="unparsed", unparsed=page.unparsed)
            elif page.value("check") != "4":
                session.update(status="excluded", exclusion_reason="failed the check")
            else:
                page = ask(llm, build_prompt("s1", arm), questions("s1", arm, "decision"))
                session["unparsed"] = page.unparsed
                if not page.ok:
                    session["status"] = "unparsed"
                else:
                    session["choice"] = page.value("choice")
                    session["comment"] = page.value("comment")
            sessions.append(session)
    return sessions


if __name__ == "__main__" and "--smoke-test" in sys.argv:
    sys.exit(smoke_main(Path(__file__)))
'''

EVALUATION = '''def evaluate(sessions):
    by_arm = {}
    for session in sessions:
        counts = by_arm.setdefault(session["arm"], {})
        counts[session["status"]] = counts.get(session["status"], 0) + 1
    return {"status_by_arm": by_arm}
'''

# An older package: its own parser, no replies.py. Not this check's business.
LEGACY = '''import sys
def build_prompt(study, condition):
    return "Pick one.\\n1. Left\\n2. Right"
def run_sessions(llm, seed, n, arms=None):
    return [{"condition": a, "arm": a, "reply": llm(build_prompt("s", a))} for a in arms or ["control", "treatment"]
            for _ in range(n)]
if __name__ == "__main__" and "--smoke-test" in sys.argv:
    print("ok")
'''


def make_project(adapter=ADAPTER, replies_copy=True, files=None):
    """A slim project: program.json beside package/paper/ (study.json with programRef)."""
    root = Path(tempfile.mkdtemp(prefix="replies-test-")) / "study"
    pkg = root / "package" / "paper"
    for d in ("task", "evaluation", "source", "materials"):
        (pkg / d).mkdir(parents=True)
    (root / "program.json").write_text(json.dumps({"id": "fixture-program", "nodes": [], "steps": []}))
    (pkg / "study.json").write_text(json.dumps({"title": "Fixture",
                                                "programRef": {"path": "../../program.json", "id": "fixture-program"}}))
    (pkg / "source/paper_metadata.json").write_text("{}")
    (pkg / "materials/materials.json").write_text("{}")
    (pkg / "task/task.json").write_text(json.dumps({"conditions": [{"id": "control"}, {"id": "treatment"}]}))
    (pkg / "task/adapter.py").write_text(adapter)
    (pkg / "evaluation/evaluation.py").write_text(EVALUATION)
    if replies_copy:
        shutil.copyfile(REPLIES, pkg / "task/replies.py")
    for name, text in (files or {}).items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text)
    return root, pkg


class Project(unittest.TestCase):
    def project(self, **kw):
        root, pkg = make_project(**kw)
        self.addCleanup(shutil.rmtree, root.parent, ignore_errors=True)
        return root, pkg

    def load(self, path, name):
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


# --------------------------------------------------------------------------- parsing (the copied file)

class Parsing(unittest.TestCase):
    def test_readable_replies(self):
        for reply, code in [("1", "1"), ("1.", "1"), ("1)", "1"), ("(1)", "1"), ("1. Be nice", "1"), ("Be nice", "1"),
                            ("be NICE", "1"), ("**2**", "2"), ("Answer: 2", "2"), ("My answer is 2.", "2"),
                            ("I choose Be fair.", "2"), ("I pick 2 because it is fair", "2"), ("2 - Be fair", "2"),
                            ("Option 2: Be fair", "2"), ("  2\n", "2")]:
            with self.subTest(reply=reply):
                answer = parse(reply, NICE)
                self.assertEqual((answer["status"], answer.get("code")), ("ok", code), answer)

    def test_unreadable_replies_are_not_guessed(self):
        for reply, status in [("1 or 2", "ambiguous"), ("1. Be fair", "ambiguous"),
                              ("I would pick 1, maybe 2", "ambiguous"), ("", "unparsed"), ("I am not sure", "unparsed"),
                              ("3", "unparsed"), ("I would not be nice", "unparsed")]:
            with self.subTest(reply=reply):
                self.assertEqual(parse(reply, NICE)["status"], status)

    def test_negations_and_ranges_are_never_read_as_an_option(self):
        for reply in ["Not 1", "I would not choose 1", "I refuse to pick 1", "Not option 1", "1 is not what I'd pick",
                      "somewhere around 1-2"]:
            with self.subTest(reply=reply):
                self.assertEqual(parse(reply, NICE)["status"], "ambiguous")
        self.assertEqual(parse("Not 50", Question("n", kind="number", minimum=0, maximum=100))["status"], "ambiguous")
        self.assertEqual(parse("3-4", Question("s", options=[str(n) for n in range(1, 8)]))["status"], "ambiguous")
        self.assertEqual(parse("1 and not 2", Question("m", options=["Red", "Green"], multiple=True))["status"],
                         "ambiguous")
        yes_no = Question("c", options=["Yes", "No"])
        self.assertEqual((parse("No", yes_no)["code"], parse("2. No", yes_no)["code"]), ("2", "2"))

    def test_label_inside_a_longer_label_and_curly_quotes(self):
        q = Question("pd", options=["Hand over", "Don\u2019t hand over"])
        self.assertEqual(parse("Don't hand over", q)["code"], "2")
        self.assertEqual(parse("2. Don't hand over", q)["code"], "2")
        self.assertEqual(parse("1. Don't hand over", q)["status"], "ambiguous")
        self.assertEqual(parse("hand over", q)["code"], "1")

    def test_printed_scales_letters_numbers_and_sets(self):
        scale = Question("s", options=["-3 (incorrect)", "-2", "-1", "0", "1 (correct)", "2", "3 (correct, very)"])
        self.assertEqual(scale.codes, ["-3", "-2", "-1", "0", "1", "2", "3"])
        self.assertEqual(parse("1", scale)["label"], "1 (correct)")
        self.assertEqual(parse("-3", scale)["index"], 0)
        self.assertNotIn("1. -3", render_options(scale))
        self.assertEqual(parse("I give 5", Question("give", options=[str(n) for n in range(11)]))["label"], "5")
        letters = Question("l", options=["Cooperate", "Defect"], codes=["A", "B"])
        self.assertEqual([parse(r, letters).get("code") for r in ("A", "b", "B)", "option A", "Defect")],
                         ["A", "B", "B", "A", "B"])
        self.assertEqual(parse("I think a lot", letters)["status"], "unparsed")
        tick = Question("m", options=["Cinema", "Farmer", "US600"], multiple=True)
        self.assertEqual(parse("1, 3", tick)["codes"], ["1", "3"])
        self.assertEqual(parse("Cinema and US600", tick)["codes"], ["1", "3"])
        self.assertEqual(parse("1, 7", tick)["status"], "unparsed")
        number = Question("n", kind="number", minimum=0, maximum=10)
        self.assertEqual(parse("I give 5 tokens", number)["value"], 5)
        self.assertEqual(parse("11", number)["status"], "out_of_range")
        self.assertEqual(parse("3 or 4", number)["status"], "ambiguous")

    def test_default_codes_never_take_amounts_and_keep_printed_scales(self):
        quiz = ["70% for auto safety and 30% for highway safety", "60% for auto safety and 40% for highway safety",
                "30% for auto safety and 70% for highway safety"]
        cases = [(quiz, ["1", "2", "3"]), (["8%", "65%", "70%"], ["1", "2", "3"]), (["30 hours", "90 hours"], ["1", "2"]),
                 (["200 people will be saved", "600 people will die"], ["1", "2"]),
                 (["0 times", "1 time", "2 times"], ["1", "2", "3"]),
                 (["4", "3", "2", "1", "0", "1", "2", "3"], [str(n) for n in range(1, 9)]),
                 (["0\nExtremely unsatisfied", "1", "2", "3\nNeutral"], ["0", "1", "2", "3"]),
                 (["1 - Not at all", "2", "3", "4", "5 - Very much"], ["1", "2", "3", "4", "5"]),
                 (["1 Strongly disagree", "2", "3", "4 Strongly agree"], ["1", "2", "3", "4"])]
        for options, codes in cases:
            with self.subTest(options=options):
                q = Question("q", options=options)
                self.assertEqual(q.codes, codes)
                for index, code in enumerate(q.codes):
                    self.assertTrue(q.option_line(index).startswith(code))
                    self.assertEqual(parse(q.option_line(index), q)["index"], index)
        q = Question("QID80", text="How is the budget allocated?", options=quiz)
        self.assertIn("1. 70% for auto safety", replies.render_questions([q]))
        self.assertEqual(parse("70", q)["status"], "unparsed")
        explicit = Question("q", options=quiz, codes=["70", "60", "30"])
        self.assertEqual(render_options(explicit).split("\n")[0], "70. 70% for auto safety and 30% for highway safety")

    def test_duplicate_scale_labels_are_ambiguous_by_label_but_codes_work(self):
        bipolar = Question("pref", options=["4 (Rock)", "3", "2", "1", "0 (Indifferent)", "1", "2", "3", "4 (Theatre)"],
                           codes=[str(n) for n in range(1, 10)])
        self.assertEqual(parse("3", bipolar)["status"], "ambiguous")
        self.assertEqual(parse("9", bipolar)["label"], "4 (Theatre)")
        self.assertEqual(parse("5. 0 (Indifferent)", bipolar)["index"], 4)

    def test_several_questions_on_one_screen(self):
        qs = [Question("a", text="Who decided?", options=["Physician", "Patient"]),
              Question("b", text="Rating", options=["1", "2", "3"]),
              Question("c", text="Comments?", kind="text", required=False)]
        text = replies.render_questions(qs)
        self.assertIn("Q1. Who decided?", text)
        self.assertIn("Q1: <your answer>", text)
        page = ask(lambda prompt: "Q1: Patient\nQ2: 3\nQ3: none", text, qs)
        self.assertTrue(page.ok)
        self.assertEqual((page.value("a"), page.value("b"), page.value("c")), ("Patient", "3", "none"))
        page = ask(lambda prompt: '{"Q1": "1", "Q2": "2"}', text, qs)
        self.assertTrue(page.ok and page.value("a") == "Physician")
        self.assertEqual([u["question"] for u in page.unparsed], ["c"])
        self.assertIs(page.unparsed[0]["required"], False)

    def test_optional_answer_never_drops_a_participant_and_retry_keeps_read_answers(self):
        qs = [Question("rating", text="Rate", options=["1", "2", "3"]),
              Question("wrap", text="What was this study about?", options=["A", "B"], codes=["x", "y"], required=False)]
        calls = []

        def llm(prompt):
            calls.append(prompt)
            return "Q1: 2\nQ2: no idea"
        page = ask(llm, "screen", qs)
        self.assertTrue(page.ok and len(calls) == 1 and page.value("rating") == "2")
        self.assertEqual(page.unparsed, [{"question": "wrap", "required": False, "status": "unparsed",
                                          "replies": ["Q1: 2\nQ2: no idea"]}])
        answers = iter(["hmm", "Q1: 3"])
        page = ask(lambda prompt: next(answers), "screen", qs[:1] + [Question("r2", options=["1", "2"])], retries=1)
        self.assertFalse(page.ok)
        self.assertEqual(page.answers["rating"]["status"], "ok")
        seen = iter(["hmm", "2"])
        page = ask(lambda prompt: next(seen), "screen", [qs[0]])
        self.assertTrue(page.ok and page.value("rating") == "2" and len(page.replies) == 2)

    def test_key_must_be_an_option(self):
        with self.assertRaises(ValueError):
            Question("k", options=["Yes", "No"], key="Maybe").key_indices()


class Stub(unittest.TestCase):
    def test_stub_replies_with_what_the_screen_prints_not_with_codes(self):
        stub = replies.StubParticipant(seed=3, noise=0.0, use_keys=False)
        letters = Question("l", text="Which?", options=["Cooperate", "Defect"], codes=["A", "B"])
        reply = stub.answer_for("Which?\nA. Cooperate\nB. Defect\nReply with the letter of the option you choose.",
                                [letters])
        self.assertEqual(parse(reply, letters)["status"], "ok")
        self.assertFalse(stub.misreads)
        # Labels printed without the numbers that select them: the stub types the position and it is misread.
        quiz = Question("budget", options=["70% for auto", "60% for auto"], codes=["70", "60"])
        stub = replies.StubParticipant(seed=1, noise=0.0, use_keys=False)
        stub.answer_for("How?\n70% for auto\n60% for auto\nReply with the number of the option you choose.", [quiz])
        self.assertEqual([m["question"] for m in stub.misreads], ["budget"])

    def test_stub_uses_keys_only_in_the_keyed_pass(self):
        check = Question("check", text="What is 2 + 2?", options=["3", "4"], key="4")
        prompt = replies.render_questions([check])
        keyed = {replies.StubParticipant(seed=s, noise=0.0).answer_for(prompt, [check]) for s in range(10)}
        blind = {parse(replies.StubParticipant(seed=s, noise=0.0, use_keys=False).answer_for(prompt, [check]),
                       check)["label"] for s in range(30)}
        self.assertTrue(all(parse(r, check)["label"] == "4" for r in keyed))
        self.assertEqual(blind, {"3", "4"})

    def test_stub_reads_each_question_block_and_a_numeric_key_list(self):
        qs = [Question("a", text="First?", options=["Yes", "No"]), Question("b", text="Second?", options=["No", "Yes"])]
        prompt = replies.render_questions(qs)
        for seed in range(20):
            stub = replies.StubParticipant(seed=seed, noise=0.0, use_keys=False)
            self.assertTrue(ask(stub, prompt, qs).ok and not stub.misreads)
        q = Question("give", kind="number", minimum=0, maximum=10, key=[5, 6])
        self.assertEqual(parse(replies.StubParticipant(0).answer_for("x", [q]), q)["value"], 5)


class SeveralNumbersAndLabels(unittest.TestCase):
    """Round 4: the number tied to the asked verb, label-keyed multi-answers, a retry for optional answers that
    the analysis uses, and never a default."""
    C = Question("c", text="How many points do you contribute to the project?", kind="number", minimum=0, maximum=20,
                 required=False, retry=True)
    PEERS = [Question("d%d" % k, text="Points for Participant %s:" % p, kind="number", minimum=0, maximum=10,
                      required=False, retry=True) for k, p in enumerate("ABC")]

    def test_the_number_after_the_asked_verb(self):
        for reply, value in (("I keep 5 points and contribute 15.", 15), ("I keep 20 and contribute 0", 0),
                             ("Round 3: I contribute 8", 8), ("contribute: 7", 7), ("I contribute 10 points", 10),
                             ("10", 10), ("ten", 10), ("10 MU", 10)):
            self.assertEqual(parse(reply, self.C).get("value"), value, reply)
        for reply in ("I contribute 5 or 6, and contribute 7", "I don't contribute 5", "I keep 5", "between 3 and 8"):
            self.assertNotEqual(parse(reply, self.C)["status"], "ok", reply)
        self.assertEqual(parse("12.5", self.C)["status"], "unparsed")
        keep = Question("k", text="How many points do you keep?", kind="number", minimum=0, maximum=20)
        self.assertEqual(parse("I give 5 and keep 15", keep)["value"], 15)
        self.assertEqual(parse("I give 5", keep)["status"], "ambiguous")
        # a question without a verb keeps the old rule: two numbers are ambiguous
        self.assertEqual(parse("3 then 4", Question("n", text="Your number", kind="number"))["status"], "ambiguous")

    def test_a_number_left_over_or_a_lookalike_word_is_never_read(self):
        between = Question("g", text="Choose a number between 0 and 100", kind="number", minimum=0, maximum=100)
        for reply in ("My answer is 33, between 0 and 100", "33 (between 0 and 100)",
                      "I choose 33, which is between 0 and 100."):
            self.assertEqual(parse(reply, between)["status"], "ambiguous", reply)
        for text, reply in (("How many points do you assign to member 3?", "assign 2 to member 1 and 5 to member 3"),
                            ("How much do you allocate to the other participant?",
                             "I allocate 60 to myself and 40 to the other"),
                            ("How much do you split for the other?", "I split it 6 for me and 4 for them"),
                            ("How many points do you contribute?", "I'd contribute 10 in round 1 and 5 now")):
            self.assertEqual(parse(reply, Question("q", text=text, kind="number"))["status"], "ambiguous", reply)
        both = Question("b", text="How many of your 20 points do you contribute? The points you do not contribute "
                                  "you keep.", kind="number", minimum=0, maximum=20)
        self.assertEqual(parse("I keep 5", both)["status"], "ambiguous")
        self.assertEqual(parse("I keep 11 and contribute 9.", both)["value"], 9)
        for seed in range(20):   # the stub never blames the adapter for the reader's caution
            stub = replies.StubParticipant(seed=seed, noise=0.0, use_keys=False)
            self.assertTrue(ask(stub, replies.render_questions([both]), [both]).ok and not stub.misreads)

    def test_a_labelled_answer_keeps_its_commas(self):
        qs = [Question("contribute", text="How much do you contribute?", kind="number"),
              Question("influenced", text="What influenced you?", options=["Fairness", "Money", "Others"], multiple=True),
              Question("comments", text="Any comments?", kind="text", required=False)]
        self.assertEqual(replies.split_reply("contribute: 10\ninfluenced: 1, 3\ncomments: It was fine, though long", qs),
                         {"contribute": "10", "influenced": "1, 3", "comments": "It was fine, though long"})
        two = [Question("a", text="first", kind="number"), Question("b", text="second", kind="number")]
        self.assertEqual(replies.split_reply("1,000", two), {})

    def test_answers_keyed_by_the_questions_own_labels(self):
        split = replies.split_reply
        for reply in ("A: 2, B: 0, C: 3", "Participant A: 2\nParticipant B: 0\nParticipant C: 3",
                      "Points for Participant A: 2\nPoints for Participant B: 0\nPoints for Participant C: 3",
                      "2, 0, 3", '{"A": 2, "B": 0, "C": 3}', "Q1: 2\nQ2: 0\nQ3: 3"):
            self.assertEqual(split(reply, self.PEERS), {"d0": "2", "d1": "0", "d2": "3"}, reply)
        self.assertEqual(split("A: 2, A: 3, B: 1", self.PEERS), {"d1": "1"})   # A twice: not read
        self.assertEqual(split("I assign 0 points to everyone", self.PEERS), {})
        self.assertEqual(split("2, 0", self.PEERS), {})                          # not one number per question
        mixed = [Question("x", text="Pick one", options=["Yes", "No"]), Question("y", text="Your number", kind="number")]
        self.assertEqual(split("1, 5", mixed), {})                               # in order only for number questions
        verbs = [Question("give", text="How much do you give?", kind="number"),
                 Question("keep", text="How much do you keep?", kind="number")]
        self.assertEqual(split("give: 4; keep: 6", verbs), {"give": "4", "keep": "6"})

    def test_optional_answers_with_retry_are_asked_again_and_never_defaulted(self):
        answers = iter(["I am not sure", "I keep 5 and contribute 15"])
        page = ask(lambda prompt: next(answers), "screen", [self.C])
        self.assertEqual((page.value("c"), len(page.replies)), (15, 2))
        answers = iter(["hmm", "still unsure"])
        page = ask(lambda prompt: next(answers), "screen", [self.C])
        self.assertIsNone(page.value("c"))
        self.assertEqual(page.answers["c"]["status"], "unparsed")
        self.assertTrue(page.ok)                          # optional: the participant stays in
        replies_seen = iter(["A: 2, B: x", "B: 1, C: 0"])
        page = ask(lambda prompt: next(replies_seen), "screen", self.PEERS)
        self.assertEqual([page.value(q.id) for q in self.PEERS], [2, 1, 0])
        plain = Question("w", text="Comments?", options=["A", "B"], codes=["x", "y"], required=False)
        calls = []
        ask(lambda prompt: calls.append(prompt) or "no idea", "screen", [plain])
        self.assertEqual(len(calls), 1)                   # without retry=True an optional answer is asked once

    def test_the_stub_writes_verb_sentences_and_labelled_answers_that_are_read(self):
        prompt = replies.render_questions(self.PEERS)
        labelled, sentences = set(), set()
        for seed in range(30):
            stub = replies.StubParticipant(seed=seed, noise=0.0, use_keys=False)
            page = ask(stub, prompt, self.PEERS)
            self.assertTrue(all(page.answers[q.id]["status"] == "ok" for q in self.PEERS), page.replies)
            labelled.add("Q1:" not in page.replies[0])
            self.assertFalse(stub.misreads)
            stub = replies.StubParticipant(seed=seed, noise=0.0, use_keys=False)
            page = ask(stub, replies.render_questions([self.C]), [self.C])
            self.assertEqual(page.answers["c"]["status"], "ok", page.replies)
            sentences.add("contribute" in page.replies[0])
            self.assertFalse(stub.misreads)
        self.assertEqual((labelled, sentences), ({True, False}, {True, False}))   # both forms, and the plain ones


# --------------------------------------------------------------------------- check_replies.py

class ImportsReplies(unittest.TestCase):
    def test_only_a_real_import_counts(self):
        for text in ("import replies\n", "import replies as r\n", "from replies import ask\n",
                     "def f():\n    from replies import ask\n", "import os, replies\n"):
            self.assertTrue(check_replies.imports_replies(text), text)
        for text in ('"""Usage:\nimport replies\n"""\n', "X = '''\nfrom replies import ask\n'''\n",
                     "# import replies\n", "import replies_old\n", "from repliesx import a\n", ""):
            self.assertFalse(check_replies.imports_replies(text), text)
        self.assertTrue(check_replies.imports_replies("import replies\ndef broken(:\n"))   # unparsable: the pattern


class CheckReplies(Project):
    def test_passing_package_and_its_own_smoke_flag_confined(self):
        root, pkg = self.project()
        self.assertEqual(check_replies.problems(root, pkg), [])
        result = check_replies.check(root, pkg)
        self.assertEqual(set(result["report"]["arms"]), {"control", "treatment"})
        self.assertTrue(all(arm["completed"] >= 1 for arm in result["report"]["arms"].values()))
        # check_package.py runs `task/adapter.py --smoke-test` confined: replies.smoke_main(Path(__file__)) works there.
        with sandbox_run.work_dir() as work:
            copy = check_replies.copy_like_project(pkg, work)
            run = sandbox_run.run_python(copy / "task/adapter.py", ["--smoke-test"], cwd=copy, work=work, timeout=120)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIs(json.loads(run.stdout)["ok"], True)

    def test_adapter_that_calls_llm_directly_fails(self):
        bypass = ADAPTER.replace('page = ask(llm, build_prompt("s1", arm), questions("s1", arm, "decision"))',
                                 'llm(build_prompt("s1", arm))\n                page = ask(llm, build_prompt("s1", arm), '
                                 'questions("s1", arm, "decision"))')
        root, pkg = self.project(adapter=bypass)
        text = "\n".join(m for m, _ in check_replies.problems(root, pkg))
        self.assertIn("did not go through replies.ask()", text)

    def test_changed_copy_missing_import_and_missing_smoke_main(self):
        root, pkg = self.project()
        (pkg / "task/replies.py").write_bytes(REPLIES.read_bytes() + b"\n# tweaked\n")
        self.assertTrue(any("differs" in m for m, _ in check_replies.problems(root, pkg)))
        shutil.copyfile(REPLIES, pkg / "task/replies.py")
        (pkg / "task/adapter.py").write_text(LEGACY)
        self.assertTrue(any("does not import it" in m for m, _ in check_replies.problems(root, pkg)))
        (pkg / "task/adapter.py").write_text(ADAPTER.replace("sys.exit(smoke_main(Path(__file__)))", "print('ok')"))
        self.assertTrue(any("answer-aware smoke test" in m for m, _ in check_replies.problems(root, pkg)))

    def test_arm_without_a_completed_session_fails(self):
        root, pkg = self.project(adapter=ADAPTER.replace('page.value("check") != "4"', 'page.value("check") != "3"'))
        text = "\n".join(m for m, _ in check_replies.problems(root, pkg))
        self.assertIn("no session completed", text)

    def test_legacy_package_without_replies_passes_silently(self):
        root, pkg = self.project(adapter=LEGACY, replies_copy=False)
        self.assertEqual(check_replies.problems(root, pkg), [])
        self.assertEqual(recorded_answers.problems(pkg), [])
        for script, args in (("check_replies.py", [str(root)]), ("recorded_answers.py", [str(pkg)])):
            run = subprocess.run([sys.executable, "-B", str(BUILD / script)] + args, capture_output=True, text=True)
            self.assertEqual((run.returncode, run.stdout), (0, ""), run.stderr)


SURVEY_CHECKS = [{"qid": "QID9", "tag": "Q9", "text": "What is 2 + 2?", "options": ["3", "4"], "correct": ["4"],
                  "response": "optional"}]


class KeyedChecks(Project):
    def fake_qsf_flow(self):
        """A stand-in for qsf_flow.py: read_qsf loads the JSON, correct_answer_checks returns its `checks`."""
        module = types.ModuleType("qsf_flow")
        module.read_qsf = lambda path: json.loads(Path(path).read_text())
        module.correct_answer_checks = lambda report: report["checks"]
        saved = sys.modules.get("qsf_flow")
        sys.modules["qsf_flow"] = module
        self.addCleanup(lambda: sys.modules.__setitem__("qsf_flow", saved) if saved else sys.modules.pop("qsf_flow"))

    def test_unkeyed_checks_by_id_wording_and_wrong_key(self):
        checks = [dict(c, source="sources/open/s.qsf") for c in SURVEY_CHECKS]

        def asked(qid, key=None, text="What is 2 + 2?", options=("3", "4")):
            return {"id": qid, "kind": "choice", "text": text, "options": list(options), "key": key}
        self.assertTrue(check_replies.unkeyed_checks(checks, [asked("QID9")])[0][0].startswith("question QID9"))
        self.assertEqual(len(check_replies.unkeyed_checks(checks, [asked("quiz-1")])), 1)   # same wording
        self.assertIn("not an answer the survey accepts", check_replies.unkeyed_checks(checks, [asked("QID9", ["3"])])[0][0])
        self.assertEqual(check_replies.unkeyed_checks(checks, [asked("QID9", ["4"])]), [])
        self.assertEqual(check_replies.unkeyed_checks(checks, [asked("QID9", options=("3", "4", "5"))]), [])
        self.assertEqual(check_replies.unkeyed_checks(checks, [asked("other", text="Pick one.")]), [])

    def test_unkeyed_comprehension_check_in_a_package_fails(self):
        self.fake_qsf_flow()
        survey = json.dumps({"checks": SURVEY_CHECKS})
        root, pkg = self.project(files={"sources/open/survey.qsf": survey})
        self.assertEqual(check_replies.problems(root, pkg), [])   # the fixture's check carries key="4"
        unkeyed = ADAPTER.replace(', key="4")', ")").replace('page.value("check") != "4"', "False")
        (pkg / "task/adapter.py").write_text(unkeyed)
        found = check_replies.problems(root, pkg)
        self.assertEqual(len(found), 1, found)
        self.assertIn("question check is the survey's comprehension or attention check QID9", found[0][0])
        self.assertIn("sources/open/survey.qsf", found[0][0])

    def test_without_qsf_flow_the_keyed_rule_is_skipped(self):
        saved = sys.modules.get("qsf_flow")
        sys.modules["qsf_flow"] = None   # import fails as if the module were absent
        self.addCleanup(lambda: sys.modules.__setitem__("qsf_flow", saved) if saved else sys.modules.pop("qsf_flow"))
        root, _ = self.project(files={"sources/open/survey.qsf": json.dumps({"checks": SURVEY_CHECKS})})
        self.assertEqual(check_replies.survey_checks(root), [])

    @unittest.skipUnless((BUILD / "qsf_flow.py").is_file(), "qsf_flow.py is not in this tree")
    def test_real_qsf_flow_reads_a_check_that_is_not_forced(self):
        def mc(qid, text, choices, correct):
            index = str(choices.index(correct) + 1)
            validation = {"Settings": {"ForceResponse": "OFF", "ForceResponseType": "ON", "Type": "CustomValidation",
                                       "CustomValidation": {"Logic": {"0": {"0": {
                                           "LogicType": "Question", "QuestionID": qid, "Operator": "Selected",
                                           "LeftOperand": "q://%s/SelectableChoice/%s" % (qid, index),
                                           "Type": "Expression"}, "Type": "If"}, "Type": "BooleanExpression"},
                                           "Message": {"description": "Wrong answer"}}}}
            return {"QuestionID": qid, "DataExportTag": "tag-" + qid, "QuestionType": "MC", "Selector": "SAVR",
                    "QuestionText": text, "Choices": {str(i + 1): {"Display": c} for i, c in enumerate(choices)},
                    "ChoiceOrder": [str(i + 1) for i in range(len(choices))], "Validation": validation}
        q = mc("QID9", "What is 2 + 2?", ["3", "4"], "4")
        survey = {"SurveyEntry": {"SurveyID": "SV_1", "SurveyName": "Fixture"}, "SurveyElements": [
            {"Element": "SQ", "PrimaryAttribute": "QID9", "Payload": q},
            {"Element": "BL", "Payload": {"0": {"ID": "BL_1", "Type": "Standard", "Description": "Quiz",
                                                "BlockElements": [{"Type": "Question", "QuestionID": "QID9"}]}}},
            {"Element": "FL", "Payload": {"Type": "Root", "FlowID": "FL_1",
                                          "Flow": [{"Type": "Block", "ID": "BL_1", "FlowID": "FL_2"}]}}]}
        root, pkg = self.project(files={"sources/open/survey.qsf": json.dumps(survey)})
        checks = check_replies.survey_checks(root)
        self.assertEqual([(c["qid"], c["correct"]) for c in checks], [("QID9", ["4"])])
        (pkg / "task/adapter.py").write_text(
            ADAPTER.replace(', key="4")', ")").replace('page.value("check") != "4"', "False"))
        self.assertTrue(any("QID9" in m for m, _ in check_replies.problems(root, pkg)))


# --------------------------------------------------------------------------- recorded_answers.py

class RecordedAnswers(Project):
    def test_every_answer_recorded_passes_and_keyed_checks_are_skipped(self):
        _, pkg = self.project()
        report = recorded_answers.confined_report(pkg)
        self.assertEqual((report["dropped"], report["checked"]), ([], 2))
        self.assertEqual(recorded_answers.problems(pkg), [])

    def test_dropped_wrap_up_answer_fails(self):
        _, pkg = self.project(adapter=ADAPTER.replace('                    session["comment"] = page.value("comment")\n', ""))
        report = recorded_answers.confined_report(pkg)
        self.assertEqual([d["question"] for d in report["dropped"]], ["comment"])
        found = recorded_answers.problems(pkg)
        self.assertEqual(len(found), 1)
        self.assertIn("Any comments?", found[0][0])

    def test_nondeterministic_package_is_not_judged(self):
        adapter = ADAPTER.replace('session = {"condition": arm,',
                                  'import uuid\n            session = {"run": str(uuid.uuid4()), "condition": arm,')
        _, pkg = self.project(adapter=adapter.replace('                    session["comment"] = page.value("comment")\n', ""))
        report = recorded_answers.confined_report(pkg)
        self.assertEqual(report["dropped"], [])
        self.assertIn("differ", report["skipped"])
        self.assertEqual(recorded_answers.problems(pkg), [])


# --------------------------------------------------------------------------- round 3: amounts, number words, typos
# Option sets from round-3 packages (a white-lies dictator game, a profundity scale, a status-quo quiz).

AMOUNTS = ["%dc" % n for n in range(0, 21, 2)]          # "1. 0c ... 6. 10c ... 10. 18c 11. 20c"
TYPOS = ["Tranfer the 10c", "Do not trasfer the 10c"]   # printed typos, kept verbatim
PROFOUND = ["Not at all profound", "somewhat profound", "fairly profound", "definitely profound", "very profound"]
QUIZ = ["70% for auto safety and 30% for highway safety", "60% for auto safety and 40% for highway safety",
        "30% for auto safety and 70% for highway safety", "50% for auto safety and 50% for highway safety"]


def read(reply, question):
    answer = parse(reply, question)
    return answer.get("label") if answer["status"] == "ok" else answer["status"]


class Round3(unittest.TestCase):
    def table(self, rows, options):
        for reply, expected in rows:
            with self.subTest(reply=reply, options=options[:3]):
                self.assertEqual(read(reply, Question("q", options=options)), expected)

    def test_amount_list_reads_amounts_and_never_guesses(self):
        self.table([
            ("10", "ambiguous"), ("4", "ambiguous"), ("10 because it is fair", "ambiguous"), ("I give 10", "ambiguous"),
            ("ten", "unparsed"), ("0", "0c"), ("20", "20c"), ("1", "0c"), ("2", "2c"),
            ("10c", "10c"), ("10 cents", "10c"), ("$0.10", "10c"), ("I will transfer 10c", "10c"),
            ("6. 10c", "10c"), ("10. 18c", "18c"), ("4. 4c", "ambiguous"),
            ("I give 10c of my 20c", "unparsed"), ("15c", "unparsed"), ("Not 10c", "unparsed"),
            ("I keep 20c", "unparsed"), ("more than 10c", "unparsed"), ("20c for me", "ambiguous"),
            ("I give 20", "20c"), ("I'd transfer $0.10 to the other participant", "10c"), ("1,000", "unparsed"),
            ("I give 3", "unparsed"), ("I give 12", "12c"), ("Option 12", "unparsed"), ("Option 6", "10c"),
        ], AMOUNTS)
        self.table([("I give 2", "unparsed"), ("I'd transfer 2", "unparsed")], ["0c", "10c", "20c"])

    def test_amount_list_asks_for_the_number_and_the_option(self):
        q = Question("dg", options=AMOUNTS)
        self.assertTrue(q.codes == [str(n) for n in range(1, 12)] and q.amount_clash())
        rendered = replies.render_questions([q])
        self.assertIn("6. 10c", rendered)
        self.assertIn("followed by the option as printed", rendered)
        plain = Question("p", options=["8%", "65%", "70%"])
        self.assertFalse(plain.amount_clash())
        self.assertTrue(replies.render_questions([plain]).endswith("Reply with the number of the option you choose."))
        self.assertEqual((read("65", plain), read("2", plain)), ("65%", "65%"))

    def test_ambiguous_reply_is_asked_again_with_the_reason(self):
        prompts = []

        def llm(prompt):
            prompts.append(prompt)
            return "10" if len(prompts) == 1 else "6. 10c"

        q = Question("dg", options=AMOUNTS)
        page = ask(llm, replies.render_questions([q]), [q])
        self.assertTrue(page.ok and page.value("dg") == "10c" and len(prompts) == 2)
        self.assertIn("could be read as more than one option", prompts[1])

    def test_percent_and_amount_leading_labels_are_still_not_codes(self):
        q = Question("quiz", options=QUIZ)
        self.assertTrue(q.codes == ["1", "2", "3", "4"] and not q.amount_clash())
        self.assertEqual((read("4", q), read("70", q)), (QUIZ[3], "unparsed"))
        scale = Question("s", options=["1 - Not at all", "2", "3", "4", "5 - Very much"])
        self.assertEqual((scale.codes, read("3", scale)), (["1", "2", "3", "4", "5"], "3"))
        hours = Question("h", options=["30 hours", "90 hours"])
        self.assertEqual((hours.codes, read("90", hours), read("1", hours)), (["1", "2"], "90 hours", "30 hours"))
        mixed = Question("spend", options=["Nothing", "US$90", "30 hours", "US$30", "90 hours"])
        self.assertEqual((read("90", mixed), read("$90", mixed), read("90 hours", mixed)),
                         ("ambiguous", "US$90", "90 hours"))

    def test_number_words(self):
        self.table([("Three", "fairly profound"), ("three.", "fairly profound"), ("Answer: Five", "very profound"),
                    ("Three (fairly profound)", "fairly profound"), ("3", "fairly profound"),
                    ("One of those", "unparsed"), ("Three (or maybe four)", "ambiguous"),
                    ("Three, maybe four", "unparsed")], PROFOUND)
        q = Question("f", options=["None", "One", "Two or more"])
        self.assertEqual((read("One", q), read("Two", q)), ("One", "unparsed"))   # never "Two" -> option 2
        number = Question("n", kind="number", minimum=0, maximum=10)
        self.assertEqual(parse("Five", number)["value"], 5)
        self.assertEqual(parse("five or six", number)["status"], "unparsed")
        # Counts are not option numbers; a scale's labels and number words must agree.
        self.table([("Two", "unparsed"), ("One", "unparsed")], ["Never", "Once", "Twice", "Three times or more"])
        self.table([("Three", "unparsed")], ["One", "Two or more", "None"])
        self.table([("Two", "unparsed"), ("3 children", "ambiguous")],
                   ["No children", "1 child", "2 children", "3 or more children"])
        self.table([("One", "unparsed")], ["0 hours", "1-5 hours", "6-10 hours"])
        self.table([("Two", "unparsed")], ["Rarely", "Sometimes", "Often"])
        seven = ["1 (strongly disagree)", "2", "3", "4", "5", "6", "7 (strongly agree)"]
        self.table([("1 (strongly agree)", "ambiguous"), ("Two (strongly disagree)", "ambiguous"),
                    ("Seven", "7 (strongly agree)")], seven)
        self.table([("Two", "No")], ["Yes", "No"])

    def test_amount_formats(self):
        self.table([("$1", "unparsed"), ("$1,000", "$1,000")], ["$500", "$1,000", "$2,000", "$5,000"])
        self.table([("$1", "$1"), ("$1,000", "$1,000")], ["$1", "$1,000"])
        self.table([(".5%", "0.5%")], ["0.5%", "1%", "5%"])
        self.table([("−10c", "-10c")], ["-10c", "0c", "10c"])
        self.table([("1 day", "unparsed")], ["10 hours", "20 hours", "30 hours"])
        self.table([("€10", "unparsed")], ["$10", "$20"])            # another currency
        self.table([("$0.10", "10c")], ["10c", "20c"])

    def test_correct_spelling_of_a_printed_typo(self):
        self.table([("Transfer the 10c", TYPOS[0]), ("Do not transfer the 10c", TYPOS[1]),
                    ("1. Transfer the 10c", TYPOS[0]), ("2. Transfer the 10c", "ambiguous"),
                    ("Do transfer the 10c", "unparsed"), ("Transfer the 20c", "unparsed"),
                    ("Transfer", "unparsed")], TYPOS)

    def test_near_matches_never_change_meaning_or_guess(self):
        q = Question("sq", options=["Increase auto program by 20% and lower highway program by like amount",
                                    "Retain the auto program at 50%"])
        self.assertEqual(read("Decrease auto program by 20% and lower highway program by like amount", q), "unparsed")
        for reply, options in (("atypical outcome", ["typical outcome", "rare outcome"]),
                               ("likely", ["unlikely", "certain"]),
                               ("Transfer it", ["Tranfer it", "Transfr it"]),      # one letter from two labels
                               ("causal factor", ["casual factor", "no factor"]),  # swapped letters: another word
                               ("Males", ["Male", "Female"]), ("lost", ["lose", "win"])):
            with self.subTest(reply=reply):
                self.assertEqual(read(reply, Question("q", options=options)), "unparsed")

    def test_aliases_are_read_never_shown_and_never_shared(self):
        q = Question("pd", options=TYPOS, aliases={"Tranfer the 10c": ["Transfer"], 1: ["Do not transfer"]})
        self.assertEqual((read("Transfer", q), read("Do not transfer", q), read("I choose Transfer", q),
                          read("2. Transfer", q)), (TYPOS[0], TYPOS[1], TYPOS[0], "ambiguous"))
        rendered = replies.render_questions([q])
        self.assertNotIn("Transfer\n", rendered + "\n")
        self.assertNotIn("Do not transfer", rendered)
        for aliases in ({0: ["Do not trasfer the 10c"]}, {"Cooperate": ["x"]}):
            with self.assertRaises(ValueError):
                Question("pd", options=TYPOS, aliases=aliases)

    def test_stub_tries_amounts_number_words_and_aliases(self):
        stub = replies.StubParticipant(3, noise=0, use_keys=False)
        qs = [Question("dg", options=AMOUNTS), Question("rate", options=PROFOUND),
              Question("pd", options=TYPOS, aliases={0: ["Transfer"], 1: ["Do not transfer"]})]
        for q in qs:
            for _ in range(6):
                self.assertEqual(parse(stub.answer_for(replies.render_questions([q]), [q]), q)["status"], "ok")
        self.assertEqual((stub.probed, stub.misreads), ({"dg", "rate", "pd"}, []))
        self.assertIn("dg", stub.ambiguous)   # a bare option number on this list is asked again, and reported

    def test_multi_select_and_old_copies(self):
        self.assertEqual(parse("1, 2", Question("m", options=["Red", "Green", "Blue"], multiple=True))["codes"],
                         ["1", "2"])
        old = type("OldQuestion", (), {"id": "x", "text": "", "options": ["A", "B"], "kind": "choice",
                                       "codes": ["1", "2"], "key": None, "required": True, "multiple": False})()
        converted = replies.StubParticipant._current(old)
        self.assertTrue(converted.legacy and converted.integer and converted.codes == ["1", "2"])

    def test_sessions_for(self):
        self.assertEqual(replies.sessions_for(4, "a"), 4)
        self.assertEqual(replies.sessions_for({"a": 357, "b": 257}, "b"), 257)
        self.assertEqual(replies.sessions_for({"a": 1}, "b"), 0)


class PaperCellSizes(Project):
    def test_paper_n_needs_run_sessions_to_take_a_dict(self):
        root, pkg = self.project()
        (pkg / "task/task.json").write_text(json.dumps({"conditions": [{"id": "control", "paper_n": 357},
                                                                       {"id": "treatment", "paper_n": 257}]}))
        text = "\n".join(m for m, _ in check_replies.problems(root, pkg))   # the fixture does range(n)
        self.assertIn("n may be a dict of cell sizes", text)
        (pkg / "task/adapter.py").write_text(ADAPTER.replace(
            "smoke_main, split_reply", "sessions_for, smoke_main, split_reply").replace(
            "for index in range(n):", "for index in range(sessions_for(n, arm)):"))
        self.assertEqual(check_replies.problems(root, pkg), [])


class Markers(Project):
    """A package cannot hand the checker a report of its own: one marker line, carrying this run's nonce."""

    def test_read_marked_takes_one_line_with_this_runs_nonce(self):
        mark, nonce = check_replies.MARK, "ab" * 16
        good = check_replies.marked(mark, nonce, json.dumps({"ok": True}))
        self.assertEqual(check_replies.read_marked("noise\n" + good + "\n", mark, nonce), ({"ok": True}, None))
        forged = mark + json.dumps({"ok": True})                      # the old, nonce-less form
        self.assertIsNotNone(check_replies.read_marked(forged, mark, nonce)[1])
        self.assertIsNotNone(check_replies.read_marked(check_replies.marked(mark, "cd" * 16, "{}"), mark, nonce)[1])
        two = check_replies.read_marked(good + "\n" + good, mark, nonce)
        self.assertEqual(two[0], None)
        self.assertIn("2 report lines", two[1])
        self.assertEqual(check_replies.read_marked("", mark, nonce), (None, None))
        self.assertNotEqual(check_replies.new_nonce(), check_replies.new_nonce())

    def test_package_printing_a_forged_report_fails_and_never_sees_the_nonce(self):
        forge = ('import os as _os\nprint("NONCE-SEEN" if _os.environ.get("%s") else "", file=sys.__stderr__)\n'
                 'print(%r, file=sys.__stdout__, flush=True)\n'
                 'print(%r, file=sys.__stdout__, flush=True)\n'
                 % (check_replies.NONCE_ENV, check_replies.MARK + json.dumps({"ok": True, "arms": {}, "problems": []}),
                    recorded_answers.MARK + json.dumps({"dropped": [], "checked": 9, "skipped": None})))
        adapter = ADAPTER.replace("def run_sessions(llm, seed, n, arms=None):\n",
                                  forge + "def run_sessions(llm, seed, n, arms=None):\n", 1)
        root, pkg = self.project(adapter=adapter.replace(
            '                    session["comment"] = page.value("comment")\n', ""))
        found = "\n".join(m for m, _ in check_replies.problems(root, pkg))
        self.assertIn("cannot be trusted", found)
        answers = recorded_answers.judge(pkg)
        self.assertTrue(any("cannot be trusted" in m for m, _ in answers["problems"]), answers)
        # the child deleted the nonce before loading the package
        with sandbox_run.work_dir() as work:
            copy = check_replies.copy_like_project(pkg, work)
            run = sandbox_run.run_python(BUILD / "check_replies.py", ["--smoke-child", str(copy)], cwd=copy,
                                         work=work, timeout=120, env={check_replies.NONCE_ENV: "f" * 32})
        self.assertNotIn("NONCE-SEEN", run.stderr)
        self.assertIn(check_replies.marked(check_replies.MARK, "f" * 32, ""), run.stdout)


class PackageNotes(Project):
    def test_legacy_package_gets_a_note_not_a_failure(self):
        import check_package
        _, pkg = self.project(adapter=LEGACY, replies_copy=False)
        self.assertEqual(check_package.reply_checks(pkg), (
            [], "note replies checks skipped: no task/replies.py (packages built before the shared reader)"))
        _, pkg = self.project()
        self.assertEqual(check_package.reply_checks(pkg), (
            [], "ok   replies: shared reader unchanged, answer-aware smoke test passes, every answer recorded"))

    def test_current_contract_package_without_the_reader_fails(self):
        import check_package
        _, pkg = self.project(adapter=LEGACY, replies_copy=False)
        study = json.loads((pkg / "study.json").read_text(encoding="utf-8"))
        study["buildContract"] = 2
        (pkg / "study.json").write_text(json.dumps(study), encoding="utf-8")
        bad, _ = check_package.reply_checks(pkg)
        self.assertEqual(len(bad), 1)
        self.assertIn("task/replies.py is missing", bad[0][0])

    def test_recorded_answers_that_cannot_judge_say_why(self):
        self.assertEqual(recorded_answers._note({"dropped": [], "checked": 2, "skipped": None}, None), None)
        self.assertEqual(recorded_answers._note(None, "the check did not finish within 150 s"),
                         "every answer recorded: not judged (the check did not finish within 150 s)")
        self.assertIn("checked in part", recorded_answers._note(
            {"checked": 3, "skipped": "time budget reached; later conditions not checked"}, None))
        adapter = ADAPTER.replace('session = {"condition": arm,',
                                  'import uuid\n            session = {"run": str(uuid.uuid4()), "condition": arm,')
        _, pkg = self.project(adapter=adapter)
        result = recorded_answers.judge(pkg)
        self.assertEqual(result["problems"], [])
        self.assertTrue(result["note"].startswith("every answer recorded: not judged (sessions differ"), result)
        run = subprocess.run([sys.executable, "-B", str(BUILD / "recorded_answers.py"), str(pkg)],
                             capture_output=True, text=True, timeout=600)
        self.assertIn("note    every answer recorded: not judged (sessions differ", run.stdout)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        hang = ADAPTER.replace("def run_sessions(llm, seed, n, arms=None):\n",
                               "def run_sessions(llm, seed, n, arms=None):\n    while True:\n        pass\n", 1)
        _, pkg = self.project(adapter=hang)
        result = recorded_answers.judge(pkg, timeout=5)
        self.assertEqual(result["problems"], [])
        self.assertIn("not judged (the check did not finish within 5 s)", result["note"])


# --------------------------------------------------------------------------- the simulate skill's parallel path

class Simulate(Project):
    def test_a_replies_package_runs_in_simkit_both_ways(self):
        _, pkg = self.project()
        adapter = self.load(pkg / "task/adapter.py", "replies_fixture_adapter")
        lock = threading.Lock()
        calls = []

        def model(prompt):   # a stand-in for humanstudy_llm.llm(prompt, temperature=...)
            with lock:
                calls.append(prompt)
            return "4" if "2 + 2" in prompt else "Q1: %d\nQ2: fine" % random.Random(prompt).choice([1, 2])

        def one_run_sessions(condition, index, rng):   # one participant through the adapter's own flow
            session = adapter.run_sessions(model, rng.randrange(2 ** 31), 1, arms=[condition])[0]
            return dict(session, condition=condition)

        def one_prompt_parse(condition, index, rng):   # a single-screen study through build_prompt/parse_reply
            prompt = adapter.build_prompt("s1", condition)
            reply = model(prompt)
            answers = adapter.parse_reply("s1", condition, reply)
            return {"condition": condition, "arm": condition, "reply": reply,
                    "status": "completed" if all(a["status"] == "ok" for a in answers.values()) else "unparsed",
                    "choice": answers["choice"].get("label")}

        for one in (one_run_sessions, one_prompt_parse):
            with tempfile.TemporaryDirectory() as d:
                sessions = simkit.SimRun(d, plan={"control": 3, "treatment": 3}, workers=4).participants(one)
            with self.subTest(one=one.__name__):
                self.assertEqual(len(sessions), 6)
                self.assertTrue(all(s["status"] == "completed" and s["choice"] in ("Left", "Right") for s in sessions),
                                sessions)
        self.assertTrue(any("2 + 2" in c for c in calls))


if __name__ == "__main__":
    unittest.main()
