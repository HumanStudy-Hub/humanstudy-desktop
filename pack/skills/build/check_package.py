#!/usr/bin/env python3
"""Check a replay package against the HumanStudy-Bench contract, offline.

Usage: python check_package.py package/<paper-slug> [--program program.json] [--no-validity]

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

In a project (slim layout) it also requires sources/SOURCE.json to record every source file with its
current SHA-256 and a license entry (write it with sources.py), and runs check_validity.py: no prompt tells
participants what the paper says they were not told, the memory design is a recorded decision, one
unparsed reply does not drop a participant, missing instructions are a decision. Also in a project:
downloaded sources carry a stated licence (fetch_source.py), the authors' analysis code, survey versions and
researcher questions are checked against them (check_source_use.py), and no survey text participants never
saw is used (qsf_flow.py), no participant text carries Word-export markup or runs two lines of a .docx under
sources/ together (docx_text.py), and no researcher question is about a licence, a blocked condition says what is
missing, and the layout is recorded (design_checks.py). check_validity.py also runs the analysis: every runnable arm
with keyed stand-in replies, then evaluate() and effect_estimates() as the replay does; an effect that does not compute
and is not excluded in capabilities.json fails. No package ships compiled Python (__pycache__, .pyc). A package with the shared reply reader (task/replies.py) also
runs the answer-aware smoke test (check_replies.py) and the every-answer-recorded check (recorded_answers.py; when it
cannot judge, the reason is printed in its ok line). A package without task/replies.py (built before the shared
reader) gets a note line instead, not a failure. For such an older package the downloaded-source, source-use, survey,
Word-source and design findings, and check_validity.py's newer prompt rules, are printed as
`warn  <message>  [fix: ...]` lines and the package still passes (contract.py); rebuilding under the current contract
makes them failures. The rules added with build contract 3 (an earlier release of task/replies.py, compiled Python,
the not-printed claims, the survey transcription rules, the batch-list licences, check_validity.py's analysis run)
are `warn` lines below study.json buildContract 3 and failures from it (contract.strict).

The structural checks (files, JSON, program, bindings, adapter smoke test) stop at the first failure; the checks
after them (sources, replies, validity, survey, Word and design) each print their FAIL line and the run goes on, so
one failure never hides another; the exit is 1 when any failed. --no-validity skips check_validity.py:
check_readiness.py runs it itself, so the analysis run is not done twice.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sandbox_run  # noqa: E402

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
# Files the project format puts beside program.json that a package may read (plus the paper PDF, sources/).
BESIDE_PROGRAM = {"program.json", "effects.json", "capabilities.json", "README.md"}


def fail(msg: str) -> None:
    print(f"FAIL {msg}")
    sys.exit(1)


FAILED: list = []


def collect(msg: str) -> None:
    """A failure of a check the later checks do not depend on: printed now, the run goes on and exits 1 at the
    end, so one failure does not hide the others (survey, Word and design checks after a validity failure)."""
    print(f"FAIL {msg}")
    FAILED.append(msg)


def warn(bad: list) -> None:
    """A newer rule's findings on a package built before the current contract: printed, never a failure."""
    for m, h in bad:
        print(f"warn  {m}" + (f"  [fix: {h}]" if h else ""))


def compiled(root: Path) -> list:
    """__pycache__ folders and stray .pyc/.pyo files in a package, outermost first, relative to it."""
    found = sorted(p.relative_to(root).as_posix() for p in root.rglob("*")
                   if p.name == "__pycache__" or p.suffix in (".pyc", ".pyo"))
    return [c for c in found if not any(c.startswith(d + "/") for d in found)]


