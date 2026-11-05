"""Self-contained prompts, identical arms and unread answers (check_validity.py with prompt_context.py).

A stateless model call sees only its prompt: a quiz must carry the instructions it tests, later rounds the
rules, and an effect cannot contrast arms whose prompts are identical. The fixture is a two-part public-goods
game shaped like the stage-1 regression case (a quiz before each part, online and lab arms that differ only
in label).
   python -m unittest discover -s pack/runtime/tests"""
import copy
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
sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_validity  # noqa: E402
import prompt_context  # noqa: E402
import test_validity as tv  # noqa: E402  (a module, so its tests are not collected twice)

INSTR1 = ("Instructions. In this experiment you play a game with the same three people for ten rounds. "
          "At the start of each round every group member receives 20 points. "
          "You decide how many of the 20 points you contribute to a group project and keep the rest. "
          "The points in the project are multiplied by 1.6 and shared equally among all four members.")
QUIZ1 = ("Quiz. Please answer all control questions before the game starts. "
         "They serve as a test for your understanding of the experiment and its rules. "
         "Each group member receives 20 points and contributes nothing: what is your income?")
INSTR2 = ("Instructions for the second experiment. This experiment is very similar to your task in the first one. "
          "After each round you may assign deduction points to each other member of your group. "
          "Each deduction point you assign costs you one point and reduces the income of the member by three points.")
QUIZ2 = ("Quiz. Please answer all control questions for the second experiment now. "
         "They serve as a test for your understanding of the second experiment's rules. "
         "You assign two deduction points to one member: how many points does this cost you?")

ADAPTER = '''
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from replies import Question, ask, render_questions, smoke_main, sessions_for

INSTR1, QUIZ1, INSTR2, QUIZ2 = %(texts)r
ARMS = %(arms)r
CARRY = %(carry)r
PERSONA = %(persona)r


def screens(part):
    return [INSTR1, INSTR2][:part] if CARRY else [[INSTR1, INSTR2][part - 1]]


def run_sessions(llm, seed, n, arms=None):
    out = []
    for arm in (arms or ARMS):
        for i in range(sessions_for(n, arm)):
            rec = {"arm": arm, "condition": arm, "status": "completed", "c": []}
            for part, quiz, key in ((1, QUIZ1, 20), (2, QUIZ2, 2)):
                before = screens(part) if CARRY else []
                q = Question("quiz%%d" %% part, text="Your answer", kind="number", minimum=0, maximum=100, key=key)
                page = ask(llm, "\\n\\n".join([PERSONA.get(arm, "")] + before + [quiz, render_questions([q])]), [q])
                for r in range(1, 4):
                    c = Question("c", text="How many points do you contribute to the project?", kind="number",
                                 minimum=0, maximum=20, required=False, retry=True)
                    page = ask(llm, "\\n\\n".join([PERSONA.get(arm, "")] + screens(part) + ["Round %%d." %% r,
                                                                                         render_questions([c])]), [c])
                    v = page.value("c")
                    %(store)s
            out.append(rec)
    return out


if __name__ == "__main__" and "--smoke-test" in sys.argv:
    sys.exit(smoke_main(Path(__file__)))
'''


def game(carry=False, arms=("online", "lab"), persona=None, default0=False):
    store = "rec['c'].append(v if v is not None else 0)" if default0 else "rec['c'].append(v)"
    return ADAPTER % {"texts": (INSTR1, QUIZ1, INSTR2, QUIZ2), "arms": list(arms), "carry": carry,
                      "persona": persona or {}, "store": store}


def material(nid, text):
    return {"id": nid, "kind": "material", "title": nid, "fields": [
        {"id": "text", "label": "Screen text", "origin": "verbatim", "state": "confirmed", "evidenceIds": [], "value": text}]}


STEPS = [("s-instr1", "m-instr1"), ("s-quiz1", "m-quiz1"), ("s-play1", None), ("s-instr2", "m-instr2"),
         ("s-quiz2", "m-quiz2"), ("s-play2", None)]


def effect(eid, treatment, reference):
    return {"id": eid, "label": eid, "role": "descriptive", "hypothesisIds": [], "studyId": "s1", "design": "between",
            "outcome": {"type": "continuous"}, "contrast": {"kind": "two_groups", "treatment": treatment,
                                                            "reference": reference},
            "compute": {"op": "mean_difference", "field": "c"}, "reported": None}


