"""Who the AI participants are (skills/run/participants.py) and how app_run uses it: the spec's validation,
deterministic draws, the paper's sample as the default (unstated attributes left out), think-then-answer
prompts and replies, and refusal when the file is not the approved one. Fake models only."""
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

RUNTIME = Path(__file__).resolve().parents[1]
PACK = RUNTIME.parent
RUN = PACK / "skills" / "run"
SAMPLE = PACK.parent / "app" / "resources" / "protocol-sample"
sys.path.insert(0, str(RUN))
import participants as P  # noqa: E402

CUSTOM = {"version": 1, "mode": "custom", "groups": [
    {"id": "students", "weight": 3, "persona": "A first-year psychology student.",
     "attributes": {"age": {"min": 18, "max": 22}, "gender": {"woman": 0.6, "man": 0.4}, "country": "United States"}},
    {"id": "retirees", "weight": 1, "persona": "A retired schoolteacher.",
     "attributes": {"age": {"mean": 70, "sd": 4}, "occupation": ["retired teacher"]}}]}
PROTOCOL = {"id": "t", "meta": {}, "arms": [{"id": "armalpha", "label": "Study 1"}, {"id": "armbeta", "label": "Study 1"},
                                            {"id": "x", "runnable": False}]}


def opaque(seed, arm, i):
    return "%s-%s-%s" % (seed, arm, i)


class SpecValidation(unittest.TestCase):
    def test_good_specs(self):
        self.assertEqual(P.validate({})["mode"], "paper")
        self.assertEqual(P.validate({"mode": "blank"}), {"version": 1, "mode": "blank"})
        v = P.validate(dict(CUSTOM, system="You are {{persona}}, aged {{age}}."))
        self.assertEqual(v["groups"][0]["attributes"]["country"], {"United States": 1})
        self.assertEqual(v["groups"][1]["attributes"]["occupation"], {"retired teacher": 1})

    def test_bad_specs_say_what_is_wrong(self):
        bad = [
            ({"mode": "people"}, "mode"),
            ({"mode": "paper", "colour": 1}, "unknown field"),
            ({"version": 2}, "version"),
            ({"mode": "custom"}, "groups"),
            ({"mode": "custom", "groups": [{"id": "g", "weight": 0, "persona": "x"}]}, "weight"),
            ({"mode": "custom", "groups": [{"id": "g"}]}, "persona or attributes"),
            ({"mode": "custom", "groups": [{"id": "g", "persona": "x"}, {"id": "g", "persona": "y"}]}, "unique"),
            ({"mode": "custom", "groups": [{"persona": "x", "attributes": {"age": {"min": 30, "max": 20}}}]}, "above"),
            ({"mode": "custom", "groups": [{"persona": "x", "attributes": {"age": {"mean": 30}}}]}, "mean and sd"),
            ({"mode": "custom", "groups": [{"persona": "x", "attributes": {"height": 3}}]}, "attributes may hold"),
            ({"mode": "paper", "groups": []}, "groups are for mode custom"),
            ({"mode": "blank", "system": "hi"}, "blank"),
            ({"system": "You are {{name}}"}, "placeholder"),
            ({"mode": "custom", "groups": [{"persona": "x" * (P.MAX_PERSONA + 1)}]}, "longer"),
        ]
        for spec, why in bad:
            with self.assertRaises(P.SpecError, msg=spec) as cm:
                P.validate(spec)
            self.assertIn(why, str(cm.exception), spec)

    def test_load_hashes_the_file_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(P.load(Path(d)), ({"version": 1, "mode": "paper"}, None))
            (Path(d) / "simulation").mkdir()
            raw = json.dumps(CUSTOM).encode()
            (Path(d) / P.SPEC_PATH).write_bytes(raw)
            spec, sha = P.load(Path(d))
            self.assertEqual(sha, hashlib.sha256(raw).hexdigest())
            self.assertEqual(spec["mode"], "custom")
            (Path(d) / P.SPEC_PATH).write_text("{not json", encoding="utf-8")
            with self.assertRaises(P.SpecError):
                P.load(Path(d))


class Sampling(unittest.TestCase):
    def test_largest_remainder(self):
        self.assertEqual(P.split(10, [3, 7]), [3, 7])
        self.assertEqual(P.split(5, [1, 1, 1]), [2, 2, 1])
        self.assertEqual(P.split(2, [1, 1, 1]), [1, 1, 0])
        self.assertEqual(sum(P.split(7, [0.2, 0.5, 0.3])), 7)

    def test_draws_are_deterministic_and_split_each_condition(self):
        spec = P.validate(CUSTOM)
        plan = {"armalpha": 8, "armbeta": 8}
        one = P.people(spec, "sha1", PROTOCOL, None, plan, {}, [1], opaque)
        self.assertEqual(one, P.people(spec, "sha1", PROTOCOL, None, plan, {}, [1], opaque), "a resumed run gets the same people")
        self.assertNotEqual(one, P.people(spec, "sha1", PROTOCOL, None, plan, {}, [2], opaque), "another seed, other people")
        for arm in plan:
            groups = [p["group"] for (oid, _), p in one.items() if oid.split("-")[1] == arm]
            self.assertEqual((groups.count("students"), groups.count("retirees")), (6, 2), "3:1 in every condition")
        for (oid, member), p in one.items():
            a = p["attributes"]
            self.assertEqual(member, "p1")
            if p["group"] == "students":
                self.assertTrue(18 <= a["age"] <= 22 and a["gender"] in ("woman", "man") and a["country"] == "United States")
                self.assertIn("A first-year psychology student.", p["persona"])
            else:
                self.assertTrue(60 <= a["age"] <= 80 and "gender" not in a, a)
            self.assertNotIn("arm", json.dumps(p), "the condition is never named")

    def test_group_members(self):
        proto = {"arms": [{"id": "g", "group_size": 3}]}
        ppl = P.people(P.validate(CUSTOM), "s", proto, None, {"g": 2}, {"g": 3}, [1], opaque)
        self.assertEqual(sorted(ppl), [("1-g-%d" % i, "p%d" % m) for i in range(2) for m in (1, 2, 3)])


class PaperDefault(unittest.TestCase):
    def program(self, fields):
        return {"studies": [{"id": "s1", "title": "Study 1", "type": "empirical"}],
                "nodes": [{"id": "pp", "kind": "participants", "studyIds": ["s1"], "fields": fields}]}

    def field(self, fid, value, state="confirmed"):
        return {"id": fid, "label": fid, "value": value, "origin": "reported", "state": state, "evidenceIds": []}

    def test_printed_figures_are_drawn(self):
        prog = self.program([self.field("population", "120 undergraduates at a US university (M age = 20.4, SD = 1.8; 62% female)."),
                             self.field("n-analysed", 120)])
        prof = P.paper_profile({"arms": [{"id": "s1"}]}, prog, {"id": "s1"})
        self.assertEqual(prof["description"], "120 undergraduates at a US university")
        self.assertEqual(prof["age"], {"mean": 20.4, "sd": 1.8})
        self.assertAlmostEqual(prof["gender"]["woman"], 0.62)
        ppl = P.people({"mode": "paper"}, None, {"arms": [{"id": "s1"}]}, prog, {"s1": 40}, {}, [1], opaque)
        ages = [p["attributes"]["age"] for p in ppl.values()]
        self.assertTrue(all(16 <= a <= 25 for a in ages) and len(set(ages)) > 1, ages)
        self.assertIn("whom the paper describes as: 120 undergraduates at a US university", next(iter(ppl.values()))["persona"])
        self.assertIn("Sample-matched: 120 undergraduates at a US university, age ~20.4, 62% women",
                      P.summary({"mode": "paper"}, {"arms": [{"id": "s1"}]}, prog))

    def test_unstated_attributes_are_omitted(self):
        prog = self.program([self.field("population", "Visitors to a public park in Manhattan."),
                             self.field("age", None, "missing"), self.field("compensation", "a candy bar")])
        ppl = P.people({"mode": "paper"}, None, {"arms": [{"id": "s1"}]}, prog, {"s1": 5}, {}, [1], opaque)
        for p in ppl.values():
            self.assertEqual(p["attributes"], {})
            self.assertNotRegex(p["persona"], r"years old|year-old|woman|\bman\b|gender|mean age")
            self.assertIn("Visitors to a public park in Manhattan", p["persona"])
        nothing = P.people({"mode": "paper"}, None, {"arms": [{"id": "s1"}]}, None, {"s1": 1}, {}, [1], opaque)
        self.assertEqual({k: v for k, v in next(iter(nothing.values())).items() if k in ("group", "attributes", "persona")},
                         {"group": None, "attributes": {}, "persona": ""})

    def test_a_mean_alone_is_stated_not_drawn(self):
        proto = {"meta": {"sample": {"population": "Amazon Mechanical Turk workers (Study 1: 228 men, 171 women, mean age 32.3; "
                                                   "Study 2: 230 men, 168 women, 32.6)"}},
                 "arms": [{"id": "s1", "label": "Study 1: x"}, {"id": "s2", "label": "Study 2: y"}]}
        p1 = P.paper_profile(proto, None, proto["arms"][0])
        self.assertEqual(p1["description"], "Amazon Mechanical Turk workers")
        self.assertEqual(p1["age_mean_only"], 32.3)
        self.assertAlmostEqual(p1["gender"]["woman"], 171 / 399)
        p2 = P.paper_profile(proto, None, proto["arms"][1])
        self.assertNotIn("age_mean_only", p2, "study 2's '32.6' is not labelled as an age")
        self.assertAlmostEqual(p2["gender"]["woman"], 168 / 398)
        person = next(iter(P.people({"mode": "paper"}, None, proto, None, {"s1": 1}, {}, [1], opaque).values()))
        self.assertNotIn("age", person["attributes"])
        self.assertIn("mean age was 32.3", person["persona"])


