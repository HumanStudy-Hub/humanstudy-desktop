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
import hs_approx_text as A  # noqa: E402
import hs_original_text as O  # noqa: E402
from hsenv import distribution as D  # noqa: E402

def _pdf_reader_matches():
    """pypdfium2 is installed AND is the version the fixture's PDF locator was written with (the lock's pin); another
    version is a different extractor, which hsenv refuses by design: those cases skip instead of failing."""
    try:
        name = D.pdfium_extractor().name
    except ImportError:
        return False
    held = json.loads((FIX / "protocol.json").read_text(encoding="utf-8"))["distribution"]["held"]
    return all(h["locator"]["extractor"] == name for h in held.values() if h.get("locator", {}).get("format") == "pdf")


HAVE_PDFIUM = _pdf_reader_matches()

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


class Published(unittest.TestCase):
    """A project with the published fixture and a local publisher (helpers only)."""

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


class OriginalText(Published):
    def test_fixture_is_a_published_study(self):
        p = json.loads((FIX / "protocol.json").read_text(encoding="utf-8"))
        self.assertEqual(p["distribution"]["format"], "hsenv-projection/1")
        self.assertEqual(len(p["distribution"]["held"]), 4)
        for path, text in TEXTS.items():
            self.assertEqual(get(p, path), D.PLACEHOLDER * len(text), "no wording ships in the fixture")

    @unittest.skipUnless(HAVE_PDFIUM, "needs the locked pypdfium2 (the runtime python)")
    def test_link_downloaded_and_dropped_files_fill_in_every_screen(self):
        st = self.run_helper(files=[self.drop("booklet.html"), self.drop("leaflet.pdf")])
        self.assertTrue(st["complete"], st)
        self.assertEqual((st["items"], st["restored"], st["screens"]), (4, 4, 0))
        # the cached copy's bytes are exactly what its record names (no newline translation on Windows)
        raw = Path(st["restoredPath"]).read_bytes()
        self.assertEqual(O.sha256(raw), st["restoredSha256"])
        self.assertNotIn(b"\r\n", raw)
        restored = json.loads(raw.decode("utf-8"))
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

    def test_a_sign_in_page_is_a_failed_download(self):
        server = Server({"/handout.txt": b"<!DOCTYPE html><html><body>Please sign in to read this article</body></html>"})
        self.addCleanup(server.close)
        st = self.run_helper(protocol=self.published(server.url + "/handout.txt"), files=[])
        self.assertEqual(self.by_key(st)["handout"]["need"], "download")
        self.assertEqual(st["downloadsFailed"], 1)

    def test_a_trickling_server_is_cut_off_at_the_deadline_and_remembered(self):
        import time as _t
        stop = threading.Event()

        class Slow(BaseHTTPRequestHandler):
            def do_GET(self):   # noqa: N802 - one byte every 0.7 s, for as long as the client listens
                self.send_response(200)
                self.end_headers()
                try:
                    while not stop.is_set():
                        self.wfile.write(b"x")
                        self.wfile.flush()
                        _t.sleep(0.7)
                except OSError:
                    pass

            def log_message(self, *a):
                pass
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Slow)
        httpd.daemon_threads = True
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        self.addCleanup(stop.set)
        url = "http://127.0.0.1:%d/handout.txt" % httpd.server_address[1]
        for name, value in (("DOWNLOAD_DEADLINE", 2), ("DOWNLOAD_TIMEOUT", 30)):
            self.addCleanup(setattr, O, name, getattr(O, name))
            setattr(O, name, value)
        started = _t.monotonic()
        st = self.run_helper(protocol=self.published(url), files=[])
        elapsed = _t.monotonic() - started
        self.assertLess(elapsed, 2 + 1.5, "the download stops at its deadline, not when the server closes")
        self.assertEqual(self.by_key(st)["handout"]["need"], "download")
        failed = list((self.cache / "downloads").glob("*.failed"))
        self.assertEqual(len(failed), 1)
        self.assertIn("TimeoutError", failed[0].read_text(encoding="utf-8"))

    def test_an_unresolvable_host_is_not_public(self):
        self.assertFalse(O._public_host("https://no-such-host.invalid/x.txt"))

    def test_a_download_that_restores_nothing_is_not_kept(self):
        server = Server({"/handout.txt": b"Morning Walk Survey\nAn entirely different handout text.\n"})
        self.addCleanup(server.close)
        path = self.published(server.url + "/handout.txt")
        for _ in range(2):   # the second check says the same, from the remembered failure
            st = self.run_helper(protocol=path, files=[])
            self.assertEqual(self.by_key(st)["handout"]["need"], "changed-online")
        self.assertFalse([f for f in (self.cache / "downloads").iterdir() if not f.name.endswith(".failed")],
                         "a page that restored nothing is not cached")

    def test_redirects_to_this_computer_are_refused(self):
        import urllib.error
        import urllib.request
        h = O._NoDowngrade()
        req = urllib.request.Request("https://example.org/a.txt")
        for target in ("http://127.0.0.1:8080/x", "https://169.254.169.254/latest", "http://10.1.2.3/x", "file:///etc/hosts"):
            with self.assertRaises(urllib.error.HTTPError, msg=target):
                h.redirect_request(req, None, 302, "Found", {}, target)

    def test_a_held_picture_keeps_the_study_from_running(self):
        p = json.loads(self.projection.read_text(encoding="utf-8"))
        p["stages"]["intro"]["content"].append({"id": "pic", "value": {"src": "assets/walk.png", "sha256": "ab" * 32}})
        p["distribution"]["held"]["h9"] = {"path": "/stages/intro/content/2/value", "source": "booklet", "kind": "image",
                                          "sha256": "ab" * 32}
        path = self.tmp / "picture.json"
        path.write_text(json.dumps(p), encoding="utf-8")
        st = self.run_helper(protocol=path, files=[self.drop("booklet.html"), self.drop("leaflet.pdf")])
        self.assertFalse(st["complete"])
        self.assertIsNone(st["restoredPath"])
        self.assertEqual(self.by_key(st)["booklet"]["need"], "picture")

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