class SelfContained(tv.FakePdfMixin, unittest.TestCase):
    current = True
    # the project helpers of test_validity.Validity, without re-running its tests
    project, problems = tv.Validity.project, tv.Validity.problems
    not_told, memory = staticmethod(tv.Validity.not_told), staticmethod(tv.Validity.memory)
    MEMORY_ISSUE = tv.Validity.MEMORY_ISSUE

    def game_project(self, text, effects=None, capabilities=None, materials=None, conditions=None):
        # the prompts grow from part 1 to part 2 (carried screens): a researcher's memory decision records it
        root = self.project([self.not_told([tv.ENTRY]), self.memory("other", origin="researcher")], text,
                            issues=[self.MEMORY_ISSUE])
        p = json.loads((root / "program.json").read_text(encoding="utf-8"))
        p["nodes"] += [material("m-instr1", INSTR1), material("m-quiz1", QUIZ1), material("m-instr2", INSTR2),
                       material("m-quiz2", QUIZ2)]
        p["evidence"].append({"id": "e-gone", "path": "paper.pdf", "locator": {"page": 2},
                              "quote": "The first instructions were not available during the second part."})
        p["steps"] = [{"id": "s-root", "studyId": "s1", "kind": "sequence", "title": "Session", "actorIds": ["pt"],
                       "visibleIds": [], "children": [s for s, _ in STEPS]}] + [
            {"id": s, "studyId": "s1", "kind": "action", "title": s, "actorIds": ["pt"],
             "visibleIds": [m] if m else [], "inputIds": [m] if m else [], "children": []} for s, m in STEPS]
        (root / "program.json").write_text(json.dumps(p), encoding="utf-8")
        pkg = root / "package/x"
        shutil.copy2(BUILD / "package_files/replies.py", pkg / "task/replies.py")
        (pkg / "materials").mkdir(exist_ok=True)
        (pkg / "materials/materials.json").write_text(json.dumps(materials or {}), encoding="utf-8")
        (pkg / "task/task.json").write_text(json.dumps({"conditions": conditions or [
            {"id": "online", "label": "Online sample", "programNodes": ["pt-online"]},
            {"id": "lab", "label": "Laboratory sample", "programNodes": ["pt-lab"]}]}), encoding="utf-8")
        if effects is not None:
            (root / "effects.json").write_text(json.dumps({"effects": effects}), encoding="utf-8")
        if capabilities is not None:
            (root / "capabilities.json").write_text(json.dumps(capabilities), encoding="utf-8")
        return root

    def found(self, root, phrase):
        return [m for m in self.problems(root) if phrase in m]

    KEYED = "questions with an answer key are asked without the instructions"
    ROUNDS = "a repeated question loses the instruction screens"
    SAME = "effects contrast arms whose prompts are identical"

    def test_the_regression_case_is_flagged(self):
        root = self.game_project(game(default0=True), effects=[effect("e_online_lab", "online", "lab")])
        keyed = self.found(root, self.KEYED)
        self.assertTrue(keyed and "m-instr1" in keyed[0], keyed)
        self.assertIn("lacks m-instr1, m-instr2", keyed[0])   # quiz 2 needs both parts' instructions
        self.assertNotIn("m-quiz1", keyed[0])                  # an earlier quiz is not an instruction
        rounds = self.found(root, self.ROUNDS)
        self.assertTrue(rounds and "'c'" in rounds[0] and "m-instr1" in rounds[0], rounds)
        same = self.found(root, self.SAME)
        self.assertTrue(same and "e_online_lab (online vs lab)" in same[0], same)
        self.assertTrue(self.found(root, "an answer that could not be read becomes a number"))

    def test_carried_screens_pass(self):
        root = self.game_project(game(carry=True))
        self.assertEqual(self.problems(root), [])

    def test_declared_repeats_and_not_carried_screens(self):
        # notCarried waives the later rounds, never the quiz that follows the instructions
        gone = {"notCarried": [{"screen": "m-instr1", "reason": "not visible in part 2", "evidenceIds": ["e-gone"]}]}
        root = self.game_project(game(), materials={"screenMemory": gone})
        self.assertEqual(self.found(root, self.ROUNDS), [])
        self.assertTrue(self.found(root, self.KEYED))
        # a declared repeat: the quiz prompt shows the rule sentence the paper prints there, not the whole screen
        rule = ("At the start of each round every group member receives 20 points. "
                "The points in the project are multiplied by 1.6 and shared equally among all four members.")
        repeat = {"repeats": [{"screen": "m-instr1", "text": rule, "evidenceIds": ["e-gone"]}], **gone}
        text = game().replace("before = screens(part) if CARRY else []",
                              "before = [%r] if part == 1 else [INSTR1, INSTR2]" % rule)
        root = self.game_project(text, materials={"screenMemory": repeat})
        self.assertEqual(self.found(root, self.KEYED), [])
        self.assertEqual(self.found(root, self.ROUNDS), [])
        bad = {"notCarried": [{"screen": "m-nowhere", "reason": "", "evidenceIds": ["e-none"]}]}
        found = self.problems(self.game_project(game(carry=True), materials={"screenMemory": bad}))
        self.assertTrue(any("not a program.json material node" in m for m in found), found)
        self.assertTrue(any("`reason` is empty" in m for m in found), found)
        self.assertTrue(any("needs evidenceIds" in m for m in found), found)

    def test_identical_arms_need_the_effect_marked_not_testable(self):
        effects = [effect("e_online_lab", "online", "lab"), effect("e_label", "Online sample", "Laboratory sample"),
                   effect("e_node", "pt-online", "pt-lab")]
        root = self.game_project(game(carry=True), effects=effects)
        same = self.found(root, self.SAME)
        self.assertTrue(same and all(e in same[0] for e in ("e_online_lab", "e_label", "e_node")), same)
        caps = {"schemaVersion": 1, "run": {"excluded": [{"what": "Online versus lab", "reason": "population difference, "
                                                          "not a manipulation", "effects": [e["id"] for e in effects]}]}}
        self.assertEqual(self.problems(self.game_project(game(carry=True), effects=effects, capabilities=caps)), [])
        no_reason = copy.deepcopy(caps)
        no_reason["run"]["excluded"][0]["reason"] = ""
        self.assertTrue(self.found(self.game_project(game(carry=True), effects=effects, capabilities=no_reason), self.SAME))
        # a population difference the adapter writes into the prompt makes the arms differ
        persona = {"online": "You are taking part online from home.", "lab": "You are in a university laboratory."}
        self.assertEqual(self.problems(self.game_project(game(carry=True, persona=persona), effects=effects)), [])

    def test_multi_site_within_arm_effects_still_build(self):
        arms = ("us_gain", "us_loss", "uk_gain", "uk_loss")
        frame = {"us_gain": "200 people will be saved.", "uk_gain": "200 people will be saved.",
                 "us_loss": "400 people will die.", "uk_loss": "400 people will die."}
        conditions = [{"id": a, "label": a, "programNodes": ["c-" + a.split("_")[1], "site-" + a.split("_")[0]]}
                      for a in arms]
        effects = [effect("gain_vs_loss", "c-gain", "c-loss"), effect("us_gain_vs_loss", "us_gain", "us_loss"),
                   effect("us_vs_uk", "site-us", "site-uk")]
        root = self.game_project(game(carry=True, arms=arms, persona=frame), effects=effects, conditions=conditions)
        same = self.found(root, self.SAME)
        self.assertTrue(same and "us_vs_uk" in same[0], same)
        self.assertNotIn("gain_vs_loss", same[0])

    def test_older_builds_get_warnings(self):
        root = self.game_project(game(), effects=[effect("e_online_lab", "online", "lab")])
        (root / "package/x/task/replies.py").unlink()
        text = (root / "package/x/task/adapter.py").read_text(encoding="utf-8")
        shutil.copy2(BUILD / "package_files/replies.py", root / "package/x/task/reader.py")
        (root / "package/x/task/adapter.py").write_text(text.replace("from replies import", "from reader import"),
                                                         encoding="utf-8")
        report = check_validity.check(root)
        self.assertFalse(report["currentContract"])
        self.assertEqual(report["problems"], [])
        warned = " ".join(m for m, _ in report["warnings"])
        for phrase in (self.KEYED, self.ROUNDS, self.SAME):
            self.assertIn(phrase, warned)


