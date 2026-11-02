#!/usr/bin/env python3
"""Run a study package's own code (adapter.py, evaluation.py, human loaders, smoke tests) in a confined
child process. Study packages can come from other people (community revisions), so their code is never
imported into a checker's process and never sees the researcher's keys, home folder or network.

    from sandbox_run import run_python, work_dir
    with work_dir() as work:
        res = run_python(script, ["--smoke-test"], cwd=copy_of_package, work=work, timeout=120)
        res.returncode, res.stdout, res.stderr, res.timed_out, res.confinement

Every platform:
  * `python -I -B -X utf8`: no PYTHON* variables, no user site-packages, no bytecode written. The script's
    folder is put back on sys.path so a package can still import its sibling files.
  * a minimal environment: PATH, LANG/LC_*, HOME and TMPDIR pointing into the work folder, and only the
    non-secret names in SAFE_ENV. API keys, tokens and everything else in the parent's environment are dropped.
  * a new session / process group; on a timeout (and after a normal exit) the whole group is killed.
macOS: sandbox-exec with a profile that denies all network access and messages to other processes (so no
  browser, keychain or pasteboard), denies writes outside the work folder, and denies reading file contents
  under the real home folder except the work folder, the Python installation and the folders named in `read`.
Linux: `unshare -rn` (no network) when unprivileged user namespaces are available; files are not confined.
Elsewhere (Windows, or Linux without user namespaces): environment and process-group only, with a warning.

Nested calls (a sandboxed checker that itself runs a package) reuse the confinement they are already in.
Standard library only.
"""
import contextlib
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