class ApproxAndFills(Published):
    """The two tiers after the exact one: approximate (the release's fingerprint located in the researcher's own PDF)
    and supplied (the project's fills file, origin "user" or "reconstructed"). Exact > approx > fill."""
    LEAFLET = TEXTS["/stages/intro/content/1/value"]

    def variant(self, edit):
        p = json.loads(self.projection.read_text(encoding="utf-8"))
        edit(p["distribution"]["held"])
        path = self.tmp / ("variant-%d.json" % len(list(self.tmp.glob("variant-*.json"))))
        path.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
        return path

    def fills(self, data):
        f = self.tmp / "project" / "sources" / "private" / "original-text-fills.json"
        f.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return f

    def run_fills(self, protocol, files=(), fills=None):
        extra = ["--allow-local"] + (["--fills", str(fills)] if fills is not None else [])
        return self.run_helper(protocol=protocol, files=files, extra=extra)

    def ocr_corrected(self, held):
        """h2 as a release whose wording was corrected by the build team: the exact hash no longer matches the PDF."""
        held["h2"]["text_sha256"] = "0" * 64
        held["h2"]["approx"] = A.fingerprint(self.LEAFLET, [2], salt="5a1t")

    def restored(self, st):
        return json.loads(Path(st["restoredPath"]).read_text(encoding="utf-8"))

    def assert_no_text(self, st, *texts):
        dumped = json.dumps(st, ensure_ascii=False)
        for t in texts:
            for piece in (t, t[:20], t[-20:]):
                self.assertNotIn(piece, dumped)

    @unittest.skipUnless(HAVE_PDFIUM, "needs the locked pypdfium2 (the runtime python)")
    def test_approx_restores_from_the_researchers_pdf_and_is_labelled(self):
        path = self.variant(self.ocr_corrected)
        st = self.run_fills(path, files=[self.drop("booklet.html"), self.drop("leaflet.pdf")])
        self.assertTrue(st["complete"], st)
        self.assertEqual((st["restored"], st["exact"], st["approx"]), (4, 3, 1))
        self.assertEqual(st["supplied"], {"user": 0, "reconstructed": 0})
        self.assertEqual(st["labels"], {"h2": "approx"})
        self.assertEqual(st["unresolved"], [])
        self.assertEqual(self.by_key(st)["leaflet"]["approx"], 1)
        self.assertEqual(get(self.restored(st), "/stages/intro/content/1/value"), self.LEAFLET)
        self.assertNotIn("distribution", self.restored(st))
        self.assert_no_text(st, self.LEAFLET, *TEXTS.values())

    @unittest.skipUnless(HAVE_PDFIUM, "needs the locked pypdfium2 (the runtime python)")
    def test_a_downloaded_pdf_with_no_exact_match_still_gives_the_approximate_text(self):
        server = Server({"/leaflet.pdf": (FIX / "leaflet.pdf").read_bytes()})
        self.addCleanup(server.close)
        p = json.loads(self.projection.read_text(encoding="utf-8"))
        self.ocr_corrected(p["distribution"]["held"])
        p["meta"]["sources"]["leaflet"]["distribution"].update(tier="link", url=server.url + "/leaflet.pdf", sha256="0" * 64)
        path = self.tmp / "link-pdf.json"
        path.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
        st = self.run_fills(path, files=[self.drop("booklet.html")])
        self.assertTrue(st["complete"], st)
        self.assertEqual(st["labels"], {"h2": "approx"})
        self.assertTrue(any(f.name.endswith(".failed") is False for f in (self.cache / "downloads").iterdir()),
                        "a download that gave approximate wording is kept")

    @unittest.skipUnless(HAVE_PDFIUM, "needs the locked pypdfium2 (the runtime python)")
    def test_approx_fetches_the_pdf_when_the_exact_pass_did_not(self):
        # a locator from another PDF reader version: the exact pass never downloads; the approximate one does
        server = Server({"/leaflet.pdf": (FIX / "leaflet.pdf").read_bytes()})
        self.addCleanup(server.close)
        p = json.loads(self.projection.read_text(encoding="utf-8"))
        self.ocr_corrected(p["distribution"]["held"])
        p["distribution"]["held"]["h2"]["locator"]["extractor"] = "pypdfium2/99.0+pdfium/1.0"
        p["meta"]["sources"]["leaflet"]["distribution"].update(tier="link", url=server.url + "/leaflet.pdf")
        path = self.tmp / "cold.json"
        path.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
        st = self.run_fills(path, files=[self.drop("booklet.html")])
        self.assertTrue(st["complete"], st)
        self.assertEqual(st["labels"], {"h2": "approx"})

    @unittest.skipUnless(HAVE_PDFIUM, "needs the locked pypdfium2 (the runtime python)")
    def test_an_exhausted_approx_budget_still_applies_the_fills(self):
        self.addCleanup(setattr, O, "APPROX_BUDGET", O.APPROX_BUDGET)
        O.APPROX_BUDGET = -1
        calls = []
        real = O.approx_pages
        self.addCleanup(setattr, O, "approx_pages", real)
        O.approx_pages = lambda *a, **k: (calls.append(1), real(*a, **k))[1]
        f = self.fills({"h2": {"text": "Drink some water first.", "origin": "user"}})
        st = self.run_fills(self.variant(self.ocr_corrected), files=[self.drop("booklet.html"), self.drop("leaflet.pdf")], fills=f)
        self.assertTrue(st["complete"], st)
        self.assertEqual(st["labels"], {"h2": "user"})
        self.assertEqual(calls, [], "out of time: no PDF is read or extracted for the approximate pass")

    def test_complementary_pdfs_each_place_their_passage(self):
        q0, q1 = TEXTS["/stages/q/responses/0/prompt"], TEXTS["/stages/q/responses/1/prompt"]

        def edit(held):
            for h, t in (("h3", q0), ("h4", q1)):
                held[h]["text_sha256"] = "0" * 64
                held[h]["approx"] = A.fingerprint(t, [1], salt="5a1t")
        real = O.approx_pages
        self.addCleanup(setattr, O, "approx_pages", real)
        O.approx_pages = lambda *a, **k: iter([(self.files / "one.pdf", ["Survey page. " + q0 + " End of page."]),
                                               (self.files / "two.pdf", ["Survey page. " + q1 + " End of page."])])
        st = self.run_fills(self.variant(edit), files=[self.drop("leaflet.pdf")])
        self.assertTrue(st["complete"], st)
        self.assertEqual(st["labels"], {"h3": "approx", "h4": "approx"})

    def test_a_restore_cut_short_is_not_reused(self):
        self.addCleanup(setattr, O, "APPROX_BUDGET", O.APPROX_BUDGET)
        O.APPROX_BUDGET = -1
        p = json.loads(self.projection.read_text(encoding="utf-8"))
        self.ocr_corrected(p["distribution"]["held"])
        path = self.tmp / "cut.json"
        path.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
        f = self.fills({"h2": {"text": "Drink some water first.", "origin": "user"}})
        st = self.run_fills(path, files=[self.drop("booklet.html")], fills=f)
        self.assertTrue(st["complete"])
        self.assertEqual(st["approxCut"], ["leaflet"])
        again = self.run_fills(path, files=[self.drop("booklet.html")], fills=f)
        self.assertFalse(again.get("cached"), "the approximate pass gets another chance")

    def test_two_partial_copies_together_restore_a_source(self):
        good = (FIX / "booklet.html").read_bytes()
        a = self.drop("booklet-a.html", good.replace(b"neighbour", b"friend"))     # verifies h3 only
        b = self.drop("booklet-b.html", good.replace(b"this morning", b"this evening"))   # verifies h4 only
        st = self.run_fills(self.projection, files=[a, b])
        self.assertEqual(self.by_key(st)["booklet"]["restored"], 2, st)
        restored = json.loads((self.cache / st["slot"] / "protocol.json").read_text(encoding="utf-8")) if st["complete"] else None
        if restored is not None:
            self.assertEqual(get(restored, "/stages/q/responses/0/prompt"), TEXTS["/stages/q/responses/0/prompt"])

    def test_a_stale_download_is_not_kept_because_a_local_copy_matched(self):
        stale = Server({"/booklet.html": b"<html><body><p>An unrelated page.</p></body></html>"})
        self.addCleanup(stale.close)
        p = json.loads(self.projection.read_text(encoding="utf-8"))
        url = stale.url + "/booklet.html"
        p["meta"]["sources"]["booklet"]["distribution"].update(tier="link", url=url)
        path = self.tmp / "stale.json"
        path.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
        partial = (FIX / "booklet.html").read_bytes().replace(b"this morning", b"this evening")
        st = self.run_fills(path, files=[self.drop("booklet.html", partial)])
        self.assertEqual(self.by_key(st)["booklet"]["restored"], 1, "the local copy restored one of two")
        key = O.sha256(url.encode("utf-8"))
        self.assertFalse((self.cache / "downloads" / key).exists(), "the stale download is asked for again later")

    @unittest.skipUnless(HAVE_PDFIUM, "needs the locked pypdfium2 (the runtime python)")
    def test_a_cold_download_that_gives_nothing_is_not_kept(self):
        other = Server({"/leaflet.pdf": (FIX / "leaflet.pdf").read_bytes()})
        self.addCleanup(other.close)
        p = json.loads(self.projection.read_text(encoding="utf-8"))
        self.ocr_corrected(p["distribution"]["held"])
        p["distribution"]["held"]["h2"]["approx"] = A.fingerprint("A sentence about cycling to work at dawn today.", [2], salt="x")
        p["distribution"]["held"]["h2"]["locator"]["extractor"] = "pypdfium2/99.0+pdfium/1.0"
        p["meta"]["sources"]["leaflet"]["distribution"].update(tier="link", url=other.url + "/leaflet.pdf", sha256="0" * 64)
        path = self.tmp / "cold-wrong.json"
        path.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
        st = self.run_fills(path, files=[self.drop("booklet.html")])
        self.assertFalse(st["complete"])
        key = O.sha256((other.url + "/leaflet.pdf").encode("utf-8"))
        self.assertFalse((self.cache / "downloads" / key).exists(), "a download no pass used is asked for again later")
        self.assertTrue((self.cache / "downloads" / (key + ".failed")).exists())

    @unittest.skipUnless(HAVE_PDFIUM, "needs the locked pypdfium2 (the runtime python)")
    def test_a_download_the_approx_pass_had_no_time_for_is_kept(self):
        server = Server({"/leaflet.pdf": (FIX / "leaflet.pdf").read_bytes()})
        self.addCleanup(server.close)
        self.addCleanup(setattr, O, "APPROX_BUDGET", O.APPROX_BUDGET)
        O.APPROX_BUDGET = -1
        p = json.loads(self.projection.read_text(encoding="utf-8"))
        self.ocr_corrected(p["distribution"]["held"])
        url = server.url + "/leaflet.pdf"
        p["meta"]["sources"]["leaflet"]["distribution"].update(tier="link", url=url, sha256="0" * 64)
        path = self.tmp / "slow.json"
        path.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
        st = self.run_fills(path, files=[self.drop("booklet.html")])
        self.assertFalse(st["complete"])
        self.assertTrue((self.cache / "downloads" / O.sha256(url.encode("utf-8"))).exists(), "kept for the next check")

    @unittest.skipUnless(HAVE_PDFIUM, "needs the locked pypdfium2 (the runtime python)")
    def test_approx_is_not_placed_from_a_pdf_without_the_passage(self):
        other = (FIX / "leaflet.pdf").read_bytes()   # a fingerprint of a passage the PDF does not hold
        path = self.variant(lambda held: (self.ocr_corrected(held), held["h2"].update(
            approx=A.fingerprint("An entirely different sentence about cycling to work at dawn.", [2], salt="5a1t"))))
        st = self.run_fills(path, files=[self.drop("booklet.html"), self.drop("leaflet.pdf", other)])
        self.assertFalse(st["complete"])
        self.assertEqual([u["held"] for u in st["unresolved"]], ["h2"])

    def test_fills_restore_what_no_file_can(self):
        f = self.fills({"h3": {"text": TEXTS["/stages/q/responses/0/prompt"], "origin": "user", "note": "pasted"},
                        "h4": {"text": "Did you meet anyone you know on your walk?", "origin": "reconstructed",
                               "note": "the paper describes the item, does not print it"},
                        "_comment": "ignored"})
        original = O.pdf_extractors
        O.pdf_extractors = lambda: {}    # the leaflet stays unresolved (no PDF reader): it is listed, not filled
        self.addCleanup(setattr, O, "pdf_extractors", original)
        st = self.run_fills(self.projection, fills=f)
        self.assertFalse(st["complete"])
        # h3 is exactly the published text: exact, although it came from the fills file
        self.assertEqual(st["exact"], 2)
        self.assertEqual(st["supplied"], {"user": 0, "reconstructed": 1})
        self.assertEqual(st["labels"], {"h4": "reconstructed"})
        self.assertEqual(self.by_key(st)["booklet"]["restored"], 2)
        self.assertEqual(self.by_key(st)["booklet"]["reconstructed"], 1)
        self.assertNotIn("need", self.by_key(st)["booklet"])
        self.assertEqual(st["unresolved"], [{"held": "h2", "screen": "stage:intro", "path": "/stages/intro/content/1/value",
                                             "source": "leaflet", "title": "Water leaflet", "kind": "text", "length": 41,
                                             "need": "pdf-reader"}])
        self.assertEqual(st["fills"], {"file": O.FILLS, "present": True, "problems": []})
        self.assert_no_text(st, "Did you meet anyone", *TEXTS.values())
        # now the leaflet is supplied too: complete, and the restored copy holds the supplied wording
        f = self.fills({"h3": {"text": "How many minutes did you walk today?", "origin": "user"},
                        "h4": {"text": "Did you meet anyone you know on your walk?", "origin": "reconstructed"},
                        "h2": {"text": "Drink some water before you go.", "origin": "user"}})
        st = self.run_fills(self.projection, fills=f)
        self.assertTrue(st["complete"], st)
        self.assertEqual((st["exact"], st["supplied"]), (1, {"user": 2, "reconstructed": 1}))
        restored = self.restored(st)
        self.assertEqual(get(restored, "/stages/q/responses/1/prompt"), "Did you meet anyone you know on your walk?")
        self.assertEqual(get(restored, "/stages/q/responses/0/prompt"), "How many minutes did you walk today?")
        # the cached copy is reused only while the fills file is unchanged
        again = self.run_fills(self.projection, fills=f)
        self.assertTrue(again.get("cached"))
        f.write_text("{}", encoding="utf-8")
        st = self.run_fills(self.projection, fills=f)
        self.assertFalse(st["complete"])
        self.assertFalse(st.get("cached"))
        self.assertIsNone(st["restoredPath"])

    @unittest.skipUnless(HAVE_PDFIUM, "needs the locked pypdfium2 (the runtime python)")
    def test_precedence_exact_then_approx_then_fill(self):
        def edit(held):
            self.ocr_corrected(held)
            held["h1"]["approx"] = A.fingerprint(TEXTS["/stages/intro/content/0/value"], [1], salt="5a1t")
        f = self.fills({"h1": {"text": "Some other greeting for the handout screen.", "origin": "reconstructed"},
                        "h2": {"text": "A fill that loses to the approximate text.", "origin": "user"},
                        "h3": {"text": "A fill that loses to the exact text.", "origin": "reconstructed"}})
        st = self.run_fills(self.variant(edit), files=[self.drop("booklet.html"), self.drop("leaflet.pdf")], fills=f)
        self.assertTrue(st["complete"], st)
        self.assertEqual(st["labels"], {"h2": "approx"})
        restored = self.restored(st)
        self.assertEqual(get(restored, "/stages/intro/content/0/value"), TEXTS["/stages/intro/content/0/value"])
        self.assertEqual(get(restored, "/stages/intro/content/1/value"), self.LEAFLET)
        self.assertEqual(get(restored, "/stages/q/responses/0/prompt"), TEXTS["/stages/q/responses/0/prompt"])

    def test_invalid_fills_are_reported_without_their_text(self):
        f = self.fills({"h3": {"text": "   ", "origin": "user"}, "h4": {"text": "Secret pasted words here", "origin": "ai"},
                        "h99": {"text": "Secret pasted words here", "origin": "user"},
                        "h2": {"text": "Has ░░ placeholders", "origin": "user"}})
        st = self.run_fills(self.projection, fills=f)
        self.assertEqual(sorted((p["held"], p["why"]) for p in st["fills"]["problems"]), [
            ("h2", "text contains placeholder characters"), ("h3", "text must be a non-empty string"),
            ("h4", 'origin must be "user" or "reconstructed"'), ("h99", "no held item has this id")])
        self.assertEqual(st["supplied"], {"user": 0, "reconstructed": 0})
        self.assert_no_text(st, "Secret pasted words here")
        bad = self.tmp / "project" / "sources" / "private" / "original-text-fills.json"
        bad.write_text("not json", encoding="utf-8")
        st = self.run_fills(self.projection, fills=bad)
        self.assertEqual(st["fills"]["problems"], [{"held": None, "why": "the fills file is not valid JSON"}])

    def test_a_fill_much_longer_than_the_original_is_refused(self):
        # the relay charges a placeholder character 6 bytes (its JSON escape): a fill may cost no more than that
        why = "text is longer than the original passage allows (35 characters of placeholder)"
        for text, ok in (("w" * 210, True), ("w" * 211, False), ("\u8bcd" * 35, True), ("\u8bcd" * 36, False),
                         ('"' * 35, True), ('"' * 52, True), ('"' * 53, False),   # quotes: as render.py nests a prefill
                         ("e\u0301" * 35, True)):                       # NFC: 70 code points stored as 35
            st = self.run_fills(self.projection, fills=self.fills({"h4": {"text": text, "origin": "reconstructed"}}))
            self.assertEqual(st["fills"]["problems"], [] if ok else [{"held": "h4", "why": why}], text)

    def test_a_text_region_keeps_its_slot_for_a_transcription(self):
        # hsenv could render a held text's region as a picture into its slot; the app cannot show that, so the slot
        # keeps its placeholder, the item says "reading", and a pasted transcription that hashes exactly fills it
        p = json.loads(self.projection.read_text(encoding="utf-8"))
        p["distribution"]["held"]["h3"]["locator"] = {"format": "region", "page": 1, "x": 0, "y": 0, "w": 1, "h": 1}
        path = self.tmp / "region.json"
        path.write_text(json.dumps(p), encoding="utf-8")
        st = self.run_fills(path, files=[self.drop("booklet.html")])
        self.assertEqual([(u["held"], u["need"]) for u in st["unresolved"] if u["held"] == "h3"], [("h3", "reading")])
        st = self.run_fills(path, files=[self.drop("booklet.html")],
                            fills=self.fills({"h3": {"text": TEXTS["/stages/q/responses/0/prompt"], "origin": "user"}}))
        self.assertNotIn("h3", [u["held"] for u in st["unresolved"]])

    def test_two_projects_never_share_a_restored_copy(self):
        def project_run(key, text):
            f = self.fills({"h2": {"text": text, "origin": "user"}, "h3": {"text": "Minutes walked?", "origin": "user"},
                            "h4": {"text": "Neighbour seen?", "origin": "user"}})
            return self.run_helper(files=[], extra=["--allow-local", "--fills", str(f), "--project-key", key])
        a = project_run("a" * 64, "Drink water first.")
        b = project_run("b" * 64, "Have some tea first.")
        self.assertTrue(a["complete"] and b["complete"])
        self.assertNotEqual(a["slot"], b["slot"])
        self.assertEqual(a["slot"], O.restore_slot(a["projectionSha256"], "a" * 64))
        self.assertEqual(get(json.loads(Path(a["restoredPath"]).read_text(encoding="utf-8")), "/stages/intro/content/1/value"),
                         "Drink water first.")

    @unittest.skipUnless(HAVE_PDFIUM, "needs the locked pypdfium2 (the runtime python)")
    def test_a_copy_added_later_replaces_supplied_wording(self):
        f = self.fills({"h2": {"text": "Drink some water.", "origin": "user"}, "h3": {"text": "Minutes walked?", "origin": "user"},
                        "h4": {"text": "Neighbour seen?", "origin": "user"}})
        st = self.run_fills(self.projection, fills=f)
        self.assertEqual(st["supplied"]["user"], 3)
        st = self.run_fills(self.projection, files=[self.drop("booklet.html"), self.drop("leaflet.pdf")], fills=f)
        self.assertFalse(st.get("cached"), "the source files changed: restored again")
        self.assertEqual((st["exact"], st["labels"]), (4, {}))

    def test_a_fill_never_overwrites_anything_but_its_placeholder(self):
        p = json.loads(self.projection.read_text(encoding="utf-8"))
        p["distribution"]["held"]["h3"]["length"] = 7   # a tampered entry: the placeholder at its path is 43 long
        path = self.tmp / "tampered.json"
        path.write_text(json.dumps(p), encoding="utf-8")
        st = self.run_fills(path, fills=self.fills({"h3": {"text": "Overwritten", "origin": "user"}}))
        self.assertIn("h3", [u["held"] for u in st["unresolved"]])

    def test_user_fills_are_indexed_as_private(self):
        pasted = "How long did you walk this morning, and was the weather pleasant on your way to the park?"
        p, c = self.tmp / "proj2", self.tmp / "cache2"
        (p / "sources/private").mkdir(parents=True)
        dest = O.index_project(c, p, {"distribution": {"held": {}}}, [], {},
                               fills={"h1": {"text": pasted, "origin": "user"}, "h2": {"text": pasted + " x", "origin": "reconstructed"}})
        self.assertTrue(O._read_pairs(dest) & O.window_pairs(pasted))
        dest = O.index_project(c, p, {"distribution": {"held": {}}}, [], {},
                               fills={"h2": {"text": pasted, "origin": "reconstructed"}})
        self.assertEqual(O._read_pairs(dest), set(), "reconstructed text is the assistant's, not a source's")


