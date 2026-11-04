#!/usr/bin/env python3
"""Check how a package reads its participants' replies: the shared reader and the answer-aware smoke test.

    python .opencode/skills/build/check_replies.py .   [--package package/<slug>]

check_package.py runs it. It applies only to packages that use the shared reply reader
(`task/replies.py`, a byte copy of `.opencode/skills/build/package_files/replies.py`, the same file as
HumanStudy-Bench's agent_pipeline/package_files/replies.py). A package with neither the copy nor an
adapter that imports it is an older package: nothing is checked and nothing is printed.

  copy        task/replies.py equals the shipped copy byte for byte (never edit it: copy it again).
  import      task/adapter.py imports replies and its --smoke-test calls replies.smoke_main(Path(__file__)).
  smoke test  every runnable arm of task/task.json `conditions` runs through run_sessions twice with an
              offline stand-in that replies from the prompt text as a model would (the number printed
              before an option, or its position when none is printed): once blind to the keys, once
              answering every keyed question correctly. It fails when a reply typed from the screen is
              read as another option or not at all, when an arm has no `completed` session in the keyed
              pass, when a model call bypasses replies.ask, and when evaluate returns nothing (for all
              sessions or for one arm's alone).
  keyed       every question a recorded Qualtrics survey (a .qsf under sources/) accepts only with a
              correct answer (custom validation, forced or not) is asked with `key=`, and the key is an
              answer the survey accepts. Read with qsf_flow.py; skipped when that reader is absent.

The package's code runs only in a confined child (sandbox_run.py) on a copy laid out like the project:
no keys, no network, writes only in a scratch folder; pauses (time.sleep) are skipped. Never in this
process. The .qsf files are read here as data (JSON), never run.

Limits: the stand-in is not a participant; a pass says the wiring works (every arm reaches evaluate, the
numbers on screen are read back), not that the prompts are faithful. A survey check is matched to an asked
question by identical options plus the survey's question id, export tag or wording; a package that
rewords the question and changes its options is not matched.
Standard library only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sandbox_run  # noqa: E402

SHIPPED = HERE / "package_files" / "replies.py"
IMPORTS = re.compile(r"(?m)^\s*(from\s+replies\s+import\b|import\s+replies\b)")
SMOKE_MAIN = re.compile(r"\bsmoke_main\s*\(")
SMOKE_TIMEOUT = 300
MARK = "@@SMOKE@@"
# Files the project format puts beside program.json that a package may read (as check_package.py).
BESIDE_PROGRAM = {"program.json", "effects.json", "capabilities.json", "README.md"}
READING_REPLIES = "build SKILL.md section 3, 'Reading replies'"


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def uses_replies(pkg: Path) -> bool:
    """The package carries task/replies.py or its adapter imports it."""
    pkg = Path(pkg)
    return (pkg / "task/replies.py").is_file() or bool(IMPORTS.search(_read(pkg / "task/adapter.py")))


def copy_problems(pkg: Path) -> list:
    """The copy is the shipped file, byte for byte; the adapter imports it and its smoke test calls it."""
    pkg = Path(pkg)
    out = []
    copy = pkg / "task/replies.py"
    adapter = _read(pkg / "task/adapter.py")
    if not copy.is_file():
        out.append(("task/adapter.py imports replies, but task/replies.py is missing",
                    "copy .opencode/skills/build/package_files/replies.py to task/replies.py, unchanged"))
    elif hashlib.sha256(copy.read_bytes()).digest() != hashlib.sha256(SHIPPED.read_bytes()).digest():
        out.append(("task/replies.py differs from the shipped .opencode/skills/build/package_files/replies.py "
                    "(it is shared with HumanStudy-Bench, so every package reads replies the same way)",
                    "copy .opencode/skills/build/package_files/replies.py to task/replies.py again, unchanged; "
                    "work around a reader limit in the adapter (codes=, kind=, required=), never in the copy"))
    if not IMPORTS.search(adapter):
        out.append(("task/replies.py is there but task/adapter.py does not import it",
                    "ask every question with replies.ask() (%s); never call llm directly or write "
                    "an own reply parser" % READING_REPLIES))
    elif not SMOKE_MAIN.search(adapter):
        out.append(("task/adapter.py --smoke-test does not run the answer-aware smoke test",
                    "end the adapter with: if __name__ == '__main__' and '--smoke-test' in sys.argv: "
                    "sys.exit(replies.smoke_main(Path(__file__)))"))
    return out


def copy_like_project(pkg: Path, work: Path) -> Path:
    """A copy of the package at work/project/package/<slug>, with what the format puts beside program.json
    (program.json, effects.json, capabilities.json, README.md, the PDFs, sources/). Symlinks are not followed."""
    pkg = Path(pkg).resolve()
    copy = work / "project" / "package" / pkg.name
    sandbox_run.copy_tree(pkg, copy, ignore=shutil.ignore_patterns("__pycache__", ".git"))
    project = pkg.parent.parent
    if pkg.parent.name == "package" and (project / "program.json").is_file():
        for f in project.iterdir():
            if f.is_file() and not f.is_symlink() and (f.name in BESIDE_PROGRAM or f.suffix.lower() == ".pdf"):
                shutil.copy2(f, work / "project" / f.name)
        if (project / "sources").is_dir() and not (project / "sources").is_symlink():
            sandbox_run.copy_tree(project / "sources", work / "project" / "sources")
    return copy


def smoke(pkg: Path, timeout: int = SMOKE_TIMEOUT) -> dict:
    """replies.smoke_package on the package, in a confined child. The report as replies.py writes it."""
    with sandbox_run.work_dir(prefix="check-replies-") as work:
        copy = copy_like_project(pkg, work)
        run = sandbox_run.run_python(Path(__file__).resolve(), ["--smoke-child", str(copy)], cwd=copy, work=work,
                                     timeout=timeout)
    if run.timed_out:
        return {"ok": False, "arms": {}, "problems": ["the smoke test did not finish within %d s" % timeout]}
    line = next((l for l in run.stdout.splitlines()[::-1] if l.startswith(MARK)), None)
    try:
        report = json.loads(line[len(MARK):]) if line else None
    except ValueError:
        report = None
    if not isinstance(report, dict):
        tail = (run.stderr or run.stdout).strip()[-400:]
        return {"ok": False, "arms": {}, "problems": ["the smoke test could not be run: " + (tail or "no output")]}
    return report


def _smoke_child(pkg: Path) -> None:
    """In the confined child: run the shipped replies.smoke_package on the package copy; print one line."""
    import contextlib
    import importlib.util
    import io
    import time
    time.sleep = lambda *a, **k: None   # pacing between calls is not waited out
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("humanstudy_replies_shipped", SHIPPED)
    replies = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = replies
    spec.loader.exec_module(replies)
    while str(HERE) in sys.path:  # the package imports its own siblings, never a checker module
        sys.path.remove(str(HERE))
    os.chdir(pkg)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            report = replies.smoke_package(pkg)
    except BaseException as exc:  # noqa: BLE001  an import error in the package is a finding, not a crash
        report = {"ok": False, "arms": {}, "problems": ["the package could not be loaded: %s: %s"
                                                         % (type(exc).__name__, str(exc)[:300])]}
    print(MARK + json.dumps(report, default=str, ensure_ascii=False), flush=True)


# --------------------------------------------------------------------------- survey checks with a correct answer

def _plain(text: object) -> str:
    text = re.sub(r"<[^>]+>|[*_]", " ", str(text or "")).replace("’", "'").replace("‘", "'")
    return re.sub(r"\s+", " ", text).strip().strip(" .,;:!?").casefold()


def _qsf_reader():
    """(read_qsf, correct_answer_checks) from qsf_flow.py beside this file, or None when it is absent."""
    try:
        import qsf_flow
    except ImportError:
        return None
    read, checks = getattr(qsf_flow, "read_qsf", None), getattr(qsf_flow, "correct_answer_checks", None)
    return (read, checks) if callable(read) and callable(checks) else None


def survey_checks(project: Path) -> list:
    """Correct-answer checks of every .qsf under sources/, each with its `source` path."""
    reader = _qsf_reader()
    sources = Path(project) / "sources"
    if reader is None or not sources.is_dir():
        return []
    read_qsf, correct_answer_checks = reader
    out = []
    for path in sorted(sources.rglob("*")):
        if not path.is_file() or path.is_symlink() or path.suffix.lower() != ".qsf":
            continue
        try:
            report = read_qsf(path)
            found = correct_answer_checks(report)
        except Exception:  # noqa: BLE001  an export the reader cannot follow is not a smoke-test failure
            continue
        rel = path.relative_to(Path(project)).as_posix()
        out += [dict(check, source=rel) for check in found if isinstance(check, dict)]
    return out


def unkeyed_checks(checks: list, asked: list) -> list:
    """Asked questions that are a survey's correct-answer check but carry no key (or a key it refuses)."""
    out = []
    for question in asked or []:
        if not isinstance(question, dict) or question.get("kind") != "choice":
            continue
        qid = str(question.get("id", ""))
        options = {_plain(o) for o in question.get("options") or []}
        text = _plain(question.get("text"))
        matched = []
        for check in checks:
            # Always the same options; then the survey's id (or export tag), or the same wording.
            if len(options) < 2 or options != {_plain(o) for o in check.get("options") or []}:
                continue
            by_id = qid in (check.get("qid"), check.get("tag")) or bool(
                check.get("qid") and re.search(r"(?<![A-Za-z0-9])%s(?![0-9])" % re.escape(str(check["qid"])), qid))
            wording = _plain(check.get("text"))
            same_text = bool(text and wording) and (wording in text or text in wording)
            if by_id or same_text:
                matched.append((by_id, check))
        if not matched:
            continue
        # The survey question with this id, when the package kept the id; else every question it reproduces.
        matched = [c for strong, c in matched if strong] or [c for _, c in matched]
        names = ", ".join(dict.fromkeys("%s" % c.get("qid") + (" (%s)" % c["tag"] if c.get("tag") else "")
                                        for c in matched))
        correct = list(dict.fromkeys(a for c in matched for a in c.get("correct") or []))
        accepted = " or ".join(repr(a) for a in correct[:4])
        key = question.get("key")
        if key in (None, [], ""):
            out.append(("question %s is the survey's comprehension or attention check %s: the survey (%s) accepts "
                        "only %s, even though its response is %s, and the package asks it without a key"
                        % (qid, names, matched[0].get("source"), accepted,
                           matched[0].get("response") or "not forced"),
                        "ask it with key= set to the correct option (the survey's own rule, not a choice) and "
                        "apply the same rule as the package's other checks"))
            continue
        keys = key if isinstance(key, list) else [key]
        if correct and not {_plain(k) for k in keys} <= {_plain(a) for a in correct}:
            out.append(("question %s: its key %r is not an answer the survey accepts for %s (%s)"
                        % (qid, keys, names, accepted),
                        "set key= to the option the survey's validation accepts"))
    return out


