"""Public-source download, OSF licence lookup and re-check (fetch_source.py). No network: the one request
function is replaced by canned answers, and one test serves files from a localhost http.server.
   python -m unittest discover -s pack/runtime/tests"""
import contextlib
import email.message
import hashlib
import http.server
import io
import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import zipfile
from pathlib import Path

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "pack/skills/build"))
import check_materials  # noqa: E402
import fetch_source  # noqa: E402
import sources  # noqa: E402

QSF = json.dumps({"SurveyEntry": {"SurveyName": "Study 1"}, "SurveyElements": []}).encode()


def quiet(main, argv):
    with contextlib.redirect_stdout(io.StringIO()):
        return main(argv)


class Response(io.BytesIO):
    def __init__(self, body, url, headers=None):
        super().__init__(body)
        self.url = url
        self.headers = email.message.Message()
        for k, v in (headers or {}).items():
            self.headers[k] = v

    def geturl(self):
        return self.url


def http_error(url, code, headers=None):
    message = email.message.Message()
    for k, v in (headers or {}).items():
        message[k] = v
    return urllib.error.HTTPError(url, code, "error", message, None)


class Scripted:
    """Answers by URL: each a list consumed in order (the last one repeats); bytes, (bytes, headers) or an exception."""

    def __init__(self, answers):
        self.answers = {k: list(v) for k, v in answers.items()}
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append(request)
        url = request.full_url
        queue = self.answers[url]
        answer = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(answer, int):
            raise http_error(url, answer)
        if isinstance(answer, BaseException):
            raise answer
        body, headers = answer if isinstance(answer, tuple) else (answer, {})
        return Response(body, headers.pop("final", url) if "final" in headers else url, headers)


def zip_bytes(members):
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        for name, data in members.items():
            z.writestr(name, data)
    return out.getvalue()


def osf_node(kind, node_id, licence=None, parent=None, registered_from=None):
    data = {"type": kind, "id": node_id, "attributes": {"title": "Project %s" % node_id}, "relationships": {}}
    if licence:
        data["embeds"] = {"license": {"data": {"attributes": {"name": licence}}}}
    if parent:
        data["relationships"]["parent"] = {"data": {"id": parent, "type": kind}}
    if registered_from:
        data["relationships"]["registered_from"] = {"data": {"id": registered_from, "type": "nodes"}}
    return json.dumps({"data": data}).encode()


def osf_file(sha, name="survey.qsf", target="abcde", kind="nodes"):
    return json.dumps({"data": {"type": "files", "attributes": {
        "name": name, "guid": "fguid", "materialized_path": "/" + name, "extra": {"hashes": {"sha256": sha}}},
        "relationships": {"target": {"data": {"type": kind, "id": target}}}}}).encode()


