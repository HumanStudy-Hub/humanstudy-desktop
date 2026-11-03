#!/usr/bin/env python3
"""Run a study package's own code (adapter.py, evaluation.py, human loaders, smoke tests) in a confined
child process. Study packages can come from other people (community revisions), so their code is never
imported into a checker's process, gets no keys in its environment, and (on macOS) no network, home folder
or writes outside its work folder.

    from sandbox_run import run_python, work_dir
    with work_dir() as work:
        res = run_python(script, ["--smoke-test"], cwd=copy_of_package, work=work, timeout=120)
        res.returncode, res.stdout, res.stderr, res.timed_out, res.confinement

Every platform:
  * `python -I -B -X utf8`: no PYTHON* variables, no user site-packages, no bytecode written. The script's
    folder is put back on sys.path so a package can still import its sibling files.
  * a minimal environment: PATH, LANG/LC_*, HOME and TMPDIR pointing into the work folder, and only the
    non-secret names in SAFE_ENV. API keys, tokens and everything else in the parent's environment are dropped.
  * a new session / process group; on a timeout (and after a normal exit) the whole group is killed, and
    then any process still carrying this run's marker in its environment (one that left the group).
  * the parent's secret values, and anything shaped like a known key, are blanked out of stdout/stderr.
macOS: sandbox-exec with an inline profile (never a file the code could rewrite) that denies all network
  access, messages to other processes (browser, keychain, pasteboard) and signals outside the sandbox,
  denies writes outside the work folder, and denies reading file contents under /Users, /Volumes and the
  shared temp folders except the work folder, the Python installation and the folders named in `read`.
Linux: `unshare -rn` (no network) when unprivileged user namespaces are available; files are not confined.
Elsewhere (Windows, or Linux without user namespaces): environment and process-group only, with a warning.

Nested calls (a sandboxed checker that itself runs a package) reuse the confinement they are already in:
the kernel must report a sandbox (sandbox_check, network namespace) and the marker must be set. Inside
someone else's macOS sandbox ours cannot be added, so package code is not run at all (returncode 126).
Use a fresh work folder per call: a process that outlives one run could otherwise tamper with the next.
Not covered: a same-user process can read the initial environment of other processes of that user (macOS
KERN_PROCARGS2, Linux /proc/<pid>/environ), so keys that other processes hold in environment variables stay
readable; without network, IPC or writes outside the work folder the only way out is the output, whose
redaction (secret-named values, known key shapes) is a mitigation, not a control: encoded or split text gets
through. The sweep for leftover processes is best effort: one that re-executes itself with a fresh
environment is not found (it stays confined, and its work folder is not reused). Linux and Windows do not
confine files.
Standard library only.
"""
import contextlib
import ctypes
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

MARK = "HUMANSTUDY_SANDBOX"
RUN_MARK = "HUMANSTUDY_SANDBOX_RUN"
SECRET_NAME = re.compile(r"KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|BYPASS", re.I)
SECRET_SHAPES = re.compile(r"sk-ant-[A-Za-z0-9_-]{16,}|sk-or-v1-[A-Za-z0-9]{20,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}|"
                           r"\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|\bAKIA[0-9A-Z]{16}\b|"
                           r"\bAIza[0-9A-Za-z_-]{35}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----")
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


# Where other people's or other studies' files live; reads are denied there except the allowed folders.
MAC_PRIVATE = ("/Users", "/Volumes", "/private/tmp", "/private/var/folders", "/private/var/tmp")


