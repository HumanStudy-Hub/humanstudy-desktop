"""Filling in a published study's original wording on this computer (lib/hs_original_text.py over the vendored
hsenv.rehydrate). The fixture is invented (fixtures/original_text, CC0-1.0): a made-up morning-walk study with a
link-tier text handout, a user-tier HTML booklet and a user-tier PDF leaflet.
   python -m unittest discover -s pack/runtime/tests     (with the runtime python: the PDF cases need pypdfium2)"""
import contextlib
import io
import json
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNTIME = HERE.parent
FIX = HERE / "fixtures" / "original_text"
sys.path.insert(0, str(RUNTIME / "lib"))
sys.path.insert(0, str(RUNTIME / "hsenv"))
import hs_original_text as O  # noqa: E402
from hsenv import distribution as D  # noqa: E402

try:
    import pypdfium2  # noqa: F401
    HAVE_PDFIUM = True
except ImportError:
    HAVE_PDFIUM = False

TEXTS = {   # what each held item must read once filled in (the fixture's own invented wording)
    "/stages/intro/content/0/value": "Thank you for joining this short study about walking before breakfast.",
    "/stages/intro/content/1/value": "Remember to drink a glass of water first.",
    "/stages/q/responses/0/prompt": "How many minutes did you walk this morning?",
    "/stages/q/responses/1/prompt": "Did you see a neighbour on the way?",
}


class Server:
    """A local publisher: serves `files` {path: bytes}; anything else is 404 (a dead link)."""

    def __init__(self, files):
        files_ = files

        class H(BaseHTTPRequestHandler):
            def do_GET(self):   # noqa: N802
                body = files_.get(self.path)
                self.send_response(200 if body is not None else 404)
                self.end_headers()
                if body is not None:
                    self.wfile.write(body)

            def log_message(self, *a):
                pass
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def get(doc, path):
    for p in path.split("/")[1:]:
        doc = doc[int(p)] if isinstance(doc, list) else doc[p]
    return doc


