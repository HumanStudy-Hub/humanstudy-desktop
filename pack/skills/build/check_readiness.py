#!/usr/bin/env python3
"""The app's readiness gate: every build check the build skill requires, on one package of a project.

Usage: python check_readiness.py <project> <package-slug>

Prints one JSON document, {"problems": [{"check", "reason"}], "checks": {name: "pass" | "fail"},
"warnings": [{"check", "reason"}]}, and exits 0 (1 only on a usage error). A package is ready only when
"problems" is empty. "warnings" holds the newer rules' findings on a package built before the current contract
(no task/replies.py, see contract.py): check_package.py `warn` lines and the warnings of check_validity.py,
check_results.py, effects.py (the effect-link rules) and check_materials.py (the minimum search list), at most
WARNINGS_MAX per check and then "and N more". Such a package also always carries one "contract" warning,
OLDER_BUILD. They never make a package not ready; a rebuild under the current contract turns them into problems.
The rules added with build contract 3 (see contract.py and SKILL.md "Build contract") are problems only for a package
whose study.json says buildContract >= 3; below that their findings are warnings too, and the report carries one
"contract" warning, OLDER_THAN_3_BUILD.
Checks, each the same rule as
the script the build skill (SKILL.md) tells the agent to run until it prints PASS:

  program    check_program.py program.json --complete (schema read from this copy, not the project's)
  sources    sources.py . --check (sources/SOURCE.json: every source file with its hash and license)
  package    check_package.py package/<slug> --no-validity (files, bindings, the adapter smoke test, the replies
             checks, sources used, survey, Word and design checks; every failure, not only the first)
  validity   check_validity.py . --package package/<slug> (prompts captured from a stand-in model run)
  verbatim   check_verbatim.py program.json
  results    check_results.py program.json (a printed table left untranscribed needs its reason)
  effects    effects.py . (reported.n, signs against cells and contrast, fields the sessions carry)
  materials  check_materials.py . (materials the paper does not print: schema-enough or needs-original, never
             invented; researcher-supplied text stays in sources/researcher/)

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
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "export" / "agent"))

REASON_MAX = 300
# check_package.py --no-validity runs, one after another: the adapter smoke test (120 s), the answer-aware replies
# smoke test (check_replies.py, 300 s) and the every-answer-recorded check (recorded_answers.py, 150 s), plus a
# margin for copying and the offline checks. check_validity.py (its prompt capture, 300 s, and analysis run, 360 s)
# runs once, as the validity check below, not again inside check_package.py.
PACKAGE_TIMEOUT = 700


WARNINGS_MAX = 20   # warnings listed per check; the rest are counted
OLDER_BUILD = ("older build: newer build rules are warnings; rebuild with the current build skill to make them "
               "blocking")
OLDER_THAN_3_BUILD = ("build contract below 3: the rules added with contract 3 are warnings; rebuild with the current "
                      "build skill (it writes buildContract 3) to make them blocking")


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
    found, older = sources.findings(root)
    return [m for m, _ in found], [m for m, _ in older]


def package_warnings(stdout):
    """check_package.py `warn` lines (an older build's findings of the newer rules). Its validity warnings are
    left out: the validity check reports them itself."""
    found = []
    for line in stdout.splitlines():
        if line.startswith("warn  ") and not line[6:].lstrip().startswith("validity: "):
            found.append(line[6:].strip().split("  [fix:", 1)[0])
    return found


def package_problems(root, slug):
    """check_package.py in a child process: it reports the first failure and exits 1. Returns (problems,
    warnings)."""
    pkg = root / "package" / slug
    with tempfile.TemporaryDirectory(prefix="readiness-package-") as work:
        try:
            run = subprocess.run([sys.executable, "-I", "-B", "-X", "utf8", str(HERE / "check_package.py"), str(pkg),
                                  "--no-validity"],
                                 cwd=work, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                 encoding="utf-8", errors="replace", timeout=PACKAGE_TIMEOUT)
        except subprocess.TimeoutExpired:
            return ["check_package.py did not finish within %d s" % PACKAGE_TIMEOUT]
    return package_failure(run), package_warnings(run.stdout)


FAIL_COUNT = re.compile(r"^FAIL \d+ check\(s\) failed$")


def package_failure(run):
    """Every FAIL line of check_package.py (it goes on after a failure the later checks do not depend on), except
    those the program, sources and validity checks report themselves."""
    if run.returncode == 0:
        return []
    lines = [l.strip() for l in run.stdout.splitlines() if l.strip()]
    found = []
    for at, line in enumerate(lines):
        if not line.startswith("FAIL") or FAIL_COUNT.match(line):
            continue
        head = line[4:].strip()
        # The program, sources and validity checks report these rules themselves, with every problem counted.
        if head.startswith(("package validity (check_validity.py)", "sources/SOURCE.json:", "program has problems:")):
            continue
        if head.endswith(":"):
            head = head[:-1] + (": " + lines[at + 1].split("  [fix:", 1)[0] if at + 1 < len(lines) else "")
        found.append(head)
    if not found and not any(l.startswith("FAIL") for l in lines):
        return ["check_package.py stopped (exit %s): %s" % (run.returncode, (run.stderr or run.stdout).strip()[-200:])]
    return found


def validity_problems(root, slug):
    import check_validity
    report = check_validity.check(root, root / "package" / slug)
    return report["problems"], report.get("warnings") or []


def verbatim_problems(root):
    import check_verbatim
    report = check_verbatim.check(root / "program.json")
    bad, older = check_verbatim.split_findings(report)   # passing statuses include `reference`
    line = lambda r: "%s: %s: %s" % (r["field"], r["status"].replace("_", " "), r["info"])  # noqa: E731
    return [line(r) for r in bad], [line(r) + check_verbatim.contract_note() for r in older]


def results_problems(root, slug):
    import check_results
    report = check_results.check(root / "program.json", package=root / "package" / slug)
    return report["problems"], report.get("warnings") or []


def materials_problems(root, slug):
    import check_materials
    report = check_materials.check(root, package=root / "package" / slug)
    return report["problems"], report.get("warnings") or []


def effects_problems(root, slug, static_only=False):
    import effects
    doc = effects.effects_core.load(root)
    if doc is None:
        return ["effects.json is missing"]
    program = json.loads((root / "program.json").read_text(encoding="utf-8"))
    found, _ = effects.effects_core.check(root, doc, program)
    found += effects.build_rules(doc, program)
    warned = []
    # rules added with buildContract 3 (scale, signed metrics, pooled values, hypothesis status, arms): blocking
    # for contract 3 packages, warnings for older ones, as effects.py prints them
    rules, hints = effects.contract_rules(root, doc, program)
    (found if effects.strict_contract(root) else warned).extend(rules)
    warned += hints
    if not found and not static_only:  # as effects.py: the field check runs the adapter (confined) only on an otherwise clean file
        gaps, _, field_warnings = effects.field_report(root, doc, package=root / "package" / slug)
        found += gaps
        warned += field_warnings
    return found, warned


CHECK_MODULES = ("check_program", "check_package", "sources", "check_validity", "check_verbatim", "check_results",
                 "effects", "effects_core", "check_quotes", "sandbox_run", "check_materials", "contract",
                 "check_replies", "prompt_context")
OPTIONAL_MODULES = ("jsonschema", "pdfplumber", "pypdf")  # lazily imported by the checks when present


def load_checkers():
    """Import every checker before any package code runs, then take the checker folders off sys.path: on
    platforms where sandbox_run does not confine files, package code could otherwise rewrite a checker file
    before it is first imported. An import missed here then fails (a failed check), never loads a new file."""
    import importlib
    for name in CHECK_MODULES:
        importlib.import_module(name)
    for name in OPTIONAL_MODULES:
        try:
            importlib.import_module(name)
        except ImportError:
            pass
    drop_checker_paths()


def listed_warnings(name, warned):
    """Each warning on its own line (the agent reports every one), at most WARNINGS_MAX, then "and N more"."""
    warned = list(warned or [])
    out = [{"check": name, "reason": one_line(w[0] if isinstance(w, (list, tuple)) else w)}
           for w in warned[:WARNINGS_MAX]]
    if len(warned) > WARNINGS_MAX:
        out.append({"check": name, "reason": "and %d more" % (len(warned) - WARNINGS_MAX)})
    return out


def drop_checker_paths():
    for folder in (str(HERE), str(HERE.parent / "export" / "agent")):
        while folder in sys.path:
            sys.path.remove(folder)


def run_checks(root, slug, static_only=False):
    root = Path(root).resolve()
    load_checkers()
    checks = [
        ("program", lambda: program_problems(root)),
        ("sources", lambda: sources_problems(root)),
        ("package", lambda: package_problems(root, slug)),
        ("validity", lambda: validity_problems(root, slug)),
        ("verbatim", lambda: verbatim_problems(root)),
        ("results", lambda: results_problems(root, slug)),
        ("effects", lambda: effects_problems(root, slug, static_only)),
        ("materials", lambda: materials_problems(root, slug)),
    ]
    problems, status, warnings = [], {}, []
    if static_only:
        problems.append({"check": "isolation", "reason": "Legacy package execution requires verified file isolation."})
    for name, fn in checks:
        if static_only and name in ("package", "validity"):
            status[name] = "skipped"
            continue
        warned = []
        try:
            # Helpers may print diagnostics; this script's stdout stays one JSON document.
            with contextlib.redirect_stdout(io.StringIO()):
                found = fn()
            if isinstance(found, tuple):  # (problems, warnings): an older build's findings of the newer rules
                found, warned = found
        except Exception as exc:  # a check that cannot run never counts as passed
            found = ["the check could not complete (%s: %s)" % (type(exc).__name__, one_line(exc)[:120])]
        drop_checker_paths()  # a check may put its folder back (sources.py does); keep later imports failing closed
        line = summary(found)
        status[name] = "fail" if line else "pass"
        if line:
            problems.append({"check": name, "reason": line})
        warnings += listed_warnings(name, warned)
    try:
        import contract
        current = contract.current_contract(root / "package" / slug)
    except Exception:  # noqa: BLE001  undecided: say nothing rather than mislabel the build
        current = True
    if not current:
        warnings.append({"check": "contract", "reason": OLDER_BUILD})
    else:
        try:
            strict = contract.strict(root / "package" / slug)
        except Exception:  # noqa: BLE001
            strict = True
        if not strict:
            warnings.append({"check": "contract", "reason": OLDER_THAN_3_BUILD})
    return {"problems": problems, "checks": status, "warnings": warnings}


def main(argv):
    static_only = len(argv) == 3 and argv[2] == "--static-only"
    if not (len(argv) == 2 or static_only) or not argv[1] or Path(argv[1]).name != argv[1] or argv[1] in (".", ".."):
        print("usage: check_readiness.py PROJECT PACKAGE_SLUG [--static-only]", file=sys.stderr)
        return 1
    root = Path(argv[0]).resolve()
    if not (root / "package" / argv[1]).is_dir():
        report = {"problems": [{"check": "package", "reason": "package/%s is not a folder" % argv[1]}], "checks": {},
                  "warnings": []}
    else:
        report = run_checks(root, argv[1], static_only)
    sys.stdout.write(json.dumps(report) + "\n")  # ASCII: safe on any console encoding
    return 0


if __name__ == "__main__":
    os.environ.pop("HUMANSTUDY_HUMAN_DATA", None)  # the app checks the study's own human-data/ folder only
    sys.exit(main(sys.argv[1:]))
