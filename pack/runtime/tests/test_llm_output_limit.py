"""Per-call output limit: every simulation call names a small max_tokens, so the macOS run relay
reserves (and forwards) that much instead of 4,096 per call. Localhost stub only; no model calls."""
import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "pack/runtime/lib"))
sys.path.insert(0, str(REPO / "pack/skills/export/agent"))
import humanstudy_llm as H  # noqa: E402
import study_core  # noqa: E402


class Stub(BaseHTTPRequestHandler):
    bodies = []
    finish = "stop"

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        type(self).bodies.append(body)
        out = json.dumps({"choices": [{"message": {"content": "ok"}, "finish_reason": type(self).finish}],
                          "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(out)


class OutputLimitTests(unittest.TestCase):
    def setUp(self):
        Stub.bodies, Stub.finish = [], "stop"
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.tmp = tempfile.mkdtemp()
        self.old = dict(os.environ)
        base = f"http://127.0.0.1:{self.srv.server_address[1]}/v1"
        os.environ.update({"HUMANSTUDY_HOSTED_BASEURL": base, "HUMANSTUDY_DESKTOP_KEY": "fake-key",
                           "OPENROUTER_BASE_URL": base, "OPENROUTER_API_KEY": "fake-key",
                           "HUMANSTUDY_PROJECT_DIR": self.tmp})
        os.environ.pop("HUMANSTUDY_LLM_MAX_OUTPUT", None)
        os.environ.pop("HUMANSTUDY_LLM_USAGE_LOG", None)

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        os.environ.clear()
        os.environ.update(self.old)

    def log(self):
        p = Path(self.tmp) / ".humanstudy/tmp/llm-usage.jsonl"
        return [json.loads(x) for x in p.read_text().splitlines()]

    def test_default_is_512(self):
        H.llm("hi")
        H.llm_many(["a", "b"])
        self.assertEqual([b["max_tokens"] for b in Stub.bodies], [512, 512, 512])
        self.assertTrue(all("max_completion_tokens" not in b for b in Stub.bodies))

    def test_env_override_and_invalid_values_fall_back(self):
        os.environ["HUMANSTUDY_LLM_MAX_OUTPUT"] = "1024"
        H.llm("x")
        for bad in ("lots", "0", "-5", "4097", "", "12.5"):
            os.environ["HUMANSTUDY_LLM_MAX_OUTPUT"] = bad
            H.llm("x")
        self.assertEqual([b["max_tokens"] for b in Stub.bodies], [1024] + [512] * 6)

    def test_explicit_argument_wins(self):
        os.environ["HUMANSTUDY_LLM_MAX_OUTPUT"] = "300"
        H.chat([{"role": "user", "content": "x"}], max_tokens=2000)
        H.llm("x", max_tokens=64)
        self.assertEqual([b["max_tokens"] for b in Stub.bodies], [2000, 64])

    def test_max_completion_tokens_becomes_one_field(self):
        H.llm("x", max_completion_tokens=800)
        H.llm("x", max_tokens=100, max_completion_tokens=900)
        self.assertEqual([b["max_tokens"] for b in Stub.bodies], [800, 100])
        self.assertTrue(all("max_completion_tokens" not in b for b in Stub.bodies))

    def test_truncation_is_logged(self):
        H.llm("x")
        Stub.finish = "length"
        H.llm("y")
        first, second = self.log()
        self.assertEqual((first["max_tokens"], first["finish_reason"], first["truncated"]), (512, "stop", False))
        self.assertEqual((second["finish_reason"], second["truncated"]), ("length", True))

    def test_study_core_http_llm_sends_the_same_limit(self):
        call = study_core.http_llm("some/model")
        self.assertEqual(call("p"), "ok")
        os.environ["HUMANSTUDY_LLM_MAX_OUTPUT"] = "256"
        call("p")
        call("p", max_tokens=1500)
        call("p", max_completion_tokens=700)
        os.environ["HUMANSTUDY_LLM_MAX_OUTPUT"] = "nope"
        call("p")
        self.assertEqual([b["max_tokens"] for b in Stub.bodies], [512, 256, 1500, 700, 512])
        self.assertTrue(all("max_completion_tokens" not in b for b in Stub.bodies))


    def test_usage_log_goes_where_the_confined_run_can_write(self):
        run = Path(self.tmp) / "artifacts/simulations/r1"
        run.mkdir(parents=True)
        os.environ["HUMANSTUDY_LLM_USAGE_LOG"] = str(run / "llm-usage.jsonl")
        Stub.finish = "length"
        H.llm("secret prompt text")
        line = json.loads((run / "llm-usage.jsonl").read_text())
        self.assertTrue(line["truncated"])
        self.assertNotIn("secret prompt text", json.dumps(line))
        self.assertFalse((Path(self.tmp) / ".humanstudy/tmp/llm-usage.jsonl").exists())
        outside = tempfile.mkdtemp()
        for bad in ("relative/llm-usage.jsonl", str(run / "usage.txt"), "", str(Path(outside) / "llm-usage.jsonl"),
                    str(run / "../../../../escape.jsonl")):
            os.environ["HUMANSTUDY_LLM_USAGE_LOG"] = bad
            self.assertEqual(H.usage_log_path(), Path(self.tmp) / ".humanstudy/tmp/llm-usage.jsonl", bad)

    def test_study_core_counts_and_warns_on_truncation(self):
        call = study_core.http_llm("some/model")
        call("p")
        Stub.finish = "length"
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            call("private words")
        self.assertEqual((call.calls, call.truncated), (2, 1))
        self.assertIn("cut off at max_tokens=512", err.getvalue())
        self.assertNotIn("private words", err.getvalue())

    def test_study_core_keeps_an_explicit_zero(self):
        study_core.http_llm("some/model")("p", max_tokens=0)
        self.assertEqual(Stub.bodies[0]["max_tokens"], 0)



class LauncherTimeoutTests(unittest.TestCase):
    def test_script_gets_the_relay_capability_remaining_lifetime(self):
        sys.path.insert(0, str(REPO / "pack/skills/simulate"))
        import run_confined
        import time
        self.assertEqual(run_confined._remaining({}), 1800, "older descriptor: as before")
        self.assertEqual(run_confined._remaining({"expiresAt": True}), 1800)
        self.assertEqual(run_confined._remaining({"expiresAt": "soon"}), 1800)
        left = run_confined._remaining({"expiresAt": (time.time() + 7200) * 1000})
        self.assertTrue(7190 <= left <= 7200, left)
        self.assertEqual(run_confined._remaining({"expiresAt": (time.time() - 60) * 1000}), 1)


if __name__ == "__main__":
    unittest.main()