class Base(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="fetch-test-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / "paper.pdf").write_bytes(b"%PDF-1.4 stand-in")
        (self.root / "program.json").write_text(json.dumps({"schemaVersion": 2, "evidence": []}), encoding="utf-8")
        self._open = fetch_source._open
        self.addCleanup(setattr, fetch_source, "_open", self._open)

    def serve(self, answers):
        fetch_source._open = Scripted(answers)
        return fetch_source._open

    def kept(self):
        return sorted(p.name for p in (self.root / "sources").rglob("*") if p.is_file()) \
            if (self.root / "sources").is_dir() else []

    def source(self):
        return json.loads((self.root / "sources/SOURCE.json").read_text(encoding="utf-8"))


class Download(Base):
    def test_material_is_saved_and_recorded(self):
        url = "https://osf.io/download/abcde/"
        self.serve({url: [(QSF, {"Content-Disposition": 'attachment; filename="Study1 survey.qsf"'})]})
        entry = fetch_source.fetch(self.root, url, linked="linked from p. 9", version="OSF snapshot")
        self.assertEqual(entry["path"], "sources/open/Study1_survey.qsf")
        self.assertEqual(entry["sha256"], hashlib.sha256(QSF).hexdigest())
        self.assertEqual((entry["url"], entry["bytes"], entry["linkedToPaper"]), (url, len(QSF), "linked from p. 9"))
        self.assertIn("retrieved", entry)
        # the same file again is not a second copy; --private goes to sources/private/
        fetch_source.fetch(self.root, url)
        self.assertEqual(self.kept(), ["SOURCE.json", "Study1_survey.qsf"])
        entry = fetch_source.fetch(self.root, url, private=True)
        self.assertTrue(entry["path"].startswith("sources/private/") and entry["private"])

    def test_participant_data_is_refused(self):
        csv_data = b"subject_id,rt,choice\n1,512,left\n"
        qualtrics = b'StartDate,EndDate,Status,IPAddress,Progress,"Duration (in seconds)",Finished,ResponseId,Q1\n'
        self.serve({
            "https://osf.io/download/a1/": [(b"x", {"Content-Disposition": 'attachment; filename="exp1_clean.csv"'})],
            "https://osf.io/download/a2/": [(b"x", {"Content-Disposition": 'attachment; filename="study.sav"'})],
            "https://osf.io/download/a3/": [(csv_data, {"Content-Disposition": 'attachment; filename="trial_list.csv"'})],
            "https://osf.io/download/a4/": [(qualtrics, {"Content-Disposition": 'attachment; filename="survey.csv"'})],
        })
        for url, words in (("https://osf.io/download/a1/", "exp1_clean.csv"), ("https://osf.io/download/a2/", "format"),
                           ("https://osf.io/download/a3/", "columns"), ("https://example.org/lotteries.csv", "not named as materials"), ("https://osf.io/download/a4/", "Qualtrics"),
                           ("https://example.org/data/Study2_responses.xlsx", "participant-data")):
            with self.assertRaisesRegex(ValueError, words):
                fetch_source.fetch(self.root, url)
        # a server name that is data cannot be renamed into a material
        with self.assertRaisesRegex(ValueError, "participant data"):
            fetch_source.fetch(self.root, "https://osf.io/download/a1/", name="stimuli.csv")
        self.assertEqual(self.kept(), [])

    def test_archive_with_data_is_refused(self):
        bad = zip_bytes({"Materials/survey.qsf": "{}", "Data/Study1.csv": "id,choice\n"})
        hidden = zip_bytes({"Materials/trial_list.tsv": "subject\trt\tresponse_key\n1\t300\tf\n"})
        good = zip_bytes({"Materials/survey.qsf": "{}", "Materials/instructions.txt": "Please read carefully."})
        self.serve({"https://osf.io/download/z1/": [(bad, {"Content-Disposition": 'filename="osfstorage-archive.zip"'})],
                    "https://osf.io/download/z2/": [(hidden, {"Content-Disposition": 'filename="materials.zip"'})],
                    "https://osf.io/download/z3/": [(good, {"Content-Disposition": 'filename="materials.zip"'})],
                    "https://osf.io/download/z4/": [(b"7z\xbc\xaf", {"Content-Disposition": 'filename="all.7z"'})]})
        with self.assertRaisesRegex(ValueError, "Study1.csv"):
            fetch_source.fetch(self.root, "https://osf.io/download/z1/")
        with self.assertRaisesRegex(ValueError, "trial_list.tsv"):
            fetch_source.fetch(self.root, "https://osf.io/download/z2/")
        with self.assertRaisesRegex(ValueError, "cannot be listed"):
            fetch_source.fetch(self.root, "https://osf.io/download/z4/")
        self.assertEqual(self.kept(), [])
        self.assertEqual(fetch_source.fetch(self.root, "https://osf.io/download/z3/")["path"], "sources/open/materials.zip")

    def test_notebook_with_outputs_is_refused(self):
        table = {"output_type": "execute_result", "data": {"text/html": ["<table><tr><td>1</td></tr></table>"]}}
        shown = json.dumps({"cells": [{"cell_type": "code", "source": ["df.head()"], "outputs": [table]}]}).encode()
        clean = json.dumps({"cells": [{"cell_type": "code", "source": ["df.head()"], "outputs": []}]}).encode()
        self.serve({"https://example.org/analysis.ipynb": [shown, clean]})
        with self.assertRaisesRegex(ValueError, "saved outputs"):
            fetch_source.fetch(self.root, "https://example.org/analysis.ipynb")
        self.assertEqual(self.kept(), [])
        self.assertEqual(fetch_source.fetch(self.root, "https://example.org/analysis.ipynb")["path"],
                         "sources/open/analysis.ipynb")

    def test_size_cap_scheme_and_extension(self):
        self.serve({"https://example.org/big.pdf": [(b"x", {"Content-Length": str(fetch_source.MAX_FILE + 1)})],
                    "https://example.org/s.qsf": [QSF]})
        with self.assertRaisesRegex(ValueError, "MiB limit"):
            fetch_source.fetch(self.root, "https://example.org/big.pdf")
        with self.assertRaisesRegex(ValueError, "http"):
            fetch_source.fetch(self.root, "file:///etc/hosts")
        with self.assertRaisesRegex(ValueError, "extension"):
            fetch_source.fetch(self.root, "https://example.org/s.qsf", name="s.txt")
        self.assertEqual(self.kept(), [])

    def test_signed_redirect_is_recorded_without_its_query_and_kept_by_sources_rerun(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/download/abcde/":
                    self.send_response(302)
                    self.send_header("Location", "/storage/survey.qsf?X-Amz-Algorithm=AWS4&X-Amz-Expires=60"
                                                 "&X-Amz-Signature=deadbeef")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(QSF)))
                self.end_headers()
                self.wfile.write(QSF)

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = "http://127.0.0.1:%d" % server.server_address[1]
        entry = fetch_source.fetch(self.root, base + "/download/abcde/")
        self.assertEqual(entry["finalUrl"], base + "/storage/survey.qsf")
        self.assertNotIn("Signature", (self.root / "sources/SOURCE.json").read_text(encoding="utf-8"))
        self.assertEqual(fetch_source.public_url("https://s.example/x?sv=1&se=2&sig=3"), "https://s.example/x")
        self.assertEqual(fetch_source.public_url("https://osf.io/x/?view_only=abc"), "https://osf.io/x/")
        self.assertEqual(fetch_source.public_url("https://osf.io/x/?page=2"), "https://osf.io/x/?page=2")
        # sources.py run again keeps what fetch_source.py recorded
        quiet(sources.main, [str(self.root), "--license", "sources/open/survey.qsf=CC-BY-4.0", "--license-evidence",
                      "sources/open/survey.qsf=OSF project page: License CC-By Attribution 4.0"])
        kept = next(f for f in self.source()["files"] if f["path"] == "sources/open/survey.qsf")
        self.assertEqual((kept["url"], kept["finalUrl"], kept["sha256"]),
                         (base + "/download/abcde/", base + "/storage/survey.qsf", hashlib.sha256(QSF).hexdigest()))
        self.assertIn("retrieved", kept)
        self.assertEqual(fetch_source.problems(self.root), [])
        self.assertEqual(sources.problems(self.root), [])


