"""The analysis run of check_validity.py and the rules read from it (batch-2 reviews): every effect a package
reports computes on keyed stand-in sessions; one unread reply drops one participant, never a group and never an
outcome while the session stays completed; checks are keyed and answered without the stimulus on screen; prompts
carry no export markup or design names; within-person outcomes get the memory they need; no compiled Python ships.
   python -m unittest discover -s pack/runtime/tests"""
import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[3]
BUILD = REPO / "pack/skills/build"
sys.path.insert(0, str(BUILD))
import check_package  # noqa: E402
import check_validity  # noqa: E402

sys.path.insert(0, str(check_validity.EFFECTS_CORE))
import effects_core  # noqa: E402

_spec = importlib.util.spec_from_file_location("humanstudy_replies_shipped", check_validity.SHIPPED_REPLIES)
REPLIES = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = REPLIES
_spec.loader.exec_module(REPLIES)

HEAD = '''
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import replies
from replies import Question, ask

STORY = {"high": "You receive a dinnerware set of 24 pieces, all intact.",
         "low": "You receive a dinnerware set of 40 pieces, some of them broken."}
'''

# one rating per participant; %(required)s, %(field)s, %(value)s vary per test
RATING = HEAD + '''

def run_sessions(llm, seed, n, arms=None):
    out = []
    for arm in arms or ["high", "low"]:
        for i in range(n):
            q = Question("rating", "How much would you like this gift? (1 = not at all, 7 = very much)",
                         options=[str(k) for k in range(1, 8)], required=%(required)s)
            page = ask(llm, STORY[arm] + "\\n\\n" + replies.render_questions([q]), [q])
            v = page.value("rating")
            status = "completed" if page.ok else "unparsed"
            out.append({"arm": arm, "condition": arm, "status": status, "%(field)s": %(value)s})
    return out
'''

EVALUATION = '''
def evaluate(sessions):
    done = [s for s in sessions if s.get("status") == "completed" and s.get("rating") is not None]
    return {%(keep)s"n": len(done)}


def effect_estimates(evaluation):
    rows = evaluation.get("_sessions", [])
    hi = [s["rating"] for s in rows if s["arm"] == "high"]
    lo = [s["rating"] for s in rows if s["arm"] == "low"]
    if len(hi) < 2 or len(lo) < 2:
        return {"diff": {"status": "not_ready", "reason": "needs at least 2 participants in each arm"}}
    return {"diff": {"status": "computed", "value": sum(hi) / len(hi) - sum(lo) / len(lo), "n": len(hi) + len(lo)}}
'''

EFFECT = {"id": "e_diff", "studyId": "s1", "contrast": {"kind": "between", "treatment": "high", "reference": "low"},
          "compute": {"op": "package", "key": "diff"}}


def rating(required="True", field="rating", value="int(v) if v else None"):
    return RATING % {"required": required, "field": field, "value": value}


def evaluation(keep='"_sessions": done, '):
    return EVALUATION % {"keep": keep}


class Fixture(unittest.TestCase):
    def package(self, adapter, evaluation_text=None, effects=None, capabilities=None, conditions=("high", "low"),
                materials=None, program=None):
        root = Path(tempfile.mkdtemp(prefix="analysis-run-"))
        self.addCleanup(shutil.rmtree, root, True)
        pkg = root / "package/x"
        for d in ("task", "evaluation", "materials"):
            (pkg / d).mkdir(parents=True)
        shutil.copy2(check_validity.SHIPPED_REPLIES, pkg / "task/replies.py")
        (pkg / "task/adapter.py").write_text(adapter, encoding="utf-8")
        (pkg / "task/task.json").write_text(json.dumps({"conditions": [
            c if isinstance(c, dict) else {"id": c} for c in conditions]}), encoding="utf-8")
        (pkg / "evaluation/evaluation.py").write_text(evaluation_text or evaluation(), encoding="utf-8")
        (pkg / "materials/materials.json").write_text(json.dumps(materials or {}), encoding="utf-8")
        (root / "effects.json").write_text(json.dumps(effects if effects is not None else {"effects": [EFFECT]}),
                                           encoding="utf-8")
        if capabilities is not None:
            (root / "capabilities.json").write_text(json.dumps(capabilities), encoding="utf-8")
        (root / "program.json").write_text(json.dumps(program or {"nodes": [], "steps": [], "issues": []}),
                                           encoding="utf-8")
        return root, pkg

    def probe(self, root, pkg):
        for name in ("hs_probe_adapter", "hs_probe_evaluation", "replies"):
            sys.modules.pop(name, None)
        return json.loads(json.dumps(check_validity._probe(pkg, REPLIES, effects_core), default=str))

    def rules(self, root, pkg, probe=None):
        """(problems, warnings, summary) of the effect and unread rules on the analysis run."""
        probe = probe if probe is not None else self.probe(root, pkg)
        problems, warnings, notes = [], [], []
        newer = lambda m, f="": problems.append(m)  # noqa: E731
        warn = lambda m, f="": warnings.append(m)  # noqa: E731
        summary = check_validity.effect_rules(root, pkg, probe, newer, warn, notes)
        check_validity.unread_rules(probe, newer, warn)
        return problems, warnings, summary