# --------------------------------------------------------------------------- the check

def check(project: Path, pkg: Path) -> dict:
    """{"applies", "problems": [(message, fix)], "report": smoke report or None}."""
    pkg = Path(pkg).resolve()
    if not uses_replies(pkg):
        return {"applies": False, "problems": [], "report": None}
    problems = copy_problems(pkg)
    if not IMPORTS.search(_read(pkg / "task/adapter.py")) or not (pkg / "task/replies.py").is_file():
        return {"applies": True, "problems": problems, "report": None}
    report = smoke(pkg)
    fix = ("fix the adapter (not the copy of replies.py) until `python task/adapter.py --smoke-test` passes "
           "(%s)" % READING_REPLIES)
    problems += [("smoke test: %s" % p, fix) for p in report.get("problems") or []]
    try:
        problems += unkeyed_checks(survey_checks(project), report.get("asked") or [])
    except Exception as exc:  # noqa: BLE001  reading the project's survey files must not crash the check
        problems.append(("the survey's correct-answer checks could not be compared (%s: %s)"
                         % (type(exc).__name__, exc), "report this; the .qsf may be one the reader cannot follow"))
    return {"applies": True, "problems": problems, "report": report}


def problems(project_root, package_root) -> list:
    """[(message, fix)] for check_package.py; [] for a package that does not use replies.py."""
    return check(Path(project_root).resolve(), Path(package_root))["problems"]


