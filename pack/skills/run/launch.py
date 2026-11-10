#!/usr/bin/env python3
"""Start an approved protocol run from the app's trusted copy (review 4, S1). App-owned; the main process runs it
with `python -I -B`, from a copy of the shipped code it writes outside the project, never from the project's
editable .opencode folder and never from a script the agent wrote.

    python -I -B <code>/skills/run/launch.py <run folder> <project folder> <code folder>

The code folder holds the engine (<code>/hsenv), the run skill (<code>/skills/run), the sandbox launcher
(<code>/skills/build/sandbox_run.py), the artifact kit (<code>/artifact-kit) and, for a published study whose
original wording was filled in on this computer, the restored protocol (<code>/restored/protocol.json), all
written by the app. The run is
`app_run.py run <run folder> <project>` from that folder: its sys.path is the trusted run skill and engine only
(sandbox_run's boot puts the script's own folder first; -I keeps the working folder, PYTHONPATH and user site out),
plus the runtime's site-packages (humanstudy_llm). The project and the run folder are data, never code.

With a relay (macOS; env HS_RELAY_BASEURL, HS_RELAY_TOKEN, HS_RELAY_MODEL, HS_RELAY_EXPIRES_AT): the run is
confined by sandbox-exec (writes only in its run folder, network only to the relay port) and reaches the model
through the relay capability only; when it finishes well, the capability is handed back (/run/complete).
Without one (Linux, Windows: the pre-relay path) it runs unconfined with the environment the app gives it, as
package runs do there. Output goes to <run>/run.log.
"""
import os
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit


def main():
    run_dir, project, code = (Path(a).resolve() for a in sys.argv[1:4])
    # The app checked the run folder's real path; check it again now that it is resolved, since it becomes the
    # sandbox's only write root (review 6, S4).
    if not run_dir.is_relative_to(project) or run_dir.parent.name != "simulations":
        raise SystemExit("the run folder leads outside the project; the run was not started")
    sys.path.insert(0, str(code / "skills" / "build"))
    from sandbox_run import run_python
    entry = code / "skills" / "run" / "app_run.py"
    env = {"HUMANSTUDY_PROJECT_DIR": str(project), "HSENV_PRIVATE_CONFIG": "",
           "HUMANSTUDY_LLM_USAGE_LOG": str(run_dir / "llm-usage.jsonl")}
    for name in ("HUMANSTUDY_RUN_ROUTE", "HUMANSTUDY_RUN_ID", "HUMANSTUDY_RUN_PROTOCOL_SHA256", "HUMANSTUDY_RUN_APPROVED_AT",
                 "HUMANSTUDY_RUN_PLAN", "HUMANSTUDY_LLM_MAX_OUTPUT", "HUMANSTUDY_LANG"):
        if os.environ.get(name):
            env[name] = os.environ[name]
    base, token = os.environ.get("HS_RELAY_BASEURL", ""), os.environ.get("HS_RELAY_TOKEN", "")
    log = open(run_dir / "run.log", "a", encoding="utf-8")
    log.write("started %s from the app's trusted copy\n" % time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    log.flush()
    if base:
        url = urlsplit(base)
        if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port or url.path != "/v1":
            raise SystemExit("invalid model relay")
        env.update({"HUMANSTUDY_DESKTOP_KEY": token, "HUMANSTUDY_HOSTED_BASEURL": base,
                    "OPENROUTER_API_KEY": token, "OPENROUTER_BASE_URL": base,
                    "OPENAI_API_KEY": token, "OPENAI_BASE_URL": base,
                    "HUMANSTUDY_SIM_MODEL": os.environ.get("HS_RELAY_MODEL", "")})
        expires = float(os.environ.get("HS_RELAY_EXPIRES_AT") or 0) / 1000
        timeout = max(1, int(expires - time.time())) if expires else 1800
        result = run_python(entry, ["run", str(run_dir), str(project)], cwd=run_dir, work=run_dir,
                            read=[project, code], timeout=timeout, env=env, relay_port=url.port)
        log.write(result.stdout + result.stderr + "\nexit %s%s\n" % (result.returncode, " (time limit)" if result.timed_out else ""))
        log.close()
        if result.returncode == 0:
            try:   # a finished run gives its model access back
                request = urllib.request.Request(base + "/run/complete", data=b"", headers={"Authorization": "Bearer " + token})
                urllib.request.urlopen(request, timeout=5).close()
            except OSError:
                pass
        raise SystemExit(result.returncode)
    # Pre-relay path: the app's own environment for simulations (HUMANSTUDY_DESKTOP_KEY …), unconfined.
    import subprocess
    child_env = {**os.environ, **env}
    for name in ("HS_RELAY_BASEURL", "HS_RELAY_TOKEN", "HS_RELAY_MODEL", "HS_RELAY_EXPIRES_AT"):
        child_env.pop(name, None)
    boot = ("import os, runpy, sys; s = sys.argv[1]; sys.argv = sys.argv[1:]; "
            "sys.path.insert(0, os.path.dirname(os.path.abspath(s))); runpy.run_path(s, run_name='__main__')")
    code_ = subprocess.call([sys.executable, "-I", "-B", "-X", "utf8", "-c", boot, str(entry), "run", str(run_dir), str(project)],
                            cwd=str(run_dir), env=child_env, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
    log.close()
    raise SystemExit(code_)


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:   # a refusal says why in run.log, which the app quotes when it marks the run failed
        if e.code not in (None, 0) and not isinstance(e.code, int):
            try:
                with open(Path(sys.argv[1]) / "run.log", "a", encoding="utf-8") as fh:
                    fh.write("refused: %s\n" % e.code)
            except OSError:
                pass
        raise
    except Exception as e:   # noqa: BLE001
        try:
            with open(Path(sys.argv[1]) / "run.log", "a", encoding="utf-8") as fh:
                fh.write("launch failed: %s: %s\n" % (type(e).__name__, e))
        except OSError:
            pass
        raise SystemExit(1)