class EffectsCompute(Fixture):
    """Every effect not excluded in capabilities.json computes on 10 keyed stand-in sessions per arm."""

    def test_a_clean_package_computes_every_effect(self):
        problems, warnings, summary = self.rules(*self.package(rating()))
        self.assertEqual(problems, [])
        self.assertEqual(warnings, [])
        self.assertTrue(summary.startswith("1 of 1 effects compute"), summary)

    def test_an_analysis_that_crashes_on_labels(self):
        # vonasch2023lessisbetter: the choice label (a str) is averaged
        problems, _, summary = self.rules(*self.package(rating(value="v")))
        self.assertTrue(any("never compute because the analysis crashes" in m and "unsupported operand" in m
                            for m in problems), problems)
        self.assertTrue(summary.startswith("0 of 1"), summary)

    def test_a_key_the_sessions_do_not_carry(self):
        # chandrashekar2021blindspot: the adapter writes fwd4, the analysis reads fwd
        problems, _, _ = self.rules(*self.package(rating(field="rating4")))
        self.assertTrue(any("reads 'rating', which no session carries" in m and "'rating4'" in m for m in problems),
                        problems)

    def test_sessions_evaluate_does_not_return(self):
        # li2025mentalaccounting: effect_estimates reads evaluation['_sessions'], evaluate() drops it
        problems, _, _ = self.rules(*self.package(rating(), evaluation(keep="")))
        self.assertTrue(any("evaluation['_sessions'], which evaluate() does not return" in m for m in problems),
                        problems)

    def test_a_compute_key_the_analysis_does_not_return(self):
        effects = {"effects": [dict(EFFECT, compute={"op": "package", "key": "difference"})]}
        problems, _, _ = self.rules(*self.package(rating(), effects=effects))
        self.assertTrue(any("compute.key that effect_estimates() does not return" in m and "diff" in m
                            for m in problems), problems)

    def test_an_excluded_effect_is_not_required_but_some_effect_must_be_live(self):
        caps = {"run": {"excluded": [{"effects": ["e_diff"], "reason": "needs the lab's stimuli"}]}}
        problems, _, _ = self.rules(*self.package(rating(value="v"), capabilities=caps))
        self.assertFalse(any("crashes" in m for m in problems), problems)
        # sirota2021verbalcrt: every effect excluded while the arms run
        self.assertTrue(any("no effect of effects.json is computed from the arms the package runs" in m
                            for m in problems), problems)


GROUP = HEAD + '''

def run_sessions(llm, seed, n, arms=None):
    out = []
    for arm in arms or ["high", "low"]:
        for g in range(n):
            members = []
            for p in range(4):
                q = Question("c", "How many of the 20 points do you contribute to the group project? (0 to 20)",
                             kind="number", minimum=0, maximum=20)
                page = ask(llm, "You are in a group of four. " + replies.render_questions([q]), [q])
                members.append({"player": p, "contribution": page.value("c"), "parsed": page.ok})
            %(status)s
            out.append({"arm": arm, "condition": arm, "status": status, "members": members,
                        "rating": sum(m["contribution"] or 0 for m in members)})
    return out
'''