def summary(report: dict) -> list:
    """Plain lines: sessions per arm by status, exactly as the adapter labelled them."""
    lines = []
    for arm, counts in (report or {}).get("arms", {}).items():
        statuses = ", ".join("%d %s" % (n, s) for s, n in sorted(counts.get("statuses", {}).items())) or "none"
        lines.append("%s: %d sessions (%s)" % (arm, counts.get("sessions", 0), statuses))
    return lines


def _package_of(root: Path, given) -> Path:
    if given:
        path = Path(given)
        return path if path.is_absolute() else (root / path)
    found = [p for p in sorted((root / "package").glob("*")) if (p / "task/adapter.py").is_file()]
    if len(found) != 1:
        raise SystemExit("name the package with --package package/<slug> (found %d)" % len(found))
    return found[0]


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["--smoke-child"]:
        _smoke_child(Path(argv[1]).resolve())
        return 0
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--package", help="package/<slug> (default: the only package of the project)")
    a = ap.parse_args(argv)
    root = Path(a.root).resolve()
    result = check(root, _package_of(root, a.package))
    if not result["applies"]:
        return 0  # an older package without the shared reader: nothing to say
    for line in summary(result["report"]):
        print("note    " + line)
    for msg, fix in result["problems"]:
        print("PROBLEM %s" % msg + ("\n        fix: %s" % fix if fix else ""))
    if result["problems"]:
        print("FAIL %d reply-reading problem(s)" % len(result["problems"]))
        return 1
    print("PASS replies: shared reader unchanged, smoke test passes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