class ApproxMatcher(unittest.TestCase):
    """hs_approx_text: a window scores the passage's DISTINCT trigrams it holds, so a repeated phrase cannot stand in
    for the words it lacks."""

    def test_a_repeated_phrase_is_not_the_passage(self):
        fp = A.fingerprint("red blue red blue green yellow", [1], salt="5a1t")
        self.assertIsNone(A.locate(["red blue red blue red blue"], fp))

    def test_the_exact_passage_scores_one(self):
        text = "Remember to drink a glass of water before you leave the house."
        fp = A.fingerprint(text, [2], salt="5a1t")
        got = A.locate(["A cover page about something else entirely.", "Leaflet. " + text + " Thank you."], fp)
        self.assertEqual(got, (text, 1.0))

    def test_a_misread_edge_word_is_never_trimmed_off(self):
        # an OCR error on the first or last word gives no trigram hit there; the window must not silently move by a
        # word and drop "Never" / "not": it keeps the passage's length and punctuation, or gives up (None)
        t = "Never share your personal details with strangers who contact you online."
        got = A.locate(["Safety tips. Neyer share your personal details with strangers who contact you online. Thanks."],
                       A.fingerprint(t, [1], salt="ab"))
        self.assertTrue(got is None or got[0].startswith("Neyer share"), got)
        t = "Please do not open the box until the experimenter tells you to do so now."
        got = A.locate(["Rules. Please do not open the box until the experimenter tells you to do so nqw. Next."],
                       A.fingerprint(t, [1], salt="ab"))
        self.assertIsNone(got, "a misread last word: the end of the passage is not established")
        got = A.locate(["Rules. Please do not open the box until the experimentor tells you to do so now. Next."],
                       A.fingerprint(t, [1], salt="ab"))
        self.assertEqual(got[0], "Please do not open the box until the experimentor tells you to do so now.",
                         "a misread word inside the passage is placed, with its reading error")
        t = "you must not press the red button before the signal sounds"
        fp = A.fingerprint(t, [1], salt="ab")
        self.assertIsNone(A.locate(["Rule one you must not press the red button before the signal squnds and then wait"], fp),
                          "no punctuation to tell where it ends: ambiguous")
        self.assertEqual(A.locate(["Rule one " + t + " and then wait"], fp), (t, 1.0))

    def test_a_passage_split_across_pages_is_not_cut(self):
        # "Do not" at the foot of one page, the rest on the next with a misread last word: never "open the box ..."
        t = "Do not open the box until the experimenter tells you to do so now."
        fp = A.fingerprint(t, [1, 2], salt="ab")
        got = A.locate(["Instructions for the session. Do not",
                        "open the box until the experimenter tells you to do so nqw. Then wait."], fp)
        self.assertTrue(got is None or got[0].startswith("Do not"), got)
        got = A.locate(["Instructions for the session. Do not",
                        "open the box until the experimenter tells you to do so n o w. Then wait."], fp)
        self.assertTrue(got is None or got[0].startswith("Do not"), "a word split by the reader is no stand-in")
        got = A.locate(["Instructions for the session. Do not",
                        "Page 12 open the box until the experimenter tells you to do so n o w. Then wait."], fp)
        self.assertTrue(got is None or got[0].startswith("Do not"), "nor a running header")
        got = A.locate(["Instructions for the session. Do not",
                        "Page 12 open the box until the experi menter tells you to do so now. Then wait."], fp)
        self.assertTrue(got is None or got[0].startswith("Do not"), "nor a split word inside")
        old = dict(fp)
        old.pop("ends")
        self.assertIsNone(A.locate(["Rules. Do not open the box until the experimentor tells you to do so now."], old))
        self.assertIsNone(A.locate(["Rules. " + t + " Next."], old), "a fingerprint without ends is never placed")

    def test_signs_and_operators_must_survive(self):
        for t, wrong, right in (("\u22125 points", "You lose 5 points here.", "You lose \u22125 points here."),
                                ("\u2264 5 minutes", "Wait 5 minutes.", "Wait \u2264 5 minutes."),
                                ("You lose -5 points if you press the red button now.",
                                 "Rules: You lose 5 points if you press the red button now. End",
                                 "Rules: You lose \u22125 points if you press the red button now. End"),
                                ("Join only if 5 \u2264 x holds for your age group today.",
                                 "Rules. Join only if 5 \u2265 x holds for your age group today. End",
                                 "Rules. Join only if 5 \u2264 x holds for your age group today. End")):
            fp = A.fingerprint(t, [1], salt="ab")
            self.assertIsNone(A.locate([wrong], fp), wrong)
            self.assertIsNotNone(A.locate([right], fp), right)
        self.assertIsNone(A.locate(["Wait 5 minutes."], {k: v for k, v in A.fingerprint("\u2264 5 minutes", [1], salt="ab").items()
                                                         if k != "nums"}), "no nums: never placed")

    def test_a_repeated_passage_is_not_clipped_at_a_perfect_score(self):
        t = "Do not move. Do not move. Stay calm."
        fp = A.fingerprint(t, [1], salt="ab")
        got = A.locate(["Header line. not move. Do not move. Stay calm. Footer words here."], fp)
        self.assertTrue(got is None or got[0].startswith("Do not"), got)
        t = "Do not move. Do not move. Do not move."
        got = A.locate(["Header line here. Do not move. Do not move. Footer words follow here."], A.fingerprint(t, [1], salt="ab"))
        self.assertIsNone(got, "two of three repetitions are not the passage")