def reply_checks(root: Path) -> tuple:
    """([(message, fix)], the line to print) for the shared reply reader's checks (check_replies.py,
    recorded_answers.py). A package without task/replies.py (built before the shared reader) gets a note line,
    not a failure: whether to require the reader of older packages is the owner's decision."""
    from check_replies import uses_replies
    import recorded_answers

    if not uses_replies(root):
        from contract import current_contract
        if current_contract(root):  # built with the current skill (buildContract 2 or its records): the reader is required
            return [("task/replies.py is missing although the package is built under the current build contract",
                     "copy .opencode/skills/build/package_files/replies.py to task/replies.py unchanged and ask every "
                     "question through replies.ask")], ""
        return [], "note replies checks skipped: no task/replies.py (packages built before the shared reader)"
    answers = recorded_answers.judge(root)
    from check_replies import check as reply_check

    result = reply_check(root.parent.parent.resolve(), root)
    warn(result.get("warnings") or [])
    bad = result["problems"] + answers["problems"]
    return bad, ("ok   replies: shared reader " + ("unchanged" if not result.get("warnings") else "of an earlier release")
                 + ", answer-aware smoke test passes, " + (answers["note"] or "every answer recorded"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("package", type=Path, help="package/<paper-slug>")
    parser.add_argument("--program", type=Path, default=None, help="project program.json to compare with")
    parser.add_argument("--no-validity", action="store_true",
                        help="skip check_validity.py (check_readiness.py runs it itself, with every problem counted)")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):  # a console without UTF-8 (Windows cp1252) must not end the check
        sys.stdout.reconfigure(errors="replace")
    FAILED.clear()
    root: Path = args.package.resolve()
    if not root.is_dir():
        fail(f"{root} is not a folder")
    from contract import OLDER_THAN_3, current_contract, strict

    current = current_contract(root)  # built with the shared reply reader: the newer rules fail, not warn
    strict3 = strict(root)            # study.json buildContract >= 3: the rules added with contract 3 fail too

    missing = [name for name in REQUIRED if not (root / name).is_file()]
    if missing:
        fail("missing required files: " + ", ".join(missing))
    print("ok   required files present")

    # Compiled Python is a by-product of running the package, not part of it: it goes stale against the source
    # beside it, differs per interpreter and carries the builder's local paths.
    cache = compiled(root)
    if cache:
        msg = "compiled Python in the package: " + ", ".join(cache[:6]) + (
            f" and {len(cache) - 6} more" if len(cache) > 6 else "")
        hint = ("delete it (rm -r " + " ".join(cache[:3]) + "); run Python with -B or PYTHONDONTWRITEBYTECODE=1 "
                "while building")
        if strict3:
            fail(f"{msg}  [fix: {hint}]")
        warn([(msg + OLDER_THAN_3, hint)])
    else:
        print("ok   no compiled Python (__pycache__, .pyc) in the package")

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
    if slim:  # inside a project: the files the program was built from are recorded with hash and license
        from sources import findings as source_findings

        bad, older = source_findings(Path(source).resolve().parent)
        warn(older)   # rules of build contract 3 on an older build
        if bad:
            collect("sources/SOURCE.json:\n" + "\n".join(f"  {m}  [fix: {h}]" for m, h in bad))
        else:
            print("ok   sources/SOURCE.json records every source file (hash, license)")
        import fetch_source
        from check_source_use import findings as source_use_findings

        bad, older = source_use_findings(Path(source).resolve().parent)
        warn(older)   # rules of build contract 3 on an older build
        bad = fetch_source.problems(Path(source).resolve().parent) + bad
        if bad and not current:
            warn(bad)
        elif bad:
            collect("sources used:\n" + "\n".join(f"  {m}" + (f"  [fix: {h}]" if h else "") for m, h in bad))
        if not (bad and current):
            print("ok   downloaded sources licensed; analysis code, survey versions and questions checked against them"
                  + (" (older build: findings above are warnings)" if bad or older else ""))
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

    # The adapter is package code, possibly someone else's: run it confined (sandbox_run.py) on a copy laid out
    # like the project, so it cannot read keys or write outside the copy. A package may read what the format
    # puts beside it (../../program.json, the files next to program.json, sources/), as agent_package.py's
    # self-test allows; symlinks are not followed out of what is copied.
    with sandbox_run.work_dir(prefix="check-package-") as work:
        copy = work / "project" / "package" / root.name
        sandbox_run.copy_tree(root, copy, ignore=shutil.ignore_patterns("__pycache__", ".git"))
        project = root.parent.parent
        if root.parent.name == "package" and (project / "program.json").is_file():
            for f in project.iterdir():  # only what the format puts there; never .env or tool configuration
                if f.is_file() and not f.is_symlink() and (f.name in BESIDE_PROGRAM or f.suffix.lower() == ".pdf"):
                    shutil.copy2(f, work / "project" / f.name)
            if (project / "sources").is_dir() and not (project / "sources").is_symlink():
                sandbox_run.copy_tree(project / "sources", work / "project" / "sources")
        result = sandbox_run.run_python(copy / "task/adapter.py", ["--smoke-test"], cwd=copy, work=work, timeout=120)
    if result.timed_out:
        fail("adapter smoke test timed out after 120 s")
    if result.returncode != 0:
        fail("adapter smoke test failed:\n" + result.stdout + result.stderr)
    print("ok   task/adapter.py --smoke-test")
    bad, line = reply_checks(root)
    if bad:
        collect("reading replies (check_replies.py, recorded_answers.py):\n" + "\n".join(
            f"  {m}  [fix: {h}]" for m, h in bad))
    else:
        print(line)
    if slim and args.no_validity:
        print("note package validity skipped (--no-validity: check_readiness.py runs check_validity.py itself)")
    elif slim:  # inside a project: the package replays what participants experienced (check_validity.py)
        from check_validity import check as check_validity

        report = check_validity(Path(source).resolve().parent, root)
        if report["problems"]:
            collect("package validity (check_validity.py):\n" + "\n".join(
                f"  {m}" + (f"  [fix: {h}]" if h else "") for m, h in report["problems"]))
        warn([("validity: " + m, h) for m, h in report.get("warnings") or []])
        if not report["problems"]:
            print("ok   package validity: nothing participants were not told is in a prompt; memory design recorded")
        if report.get("analysis"):
            print("ok   analysis run: " + report["analysis"])
    if slim:
        from qsf_flow import findings as survey_findings

        bad, older = survey_findings(Path(source).resolve().parent, root)
        warn(older)   # rules of build contract 3 on an older build
        if bad and not current:
            warn(bad)
        elif bad:
            collect("survey files (qsf_flow.py):\n" + "\n".join(
                f"  {m}" + (f"  [fix: {h}]" if h else "") for m, h in bad))
        if not (bad and current):
            print("ok   survey files: no text participants never saw; items marked not shown are unused"
                  + (" (older build: findings above are warnings)" if bad or older else ""))
        from docx_text import problems as word_problems
        from design_checks import problems as design_problems

        bad = []
        for name, check in (("docx_text.py", word_problems), ("design_checks.py", design_problems)):
            try:
                bad += check(Path(source).resolve().parent, root)
            except Exception as exc:     # one finding line, never a traceback that hides every other check
                bad.append(("%s could not finish (%s: %s)" % (name, type(exc).__name__, str(exc)[:200]),
                            "fix the file it names, or report this to the HumanStudy Hub developers"))
        if bad and not current:
            warn(bad)
        elif bad:
            collect("Word sources and design disclosures (docx_text.py, design_checks.py):\n" + "\n".join(
                f"  {m}" + (f"  [fix: {h}]" if h else "") for m, h in bad))
        if not (bad and current):
            print("ok   Word sources: no export markup or run-together lines; no licence question; blocked conditions "
                  "and the layout recorded" + (" (older build: findings above are warnings)" if bad else ""))
    if FAILED:
        print("FAIL %d check(s) failed" % len(FAILED))
        sys.exit(1)
    print("PASS package checks")


if __name__ == "__main__":
    main()
