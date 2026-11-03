"""Trusted entry point: confine the complete run script before any package imports.

macOS desktop runs (the app sets HUMANSTUDY_RELAY_REQUIRED=1) use the app's per-approval relay
capability inside sandbox-exec; no real credential is inherited. On Linux and Windows the app does
not set it: the script runs as before, unconfined, and can read the key in its environment (the
run confirmation tells the researcher). Hand-run study_core.py keeps using the researcher's own key.
"""
import json
import os
import shutil
import subprocess
import tempfile
import urllib.request
import sys
from pathlib import Path
from urllib.parse import urlsplit


def run_unconfined(script, args):
    """Pre-relay path: exactly what `python run.py ...` in the run folder did."""
    return subprocess.call([sys.executable, str(script), *args], cwd=str(script.parent))


USAGE = 'usage: run_confined.py [--final | --no-model] SCRIPT [args...]'
ENDED = ('The approved model access for this run has ended (it ends when a run finishes, on Stop, '
         'or after 30 minutes). Ask the researcher to press Run simulation again.')


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
           'HUMANSTUDY_SIM_MODEL': config['model'], 'HUMANSTUDY_PROJECT_DIR': str(project)}
    # The run folder is the working directory, as with `python run.py` on the pre-relay path. The
    # project stays readable (study_core needs capabilities.json, effects.json and human data);
    # writes stay in the run folder. The project holds no credential.
    result = run_python(script, args[1:], cwd=script.parent, work=script.parent, read=[project],
                        timeout=1800, env=env, relay_port=url.port)
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
