"""Tests for the simulate skill's runner (pack/skills/simulate/simkit.py): balanced plan, progress.json
the app reads, resume without repeating participants, and the researcher's Stop file.
   python -m unittest discover -s pack/runtime/tests"""
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "skills" / "simulate"))
import simkit  # noqa: E402


class SimkitTest(unittest.TestCase):
    def test_runs_plan_writes_progress_and_resumes(self):
        with tempfile.TemporaryDirectory() as d:
            calls = []
            lock = threading.Lock()

            def one(cond, idx, rng):
                with lock:
                    calls.append((cond, idx))
                return {"condition": cond, "answer": rng.random()}

            run = simkit.SimRun(d, plan={"harm": 3, "help": 2}, model="m", seed=1, workers=3)
            trial = run.participants(one, trial=1)
            self.assertEqual(len(trial), 2)
            sessions = run.participants(one)
            self.assertEqual(len(sessions), 5)
            self.assertEqual(sorted(s["index"] for s in sessions if s["condition"] == "harm"), [0, 1, 2])
            p = json.loads((Path(d) / "progress.json").read_text())
            self.assertEqual((p["stage"], p["done"], p["total"], p["failed"]), ("running", 5, 5, 0))
            self.assertEqual({c["id"]: c["done"] for c in p["conditions"]}, {"harm": 3, "help": 2})
            # resume: nothing is run twice, and a new run object keeps startedAt
            n = len(calls)
            again = simkit.SimRun(d, plan={"harm": 3, "help": 2}, model="m", seed=1).participants(one)
            self.assertEqual(len(calls), n)
            self.assertEqual(len(again), 5)
            self.assertEqual(json.loads((Path(d) / "progress.json").read_text())["startedAt"], p["startedAt"])

    def test_failures_are_counted_and_stop_ends_the_run(self):
        with tempfile.TemporaryDirectory() as d:
            def bad(cond, idx, rng):
                raise RuntimeError("no reply")

            run = simkit.SimRun(d, plan={"a": 2}, workers=1)
            rows = run.participants(bad)
            self.assertTrue(all("error" in r for r in rows))
            self.assertEqual(json.loads((Path(d) / "progress.json").read_text())["failed"], 2)

        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "STOP").write_text("stop")
            run = simkit.SimRun(d, plan={"a": 3}, workers=1)
            with self.assertRaises(SystemExit):
                run.participants(lambda c, i, r: {"condition": c})
            self.assertEqual(json.loads((Path(d) / "progress.json").read_text())["stage"], "stopped")

    def test_stage_cli(self):
        with tempfile.TemporaryDirectory() as d:
            simkit._cli(["stage", d, "failed", "The evaluation could not read the answers"])
            p = json.loads((Path(d) / "progress.json").read_text())
            self.assertEqual((p["stage"], p["message"]), ("failed", "The evaluation could not read the answers"))

    def test_heartbeat_keeps_a_quiet_stage_live_and_exit_is_recorded(self):
        # #16: a long scoring step writes no progress, but the heartbeat shows the process is alive;
        # when run.py ends, runner becomes "exited" (the agent writes the results up).
        with tempfile.TemporaryDirectory() as d:
            old = simkit.HEARTBEAT_SECONDS
            simkit.HEARTBEAT_SECONDS = 0.05
            try:
                run = simkit.SimRun(d, plan={"a": 1}, model="m")
                run.stage("scoring")
                first = json.loads((Path(d) / "progress.json").read_text())
                self.assertEqual((first["runner"], first["stage"]), ("alive", "scoring"))
                deadline = time.time() + 5
                beat = first
                while time.time() < deadline and beat["heartbeatAt"] == first["heartbeatAt"]:
                    time.sleep(0.1)
                    beat = json.loads((Path(d) / "progress.json").read_text())
                self.assertNotEqual(beat["heartbeatAt"], first["heartbeatAt"], "heartbeat did not move during a quiet stage")
                self.assertEqual(beat["updatedAt"], first["updatedAt"], "a heartbeat is not progress")
                self.assertEqual(beat["stage"], "scoring")
                run._exit()
                done = json.loads((Path(d) / "progress.json").read_text())
                self.assertEqual((done["runner"], done["stage"]), ("exited", "scoring"))
                after = done["heartbeatAt"]
                time.sleep(0.3)
                self.assertEqual(json.loads((Path(d) / "progress.json").read_text())["heartbeatAt"], after, "heartbeat continued after exit")
                simkit._cli(["stage", d, "writing"])
                self.assertEqual(json.loads((Path(d) / "progress.json").read_text())["runner"], "exited")
            finally:
                simkit.HEARTBEAT_SECONDS = old


if __name__ == "__main__":
    unittest.main()
