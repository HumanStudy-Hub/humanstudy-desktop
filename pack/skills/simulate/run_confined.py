"""Trusted entry point: confine the complete run script before any package imports.

macOS desktop runs (the app sets HUMANSTUDY_RELAY_REQUIRED=1) use the app's per-approval relay
capability inside sandbox-exec; no real credential is inherited. Desktop legacy runs require
verified file isolation. Hand-run study_core.py keeps using the researcher's own key.
"""
import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
import sys
from pathlib import Path
from urllib.parse import urlsplit


def run_unconfined(script, args):
    """Pre-relay path: exactly what `python run.py ...` in the run folder did."""
    # -B: package code imported by the run writes no __pycache__ into the package
    # The engine's private sidecar (study pins outside the public code) is never read in a desktop run.
    return subprocess.call([sys.executable, '-B', str(script), *args], cwd=str(script.parent),
                           env={**os.environ, 'HSENV_PRIVATE_CONFIG': ''})


USAGE = 'usage: run_confined.py [--final | --no-model] SCRIPT [args...]'
ENDED = ('The approved model access for this run has ended (it ends when a run finishes, on Stop, '
         'or when its time limit is reached). Ask the researcher to press Run simulation again.')


def main():
    args = sys.argv[1:]
    final = bool(args) and args[0] == '--final'
    no_model = bool(args) and args[0] == '--no-model'
    if final or no_model:
        args.pop(0)
    if not args:
        raise SystemExit(USAGE)
    script = Path(args[0]).resolve()
    if os.environ.get('HUMANSTUDY_RELAY_REQUIRED') != '1':
        if os.environ.get('HUMANSTUDY_DESKTOP_APP') == '1':
            raise SystemExit('Legacy package execution requires verified file isolation. Use a supported protocol to run this study.')
        raise SystemExit(run_unconfined(script, args[1:]))
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'build'))
    from sandbox_run import run_python
    project = next((p for p in script.parents if (p / '.humanstudy').is_dir()), None)
    if project is None:
        raise SystemExit('No approved desktop project.')
    if no_model:
        # Model-free package code (study_core.py reproduce): no network at all, no relay needed,
        # writes only in a fresh scratch folder, no credential in the environment.
        work = Path(tempfile.mkdtemp(prefix='confined-', dir=str(_scratch(project))))
        try:
            result = run_python(script, args[1:], cwd=project, work=work, timeout=1800,
                                env={'HUMANSTUDY_PROJECT_DIR': str(project)}, system_sandbox=True)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        _finish(result)
    if not script.is_relative_to((project / 'artifacts/simulations').resolve()):
        raise SystemExit('The run script must be inside artifacts/simulations/.')
    descriptor = os.environ.get('HUMANSTUDY_RELAY_DESCRIPTOR')
    if not descriptor:
        raise SystemExit('No approved desktop model relay.')
    try:
        config = json.loads(Path(descriptor).read_text())
    except (OSError, ValueError):
        raise SystemExit(ENDED)
    url = urlsplit(config['baseURL'])
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.path != '/v1':
        raise SystemExit('Invalid model relay.')
    env = {'OPENROUTER_API_KEY': config['token'], 'OPENROUTER_BASE_URL': config['baseURL'],
           'OPENAI_API_KEY': config['token'], 'OPENAI_BASE_URL': config['baseURL'],
           'HUMANSTUDY_DESKTOP_KEY': config['token'], 'HUMANSTUDY_HOSTED_BASEURL': config['baseURL'],
           'HUMANSTUDY_SIM_MODEL': config['model'], 'HUMANSTUDY_PROJECT_DIR': str(project),
           'HSENV_PRIVATE_CONFIG': ''}   # the engine's private sidecar is never read in a desktop run
    # What the approval lets this capability run (the app wrote the descriptor; the agent cannot forge it): the route, the
    # SHA-256 of protocol.json the app read at approval, and the run id. skills/run and simkit check them.
    for key, name in (('route', 'HUMANSTUDY_RUN_ROUTE'), ('runId', 'HUMANSTUDY_RUN_ID'), ('protocolSha256', 'HUMANSTUDY_RUN_PROTOCOL_SHA256')):
        if isinstance(config.get(key), str):
            env[name] = config[key]
    if isinstance(config.get('approvedAt'), int) and not isinstance(config.get('approvedAt'), bool):
        env['HUMANSTUDY_RUN_APPROVED_AT'] = str(config['approvedAt'])
    # The sandbox lets the script write only in its run folder, so the usage log (token counts,
    # finish_reason, truncated; never prompt text) goes there instead of .humanstudy/tmp.
    env['HUMANSTUDY_LLM_USAGE_LOG'] = str(script.parent / 'llm-usage.jsonl')
    output = os.environ.get('HUMANSTUDY_LLM_MAX_OUTPUT', '')
    if output.isdigit():  # per-call output limit for humanstudy_llm / http_llm; a number, nothing else
        env['HUMANSTUDY_LLM_MAX_OUTPUT'] = output
    # The run folder is the working directory, as with `python run.py` on the pre-relay path. The
    # project stays readable (study_core needs capabilities.json, effects.json and human data);
    # writes stay in the run folder. The project holds no credential.
    result = run_python(script, args[1:], cwd=script.parent, work=script.parent, read=[project],
                        timeout=_remaining(config), env=env, relay_port=url.port)
    if final and result.returncode == 0:
        # A finished run gives up its access. After a failure it stays (within its token and time
        # limits) so the fixed script can be started again; Stop and expiry still end it.
        try:
            request = urllib.request.Request(config['baseURL'] + '/run/complete', data=b'',
                                             headers={'Authorization': 'Bearer ' + config['token']})
            urllib.request.urlopen(request, timeout=5).close()
        except OSError:
            pass
    _finish(result)


def _remaining(config):
    """Seconds until the relay capability expires (the script cannot reach the model after that);
    1800 for a descriptor without expiresAt."""
    expires = config.get('expiresAt')
    if isinstance(expires, bool) or not isinstance(expires, (int, float)):
        return 1800
    return max(1, int(expires / 1000 - time.time()))


def _scratch(project):
    folder = project / '.humanstudy' / 'tmp'
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _finish(result):
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