MARK = "HUMANSTUDY_SANDBOX"
# Non-secret settings a package may legitimately need. Nothing here may hold a key, token or password.
SAFE_ENV = ("LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC",
            "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OMP_NUM_THREADS",
            "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "SOURCE_DATE_EPOCH")
MAX_OUTPUT = 32 << 20  # bytes of stdout/stderr kept (the tail)
BOOT = ("import os, runpy, sys; s = sys.argv[1]; sys.argv = sys.argv[1:]; "
        "sys.path.insert(0, os.path.dirname(os.path.abspath(s))); runpy.run_path(s, run_name='__main__')")
_warned = set()
_unshare = None


class Result:
    def __init__(self, returncode, stdout, stderr, timed_out, confinement):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr
        self.timed_out, self.confinement = timed_out, confinement


@contextlib.contextmanager
def work_dir(prefix="hs-sandbox-", parent=None):
    """A fresh folder the confined code may write to; removed afterwards."""
    path = tempfile.mkdtemp(prefix=prefix, dir=str(parent) if parent else None)
    try:
        yield Path(path)
    finally:
        shutil.rmtree(path, ignore_errors=True)


def _warn(key, text):
    if key not in _warned:
        _warned.add(key)
        print("warning: " + text, file=sys.stderr)


def _real(p):
    return os.path.realpath(os.path.abspath(str(p)))


def _sb_str(p):
    return '"' + p.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _python_dirs():
    """Folders the interpreter reads its standard library and installed packages from."""
    dirs = {sys.prefix, sys.base_prefix, sys.exec_prefix, getattr(sys, "base_exec_prefix", sys.exec_prefix),
            os.path.dirname(sys.executable), os.path.dirname(_real(sys.executable))}
    dirs.update(p for p in sys.path if p and os.path.isabs(p) and os.path.isdir(p))
    return dirs


def macos_profile(work, read=()):
    home = _real(Path.home())
    allow_read = {_real(work), _real(Path(__file__).resolve().parent.parent)}  # the work folder and the skills
    allow_read.update(_real(p) for p in read if p)
    allow_read.update(_real(p) for p in _python_dirs())
    # Never re-open the whole home folder (or a parent of it) because of a broad sys.path entry.
    allow_read = sorted(p for p in allow_read if not (home + os.sep).startswith(p.rstrip(os.sep) + os.sep))
    w = _sb_str(_real(work))
    lines = ["(version 1)", "(allow default)",
             "(deny network*)",
             # No talking to other processes either (browser via Launch Services, keychain, pasteboard):
             # only the user-name lookup that getpass/pwd need.
             "(deny mach-lookup)",
             "(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\"))",
             "(deny appleevent-send)",
             "(deny file-write*)",
             "(allow file-write* (subpath %s) (literal \"/dev/null\") (literal \"/dev/zero\") "
             "(literal \"/dev/tty\") (literal \"/dev/dtracehelper\") (subpath \"/dev/fd\"))" % w,
             "(deny file-read-data (subpath %s))" % _sb_str(home)]
    if allow_read:
        lines.append("(allow file-read-data %s)" % " ".join("(subpath %s)" % _sb_str(p) for p in allow_read))
    return "\n".join(lines) + "\n"


def _linux_unshare():
    global _unshare
    if _unshare is None:
        exe = shutil.which("unshare")
        ok = False
        if exe:
            try:
                ok = subprocess.run([exe, "-rn", "true"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    timeout=10).returncode == 0
            except (OSError, subprocess.SubprocessError):
                ok = False
        _unshare = [exe, "-rn"] if ok else []
    return _unshare


def env_for(work, extra=None):
    home = Path(work) / "home"
    tmp = Path(work) / "tmp"
    home.mkdir(parents=True, exist_ok=True)
    tmp.mkdir(parents=True, exist_ok=True)
    env = {k: os.environ[k] for k in SAFE_ENV if k in os.environ}
    env.update(PATH=os.environ.get("PATH", os.defpath), HOME=str(home), USERPROFILE=str(home), TMPDIR=str(tmp),
               TEMP=str(tmp), TMP=str(tmp), MPLBACKEND="Agg", MPLCONFIGDIR=str(home / ".matplotlib"),
               PYTHONIOENCODING="utf-8")
    env.setdefault("LANG", "C.UTF-8")
    for k, v in (extra or {}).items():
        env[k] = str(v)
    env[MARK] = "1"
    return env


def wrapper(work, read=()):
    """(argv prefix, confinement label) for this platform."""
    if os.environ.get(MARK) == "1":
        return [], "inherited"
    if sys.platform == "darwin":
        exe = shutil.which("sandbox-exec") or ("/usr/bin/sandbox-exec" if os.path.exists("/usr/bin/sandbox-exec") else None)
        if exe:
            profile = Path(work) / "sandbox.sb"
            profile.write_text(macos_profile(work, read), encoding="utf-8")
            return [exe, "-f", str(profile)], "sandbox-exec (no network, writes only in the work folder, home folder unreadable)"
        _warn("darwin", "sandbox-exec is unavailable: package code runs with a clean environment but without "
                        "network or file confinement")
        return [], "environment only"
    if sys.platform.startswith("linux"):
        pre = _linux_unshare()
        if pre:
            return pre, "unshare (no network); files not confined"
        _warn("linux", "unprivileged network namespaces are unavailable (unshare -rn failed): package code runs "
                       "with a clean environment but without network or file confinement")
        return [], "environment only"
    _warn(sys.platform, "no sandbox on %s: package code runs with a clean environment but without network or "
                        "file confinement" % sys.platform)
    return [], "environment only"


def _kill_tree(proc, timed_out):
    try:
        if os.name == "nt":
            if not timed_out:  # the pid may already belong to another process
                return
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30)
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        proc.kill()
    except OSError:
        pass


def _tail(f):
    f.seek(0, os.SEEK_END)
    size = f.tell()
    f.seek(max(0, size - MAX_OUTPUT))
    return f.read().decode("utf-8", errors="replace")


def run_python(script, args=(), cwd=None, work=None, timeout=600, read=(), env=None):
    """Run `python script args...` confined; `work` is the only folder it may write to (made if missing).

    `read` names extra folders whose files the code may read (on macOS the home folder is otherwise
    unreadable); `cwd` and the script's folder are added. `env` adds non-secret variables."""
    if work is None:
        raise ValueError("run_python needs a work folder")
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    script = Path(script).resolve()
    reads = [script.parent] + ([cwd] if cwd else []) + list(read)
    pre, label = wrapper(work, reads)
    argv = pre + [sys.executable, "-I", "-B", "-X", "utf8", "-c", BOOT, str(script)] + [str(a) for a in args]
    kw = {"start_new_session": True} if os.name != "nt" else \
        {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)}
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(argv, cwd=str(cwd or work), env=env_for(work, env), stdin=subprocess.DEVNULL,
                                stdout=out, stderr=err, **kw)
        timed_out = False
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        _kill_tree(proc, timed_out)  # on POSIX also ends anything the code left running in its group
        proc.wait()
        return Result(proc.returncode, _tail(out), _tail(err), timed_out, label)
