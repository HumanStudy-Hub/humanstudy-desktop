#!/usr/bin/env python3
"""Regenerate the app sample's study card and offline view with the shipped engine; no model calls."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SAMPLE = ROOT / 'app/resources/protocol-sample'


def main():
    protocol = json.loads((SAMPLE / 'protocol.json').read_text(encoding='utf-8'))
    sha = hashlib.sha256(json.dumps(protocol, sort_keys=True).encode()).hexdigest()
    card = {'schema_version': '1', 'id': protocol['id'], 'title': protocol['meta']['title'],
            'authors': ['Diana Mazzarella', 'Emmanuel Trouche', 'Hugo Mercier', 'Ira Noveck'],
            'year': 2018, 'doi': protocol['meta']['doi'], 'version': '1.0.0',
            'quality': 'high_fidelity', 'quality_evidence': ['review/fidelity-review-1.md', 'review/resolutions-1.md', 'review/checks-latest.json'],
            'licence': {'paper': 'CC-BY-4.0', 'materials': 'CC-BY-4.0'},
            'protocol': {'path': 'protocol.json', 'sha256': sha, 'schema_version': '1'}, 'hsenv': '>=0.8,<0.9'}
    (SAMPLE / 'study.json').write_text(json.dumps(card, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    # Work only on a disposable copy: the shipped sample contains no runtime or hidden app state.
    with tempfile.TemporaryDirectory(prefix='hs-sample-') as td:
        project = Path(td)
        for rel in ['protocol.json', 'paper.pdf', 'sourcetext/paper.txt']:
            dest = project / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SAMPLE / rel, dest)
        for source, dest in [('runtime/hsenv', 'hsenv'), ('skills/preview', 'skills/preview'), ('artifact-kit', 'artifact-kit')]:
            shutil.copytree(ROOT / 'pack' / source, project / '.opencode' / dest, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        subprocess.run([sys.executable, str(project / '.opencode/skills/preview/make_preview.py')], cwd=project, check=True)
        shutil.copy2(project / 'artifacts/preview.html', SAMPLE / 'artifacts/preview.html')


if __name__ == '__main__':
    main()
