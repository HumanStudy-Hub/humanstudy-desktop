import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

PACK = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(PACK / "runtime/hsenv"), str(PACK / "skills/run")]
from run_study import Env, Participant, Protocol, Runner, _PLATFORM_ID


def protocol(*, pattern=None, group=False, optional=False):
    field = {"id": "registration", "kind": "text", "required": True,
             "prompt": "Please paste your Prolific ID below.", "min_chars": 24}
    if pattern:
        field["validate"] = {"pattern": pattern}
    fields = [field]
    if optional:
        fields.append(dict(field, id="optional", required=False))
    return Protocol({"id": "test", "flow": {"stage": "form"}, "stages": {"form": {"responses": fields}},
                     "arms": [{"id": "main", **({"group_size": 2} if group else {})}]})


class PlatformIdTests(unittest.TestCase):
    def test_wording(self):
        for prompt in ("Please paste your Prolific ID below.", "Enter your worker ID here",
                       "Type your participant ID in the box", "Provide your subject ID in the field"):
            self.assertIsNotNone(_PLATFORM_ID.fullmatch(prompt), prompt)
        for prompt in ("What is your ID number?", "Please create your participant ID",
                       "What was the participant ID shown on the previous screen?"):
            self.assertIsNone(_PLATFORM_ID.fullmatch(prompt), prompt)

    def test_engine_step(self):
        env = Env(protocol(pattern="^[a-f0-9]{24}$"))
        member = env.open(env.design(n=1)[0])
        field = member.reset()["screen"]["responses"][0]["id"]
        self.assertIn(field, member.step({}, system_filled={field: "bad"})["error"])
        self.assertTrue(member.step({}, system_filled={field: "a" * 24})["done"])
        self.assertEqual(member.answers, [])
        self.assertEqual(member.refused[0]["answers"], {})

    def test_minimum_length_and_model_errors(self):
        study = protocol(optional=True)
        study.stages["form"]["responses"][0]["min_chars"] = 75
        env = Env(study)
        part = Participant(env, env.design(n=1)[0], 1, b"salt")
        pid, state = part.todo()[0]
        required, optional = [r["id"] for r in state["screen"]["responses"]]
        state = dict(state, error={required: "private", optional: "visible"})
        answer = Mock(return_value={})
        with tempfile.TemporaryDirectory() as directory:
            runner = Runner(study, answer, {"spec": {"fill_platform_ids": True}, "name": "stub", "retries": 0},
                            directory)
            row, _ = runner._call(part, pid, state)
        self.assertEqual(len(row["system_filled"][required]), 75)
        self.assertEqual(answer.call_args.args[0]["error"], {optional: "visible"})
        self.assertEqual(state["error"][required], "private")

    def simulate(self, study, answer):
        with tempfile.TemporaryDirectory() as directory:
            spec = {"spec": {"fill_platform_ids": True}, "retries": 0, "max_refusals": 20, "name": "stub"}
            runner = Runner(study, answer, spec, directory, top_up=False)
            runner.run_seed(1, {"main": 1}, Mock(stop_requested=False))
            return [[json.loads(line) for line in path.read_text().splitlines()]
                    for path in (runner.steps_path, runner.operator_path)]

    def test_group_and_optional_field(self):
        def answer(state, ctx):
            self.assertEqual([r["required"] for r in state["screen"]["responses"]], [False])
            return {}
        steps, records = self.simulate(protocol(pattern="^[a-f0-9]{24}$", group=True, optional=True), answer)
        self.assertEqual([r["status"] for r in records], ["completed"] * 2)
        ids = [next(iter(row["system_filled"].values())) for row in steps]
        self.assertEqual(len(set(ids)), 2)
        for value in ids:
            self.assertRegex(value, "^[a-f0-9]{24}$")

    def test_unsatisfiable_field_stops_before_mixed_page_call(self):
        answer = Mock()
        steps, records = self.simulate(protocol(pattern="^.{3}$", optional=True), answer)
        answer.assert_not_called()
        self.assertFalse(steps)
        self.assertEqual(records[0]["error"], "platform ID refused by protocol validation")