class Licence(Base):
    def test_file_in_component_takes_the_parent_project_licence(self):
        sha = "ab" * 32
        self.serve({"https://api.osf.io/v2/files/abcdefabcdefabcdefabcdef/": [osf_file(sha.upper(), target="comp1")],
                    "https://api.osf.io/v2/nodes/comp1/?embed=license": [osf_node("nodes", "comp1", parent="proj1")],
                    "https://api.osf.io/v2/nodes/proj1/?embed=license":
                        [osf_node("nodes", "proj1", licence="CC-By Attribution 4.0 International")]})
        record = fetch_source.osf_licence("https://osf.io/xyz12/files/osfstorage/abcdefabcdefabcdefabcdef")
        self.assertEqual(record["file"]["sha256"], sha)
        self.assertEqual(record["license"], "CC-BY-4.0")
        self.assertEqual([p["id"] for p in record["projects"]], ["comp1", "proj1"])
        self.assertIn("proj1", record["licenseFrom"])
        self.assertEqual(len(record["asked"]), 3)
        fetch_source.record_lookup(self.root, record)
        fetch_source.record_lookup(self.root, record)   # same url: replaced, not duplicated
        self.assertEqual(len(self.source()["licenceLookups"]), 1)

    def test_registration_without_licence_does_not_take_its_project_licence(self):
        self.serve({"https://api.osf.io/v2/files/rrrrr/": [404],
                    "https://api.osf.io/v2/nodes/rrrrr/?embed=license": [404],
                    "https://api.osf.io/v2/registrations/rrrrr/?embed=license":
                        [osf_node("registrations", "rrrrr", registered_from="nnnnn")],
                    "https://api.osf.io/v2/nodes/nnnnn/?embed=license": [osf_node("nodes", "nnnnn", licence="CC0 1.0 Universal")]})
        record = fetch_source.osf_licence("https://osf.io/rrrrr/")
        self.assertEqual(record["license"], "none stated")
        self.assertEqual(record["registeredFrom"]["license"], "CC0-1.0")
        self.assertEqual(record["projects"][0]["type"], "registrations")

    def test_explicit_no_license_stops_the_walk(self):
        self.serve({"https://api.osf.io/v2/files/ccccc/": [404],
                    "https://api.osf.io/v2/nodes/ccccc/?embed=license":
                        [osf_node("nodes", "ccccc", licence="No license", parent="ppppp")]})
        record = fetch_source.osf_licence("https://osf.io/ccccc/")
        self.assertEqual((record["license"], len(record["projects"])), ("none stated", 1))
        with self.assertRaisesRegex(ValueError, "OSF"):
            fetch_source.osf_licence("https://example.org/ccccc/")

    def test_same_sha_as_an_open_lookup_carries_that_licence(self):
        rel = "sources/open/survey.qsf"
        (self.root / "sources/open").mkdir(parents=True)
        (self.root / rel).write_bytes(QSF)
        data = sources.build(self.root, extra={"url": {rel: "https://example.org/survey.qsf"}})
        data["licenceLookups"] = [{"url": "https://osf.io/abcde/", "file": {"name": "survey.qsf",
                                   "sha256": hashlib.sha256(QSF).hexdigest()}, "license": "CC-BY-4.0",
                                   "licenseFrom": "OSF node abcde ('Materials'): License CC-By Attribution 4.0 International"}]
        (self.root / "sources/SOURCE.json").write_text(json.dumps(data), encoding="utf-8")
        found = fetch_source.problems(self.root)
        self.assertEqual(len(found), 1)
        self.assertIn("same SHA-256", found[0][0])
        self.assertIn("--license %s=CC-BY-4.0" % rel, found[0][1])
        entry = next(f for f in data["files"] if f["path"] == rel)
        self.assertEqual(fetch_source.licence_from_lookup(self.root, entry)["url"], "https://osf.io/abcde/")
        quiet(sources.main, [str(self.root), "--license", rel + "=CC-BY-4.0", "--license-evidence",
                      rel + "=OSF licence lookup (licenceLookups, https://osf.io/abcde/): same SHA-256 as survey.qsf"])
        self.assertEqual(fetch_source.problems(self.root), [])
        self.assertTrue(check_materials.LICENSE_WORDS.search(next(
            f for f in self.source()["files"] if f["path"] == rel)["licenseEvidence"]))
        # a lookup of another file does not confirm it
        data = self.source()
        data["licenceLookups"][0]["file"]["sha256"] = "00" * 32
        (self.root / "sources/SOURCE.json").write_text(json.dumps(data), encoding="utf-8")
        self.assertIn("cites a licence lookup", fetch_source.problems(self.root)[0][0])

    def test_open_file_without_licence_and_signed_links_fail_but_a_plain_project_passes(self):
        self.assertEqual(fetch_source.problems(self.root), [])   # no SOURCE.json
        quiet(sources.main, [str(self.root)])
        self.assertEqual(fetch_source.problems(self.root), [])   # nothing downloaded
        (self.root / "sources/open").mkdir(parents=True)
        (self.root / "sources/open/items.txt").write_text("Item 1. I like puzzles.", encoding="utf-8")
        quiet(sources.main, [str(self.root), "--url", "sources/open/items.txt=https://s3.example/items.txt?X-Amz-Signature=a"])
        found = [m for m, _ in fetch_source.problems(self.root)]
        self.assertTrue(any("without an open licence" in m for m in found))
        self.assertTrue(any("signed storage link" in m for m in found))
        self.assertEqual(quiet(fetch_source.main, ["--check", str(self.root)]), 1)


