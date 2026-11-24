#!/usr/bin/env python3
"""Write a Human Program incrementally, by stable IDs, without giant generated tool arguments."""
import argparse, json, os
from pathlib import Path


def merge(old, new):
    if isinstance(old, dict) and isinstance(new, dict):
        return {**old, **{k: merge(old.get(k), v) for k, v in new.items()}}
    if isinstance(old, list) and isinstance(new, list) and all(isinstance(x, dict) and x.get('id') for x in old + new):
        items = {x['id']: x for x in old}
        for item in new:
            items[item['id']] = merge(items.get(item['id']), item)
        return list(items.values())
    return new


def apply(program, patch):
    for key in ('studies', 'nodes', 'steps', 'relations', 'evidence', 'issues'):
        if key in patch and (not isinstance(patch[key], list) or any(not isinstance(x, dict) or not x.get('id') for x in patch[key])):
            raise ValueError(key + ' must contain records with stable ids')
    return merge(program, patch)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('patch', help='JSON batch file, or - for stdin')
    parser.add_argument('--program', default='program.json')
    args = parser.parse_args()
    target = Path(args.program)
    patch = json.load(__import__('sys').stdin) if args.patch == '-' else json.loads(Path(args.patch).read_text())
    prior = json.loads(target.read_text()) if target.exists() else {}
    merged = apply(prior, patch)
    if merged.get('schemaVersion') != 2 or not merged.get('id') or not merged.get('title'):
        raise ValueError('First batch must provide schemaVersion=2, id, title and source, plus the six record arrays')
    for key in ('studies', 'nodes', 'steps', 'relations', 'evidence', 'issues'):
        merged.setdefault(key, [])
    merged.setdefault('intent', 'reconstruct')
    # Parse/serialize before replacement. Failed batches never damage an existing valid file.
    text = json.dumps(merged, ensure_ascii=False, indent=2) + '\n'
    tmp = target.with_suffix(target.suffix + '.tmp')
    with tmp.open('w', encoding='utf8') as handle:
        handle.write(text); handle.flush(); os.fsync(handle.fileno())
    os.replace(tmp, target)
    print('Saved', target, {key: len(merged[key]) for key in ('studies', 'nodes', 'steps', 'evidence', 'issues')})

if __name__ == '__main__':
    main()