def macos_profile(work, read=(), relay_port=None):
    private = [_real(Path.home())] + [p for p in MAC_PRIVATE if os.path.isdir(p)]
    allow_read = {_real(work), _real(Path(__file__).resolve().parent.parent)}  # the work folder and the skills
    allow_read.update(_real(p) for p in read if p)
    allow_read.update(_real(p) for p in _python_dirs())
    # Never re-open a private root (or a parent of one) because of a broad sys.path entry.
    allow_read = sorted(p for p in allow_read
                        if not any((q.rstrip(os.sep) + os.sep).startswith(p.rstrip(os.sep) + os.sep) for q in private))
    w = _sb_str(_real(work))
    lines = ["(version 1)", "(allow default)",
             "(deny network*)",
             "(deny process-info*)",
             '(deny sysctl-read)',
             '(allow sysctl-read (sysctl-name-regex #"^hw[.]") (sysctl-name-regex #"^kern[.]os") (sysctl-name "kern.version") (sysctl-name "kern.hostname"))',
             "(allow process-info* (target self))",
             # No talking to other processes either (browser via Launch Services, keychain, pasteboard):
             # only the user-name lookup that getpass/pwd need. No signals to processes outside the sandbox.
             "(deny mach-lookup)",
             "(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\"))",
             "(deny appleevent-send)",
             "(deny signal)",
             "(allow signal (target same-sandbox))",
             "(deny file-write*)",
             "(allow file-write* (subpath %s) (literal \"/dev/null\") (literal \"/dev/zero\") "
             "(literal \"/dev/tty\") (literal \"/dev/dtracehelper\") (subpath \"/dev/fd\"))" % w,
             "(deny file-read-data %s)" % " ".join("(subpath %s)" % _sb_str(_real(p)) for p in private)]
    if relay_port is not None:
        if type(relay_port) is not int or not 1 <= relay_port <= 65535:
            raise ValueError("invalid relay port")
        lines.append('(allow network-outbound (remote ip "localhost:%d"))' % relay_port)
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


def already_confined():
    """True when this process already runs inside the confinement wrapper() would add (checked with the
    kernel, so setting an environment variable cannot switch the sandbox off)."""
    if sys.platform == "darwin":
        try:
            check = ctypes.CDLL("/usr/lib/libSystem.dylib").sandbox_check
            check.restype = ctypes.c_int
            return check(os.getpid(), None, 0) != 0
        except (OSError, AttributeError):
            return False
    if sys.platform.startswith("linux"):
        try:
            return os.readlink("/proc/self/ns/net") != os.readlink("/proc/1/ns/net")
        except OSError:
            return False
    return False


RELAY_SANDBOX_EXEC = "/usr/bin/sandbox-exec"


def wrapper(work, read=(), relay_port=None, system_sandbox=False):
    """(argv prefix, confinement label) for this platform. A relay run (relay_port) or system_sandbox
    needs the system /usr/bin/sandbox-exec and refuses to run without it."""
    strict = relay_port is not None or system_sandbox
    if strict and sys.platform != "darwin":
        raise RuntimeError("Relay simulations require macOS sandbox-exec; Linux/Windows cannot enforce relay-only access.")
    if already_confined():
        if os.environ.get(MARK) == "1":  # our own confinement (the variable alone switches nothing off)
            return [], "inherited"
        if sys.platform == "darwin":  # someone else's sandbox: ours cannot be added on top, so do not run
            return None, "foreign sandbox"
    if sys.platform == "darwin":
        if strict:  # the relay trusts only the system binary, never one found on PATH
            exe = RELAY_SANDBOX_EXEC if os.path.isfile(RELAY_SANDBOX_EXEC) else None
        else:
            exe = shutil.which("sandbox-exec") or ("/usr/bin/sandbox-exec" if os.path.exists("/usr/bin/sandbox-exec") else None)
        if exe:  # the profile goes inline: a file in the work folder could be rewritten by a leftover process
            return [exe, "-p", macos_profile(work, read, relay_port)], \
                "sandbox-exec (no network, writes only in the work folder, home folder unreadable)"
        if strict:
            raise RuntimeError("Relay simulations require sandbox-exec.")
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


