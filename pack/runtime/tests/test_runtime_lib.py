"""Tests for the runtime's shims and LLM client.
   python -m unittest discover -s pack/runtime/tests     (with the runtime python for the PDF tests)"""
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

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
import humanstudy_llm as H  # noqa: E402

try:
    import hs_pdf_tools as T  # noqa: E402
    import pdfplumber  # noqa: F401, E402
    import pypdf  # noqa: F401, E402
    HAVE_PDF = True
except ImportError:
    HAVE_PDF = False


def make_pdf(pages):
    """A minimal valid PDF, one Helvetica text line per page."""
    objs = []
    n = len(pages)
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n))
    objs.append("<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n} >>")
    for i, text in enumerate(pages):
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {4 + 2 * i} 0 R "
            f"/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>"
        )
        stream = f"BT /F1 12 Tf 72 700 Td ({text}) Tj ET" if text else ""
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
    objs.append("<< /Title (Test Paper) >>")
    out = b"%PDF-1.4\n"
    offs = []
    for i, o in enumerate(objs):
        offs.append(len(out))
        out += f"{i + 1} 0 obj\n{o}\nendobj\n".encode()
    x = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for o in offs:
        out += f"{o:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R /Info {len(objs)} 0 R >>\nstartxref\n{x}\n%%EOF\n".encode()
    return out


