"""Trusted entry point: confine the complete run script before any package imports.

Desktop runs use the app's per-approval relay capability; no real credential is inherited.
Linux/Windows refuse relay runs until relay-only network and process isolation exist.
Hand-run study_core.py remains available to researchers using their own credentials.
"""
import json
import os
import urllib.request
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'build'))
from sandbox_run import run_python


def main():
    if len(sys.argv) < 2:
        raise SystemExit('usage: run_confined.py RUN_SCRIPT [args...]')
    args = sys.argv[1:]
    final = args[0] == '--final'
    if final:
        args.pop(0)
    script = Path(args[0]).resolve()
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
                            read=[project], timeout=86400, env=env, relay_port=url.port)
    finally:
      if final:
        try:
            request = urllib.request.Request(config['baseURL'] + '/run/complete', data=b'', headers={'Authorization': 'Bearer ' + config['token']})
            urllib.request.urlopen(request, timeout=5).close()
        except OSError:
            pass
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
