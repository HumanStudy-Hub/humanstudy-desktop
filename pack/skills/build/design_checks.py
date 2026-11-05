#!/usr/bin/env python3
"""Check what the researcher is asked about licences and what the package discloses about its design.

    python .opencode/skills/build/design_checks.py .        (the project folder; check_package.py runs it)

Prints every problem with a fix, then PASS or FAIL (exit 1). Adapted from HumanStudy-Bench's
agent_pipeline/design_checks.py (desktop terms: program.json issues instead of a reply file and
audit/missing_information.json, sources/SOURCE.json instead of source/paper_metadata.json).

  licence        no question to the researcher (a program issue of severity decision or blocking whose title ends
                 in "?") is about the rights to a third-party file ("May the item lists from the supplement be
                 published?"): the researcher does not hold them. Such a doubt is a Hub policy item in
                 sources/SOURCE.json `licencePolicy`: [{"path": "sources/private/<file>", "licence": "<as stated, or
                 none stated>", "evidence": "<where the licence is or is not stated>", "use":
                 "researcher-own-use-only"}], and goes on the report's Licence line. Each entry names a file under
                 sources/ and says licence, evidence and use.
  blocked        a condition in task/task.json with "status": "blocked" (or listed in `blocked_arms`) carries
                 `blocked_reason` (one sentence), `blocked_missing` (each missing item by its `what`) and
                 `blocked_results` (the result fields or headline findings it blocks).
  presentation   task/task.json `presentation`: {"layout": "one statement per screen", "origin": "verbatim" |
                 "reported" | "derived", "evidence": "<the passage or survey page>"}. Required in a package that uses
                 the shared reply reader (task/replies.py, the current build contract); checked in any package that
                 has it. A `derived` layout (no source says how items were paged) is a departure: a program.json
                 issue of severity decision whose id, title or fieldId names the presentation or layout, saying the
                 choice, why, and its likely effect.

A project whose packages have no blocked condition, no presentation record and no task/replies.py, and whose
program asks nothing about licences, passes unchanged. Standard library only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# A licence question asks about rights to a file: "licence", "copyright", "permission to publish", "rights holder",
# "may we publish/share/redistribute ...", and names a file or material. "Should participants be licensed drivers?"
# or "Should the scale run left to right?" are study questions. (The same patterns as HumanStudy-Bench.)
LICENCE_RE = re.compile(
    r"(?i)\b(licen[cs]e[sd]?\b|licen[cs]ing|copyright\w*|permission to (use|publish|share|redistribute|reproduce)|"
    r"rights?[- ]holders?|rights? to (use|publish|share|redistribute|reproduce)|"
    r"(may|can|could) (we|i|you|the (package|hub|study))( also)? (publish|share|redistribute|reproduce)|"
    r"\bbe (published|redistributed|reproduced|shared publicly)\b)")
LICENCE_OBJECT_RE = re.compile(r"(?i)\b(supplement\w*|files?|materials?|item lists?|items|package|survey|"
                               r"questionnaires?|stimul\w*|instruments?|wording|texts?|scales?|cop(y|ies)|appendix|"
                               r"figures?|images?|data ?sets?|exports?|documents?|pdf)\b")
ORIGINS = ("verbatim", "reported", "derived")
LAYOUT_ISSUE = re.compile(r"(?i)presentation|layout|paging|paged|per screen|one page|same page|list page")


def _load(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _list(value):
    return [x for x in value if isinstance(x, dict)] if isinstance(value, list) else []


def _words(text):
    return len(re.findall(r"\w+", str(text or "")))


def is_licence_question(text):
    return bool(LICENCE_RE.search(text or "") and LICENCE_OBJECT_RE.search(text or ""))


def check_licence(root, program, record):
    from check_source_use import question_issues

    out = []
    asked = [i for i in question_issues(program) if is_licence_question(str(i.get("title", "")))]
    if asked:
        out.append(("issue '%s' asks the researcher about a licence (\"%s\"); the researcher does not hold the rights "
                    "to the authors' or publisher's files" % (asked[0].get("id"), str(asked[0].get("title"))[:120]),
                    "drop the question: record the doubt in sources/SOURCE.json licencePolicy [{\"path\": "
                    "\"sources/private/<file>\", \"licence\": \"<as stated>\", \"evidence\": \"<where it is or is not "
                    "stated>\", \"use\": \"researcher-own-use-only\"}], keep the file under sources/private/, and "
                    "state the doubt on the report's Licence line"))
    policy = record.get("licencePolicy")
    if policy is None:
        return out
    if not isinstance(policy, list):
        return out + [("sources/SOURCE.json licencePolicy must be a list of {path, licence, evidence, use}", "")]
    for index, entry in enumerate(policy):
        label = "licencePolicy[%d]" % index
        if not isinstance(entry, dict):
            out.append(("%s must be {path, licence, evidence, use}" % label, ""))
            continue
        rel = str(entry.get("path") or "").replace("\\", "/").lstrip("./")
        if not rel.startswith("sources/") or not (root / rel).is_file():
            out.append(("%s: path must name a file under sources/ (%r)" % (label, entry.get("path")), ""))
        if not str(entry.get("licence") or "").strip():
            out.append(("%s: say the licence as stated, or 'none stated'" % label, ""))
        if _words(entry.get("evidence")) < 3:
            out.append(("%s: say in 'evidence' where the licence is or is not stated" % label, ""))
        if not str(entry.get("use") or "").strip():
            out.append(("%s: say the use ('researcher-own-use-only' until the Hub settles it)" % label, ""))
    return out


def _conditions(task):
    conditions = task.get("conditions") if isinstance(task, dict) else None
    if isinstance(conditions, dict):
        conditions = [dict(v, id=k) if isinstance(v, dict) else {"id": k} for k, v in conditions.items()]
    return [c for c in conditions or [] if isinstance(c, dict)]


def check_blocked(task, where):
    arms = {}
    for item in (task.get("blocked_arms") or [] if isinstance(task, dict) else []):
        arms[item.get("id") if isinstance(item, dict) else item] = item if isinstance(item, dict) else {}
    vague = []
    for condition in _conditions(task):
        if condition.get("status") != "blocked" and condition.get("id") not in arms:
            continue
        condition = {**arms.get(condition.get("id"), {}), **{k: v for k, v in condition.items() if v}}
        missing = condition.get("blocked_missing")
        results = condition.get("blocked_results")
        if not (isinstance(missing, list) and missing and all(isinstance(m, str) and m.strip() for m in missing)) \
                or not (isinstance(results, list) and results) or not str(condition.get("blocked_reason") or "").strip():
            vague.append(str(condition.get("id")))
    if not vague:
        return []
    return [("%s: blocked condition(s) %s must say exactly what is missing and what it blocks" % (where, ", ".join(vague[:6])),
             "add 'blocked_reason' (one sentence), 'blocked_missing' (each missing item by its `what`; only what no "
             "source prints: when the paper prints the scale anchors, the scale is not missing) and "
             "'blocked_results' (the result fields or headline findings that cannot be computed without it)")]


def check_presentation(task, where, program, required, audit=None):
    if not isinstance(task, dict):
        return []
    presentation = task.get("presentation")
    if presentation is None and not required:
        return []
    if not isinstance(presentation, dict) or not str(presentation.get("layout") or "").strip() \
            or presentation.get("origin") not in ORIGINS:
        return [("%s needs 'presentation': how items were paged and whether a source says so" % where,
                 "add {\"layout\": \"<one statement per screen, or all items on one page>\", \"origin\": \"reported\" "
                 "| \"verbatim\" | \"derived\", \"evidence\": \"<the passage or survey page, when reported>\"}; when no "
                 "source states the layout, origin is 'derived' and the choice is a decision issue (a departure)")]
    if presentation["origin"] != "derived":
        if not str(presentation.get("evidence") or "").strip():
            return [("%s presentation.origin is %r but gives no evidence" % (where, presentation["origin"]),
                     "quote or locate the passage or survey page that states the layout")]
        return []
    issues = [i for i in _list(program.get("issues")) if i.get("severity") in ("decision", "blocking")]
    if any(LAYOUT_ISSUE.search(" ".join(str(i.get(k) or "") for k in ("id", "title", "fieldId"))) for i in issues):
        return []
    entries = audit.get("entries") if isinstance(audit, dict) else audit
    if any(re.match(r"(?i)\s*presentation\b", str(e.get("field") or "")) for e in _list(entries)):
        return []   # a standalone package's audit/missing_information.json departure
    return [("%s presentation.origin is 'derived' (no source says how items were paged), but no program.json "
             "issue records the departure" % where,
             "add a decision issue (e.g. id 'presentation-layout', title 'Layout not stated: one statement per screen "
             "chosen') giving the choice, why, and its likely effect on the findings in reason and impact")]


def _packages(root, package):
    if package:
        return [Path(package).resolve()]
    base = root / "package"
    return sorted(p for p in base.iterdir() if (p / "task/task.json").is_file()) if base.is_dir() else []


def problems(root, package=None):
    """[(message, fix)] for licence questions, licencePolicy, blocked conditions and the recorded layout."""
    from check_replies import uses_replies
    import check_materials as cm

    root = Path(root).resolve()
    program = _load(root / "program.json")
    program = program if isinstance(program, dict) else {}
    record = cm.source_record(root)
    record = record if isinstance(record, dict) else {}
    out = []
    checks = [lambda: check_licence(root, program, record)]
    for pkg in _packages(root, package):
        task = _load(pkg / "task/task.json")
        where = "package/%s/task/task.json" % pkg.name
        checks.append(lambda task=task, where=where: check_blocked(task, where))
        checks.append(lambda task=task, where=where, pkg=pkg: check_presentation(
            task, where, program, uses_replies(pkg), _load(pkg / "audit/missing_information.json")))
    for check in checks:
        try:
            out += check()
        except Exception as exc:  # noqa: BLE001 - a malformed record is reported, not a crash
            out.append(("design check could not run (%s: %s)" % (type(exc).__name__, exc),
                        "fix the malformed record in task/task.json or sources/SOURCE.json"))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", nargs="?", default=".")
    ap.add_argument("--package", help="package/<slug> (default: every package of the project)")
    a = ap.parse_args(argv)
    found = problems(a.project, a.package)
    for msg, fix in found:
        print("PROBLEM %s" % msg + ("\n        fix: %s" % fix if fix else ""))
    if found:
        print("FAIL %d design disclosure problem(s)" % len(found))
        return 1
    print("PASS design: no licence question, blocked conditions say what is missing, layout recorded")
    return 0


if __name__ == "__main__":
    sys.exit(main())
