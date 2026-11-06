#!/usr/bin/env python3
"""Check how the build used the files it downloaded: the authors' analysis code, survey versions, and
questions to the researcher that a downloaded file already answers.

    python .opencode/skills/build/check_source_use.py .        (the project folder)

Prints every problem with a fix, then PASS or FAIL (exit 1). Records live in sources/SOURCE.json
(top-level keys; sources.py keeps them across reruns). Paths are project-relative ("sources/open/a.Rmd").

  analysis code  every analysis file downloaded with fetch_source.py (a SOURCE.json file entry with `url` or
                 `retrieved`, under sources/open/ or sources/private/; sources/researcher/ is the researcher's and
                 is not checked) is read for its recodes, exclusions and test options and recorded in
                 `analysisCode`: {"source": <path>, "lines": "79-90", "quote": <the code as written>, "what": ...,
                 "use": "carried over" | "not applicable", "where": ... | "reason": ...}. Analysis files are .R
                 .Rmd .qmd .ipynb .do .sps .sas, and a .py that runs statistics and is not an experiment script
                 (one that imports psychopy, expyriment, pygame, jspsych, otree ... or defines run_sessions is
                 material, not analysis); never data, never run. Every comment or prose line that reports a coding
                 error, a recode, an exclusion or a removal, and every recode call, must lie within (or 3 lines
                 of) the quoted code of an entry, and an entry spans at most MAX_SPAN lines (one wide entry never
                 covers a script); an entry for a sources/private/ file gives `lines` without `quote` (SOURCE.json
                 is exported; private text is not) and covers by its lines alone.
                 A `searches` record that names analysis code while none is under sources/ fails unless
                 `analysisCode` has {"source": "not fetched", "reason": ...} (refused, only inside a data archive,
                 not public, not this paper); "not needed" is not a reason.
  survey versions when two or more survey files (.qsf, or a .docx/.pdf/... questionnaire) are under sources/,
                 `surveyVersions` compares each with the paper: {"path", "study", "matchesPaper": "yes" | "no" |
                 "partly", "compared": ..., "usedFor": ...}. A file marked "no" supplies no participant text (a
                 material or verbatim field citing it fails); one study's text from two files says in each
                 file's usedFor which screens it supplies.
  questions      when files were downloaded with fetch_source.py (as above), every issue that asks the
                 researcher something (severity decision or blocking, title ending in "?") has a
                 `questionsChecked` entry {"issue": <id>, "sourcesChecked": [{"paths": [...], "answers": false,
                 "found": "what the file says on this point"}]} covering the paper (paper.pdf: its text elsewhere,
                 arithmetic on its numbers, which model a number comes from) and every downloaded file. Without
                 downloads, an entry that exists must still list the paper. An entry that says a
                 file answers it fails: take the decision, record it in `decisionsFromSources` ({"what", "path",
                 "locator", "quote"}; a private file gives the locator without quote), and drop the question.
  claims         a claim that material or a rule is not printed or not public (a failures.json entry with
                 pattern materials-not-public / missing-information or such words, a run.excluded reason, an
                 issue title or reason, a pending / stand-in / left-out item, a field note) is searched for in the
                 text of every source the build holds (the paper, PDFs, .qsf one page per block, .docx, text
                 files). A page that mentions enough of the claim's terms (rare ones; a close match in the paper)
                 needs a `claimsChecked` entry {"claim": <id>, "sourcesChecked": [{"path", "pages", "prints":
                 false, "found": "what the page says"}]}; "prints": true fails (use it, drop the claim). While a
                 claim stands, a PDF page without a text layer fails unless `pagesRead` records it ({"path",
                 "pages", "how", "holds"}), and a search that located openly licensed material it did not import
                 ("only ... was imported") fails.

A project without downloaded files and without analysis code passes unchanged; a file placed under sources/open/
by hand (no url, no retrieved date) is not held to the analysis-code and question rules. A malformed SOURCE.json
or program.json never crashes it: records of the wrong shape are skipped. Standard library plus the readers of
check_materials.py and check_quotes.py.
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
MAX_SPAN = 15   # lines one analysisCode entry may cover: one recode or exclusion, never a whole script
# A Python experiment script (stimulus presentation, a replay harness) is material, not analysis code.
EXPERIMENT_PY = re.compile(
    r"(?m)^\s*(?:from|import)\s+(?:psychopy|expyriment|pygame|pyglet|jspsych|otree|psychtoolbox|libopensesame|"
    r"opensesame|neuropsydia|psychopy_\w+)\b|^\s*def\s+run_sessions\s*\(")
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
    """Files under sources/open/ and sources/private/ (downloaded, or placed there by hand)."""
    return _files(root, DOWNLOAD_DIRS)


def fetched(root, record):
    """Files fetch_source.py downloaded: a SOURCE.json file entry with `url` or `retrieved`, under sources/open/
    or sources/private/, on disk, not participant data."""
    on_disk = set(downloads(root))
    out = set()
    for f in _list(record.get("files")):
        rel = _norm(f.get("path")) if isinstance(f.get("path"), str) else ""
        if rel in on_disk and (isinstance(f.get("url"), str) and f["url"].strip()
                               or isinstance(f.get("retrieved"), str) and f["retrieved"].strip()):
            out.add(rel)
    return sorted(out)


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
        text = "\n".join(code_lines(path))
        return bool(STATS_CALL.search(text)) and not EXPERIMENT_PY.search(text)
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


def _overlaps(quote, line):
    """The quote is, holds or lies within the line (code compared as written)."""
    q, l = _code_squash(quote), _code_squash(line)
    return bool(q and l) and (len(l) >= 4 and l in q or q in l)


def check_analysis_code(root, record):
    out = []
    add = lambda msg, fix: out.append((msg, fix))
    entries = _list(record.get("analysisCode"))
    anywhere = [rel for rel in _files(root) if is_analysis_code(root / rel)]
    code = [rel for rel in fetched(root, record) if rel in anywhere]
    if not anywhere:
        searches = " ".join("%s %s" % (s.get("query", ""), s.get("result", "")) for s in _list(record.get("searches")))
        listed = CODE_LISTED.search(searches)
        excused = [e for e in entries if str(e.get("source") or "").strip().lower() in ("none", "not fetched")
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
        signals = signal_lines(root / rel)
        covered = set()
        for i, e in enumerate(mine, 1):
            label = "analysisCode entry %d for %s" % (i, rel)
            span = _line_range(e.get("lines"))
            if span is None or span[0] < 1 or span[1] > len(lines):
                add("%s: lines must be a line number or range in the file (1-%d)" % (label, len(lines)), "")
                continue
            quote = e.get("quote")
            if span[1] - span[0] + 1 > MAX_SPAN:
                add("%s: lines %d-%d span more than %d lines; an entry records one recode, exclusion or test"
                    % (label, span[0], span[1], MAX_SPAN),
                    "give each recode and exclusion its own entry with the lines and quote of that code")
            else:
                if private or not isinstance(quote, str) or not quote.strip():
                    at = range(span[0], span[1] + 1)      # a private file is located by its lines alone
                else:                                     # the lines (in the span) that the quote is or holds
                    at = [k for k in range(max(1, span[0] - 5), min(len(lines), span[1] + 5) + 1)
                          if _overlaps(quote, lines[k - 1])]
                covered.update(n for n, _ in signals if any(abs(n - k) <= 3 for k in at))
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
        missed = [(n, t) for n, t in signals if n not in covered]
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
    ids = field.get("evidenceIds") if isinstance(field.get("evidenceIds"), list) else []
    paths = [_norm(evidence[i].get("path")) for i in ids if isinstance(i, str) and i in evidence]
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
    evidence = {e["id"]: e for e in _list(program.get("evidence")) if isinstance(e.get("id"), str)}
    per_study = {}
    for n in _list(program.get("nodes")):
        for f in _list(n.get("fields")):
            if not _participant_text(f):
                continue
            studies = f.get("studyIds") or n.get("studyIds")
            studies = [str(s) for s in studies] if isinstance(studies, list) else []
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
        if not isinstance(i.get("id"), str):
            continue
        title = str(i.get("title") or "").strip()
        if i.get("severity") in ("decision", "blocking") and title.endswith("?") \
                and not re.match(r"(?i)(needs the original|left out by the researcher)", title):
            out.append(i)
    return out


def _quote_in(quote, rel, root):
    text = normalise(cm.text_of(root / rel))
    return not text or normalise(quote) in text  # unreadable file: cannot check


def check_questions(root, record):
    files = fetched(root, record)
    program = _program(root)
    source = program.get("source") if isinstance(program.get("source"), dict) else {}
    paper = source.get("filename") if isinstance(source.get("filename"), str) else "paper.pdf"
    on_disk = downloads(root)
    records = {r.get("issue"): r for r in _list(record.get("questionsChecked")) if isinstance(r.get("issue"), str)}
    if not files and not records:
        return []
    # The paper settles many questions itself (its text elsewhere, arithmetic on its numbers, which model a number
    # comes from), so a check lists it too. Without downloads only the questions that have a record are held to it.
    must = files + ([_norm(paper)] if (root / _norm(paper)).is_file() else [])
    out = []
    unchecked, answered = [], []
    for issue in question_issues(program):
        r = records.get(issue.get("id"))
        if not files and not r:
            continue
        covered = set()
        for item in _list(r.get("sourcesChecked")) if r else []:
            paths = ([item.get("path")] if isinstance(item.get("path"), str) else []) + \
                [p for p in (item.get("paths") if isinstance(item.get("paths"), list) else []) if isinstance(p, str)]
            covered.update(_norm(p) for p in paths)
            if _words(item.get("found")) < 3:
                unchecked.append("'%s' (say in 'found' what each file says on this point)" % issue.get("id"))
            if item.get("answers") is True:
                answered.append("'%s' (%s)" % (issue.get("id"), ", ".join(paths)))
        missing = [p for p in must if p not in covered]
        if not r:
            unchecked.append("'%s' (no record)" % issue.get("id"))
        elif missing:
            unchecked.append("'%s' (not checked: %s%s)" % (issue.get("id"), ", ".join(missing[:4]),
                                                          " and more" if len(missing) > 4 else ""))
    if unchecked:
        out.append(("questions: before asking the researcher, check every downloaded file for the answer; missing for "
                    + ", ".join(unchecked[:6]),
                    "record it in sources/SOURCE.json questionsChecked: {\"issue\": \"<issue id>\", \"sourcesChecked\": "
                    "[{\"paths\": [\"%s\", \"sources/open/<file>\", ...], \"answers\": false, \"found\": \"<what "
                    "the file says on this point>\"}]}, covering the paper (its text, its arithmetic, which model a "
                    "number comes from) and every file under sources/open/ and sources/private/" % _norm(paper)))
    if answered:
        out.append(("questions: a downloaded file answers %s" % ", ".join(answered[:4]),
                    "do not ask: apply the answer, record it in sources/SOURCE.json decisionsFromSources ({\"what\", "
                    "\"path\", \"locator\", \"quote\"}), remove the question issue, and say in the reply that it was "
                    "decided from the sources and where"))
    for i, d in enumerate(_list(record.get("decisionsFromSources"))):
        label = "decisionsFromSources[%d]" % i
        rel, quote = _norm(d.get("path")), d.get("quote")
        if rel not in on_disk and rel != _norm(paper):
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


# --------------------------------------------------------------------------- 4. "not printed / not public" claims

NOT_PRINTED = re.compile(
    r"(?i)\bnot\s+(?:\w+\s+){0,2}?(?:printed|public|publicly\s+available|reported|available|included|shown)\b|\bunprinted\b|\bdoes(?:\s+not|n't)\s+print\b|\bprints\s+no\b|\bno\s+(?:public|"
    r"general)\s+(?:text|source|copy|materials?)\b|\bonly\s+as\s+(?:images?|screenshots?|pictures?|scans?)\b|"
    r"\bexist\s+only\s+as\b|\bno\s+text\s+layer\b|\bnot\s+in\s+the\s+(?:paper|supplement|si|osf|public)\b")
# A claim about a reported statistic ("N is not printed", "the exact p value is not printed") is a results matter.
STAT_CLAIM = re.compile(r"(?i)^\W*(?:the\s+)?(?:exact\s+)?(?:n|ns|df|p|p\s+values?|se|sd|sds|cell\s+(?:sizes|counts|means)|"
                        r"means?|degrees\s+of\s+freedom|test\s+statistics?|statistics?|number\s+of\s+observations|"
                        r"(?:total|per[- ]condition|analysed)\s+n|n\s+of|joint|correlations?)\b")
CLAIM_PATTERNS = ("materials-not-public", "missing-information")
CLAIM_STOP = set("""paper papers printed print prints public publicly text texts available found source sources supplement
supplementary appendix appendices exact exactly described describe describes description replay replays replayed stand
stands labelled label labels original originals missing wording words therefore only other these those their which from
with that this each were have does into also there about through before after cannot until while where when what would
could should because material materials study studies participant participants paper's not none nor than then them they
been being here more most many some such shown show shows given given provided included stated specified reported
report reports public online files file page pages build builder used uses using runs running needs need needed
researcher authors author pdf osf journal article articles version versions instead without within across left
supplied supply until meanwhile labelled accepted provisional nothing cannot adapter needs original stand three four
five two one json both all every""".split())
STEM = 5           # letters a word is compared by ("predicates" and "predicate" agree)
WINDOW = 60        # words within which a claim's terms count as one mention
MIN_TERMS = 2      # distinct claim terms in one window
RARE_SHARE = 0.25  # at least one of them on no more than this share of the pages
RARER_SHARE = 0.1  # two terms suffice when both are this rare
PAPER_TERMS = 4    # in the paper itself, a mention needs this many terms (two of them rare)
MAX_HITS = 3       # pages reported per claim
LOCATED_NOT_IMPORTED = re.compile(r"(?i)\bonly\b[^.;]{0,80}\b(?:was|were)\s+(?:imported|downloaded|fetched|used)\b|"
                                  r"\b(?:was|were)\s+not\s+(?:imported|downloaded|fetched)\b|\bnot\s+(?:yet\s+)?imported\b")
OPEN_WORDS = re.compile(r"(?i)\bcc[- ]?by\b|\bcc0\b|creative\s+commons|open\s+licen[cs]e")


def _stem(word):
    return word[:STEM]


def _terms(text):
    return [_stem(w) for w in re.findall(r"[a-z]{4,}", str(text or "").lower()) if w not in CLAIM_STOP]


def _load_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _claimed(text):
    """The text holds a sentence saying something is not printed or not public that is not about a statistic."""
    return any(NOT_PRINTED.search(x) and not STAT_CLAIM.search(x) for x in re.split(r"(?<=[.;])\s+", str(text or "")))


def claims(root, program=None):
    """Every place the build says material or a rule is not printed or not public: [{"id", "text", "kind"}].
    Ids: failures[i] (artifacts/failures.json), run.excluded[i] (capabilities.json), an issue id, or node.field."""
    root = Path(root)
    program = program if isinstance(program, dict) else _program(root)
    out = []
    failures = _load_json(root / "artifacts/failures.json")
    for i, f in enumerate(failures if isinstance(failures, list) else []):
        if not isinstance(f, dict):
            continue
        text = " ".join(str(f.get(k) or "") for k in ("where", "what"))
        if f.get("pattern") in CLAIM_PATTERNS or _claimed(f.get("what")):
            out.append({"id": "failures[%d]" % i, "text": text, "kind": str(f.get("pattern") or "claim")})
    caps = _load_json(root / "capabilities.json")
    run = caps.get("run") if isinstance(caps, dict) and isinstance(caps.get("run"), dict) else {}
    for i, x in enumerate(_list(run.get("excluded"))):
        text = "%s %s" % (x.get("what") or "", x.get("reason") or "")
        if _claimed(x.get("reason")):
            out.append({"id": "run.excluded[%d]" % i, "text": text, "kind": "excluded"})
    materials = {(n.get("id"), f.get("id")) for n in _list(program.get("nodes")) for f in _list(n.get("fields"))
                 if isinstance(f.get("extensions"), dict) and isinstance(f["extensions"].get("material"), dict)}
    for issue in _list(program.get("issues")):
        if (issue.get("nodeId"), issue.get("fieldId")) in materials:
            continue   # the material item itself is the claim
        text = " ".join(str(issue.get(k) or "") for k in ("title", "reason"))
        if isinstance(issue.get("id"), str) and any(_claimed(issue.get(k)) for k in ("title", "reason", "description")):
            out.append({"id": issue["id"], "text": text, "kind": "issue"})
    for n in _list(program.get("nodes")):
        for f in _list(n.get("fields")):
            where = "%s.%s" % (n.get("id"), f.get("id"))
            m = (f.get("extensions") or {}).get("material") if isinstance(f.get("extensions"), dict) else None
            if isinstance(m, dict) and m.get("kind") == "needs-original" and m.get("status") in ("pending", "stand-in",
                                                                                                  "left-out"):
                out.append({"id": where, "kind": "material " + str(m.get("status")),
                            "text": "%s %s" % (m.get("what") or "", f.get("label") or "")})
                continue
            strings = [s for s in (f.get("value"), f.get("note"), f.get("derivation"), f.get("basis"))
                       if isinstance(s, str)]
            said = [s for s in strings if NOT_PRINTED.search(s)]
            sentences = [x for s in said for x in re.split(r"(?<=[.;])\s+", s) if NOT_PRINTED.search(x)
                         and not STAT_CLAIM.search(x)]
            if sentences:
                out.append({"id": where, "kind": "field", "text": "%s %s" % (f.get("label") or f.get("id"),
                                                                              " ".join(sentences))})
    return out


def _qsf_pages(path):
    """A survey export as one page per block: its description and every question's text, options and labels."""
    try:
        import qsf_flow
        data = qsf_flow.load_qsf(path)
        questions = qsf_flow._questions(data)
        pages = []
        for bid, block in qsf_flow._blocks(data).items():
            texts = [str(block.get("Description") or "")]
            for e in block.get("BlockElements") or []:
                q = questions.get(e.get("QuestionID")) if isinstance(e, dict) else None
                if q:
                    texts += qsf_flow._record_texts(qsf_flow._question(q, questions, []))
            pages.append("\n".join(texts))
        return pages
    except Exception:  # noqa: BLE001  not a survey export: read as text
        return [cm.text_of(path)]


