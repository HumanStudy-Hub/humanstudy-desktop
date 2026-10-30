"""Human-data keys and reproduce_paper (issue #45 milestone 2): data come from their source, pinned by sha256.
   python -m unittest discover -s pack/runtime/tests"""
import hashlib
import http.server
import json
import os
import shutil
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_agent_package import REPO, make_project  # noqa: E402

sys.path.insert(0, str(REPO / "pack/skills/export/agent"))
import study_core  # noqa: E402

DATA = b"arm,answer\ncondition-harm,yes\ncondition-harm,yes\ncondition-help,no\n"
LOADER = '''import csv, os
SOURCE = "test.csv from the test server"
EXCLUSIONS = "none"
NOT_MAPPED = []
def load(data_dir):
    with open(os.path.join(data_dir, "test.csv"), newline="") as f:
        rows = list(csv.DictReader(f))
    return [{"condition": r["arm"], "arm": r["arm"], "participant": i, "answer": r["answer"], "source": "human"}
            for i, r in enumerate(rows)]
def key_effects(evaluation):
    harm = evaluation["yes"].get("condition-harm", {"yes": 0, "n": 1})
    return [{"id": "harm_yes", "label": "share yes in harm", "estimate": harm["yes"] / harm["n"], "p": None,
             "reported": REPORTED}]
'''


class Server:
    def __init__(self, routes):
        routes_ = routes

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = routes_.get(self.path)
                if body is None:
                    self.send_response(404); self.end_headers(); return
                self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass
        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]

    def close(self):
        self.httpd.shutdown()


class HumanData(unittest.TestCase):
    def setUp(self):
        self.root = make_project()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.routes = {"/test.csv": DATA}
        self.server = Server(self.routes)
        self.addCleanup(self.server.close)
        os.environ.pop("HUMANSTUDY_HUMAN_DATA", None)

    def key(self, reported=1.0, sample="original", url="/test.csv", sha=None):
        human = self.root / "package/knobe/human"
        human.mkdir(exist_ok=True)
        (human / "human_sessions.py").write_text(LOADER.replace("REPORTED", repr(reported)))
        (human / "key.json").write_text(json.dumps({"schemaVersion": 1, "loader": "human_sessions.py", "sample": sample,
            "files": [{"path": "test.csv", "sha256": sha or hashlib.sha256(DATA).hexdigest(), "role": "data",
                       "url": self.server.url + url if url else None}]}))
        return study_core.Study(str(self.root))

    def test_fetches_from_source_and_reproduces(self):
        s = self.key()
        data = s.get_human_data()
        self.assertEqual(data["status"], "ok")
        self.assertEqual((self.root / "human-data/test.csv").read_bytes(), DATA)
        rep = s.reproduce_paper()
        self.assertEqual((rep["verdict"], rep["recovered"], rep["humanSessions"]), ("pass", [1, 1], 3))
        self.assertNotIn("caveat", rep)

    def test_a_replication_sample_is_labelled_and_a_miss_is_a_fail(self):
        rep = self.key(reported=0.4, sample="replication").reproduce_paper()
        self.assertEqual(rep["verdict"], "fail")
        self.assertIn("replication", rep["caveat"])

    def test_changed_source_is_kept_aside_and_never_used(self):
        s = self.key(sha="0" * 64)
        data = s.get_human_data()
        self.assertEqual(data["status"], "changed")
        self.assertFalse((self.root / "human-data/test.csv").exists())
        self.assertTrue((self.root / "human-data/test.csv.changed").exists())
        with self.assertRaises(study_core.Refusal) as ctx:
            s.reproduce_paper()
        self.assertEqual(ctx.exception.capability, "humanData")

    def test_files_inside_a_zip_are_extracted_and_checked(self):
        import io
        import zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("Exp2/test.csv", DATA)
            z.writestr("Exp1/test.csv", b"other")
        self.routes["/data.zip"] = buf.getvalue()
        s = self.key(url="/data.zip")
        key = json.loads((self.root / "package/knobe/human/key.json").read_text())
        key["files"][0]["archiveMember"] = "Exp2/test.csv"
        (self.root / "package/knobe/human/key.json").write_text(json.dumps(key))
        s = study_core.Study(str(self.root))
        self.assertEqual(s.get_human_data()["status"], "ok")
        self.assertEqual((self.root / "human-data/test.csv").read_bytes(), DATA)
        (self.root / "human-data/test.csv").unlink()
        key["files"][0]["archiveMember"] = "Exp3/test.csv"
        (self.root / "package/knobe/human/key.json").write_text(json.dumps(key))
        self.assertEqual(study_core.Study(str(self.root)).get_human_data()["status"], "changed")

    def test_withdrawn_unavailable_and_no_key(self):
        self.assertEqual(self.key(url="/gone.csv").get_human_data()["status"], "withdrawn")
        data = self.key(url=None).get_human_data()
        self.assertEqual(data["status"], "unavailable")
        self.assertTrue(data["next_steps"])
        (self.root / "package/knobe/human/key.json").unlink()
        with self.assertRaises(study_core.Refusal):
            study_core.Study(str(self.root)).get_human_data()

    def test_never_downloads_into_a_git_repository(self):
        (self.root / ".git").mkdir()
        home = self.root / "home"
        old = {k: os.environ.get(k) for k in ("HOME", "USERPROFILE")}
        os.environ.update(HOME=str(home), USERPROFILE=str(home))  # Path.home() on POSIX and Windows
        try:
            s = self.key()
            self.assertEqual(s.get_human_data()["status"], "ok")
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.assertFalse((self.root / "human-data").exists())
        self.assertTrue(list(home.glob(".humanstudy/human-data/*/test.csv")))

    def test_unsafe_paths_and_author_method_are_refused(self):
        s = self.key()
        with self.assertRaises(study_core.Refusal) as ctx:
            s.reproduce_paper("author")
        self.assertEqual(ctx.exception.capability, "authorCode")
        key = json.loads((self.root / "package/knobe/human/key.json").read_text())
        key["files"][0]["path"] = "../outside.csv"
        (self.root / "package/knobe/human/key.json").write_text(json.dumps(key))
        with self.assertRaises(study_core.Refusal):
            study_core.Study(str(self.root)).get_human_data()


if __name__ == "__main__":
    unittest.main()