class Verify(Base):
    URL = "https://osf.io/download/abcde/"

    def setUp(self):
        super().setUp()
        self.serve({self.URL: [(QSF, {"Content-Disposition": 'filename="survey.qsf"'})]})
        fetch_source.fetch(self.root, self.URL)
        self.pauses = []

    def status(self, answers, **kw):
        opener = self.serve(answers)
        out = fetch_source.verify(self.root, sleep=self.pauses.append, **kw)
        self.assertEqual(len(out), 1)
        return out[0][2], out[0][3], opener

    def test_same_differs_gone(self):
        self.assertEqual(self.status({self.URL: [QSF]})[0], "same")
        self.assertEqual(self.status({self.URL: [b"edited"]})[0], "differs")
        status, detail, opener = self.status({self.URL: [410]})
        self.assertEqual((status, len(opener.requests), self.pauses), ("gone", 1, []))
        self.assertEqual(quiet(fetch_source.main, ["--verify", str(self.root)]), 1)

    def test_transient_retries_then_not_rechecked(self):
        status, detail, opener = self.status({self.URL: [503], "https://api.osf.io/v2/files/abcde/": [503]}, attempts=2)
        self.assertEqual(status, "not re-checked")
        # Retry-After is honoured (capped), and a retry that then succeeds is `same`
        self.pauses.clear()
        status, _, _ = self.status({self.URL: [http_error(self.URL, 429, {"Retry-After": "120"}), QSF]})
        self.assertEqual((status, self.pauses), ("same", [fetch_source.RETRY_AFTER_CAP]))
        self.pauses.clear()
        status, _, _ = self.status({self.URL: [OSError("timed out"), QSF]})
        self.assertEqual((status, self.pauses), ("same", [2.0]))

    def test_refused_osf_file_is_confirmed_by_the_listed_hash(self):
        sha = hashlib.sha256(QSF).hexdigest()
        status, detail, _ = self.status({self.URL: [403], "https://api.osf.io/v2/files/abcde/": [osf_file(sha.upper())]})
        self.assertEqual(status, "same")
        self.assertIn("OSF API lists", detail)
        self.assertEqual(self.status({self.URL: [403], "https://api.osf.io/v2/files/abcde/": [osf_file("11" * 32)]})[0],
                         "differs")
        self.assertEqual(self.status({self.URL: [403], "https://api.osf.io/v2/files/abcde/": [404]})[0], "gone")

    def test_persistent_refusal_without_osf_route_fails(self):
        data = self.source()
        data["files"][-1]["url"] = "https://example.org/survey.qsf"
        (self.root / "sources/SOURCE.json").write_text(json.dumps(data), encoding="utf-8")
        status, _, _ = self.status({"https://example.org/survey.qsf": [403]}, attempts=2)
        self.assertEqual(status, "refused")
        self.assertEqual(self.pauses, [fetch_source.REFUSED_PAUSE])

    def test_changed_page_that_still_shows_its_quotes_is_same(self):
        rel = "sources/open/page.html"
        (self.root / rel).write_bytes(b"<html><body><p>Participants read: Please choose a box.</p></body></html>")
        program = {"schemaVersion": 2, "evidence": [{"id": "e1", "path": rel, "quote": "Please choose a box."}]}
        (self.root / "program.json").write_text(json.dumps(program), encoding="utf-8")
        data = sources.build(self.root, extra={"url": {rel: "https://example.org/page"}})
        data["files"] = [f for f in data["files"] if f["path"] == rel]
        (self.root / "sources/SOURCE.json").write_text(json.dumps(data), encoding="utf-8")
        page = b"<html><body><nav>New menu</nav><p>Participants read: Please\n choose a box.</p></body></html>"
        self.assertEqual(self.status({"https://example.org/page": [page]})[0], "same")
        self.assertEqual(self.status({"https://example.org/page": [b"<html><body>Moved</body></html>"]})[0], "differs")


if __name__ == "__main__":
    unittest.main()