class UnreadReplies(Fixture):
    def test_one_unread_reply_does_not_drop_the_group(self):
        # arechar2018online: the whole group of four leaves on one unread contribution
        dropped = GROUP % {"status": 'status = "completed" if all(m["parsed"] for m in members) else "unparsed"'}
        problems, _, _ = self.rules(*self.package(dropped))
        self.assertTrue(any("one unread reply" in m and "removed 4 participants" in m for m in problems), problems)
        kept = GROUP % {"status": 'status = "completed"'}
        problems, _, _ = self.rules(*self.package(kept))
        self.assertFalse(any("one unread reply" in m for m in problems), problems)

    def test_an_optional_outcome_left_unread_keeps_a_completed_session_with_nothing(self):
        # wong2025bracketing: required=False on the DV, the session stays completed with None
        problems, _, _ = self.rules(*self.package(rating(required="False")))
        self.assertTrue(any("stays `completed` but counts in no effect at all" in m for m in problems), problems)

    def test_a_check_that_decides_exclusion_needs_its_key(self):
        # ruggeri2022discounting: an unkeyed attention check sends a share of participants to `excluded`
        gate = HEAD + '''

def run_sessions(llm, seed, n, arms=None):
    out = []
    for arm in arms or ["high", "low"]:
        for i in range(n):
            a = Question("att", "Which would you prefer?", options=["Receive $500 right now", "Pay $500 in one year"]%(key)s)
            first = ask(llm, "Please read carefully. " + replies.render_questions([a]), [a])
            q = Question("rating", "How much would you like this gift? (1 = not at all, 7 = very much)",
                         options=[str(k) for k in range(1, 8)])
            page = ask(llm, STORY[arm] + "\\n\\n" + replies.render_questions([q]), [q])
            v = page.value("rating")
            failed = first.value("att") != "Receive $500 right now"
            out.append({"arm": arm, "condition": arm, "status": "excluded" if failed else "completed",
                        "exclusion_reason": "failed the attention check" if failed else None,
                        "rating": int(v) if v else None})
    return out
'''
        problems, _, _ = self.rules(*self.package(gate % {"key": ""}))
        self.assertTrue(any("question att \"Which would you prefer?\" decides whether a session is completed" in m
                            and "without key=" in m for m in problems), problems)
        problems, _, _ = self.rules(*self.package(gate % {"key": ', key="1"'}))
        self.assertFalse(any("without key=" in m for m in problems), problems)

    def test_any_that_settles_before_its_unread_answers(self):
        # thomson2016crt2: any(yes) returns True with unread answers, False only when all are read
        root = Path(tempfile.mkdtemp(prefix="analysis-run-"))
        self.addCleanup(shutil.rmtree, root, True)
        bad = root / "bad.py"
        bad.write_text('''
def any_yes(vals):
    if any(v == "Yes" for v in vals):
        return True
    return None if any(v is None for v in vals) else False
''', encoding="utf-8")
        self.assertEqual([n for n, _ in check_validity.asymmetric_any(bad)], [3])
        good = root / "good.py"
        good.write_text('''
def any_yes(vals):
    if any(v is None for v in vals):
        return None
    return any(v == "Yes" for v in vals)
''', encoding="utf-8")
        self.assertEqual(check_validity.asymmetric_any(good), [])
        # all(v == "Yes") is never True while an answer is unread: symmetric, not flagged
        both = root / "both.py"
        both.write_text('''
def all_yes(vals):
    if all(v == "Yes" for v in vals):
        return True
    return None if any(v is None for v in vals) else False
''', encoding="utf-8")
        self.assertEqual(check_validity.asymmetric_any(both), [])


class Confined(Fixture):
    def test_the_analysis_run_in_the_sandboxed_child(self):
        root, pkg = self.package(rating(field="rating4"))
        probe = check_validity.probe_of(pkg, root=root)
        self.assertNotIn("error", probe)
        problems, _, _ = self.rules(root, pkg, probe)
        self.assertTrue(any("'rating4'" in m for m in problems), problems)

    def test_an_arm_that_never_finishes_is_stopped_and_not_judged(self):
        forever = HEAD + '''

def run_sessions(llm, seed, n, arms=None):
    done = []
    while len(done) < n:   # recruits until n pass a check nobody passes
        q = Question("rating", "How much would you like this gift? (1 = not at all, 7 = very much)",
                     options=[str(k) for k in range(1, 8)])
        try:
            ask(llm, STORY["high"] + "\\n\\n" + replies.render_questions([q]), [q])
        except Exception:
            pass
    return done
'''
        root, pkg = self.package(forever, conditions=("high",))
        probe = self.probe(root, pkg)
        self.assertTrue(probe["arms"]["high"]["error"].startswith("stopped"), probe["arms"])
        problems, _, _ = self.rules(root, pkg, probe)
        self.assertFalse(any("never compute" in m or "do not compute" in m for m in problems), problems)