def source_pages(root):
    """{project path: [page text, ...]} of the paper and every readable file under sources/ (never data)."""
    root = Path(root)
    program = _program(root)
    source = program.get("source") if isinstance(program.get("source"), dict) else {}
    paper = "paper.pdf" if (root / "paper.pdf").is_file() else str(source.get("filename") or "paper.pdf")
    out = {}
    for rel in ([paper] if (root / paper).is_file() else []) + _files(root):
        path = root / rel
        suffix = path.suffix.lower()
        try:
            if suffix == ".pdf":
                import check_quotes
                pages = check_quotes.Pdf(path).load() or []
            elif suffix == ".qsf":
                pages = _qsf_pages(path)
            elif suffix == ".docx":
                import docx_text
                pages = ["\n".join(p) for p in docx_text.read(path)["pages"]]
            else:
                pages = [cm.text_of(path)]
        except Exception:  # noqa: BLE001  an unreadable file has no pages
            pages = []
        if any(str(p).strip() for p in pages) or suffix == ".pdf" and pages:
            out[rel] = [str(p or "") for p in pages]
    return out


def unread_pages(pages):
    """{path: [page numbers]} of PDF pages without a text layer (scanned pages, screenshots)."""
    return {rel: [i for i, t in enumerate(doc, 1) if len(re.sub(r"\s+", "", t)) < 40]
            for rel, doc in pages.items() if rel.lower().endswith(".pdf")}


