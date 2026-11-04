#!/usr/bin/env python3
"""Check how the build used the files it downloaded: the authors' analysis code, survey versions, and
questions to the researcher that a downloaded file already answers.

    python .opencode/skills/build/check_source_use.py .        (the project folder)

Prints every problem with a fix, then PASS or FAIL (exit 1). Records live in sources/SOURCE.json
(top-level keys; sources.py keeps them across reruns). Paths are project-relative ("sources/open/a.Rmd").

  analysis code  every analysis file under sources/ (.R .Rmd .qmd .ipynb .do .sps .sas, and .py that runs
                 statistics; never data, never run) is read for its recodes, exclusions and test options and
                 recorded in `analysisCode`: {"source": <path>, "lines": "79-90", "quote": <the code as written>,
                 "what": ..., "use": "carried over" | "not applicable", "where": ... | "reason": ...}. Every
                 comment or prose line that reports a coding error, a recode, an exclusion or a removal, and every
                 recode call, must lie within (or 3 lines of) an entry. A file under sources/private/ or
                 sources/researcher/ gives `lines` without `quote` (SOURCE.json is exported; private text is not).
                 A `searches` record that names analysis code while none is under sources/ fails unless
                 `analysisCode` has {"source": "not fetched", "reason": ...} (refused, only inside a data archive,
                 not public, not this paper); "not needed" is not a reason.
  survey versions when two or more survey files (.qsf, or a .docx/.pdf/... questionnaire) are under sources/,
                 `surveyVersions` compares each with the paper: {"path", "study", "matchesPaper": "yes" | "no" |
                 "partly", "compared": ..., "usedFor": ...}. A file marked "no" supplies no participant text (a
                 material or verbatim field citing it fails); one study's text from two files says in each
                 file's usedFor which screens it supplies.
  questions      when files were downloaded (sources/open/, sources/private/), every issue that asks the
                 researcher something (severity decision or blocking, title ending in "?") has a
                 `questionsChecked` entry {"issue": <id>, "sourcesChecked": [{"paths": [...], "answers": false,
                 "found": "what the file says on this point"}]} covering every downloaded file. An entry that says a
                 file answers it fails: take the decision, record it in `decisionsFromSources` ({"what", "path",
                 "locator", "quote"}; a private file gives the locator without quote), and drop the question.

A project without downloaded files and without analysis code passes unchanged. Standard library plus the
readers of check_materials.py and check_quotes.py.
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_materials as cm  # noqa: E402  file readers, data detection, folder names
from check_quotes import normalise  # noqa: E402

ANALYSIS_SUFFIXES = (".r", ".rmd", ".qmd", ".py", ".ipynb", ".do", ".sps", ".sas")
# A .py file is analysis code only when it runs statistics (a PsychoPy script is material).
STATS_CALL = re.compile(
    r"(?i)\b(t\.test|aov|anova|lm|glm|lmer|glmer|prop\.test|chisq\.test|wilcox\.test|cor\.test|TOSTER|tsum_TOST|"
    r"esc_\w+|ttest\w*|scipy\.stats|statsmodels|pingouin|regress|xtreg|UNIANOVA|T-TEST|ONEWAY|fitlm|anovan)\s*[(.]?")
SIGNAL = re.compile(
    r"(?i)\b(coding errors?|errors?|mistakes?|wrong(ly)?|incorrect(ly)?|mis-?coded|re-?cod(e|ed|es|ing)|corrected|"
    r"correction|exclud(e|ed|es|ing)|exclusions?|remov(e|ed|es|ing)|drop(ped|s|ping)?|attention[- ]checks?|"
    r"reverse[- ]?(cod\w*|scor\w*)|outliers?)\b")
RECODE_CALL = re.compile(r"\b(recode|fct_recode|mapvalues|RECODE)\s*\(|^\s*RECODE\b")
# Stata and SPSS: "recode part 1=0 if ...", "drop if ...", "keep if ...", "SELECT IF".
STATA_RECODE = re.compile(r"(?i)^\s*(recode\s+\w|drop\s+if\b|keep\s+if\b|select\s+if\b|filter\s+by\b)")
NOT_SIGNAL = re.compile(r"(?i)standard errors?|type (i+|1|2) errors?|error bars?|errors? terms?|"
                        r"remove (all )?(objects|everything|the workspace)|rm\(list|clear (all|the) (memory|workspace)|"
                        r"marginal error|mean squared? error")
CODE_LISTED = re.compile(
    r"(?i:\b(analysis|analyses|analytic)\s+(script|code|syntax|file|folder)s?\b|\b(R|Stata|SPSS|Python)\s+"
    r"(script|code|syntax|markdown)s?\b|\bdata and code\b)"
    r"|(?<![\w/.-])(?!sources|fetch_source|paper_tables|estimate_run|check_\w+|program_io|effects|audit)[\w-]+"
    r"\.(R|Rmd|qmd|py|ipynb|do|sps|sas)(?![\w.-])")
NOT_FETCHED_OK = re.compile(r"(?i)refused|archive|participant data|not public|not found|no (analysis )?code|"
                            r"login|private|not this (paper|study)|different study|other study")
USES = ("carried over", "not applicable")
STRONG_SURVEY_NAME = re.compile(r"(?i)survey|questionnaire|qualtrics")
NOT_SURVEY_NAME = re.compile(r"(?i)prereg|pre-reg|registration|analysis|readme|codebook|preprint|manuscript|"
                             r"supplement|consent[-_ ]form")
SURVEY_SUFFIXES = (".docx", ".doc", ".pdf", ".odt", ".txt", ".html", ".htm")
MATCHES = ("yes", "no", "partly")
DOWNLOAD_DIRS = (cm.OPEN_DIR, cm.PRIVATE_DIR)


def _list(value):
    return [x for x in value if isinstance(x, dict)] if isinstance(value, list) else []


def _words(text):
    return len(re.findall(r"\w+", str(text or "")))


def _files(root, folders=None):
    """Project-relative paths of the files under sources/ (or the given folders), never participant data."""
    base = root / "sources"
    out = []
    for p in sorted(base.rglob("*")) if base.is_dir() else []:
        rel = p.relative_to(root).as_posix()
        if not p.is_file() or p.name.startswith(".") or p.name == "SOURCE.json":
            continue
        if folders is not None and not any(cm.under(rel, d) for d in folders):
            continue
        if cm.looks_like_data(p):
            continue  # check_materials reports participant data under sources/
        out.append(rel)
    return out


def downloads(root):
    """Files the build downloaded: sources/open/ and sources/private/."""
    return _files(root, DOWNLOAD_DIRS)


def _private(rel):
    return cm.private_rel(rel)


def _program(root):
    try:
        data = json.loads((root / "program.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _norm(rel):
    return cm.norm_rel(rel)


# --------------------------------------------------------------------------- 1. analysis code

def code_lines(path):
    """The file's lines; a notebook's code and markdown cells joined in order (never its outputs)."""
    path = Path(path)
    if path.suffix.lower() == ".ipynb":
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        lines = []
        for cell in data.get("cells") or [] if isinstance(data, dict) else []:
            source = cell.get("source") if isinstance(cell, dict) else None
            lines += ("".join(source) if isinstance(source, list) else str(source or "")).splitlines()
        return lines
    try:
        return path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []


def _code_squash(text):
    """Code compared as written: only typographic quotes and whitespace evened out."""
    text = str(text).replace("\u2019", "'").replace("\u2018", "'").replace("\u201c", '"').replace("\u201d", '"')
    return re.sub(r"\s+", "", text).casefold()


def is_analysis_code(path):
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix not in ANALYSIS_SUFFIXES:
        return False
    if suffix == ".py":
        return bool(STATS_CALL.search("\n".join(code_lines(path))))
    return True


def signal_lines(path):
    """(line number, text) of comment and prose lines that report a recode, a coding error, an exclusion or a
    removal, and of recode calls."""
    path = Path(path)
    suffix = path.suffix.lower()
    out, in_chunk = [], False
    for number, line in enumerate(code_lines(path), 1):
        stripped = line.strip()
        if suffix in (".rmd", ".qmd") and stripped.startswith("```"):
            in_chunk = not in_chunk
            continue
        if suffix in (".rmd", ".qmd") and not in_chunk and re.match(r"#{1,6}\s", stripped):
            continue  # a section heading ("## 6. Data Analysis (After Exclusion)")
        prose = suffix in (".rmd", ".qmd") and not in_chunk and stripped and not stripped.startswith(("<!--", "---"))
        comment = bool(re.match(r"(#|//|\*|/\*|%)", stripped)) or bool(re.search(r"\s#\s", line)) and \
            suffix in (".r", ".rmd", ".qmd", ".py", ".ipynb")
        if suffix == ".ipynb" and re.match(r"#{1,6}\s", stripped) and not re.match(r"#\s", stripped):
            continue  # a markdown heading of a notebook
        if (prose or comment) and SIGNAL.search(NOT_SIGNAL.sub(" ", stripped)):
            out.append((number, stripped[:160]))
        elif RECODE_CALL.search(line) or suffix in (".do", ".sps") and STATA_RECODE.search(line):
            out.append((number, stripped[:160]))
    return out


def _line_range(value):
    if isinstance(value, int) and not isinstance(value, bool):
        return value, value
    if isinstance(value, list) and len(value) == 2 and all(isinstance(v, int) and not isinstance(v, bool) for v in value):
        return min(value), max(value)
    if isinstance(value, str):
        m = re.fullmatch(r"\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*", value)
        if m:
            a, b = int(m.group(1)), int(m.group(2) or m.group(1))
            return min(a, b), max(a, b)
    return None


def check_analysis_code(root, record):
    out = []
    add = lambda msg, fix: out.append((msg, fix))
    entries = _list(record.get("analysisCode"))
    code = [rel for rel in _files(root) if is_analysis_code(root / rel)]
    if not code:
        searches = " ".join("%s %s" % (s.get("query", ""), s.get("result", "")) for s in _list(record.get("searches")))
        listed = CODE_LISTED.search(searches)
        excused = [e for e in entries if str(e.get("source", "")).strip().lower() in ("none", "not fetched")
                   and NOT_FETCHED_OK.search(str(e.get("reason", "")))]
        if listed and not excused:
            add("analysis code: a search found the authors' analysis code (\"%s\" in sources/SOURCE.json searches) but "
                "no analysis file is under sources/" % listed.group(0),
                "download the code files (never data), record them with sources.py and read them for recodes, "
                "exclusions and the exact tests. Only when the code cannot be fetched (refused, only inside an archive "
                "with participant data, not public) add {\"source\": \"not fetched\", \"reason\": \"...\"} to analysisCode")
        return out
    for rel in code:
        mine = [e for e in entries if _norm(e.get("source")) == rel]
        private = _private(rel)
        if not mine:
            add("analysis code: nothing is recorded from %s" % rel,
                "add sources/SOURCE.json analysisCode entries {\"source\": \"%s\", \"lines\": \"79-90\", %s\"what\": "
                "\"<the recode, exclusion or test option>\", \"use\": \"carried over\", \"where\": \"<where the package "
                "applies it>\"} (or \"use\": \"not applicable\" with a \"reason\") for each recode, exclusion and test "
                "specification it holds" % (rel, "" if private else "\"quote\": \"<the code line, exactly>\", "))
            continue
        lines = code_lines(root / rel)
        covered = []
        for i, e in enumerate(mine, 1):
            label = "analysisCode entry %d for %s" % (i, rel)
            span = _line_range(e.get("lines"))
            if span is None or span[0] < 1 or span[1] > len(lines):
                add("%s: lines must be a line number or range in the file (1-%d)" % (label, len(lines)), "")
                continue
            covered.append(span)
            quote = e.get("quote")
            if private:
                if isinstance(quote, str) and quote.strip():
                    add("%s: %s is not openly licensed; SOURCE.json is exported, so give lines without a quote" % (label, rel),
                        "remove quote; lines locate the code")
            elif not isinstance(quote, str) or not quote.strip():
                add("%s: quote the code line(s) it is about" % label, "copy the line exactly as written")
            elif _code_squash(quote) not in _code_squash("\n".join(lines[max(0, span[0] - 6):span[1] + 5])):
                add("%s: the quote does not occur at lines %d-%d of %s" % (label, span[0], span[1], rel), "")
            if _words(e.get("what")) < 3:
                add("%s: say in 'what' what the code does there (a recode, an exclusion, a test and its options)" % label, "")
            use = str(e.get("use", "")).strip().lower()
            if use not in USES:
                add("%s: use must be 'carried over' or 'not applicable'" % label, "")
            elif use == "carried over" and len(str(e.get("where", "")).split()) < 2 \
                    and not re.search(r"[/.]", str(e.get("where", ""))):
                add("%s: say in 'where' where the package applies it (evaluation, adapter, materials)" % label, "")
            elif use == "not applicable" and _words(e.get("reason")) < 4:
                add("%s: say in 'reason' why it does not apply to the replay" % label, "")
        missed = [(n, t) for n, t in signal_lines(root / rel) if not any(lo - 3 <= n <= hi + 3 for lo, hi in covered)]
        if missed:
            add("analysis code: %s reports recodes, coding errors or exclusions that no analysisCode entry covers: %s%s"
                % (rel, "; ".join("line %d: \"%s\"" % (n, t[:90]) for n, t in missed[:6]),
                   " and %d more" % (len(missed) - 6) if len(missed) > 6 else ""),
                "read each: carry a recode or exclusion over to the evaluation (or adapter) and record it, or record "
                "why it does not apply to the replay")
    return out


# --------------------------------------------------------------------------- 2. survey versions

def survey_files(paths):
    def stem(p):
        return re.sub(r"-\d+$", "", Path(p).stem.lower())
    stems = {stem(p) for p in paths if Path(p).suffix.lower() == ".qsf"}
    out = []
    for rel in paths:
        suffix, name = Path(rel).suffix.lower(), Path(rel).name
        if suffix == ".qsf":
            out.append(rel)
        elif suffix in SURVEY_SUFFIXES and (stem(rel) in stems or STRONG_SURVEY_NAME.search(name)
                                            and not NOT_SURVEY_NAME.search(STRONG_SURVEY_NAME.sub("", name))):
            out.append(rel)
    return out


def _cited_files(field, evidence):
    m = field.get("extensions", {}).get("material") if isinstance(field.get("extensions"), dict) else None
    paths = [_norm(evidence[i].get("path")) for i in field.get("evidenceIds") or [] if i in evidence]
    if isinstance(m, dict):
        paths.append(_norm(m.get("file")))
    if isinstance(field.get("value"), dict):
        paths.append(_norm(field["value"].get("file")))
    return [p for p in paths if p]


def _participant_text(field):
    m = field.get("extensions", {}).get("material") if isinstance(field.get("extensions"), dict) else None
    return (isinstance(m, dict) and m.get("status") in ("found-open", "found-private")) or field.get("origin") == "verbatim"


def check_survey_versions(root, record):
    surveys = survey_files(_files(root))
    if len(surveys) < 2:
        return []
    out = []
    entries = {}
    for e in _list(record.get("surveyVersions")):
        if _norm(e.get("path")):
            entries.setdefault(_norm(e.get("path")), []).append(e)
    absent = [p for p in surveys if p not in entries]
    if absent:
        out.append(("survey versions: %d survey files are under sources/ (%s) but sources/SOURCE.json surveyVersions "
                    "does not compare %s with the paper" % (len(surveys), ", ".join(surveys), ", ".join(absent)),
                    "for each file add {\"path\": \"%s\", \"study\": \"<study id>\", \"matchesPaper\": \"yes\" | \"no\" | "
                    "\"partly\", \"compared\": \"<number and order of scenarios, wording of the items the paper prints, "
                    "response codes against option text>\", \"usedFor\": \"<which screens it supplies, or 'not used'>\"}; "
                    "build each study from the version that matches the paper" % absent[0]))
    for rel, items in entries.items():
        for e in items:
            if e.get("matchesPaper") not in MATCHES:
                out.append(("surveyVersions %s: matchesPaper must be 'yes', 'no' or 'partly'" % rel, ""))
            if _words(e.get("compared")) < 6:
                out.append(("surveyVersions %s: say in 'compared' what was compared with the paper" % rel,
                            "number and order of scenarios or blocks, item wording, response codes"))
    program = _program(root)
    evidence = {e.get("id"): e for e in _list(program.get("evidence"))}
    per_study = {}
    for n in _list(program.get("nodes")):
        for f in _list(n.get("fields")):
            if not _participant_text(f):
                continue
            studies = [str(s) for s in (f.get("studyIds") or n.get("studyIds") or [])]
            for rel in _cited_files(f, evidence):
                if rel not in entries:
                    continue
                per_study.setdefault(" ".join(studies), set()).add(rel)
                bad = [e for e in entries[rel] if e.get("matchesPaper") == "no"
                       and (not e.get("study") or not studies or str(e.get("study")) in studies)]
                if bad:
                    out.append(("survey versions: %s.%s takes participant text from %s, which surveyVersions says does "
                                "not match the paper" % (n.get("id"), f.get("id"), rel),
                                "use the version that matches the paper"))
    for studies, paths in per_study.items():
        if len(paths) >= 2:
            unexplained = [p for p in sorted(paths) if not any(len(str(e.get("usedFor", "")).split()) >= 3
                                                                for e in entries.get(p, []))]
            if unexplained:
                out.append(("survey versions: one study (%s) takes participant text from %s" % (
                    studies or "the program", " and ".join(sorted(paths))),
                    "say in each file's surveyVersions usedFor which screens it supplies and why they are the version "
                    "participants saw"))
    return out


# --------------------------------------------------------------------------- 3. questions to the researcher

def question_issues(program):
    """Issues that put a question to the researcher: severity decision or blocking and a title ending in "?".
    The per-item "Needs the original ..." and "Left out by the researcher" issues are not questions."""
    out = []
    for i in _list(program.get("issues")):
        title = str(i.get("title", "")).strip()
        if i.get("severity") in ("decision", "blocking") and title.endswith("?") \
                and not re.match(r"(?i)(needs the original|left out by the researcher)", title):
            out.append(i)
    return out


def _quote_in(quote, rel, root):
    text = normalise(cm.text_of(root / rel))
    return not text or normalise(quote) in text  # unreadable file: cannot check


def check_questions(root, record):
    files = downloads(root)
    if not files:
        return []
    program = _program(root)
    paper = (program.get("source") or {}).get("filename") or "paper.pdf"
    out = []
    records = {r.get("issue"): r for r in _list(record.get("questionsChecked")) if isinstance(r.get("issue"), str)}
    unchecked, answered = [], []
    for issue in question_issues(program):
        r = records.get(issue.get("id"))
        covered = set()
        for item in _list(r.get("sourcesChecked")) if r else []:
            paths = ([item.get("path")] if isinstance(item.get("path"), str) else []) + \
                [p for p in item.get("paths") or [] if isinstance(p, str)]
            covered.update(_norm(p) for p in paths)
            if _words(item.get("found")) < 3:
                unchecked.append("'%s' (say in 'found' what each file says on this point)" % issue.get("id"))
            if item.get("answers") is True:
                answered.append("'%s' (%s)" % (issue.get("id"), ", ".join(paths)))
        missing = [p for p in files if p not in covered]
        if not r:
            unchecked.append("'%s' (no record)" % issue.get("id"))
        elif missing:
            unchecked.append("'%s' (not checked: %s%s)" % (issue.get("id"), ", ".join(missing[:4]),
                                                          " and more" if len(missing) > 4 else ""))
    if unchecked:
        out.append(("questions: before asking the researcher, check every downloaded file for the answer; missing for "
                    + ", ".join(unchecked[:6]),
                    "record it in sources/SOURCE.json questionsChecked: {\"issue\": \"<issue id>\", \"sourcesChecked\": "
                    "[{\"paths\": [\"sources/open/<file>\", ...], \"answers\": false, \"found\": \"<what the file says on "
                    "this point>\"}]}, covering every file under sources/open/ and sources/private/"))
    if answered:
        out.append(("questions: a downloaded file answers %s" % ", ".join(answered[:4]),
                    "do not ask: apply the answer, record it in sources/SOURCE.json decisionsFromSources ({\"what\", "
                    "\"path\", \"locator\", \"quote\"}), remove the question issue, and say in the reply that it was "
                    "decided from the sources and where"))
    for i, d in enumerate(_list(record.get("decisionsFromSources"))):
        label = "decisionsFromSources[%d]" % i
        rel, quote = _norm(d.get("path")), d.get("quote")
        if rel not in files and rel != _norm(paper):
            out.append(("%s: path must be a downloaded file (sources/open/... or sources/private/...) or the paper" % label, ""))
            continue
        if _words(d.get("what")) < 3:
            out.append(("%s: say in 'what' what was decided" % label, ""))
        if _private(rel):
            if isinstance(quote, str) and quote.strip():
                out.append(("%s: %s is not openly licensed; give the locator without a quote" % (label, rel), ""))
            elif not d.get("locator"):
                out.append(("%s: give the locator (page, section, question id) where the file settles it" % label, ""))
        elif not isinstance(quote, str) or not quote.strip():
            out.append(("%s: give the quote that settles it" % label, "copy the sentence exactly from %s" % rel))
        elif not _quote_in(quote, rel, root):
            out.append(("%s: the quote does not occur in %s" % (label, rel), "copy it exactly from the file"))
    return out


def problems(root):
    """[(message, fix)] for the analysis code, survey versions and researcher questions of a project folder."""
    root = Path(root).resolve()
    record = cm.source_record(root)
    record = record if isinstance(record, dict) else {}
    out = []
    for check in (check_analysis_code, check_survey_versions, check_questions):
        try:
            out += check(root, record)
        except Exception as exc:  # noqa: BLE001 - a malformed record is reported, not a crash
            out.append(("%s could not run (%s: %s)" % (check.__name__, type(exc).__name__, exc),
                        "fix the malformed record in sources/SOURCE.json"))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", nargs="?", default=".")
    a = ap.parse_args(argv)
    found = problems(a.project)
    for msg, fix in found:
        print("PROBLEM %s" % msg + ("\n        fix: %s" % fix if fix else ""))
    if found:
        print("FAIL %d problem(s) in how the build used its sources" % len(found))
        return 1
    print("PASS sources used: analysis code, survey versions and questions checked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