class OriginalText(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cache = self.tmp / "cache"
        self.files = self.tmp / "project" / "sources" / "private"
        self.files.mkdir(parents=True)
        self.server = Server({"/handout.txt": (FIX / "handout.txt").read_bytes()})
        self.addCleanup(self.server.close)
        self.projection = self.published(self.server.url + "/handout.txt")

    def published(self, url):
        p = json.loads((FIX / "protocol.json").read_text(encoding="utf-8"))
        p["meta"]["sources"]["handout"]["distribution"]["url"] = url
        path = self.tmp / ("protocol-%d.json" % len(list(self.tmp.glob("protocol-*.json"))))
        path.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
        return path

    def drop(self, name, data=None):
        f = self.files / name
        f.write_bytes(data if data is not None else (FIX / name).read_bytes())
        return f

    def run_helper(self, protocol=None, files=(), extra=("--allow-local",)):
        args = [str(RUNTIME / "hsenv"), str(protocol or self.projection), str(self.cache)]
        for f in files:
            args += ["--file", str(f)]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(O.main(args + list(extra)), 0)
        return json.loads(out.getvalue().strip().splitlines()[-1])

    def by_key(self, st):
        return {s["key"]: s for s in st["sources"]}

    def test_fixture_is_a_published_study(self):
        p = json.loads((FIX / "protocol.json").read_text(encoding="utf-8"))
        self.assertEqual(p["distribution"]["format"], "hsenv-projection/1")
        self.assertEqual(len(p["distribution"]["held"]), 4)
        for path, text in TEXTS.items():
            self.assertEqual(get(p, path), D.PLACEHOLDER * len(text), "no wording ships in the fixture")

    @unittest.skipUnless(HAVE_PDFIUM, "needs pypdfium2 (the runtime python)")
    def test_link_downloaded_and_dropped_files_fill_in_every_screen(self):
        st = self.run_helper(files=[self.drop("booklet.html"), self.drop("leaflet.pdf")])
        self.assertTrue(st["complete"], st)
        self.assertEqual((st["items"], st["restored"], st["screens"]), (4, 4, 0))
        restored = json.loads(Path(st["restoredPath"]).read_text(encoding="utf-8"))
        self.assertNotIn("distribution", restored)
        for path, text in TEXTS.items():
            self.assertEqual(get(restored, path), text)
        # the restored copy and the download live in the cache (app storage), never next to the project
        self.assertTrue(Path(st["restoredPath"]).is_relative_to(self.cache))
        self.assertEqual(len(list((self.cache / "downloads").iterdir())), 1)
        self.assertFalse(any("Thank you for joining" in p.read_text(errors="ignore")
                             for p in (self.tmp / "project").rglob("*") if p.is_file() and p.suffix != ".html"))
        # the status carries no wording
        self.assertNotIn("Thank you", json.dumps(st))
        # a second check is answered from the cache without downloading again
        self.server.close()
        again = self.run_helper(files=[])
        self.assertTrue(again["complete"] and again.get("cached"))
        self.assertEqual(again["restoredPath"], st["restoredPath"])

    def test_missing_user_file_leaves_screens_empty_and_says_which(self):
        st = self.run_helper(files=[])
        self.assertFalse(st["complete"])
        self.assertIsNone(st["restoredPath"])
        src = self.by_key(st)
        self.assertEqual(src["handout"]["restored"], 1, "the link source was downloaded")
        self.assertNotIn("need", src["handout"])
        self.assertEqual((src["booklet"]["need"], src["booklet"]["screens"], src["booklet"]["title"]),
                         ("file", 1, "Walking booklet"))
        self.assertEqual(src["booklet"]["format"], "html")
        self.assertFalse((self.cache / st["projectionSha256"] / "protocol.json").exists(), "no partial copy is kept")

    def test_hash_mismatch_leaves_the_item_unresolved(self):
        changed = (FIX / "booklet.html").read_bytes().replace(b"this morning", b"this evening")
        st = self.run_helper(files=[self.drop("booklet.html", changed)])
        src = self.by_key(st)
        self.assertFalse(st["complete"])
        # one prompt still matches, the edited one never does: other wording can never reach a screen
        self.assertEqual(src["booklet"]["restored"], 1)
        self.assertEqual(src["booklet"]["need"], "wrong-file")
        self.assertIsNone(st["restoredPath"])

    def test_a_changed_file_online_is_not_served(self):
        server = Server({"/handout.txt": (FIX / "handout.txt").read_bytes().replace(b"short study", b"long study")})
        self.addCleanup(server.close)
        st = self.run_helper(protocol=self.published(server.url + "/handout.txt"), files=[])
        self.assertEqual(self.by_key(st)["handout"]["restored"], 0)
        self.assertEqual(self.by_key(st)["handout"]["need"], "changed-online")

    def test_dead_link_then_the_researchers_copy(self):
        dead = self.published(self.server.url + "/gone.txt")
        st = self.run_helper(protocol=dead, files=[])
        self.assertEqual(self.by_key(st)["handout"]["need"], "download")
        self.assertEqual(st["downloadsFailed"], 1)
        # the researcher drops their copy: the link source is filled from it, and the dead link is not asked again
        st = self.run_helper(protocol=dead, files=[self.drop("handout.txt")])
        self.assertEqual(self.by_key(st)["handout"]["restored"], 1)
        self.assertTrue(self.by_key(st)["handout"]["file"].endswith("handout.txt"))
        self.assertEqual(st["downloadsFailed"], 0, "a recent failure is remembered, not retried")

    def test_without_a_pdf_reader_text_and_html_still_work(self):
        original = O.pdf_extractors
        O.pdf_extractors = lambda: {}
        self.addCleanup(setattr, O, "pdf_extractors", original)
        st = self.run_helper(files=[self.drop("booklet.html"), self.drop("leaflet.pdf")])
        src = self.by_key(st)
        self.assertFalse(st["complete"])
        self.assertFalse(st["pdfReader"])
        self.assertEqual((src["handout"]["restored"], src["booklet"]["restored"]), (1, 2))
        self.assertEqual(src["leaflet"]["need"], "pdf-reader")

    def test_a_pdf_from_another_reader_version_asks_for_a_newer_app(self):
        p = json.loads(self.projection.read_text(encoding="utf-8"))
        p["distribution"]["held"]["h2"]["locator"]["extractor"] = "pypdfium2/99.0+pdfium/1.0"
        path = self.tmp / "other.json"
        path.write_text(json.dumps(p), encoding="utf-8")
        st = self.run_helper(protocol=path, files=[self.drop("leaflet.pdf")])
        if HAVE_PDFIUM:
            self.assertEqual(self.by_key(st)["leaflet"]["need"], "app-version")

    def test_local_addresses_are_refused_unless_allowed(self):
        st = self.run_helper(files=[], extra=())
        self.assertEqual(self.by_key(st)["handout"]["need"], "download")

    def test_only_http_links_are_fetched(self):
        fetch = O.make_fetch(self.cache, allow_local=True)
        with self.assertRaises(ValueError):
            fetch((FIX / "handout.txt").as_uri())

    def test_an_ordinary_protocol_needs_nothing(self):
        path = self.tmp / "plain.json"
        path.write_text(json.dumps({"id": "x", "stages": {}}), encoding="utf-8")
        self.assertEqual(self.run_helper(protocol=path), {"version": O.STATUS_VERSION, "projection": False})


class Runtime(unittest.TestCase):
    def test_the_runtime_ships_the_pdf_reader_hsenv_pins(self):
        lock = (RUNTIME / "requirements.lock").read_text(encoding="utf-8")
        self.assertRegex(lock, r"(?m)^pypdfium2==\d")
        self.assertTrue(D.PDF_EXTRACTOR_FAMILY.startswith("pypdfium2/"))


if __name__ == "__main__":
    unittest.main()
