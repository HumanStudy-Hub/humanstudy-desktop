#!/usr/bin/env python3
"""The app's readiness gate: every build check the build skill requires, on one package of a project.

Usage: python check_readiness.py <project> <package-slug>

Prints one JSON document, {"problems": [{"check", "reason"}], "checks": {name: "pass" | "fail"}}, and exits 0
(1 only on a usage error). A package is ready only when "problems" is empty. Checks, each the same rule as
the script the build skill (SKILL.md) tells the agent to run until it prints PASS:

  program    check_program.py program.json --complete (schema read from this copy, not the project's)
  sources    sources.py . --check (sources/SOURCE.json: every source file with its hash and license)
  package    check_package.py package/<slug> (files, bindings, the adapter smoke test, check_validity.py)
  validity   check_validity.py . --package package/<slug> (prompts captured from a stand-in model run)
  verbatim   check_verbatim.py program.json
  results    check_results.py program.json (a printed table left untranscribed needs its reason)
  effects    effects.py . (reported.n, signs against cells and contrast, fields the sessions carry)

The desktop app runs its own bundled copy of this folder, never the project's editable .opencode copy, so
editing a checker inside a project does not change what the app accepts. This script never imports or runs
package code itself: the adapter smoke test, the prompt capture and the effects field check run it through
sandbox_run.py (no keys, no network, writes only in a scratch folder; see that file for what each platform
confines). Instructions between blocks are covered by check_validity.py's missing-instruction rule and by
review, not by a separate check (see SKILL.md "Instructions between blocks").
"""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "export" / "agent"))

REASON_MAX = 300
PACKAGE_TIMEOUT = 900  # the smoke test (120 s) plus check_validity's capture (300 s) with margin


def one_line(text):
    return " ".join(str(text).split())[:REASON_MAX]


def summary(messages):
    """One line: the first problem, and how many more there are."""
    messages = [one_line(m[0] if isinstance(m, (list, tuple)) else m) for m in messages]
    if not messages:
        return None
    more = len(messages) - 1
    return messages[0] + (" (+%d more)" % more if more else "")


def program_problems(root):
    import check_program
    path = root / "program.json"
    try:
        program = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return ["program.json cannot be read as JSON (%s)" % type(exc).__name__]
    if not isinstance(program, dict) or program.get("schemaVersion") != 2:
        return [m for m, _ in check_program.check(program)]
    found = []
    try:  # the schema shipped with this checker, never the project's schema/ copy
        import jsonschema
        schema = json.loads((HERE.parents[1] / "schema/human-program.schema.json").read_text(encoding="utf-8"))
        validator = jsonschema.validators.validator_for(schema)(schema)
        found += ["schema: %s: %s" % ("/".join(map(str, e.absolute_path)), e.message[:200])
                  for e in sorted(validator.iter_errors(program), key=lambda e: list(map(str, e.absolute_path)))[:50]]
    except ImportError:
        found.append("the jsonschema package is unavailable in the research runtime")
    found += [m for m, _ in check_program.check(program)]
    if not found:
        found += [m for m, _ in check_program.coverage_problems(program)]
    return found


def sources_problems(root):
    import sources
    return [m for m, _ in sources.problems(root)]


def package_problems(root, slug):
    """check_package.py in a child process: it reports the first failure and exits 1."""
    pkg = root / "package" / slug
    with tempfile.TemporaryDirectory(prefix="readiness-package-") as work:
        try:
            run = subprocess.run([sys.executable, "-I", "-B", str(HERE / "check_package.py"), str(pkg)],
                                 cwd=work, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                 encoding="utf-8", errors="replace", timeout=PACKAGE_TIMEOUT)
        except subprocess.TimeoutExpired:
            return ["check_package.py did not finish within %d s" % PACKAGE_TIMEOUT]
    if run.returncode == 0:
        return []
    lines = [l.strip() for l in run.stdout.splitlines() if l.strip()]
    at = next((i for i, l in enumerate(lines) if l.startswith("FAIL")), None)
    if at is None:
        return ["check_package.py stopped (exit %s): %s" % (run.returncode, (run.stderr or run.stdout).strip()[-200:])]
    head = lines[at][4:].strip()
    # The program, sources and validity checks report these rules themselves, with every problem counted.
    if head.startswith(("package validity (check_validity.py)", "sources/SOURCE.json:", "program has problems:")):
        return []
    if head.endswith(":"):
        head = head[:-1] + (": " + lines[at + 1].split("  [fix:", 1)[0] if at + 1 < len(lines) else "")
    return [head]


def validity_problems(root, slug):
    import check_validity
    return check_validity.check(root, root / "package" / slug)["problems"]


def verbatim_problems(root):
    import check_verbatim
    report = check_verbatim.check(root / "program.json")
    return ["%s: %s: %s" % (r["field"], r["status"].replace("_", " "), r["info"]) for r in report["results"]
            if r["status"] not in ("found", "unchecked", "table_text_layer", "close_unverified")]


def results_problems(root):
    import check_results
    return check_results.check(root / "program.json")["problems"]


def effects_problems(root):
    import effects
    doc = effects.effects_core.load(root)
    if doc is None:
        return ["effects.json is missing"]
    program = json.loads((root / "program.json").read_text(encoding="utf-8"))
    found, _ = effects.effects_core.check(root, doc, program)
    found += effects.build_rules(doc, program)
    if not found:  # as effects.py: the field check runs the adapter (confined) only on an otherwise clean file
        found += effects.field_gaps(root, doc)[0]
    return found


def run_checks(root, slug):
    root = Path(root).resolve()
    checks = [
        ("program", lambda: program_problems(root)),
        ("sources", lambda: sources_problems(root)),
        ("package", lambda: package_problems(root, slug)),
        ("validity", lambda: validity_problems(root, slug)),
        ("verbatim", lambda: verbatim_problems(root)),
        ("results", lambda: results_problems(root)),
        ("effects", lambda: effects_problems(root)),
    ]
    problems, status = [], {}
    for name, fn in checks:
        try:
            # Helpers may print diagnostics; this script's stdout stays one JSON document.
            with contextlib.redirect_stdout(io.StringIO()):
                found = fn()
        except Exception as exc:  # a check that cannot run never counts as passed
            found = ["the check could not complete (%s: %s)" % (type(exc).__name__, one_line(exc)[:120])]
        line = summary(found)
        status[name] = "fail" if line else "pass"
        if line:
            problems.append({"check": name, "reason": line})
    return {"problems": problems, "checks": status}


def main(argv):
    if len(argv) != 2 or not argv[1] or Path(argv[1]).name != argv[1] or argv[1] in (".", ".."):
        print("usage: check_readiness.py PROJECT PACKAGE_SLUG", file=sys.stderr)
        return 1
    root = Path(argv[0]).resolve()
    if not (root / "package" / argv[1]).is_dir():
        report = {"problems": [{"check": "package", "reason": "package/%s is not a folder" % argv[1]}], "checks": {}}
    else:
        report = run_checks(root, argv[1])
    sys.stdout.write(json.dumps(report) + "\n")  # ASCII: safe on any console encoding
    return 0


if __name__ == "__main__":
    os.environ.pop("HUMANSTUDY_HUMAN_DATA", None)  # the app checks the study's own human-data/ folder only
    sys.exit(main(sys.argv[1:]))
