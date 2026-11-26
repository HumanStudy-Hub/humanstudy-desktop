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
        self.assertEqual(prof["description"], "undergraduates at a US university")
        self.assertEqual(prof["age"], {"mean": 20.4, "sd": 1.8})
        self.assertAlmostEqual(prof["gender"]["woman"], 0.62)
        ppl = P.people({"mode": "paper"}, None, {"arms": [{"id": "s1"}]}, prog, {"s1": 40}, {}, [1], opaque)
        ages = [p["attributes"]["age"] for p in ppl.values()]
        self.assertTrue(all(16 <= a <= 25 for a in ages) and len(set(ages)) > 1, ages)
        self.assertIn("whom the paper describes as: undergraduates at a US university", next(iter(ppl.values()))["persona"])
        self.assertIn("Sample-matched: undergraduates at a US university, age ~20.4, 62% women",
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
        self.assertEqual(next(iter(nothing.values())), {"group": None, "attributes": {}, "persona": ""})

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
            (d / P.SPEC_PATH).write_text(json.dumps({"mode": "custom", "groups": [{"persona": "é" * 1400}]}), encoding="utf-8")
            self.assertIn("too long", P.check(d)["problem"])
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
        reply = 'Honestly {"r1": "o9"} looks like a trap to me, so I pick the first {one}.\n```json\n{"r1": "o1", "r2": {"code": "o3", "text": "x"}}\n```'
        reasoning, answers = P.split_reply(reply)
        self.assertEqual(answers, {"r1": "o1", "r2": {"code": "o3", "text": "x"}})
        self.assertTrue(reasoning.startswith("Honestly") and reasoning.endswith("{one}."))
        self.assertEqual(P.parse_answer('I like it.\n```json\n{"a": 1}\n```\nmore\n```json\n{"a": 2}\n```'), {"a": 2}, "the last block")
        self.assertEqual(P.split_reply('Not sure {at all}. {"q": 5}'), ("Not sure {at all}.", {"q": 5}), "unfenced: the last object")
        self.assertEqual(P.parse_answer('{"q": {"code": "o1", "text": "t"}}'), {"q": {"code": "o1", "text": "t"}}, "outermost")
        self.assertEqual(P.parse_answer("{}"), {})
        with self.assertRaisesRegex(ValueError, "no JSON object"):
            P.parse_answer("I would rather not say.")


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

    def test_participant_f_sends_persona_images_and_keeps_the_reasoning(self):
        A = self.A
        sent = []

        def complete(messages):
            sent.append(messages)
            return 'Seems fine to me.\n```json\n{"q1": "o2"}\n```'
        img = self.tmp / "pic.png"
        img.write_bytes(b"\x89PNG\r\n\x1a\nfake")
        people = {("abc", "p1"): {"group": None, "attributes": {}, "persona": "", "system": P.system_text("You are a nurse.")}}
        f = A.participant_f(complete, people, {"mode": "paper"}, True, "sent", "Sample-matched: nurses")

        class Ctx:
            participant, member, note = "abc", "p1", None
            asset_path = staticmethod(lambda ref: str(img))
        state = {"step": 1, "page": 1, "screen": {"items": [{"id": "i1", "src": "asset:ff"}],
                                                   "responses": [{"id": "q1", "kind": "single", "prompt": "Pick", "options": [{"code": "o1", "label": "A"}, {"code": "o2", "label": "B"}]}]}}
        ctx = Ctx()
        self.assertEqual(f(state, ctx), {"q1": "o2"})
        system, user = sent[0]
        self.assertTrue(system["content"].startswith("You are a nurse."))
        self.assertEqual([p["type"] for p in user["content"]], ["text", "image_url"])
        self.assertTrue(user["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertEqual(ctx.note["reasoning"], "Seems fine to me.")
        self.assertEqual(ctx.note["images_sent"], 1)
        self.assertNotIn("base64", json.dumps(ctx.note), "the picture itself is never stored")
        private = A.participant_f(complete, people, {"mode": "paper"}, True, "sent", "s", keep_text=False)
        ctx3 = Ctx()
        self.assertEqual(private(state, ctx3), {"q1": "o2"})
        self.assertEqual(ctx3.note, {"reply_chars": len('Seems fine to me.\n```json\n{"q1": "o2"}\n```'), "images_sent": 1},
                         "a restored study's replies (which may quote its wording) are not kept")
        ctx2 = Ctx()
        ctx2.participant = "zzz"
        with self.assertRaises(RuntimeError):
            f(state, ctx2)


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
                    "seeds": [1], "temperature": 1.0, "participantsSha256": sha(project / P.SPEC_PATH), "images": False}
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
            self.assertTrue(all(set(r) == {"opaque_id", "member", "group", "attributes"} for r in rows), "never the condition")
            notes = [e.get("note") for line in (run / "records.jsonl").read_text(encoding="utf-8").splitlines()
                     for e in json.loads(line)["transcript"] if e.get("note")]
            self.assertTrue(notes and all(n["reasoning"] == "Hmm {weird}. I go with the first." for n in notes))
            self.assertIn("Participants: Custom: 2 groups", (run / "results.html").read_text(encoding="utf-8"))
            runjson = json.loads((run / "run.json").read_text(encoding="utf-8"))
            self.assertEqual(runjson["f"]["spec"]["participants"]["sha256"], plan["participantsSha256"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
