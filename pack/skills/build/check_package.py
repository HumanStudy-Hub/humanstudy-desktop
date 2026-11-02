#!/usr/bin/env python3
"""Check a replay package against the HumanStudy-Bench contract, offline.

Usage: python check_package.py package/<paper-slug> [--program program.json]

Mirrors HumanStudy-Bench/agent_pipeline/validate_package.py: the required files exist, every JSON
file parses, the program is the project's program.json, task/task.json.programBindings cover the
program exactly, and `task/adapter.py --smoke-test` exits 0. Prints one line per check; exits 1 on
the first failure.

Two layouts pass:
- slim (inside a project or community paper): study.json has `programRef` {path: "../../program.json",
  id} instead of a copy; source/evidence.json and audit/missing_information.json are not written,
  because both are views of program.json (its evidence and issues).
- standalone (the eight-file HumanStudy-Bench contract): study.json.program is an exact copy and the
  two view files exist.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

REQUIRED = [
    "study.json",
    "source/paper_metadata.json",
    "materials/materials.json",
    "task/task.json",
    "task/adapter.py",
    "evaluation/evaluation.py",
]
# Views of program.json: required only in the standalone layout (study.json.program is a copy).
STANDALONE_VIEWS = ["source/evidence.json", "audit/missing_information.json"]
PROGRAM_REF = "../../program.json"


def fail(msg: str) -> None:
    print(f"FAIL {msg}")
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("package", type=Path, help="package/<paper-slug>")
    parser.add_argument("--program", type=Path, default=None, help="project program.json to compare with")
    args = parser.parse_args()
    root: Path = args.package.resolve()
    if not root.is_dir():
        fail(f"{root} is not a folder")

    missing = [name for name in REQUIRED if not (root / name).is_file()]
    if missing:
        fail("missing required files: " + ", ".join(missing))
    print("ok   required files present")

    for path in root.rglob("*.json"):
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            fail(f"invalid JSON in {path.relative_to(root)}: {exc}")
    print("ok   every JSON file parses")

    study = json.loads((root / "study.json").read_text(encoding="utf-8"))
    program = study.get("program")
    slim = program is None
    if slim:
        ref = study.get("programRef")
        if not isinstance(ref, dict) or ref.get("path") != PROGRAM_REF:
            fail('study.json needs programRef {"path": "%s", "id": <program id>} (or, standalone, a program copy)' % PROGRAM_REF)
        source = args.program or (root / PROGRAM_REF)
        if not Path(source).is_file():
            fail("study.json refers to %s, which does not exist" % PROGRAM_REF)
        program = json.loads(Path(source).read_text(encoding="utf-8"))
        if ref.get("id") != program.get("id"):
            fail("study.json programRef.id %r is not the program's id %r" % (ref.get("id"), program.get("id")))
        print("ok   slim layout: study.json refers to program.json")
    elif not isinstance(program, dict):
        fail("study.json.program must be the Human Program (standalone) or absent with programRef (slim)")
    else:
        absent = [name for name in STANDALONE_VIEWS if not (root / name).is_file()]
        if absent:
            fail("standalone layout (study.json holds a program copy) needs: " + ", ".join(absent))
        print("ok   standalone layout: program copy and views present")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from check_program import check as check_program  # same rules as the app's validateHumanProgram

    bad = check_program(program)
    if bad:
        fail("program has problems:\n" + "\n".join(f"  {m}" + (f"  [fix: {h}]" if h else "") for m, h in bad))
    print("ok   program passes check_program.py")
    if args.program is not None and not slim:
        canonical = json.loads(args.program.read_text(encoding="utf-8"))
        if canonical != program:
            fail("study.json.program differs from program.json; copy the canonical program exactly")
        print("ok   study.json.program equals program.json")

    task = json.loads((root / "task/task.json").read_text(encoding="utf-8"))
    expected = {
        "programId": program.get("id"),
        "stepIds": [s["id"] for s in program.get("steps", [])],
        "recordNodeIds": [n["id"] for n in program.get("nodes", []) if n.get("kind") in ("record", "variable")],
        "analysisNodeIds": [n["id"] for n in program.get("nodes", []) if n.get("kind") == "analysis"],
    }
    if task.get("programBindings") != expected:
        fail("task/task.json.programBindings do not match the program; expected " + json.dumps(expected)[:600])
    print("ok   programBindings cover the program")

    issue_ids = {i.get("id") for i in program.get("issues", [])}
    audit_path = root / "audit/missing_information.json"
    audit = json.loads(audit_path.read_text(encoding="utf-8")) if audit_path.is_file() else []
    entries = audit if isinstance(audit, list) else audit.get("entries", [])
    for entry in entries:
        for key in ("study", "field", "reason", "impact", "suggested_action"):
            if key not in entry:
                fail(f"audit entry lacks '{key}': {json.dumps(entry)[:200]}")
        if entry.get("id") and entry["id"] not in issue_ids:
            fail(f"audit entry {entry['id']} has no matching program issue")
    if audit_path.is_file():
        print(f"ok   audit checklist well-formed ({len(entries)} entries)")

    result = subprocess.run(
        [sys.executable, str(root / "task/adapter.py"), "--smoke-test"],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        fail("adapter smoke test failed:\n" + result.stdout + result.stderr)
    print("ok   task/adapter.py --smoke-test")
    print("PASS package checks")


if __name__ == "__main__":
    main()
