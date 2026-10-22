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
import hashlib
import json
import os
import sys
import time
import uuid
from program_lock import program_lock
from pathlib import Path

RECORDS = ("studies", "nodes", "steps", "relations", "evidence", "issues")
TOP = ("schemaVersion", "id", "title", "intent", "source")


def protected(value):
    if isinstance(value, dict):
        return value.get("origin") == "researcher" and value.get("state") == "confirmed" or any(protected(v) for v in value.values())
    return isinstance(value, list) and any(protected(v) for v in value)


def merge(old, new, conflicts=None, path=()):
    # A confirmed researcher's field/rule is indivisible. Even a value-only model patch must not
    # keep its researcher label while changing its contents. App field edits are the resolution path.
    if isinstance(old, dict) and old.get("origin") == "researcher" and old.get("state") == "confirmed":
        candidate = dict(old, **new) if isinstance(new, dict) else new
        if candidate != old and conflicts is not None:
            conflicts.append({"path": list(path), "kept": old, "proposed": new})
        return old
    if protected(old) and not (isinstance(old, dict) and isinstance(new, dict) or isinstance(old, list) and isinstance(new, list) and all(isinstance(x, dict) and x.get("id") for x in new)):
        if conflicts is not None and old != new:
            conflicts.append({"path": list(path), "kept": old, "proposed": new})
        return old
    if isinstance(old, dict) and isinstance(new, dict):
        out = dict(old)
        for key, value in new.items():
            out[key] = merge(old.get(key), value, conflicts, (*path, key))
        return out
    if isinstance(old, list) and isinstance(new, list) and all(isinstance(x, dict) and x.get("id") for x in new) \
            and all(isinstance(x, dict) for x in old):
        # Update the first record with that id in place (the one the app shows); never drop or reorder
        # saved records, including duplicates the researcher has not resolved yet.
        out = list(old)
        for item in new:
            at = next((i for i, x in enumerate(out) if x.get("id") == item["id"]), None)
            if at is None:
                out.append(item)
            else:
                out[at] = merge(out[at], item, conflicts, (*path, item["id"]))
        return out
    return new


def apply(program: dict, batch: dict, conflicts=None) -> dict:
    if not isinstance(batch, dict):
        raise ValueError("a batch must be a JSON object shaped like program.json")
    for key in RECORDS:
        if key in batch and (not isinstance(batch[key], list) or any(not isinstance(x, dict) or not x.get("id") for x in batch[key])):
            raise ValueError(f"{key} must be a list of records, each with an id")
    merged = merge(program, batch, conflicts)
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
    tmp = target.with_name(f"{target.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        text = sys.stdin.buffer.read().decode("utf-8-sig") if args.batch == "-" else Path(args.batch).read_text(encoding="utf-8-sig")
        batch = json.loads(text)
        with program_lock(target):
            prior = json.loads(target.read_text(encoding="utf-8-sig")) if target.exists() else {}
            conflicts = []
            merged = apply(prior, batch, conflicts)
            if conflicts:
                # Retain the whole proposal locally and surface targeted review issues in the Study.
                report_dir = target.parent / ".humanstudy" / "program-conflicts"
                report_dir.mkdir(parents=True, exist_ok=True)
                report = report_dir / f"{time.time_ns()}-{uuid.uuid4().hex}.json"
                report.write_text(json.dumps(conflicts, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                for conflict in conflicts:
                    path = conflict["path"]
                    issue_id = "researcher-conflict-" + hashlib.sha256(json.dumps(path).encode()).hexdigest()[:24]
                    issue = {"id": issue_id, "title": "Review a proposed change to your confirmed edit", "severity": "decision",
                             "reason": "The agent proposed a different value. Your confirmed edit was kept.",
                             "impact": "The proposal has not changed the accepted study.",
                             "suggestedAction": f"Review the full proposal in {report.relative_to(target.parent).as_posix()} and edit the field if you accept it.", "evidenceIds": []}
                    if len(path) >= 4 and path[0] == "nodes" and path[2] == "fields":
                        issue.update(nodeId=path[1], fieldId=path[3])
                    elif len(path) >= 3 and path[0] == "steps" and path[2] == "rule":
                        issue.update(stepId=path[1])
                    merged["issues"] = [i for i in merged["issues"] if i.get("id") != issue_id] + [issue]
                print(f"Kept {len(conflicts)} confirmed researcher edit(s); proposed changes saved to {report} for review.", file=sys.stderr)
            with tmp.open("w", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps(merged, ensure_ascii=False, indent=2) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            # Windows file sharing can transiently block an atomic replacement.
            for attempt in range(10):
                try:
                    os.replace(tmp, target)
                    break
                except PermissionError:
                    if attempt == 9:
                        raise
                    time.sleep(0.2)
    except (OSError, ValueError) as error:
        tmp.unlink(missing_ok=True)
        print(f"program_io: {error}. program.json was not changed.", file=sys.stderr)
        return 1
    counts = ", ".join(f"{len(merged[key])} {key}" for key in RECORDS)
    print(f"Saved {target}: {counts}. Run check_program.py next.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