class Gender(unittest.TestCase):
    """Review item 1: only printed categories, at printed shares; an undescribed rest is left unstated."""

    def test_only_printed_categories(self):
        self.assertEqual(P.stats("62% female")["gender"], {"woman": 0.62, None: 0.38})
        g = P.stats("48% women, 50% men and 2% nonbinary")["gender"]
        self.assertEqual(g, {"woman": 0.48, "man": 0.5, "nonbinary person": 0.02})
        g = P.stats("N = 100 (40 women, 55 men)")["gender"]
        self.assertAlmostEqual(g["woman"], 0.40)
        self.assertAlmostEqual(g["man"], 0.55)
        self.assertAlmostEqual(g[None], 0.05)
        self.assertNotIn("gender", P.stats("171 women took part"), "one count without an N states no share")

    def test_the_unstated_rest_gets_no_gender(self):
        proto = {"meta": {"sample": "Undergraduates (62% female)."}, "arms": [{"id": "s1"}]}
        ppl = P.people({"mode": "paper"}, None, proto, None, {"s1": 200}, {}, [1], opaque)
        genders = [p["attributes"].get("gender") for p in ppl.values()]
        self.assertEqual(set(genders), {"woman", None}, "never a man: the paper only says 62% female")
        self.assertTrue(40 < genders.count(None) < 120)
        for p in ppl.values():
            if "gender" not in p["attributes"]:
                self.assertNotRegex(p["persona"], r"\b(?:man|woman)\b")
        self.assertIn("You are a nonbinary person.", P.persona_text(None, {"gender": "nonbinary person"}))


class OwnStudyNoConditions(unittest.TestCase):
    """Review item 2: each participant gets its own study's sample, and no condition is ever named."""
    PROTO = {"meta": {"sample": "Study 1 participants were undergraduates at a US university. Study 2 participants "
                                "were hospital nurses in Germany."},
             "arms": [{"id": "s1-reminder", "label": "Study 1: Reminder"}, {"id": "s1-control", "label": "Study 1: Control"},
                      {"id": "s2-reminder", "label": "Study 2: Reminder"}]}
    PROGRAM = {"studies": [{"id": "s1", "title": "Study 1", "type": "empirical"}, {"id": "s2", "title": "Study 2", "type": "empirical"}],
               "nodes": [{"id": "c1", "kind": "condition", "title": "Gratitude prime", "fields": []},
                         {"id": "pp", "kind": "participants", "studyIds": ["s1"], "fields": [
                             {"id": "population", "label": "Population", "state": "confirmed",
                              "value": "Students assigned to the gratitude prime or the control group. Members of a sports club."}]}]}

    def test_each_study_its_own_sample(self):
        a1, _, a3 = self.PROTO["arms"]
        self.assertIn("undergraduates", P.paper_profile(self.PROTO, None, a1)["description"])
        self.assertNotIn("nurses", P.paper_profile(self.PROTO, None, a1)["description"])
        self.assertIn("nurses", P.paper_profile(self.PROTO, None, a3)["description"])
        self.assertNotIn("undergraduates", P.paper_profile(self.PROTO, None, a3)["description"])

    def test_no_condition_id_or_label_reaches_a_system_prompt(self):
        proto = {"meta": {}, "arms": self.PROTO["arms"]}
        names = P.condition_names(proto, self.PROGRAM)
        self.assertIn("Gratitude prime", names)
        ppl = P.people({"mode": "paper"}, None, proto, self.PROGRAM, {a["id"]: 3 for a in proto["arms"]}, {}, [1], opaque)
        self.assertTrue(any("Members of a sports club" in p["persona"] for p in ppl.values()))
        for p in ppl.values():
            system = P.system_text(p["persona"])
            for a in proto["arms"]:
                for n in (a["id"], a["label"], a["label"].split(":")[1].strip(), "gratitude prime", "control group"):
                    self.assertNotIn(n.lower(), system.lower())

    def test_a_custom_persona_naming_a_condition_is_refused(self):
        spec = P.validate({"mode": "custom", "groups": [{"persona": "You were given the gratitude prime."}]})
        self.assertIn("Gratitude prime", P.condition_problem(spec, self.PROTO, self.PROGRAM))
        self.assertIsNone(P.condition_problem(P.validate(CUSTOM), self.PROTO, self.PROGRAM))


class Budget(unittest.TestCase):
    """Review item 10: one re-ask per page and carried free text are reserved."""

    def test_headroom(self):
        import budget
        self.assertEqual(budget.with_headroom(10, 1000), (15, 1500), "the 1.5x margin includes the re-asks")
        page = {"screen": {"responses": [{"id": "why", "kind": "text"}, {"id": "pick", "kind": "choice"}]}}
        self.assertEqual(budget.text_ids(page), {"why"})
        state = {"answered": [{"response": "pick", "value": "Agree"}, {"response": "why", "value": "a long essay"},
                              {"response": "pick2", "value": "Other", "text": "x"}]}
        self.assertEqual(budget.carried_text(state, {"why"}), 2 * budget.CARRY_BYTES)
        self.assertEqual(budget.carried_text({}, {"why"}), 0)


class CheckCommand(unittest.TestCase):
    def test_check_reports_a_summary_or_the_problem(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "protocol.json").write_text(json.dumps(PROTOCOL), encoding="utf-8")
            r = P.check(d)
            self.assertTrue(r["ok"] and r["mode"] == "paper" and r["sha256"] is None, r)
            (d / "simulation").mkdir()
            (d / P.SPEC_PATH).write_text(json.dumps(CUSTOM), encoding="utf-8")
            r = P.check(d)
            self.assertEqual(r["summary"], "Custom: 2 groups by weight: students (3), retirees (1)")
            (d / P.SPEC_PATH).write_text(json.dumps({"mode": "custom", "groups": [{"persona": "é" * 1000}]}), encoding="utf-8")
            self.assertIn("too long", P.check(d)["problem"])
            (d / P.SPEC_PATH).write_text(json.dumps({"mode": "custom", "groups": [{"persona": "You saw the armalpha screen."}]}), encoding="utf-8")
            self.assertIn("names the condition", P.check(d)["problem"])
            (d / P.SPEC_PATH).write_text('{"mode": "x"}', encoding="utf-8")
            self.assertIn("mode must be", P.check(d)["problem"])