class FakeProxy(BaseHTTPRequestHandler):
    calls = []
    fail_first = 0
    active = 0
    peak = 0
    lock = threading.Lock()

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        cls = type(self)
        with cls.lock:
            cls.active += 1
            cls.peak = max(cls.peak, cls.active)
            cls.calls.append({"path": self.path, "auth": self.headers.get("authorization"),
                              "bypass": self.headers.get("x-vercel-protection-bypass"), "body": body})
            n = len(cls.calls)
        import time
        time.sleep(0.05)
        with cls.lock:
            cls.active -= 1
        if n <= cls.fail_first:
            self.send_response(429)
            self.send_header("retry-after", "0")
            self.end_headers()
            self.wfile.write(b'{"error":"slow down"}')
            return
        out = json.dumps({"model": body["model"], "choices": [{"message": {"content": "reply:" + body["messages"][-1]["content"]}}],
                          "usage": {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(out)


class LLMTests(unittest.TestCase):
    def setUp(self):
        FakeProxy.calls, FakeProxy.fail_first, FakeProxy.active, FakeProxy.peak = [], 0, 0, 0
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeProxy)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.tmp = tempfile.mkdtemp()
        self.old = dict(os.environ)
        os.environ.update({
            "HUMANSTUDY_HOSTED_BASEURL": f"http://127.0.0.1:{self.srv.server_address[1]}/api/desktop/v1/",
            "HUMANSTUDY_DESKTOP_KEY": "hs_secret_key", "HUMANSTUDY_PROJECT_DIR": self.tmp,
        })
        for k in ("HUMANSTUDY_SIM_MODEL", "HUMANSTUDY_MODEL", "HUMANSTUDY_SERVER_BYPASS", "HUMANSTUDY_LLM_CONCURRENCY"):
            os.environ.pop(k, None)
        H._backoff = lambda attempt, ra: 0.01

    def tearDown(self):
        self.srv.shutdown()
        os.environ.clear()
        os.environ.update(self.old)

    def log(self):
        p = Path(self.tmp) / ".humanstudy" / "tmp" / "llm-usage.jsonl"
        return [json.loads(x) for x in p.read_text().splitlines()]

    def test_llm_basic_headers_model_and_usage_log(self):
        os.environ["HUMANSTUDY_MODEL"] = "acct/model"
        os.environ["HUMANSTUDY_SERVER_BYPASS"] = "byp"
        self.assertEqual(H.llm("hi", system="be brief"), "reply:hi")
        c = FakeProxy.calls[0]
        self.assertEqual(c["path"], "/api/desktop/v1/chat/completions")
        self.assertEqual(c["auth"], "Bearer hs_secret_key")
        self.assertEqual(c["bypass"], "byp")
        self.assertEqual(c["body"]["model"], "acct/model")
        self.assertEqual([m["role"] for m in c["body"]["messages"]], ["system", "user"])
        rec = self.log()[0]
        self.assertEqual((rec["prompt_tokens"], rec["completion_tokens"], rec["ok"]), (7, 3, True))
        self.assertNotIn("hs_secret_key", json.dumps(rec))
        self.assertNotIn("hi", [v for k, v in rec.items() if k not in ("ts", "model")])

    def test_sim_model_wins_and_default(self):
        os.environ["HUMANSTUDY_MODEL"] = "acct/model"
        os.environ["HUMANSTUDY_SIM_MODEL"] = "sim/model"
        H.chat([{"role": "user", "content": "x"}])
        self.assertEqual(FakeProxy.calls[0]["body"]["model"], "sim/model")
        del os.environ["HUMANSTUDY_SIM_MODEL"], os.environ["HUMANSTUDY_MODEL"]
        self.assertEqual(H.model_name(), H.DEFAULT_MODEL)

    def test_retries_429(self):
        FakeProxy.fail_first = 2
        self.assertEqual(H.llm("again"), "reply:again")
        self.assertEqual(len(FakeProxy.calls), 3)
        self.assertEqual(self.log()[0]["attempts"], 3)

    def test_gives_up_and_logs_failure(self):
        FakeProxy.fail_first = 99
        with self.assertRaises(H.LLMError) as cm:
            H.llm("never")
        self.assertEqual(cm.exception.status, 429)
        self.assertEqual(len(FakeProxy.calls), H.MAX_ATTEMPTS)
        self.assertFalse(self.log()[0]["ok"])

    def test_concurrency_cap(self):
        os.environ["HUMANSTUDY_LLM_CONCURRENCY"] = "2"
        out = H.llm_many([f"p{i}" for i in range(8)], workers=8)
        self.assertEqual(out, [f"reply:p{i}" for i in range(8)])
        self.assertLessEqual(FakeProxy.peak, 2)
        self.assertEqual(len(self.log()), 8)

    def test_missing_config_never_leaks(self):
        del os.environ["HUMANSTUDY_DESKTOP_KEY"]
        with self.assertRaises(H.LLMConfigError):
            H.llm("x")
        self.assertEqual(FakeProxy.calls, [])


@unittest.skipUnless(HAVE_PDF, "pdfplumber / pypdf not available (run with the research runtime python)")
class PdfTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.pdf = os.path.join(self.dir, "p.pdf")
        Path(self.pdf).write_bytes(make_pdf(["Alpha one", "Beta two", "", "Delta four"]))

    def run_tool(self, tool, *args):
        out, err = io.StringIO(), io.StringIO()

        class B:  # stdout with a .buffer like the real one
            def __init__(s):
                s.buffer = io.BytesIO()

            def flush(s):
                pass

            def write(s, x):
                s.buffer.write(x.encode())

        b = B()
        old = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = b, err
        try:
            rc = T.main([tool, *args])
        finally:
            sys.stdout, sys.stderr = old
        return rc, b.buffer.getvalue().decode(), err.getvalue()

    def test_arg_parsing(self):
        o = T.parse_pdftotext_args(["-layout", "-f", "2", "-l", "3", "a.pdf", "-"])
        self.assertEqual((o["layout"], o["first"], o["last"], o["pdf"], o["out"]), (True, 2, 3, "a.pdf", "-"))
        self.assertEqual(T.parse_pdftotext_args(["a.pdf"])["out"], "a.txt")
        self.assertEqual(T.parse_pdftotext_args(["-enc", "UTF-8", "-nopgbrk", "x/a.PDF", "o.txt"])["out"], "o.txt")
        with self.assertRaises(T.ToolError):
            T.parse_pdftotext_args(["-f"])
        with self.assertRaises(T.ToolError):
            T.parse_pdftotext_args(["-f", "x", "a.pdf"])
        with self.assertRaises(T.ToolError):
            T.parse_pdftotext_args(["--bogus", "a.pdf"])
        with self.assertRaises(T.ToolError):
            T.parse_pdftotext_args([])

    def test_pdftotext_form_feeds(self):
        rc, out, _ = self.run_tool("pdftotext", "-layout", self.pdf, "-")
        self.assertEqual(rc, 0)
        pages = out.split("\f")
        self.assertEqual(pages.pop(), "")  # poppler: every page, including the last, ends with \f
        self.assertEqual(len(pages), 4)
        self.assertIn("Alpha one", pages[0])
        self.assertIn("Delta four", pages[3])
        self.assertEqual(pages[2].strip(), "")

    def test_pdftotext_range_and_file_output(self):
        rc, out, _ = self.run_tool("pdftotext", "-f", "2", "-l", "2", self.pdf, "-")
        self.assertEqual(out.count("\f"), 1)
        self.assertIn("Beta two", out)
        dest = os.path.join(self.dir, "o.txt")
        self.assertEqual(self.run_tool("pdftotext", self.pdf, dest)[0], 0)
        self.assertIn("Alpha one", Path(dest).read_text())

    def test_pdfinfo(self):
        rc, out, _ = self.run_tool("pdfinfo", self.pdf)
        self.assertEqual(rc, 0)
        self.assertRegex(out, r"(?m)^Pages:\s+4$")
        self.assertRegex(out, r"(?m)^Title:\s+Test Paper$")

    def test_hs_pdf_pages(self):
        rc, out, err = self.run_tool("hs-pdf", "pages", self.pdf)
        self.assertEqual(rc, 0)
        self.assertIn("=== page 1 ===\nAlpha one", out)
        self.assertIn("=== page 4 ===", out)
        self.assertIn("no text on page(s) 3", err)
        out2 = self.run_tool("hs-pdf", "pages", self.pdf, "--from", "2", "--to", "2")[1]
        self.assertTrue(out2.startswith("=== page 2 ==="))
        self.assertNotIn("page 1", out2)

    def test_errors_exit_1(self):
        rc, _, err = self.run_tool("pdftotext", "/nonexistent.pdf", "-")
        self.assertEqual(rc, 1)
        self.assertIn("Couldn't open", err)
        self.assertEqual(self.run_tool("pdfinfo", "/nonexistent.pdf")[0], 1)


if __name__ == "__main__":
    unittest.main()
