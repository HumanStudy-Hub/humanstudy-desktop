"""Trusted entry point: confine the complete run script before any package imports.

macOS desktop runs (the app sets HUMANSTUDY_RELAY_REQUIRED=1) use the app's per-approval relay
capability inside sandbox-exec; no real credential is inherited. On Linux and Windows the app does
not set it: the script runs as before, unconfined, and can read the key in its environment (the
run confirmation tells the researcher). Hand-run study_core.py keeps using the researcher's own key.
"""
import json
import os
import subprocess
import urllib.request
import sys
from pathlib import Path
from urllib.parse import urlsplit


def run_unconfined(script, args):
    """Pre-relay path: exactly what `python run.py ...` in the run folder did."""
    return subprocess.call([sys.executable, str(script), *args], cwd=str(script.parent))


def main():
    if len(sys.argv) < 2:
        raise SystemExit('usage: run_confined.py RUN_SCRIPT [args...]')
    args = sys.argv[1:]
    final = args[0] == '--final'
    if final:
        args.pop(0)
    if not args:
        raise SystemExit('usage: run_confined.py [--final] RUN_SCRIPT [args...]')
    script = Path(args[0]).resolve()
    if os.environ.get('HUMANSTUDY_RELAY_REQUIRED') != '1':
        raise SystemExit(run_unconfined(script, args[1:]))
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'build'))
    from sandbox_run import run_python
    project = next((p for p in script.parents if (p / '.humanstudy').is_dir()), None)
    if project is None:
        raise SystemExit('No approved desktop project.')
    if not script.is_relative_to((project / 'artifacts/simulations').resolve()):
        raise SystemExit('The run script must be inside artifacts/simulations/.')
    descriptor = os.environ.get('HUMANSTUDY_RELAY_DESCRIPTOR')
    if not descriptor:
        raise SystemExit('No approved desktop model relay.')
    config = json.loads(Path(descriptor).read_text())
    url = urlsplit(config['baseURL'])
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port or url.path != '/v1':
        raise SystemExit('Invalid model relay.')
    env = {'OPENROUTER_API_KEY': config['token'], 'OPENROUTER_BASE_URL': config['baseURL'],
           'OPENAI_API_KEY': config['token'], 'OPENAI_BASE_URL': config['baseURL'],
           'HUMANSTUDY_DESKTOP_KEY': config['token'], 'HUMANSTUDY_HOSTED_BASEURL': config['baseURL'],
           'HUMANSTUDY_SIM_MODEL': config['model'], 'HUMANSTUDY_PROJECT_DIR': str(project)}
    try:
        result = run_python(script, args[1:], cwd=project, work=script.parent,
                            read=[project / 'package', project / 'sources', project / 'program.json', project / '.opencode/skills'], timeout=1800, env=env, relay_port=url.port)
    finally:
        if final:
            try:
                request = urllib.request.Request(config['baseURL'] + '/run/complete', data=b'',
                                                 headers={'Authorization': 'Bearer ' + config['token']})
                urllib.request.urlopen(request, timeout=5).close()
            except OSError:
                pass
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