def _ranges(numbers):
    out, run = [], []
    for n in sorted(numbers):
        if run and n == run[-1] + 1:
            run.append(n)
        else:
            if run:
                out.append(run)
            run = [n]
    if run:
        out.append(run)
    return ", ".join("%d" % r[0] if len(r) == 1 else "%d-%d" % (r[0], r[-1]) for r in out)


def _page_set(value):
    """Page numbers a record names: 4, "4", "16-47", "pp. 3, 5-6", [1, 2]."""
    found = set()
    for part in value if isinstance(value, list) else [value]:
        for a, b in re.findall(r"(\d+)\s*(?:[-–]\s*(\d+))?", str(part if part is not None else "")):
            lo, hi = int(a), int(b or a)
            if hi - lo <= 2000:
                found.update(range(min(lo, hi), max(lo, hi) + 1))
    return found


def mentions(claim_terms, pages, paper=None):
    """[(score, path, page, snippet)]: pages where at least MIN_TERMS of the claim's terms (one of them rare)
    occur within WINDOW words, best first."""
    docs = [(rel, i, re.findall(r"[a-z]{4,}", t.lower()), t) for rel, doc in pages.items() for i, t in enumerate(doc, 1)]
    total = max(1, len(docs))
    df = {}
    for _, _, words, _ in docs:
        for s in {_stem(w) for w in words}:
            df[s] = df.get(s, 0) + 1
    wanted = {t for t in claim_terms if df.get(t)}
    if len(wanted) < MIN_TERMS:
        return []
    import math
    idf = {t: math.log(total / df[t]) for t in wanted}
    rare = {t for t in wanted if df[t] <= max(1, RARE_SHARE * total)}
    rarer = {t for t in wanted if df[t] <= max(1, RARER_SHARE * total)}
    hits = []
    for rel, page, words, raw in docs:
        stems = [_stem(w) for w in words]
        positions = [(k, s) for k, s in enumerate(stems) if s in wanted]
        best, best_at = (0.0, set()), 0
        for j, (k, _) in enumerate(positions):
            inside = {s for kk, s in positions[j:] if kk - k <= WINDOW}
            score = sum(idf[s] for s in inside)
            # three terms with one rare, or two that are both rarer: one shared word is a coincidence
            strong = len(inside) >= MIN_TERMS + 1 and inside & rare or len(inside) >= MIN_TERMS and inside <= rarer
            if rel == paper:   # the paper is what the build read first: only a close match there counts
                strong = strong and len(inside) >= PAPER_TERMS and len(inside & rare) >= 2
            if strong and score > best[0]:
                best, best_at = (score, inside), k
        if best[0]:
            snippet = " ".join(words[max(0, best_at - 3):best_at + 14])
            hits.append((round(best[0], 2), rel, page, snippet, sorted(best[1])))
    hits.sort(key=lambda h: -h[0])
    return hits


