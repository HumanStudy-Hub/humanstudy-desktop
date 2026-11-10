#!/usr/bin/env python3
"""Apply a small protocol object patch atomically; refuse stale or implicit overwrites."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
from program_lock import program_lock


def merge(old, patch):
    if not isinstance(old, dict) or not isinstance(patch, dict):
        return copy.deepcopy(patch)
    result = copy.deepcopy(old)
    for key, value in patch.items():
        result[key] = merge(result.get(key), value)
    return result


def apply_patch(project, patch, expected):
    target = Path(project) / 'protocol.json'
    if not isinstance(patch, dict):
        raise ValueError('A checkpoint must be a JSON object')
    with program_lock(target):
        prior = target.read_bytes() if target.exists() else None
        actual = hashlib.sha256(prior).hexdigest() if prior is not None else 'absent'
        if actual != expected:
            raise ValueError('The study changed since it was read. Re-read it and preserve the researcher edits; no file was changed.')
        old = json.loads(prior) if prior is not None else {}
        if old.get('distribution') or patch.get('distribution'):
            raise ValueError('Published wording cannot be edited through build checkpoints; use the original-wording workflow.')
        result = merge(old, patch)
        if result.get('schema_version') != '1' or not isinstance(result.get('id'), str) or not result['id']:
            raise ValueError('A checkpoint needs schema_version 1 and a study id')
        raw = (json.dumps(result, ensure_ascii=False, indent=1) + '\n').encode('utf-8')
        temp = None
        try:
            fd, temp = tempfile.mkstemp(dir=target.parent, prefix='.protocol-', suffix='.tmp')
            with os.fdopen(fd, 'wb') as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, target)
        finally:
            if temp and Path(temp).exists():
                Path(temp).unlink()
        return hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('patch')
    parser.add_argument('--expected-hash', required=True)
    args = parser.parse_args()
    try:
        print(apply_patch(Path.cwd(), json.loads(Path(args.patch).read_text(encoding='utf-8')), args.expected_hash))
    except (ValueError, OSError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