def _marked(nonce):
    """Pids of this user's processes whose initial environment carries the run marker."""
    me, needle, out = os.getpid(), ("%s=%s" % (RUN_MARK, nonce)).encode(), []
    if sys.platform.startswith("linux"):
        for d in os.listdir("/proc"):
            if d.isdigit() and int(d) != me:
                try:
                    with open("/proc/%s/environ" % d, "rb") as f:
                        if needle in f.read():
                            out.append(int(d))
                except OSError:
                    pass
    elif sys.platform == "darwin":
        try:
            pids = [int(x) for x in subprocess.run(["ps", "-U", str(os.getuid()), "-o", "pid="], capture_output=True,
                                                   text=True, timeout=30).stdout.split()]
            sysctl = ctypes.CDLL("/usr/lib/libSystem.dylib").sysctl
        except (OSError, ValueError, subprocess.SubprocessError, AttributeError):
            return []
        for pid in pids:
            if pid == me:
                continue
            mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
            size = ctypes.c_size_t(1 << 20)
            buf = ctypes.create_string_buffer(size.value)
            if sysctl(mib, 3, buf, ctypes.byref(size), None, 0) == 0 and needle in buf.raw[:size.value]:
                out.append(pid)
    return out


def _kill_leftovers(nonce):
    """End processes from this run that left its process group (setsid, double fork)."""
    if os.name == "nt":
        return
    for _ in range(5):
        pids = _marked(nonce)
        if not pids:
            return
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass


def redact(text):
    """Blank out the parent's secret values and anything shaped like a known key."""
    for k, v in os.environ.items():
        if SECRET_NAME.search(k) and v and len(v) >= 8:
            text = text.replace(v, "[redacted]")
    return SECRET_SHAPES.sub("[redacted]", text)


def _tail(f):
    f.seek(0, os.SEEK_END)
    size = f.tell()
    f.seek(max(0, size - MAX_OUTPUT))
    return redact(f.read().decode("utf-8", errors="replace"))


PRIVATE_NAMES = {"node_modules", "opencode.json", "__pycache__"}


def copy_tree(src, dst, ignore=None):
    """Copy a package or study without following symlinks; links that point outside `src` are left out,
    so a copy can never pull in a file from elsewhere (a link to ~/.ssh, say). Dotfiles and folders
    (.env, .git, .opencode, ...) and local tool configuration stay out of the copy too."""
    src = Path(src)
    root = _real(src)

    def skip(folder, names):
        out = set(ignore(folder, names)) if ignore else set()
        out.update(n for n in names if n.startswith(".") or n in PRIVATE_NAMES)
        for n in names:
            p = os.path.join(folder, n)
            if os.path.islink(p):
                t = _real(p)
                if not (t == root or t.startswith(root.rstrip(os.sep) + os.sep)):
                    out.add(n)
        return out
    shutil.copytree(str(src), str(dst), symlinks=True, ignore=skip)
    return Path(dst)


def run_python(script, args=(), cwd=None, work=None, timeout=600, read=(), env=None, relay_port=None,
               system_sandbox=False):
    """Run `python script args...` confined; `work` is the only folder it may write to (made if missing;
    use a fresh one per call).

    `read` names extra folders whose files the code may read (on macOS the home folder is otherwise
    unreadable); `cwd` and the script's folder are added. `env` adds non-secret variables."""
    if work is None:
        raise ValueError("run_python needs a work folder")
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    script = Path(script).resolve()
    reads = [script.parent] + ([cwd] if cwd else []) + list(read)
    pre, label = wrapper(work, reads, relay_port, system_sandbox)
    if pre is None:
        return Result(126, "", "refused: this process runs inside a sandbox that is not HumanStudy's, so package "
                               "code cannot be confined here; run the check from a normal terminal or the app\n",
                      False, label)
    argv = pre + [sys.executable, "-I", "-B", "-X", "utf8", "-c", BOOT, str(script)] + [str(a) for a in args]
    kw = {"start_new_session": True} if os.name != "nt" else \
        {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)}
    nonce = uuid.uuid4().hex
    child_env = env_for(work, env)
    child_env[RUN_MARK] = nonce
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(argv, cwd=str(cwd or work), env=child_env, stdin=subprocess.DEVNULL,
                                stdout=out, stderr=err, close_fds=True, **kw)
        timed_out = False
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        _kill_tree(proc, timed_out)  # on POSIX also ends anything the code left running in its group
        proc.wait()
        _kill_leftovers(nonce)
        return Result(proc.returncode, _tail(out), _tail(err), timed_out, label)
