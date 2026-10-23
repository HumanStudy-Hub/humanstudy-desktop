"""program_io.py under contention, the way Windows users hit it: several agent saves at once, and a reader
(the app, an editor, an antivirus scan) holding program.json open while the atomic replace runs. On
Windows an open handle without delete sharing makes os.replace fail with a sharing violation, and a lock
folder that is being removed refuses mkdir with access denied; both must be waited out, not reported as
a failed save. On macOS/Linux the same tests pass trivially.
   python -m unittest discover -s pack/runtime/tests"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

BUILD = Path(__file__).resolve().parents[2] / "skills" / "build"
IO = BUILD / "program_io.py"
TOP = {"schemaVersion": 2, "id": "p", "title": "T", "intent": "i", "source": {"kind": "paper"}}


def run(cwd, batch, timeout=60):
    return subprocess.run([sys.executable, str(IO), "-"], cwd=cwd, input=json.dumps(batch).encode("utf-8"),
                          capture_output=True, timeout=timeout)


class ProgramIoContentionTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        r = run(self.dir, dict(TOP, nodes=[{"id": "n0"}]))
        self.assertEqual(r.returncode, 0, r.stderr)

    def tearDown(self):
        self._tmp.cleanup()

    def saved(self):
        return json.loads((self.dir / "program.json").read_text(encoding="utf-8"))

    def leftovers(self):
        return [p.name for p in self.dir.iterdir() if p.name.endswith((".tmp", ".lock"))]

    def test_parallel_saves_all_land(self):
        n = 8
        procs = [subprocess.Popen([sys.executable, str(IO), "-"], cwd=self.dir, stdin=subprocess.PIPE,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE) for _ in range(n)]
        for i, p in enumerate(procs):
            p.stdin.write(json.dumps({"nodes": [{"id": f"n{i + 1}"}]}).encode("utf-8"))
            p.stdin.close()
        for p in procs:
            with p.stderr:
                err = p.stderr.read()
            p.wait(timeout=60)
            self.assertEqual(p.returncode, 0, err.decode("utf-8", "replace"))
        self.assertEqual(sorted(x["id"] for x in self.saved()["nodes"]), sorted(f"n{i}" for i in range(n + 1)))
        self.assertEqual(self.leftovers(), [])

    def test_saves_wait_out_a_reader_holding_the_file_open(self):
        # Python's open() shares read/write but not delete on Windows, like many editors and scanners.
        handle = open(self.dir / "program.json", "rb")
        threading.Timer(0.6, handle.close).start()
        r = run(self.dir, {"nodes": [{"id": "late"}]})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("late", [x["id"] for x in self.saved()["nodes"]])
        self.assertEqual(self.leftovers(), [])

    def test_lines_are_lf_and_text_is_utf8(self):
        r = run(self.dir, {"nodes": [{"id": "n0", "title": "Überprüft — 已核对"}]})
        self.assertEqual(r.returncode, 0, r.stderr)
        raw = (self.dir / "program.json").read_bytes()
        self.assertNotIn(b"\r\n", raw)
        self.assertEqual(self.saved()["nodes"][0]["title"], "Überprüft — 已核对")

    def test_lock_churn_never_reports_a_spurious_failure(self):
        # Another writer taking and dropping the lock in a tight loop: a save must wait, not fail.
        sys.path.insert(0, str(BUILD))
        try:
            from program_lock import program_lock
        finally:
            sys.path.remove(str(BUILD))
        stop = time.monotonic() + 3
        errors = []

        def churn():
            while time.monotonic() < stop:
                try:
                    with program_lock(self.dir / "program.json"):
                        pass
                except OSError as e:  # the in-process writer must not fail either
                    errors.append(repr(e))

        t = threading.Thread(target=churn)
        t.start()
        try:
            for i in range(10):
                r = run(self.dir, {"nodes": [{"id": f"c{i}"}]})
                self.assertEqual(r.returncode, 0, r.stderr)
        finally:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(len([x for x in self.saved()["nodes"] if x["id"].startswith("c")]), 10)


if __name__ == "__main__":
    unittest.main()
