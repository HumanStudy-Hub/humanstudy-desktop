#!/usr/bin/env python3
"""Apply one batch of Human Program records to program.json, so a build saves visible checkpoints.

Usage: python .opencode/skills/build/program_io.py .humanstudy/tmp/batch-01.json [--program program.json]
       (use - to read the batch from stdin)

A batch is a JSON object shaped like program.json, holding only what is new or changed. Lists of
records with an `id` (studies, nodes, steps, relations, evidence, issues, and a node's fields) merge
by id: a record sent again updates the keys it contains, records not in the batch are kept, new ones
are appended. Objects merge key by key; any other value (text, numbers, lists of ids) is replaced.
Nothing is invented: missing arrays start empty, and the first batch must give the top-level facts.
program.json is replaced atomically, so a failed batch leaves the saved file as it was.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

RECORDS = ("studies", "nodes", "steps", "relations", "evidence", "issues")
TOP = ("schemaVersion", "id", "title", "intent", "source")


def merge(old, new):
    if isinstance(old, dict) and isinstance(new, dict):
        out = dict(old)
        for key, value in new.items():
            out[key] = merge(old.get(key), value)
        return out
    if isinstance(old, list) and isinstance(new, list) and all(isinstance(x, dict) and x.get("id") for x in old + new):
        items = {x["id"]: x for x in old}
        for item in new:
            items[item["id"]] = merge(items.get(item["id"]), item)
        return list(items.values())
    return new


def apply(program: dict, batch: dict) -> dict:
    if not isinstance(batch, dict):
        raise ValueError("a batch must be a JSON object shaped like program.json")
    for key in RECORDS:
        if key in batch and (not isinstance(batch[key], list) or any(not isinstance(x, dict) or not x.get("id") for x in batch[key])):
            raise ValueError(f"{key} must be a list of records, each with an id")
    merged = merge(program, batch)
    absent = [key for key in TOP if merged.get(key) in (None, "", {})]
    if absent:
        raise ValueError("program.json still lacks " + ", ".join(absent) + "; put them in the first batch")
    if merged["schemaVersion"] != 2:
        raise ValueError("schemaVersion must be 2")
    for key in RECORDS:
        merged.setdefault(key, [])
    return merged


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("batch", help="JSON batch file, or - for stdin")
    parser.add_argument("--program", default="program.json")
    args = parser.parse_args()
    target = Path(args.program)
    try:
        text = sys.stdin.buffer.read().decode("utf-8") if args.batch == "-" else Path(args.batch).read_text(encoding="utf-8")
        batch = json.loads(text)
        prior = json.loads(target.read_text(encoding="utf-8")) if target.exists() else {}
        merged = apply(prior, batch)
    except (OSError, ValueError) as error:  # json.JSONDecodeError is a ValueError
        print(f"program_io: {error}. program.json was not changed.", file=sys.stderr)
        return 1
    tmp = target.with_name(target.name + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(merged, ensure_ascii=False, indent=2) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, target)
    counts = ", ".join(f"{len(merged[key])} {key}" for key in RECORDS)
    print(f"Saved {target}: {counts}. Run check_program.py next.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