TASKS = HEAD + '''
TASKS = ["How risky is a lottery that pays 10 euros with probability one half? (1 = safe, 7 = very risky)",
         "How risky is investing all your savings in a single stock? (1 = safe, 7 = very risky)",
         "How risky is crossing the street without looking left and right? (1 = safe, 7 = very risky)",
         "How risky is a bet that doubles 50 euros or loses them on a coin flip? (1 = safe, 7 = very risky)"]


def run_sessions(llm, seed, n, arms=None):
    out = []
    for arm in arms or ["within"]:
        for i in range(n):
            answers, earlier = {}, []
            for t, text in enumerate(TASKS):
                q = Question("t%%d" %% t, text, options=[str(k) for k in range(1, 8)])
                carried = %(carried)s
                page = ask(llm, carried + "Task %%d of four, a new screen with its own question.\\n" %% (t + 1)
                           + replies.render_questions([q]), [q])
                answers["t%%d" %% t] = page.value("t%%d" %% t)
                earlier.append("In task %%d you answered %%s." %% (t + 1, page.value("t%%d" %% t)))
            out.append(dict(answers, arm=arm, condition=arm, status="completed"))
    return out
'''
ASSOC = {"effects": [{"id": "r_t0_t1", "design": "within", "contrast": {"kind": "association"},
                      "compute": {"op": "package", "key": "r"}}]}
ASSOC_EVAL = '''
def evaluate(sessions):
    return {"_sessions": [s for s in sessions if s.get("status") == "completed"]}


def effect_estimates(evaluation):
    rows = evaluation["_sessions"]
    return {"r": {"status": "computed", "value": 0.1 * len(rows), "n": len(rows)}}
'''


class WithinPerson(Fixture):
    def found(self, carried, program=None):
        root, pkg = self.package(TASKS % {"carried": carried}, ASSOC_EVAL, ASSOC, conditions=("within",),
                                 program=program)
        probe = self.probe(root, pkg)
        problems = []
        check_validity.memory_rules(root, pkg, json.loads((root / "program.json").read_text()), probe,
                                    lambda m, f="": problems.append(m))
        return probe, problems

    def test_an_association_across_fresh_calls_is_set_by_construction(self):
        # holzmeister2021risk: four risk tasks, each a fresh call; their correlations compared with humans'
        probe, problems = self.found('""')
        self.assertTrue(probe["memory"]["within"]["stateless"], probe["memory"])
        self.assertTrue(any("set by construction" in m for m in problems), problems)
        probe, problems = self.found('"\\n".join(earlier) + "\\n" if earlier else ""')
        self.assertFalse(probe["memory"]["within"]["stateless"], probe["memory"])
        self.assertEqual(problems, [])

    def test_within_outcomes_without_memory_need_more_than_a_non_blocking_decision(self):
        effects = {"effects": [{"id": "d_t0_t1", "design": "within", "contrast": {"kind": "paired"},
                                "compute": {"op": "package", "key": "r"}}]}
        root, pkg = self.package(TASKS % {"carried": '""'}, ASSOC_EVAL, effects, conditions=("within",))
        probe = self.probe(root, pkg)
        program = {"nodes": [{"id": "task", "kind": "task", "fields": [
            {"id": "replay-memory", "origin": "implementation", "value": {"design": "none"}}]}], "issues": []}
        problems = []
        check_validity.memory_rules(root, pkg, program, probe, lambda m, f="": problems.append(m))
        self.assertTrue(any("non-blocking decision" in m for m in problems), problems)
        program["issues"].append({"id": "i", "fieldId": "replay-memory", "severity": "blocking"})
        problems = []
        check_validity.memory_rules(root, pkg, program, probe, lambda m, f="": problems.append(m))
        self.assertEqual(problems, [])

    def test_one_human_through_several_scenarios_is_not_one_agent_per_scenario(self):
        # wong2025bracketing: seven scenarios in one survey, one scenario per AI participant
        conditions = [{"id": "s1_a", "study": "s1"}, {"id": "s1_b", "study": "s1"}, {"id": "s2_a", "study": "s2"}]
        effects = {"effects": [{"id": "e1", "studyId": "s1"}, {"id": "e2", "studyId": "s2"}]}
        program = {"nodes": [{"id": "d", "kind": "design", "fields": [
            {"id": "f", "value": "Between-subjects conditions; scenario order randomised across the studies."}]}]}
        root, pkg = self.package(rating(), effects=effects, conditions=conditions, program=program)
        problems = []
        self.assertTrue(check_validity.split_rules(root, pkg, program, lambda m, f="": problems.append(m)))
        self.assertTrue(any("every AI participant answers one" in m for m in problems), problems)
        program["nodes"][0]["fields"][0]["value"] = "Between-subjects; each participant saw one scenario."
        self.assertFalse(check_validity.split_rules(root, pkg, program, lambda m, f="": problems.append(m)))


