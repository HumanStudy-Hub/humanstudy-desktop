#!/usr/bin/env python3
"""Formal build of one paper through the desktop app's own kernel and hosted models.

    python eval/replay/desktop_build.py --project <new dir> --paper paper.pdf [--resource supp.pdf ...]
        --research-auth <private profile> [--model anthropic/claude-sonnet-5.5]

This is the same path as a build in the app: scripts/prepare_conversion.py --engine opencode prepares
the project, and app/scripts/opencode-assets.mjs runs the desktop OpenCode kernel on the hosted
HumanStudy models under the signed-in research account. Step 1 is the app's initial conversion
(program.json); step 2, in the same session, builds the runnable replay package.

The research profile is created once by the account owner with app/scripts/research-auth.mjs (see
docs/headless-research.md). This script never reads or prints the key inside it.
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
APP_SUPPORT = Path.home() / "Library/Application Support/HumanStudy Hub"
PACKAGE = ("The initial conversion is done. Now use the build skill to build the runnable replay package "
           "for this program in package/<slug>/, with check_package.py passing. Transcribe printed "
           "instruments verbatim, keep missing information as open issues, and do not run any simulation.")


def newest(pattern):
    found = sorted(APP_SUPPORT.glob(pattern))
    return str(found[-1]) if found else None


def turn(proc, out, op, text=None, timeout=5400):
    """Send one op and wait for its done/error event. Returns the final event."""
    msg = {"op": op, "id": "%s-%d" % (op, int(time.time()))}
    if text:
        msg["text"] = text
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    end = time.time() + timeout
    while time.time() < end:
        line = out.get(timeout=end - time.time())
        if line is None:
            return {"eventType": "error", "error": "worker exited"}
        if line.get("type") == "event" and line.get("eventType") in ("done", "error"):
            return line
    return {"eventType": "error", "error": "timeout"}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", required=True)
    ap.add_argument("--paper", required=True)
    ap.add_argument("--resource", action="append", default=[])
    ap.add_argument("--research-auth", required=True)
    ap.add_argument("--model", default=None, help="hosted model id; default: the desktop default")
    ap.add_argument("--binary", default=os.environ.get("HUMANSTUDY_OPENCODE_BIN") or newest("opencode/*/opencode"))
    ap.add_argument("--runtime-bin", default=newest("runtime/py*/bin"))
    ap.add_argument("--no-package", action="store_true", help="program only, as the app's initial conversion")
    ap.add_argument("--send", help="send this one instruction to an already built project instead of building")
    a = ap.parse_args(argv)
    project = Path(a.project).resolve()
    if not a.binary or not a.runtime_bin:
        raise SystemExit("install the desktop app (OpenCode and the managed runtime), or pass --binary/--runtime-bin")
    py = str(Path(a.runtime_bin) / "python3")
    if not (project / ".humanstudy/conversion-pack.json").is_file():
        args = [py, str(REPO / "scripts/prepare_conversion.py"), "--engine", "opencode", "--project", str(project),
                "--paper", a.paper]
        for r in a.resource:
            args += ["--resource", r]
        subprocess.run(args, check=True, stdout=subprocess.DEVNULL)
    cmd = ["node", str(REPO / "app/scripts/opencode-assets.mjs"), "--project", str(project), "--binary", a.binary,
           "--runtime-bin", a.runtime_bin, "--research-auth", a.research_auth, "--timeout-minutes", "90",
           "--stall-minutes", "10"] + (["--model", a.model] if a.model else [])
    log = open(project.parent / ("%s.desktop.log" % project.name), "a", encoding="utf-8")
    proc = subprocess.Popen(cmd, cwd=str(REPO), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
                            text=True, bufsize=1)
    import queue
    out = queue.Queue()

    def pump():
        for raw in proc.stdout:
            log.write(raw)
            log.flush()
            try:
                out.put(json.loads(raw))
            except ValueError:
                pass
        out.put(None)
    threading.Thread(target=pump, daemon=True).start()
    result = {"project": str(project)}
    try:
        while True:  # wait for the worker to be ready
            line = out.get(timeout=600)
            if line is None:
                raise SystemExit("the desktop worker stopped before it was ready; see %s" % log.name)
            if line.get("type") == "ready":
                break
        start = time.time()
        if a.send:
            result["send"] = turn(proc, out, "send", a.send).get("eventType")
        else:
            result["program"] = turn(proc, out, "build").get("eventType")
        if result.get("program") == "done" and not a.no_package:
            result["package"] = turn(proc, out, "send", PACKAGE).get("eventType")
        result["minutes"] = round((time.time() - start) / 60, 1)
    finally:
        try:
            proc.stdin.write(json.dumps({"op": "quit", "id": "quit"}) + "\n")
            proc.stdin.flush()
            proc.wait(timeout=60)
        except Exception:
            proc.terminate()
    result["programFile"] = (project / "program.json").is_file()
    result["packages"] = sorted(p.parent.name for p in (project / "package").glob("*/study.json"))
    print(json.dumps(result))
    return 0 if result["programFile"] else 1


if __name__ == "__main__":
    sys.exit(main())