def check_claims(root, record):
    """A claim that material or a rule is not printed or not public must survive the sources the build holds."""
    program = _program(root)
    found = claims(root, program)
    if not found:
        return []
    out = []
    pages = source_pages(root)
    source = program.get("source") if isinstance(program.get("source"), dict) else {}
    paper = "paper.pdf" if (Path(root) / "paper.pdf").is_file() else str(source.get("filename") or "paper.pdf")
    checked = {}
    for r in _list(record.get("claimsChecked")):
        if isinstance(r.get("claim"), str):
            checked.setdefault(r["claim"], []).extend(_list(r.get("sourcesChecked")))
    # 1. pages nobody read: a PDF page with no text layer in a file the build holds
    read = {}
    for r in _list(record.get("pagesRead")):
        if isinstance(r.get("path"), str) and str(r.get("how", "")).strip() and _words(r.get("holds")) >= 2:
            read.setdefault(_norm(r["path"]), set()).update(_page_set(r.get("pages")))
    unread = {rel: [p for p in nums if p not in read.get(rel, set())] for rel, nums in unread_pages(pages).items()}
    unread = {rel: nums for rel, nums in unread.items() if nums}
    if unread:
        out.append(("claims: %d claim(s) say material is not printed or not public (%s), but pages of the sources "
                    "have no text layer and are not recorded as read: %s"
                    % (len(found), ", ".join(c["id"] for c in found[:4]) + (" ..." if len(found) > 4 else ""),
                       "; ".join("%s pp. %s" % (rel, _ranges(nums)) for rel, nums in sorted(unread.items()))),
                    "render each page (paper_tables.py --render <dir>, or pdf_pages.py) and read it; record "
                    "sources/SOURCE.json pagesRead: [{\"path\": \"<file>\", \"pages\": \"16-47\", \"how\": \"rendered\", "
                    "\"holds\": \"<what the pages show: instruction screenshots, a figure ...>\"}]. Screenshots of "
                    "instructions are printed material: transcribe them, never call them not public"))
    # 2. a search record that located open material the build then did not import
    located = [s for s in _list(record.get("searches")) if LOCATED_NOT_IMPORTED.search(str(s.get("result", "")))
               and OPEN_WORDS.search(str(s.get("result", "")))]
    gaps = [c for c in found if c["kind"] in ("materials-not-public", "material pending", "material left-out")]
    if located and gaps:
        s = located[0]
        out.append(("claims: %s say(s) the material is missing, but sources/SOURCE.json searches record openly licensed "
                    "material that was located and not imported (%s: \"%s\")"
                    % (", ".join(c["id"] for c in gaps[:4]) + (" ..." if len(gaps) > 4 else ""), s.get("where") or s.get("url"),
                       str(s.get("result"))[:200]),
                    "import it with fetch_source.py (every file it needs, with its licence), or record the scope "
                    "decision as a decision issue that names the located files; 'materials-not-public' and a pending "
                    "item are for material no public source holds"))
    # 3. the sources mention what the claim says they lack: name the pages, and require a record of what they say
    unresolved, printed = [], []
    for c in found:
        hits = [h for h in mentions(set(_terms(c["text"])), pages, paper)][:MAX_HITS]
        if not hits:
            continue
        records = checked.get(c["id"], [])
        if any(item.get("prints") is True for item in records):
            printed.append(c["id"])
            continue
        open_hits = []
        for score, rel, page, snippet, terms in hits:
            ok = any(_norm(item.get("path")) == rel and page in _page_set(item.get("pages"))
                     and _words(item.get("found")) >= 3 for item in records)
            if not ok:
                open_hits.append("%s p. %d (%s: \"%s ...\")" % (rel, page, ", ".join(terms[:4]), snippet[:90]))
        if open_hits:
            unresolved.append("'%s' [%s]: %s" % (c["id"], c["text"][:80].strip(), "; ".join(open_hits)))
    if unresolved:
        out.append(("claims: the sources mention what these claims call not printed or not public; read each page "
                    "before keeping the claim: " + " | ".join(unresolved[:6])
                    + (" | and %d more" % (len(unresolved) - 6) if len(unresolved) > 6 else ""),
                    "read the pages; when they print it, use it (transcribe, apply the rule) and drop the claim; "
                    "otherwise record sources/SOURCE.json claimsChecked: {\"claim\": \"<id>\", \"sourcesChecked\": "
                    "[{\"path\": \"<file>\", \"pages\": \"4\", \"prints\": false, \"found\": \"<what the page says on "
                    "this point>\"}]}"))
    if printed:
        out.append(("claims: claimsChecked says a source prints what %s calls not printed" % ", ".join(printed[:6]),
                    "use what the source prints and remove the claim (failures.json, run.excluded, the issue or the "
                    "material status)"))
    return out


def problems(root):
    """[(message, fix)] for the analysis code, survey versions and researcher questions of a project folder."""
    root = Path(root).resolve()
    record = cm.source_record(root)
    record = record if isinstance(record, dict) else {}
    out = []
    for check in (check_analysis_code, check_survey_versions, check_questions, check_claims):
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