class HeldPictures(Published):
    """A held picture: its released src is asset:<sha16> (never fetched, never rejected before filling); the fills file
    puts a screenshot or scan from the project in its place, exact when it is the published picture, else "user"."""
    PNG = b"\x89PNG\r\n\x1a\n" + b"published picture bytes"

    def picture_study(self):
        p = json.loads(self.projection.read_text(encoding="utf-8"))
        digest = O.sha256(self.PNG)
        p["stages"]["intro"]["content"].append({"id": "pic", "value": {"src": "asset:" + digest[:16]}})
        p["distribution"]["held"]["h9"] = {"path": "/stages/intro/content/2/value", "source": "booklet", "kind": "image",
                                          "sha256": digest}
        path = self.tmp / "picture.json"
        path.write_text(json.dumps(p), encoding="utf-8")
        return path

    def fill(self, entry):
        f = self.files / "original-text-fills.json"
        texts = {"h3": {"text": TEXTS["/stages/q/responses/0/prompt"], "origin": "user"},
                 "h4": {"text": TEXTS["/stages/q/responses/1/prompt"], "origin": "user"},
                 "h2": {"text": TEXTS["/stages/intro/content/1/value"], "origin": "user"}}
        f.write_text(json.dumps(dict(texts, h9=entry)), encoding="utf-8")
        return f

    def run_pic(self, path, entry):
        return self.run_helper(protocol=path, files=[], extra=["--allow-local", "--fills", str(self.fill(entry))])

    def test_unfilled_asset_src_stays_unresolved_and_loads(self):
        path = self.picture_study()
        st = self.run_helper(protocol=path, files=[])
        self.assertEqual([(u["held"], u["kind"], u["need"]) for u in st["unresolved"] if u["held"] == "h9"],
                         [("h9", "picture", "picture")])
        from hsenv import engine as E
        proto = E.Protocol(json.loads(path.read_text(encoding="utf-8")), self.tmp)
        src = proto.raw["stages"]["intro"]["content"][2]["value"]["src"]
        self.assertIsNone(proto.local_path(src), "an asset: src is just a missing file, never an error")
        self.assertTrue(proto.asset_ref(src).startswith("asset:"))

    def test_the_published_picture_is_exact(self):
        (self.files / "fig.png").write_bytes(self.PNG)
        st = self.run_pic(self.picture_study(), {"file": "project/sources/private/fig.png", "origin": "user"})
        self.assertTrue(st["complete"], st)
        self.assertEqual(st["labels"], {})
        restored = json.loads(Path(st["restoredPath"]).read_text(encoding="utf-8"))
        self.assertEqual(restored["stages"]["intro"]["content"][2]["value"]["src"], "project/sources/private/fig.png")

    def test_a_screenshot_is_supplied_by_the_user(self):
        (self.files / "shot.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"a screenshot of the figure")
        st = self.run_pic(self.picture_study(), {"file": "project/sources/private/shot.png", "origin": "user"})
        self.assertTrue(st["complete"], st)
        self.assertEqual(st["labels"], {"h9": "user"})
        self.assertEqual(st["supplied"]["user"], 1)

    def test_a_deleted_or_replaced_picture_restores_again(self):
        (self.files / "fig.png").write_bytes(self.PNG)
        path = self.picture_study()
        st = self.run_pic(path, {"file": "project/sources/private/fig.png", "origin": "user"})
        self.assertTrue(st["complete"] and st["labels"] == {})
        (self.files / "fig.png").write_bytes(b"\x89PNG\r\n\x1a\nanother picture")
        st = self.run_pic(path, {"file": "project/sources/private/fig.png", "origin": "user"})
        self.assertFalse(st.get("cached"))
        self.assertEqual(st["labels"], {"h9": "user"})
        (self.files / "fig.png").unlink()
        st = self.run_pic(path, {"file": "project/sources/private/fig.png", "origin": "user"})
        self.assertFalse(st["complete"])

    def test_bad_picture_files_are_refused(self):
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, outside, True)
        (outside / "x.png").write_bytes(self.PNG)
        (self.files / "link.png").symlink_to(outside / "x.png")
        (self.files / "notes.txt").write_text("not a picture", encoding="utf-8")
        (self.files / "fig.png").write_bytes(self.PNG)
        path = self.picture_study()
        for entry, why in (({"file": "project/sources/private/link.png", "origin": "user"}, "file must not be a link"),
                           ({"file": "../" + outside.name + "/x.png", "origin": "user"}, "file must be a path inside the project, like sources/private/figure.png"),
                           ({"file": str(outside / "x.png"), "origin": "user"}, "file must be a path inside the project, like sources/private/figure.png"),
                           ({"file": "project/sources/private/notes.txt", "origin": "user"}, "file is not a PNG, JPEG, GIF or WebP picture"),
                           ({"file": "project/sources/private/none.png", "origin": "user"}, "file not found in the project"),
                           ({"file": "project/sources/private/fig.png", "origin": "reconstructed"}, 'a picture\'s origin must be "user"'),
                           ({"text": "a description", "origin": "user"}, 'this item is a picture: give "file" (a screenshot or scan in the project), not text')):
            st = self.run_pic(path, entry)
            self.assertFalse(st["complete"], entry)
            self.assertEqual(st["fills"]["problems"], [{"held": "h9", "why": why}], entry)

    def test_the_run_accepts_only_the_project_picture_it_was_given(self):
        sys.path.insert(0, str(RUNTIME.parent / "skills" / "run"))
        import app_run
        (self.files / "fig.png").write_bytes(self.PNG)
        (self.files / "shot.png").write_bytes(b"\x89PNG\r\n\x1a\nshot")
        path = self.picture_study()
        st = self.run_pic(path, {"file": "project/sources/private/fig.png", "origin": "user"})
        projection = json.loads(path.read_text(encoding="utf-8"))
        restored = json.loads(Path(st["restoredPath"]).read_text(encoding="utf-8"))
        self.assertTrue(app_run.matches_projection(projection, restored, {}, self.tmp))
        swapped = json.loads(json.dumps(restored))
        swapped["stages"]["intro"]["content"][2]["value"]["src"] = "project/sources/private/shot.png"
        self.assertFalse(app_run.matches_projection(projection, swapped, {}, self.tmp), "another picture, unlabelled")
        self.assertTrue(app_run.matches_projection(projection, swapped, {"h9": "user"}, self.tmp))
        swapped["stages"]["intro"]["content"][2]["value"]["src"] = "../outside.png"
        self.assertFalse(app_run.matches_projection(projection, swapped, {"h9": "user"}, self.tmp))