class PromptAndReply(unittest.TestCase):
    def test_system_prompt(self):
        s = P.system_text("You are a 20-year-old woman.")
        self.assertTrue(s.startswith("You are a 20-year-old woman.\n\n" + P.TAKE_PART))
        self.assertIn("You are an 18-year-old man.", P.persona_text(None, {"age": 18, "gender": "man"}))
        self.assertIn("```json", s)
        o = P.system_text("A nurse.", "Play {{persona}} ({{age}}, {{gender}}).", {"age": 40, "gender": "man"})
        self.assertTrue(o.startswith("Play A nurse. (40, man).\n\n"))
        self.assertTrue(o.endswith(P.THINK_FORMAT), "the reply format is always appended")
        self.assertTrue(P.fits_budget(P.system_text("x" * 1000)))
        self.assertFalse(P.fits_budget(P.system_text("é" * 1000)), "JSON-escaped bytes count, as the relay counts them")

    def test_reasoning_before_the_fenced_json(self):
        reply = 'Honestly {"r1": "o9"} looks like a trap to me, so I pick the first {one}.\n```json\n{"r1": "o1", "r2": {"code": "o3", "text": "x"}}\n```\n'
        reasoning, answers = P.split_reply(reply)
        self.assertEqual(answers, {"r1": "o1", "r2": {"code": "o3", "text": "x"}}, "braces in the reasoning are never the answer")
        self.assertTrue(reasoning.startswith("Honestly") and reasoning.endswith("{one}."))
        self.assertEqual(P.parse_answer('I like it.\n```json\n{"a": 1}\n```\nmore\n```json\n{"a": 2}\n```'), {"a": 2}, "the last block")
        self.assertEqual(P.parse_answer('Fine.\n```json\n{"t": "a { b } c {", "u": "}"}\n```'), {"t": "a { b } c {", "u": "}"},
                         "a literal brace inside a JSON string")
        self.assertEqual(P.parse_answer('{"q": {"code": "o1", "text": "t"}}'), {"q": {"code": "o1", "text": "t"}}, "a bare object")
        self.assertEqual(P.parse_answer("  {}  "), {})
        for bad in ['```json\n{"a": 1}\n```\nActually, make that o2.',        # text after the answer
                    'Not sure {at all}. {"q": 5}',                             # an object inside prose, no fence
                    'I pick {"q": "o1"} as my answer.',
                    '```json\n{"a": 1}\n```\n```\n{"a": 2}\n```',          # the last block is not a json block
                    '```json\n{"a": 1} {"b": 2}\n```',                       # two objects in the block
                    '```json\n["o1"]\n```', "I would rather not say."]:
            with self.assertRaisesRegex(ValueError, "no JSON object", msg=bad):
                P.parse_answer(bad)