class Rules(unittest.TestCase):
    """The pure rules on recorded calls."""
    TABLE = {"m-i": {"segments": ["a"], "position": 1, "actors": ["pt"]},
             "m-q": {"segments": ["b"], "position": 2, "actors": ["pt"]},
             "m-v1": {"segments": ["c"], "position": 3, "actors": ["pt"]},
             "m-v2": {"segments": ["d"], "position": 4, "actors": ["pt"]},
             "m-other": {"segments": ["e"], "position": 0, "actors": ["pt-b"]}}

    def test_rotating_stimuli_are_not_dropped_rules(self):
        calls = [{"q": ["r#1"], "k": False, "s": ["m-i", "m-v1"]}, {"q": ["r#1"], "k": False, "s": ["m-i", "m-v2"]},
                 {"q": ["r#1"], "k": False, "s": ["m-i", "m-v1"]}, {"q": ["r#1"], "k": False, "s": ["m-i", "m-v2"]}]
        self.assertEqual(prompt_context.round_gaps({"calls_meta": calls}, self.TABLE), [])
        calls.append({"q": ["r#1"], "k": False, "s": ["m-v1"]})
        self.assertEqual(prompt_context.round_gaps({"calls_meta": calls}, self.TABLE)[0][1:], ("r", ["m-i"]))

    def test_another_roles_screen_is_not_needed(self):
        calls = [{"q": ["q#1"], "k": True, "s": ["m-q"]}, {"q": ["c#1"], "k": False, "s": ["m-i", "m-other"]}]
        gaps = prompt_context.keyed_gaps({"calls_meta": calls}, self.TABLE)
        self.assertEqual([g[2] for g in gaps], [["m-i"]])

    def test_flow_order_follows_children_and_next(self):
        program = {"steps": [{"id": "b", "next": [{"to": "c"}]}, {"id": "root", "children": ["a", "b"]},
                             {"id": "c"}, {"id": "a"}]}
        order = prompt_context.flow_order(program)
        self.assertEqual(sorted(order, key=order.get), ["root", "a", "b", "c"])

    def test_runs_stopped_at_the_call_cap_never_prove_identical_arms(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        (root / "package/x/task").mkdir(parents=True)
        (root / "package/x/task/task.json").write_text(json.dumps({"conditions": [{"id": "a"}, {"id": "b"}]}))
        (root / "effects.json").write_text(json.dumps({"effects": [effect("a_vs_b", "a", "b")]}))
        runs = [{"arms": [arm], "calls": 600, "digest": "same", "capped": capped, "calls_meta": []}
                for arm in ("a", "b") for capped in [True]]
        found = []
        check_validity.screen_rules(root, root / "package/x", {}, runs, lambda m, f="": found.append(m))
        self.assertEqual(found, [])
        for r in runs:
            r["capped"] = False
        check_validity.screen_rules(root, root / "package/x", {}, runs, lambda m, f="": found.append(m))
        self.assertTrue(found and "a_vs_b (a vs b)" in found[0], found)

    def test_unread_defaults_are_found(self):
        path = Path(tempfile.mkdtemp()) / "adapter.py"
        self.addCleanup(shutil.rmtree, path.parent, True)
        path.write_text("v = page.value('c')\nx = v if v is not None else 0\ny = page.value('d') or 0\n"
                        "z = a.get('value', 0)\nok = v if v is not None else None\n", encoding="utf-8")
        self.assertEqual([n for n, _ in check_validity.unread_defaults(path)], [2, 3, 4])


class ExportHonoursExclusion(unittest.TestCase):
    def test_an_excluded_effect_is_not_ready_in_the_exported_results(self):
        sys.path.insert(0, str(REPO / "pack/skills/export/agent"))
        import study_core
        effects = {"effects": [effect("e_online_lab", "online", "lab"), effect("e_kept", "online", "lab")]}
        caps = {"run": {"excluded": [{"what": "x", "reason": "population difference, not a manipulation",
                                      "effects": ["e_online_lab"]}]}}
        study = type("S", (), {"caps": caps, "_modules": {}, "require_effects": lambda self: effects})()
        sessions = [{"arm": a, "c": v} for a, v in (("online", 1), ("online", 3), ("lab", 2), ("lab", 6))]
        blocks = {b["effectId"]: b for b in study_core.Study.effect_results(study, sessions, source="agent")}
        self.assertEqual(blocks["e_online_lab"]["status"], "not_ready")
        self.assertIn("not testable by the replay: population difference", blocks["e_online_lab"]["reason"])
        self.assertEqual(blocks["e_online_lab"]["source"], "agent")
        self.assertNotEqual(blocks["e_kept"].get("reason", ""), blocks["e_online_lab"]["reason"])


if __name__ == "__main__":
    unittest.main()