STORY_TEXT = ("Darrel is a zoologist out walking in the prairie. He sees a small animal near a burrow and thinks it is a "
              "prairie dog. It is in fact a prairie dog, although many ground squirrels live in the same field and look "
              "almost the same from a distance. Darrel says to his daughter that he is looking at a prairie dog.")


class Screens(Fixture):
    def test_a_check_is_not_answered_with_the_story_on_screen(self):
        # hall2024gettier, huber2023manydesigns: the comprehension question repeats the vignette
        program = {"nodes": [{"id": "m-vignette", "kind": "material", "title": "Vignette", "fields": [
            {"id": "text", "origin": "verbatim", "value": STORY_TEXT}]}], "steps": []}
        call = lambda shown, text, keyed=True: {"k": keyed, "t": [text], "s": shown}  # noqa: E731
        probe = {"arms": {"a": {"calls": [call(["m-vignette"], "Does Darrel know it is a prairie dog?", False),
                                          call(["m-vignette"], "Darrel is looking at a ____.")]}}}
        problems = []
        check_validity.check_rules(program, {}, probe, lambda m, f="": problems.append(m))
        self.assertTrue(any("m-vignette shown with" in m for m in problems), problems)
        # first shown on the check itself, or declared as staying on screen by a source: no finding
        problems = []
        check_validity.check_rules(program, {}, {"arms": {"a": {"calls": probe["arms"]["a"]["calls"][1:]}}},
                                   lambda m, f="": problems.append(m))
        repeats = {"screenMemory": {"repeats": [{"screen": "m-vignette", "evidenceIds": ["e"]}]}}
        check_validity.check_rules(program, repeats, probe, lambda m, f="": problems.append(m))
        self.assertEqual(problems, [])

    def test_a_running_summary_does_not_undo_one_screen_against_several(self):
        # wong2025bracketing study 7: the one-day-at-a-time arm sees "Your answers so far"
        days = ["Monday", "Tuesday", "Wednesday"]
        probe = {"arms": {"day": {"summary": "Your answers so far in this scenario:", "singles": days, "grouped": []},
                          "week": {"summary": None, "singles": [], "grouped": [days]}}}
        problems = []
        check_validity.summary_rules(probe, [], lambda m, f="": problems.append(m))
        self.assertTrue(any("arm day shows \"Your answers so far" in m and "arm week" in m for m in problems), problems)
        problems = []
        printed = [check_validity.norm("Your answers so far in this scenario:")]   # the original screens printed it
        check_validity.summary_rules(probe, printed, lambda m, f="": problems.append(m))
        self.assertEqual(problems, [])

    def test_questions_keyed_and_asked_as_declared(self):
        # vlasceanu2024climate: "type the word sixty" declared text, asked as a number
        text = "To indicate you are paying attention, please type the word sixty in the box below."
        root, pkg = self.package(rating(), materials={"questions": [{"tag": "Attn_60", "type": "text", "text": text}]})
        probe = {"questions": {"q": {"id": "Attn_60", "kind": "number", "text": text, "keyed": True}}}
        problems, warnings = [], []
        check_validity.question_rules(pkg, probe, lambda m, f="": problems.append(m), lambda m, f="": warnings.append(m))
        self.assertTrue(any("Attn_60 declared text, asked as number" in m for m in problems), problems)
        probe["questions"]["q"].update(kind="text", keyed=False)
        problems, warnings = [], []
        check_validity.question_rules(pkg, probe, lambda m, f="": problems.append(m), lambda m, f="": warnings.append(m))
        self.assertEqual(problems, [])
        self.assertTrue(any("asked without key=" in m for m in warnings), warnings)

    def test_export_markup_and_design_names_in_prompts(self):
        # ruggeri2022discounting: "Start of Block: Consent" sent as screen text
        root, pkg = self.package(rating(), conditions=[{"id": "high", "title": "Less is better high value"}])
        runs = [{"arms": ["high"], "lines": ["Start of Block: Consent", "Please read the consent form."]},
                {"arms": ["high"], "lines": ["This is the less is better high value condition."]}]
        problems, warnings = [], []
        check_validity.prompt_text_rules(root, pkg, {"nodes": []}, runs, [], lambda m, f="": problems.append(m),
                                         lambda m, f="": warnings.append(m))
        self.assertTrue(any("'Start of Block'" in m for m in problems), problems)
        self.assertTrue(any("condition title 'Less is better high value'" in m for m in problems), problems)
        problems = []
        check_validity.prompt_text_rules(root, pkg, {"nodes": []}, [{"arms": ["high"], "lines": ["Please read on."]}], [],
                                         lambda m, f="": problems.append(m), lambda m, f="": warnings.append(m))
        self.assertEqual(problems, [])