class RunReportWording(unittest.TestCase):
    """A run whose wording was not all exact never gets an official verdict, and says why."""

    def test_no_official_verdict_with_approximate_or_supplied_wording(self):
        sys.path.insert(0, str(RUNTIME.parent / "skills" / "run"))
        import protocol_report as P
        run = {"evaluation": {"plan": {"official": True}}, "app": {"valid": 4, "planned": 4}}
        self.assertTrue(P.official(run))
        run["app"]["originalWording"] = {"approx": 1, "user": 0, "reconstructed": 2}
        self.assertFalse(P.official(run))
        f = P.facts([], run, False)
        self.assertEqual((f["official"], f["wording"]), (False, {"approx": 1, "user": 0, "reconstructed": 2}))
        self.assertIn("2 reconstructed", P.paragraph([], run))

    def test_the_saved_scores_are_never_official_with_non_exact_wording(self):
        sys.path.insert(0, str(RUNTIME.parent / "skills" / "run"))
        import types
        import app_run
        from hsenv import evaldata as E
        saved = E.EvalData.__dict__["build"]
        self.addCleanup(setattr, E.EvalData, "build", saved)
        E.EvalData.build = classmethod(lambda cls, *a, **k: types.SimpleNamespace(d={"plan": {"official": True}}))
        stub = E.EvalData.__dict__["build"]
        with app_run.never_official():
            ev = E.EvalData.build(None, [])
        self.assertIs(ev.d["plan"]["official"], False)
        self.assertIs(E.EvalData.__dict__["build"], stub, "restored afterwards")
        self.assertIs(E.EvalData.build(None, []).d["plan"]["official"], True)


