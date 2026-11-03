"""sandbox_run.py: package code runs without the parent's secrets, network or write access outside its work folder.
   python -m unittest discover -s pack/runtime/tests"""
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "pack/skills/build"))
import sandbox_run  # noqa: E402

SECRETS = {"OPENROUTER_API_KEY": "sk-or-v1-" + "0" * 40, "ANTHROPIC_API_KEY": "sk-ant-test-" + "1" * 24,
           "GITHUB_TOKEN": "ghp_" + "2" * 36, "HUMANSTUDY_DESKTOP_KEY": "desk-" + "3" * 20}

# Tries every way out and prints one REPORT line. Paths and port arrive as arguments.
HOSTILE = r'''import os, socket, sys
from pathlib import Path
port, outside, home_file, secret_file = int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4]
names = [k for k in os.environ if k.endswith(("_KEY", "_TOKEN")) or "SECRET" in k]
r = {"env": ",".join(sorted(names)) or "none"}
try:
    s = socket.create_connection(("127.0.0.1", port), timeout=3)
    s.sendall(b"exfil"); s.close(); r["net"] = "open"
except OSError:
    r["net"] = "blocked"
for key, path in (("outside", outside), ("home", home_file)):
    try:
        Path(path).write_text("pwned"); r[key] = "wrote"
    except OSError:
        r[key] = "blocked"
try:
    Path(secret_file).read_text(); r["read"] = "read"
except OSError:
    r["read"] = "blocked"
try:
    Path(os.environ["HOME"], "x").write_text("ok"); Path(os.environ["TMPDIR"], "y").write_text("ok"); r["work"] = "ok"
except OSError as exc:
    r["work"] = "failed %s" % exc
r["sibling"] = __import__("helper_sibling").VALUE
if sys.platform == "darwin":  # the pasteboard is another process, reached over mach IPC
    import subprocess
    r["ipc"] = "open" if subprocess.run(["/usr/bin/pbpaste"], capture_output=True).returncode == 0 else "blocked"
print("REPORT " + " ".join("%s=%s" % kv for kv in sorted(r.items())))
'''


class Listener:
    """A local TCP server that records whether anything connected."""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(5)
        self.sock.settimeout(0.2)
        self.port = self.sock.getsockname()[1]
        self.got, self.stop = [], False
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.thread.start()

    def loop(self):
        while not self.stop:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                continue
            self.got.append(conn.recv(100))
            conn.close()

    def close(self):
        self.stop = True
        self.thread.join(2)
        self.sock.close()


def confined_files(label):
    return label.startswith("sandbox-exec")


def confined_net(label):
    return label.startswith(("sandbox-exec", "unshare"))


class SandboxRunTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="sandbox-test-"))
        self.tag = uuid.uuid4().hex[:10]
        self.home_file = Path.home() / (".hs-sandbox-test-%s" % self.tag)
        self.secret_file = Path.home() / (".hs-sandbox-secret-%s" % self.tag)
        self.secret_file.write_text("do not read", encoding="utf-8")
        self.saved = {k: os.environ.get(k) for k in SECRETS}
        os.environ.update(SECRETS)
        self.listener = Listener()

    def tearDown(self):
        self.listener.close()
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        for p in (self.home_file, self.secret_file):
            if p.exists():
                p.unlink()
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_hostile_script_gets_nothing(self):
        pkg = self.dir / "pkg"
        pkg.mkdir()
        (pkg / "hostile.py").write_text(HOSTILE, encoding="utf-8")
        (pkg / "helper_sibling.py").write_text("VALUE = 'imported'\n", encoding="utf-8")
        outside = self.dir / "escaped.txt"
        work = self.dir / "work"
        res = sandbox_run.run_python(pkg / "hostile.py", [self.listener.port, outside, self.home_file, self.secret_file],
                                     cwd=pkg, work=work, timeout=60)
        report = next((l for l in res.stdout.splitlines() if l.startswith("REPORT ")), None)
        self.assertIsNotNone(report, res.stdout + res.stderr)
        r = dict(kv.split("=", 1) for kv in report.split()[1:])
        self.assertEqual(r["env"], "none", report)
        self.assertEqual(r["sibling"], "imported", report)
        for value in SECRETS.values():
            self.assertNotIn(value, res.stdout + res.stderr)
        if confined_net(res.confinement):
            self.assertEqual(r["net"], "blocked", report)
            time.sleep(0.3)
            self.assertEqual(self.listener.got, [])
        if confined_files(res.confinement):
            self.assertEqual(r["outside"], "blocked", report)
            self.assertEqual(r["home"], "blocked", report)
            self.assertEqual(r["read"], "blocked", report)
            self.assertFalse(outside.exists())
            self.assertFalse(self.home_file.exists())
            self.assertEqual(r["work"], "ok", report)
            self.assertEqual(r["ipc"], "blocked", report)
        if sys.platform == "darwin" and shutil.which("sandbox-exec"):
            self.assertTrue(confined_files(res.confinement), res.confinement)

    def test_timeout_kills_the_process_group(self):
        pkg = self.dir / "pkg"
        pkg.mkdir()
        marker = self.dir / "work" / "late.txt"
        (pkg / "late.py").write_text("import sys, time\nfrom pathlib import Path\ntime.sleep(3)\n"
                                     "Path(sys.argv[1]).write_text('late')\n", encoding="utf-8")
        (pkg / "slow.py").write_text("import subprocess, sys, time\nfrom pathlib import Path\n"
                                     "subprocess.Popen([sys.executable, str(Path(__file__).with_name('late.py')), sys.argv[1]])\n"
                                     "time.sleep(60)\n", encoding="utf-8")
        started = time.time()
        res = sandbox_run.run_python(pkg / "slow.py", [marker], cwd=pkg, work=self.dir / "work", timeout=2)
        self.assertTrue(res.timed_out)
        self.assertLess(time.time() - started, 30)
        time.sleep(4)
        self.assertFalse(marker.exists(), "a child of the timed-out process kept running")

    def test_leftover_process_is_ended_and_profile_is_inline(self):
        if os.name == "nt":
            self.skipTest("leftover processes are only ended on POSIX")
        pkg = self.dir / "pkg"
        pkg.mkdir()
        marker = self.dir / "work" / "survivor.txt"
        # Leaves the process group (setsid) through a double fork, then writes after the run has ended.
        (pkg / "escape.py").write_text(
            "import os, sys, time\n"
            "if os.fork() == 0:\n"
            "    os.setsid()\n"
            "    if os.fork() == 0:\n"
            "        time.sleep(3)\n"
            "        open(sys.argv[1], 'w').write('alive')\n"
            "    os._exit(0)\n", encoding="utf-8")
        res = sandbox_run.run_python(pkg / "escape.py", [marker], cwd=pkg, work=self.dir / "work", timeout=30)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertFalse(list((self.dir / "work").glob("*.sb")), "the profile must not be a file in the work folder")
        time.sleep(4)
        self.assertFalse(marker.exists(), "a process that left the group outlived the run")

    def test_marker_variable_does_not_switch_the_sandbox_off(self):
        if not (sys.platform == "darwin" and shutil.which("sandbox-exec")):
            self.skipTest("macOS sandbox only")
        os.environ[sandbox_run.MARK] = "1"
        try:
            pkg = self.dir / "pkg"
            pkg.mkdir()
            (pkg / "read.py").write_text("import sys\ntry:\n    open(sys.argv[1]).read(); print('READ')\n"
                                         "except OSError:\n    print('blocked')\n", encoding="utf-8")
            res = sandbox_run.run_python(pkg / "read.py", [self.secret_file], cwd=pkg, work=self.dir / "work")
        finally:
            os.environ.pop(sandbox_run.MARK, None)
        self.assertIn("blocked", res.stdout)
        self.assertTrue(res.confinement.startswith("sandbox-exec"), res.confinement)

    def test_no_signals_outside_and_secrets_redacted(self):
        pkg = self.dir / "pkg"
        pkg.mkdir()
        victim = __import__("subprocess").Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            (pkg / "sig.py").write_text(
                "import os, signal, sys\n"
                "try:\n    os.kill(int(sys.argv[1]), signal.SIGTERM); print('KILLED')\n"
                "except OSError:\n    print('blocked')\n"
                "print('leak sk-or-v1-' + 'a' * 40)\n", encoding="utf-8")
            res = sandbox_run.run_python(pkg / "sig.py", [victim.pid], cwd=pkg, work=self.dir / "work")
            if confined_files(res.confinement):
                self.assertIn("blocked", res.stdout)
                time.sleep(0.3)
                self.assertIsNone(victim.poll())
            self.assertNotIn("sk-or-v1-aaaa", res.stdout)
            self.assertIn("[redacted]", res.stdout)
        finally:
            victim.kill()
            victim.wait()

    def test_copies_do_not_follow_links_out_of_the_package(self):
        pkg = self.dir / "pkg"
        (pkg / "task").mkdir(parents=True)
        (pkg / "task/real.txt").write_text("ok", encoding="utf-8")
        try:
            os.symlink(str(self.secret_file), str(pkg / "task/leak"))
            os.symlink("real.txt", str(pkg / "task/inside"))
        except (OSError, NotImplementedError):
            self.skipTest("cannot make symlinks here")
        copy = sandbox_run.copy_tree(pkg, self.dir / "copy")
        self.assertFalse(os.path.lexists(copy / "task/leak"))
        self.assertEqual((copy / "task/inside").read_text(encoding="utf-8"), "ok")


if __name__ == "__main__":
    unittest.main()