class AppRunUses(unittest.TestCase):
    def setUp(self):
        import app_run
        self.A = app_run
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "protocol.json").write_text(json.dumps(PROTOCOL), encoding="utf-8")
        self.plan = {"protocolSha256": hashlib.sha256((self.tmp / "protocol.json").read_bytes()).hexdigest()}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_a_changed_or_new_participants_file_is_refused(self):
        A = self.A
        A.check_approval(self.tmp, self.tmp, dict(self.plan, participantsSha256=None), {})
        (self.tmp / "simulation").mkdir()
        (self.tmp / P.SPEC_PATH).write_text(json.dumps(CUSTOM), encoding="utf-8")
        with self.assertRaisesRegex(A.Refused, "participants.json changed after approval"):
            A.check_approval(self.tmp, self.tmp, dict(self.plan, participantsSha256=None), {})
        sha = hashlib.sha256((self.tmp / P.SPEC_PATH).read_bytes()).hexdigest()
        A.check_approval(self.tmp, self.tmp, dict(self.plan, participantsSha256=sha), {})
        (self.tmp / P.SPEC_PATH).write_text(json.dumps(dict(CUSTOM, note="edited")), encoding="utf-8")
        with self.assertRaisesRegex(A.Refused, "changed after approval"):
            A.check_approval(self.tmp, self.tmp, dict(self.plan, participantsSha256=sha), {})
        self.assertIn("participantsSha256", A.PLAN_KEYS)

    def test_images_only_where_the_route_and_the_model_take_them(self):
        A = self.A
        self.assertEqual(A.image_choice({"images": True}, "anthropic/claude-haiku-5.5")[0], True)
        self.assertEqual(A.image_choice({"images": True}, "anthropic/claude-opus-5")[0], True)
        on, note = A.image_choice({"images": True}, "deepseek/deepseek-v4.1-flash")
        self.assertFalse(on)
        self.assertIn("not known to accept pictures", note)
        self.assertFalse(A.image_choice({}, "anthropic/claude-sonnet-5.5")[0])
        msgs = [{"role": "user", "content": [{"type": "text", "text": "p"}, {"type": "image_url", "image_url": {"url": "https://x/y.png"}},
                                             {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]}]
        self.assertEqual(len(A.local_images_only(msgs)[0]["content"]), 2, "remote pictures never go to the relay")
        self.assertEqual(A.local_images_only([{"role": "user", "content": msgs[0]["content"][:2]}])[0]["content"], "p")

    def state(self, srcs=("asset:ff",), qid="q1"):
        return {"step": 1, "page": 1, "screen": {"items": [{"id": "i%d" % i, "src": s} for i, s in enumerate(srcs)],
                                                 "responses": [{"id": qid, "kind": "single", "prompt": "Pick",
                                                                "options": [{"code": "o1", "label": "A"}, {"code": "o2", "label": "B"}]}]}}

    def ctx(self, files, participant="abc"):
        class Ctx:
            member, note = "p1", None
        c = Ctx()
        c.participant = participant
        c.asset_path = lambda ref: files.get(ref)
        return c

    def picture(self, name, data):
        path = self.tmp / name
        path.write_bytes(data)
        digest = hashlib.sha256(data).hexdigest()
        return path, digest, "asset:" + digest[:16]

    def test_participant_f_sends_persona_images_and_keeps_the_reasoning(self):
        A = self.A
        sent = []

        def complete(messages):
            sent.append(messages)
            return 'Seems fine to me.\n```json\n{"q1": "o2"}\n```'
        img, digest, ref = self.picture("pic.png", b"\x89PNG\r\n\x1a\nfake")
        people = {("abc", "p1"): {"group": None, "attributes": {}, "persona": "", "system": P.system_text("You are a nurse.")}}
        pics = A.Pictures({"pic.png": digest})
        f = A.participant_f(complete, people, {"mode": "paper"}, True, "sent", "Sample-matched: nurses", pictures=pics)
        ctx = self.ctx({ref: str(img)})
        self.assertEqual(f(self.state([ref]), ctx), {"q1": "o2"})
        system, user = sent[0]
        self.assertTrue(system["content"].startswith("You are a nurse."))
        self.assertEqual([p["type"] for p in user["content"]], ["text", "image_url"])
        self.assertTrue(user["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertEqual(ctx.note["reasoning"], "Seems fine to me.")
        self.assertEqual(ctx.note["images_sent"], 1)
        self.assertNotIn("base64", json.dumps(ctx.note), "the picture itself is never stored")
        self.assertEqual(pics.record(), {"pages_with_pictures": 1, "pages_text_only_over_caps": 0, "pictures_sent_sha256": [digest]})
        with self.assertRaises(RuntimeError):
            f(self.state([ref]), self.ctx({ref: str(img)}, participant="zzz"))

    def test_item6_a_restored_study_keeps_only_page_question_ids_and_no_reply(self):
        A = self.A

        def complete(messages):
            return 'It said "the held words here".\n```json\n{"q1": "o2", "held passage": "copied text", "q9": 1}\n```'
        people = {("abc", "p1"): {"group": None, "attributes": {}, "persona": "", "system": P.system_text("")}}
        f = A.participant_f(complete, people, {"mode": "paper"}, False, "no", "s", keep_text=False)
        ctx = self.ctx({})
        self.assertEqual(f(self.state(()), ctx), {"q1": "o2"}, "keys that are not this page's questions are dropped")
        self.assertEqual(set(ctx.note), {"reply_chars"}, "no reply text is kept")
        blank = A.participant_f(lambda m: '{"q1": "o1", "junk": "x"}', people, {"mode": "blank"}, False, "no", "s", keep_text=False)
        self.assertEqual(blank(self.state(()), self.ctx({})), {"q1": "o1"})

    def test_item6_restored_wording_is_redacted_in_stored_records(self):
        A = self.A
        held = "The quick brown fox jumps over the lazy dog while the farmer watches from the old red barn."
        projection = {"distribution": {"held": {"h1": {"path": "/stages/s/text"}, "h2": {"path": "/stages/p/value"}}},
                      "stages": {"s": {"text": "░" * len(held)}, "p": {"value": {"src": "x", "lines": ["░" * 10]}}}}
        restored = {"stages": {"s": {"text": held}, "p": {"value": {"src": "x", "lines": ["Short line"]}}}}
        self.assertEqual(A.held_texts(projection, restored), [held, "Short line"])
        red = A.Redactor(A.held_texts(projection, restored))
        quoted = held.replace(" while ", "\n  while  ")   # the same wording, other whitespace
        answer = "Back in 2026: " + quoted + " (2026), that is all."
        out = red.text(answer)
        self.assertTrue(out.startswith("Back in 2026: ") and out.endswith(" (2026), that is all."), out)
        self.assertNotIn("fox", out)
        self.assertIn("░" * 20, out)
        self.assertEqual(red.text(held.upper()), held.upper(), "case is kept: only the exact wording matches")
        self.assertEqual(red.text("A short reply about a fox and a dog."), "A short reply about a fox and a dog.")
        self.assertEqual(red.text("Order 2026-11-26 12:00, ref 4417-2026-AB, code x9"), "Order 2026-11-26 12:00, ref 4417-2026-AB, code x9")
        row = red.row({"opaque_id": held, "step": 3, "answers": {held[:20]: held, "q2": {"code": "o1", "text": held}, "q3": ["o1"]},
                       "note": {"id": held, "status": held}})
        self.assertEqual((row["opaque_id"], row["step"], row["answers"]["q2"]["code"], row["answers"]["q3"]), (held, 3, "o1", ["o1"]),
                         "structural fields at known places are left alone")
        self.assertIn(held[:20], row["answers"], "question ids as keys are left alone")
        for v in (row["answers"][held[:20]], row["answers"]["q2"]["text"], row["note"]["id"], row["note"]["status"]):
            self.assertNotIn("fox", v, "a value under a key named id or status elsewhere is still free text")
        answer = "I remember: " + held + " That is all."
        path = A._RedactingPath(self.tmp / "steps.jsonl", red)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"answers": {"q1": answer, "q2": "o1"}}) + "\n")
        row = json.loads((self.tmp / "steps.jsonl").read_text(encoding="utf-8"))
        self.assertNotIn("fox", row["answers"]["q1"])
        self.assertEqual(row["answers"]["q2"], "o1")
        self.assertTrue(path.exists() and str(path) == str(self.tmp / "steps.jsonl"))

    def test_item7_declared_picture_digests_and_changes_during_the_run(self):
        A = self.A
        img, digest, ref = self.picture("a.png", b"\x89PNG\r\n\x1a\nAAA")
        protocol = {"stages": {"s": {"content": [{"value": {"src": "a.png", "sha256": digest}}, {"value": {"src": "https://x/y.png"}}]}}}
        self.assertEqual(A.picture_digests(protocol, self.tmp), {"a.png": digest})
        protocol["stages"]["s"]["content"][0]["value"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(A.Refused, "not the one the study declares"):
            A.picture_digests(protocol, self.tmp)
        pics = A.Pictures({"a.png": digest})
        img.write_bytes(b"\x89PNG\r\n\x1a\nCHANGED")
        with self.assertRaisesRegex(RuntimeError, "changed during the run"):
            pics.page(self.state([ref]), self.ctx({ref: str(img)}), 100)

    def test_item8_the_full_reply_is_parsed_once_not_the_excerpt(self):
        A = self.A
        long = "Let me think. " + "very " * 1200 + "long.\n```json\n{\"q1\": \"o1\"}\n```"
        self.assertGreater(len(long), 4000)
        people = {("abc", "p1"): {"group": None, "attributes": {}, "persona": "", "system": P.system_text("")}}
        f = A.participant_f(lambda m: long, people, {"mode": "paper"}, False, "no", "s")
        ctx = self.ctx({})
        self.assertEqual(f(self.state(()), ctx), {"q1": "o1"})
        self.assertEqual(len(ctx.note["reply"]), 4000, "the stored reply is only an excerpt")
        self.assertTrue(ctx.note["reasoning"].startswith("Let me think."))

    def test_item9_a_page_over_the_caps_goes_text_only_and_blank_is_text_only(self):
        A = self.A
        sent = []

        def complete(messages):
            sent.append(messages[-1]["content"])
            return '```json\n{"q1": "o1"}\n```'
        people = {("abc", "p1"): {"group": None, "attributes": {}, "persona": "", "system": P.system_text("")}}
        files, pinned, refs = {}, {}, []
        for i in range(A.MAX_IMAGES + 1):
            path, digest, ref = self.picture("p%d.png" % i, b"\x89PNG" + bytes([i]) * 10)
            files[ref], pinned[path.name], refs = str(path), digest, refs + [ref]
        pics = A.Pictures(pinned)
        f = A.participant_f(complete, people, {"mode": "paper"}, True, "sent", "s", pictures=pics)
        ctx = self.ctx(files)
        f(self.state(refs), ctx)
        self.assertIsInstance(sent[-1], str, "nine pictures: the page goes text only")
        self.assertIn("more than", ctx.note["images_skipped"])
        big, bd, bref = self.picture("big.png", b"\x89PNG" + b"x" * 800_000)
        pics2 = A.Pictures({"big.png": bd})
        g = A.participant_f(complete, people, {"mode": "paper"}, True, "sent", "s", pictures=pics2)
        ctx2 = self.ctx({bref: str(big)})
        g(self.state([bref]), ctx2)
        self.assertIsInstance(sent[-1], str)
        self.assertIn("over", ctx2.note["images_skipped"])
        self.assertEqual(pics.record()["pages_text_only_over_caps"] + pics2.record()["pages_text_only_over_caps"], 2)
        blank = A.participant_f(complete, people, {"mode": "blank"}, True, "sent", "s", pictures=pics)
        blank(self.state(refs[:1]), self.ctx(files))
        self.assertEqual([p["type"] for p in sent[-1]], ["text", "image_url"], "blank mode keeps the route's pictures")
        blank(self.state(refs), self.ctx(files))
        self.assertIsInstance(sent[-1], str, "and the same caps")

    def test_item4_program_is_pinned_and_participants_are_read_back_on_resume(self):
        A = self.A
        (self.tmp / "program.json").write_text('{"studies": [], "nodes": []}', encoding="utf-8")
        prog = hashlib.sha256((self.tmp / "program.json").read_bytes()).hexdigest()
        plan = dict(self.plan, participantsSha256=None, programSha256=prog, perArm=2, seeds=[1], arms=None)
        A.check_approval(self.tmp, self.tmp, plan, {})
        with self.assertRaisesRegex(A.Refused, "program.json changed after approval"):
            A.check_approval(self.tmp, self.tmp, dict(plan, programSha256="0" * 64), {})
        out = self.tmp / "artifacts" / "simulations" / "r1"
        sys.path.insert(0, str(RUNTIME / "hsenv"))   # run_study imports the engine
        who = A.participants_for(out, self.tmp, plan, None, False)
        lines = (out / "participants.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 4)
        first = json.loads(lines[0])
        self.assertEqual(set(first), {"opaque_id", "member", "group", "attributes", "persona", "spec_sha256"})
        tampered = dict(first, attributes={"age": 99}, persona="A person drawn when the run started.")
        (out / "participants.jsonl").write_text("\n".join([json.dumps(tampered)] + lines[1:3]) + "\n", encoding="utf-8")
        again = A.participants_for(out, self.tmp, plan, None, False)
        person = again["people"][(first["opaque_id"], first["member"])]
        self.assertEqual(person["attributes"], {"age": 99}, "a resumed run reads its people back")
        self.assertTrue(person["system"].startswith("A person drawn when the run started."))
        after = (out / "participants.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(after[0], json.dumps(tampered), "rows of started participants are never rewritten")
        self.assertEqual(len(after), 4, "only the missing participant is appended")
        self.assertEqual(again["info"]["programSha256"], prog)
        self.assertIn("programSha256", A.PLAN_KEYS)

    def test_item11_upgrades_say_what_to_do(self):
        A = self.A
        A.check_approval(self.tmp, self.tmp, dict(self.plan), {})   # no participants file, no key: fine
        (self.tmp / "program.json").write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(A.Refused, "press Run simulation again"):
            A.check_approval(self.tmp, self.tmp, dict(self.plan), {})   # a plan from before this version
        out = self.tmp / "old-run"
        out.mkdir()
        (out / "run.json").write_text(json.dumps({"f": {"spec": {"kind": "llm"}}}), encoding="utf-8")
        with self.assertRaisesRegex(A.Refused, r"^This run was started with an earlier version of the app; start a new run\.$"):
            A.check_resumable(out)
        (out / "run.json").write_text(json.dumps({"f": {"spec": {"kind": "llm", "participants": {"mode": "paper"}}}}), encoding="utf-8")
        A.check_resumable(out)
        (out / "participants.jsonl").write_text(json.dumps({"opaque_id": "x", "member": "p1", "group": None, "attributes": {}}) + "\n", encoding="utf-8")
        plan = dict(self.plan, participantsSha256=None, programSha256=hashlib.sha256(b"{}").hexdigest(), perArm=1, seeds=[1], arms=None)
        sys.path.insert(0, str(RUNTIME / "hsenv"))
        with self.assertRaisesRegex(A.Refused, "start a new run"):
            A.participants_for(out, self.tmp, plan, None, False)


@unittest.skipUnless(SAMPLE.is_dir(), "needs the app's protocol sample")
class EndToEnd(unittest.TestCase):
    """main_run in the trusted layout (code/hsenv, code/skills/run) with a fake model, in a subprocess."""

    def test_custom_participants_run(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            code = tmp / "code"
            shutil.copytree(RUNTIME / "hsenv", code / "hsenv", ignore=shutil.ignore_patterns("__pycache__"))
            shutil.copytree(PACK / "artifact-kit", code / "artifact-kit", ignore=shutil.ignore_patterns("__pycache__"))
            (code / "skills" / "run").mkdir(parents=True)
            for f in RUN.glob("*.py"):
                shutil.copy(f, code / "skills" / "run")
            project = tmp / "project"
            shutil.copytree(SAMPLE, project)
            (project / ".humanstudy").mkdir(exist_ok=True)
            (project / "simulation").mkdir()
            (project / P.SPEC_PATH).write_text(json.dumps(CUSTOM), encoding="utf-8")
            run = project / "artifacts" / "simulations" / "r1"
            run.mkdir(parents=True)
            sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()  # noqa: E731
            plan = {"route": "protocol", "protocolSha256": sha(project / "protocol.json"), "perArm": 4, "arms": ["s1"],
                    "seeds": [1], "temperature": 1.0, "participantsSha256": sha(project / P.SPEC_PATH),
                    "programSha256": sha(project / "program.json"), "images": False}
            (run / "plan.json").write_text(json.dumps(plan), encoding="utf-8")
            driver = tmp / "drive.py"
            driver.write_text(
                "import json, re, sys\nsys.path.insert(0, sys.argv[1])\nimport app_run\nfrom pathlib import Path\n"
                "systems = []\n"
                "def complete(m):\n"
                "    systems.append(m[0]['content'])\n"
                "    q = re.findall(r'Question (r[0-9]+) \\(', m[-1]['content'])\n"
                "    return 'Hmm {weird}. I go with the first.\\n```json\\n' + json.dumps({q[-1]: 'o1'} if q else {}) + '\\n```'\n"
                "meta = app_run.main_run(Path(sys.argv[2]), Path(sys.argv[3]), complete=complete, model='anthropic/claude-haiku-5.5')\n"
                "print(json.dumps({'status': meta['status'], 'who': meta['participants_spec'], 'systems': sorted(set(systems))}))\n",
                encoding="utf-8")
            r = subprocess.run([sys.executable, "-I", str(driver), str(code / "skills" / "run"), str(run), str(project)],
                               capture_output=True, text=True, timeout=600)
            self.assertEqual(r.returncode, 0, r.stderr[-2000:])
            out = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertEqual(out["status"], "done", r.stdout[-2000:])
            self.assertEqual(out["who"]["mode"], "custom")
            self.assertEqual(out["who"]["sha256"], plan["participantsSha256"])
            self.assertTrue(out["who"]["summary"].startswith("Custom: 2 groups"))
            self.assertTrue(any(s.startswith("A first-year psychology student.") for s in out["systems"]))
            self.assertTrue(any(s.startswith("A retired schoolteacher.") for s in out["systems"]))
            rows = [json.loads(x) for x in (run / "participants.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual(sorted(r["group"] for r in rows), ["retirees", "students", "students", "students"])
            self.assertTrue(all(set(r) == {"opaque_id", "member", "group", "attributes", "persona", "spec_sha256"} for r in rows),
                            "never the condition")
            notes = [e.get("note") for line in (run / "records.jsonl").read_text(encoding="utf-8").splitlines()
                     for e in json.loads(line)["transcript"] if e.get("note")]
            self.assertTrue(notes and all(n["reasoning"] == "Hmm {weird}. I go with the first." for n in notes))
            self.assertIn("Participants: Custom: 2 groups", (run / "results.html").read_text(encoding="utf-8"))
            runjson = json.loads((run / "run.json").read_text(encoding="utf-8"))
            self.assertEqual(runjson["f"]["spec"]["participants"]["sha256"], plan["participantsSha256"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless((PACK.parent / "app" / "src" / "main" / "fixtures" / "protocol-mini").is_dir(), "needs the app's fixture")
class RestoredEndToEnd(unittest.TestCase):
    """Review item 6, end to end: a published study played from restored wording keeps no held wording in its records."""
    HELD = "Imagine that you found a wallet on the street with a large amount of cash inside and nobody around."

    def test_restored_wording_never_reaches_the_records(self):
        sys.path.insert(0, str(RUNTIME / "hsenv"))
        from hsenv import distribution as D
        tmp = Path(tempfile.mkdtemp())
        try:
            code = tmp / "code"
            shutil.copytree(RUNTIME / "hsenv", code / "hsenv", ignore=shutil.ignore_patterns("__pycache__"))
            shutil.copytree(PACK / "artifact-kit", code / "artifact-kit", ignore=shutil.ignore_patterns("__pycache__"))
            (code / "skills" / "run").mkdir(parents=True)
            for f in RUN.glob("*.py"):
                shutil.copy(f, code / "skills" / "run")
            project = tmp / "project"
            shutil.copytree(PACK.parent / "app" / "src" / "main" / "fixtures" / "protocol-mini", project)
            (project / ".humanstudy").mkdir(exist_ok=True)
            restored = json.loads((project / "protocol.json").read_text(encoding="utf-8"))
            restored["stages"]["intro"]["content"][0]["value"] = self.HELD
            restored["stages"]["opinion"] = {"responses": [{"id": "why", "kind": "text", "required": True, "prompt": "What would you do, and why?"}]}
            restored["flow"]["seq"].insert(1, {"stage": "opinion"})
            projection = json.loads(json.dumps(restored))
            projection["stages"]["intro"]["content"][0]["value"] = D.PLACEHOLDER * len(self.HELD)
            projection["distribution"] = {"held": {"h1": {"path": "/stages/intro/content/0/value", "kind": "text", "source": "survey",
                                                          "length": len(self.HELD), "text_sha256": D.text_sha256(self.HELD), "locator": {}}}}
            (project / "protocol.json").write_text(json.dumps(projection), encoding="utf-8")
            (code / "restored").mkdir()
            (code / "restored" / "protocol.json").write_text(json.dumps(restored), encoding="utf-8")
            run = project / "artifacts" / "simulations" / "r1"
            run.mkdir(parents=True)
            sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()  # noqa: E731
            plan = {"route": "protocol", "protocolSha256": sha(project / "protocol.json"), "perArm": 2, "arms": None, "seeds": [1],
                    "temperature": 1.0, "participantsSha256": None, "programSha256": None, "images": False}
            (run / "plan.json").write_text(json.dumps(plan), encoding="utf-8")
            driver = tmp / "drive.py"
            driver.write_text(
                "import json, re, sys\nsys.path.insert(0, sys.argv[1])\nimport app_run\nfrom pathlib import Path\n"
                "HELD = %r\n"
                "def complete(m):\n"
                "    page = m[-1]['content']\n"
                "    ans = {}\n"
                "    text = re.findall(r'Question (\\S+) \\(text', page)\n"
                "    if 'What would you do' in page and text: ans = {text[-1]: 'As the page said: ' + HELD + ' I would return it.', 'quoted page': HELD}\n"
                "    else: ans = {q: 'o1' for q in re.findall(r'Question (\\S+) \\(choice', page)}\n"
                "    return 'Thinking about ' + HELD + '\\n```json\\n' + json.dumps(ans) + '\\n```'\n"
                "meta = app_run.main_run(Path(sys.argv[2]), Path(sys.argv[3]), complete=complete, model='m')\n"
                "print(json.dumps({'status': meta['status']}))\n" % self.HELD, encoding="utf-8")
            r = subprocess.run([sys.executable, "-I", str(driver), str(code / "skills" / "run"), str(run), str(project)],
                               capture_output=True, text=True, timeout=600)
            self.assertEqual(r.returncode, 0, r.stderr[-3000:] + r.stdout[-2000:])
            stored = {n: (run / n).read_text(encoding="utf-8") for n in ("steps.jsonl", "records.jsonl", "operator.jsonl", "participants.jsonl")
                      if (run / n).is_file()}
            self.assertTrue(stored["steps.jsonl"] and stored["records.jsonl"])
            for name, text in stored.items():
                for probe in ("wallet on the street", "large amount of cash", "quoted page", "Thinking about"):
                    self.assertNotIn(probe, text, name)
            whys = [v for l in stored["steps.jsonl"].splitlines() for v in json.loads(l).get("answers", {}).values()
                    if isinstance(v, str) and v.startswith("As the page said")]
            self.assertTrue(whys and all(w.startswith("As the page said: ") and D.PLACEHOLDER * 40 in w and w.endswith(" I would return it.") for w in whys), whys)
            private = (run / ".private" / "answers.jsonl").read_text(encoding="utf-8")
            self.assertIn("wallet on the street", private, "the answers as given are kept privately, for a resume")
            for name in ("evaldata.json", "effects.json"):
                if (run / name).is_file():
                    self.assertNotIn("wallet on the street", (run / name).read_text(encoding="utf-8"), name)
            # an in-place resume without the private journal is refused, never replayed from the masked answers
            (run / ".private" / "answers.jsonl").unlink()
            again = subprocess.run([sys.executable, "-I", str(driver), str(code / "skills" / "run"), str(run), str(project)],
                                   capture_output=True, text=True, timeout=600)
            self.assertNotEqual(again.returncode, 0)
            self.assertIn("start a new run", again.stderr + again.stdout)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class Round3(unittest.TestCase):
    """The second review of PR #187 (items 1-10)."""

    def setUp(self):
        import app_run
        self.A = app_run
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_1_output_limit_per_page_and_passed_to_the_model(self):
        short = {"screen": {"responses": [{"id": "q", "kind": "choice"}, {"id": "t", "kind": "text"}]}}
        long = {"screen": {"responses": [{"id": "t", "kind": "text", "min_chars": 200}]}}
        self.assertEqual((P.output_limit(short), P.output_limit(long)), (768, 2048))
        self.assertEqual(P.output_limit({"screen": {"responses": [{"id": "t", "kind": "text", "widget": "textarea"}]}}), 2048)
        limits = []

        def complete(messages, max_tokens=4096):
            limits.append(max_tokens)
            return '```json\n{}\n```'
        people = {("abc", "p1"): {"group": None, "attributes": {}, "persona": "", "system": P.system_text("")}}
        f = self.A.participant_f(complete, people, {"mode": "paper"}, False, "no", "s")

        class Ctx:
            participant, member, note = "abc", "p1", None
        f(dict(short, step=1, page=1, screen=dict(short["screen"], items=[])), Ctx())
        f(dict(long, step=2, page=2, screen=dict(long["screen"], items=[])), Ctx())
        self.assertEqual(limits, [768, 2048])

    def measure_survey(self):
        project = self.tmp / "survey"
        project.mkdir()
        stages, seq = {}, []
        for k in range(20):
            stages["p%d" % k] = {"content": [{"id": "t%d" % k, "value": ("Please read this short statement about everyday life "
                                                                          "and say how much you agree with it. " * 2).strip()}],
                                 "responses": [{"id": "q%d" % k, "kind": "choice", "prompt": "How much do you agree?",
                                                "options": [{"code": c, "label": l} for c, l in
                                                            (("a", "Disagree"), ("b", "Neutral"), ("c", "Agree"))]}]}
            seq.append({"stage": "p%d" % k})
        (project / "protocol.json").write_text(json.dumps({"id": "survey", "data": {}, "meta": {"title": "Survey"},
                                                           "arms": [{"id": "a1", "n_paper": 60}, {"id": "a2", "n_paper": 60}],
                                                           "stages": stages, "flow": {"seq": seq}}), encoding="utf-8")
        code = self.tmp / "code"
        shutil.copytree(RUNTIME / "hsenv", code / "hsenv", ignore=shutil.ignore_patterns("__pycache__"))
        (code / "skills" / "run").mkdir(parents=True)
        for f in RUN.glob("*.py"):
            shutil.copy(f, code / "skills" / "run")
        r = subprocess.run([sys.executable, "-I", str(code / "skills" / "run" / "budget.py"), str(project), str(self.tmp / "scratch")],
                           capture_output=True, text=True, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        b = json.loads(r.stdout.strip().splitlines()[-1])
        per = 60
        needed = sum(per * a["group_size"] * a["tokens_per_member"] for a in b["arms"].values()) + \
            sum(a["group_size"] * a["tokens_per_member"] for a in b["arms"].values())
        print("\n2x60x20 survey: %s tokens per member, %d calls, %s needed of 16,000,000"
              % ({k: a["tokens_per_member"] for k, a in b["arms"].items()}, b["arms"]["a1"]["calls"], format(needed, ",")))
        return b, needed

    def test_1_an_ordinary_survey_fits_the_ceiling(self):
        """2 conditions x 60 participants x 20 pages of modest text fit the 16,000,000 ceiling now that the relay
        reserves tokens (text bytes / 3), not bytes. Guard: the figure must not creep back up."""
        b, needed = self.measure_survey()
        self.assertEqual(b["output_tokens"], 768)
        self.assertLess(needed, 16_000_000)
        self.assertLess(needed, 12_500_000, "guard on the measured figure (about 11.5M when written)")

    def test_1_budget_and_relay_reserve_alike(self):
        import budget
        self.assertEqual(budget.BYTES_PER_TOKEN, 3)
        self.assertEqual(budget.tokens_of(10), 4)
        body = {"model": budget.MODEL_PLACEHOLDER, "messages": [{"role": "system", "content": "S"}, {"role": "user", "content": "页面"}],
                "temperature": 1.0, "max_tokens": 768}
        self.assertEqual(budget.call_charge("S", "页面", 0, 768), -(-len(json.dumps(body).encode()) // 3) + 512 + 768)

    def test_2_raw_answers_for_replay_stay_private(self):
        sys.path.insert(0, str(RUNTIME / "hsenv"))
        import run_study
        held = "A long passage of held original wording that must never be written into the run records at all."
        red = self.A.Redactor([held])
        run_dir = self.tmp / "run"
        (run_dir / ".private").mkdir(parents=True)
        raw = {"seed": 1, "participant": "x", "member": "p1", "step": 3, "attempt": 0, "answers": {"q": held}}
        (run_dir / ".private" / "answers.jsonl").write_text(json.dumps(raw) + "\n", encoding="utf-8")

        class Dummy:
            def __init__(self, d):
                self.dir, self.cache = Path(d), {}
                self.steps_path, self.records_path, self.operator_path = (Path(d) / n for n in ("steps.jsonl", "records.jsonl", "operator.jsonl"))
        real = run_study.Runner
        run_study.Runner = Dummy
        try:
            with self.A.redacted_records(red):
                r = Dummy(run_dir)
                self.assertEqual(r.cache[(1, "x", "p1", 3, 0)]["answers"]["q"], held, "a resume replays the answers as given")
                fh = r.steps_path.open("a", encoding="utf-8")
                fh.write(json.dumps(dict(raw, step=4)) + "\n")
                fh.close()
                run_study.write_json(run_dir / "effects.json", {"examples": [held], "id": held})
        finally:
            run_study.Runner = real
        self.assertNotIn("held original wording", (run_dir / "steps.jsonl").read_text(encoding="utf-8"))
        self.assertIn("held original wording", (run_dir / ".private" / "answers.jsonl").read_text(encoding="utf-8").splitlines()[1])
        effects = json.loads((run_dir / "effects.json").read_text(encoding="utf-8"))
        self.assertNotIn("held original wording", effects["examples"][0], "written redacted, not fixed up afterwards")
        self.assertNotIn("held original wording", effects["id"], "evaluation files are free text throughout")

    def test_3_answers_cut_to_each_questions_schema(self):
        A = self.A
        state = {"screen": {"responses": [
            {"id": "c", "kind": "choice", "options": [{"code": "o1"}, {"code": "o2", "text_entry": True}]},
            {"id": "m", "kind": "multi", "options": [{"code": "o1"}, {"code": "o2", "text_entry": True}]},
            {"id": "n", "kind": "scale"}, {"id": "t", "kind": "text"}, {"id": "b", "kind": "choice", "options": [{"code": "o3"}]}]}}

        class Ctx:
            note = {"reply": "x"}
        out = A.page_answers(state, {"c": {"code": "o2", "text": "fine", "quote": "held words", "extra": {"x": 1}},
                                     "m": ["o1", {"code": "o2", "text": "t", "held": "w"}, "o9", {"x": "held"}],
                                     "n": 4, "t": "free text", "b": {"text": "no code"}, "nope": "held"}, Ctx(), False)
        self.assertEqual(out, {"c": {"code": "o2", "text": "fine"}, "m": ["o1", {"code": "o2", "text": "t"}], "n": 4, "t": "free text"})
        nobox = A.schema_answer({"id": "c", "kind": "choice", "options": [{"code": "o1"}]}, {"code": "o1", "text": "held words"})
        self.assertEqual(nobox, "o1", "no text box: the text is dropped")
        for kind in ("choice", "multi", "scale", "number", "text", "slider"):
            self.assertEqual(A.schema_answer({"id": "x", "kind": kind, "na_option": True, "options": [{"code": "o1"}]}, "NA"), "NA", kind)
            if kind in ("choice", "multi"):
                self.assertIsNone(A.schema_answer({"id": "x", "kind": kind, "options": [{"code": "o1"}]}, "NA"), kind)

    def test_6_condition_names_in_any_rendered_field(self):
        proto = {"arms": [{"id": "gratitude", "label": "Gratitude condition"}, {"id": "control", "label": "Control"}]}
        for group in ({"id": "gratitude-group", "persona": "x"}, {"id": "g", "label": "Control people", "persona": "x"},
                      {"id": "g", "attributes": {"education": "Gratitude condition graduates"}},
                      {"id": "g", "attributes": {"occupation": ["nurse", "control room operator"]}},
                      {"id": "g", "attributes": {"notes": "In the control."}}):
            spec = P.validate({"mode": "custom", "groups": [group]})
            self.assertIsNotNone(P.condition_problem(spec, proto, None), group)
        self.assertIsNone(P.condition_problem(P.validate({"mode": "custom", "groups": [{"id": "nurses", "persona": "A nurse."}]}), proto, None))

    def test_8_parser_backticks_in_strings_and_no_nan(self):
        self.assertEqual(P.parse_answer('Okay.\n```json\n{"t": "use ``` fences ```"}\n```'), {"t": "use ``` fences ```"})
        self.assertEqual(P.parse_answer('First ```json {"a": 1}``` then\n```json\n{"a": 2}\n```  \n'), {"a": 2})
        for bad in ['```json\n{"n": NaN}\n```', '```json\n{"n": Infinity}\n```', '{"n": -Infinity}', '```json\n{"a": 1}\n``` and more']:
            with self.assertRaisesRegex(ValueError, "no JSON object", msg=bad):
                P.parse_answer(bad)

    def test_9_a_cut_off_participants_file_gets_its_newline(self):
        A = self.A
        proj = self.tmp / "p"
        proj.mkdir()
        (proj / "protocol.json").write_text(json.dumps(PROTOCOL), encoding="utf-8")
        plan = {"participantsSha256": None, "programSha256": None, "perArm": 2, "seeds": [1], "arms": None}
        out = proj / "artifacts" / "simulations" / "r"
        sys.path.insert(0, str(RUNTIME / "hsenv"))
        A.participants_for(out, proj, plan, None, False)
        lines = (out / "participants.jsonl").read_text(encoding="utf-8").splitlines()
        (out / "participants.jsonl").write_text("\n".join(lines[:2]) + "\n" + lines[2][:15], encoding="utf-8")   # cut mid-line
        A.participants_for(out, proj, plan, None, False)
        after = (out / "participants.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(after[2], lines[2][:15])
        self.assertEqual([json.loads(x)["opaque_id"] for x in after[3:]], [json.loads(lines[2])["opaque_id"], json.loads(lines[3])["opaque_id"]])

    def test_10_zero_counts_digits_in_study_parts_and_pinned_pictures_on_resume(self):
        self.assertNotIn("gender", P.stats("0 women and 0 men"))
        proto = {"meta": {"sample": "Study 1: 60 nurses. Study 2: 60 doctors."}, "arms": [{"id": "s1"}, {"id": "s2"}]}
        self.assertEqual(P.paper_profile(proto, None, {"id": "s1"})["description"], "60 nurses")
        self.assertEqual(P.paper_profile(proto, None, {"id": "s2"})["description"], "60 doctors")
        A = self.A
        (self.tmp / "a.png").write_bytes(b"\x89PNGone")
        protocol = {"stages": {"s": {"content": [{"value": {"src": "a.png"}}]}}}
        out = self.tmp / "run"
        first = A.pinned_pictures(out, protocol, self.tmp)
        (out / "run.json").write_text("{}", encoding="utf-8")   # the runner started: later starts are resumes
        (self.tmp / "a.png").write_bytes(b"\x89PNGtwo")
        self.assertEqual(A.pinned_pictures(out, protocol, self.tmp), first, "an in-place resume keeps the digests from the start")
        for broken in ("{not json", '{"pinned": ["a.png"]}'):
            (out / "pictures.json").write_text(broken, encoding="utf-8")
            with self.assertRaisesRegex(A.Refused, "start a new run"):
                A.pinned_pictures(out, protocol, self.tmp)
        (out / "pictures.json").unlink()
        with self.assertRaisesRegex(A.Refused, "start a new run", msg="the pins are never rebuilt"):
            A.pinned_pictures(out, protocol, self.tmp)


class Round4(unittest.TestCase):
    """The third review of PR #187."""

    def setUp(self):
        import app_run
        self.A = app_run
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_5_redactor_normalises_the_whole_string_first(self):
        import unicodedata
        held = "Café owners in Zürich were asked whether they would résumé the négociations next week."
        red = self.A.Redactor([held])
        decomposed = unicodedata.normalize("NFD", "She said: " + held + " Done.")
        out = red.text(decomposed)
        self.assertEqual(out, unicodedata.normalize("NFC", out), "the stored string is the normalised one")
        self.assertTrue(out.startswith("She said: ") and out.endswith(" Done.") and "Zürich" not in out, out)
        self.assertEqual(red.text(unicodedata.normalize("NFD", "Zürich")), "Zürich")

    def test_6_parser_tries_openers_from_last_and_refuses_overflow(self):
        self.assertEqual(P.parse_answer('A.\n```json\n{"t": "write ```json {\\"x\\": 1} here"}\n```'), {"t": 'write ```json {"x": 1} here'},
                         "the last opener sits inside a string and does not end the reply: the one before it does")
        with self.assertRaisesRegex(ValueError, "no JSON object"):
            P.parse_answer('A.\n```json\n{"a": 1}\n```\nI thought about ```json {"x": broken')
        self.assertEqual(P.parse_answer('Earlier ```json {"a": 1}``` was wrong.\n```json\n{"a": 2}'), {"a": 2}, "closing fence optional")
        for bad in ['```json\n{"n": 1e400}\n```', '{"n": -1e999}', '```json\n{"a": 1}\n``` and then more']:
            with self.assertRaisesRegex(ValueError, "no JSON object", msg=bad):
                P.parse_answer(bad)
        people = {("abc", "p1"): {"group": None, "attributes": {}, "persona": "", "system": ""}}
        f = self.A.participant_f(lambda m: 'Sure {"q": "o9"} I think {"q": "o1"}', people, {"mode": "blank"}, False, "no", "s")

        class Ctx:
            participant, member, note = "abc", "p1", None
        with self.assertRaisesRegex(ValueError, "no JSON object", msg="blank mode reads replies with the same parser"):
            f({"step": 1, "screen": {"items": [], "responses": [{"id": "q", "kind": "choice"}]}}, Ctx())

    def test_7_a_restored_resume_needs_its_private_journal_and_mends_a_torn_row(self):
        A = self.A
        red = A.Redactor(["x" * 50])
        journal = self.tmp / ".private" / "answers.jsonl"
        journal.parent.mkdir()
        journal.write_text('{"seed": 1}\n{"seed": 2, "partic', encoding="utf-8")
        path = A._RedactingPath(self.tmp / "steps.jsonl", red, journal)
        fh = path.open("a", encoding="utf-8")
        fh.write('{"seed": 3}\n')
        fh.close()
        self.assertEqual(journal.read_text(encoding="utf-8").splitlines(), ['{"seed": 1}', '{"seed": 2, "partic', '{"seed": 3}'])
        src = (RUN / "app_run.py").read_text(encoding="utf-8")
        self.assertIn('if red is not None and steps.is_file() and steps.stat().st_size and not (out / PRIVATE_DIR / "answers.jsonl").is_file():', src)

    def test_8_the_condition_check_reads_the_rendered_prompt(self):
        proto = {"arms": [{"id": "gratitude", "label": "Gratitude"}, {"id": "neutral", "label": "Neutral"}]}
        spec = P.validate({"mode": "custom", "system": "You are {{persona}} and you work as {{occupation}}.",
                           "groups": [{"id": "g", "persona": "a nurse", "attributes": {"occupation": "neutral observer"}}]})
        self.assertIsNone(P.condition_problem({**spec, "groups": [{"id": "g", "persona": "a nurse"}]}, proto, None))
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "protocol.json").write_text(json.dumps(proto), encoding="utf-8")
            (d / "simulation").mkdir()
            # the template and the persona are clean; a value filled in at render time names a condition
            (d / P.SPEC_PATH).write_text(json.dumps({"mode": "custom", "system": "You are {{persona}}, aged {{age}}. {{group}}",
                                                     "groups": [{"id": "g1", "persona": "a nurse"}]}), encoding="utf-8")
            self.assertTrue(P.check(d)["ok"], P.check(d))
            self.assertIn("Gratitude", P.researcher_text(P.system_text("You are in Gratitude.")))
            self.assertNotIn(P.THINK_FORMAT, P.researcher_text(P.system_text("x")), "the app's fixed wording is not read")
        src = (RUN / "app_run.py").read_text(encoding="utf-8")
        self.assertIn("hit = P.names_condition(P.researcher_text(P.system_text(person[\"check\"]", src, "refused at run time too")

    def test_9_the_summary_shows_studies_with_other_figures(self):
        proto = {"meta": {"sample": "Students (Study 1: 70% female; Study 2: 30% female)"},
                 "arms": [{"id": "s1", "label": "Study 1"}, {"id": "s2", "label": "Study 2"}]}
        line = P.summary({"mode": "paper"}, proto, None)
        self.assertIn("Students, 70% women", line)
        self.assertIn("Students, 30% women", line)


class Round5(unittest.TestCase):
    """The final check of PR #187."""

    def test_1_numeric_strings_reach_the_engine(self):
        import app_run as A
        for kind in ("number", "scale", "slider"):
            self.assertEqual(A.schema_answer({"id": "n", "kind": kind}, "1,200"), "1,200", kind)
            self.assertEqual(A.schema_answer({"id": "n", "kind": kind}, 7), 7)

    def test_2_a_json_only_reply_may_hold_backticks(self):
        self.assertEqual(P.parse_answer('{"t": "I would write ``` here", "q": "o1"}'), {"t": "I would write ``` here", "q": "o1"})
        self.assertEqual(P.parse_answer('{"t": "```json {\\"x\\": 1}```"}'), {"t": '```json {"x": 1}```'})
        with self.assertRaisesRegex(ValueError, "no JSON object"):
            P.parse_answer('{"n": 1e400}')

    def test_3_demographic_condition_names_with_a_matching_sample(self):
        proto = {"meta": {"sample": "120 women recruited at a US university (100% female, mean age 21.0, SD 2.0)."},
                 "arms": [{"id": "woman", "label": "Woman"}, {"id": "man", "label": "Man"}]}
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "protocol.json").write_text(json.dumps(proto), encoding="utf-8")
            r = P.check(d)
            self.assertTrue(r["ok"], r)
            ppl = P.people({"mode": "paper"}, None, proto, None, {"woman": 2, "man": 2}, {}, [1], lambda s, a, i: "%s-%s" % (a, i))
            self.assertTrue(all("You are a" in p["persona"] and "woman." in p["persona"] for p in ppl.values()), "the gender is still said")
            (d / "simulation").mkdir()
            (d / P.SPEC_PATH).write_text(json.dumps({"mode": "custom", "groups": [
                {"id": "g", "persona": "A student.", "attributes": {"gender": {"woman": 1, "man": 1}, "country": "Man"}}]}), encoding="utf-8")
            self.assertTrue(P.check(d)["ok"], "categorical gender and country values are not checked")
            for group in ({"id": "g", "persona": "A student in the Woman condition."}, {"id": "g", "label": "Woman group", "persona": "x"},
                          {"id": "g", "persona": "x", "attributes": {"occupation": "Man"}},
                          {"id": "g", "persona": "x", "attributes": {"notes": "Woman"}}):
                (d / P.SPEC_PATH).write_text(json.dumps({"mode": "custom", "groups": [group]}), encoding="utf-8")
                self.assertFalse(P.check(d)["ok"], group)
            (d / P.SPEC_PATH).write_text(json.dumps({"mode": "custom", "system": "You are {{persona}} ({{gender}}). Woman.",
                                                     "groups": [{"id": "g", "persona": "x"}]}), encoding="utf-8")
            self.assertFalse(P.check(d)["ok"], "the researcher's own system text is checked")

    def test_4_the_cross_version_message_is_plain(self):
        import app_run as A
        self.assertEqual(A.OLD_RUN, "This run was started with an earlier version of the app; start a new run.")


if __name__ == "__main__":
    unittest.main()