class RedactionIndex(unittest.TestCase):
    """Only text that verifiably ships is left out of the index: copying private text elsewhere in the project, into
    sources/researcher/, effects.json or the live protocol.json never makes it public (review probe launder.py)."""
    B = "How many minutes did you walk this morning, and did you see a neighbour on the way to work today?"

    def run_index(self, extra, received=None, protocol=None):
        p, c = Path(tempfile.mkdtemp()), Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, p, True)
        self.addCleanup(shutil.rmtree, c, True)
        (p / "sources/private").mkdir(parents=True)
        (p / "sources/private/booklet.txt").write_text(self.B, encoding="utf-8")
        for rel, txt in extra.items():
            (p / rel).parent.mkdir(parents=True, exist_ok=True)
            (p / rel).write_text(txt, encoding="utf-8")
        files = [f for f in (p / "sources").rglob("*") if f.is_file()]
        dest = O.index_project(c, p, protocol or {"distribution": {"held": {}}}, files, {}, received=received)
        self.assertTrue(dest.name.endswith(".v%d.bin" % O.INDEX_FORMAT))
        self.assertEqual(dest.with_name(dest.name[:-len(".v%d.bin" % O.INDEX_FORMAT)] + ".path").read_text(encoding="utf-8"),
                         str(p.resolve()))
        return len(O._read_pairs(dest))

    def test_copies_made_on_this_computer_stay_private(self):
        alone = self.run_index({})
        self.assertEqual(alone, 37)
        for extra in ({"sources/notes/extract.txt": self.B}, {"sources/researcher/booklet.txt": self.B},
                      {"artifacts/x.txt": self.B}, {"effects.json": json.dumps({"quote": self.B})}):
            self.assertEqual(self.run_index(extra), alone, extra)
        live = {"distribution": {"held": {}}, "stages": {"a": {"content": [{"id": "t", "value": self.B}]}}}
        self.assertEqual(self.run_index({}, protocol=live), alone, "the live protocol.json is not what was received")

    def test_what_the_received_study_ships_is_left_out(self):
        received = {"distribution": {"held": {}}, "stages": {"a": {"content": [{"id": "t", "value": self.B}]}}}
        self.assertEqual(self.run_index({}, received=received), 0, "the received protocol shows it")
        hosted = {"distribution": {"held": {}}, "meta": {"sources": {"open": {"distribution": {
            "tier": "hosted", "sha256": O.sha256(self.B.encode("utf-8"))}}}}}
        self.assertEqual(self.run_index({"sources/open/handout.txt": self.B}, received=hosted), 0, "a hosted file it lists")
        self.assertEqual(self.run_index({"sources/researcher/handout.txt": self.B}, received=hosted), 37,
                         "never from sources/researcher/")