class ContractGate(Fixture):
    """The analysis run's rules came with build contract 3: problems from study.json buildContract 3, warnings
    below (a run that times out, too), so a project that was ready stays ready after an app update."""

    def verdict(self, contract, probe):
        from unittest import mock
        root, pkg = self.package(rating())
        if contract is not None:
            (pkg / "study.json").write_text(json.dumps({"buildContract": contract}), encoding="utf-8")
        with mock.patch.object(check_validity, "prompts_of", lambda p: {"runs": []}), \
                mock.patch.object(check_validity, "probe_of", lambda p, root=None: probe):
            report = check_validity.check(root, pkg)
        return [m for m, _ in report["problems"]], [m for m, _ in report["warnings"]]

    def test_a_timed_out_analysis_run_warns_below_contract_3(self):
        hung = {"error": "the analysis run did not finish within 360 s", "timedOut": True}
        for contract in (None, 2):
            problems, warnings = self.verdict(contract, hung)
            self.assertFalse([m for m in problems if "could not judge the effects" in m], (contract, problems))
            self.assertTrue([m for m in warnings if "could not judge the effects" in m
                             and "blocking from buildContract 3" in m], (contract, warnings))
        problems, warnings = self.verdict(3, hung)
        self.assertTrue([m for m in problems if "could not judge the effects" in m], problems)

    def test_an_effect_that_does_not_compute_warns_below_contract_3(self):
        root, pkg = self.package(rating(value="v"))
        crashing = self.probe(root, pkg)
        problems, warnings = self.verdict(2, crashing)
        self.assertFalse([m for m in problems if "never compute" in m], problems)
        self.assertTrue([m for m in warnings if "never compute" in m], warnings)
        problems, _ = self.verdict(3, crashing)
        self.assertTrue([m for m in problems if "never compute" in m], problems)


class CompiledPython(unittest.TestCase):
    def test_a_package_ships_no_pycache(self):
        root = Path(tempfile.mkdtemp(prefix="analysis-run-"))
        self.addCleanup(shutil.rmtree, root, True)
        (root / "task/__pycache__").mkdir(parents=True)
        (root / "task/__pycache__/adapter.cpython-312.pyc").write_bytes(b"x")
        (root / "evaluation").mkdir()
        (root / "evaluation/old.pyc").write_bytes(b"x")
        (root / "task/adapter.py").write_text("", encoding="utf-8")
        self.assertEqual(check_package.compiled(root), ["evaluation/old.pyc", "task/__pycache__"])
        shutil.rmtree(root / "task/__pycache__")
        (root / "evaluation/old.pyc").unlink()
        self.assertEqual(check_package.compiled(root), [])


if __name__ == "__main__":
    unittest.main()