class Skeleton(unittest.TestCase):
    """The helper's skeleton, enumerators and hashes match the app's (telemetry-core.ts)."""

    def test_letters_only(self):
        self.assertEqual("".join(map(chr, O.skeleton("Q1: I walked 20 minutes - OK?"))), "qiwalkedminutesok")
        self.assertEqual("".join(map(chr, O.skeleton("第1题：我经常感到紧张。"))), "第题我经常感到紧张")
        self.assertEqual(O.skeleton("1, 2, 3 | 4-5"), [])

    def test_enumerators_are_removed(self):
        for text, want in (("1. Walk", "Walk"), ("Q1: Walk", "Walk"), ("(ii) Walk", "Walk"), ("i. Walk", "Walk"),
                           ("Question 3: Walk", "Walk"), ("Statement 2: Walk", "Walk"), ("S1. Walk", "Walk"),
                           ("A1) Walk", "Walk"), ("### Q1", ""), ("- Walk", "Walk"), ("  12| Walk", "Walk"),
                           ("第1题：走路", "走路"), ("**3.** Walk", "Walk")):
            self.assertEqual(O.strip_enumerators(text).strip(), want, text)
        self.assertEqual(O.strip_enumerators("Q1: Walk Q2: Run").split(), ["Walk", "Run"])
        self.assertEqual(O.strip_enumerators("(a) Walk (b) Run").split(), ["Walk", "Run"])
        self.assertEqual(O.strip_enumerators("a\r\nb"), "a\nb", "split on \\n, \\r dropped, as the app")
        self.assertEqual(O.strip_enumerators("My manager listens to me. I agree (mostly)."),
                         "My manager listens to me. I agree (mostly).")

    def test_full_width_digits_and_linear_time(self):
        self.assertEqual(O.strip_enumerators("第１题：走路").strip(), "走路")
        self.assertEqual(O.strip_enumerators("Ｑ１： Walk").strip(), "Walk")
        import time as _t
        for line in (" " * 100_000 + "1" + " " * 100_000, " " * 100_000 + "1" + " " * 100_000 + "x"):
            t0 = _t.perf_counter()
            O.strip_enumerators(line)
            self.assertLess(_t.perf_counter() - t0, 0.1)

    def test_renumbered_items_share_windows(self):
        items = ["I often feel nervous at work.", "My manager listens to me.", "I trust my colleagues fully."]
        src = O.window_pairs("\n".join(items))
        for shown in ("\n".join("Q%d: %s" % (i + 1, t) for i, t in enumerate(items)),
                      "\n".join("(%s) %s" % ("abc"[i], t) for i, t in enumerate(items)),
                      " ".join("Question %d: %s" % (i + 1, t) for i, t in enumerate(items))):
            self.assertTrue(src & O.window_pairs(shown), shown)


class Runtime(unittest.TestCase):
    def test_the_runtime_ships_the_pdf_reader_hsenv_pins(self):
        lock = (RUNTIME / "requirements.lock").read_text(encoding="utf-8")
        self.assertRegex(lock, r"(?m)^pypdfium2==\d")
        self.assertTrue(D.PDF_EXTRACTOR_FAMILY.startswith("pypdfium2/"))


class TextExtensionsTest(unittest.TestCase):
    def test_text_sources_include_r_scripts_and_markdown(self):
        # A Library source of format "text" may be an R script or R Markdown file the researcher saved.
        with tempfile.TemporaryDirectory() as tmp:
            files = [Path(tmp) / n for n in ("analysis.Rmd", "clean.R", "data.csv", "paper.pdf", "notes.txt")]
            for f in files:
                f.write_bytes(b"x")
            picked = O.candidates_for("text", files, "rmd", None)
            # R files are tried like any text file; data files are not text sources.
            self.assertEqual({f.name for f in picked}, {"notes.txt", "analysis.Rmd", "clean.R"})


if __name__ == "__main__":
    unittest.main()
