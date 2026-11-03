#!/usr/bin/env python3
"""Check how the build handled participant materials the paper does not print.

    python .opencode/skills/build/check_materials.py .        [--json report.json]

Every material item the paper does not print in full carries `extensions.material` on its program field:

    {"kind": "schema-enough" | "needs-original",
     "what": "Study 4 instruction screens (both framings)",      the item, as the researcher would name it
     "mentioned": "SI p. 2, Study 4 procedure",                  where the paper mentions it
     "basis": "...",            schema-enough: the printed description the value follows
     "status": "pending" | "found-open" | "found-private" | "supplied" | "stand-in" | "left-out",
     "search": [{"where": "OSF project linked on p. 9", "url": "...", "found": false}],  places searched
     "provisional": "...",      pending with a decision issue: the labelled stand-in the adapter runs meanwhile
     "asked": "2026-11-03" | null,                               when the consolidated question was asked
     "answer": "the researcher's answer, in a few words",         supplied, stand-in, left-out
     "file": "sources/researcher/s4-instructions.txt"}            supplied and found-private

Rules (each a problem; PASS only without any):

  schema-enough   the study runs faithfully from a structure the paper describes (sequences drawn from a printed
                  distribution, counts, orders, key mappings, display format). Filled by the build: origin
                  `derived` (with `derivation`) or `implementation` (with `basis`), citing the evidence that
                  describes it, never `missing`, never under a blocking issue on the field. Never participant-visible
                  wording or media (instructions, questions, vignettes, screen or debriefing text, images, audio):
                  those are needs-original whatever the label says. Its value holds structure, not prose: at most
                  SHORT words (keys included) in phrases that no cited quote prints.
  needs-original  verbatim instrument text or stimuli that cannot be reconstructed. Never invented:
                  pending       state `missing`, no value, an issue on the field (blocking or decision) whose title
                                names `what`, so the status the researcher sees says what is needed; with a decision
                                issue the adapter may run a labelled stand-in meanwhile, described in `provisional`
                  found-open    origin `verbatim`, copied from a file under sources/open/ whose SOURCE.json entry
                                records url, license (open), licenseEvidence, linkedToPaper and version; the
                                value occurs in that file
                  found-private public but not openly licensed: the file stays in sources/private/ (same record,
                                license as stated), the program holds a reference, never the text
                  supplied      origin `researcher`, state confirmed; the text stays in `file` under
                                sources/researcher/ (recorded as `researcher-supplied`); the program holds a reference
                  stand-in      the researcher accepted a stand-in: origin `implementation`, the label says
                                "stand-in", `asked` and `answer` say when and what they accepted
                  left-out      the researcher chose to leave it out: state `missing`, no value, `asked`, `answer`,
                                a decision issue, and a capabilities.json run.excluded entry naming `what` (or
                                `field: node.field`)
  sources         every file under sources/open/ and sources/private/ (and every file a found-* item cites) is
                  recorded with url, license, linkedToPaper and version; no such file is participant data
                  (trial-level responses); SOURCE.json `searches` records where the build searched whenever a
                  needs-original item exists.
  unlabelled      a participant-material field filled by the build (origin derived or implementation) without
                  `extensions.material` must not hold prose either.
  private         text from sources/researcher/ and sources/private/ appears nowhere in program.json or package/;
                  the package reads the file at run time. Community and agent exports leave both folders out and
                  refuse to export (or, for artifacts/, omit the file) while that text appears in a published file.

In a program that uses `extensions.material` at all, an unclassified missing participant-material field and an
unclassified build-written one holding prose are problems; in an older program they are notes.
Standard library plus the PDF reader check_quotes.py uses.
"""
import argparse
import hashlib
import posixpath
import json
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

KINDS = ("schema-enough", "needs-original")
STATUSES = ("pending", "found-open", "found-private", "supplied", "stand-in", "left-out")
RESEARCHER_DIR = "sources/researcher"
PRIVATE_DIR = "sources/private"
OPEN_DIR = "sources/open"
PRIVATE_DIRS = (RESEARCHER_DIR, PRIVATE_DIR)
RESEARCHER_LICENSE = "researcher-supplied"
SHORT = 12          # words a schema-enough value may hold in phrases no cited quote prints
SHINGLE = 8         # words in a row that count as a copy of a private text
# Participant-visible wording and media: never reconstructed from a description.
WORDING = re.compile(
    r"instruction|wording|briefing|debrief|consent|cover.?story|screen.?text|text of|\btext\b|"
    r"question(?:naire)?s?\b|vignette|scenario|\bstory|stories|passage|narrative|\bscripts?\b|dialog|message|prompt|"
    r"statement|sentence|word.?list|\bwords\b|image|picture|photo|drawing|video|audio|sound|recording|\bfaces?\b|"
    r"verbatim|transcript|anchor|response.?option|answer.?option|feedback.?(?:text|message|screen|wording)|"
    r"\blabels?\b(?!.{0,12}\bkeys?\b)|caption|title.?screen|greeting|thank.?you|likert|scale.?(?:points|labels)|"
    r"\bwelcome|\bintro(?:duction)?\b|\bscreens?\b(?!.{0,20}(?:layout|order|position|size|count|number|timing|"
    r"duration|format|sequence))", re.I)
MATERIAL = re.compile(r"instruction|debrief|briefing|item|question|prompt|stimul|scenario|vignette|scale|script|screen|"
                      r"message|text|wording|consent|cover|sequence|trial.?list|material|lotter|image|picture|order|"
                      r"block|practice|display|feedback|distribution|range|pairing|break|layout", re.I)
# A license that lets anyone reuse the file: Creative Commons (any terms), public domain, common open licenses.
OPEN_LICENSE = re.compile(r"^(?:CC-BY(?:-(?:NC|ND|SA))*(?:-[1-4]\.0)?|CC0-1\.0|CC0|PDDL-1\.0|ODC-By-1\.0|ODbL-1\.0|MIT|"
                          r"Apache-2\.0|BSD-[23]-Clause|GPL-[23]\.0(?:-only|-or-later)?|LGPL-[23]\.[01](?:-only|-or-later)?|"
                          r"MPL-2\.0|Unlicense|public-domain)$", re.I)
NO_LICENSE = re.compile(r"\bno\s+(?:open\s+)?licen[cs]|not\s+(?:openly\s+)?licen[cs]|without\s+(?:an?\s+)?(?:open\s+)?licen[cs]|"
                        r"licen[cs]e\s*[:=-]?\s*(?:none|unknown|not\s+(?:stated|specified|given))|all\s+rights\s+reserved", re.I)
LICENSE_WORDS = re.compile(r"licen[cs]|creativecommons|\bcc[\s-]?(?:by|0)\b|public domain|\bmit\b|apache|\bgpl\b|"
                           r"\bbsd\b|unlicense", re.I)
# Participant responses rather than materials: file names, and column headers of tables.
DATA_EXT = {".csv", ".tsv", ".xlsx", ".xls", ".sav", ".dta", ".rds", ".rdata", ".feather", ".parquet", ".mat", ".zip",
            ".json", ".jsonl", ".txt", ".dat"}
DATA_NAME = re.compile(r"data|subj|sub-|participant|respon|raw|session|ppt|choices|behav|results|demograph", re.I)
DATA_COLUMNS = re.compile(r"^(?:subj(?:ect)?(?:_?id|_?nr|num|_?number)?|sub|participant(?:_?(?:id|nr|number))?|ppt|pp|pid|"
                          r"worker_?id|prolific_?id|rt|rt_?ms|reaction_?time|latency(?:_?ms)?|response(?:_?time|_?key)?|"
                          r"resp(?:_?key)?|choice|key_?press|keypress|accuracy|acc|age|gender|sex|session_?id|"
                          r"trial_?index|time_?elapsed)$", re.I)
TEXT_EXT = {".txt", ".md", ".json", ".jsonl", ".csv", ".tsv", ".html", ".htm", ".py", ".xml", ".yaml", ".yml", ".js",
            ".css", ".svg", ".log", ".r", ".rmd", ".qmd", ".ipynb", ".tex", ".bib", ".toml", ".ini", ".rtf", ".m"}
CJK = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]")


def _json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _dict(x):
    return x if isinstance(x, dict) else {}


def _list(x):
    return x if isinstance(x, list) else []


def _str(x):
    return x if isinstance(x, str) else ""


def words(text):
    """Words of a text; CJK characters count one word each (a clause in Chinese is not one 'word')."""
    out = []
    for w in re.findall(r"[^\W_]+", (text or "").lower()):
        out += list(w) if CJK.search(w) else [w]
    return out


def strings(value, keys=True):
    """Every string in a value, dictionary keys included."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            if keys and isinstance(k, str):
                yield k
            yield from strings(v, keys)
    elif isinstance(value, list):
        for v in value:
            yield from strings(v, keys)


def empty(value):
    return value is None or (isinstance(value, (str, list, dict)) and not (value.strip() if isinstance(value, str) else value))


def fields(program):
    for n in _list(program.get("nodes")):
        if isinstance(n, dict):
            for f in _list(n.get("fields")):
                if isinstance(f, dict):
                    yield n, f


def material_of(f):
    m = _dict(f.get("extensions")).get("material")
    return m if isinstance(m, dict) else None


def _value_keys(value):
    if isinstance(value, dict):
        return [k for k in value if isinstance(k, str)] + [k for v in value.values() for k in _value_keys(v)]
    if isinstance(value, list):
        return [k for v in value for k in _value_keys(v)]
    return []


def is_wording(f, m):
    """Whether the field (its id, label, `what`, or the keys of its value) names participant-visible wording."""
    names = [f.get("id"), f.get("label"), (m or {}).get("what")] + _value_keys(f.get("value"))
    return bool(WORDING.search(" ".join(_str(x).replace("_", " ") for x in names)))


LONG = 6            # letter words one string may hold, unquoted, before it reads as a sentence


def prose_words(value, quotes):
    """(words, first phrase) over the value's strings that no quote prints, counted in letter words (numbers do not
    count, so a printed or drawn sequence of values is structure). Single-word dictionary keys (field names) do not
    count; single-word values do, so an invented word list adds up. A single string of LONG or more words counts as
    prose on its own: the total is then raised above SHORT."""
    qwords = " " + " ".join(words(quotes)) + " "
    total, first, sentence = 0, "", False

    def walk(v, is_key=False):
        nonlocal total, first, sentence
        if isinstance(v, dict):
            for k, x in v.items():
                walk(k, True)
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, str):
            w = words(v)
            alpha = [x for x in w if re.search(r"[^\W\d_]", x)]
            if not alpha or (is_key and len(alpha) < 2) or " %s " % " ".join(w) in qwords:
                return
            total += len(alpha)
            first = first or " ".join(v.split())
            sentence = sentence or len(alpha) >= LONG
    walk(value)
    return (max(total, SHORT + 1) if sentence else total), first


def norm_rel(rel):
    rel = _str(rel).replace("\\", "/")
    if not rel:
        return ""
    rel = posixpath.normpath(rel)
    return "" if rel == "." else rel.lstrip("/")


def under(rel, folder):
    rel = norm_rel(rel).lower()
    return rel == folder or rel.startswith(folder + "/")


def researcher_rel(rel):
    return under(rel, RESEARCHER_DIR)


def private_rel(rel):
    return any(under(rel, d) for d in PRIVATE_DIRS)


def text_of(path):
    """Readable text of a file (text in UTF-8 or UTF-16, PDF, .docx, .pptx, .xlsx strings); '' when it has none."""
    path = Path(path)
    suffix = path.suffix.lower()
    try:
        if suffix == ".pdf":
            import check_quotes
            return "\n".join(check_quotes.Pdf(path).load() or [])
        if suffix in (".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods"):
            out = []
            with zipfile.ZipFile(path) as z:
                for name in z.namelist():
                    if name.endswith(".xml") and re.search(r"word/document|ppt/slides/|sharedStrings|content\.xml", name):
                        xml = z.read(name).decode("utf-8", "replace")
                        xml = re.sub(r"</(?:w:p|a:p|text:p|si|row)>", "\n", xml)   # paragraphs; runs join
                        out.append(re.sub(r"<[^>]+>", "", xml))
            return "\n".join(out)
        raw = path.read_bytes()
        if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
            return raw.decode("utf-16", "replace")
        if b"\x00" in raw[:4096]:
            return ""
        text = raw.decode("utf-8", "replace")
        if suffix in (".json", ".ipynb"):
            data = _json(path)
            if data is not None:
                return "\n".join(strings(data))
        if suffix in (".jsonl",):
            lines = []
            for line in text.splitlines():
                try:
                    lines += list(strings(json.loads(line)))
                except ValueError:
                    lines.append(line)
            return "\n".join(lines)
        if suffix in (".py", ".js", ".r", ".m"):
            return re.sub(r"\\[ntr]", " ", text)
        if suffix == ".rtf":
            return re.sub(r"\\[a-z]+-?\d* ?|[{}]", " ", text)
        if suffix in TEXT_EXT or not suffix or sum(c.isprintable() or c.isspace() for c in text[:2000]) > 0.95 * len(text[:2000]):
            return text
    except Exception:
        return ""
    return ""


def segments(text):
    return [s for s in re.split(r"\n+", text or "") if s.strip()]


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def private_files(root):
    root = Path(root)
    out = []
    for d in PRIVATE_DIRS:
        folder = root / d
        if folder.is_dir() and not folder.is_symlink():
            out += [p for p in folder.rglob("*") if p.is_file() and not p.name.startswith(".")]
    return sorted(out)


def researcher_files(root):
    folder = Path(root) / RESEARCHER_DIR
    if not folder.is_dir() or folder.is_symlink():
        return []
    return sorted(p for p in folder.rglob("*") if p.is_file() and not p.name.startswith("."))


def source_record(root):
    data = _json(Path(root) / "sources/SOURCE.json")
    return data if isinstance(data, dict) else {}


def private_paths(root):
    """Project-relative paths no export publishes: sources/researcher/**, sources/private/** and every file
    sources/SOURCE.json records with license `researcher-supplied` or `"private": true`."""
    root = Path(root)
    out = {p.relative_to(root).as_posix() for p in private_files(root)}
    for f in _list(source_record(root).get("files")):
        if isinstance(f, dict) and isinstance(f.get("path"), str) and (
                _str(f.get("license")).lower() == RESEARCHER_LICENSE or f.get("private") is True):
            out.add(norm_rel(f["path"]))
    return out


ENUMERATOR = re.compile(r"^\s*(?:[(\[]?(?:\d+|[a-z]|[ivx]+)[.)\]:]|\d+[,\t;]|[-*•]\s)\s*", re.I)


def items_of(text):
    """Lines of a text, with leading enumerators ("1.", "a)", "-", a CSV id column) removed, plus the cells of
    tabular lines, so an item copied without its number is still found."""
    out = []
    for seg in segments(text):
        out.append(ENUMERATOR.sub("", seg))
        if "\t" in seg or seg.count(",") >= 1 and len(seg) < 400:
            out += [c.strip().strip('"') for c in re.split(r"\t|,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)", seg)]
    return [x for x in out if x.strip()]


def shingles(text, size=SHINGLE):
    """Runs of `size` words; a line, item or table cell shorter than that (4+ words) counts whole, so a short scale
    item copied on its own is found too. (Items of 3 words or fewer are found only as part of a longer copy.)"""
    out = set()
    for seg in items_of(text) + [text or ""]:
        w = words(seg)
        if len(w) >= size:
            out |= {" ".join(w[i:i + size]) for i in range(len(w) - size + 1)}
        elif len(w) >= 4:
            out.add(" ".join(w))
    return out


def private_index(root):
    """({shingle: private file}, {sha256: private file}) over every private file."""
    texts, hashes = {}, {}
    root = Path(root)
    for rel in sorted(private_paths(root)):
        path = root / rel
        if path.is_file() and not path.is_symlink():
            hashes.setdefault(sha(path), rel)
            for s in shingles(text_of(path)):
                texts.setdefault(s, rel)
    return texts, hashes


def researcher_shingles(root):
    return private_index(root)[0]


def leaks(root, paths, known=None):
    """[(published path, private file, words)] for every file in `paths` (absolute or project-relative) that is a
    private file (same bytes) or holds a run of SHINGLE words (or a whole short line) of a private text."""
    root = Path(root)
    texts, hashes = known if isinstance(known, tuple) else (known, {}) if known is not None else private_index(root)
    if not texts and not hashes:
        return []
    sizes = sorted({len(s.split()) for s in texts}, reverse=True)
    out = []
    for p in paths:
        path = Path(p) if Path(p).is_absolute() else root / p
        if not path.is_file() or path.is_symlink():
            continue
        try:
            shown = path.relative_to(root).as_posix()
        except ValueError:
            shown = str(p)
        digest = sha(path)
        if digest in hashes:
            out.append((shown, hashes[digest], "(an identical copy of the file)"))
            continue
        text = text_of(path)
        hit = None
        for seg in segments(text) + [text]:
            w = words(seg)
            for size in sizes:
                for i in range(max(0, len(w) - size + 1)):
                    s = " ".join(w[i:i + size])
                    if s in texts:
                        hit = (s, texts[s])
                        break
                if hit:
                    break
            if hit:
                break
        if hit:
            out.append((shown, hit[1], hit[0]))
    return out


def gate_files(root):
    """What the readiness gate scans for private text: program.json and package/ (exports scan more)."""
    root = Path(root)
    out = [root / "program.json"]
    folder = root / "package"
    if folder.is_dir() and not folder.is_symlink():
        out += sorted(p for p in folder.rglob("*") if p.is_file() and "__pycache__" not in p.parts)
    return out


published_files = gate_files


def _keys(data, depth=0):
    out = set()
    if depth > 3:
        return out
    if isinstance(data, dict):
        out |= {k for k in data if isinstance(k, str)}
        for v in list(data.values())[:20]:
            out |= _keys(v, depth + 1)
    elif isinstance(data, list):
        for v in data[:20]:
            out |= _keys(v, depth + 1)
    return out


def looks_like_data(path):
    """Why a file looks like participant data (trial-level responses), or ''."""
    path = Path(path)
    if path.suffix.lower() in DATA_EXT and DATA_NAME.search(path.name):
        return "its name"
    if not path.is_file():
        return ""
    suffix = path.suffix.lower()
    cols = []
    try:
        if suffix in (".csv", ".tsv", ".txt", ".dat"):
            head = path.read_text(encoding="utf-8", errors="replace").splitlines()[:1]
            cols = [c.strip().strip('"').strip("'") for c in re.split(r"[,\t;]", head[0])] if head else []
        elif suffix == ".json":
            cols = sorted(_keys(_json(path)))
        elif suffix == ".jsonl":
            with open(path, encoding="utf-8", errors="replace") as fh:
                for line in [next(fh, "") for _ in range(5)]:
                    try:
                        cols += sorted(_keys(json.loads(line)))
                    except ValueError:
                        pass
        elif suffix in (".xlsx", ".ods"):
            text = text_of(path)
            cols = [c.strip() for c in re.split(r"[\n\t]", text[:4000])]
    except (OSError, ValueError):
        return ""
    hits = sorted({c for c in cols if DATA_COLUMNS.match(c)})
    if len(hits) >= 2:
        return "its columns (%s)" % ", ".join(hits[:4])
    return ""


def what_in(what, title):
    want = set(words(what))
    return bool(want) and want <= set(words(title))


def check(root):
    root = Path(root).resolve()
    program = _json(root / "program.json")
    if not isinstance(program, dict):
        return {"problems": [("program.json is missing or not JSON", "")], "notes": [], "items": []}
    problems, notes, items = [], [], []
    add = lambda msg, fix="": problems.append((msg, fix))
    evidence = {e.get("id"): e for e in _list(program.get("evidence")) if isinstance(e, dict) and isinstance(e.get("id"), str)}
    issues = [i for i in _list(program.get("issues")) if isinstance(i, dict)]
    record = source_record(root)
    recorded = {norm_rel(f.get("path")): f for f in _list(record.get("files")) if isinstance(f, dict) and isinstance(f.get("path"), str)}
    caps = _json(root / "capabilities.json")
    excluded = [x for x in _list(_dict(_dict(caps).get("run")).get("excluded")) if isinstance(x, dict)]
    paper = "paper.pdf" if (root / "paper.pdf").is_file() else (_str(_dict(program.get("source")).get("filename")) or "paper.pdf")
    external = set()      # files whose provenance must be recorded (url, license, link to the paper, version)
    any_original = False
    # A program built under this rule classifies every material; in an older program an unclassified one is a note.
    adopted = any(material_of(f) is not None for _, f in fields(program))
    flag = (lambda msg, fix="": problems.append((msg, fix))) if adopted else (lambda msg, fix="": notes.append(msg))

    for n, f in fields(program):
        where = "%s.%s" % (n.get("id"), f.get("id"))
        m = material_of(f)
        ev_ids = [e for e in _list(f.get("evidenceIds")) if isinstance(e, str)]
        cited = [evidence[e] for e in ev_ids if e in evidence]
        quotes = " ".join(_str(e.get("quote")) for e in cited)
        material_like = n.get("kind") in ("material", "materials") or bool(MATERIAL.search("%s %s" % (f.get("id"), f.get("label"))))
        for e in cited:
            rel = norm_rel(e.get("path"))
            if under(rel, "human-data") and (m is not None or material_like or f.get("origin") in ("derived", "implementation")):
                add("%s cites %s: participant data never feeds the study's materials or design" % (where, rel),
                    "cite the paper or a materials file; human data are only for comparing results (Human data)")
                continue
            if rel and rel != paper and (root / rel).is_file() and (m is not None or material_like):
                why = "it is in human-data/" if under(rel, "human-data") else looks_like_data(root / rel)
                if why:
                    add("%s cites %s, which looks like participant data (%s)" % (where, rel, why),
                        "never take materials or sequences from participant data; use the stimulus or instruction "
                        "files, or ask the researcher")
        if m is None:
            if material_like and f.get("state") == "missing":
                flag("%s: missing participant material without extensions.material; classify it as "
                     "schema-enough or needs-original (build skill, 'Materials the paper does not print')" % where,
                     "add extensions.material; a gap that is not a material (an assignment rule) needs none: name "
                     "it so (e.g. id 'assignment-rule')")
            elif f.get("state") != "missing" and f.get("origin") in ("derived", "implementation", "unknown", "researcher") \
                    and (is_wording(f, None) or (material_like and n.get("kind") in ("material", "materials"))):
                prose = prose_words(f.get("value"), quotes)
                # disclosed for the researcher's decision (a stand-in or prompt wording the build wrote, under a decision
                # issue): an older program's way of labelling it; still a note, not a pass
                legacy_standin = f.get("state") == "decision" or (
                    re.search(r"stand.?in", "%s %s" % (f.get("id"), f.get("label")), re.I) and any(
                        i.get("severity") == "decision" and i.get("nodeId") == n.get("id") for i in issues))
                # Participant wording that the build wrote, or that claims a source it does not show, fails in every
                # program; other unclassified material prose is a note in older programs.
                on_material = n.get("kind") in ("material", "materials", "procedure")
                report = add if is_wording(f, None) and on_material and not legacy_standin else flag
                if prose[0] > SHORT:
                    report("%s: participant material with no source (origin %s, %d words no cited quote prints): \"%s...\""
                        % (where, f.get("origin"), prose[0], prose[1][:80]),
                        "classify it (extensions.material): structure the paper describes is schema-enough; text "
                        "participants read is needs-original and comes from an open source or the researcher")
            continue
        kind, what = m.get("kind"), _str(m.get("what")).strip()
        status = m.get("status") if kind == "needs-original" else "filled"
        items.append({"field": where, "kind": kind, "what": what, "status": status})
        mine = [i for i in issues if i.get("nodeId") == n.get("id") and i.get("fieldId") == f.get("id")]
        if kind not in KINDS:
            add("%s: extensions.material.kind must be schema-enough or needs-original" % where, "")
            continue
        if not what:
            add("%s: extensions.material.what is empty" % where,
                "name the item as the researcher would (\"Study 4 instruction screens, both framings\")")

        if kind == "schema-enough":
            if is_wording(f, m):
                add("%s: participant-visible wording or media is never schema-enough (%s)" % (where, what or f.get("label")),
                    "make it needs-original: search open sources, then ask the researcher; never write the words yourself")
            told = f.get("origin") == "researcher"   # the researcher answered a structural question in words
            if told and (not _str(m.get("asked")).strip() or not _str(m.get("answer")).strip()):
                add("%s: a structure the researcher stated needs extensions.material.asked and answer" % where, "")
            if f.get("origin") not in ("derived", "implementation", "researcher"):
                add("%s: a schema-enough value is filled from the paper's description (derived or implementation) or "
                    "from the researcher's answer (researcher), not %r" % (where, f.get("origin")),
                    "verbatim and reported are for printed text and printed facts")
            if f.get("origin") == "implementation" and not _str(m.get("basis")).strip():
                add("%s: schema-enough implementation needs extensions.material.basis" % where,
                    "say which printed description the value follows (with its page)")
            if f.get("state") == "missing" or empty(f.get("value")):
                add("%s: schema-enough means the build fills it from the paper's description; it has no value" % where,
                    "fill it from the cited description, or classify it needs-original if the description is not enough")
            if not quotes.strip() and not told:
                add("%s: schema-enough needs the evidence that describes the structure" % where,
                    "cite the passage that prints the distribution, count, order or mapping the value follows")
            prose = prose_words(f.get("value"), quotes)   # the researcher's answer is not a quote: it stays short
            if prose[0] > SHORT:
                add("%s: a schema-enough value holds prose (%d words in phrases no cited quote prints): \"%s...\""
                    % (where, prose[0], prose[1][:80]),
                    "a structure is numbers, counts, orders, key names or short labels; text participants read is "
                    "needs-original")
            for i in mine:
                if i.get("severity") == "blocking":
                    add("%s: issue %s blocks a schema-enough item" % (where, i.get("id")),
                        "schema-enough items do not block; if the paper's description is not enough to run it, it is "
                        "needs-original")
            continue

        # needs-original
        any_original = True
        if status not in STATUSES:
            add("%s: extensions.material.status must be one of %s" % (where, ", ".join(STATUSES)), "")
            continue
        if not _str(m.get("mentioned")).strip():
            add("%s: extensions.material.mentioned is empty" % where,
                "say where the paper mentions the item (page and section), so the researcher can find it")
        search = m.get("search")
        if not isinstance(search, list) or not search or any(
                not isinstance(s, dict) or not _str(s.get("where")).strip() for s in search):
            add("%s: extensions.material.search must list where it was searched ({where, url, found})" % where,
                "search the availability statement and its links, the SI page, OSF, the authors' repositories, "
                "preprint and task-hosting pages before asking (build skill)")
            search = [s for s in _list(search) if isinstance(s, dict)]
        prose = prose_words(f.get("value"), "")
        answered = status in ("supplied", "stand-in", "left-out")
        if answered and (not _str(m.get("asked")).strip() or not _str(m.get("answer")).strip()):
            add("%s: status %s is the researcher's answer: extensions.material.asked (the date) and answer are required"
                % (where, status), "until the researcher answers, the item stays pending")

        if status in ("pending", "left-out"):
            if f.get("state") != "missing" or not empty(f.get("value")):
                add("%s: %s needs the original and has none yet: state missing and no value (%s)"
                    % (where, what, "left out by the researcher" if status == "left-out" else "pending"),
                    "never fill it with your own wording")
            if f.get("origin") in ("verbatim", "reported", "researcher"):
                add("%s: origin %s claims a source the item does not have" % (where, f.get("origin")),
                    "origin unknown, state missing")
        if status == "pending":
            titled = [i for i in mine if i.get("severity") in ("blocking", "decision")]
            if not _str(m.get("asked")).strip():
                notes.append("%s: %s has not been asked about yet; ask in the one consolidated materials question"
                             % (where, what))
            if not titled:
                add("%s: pending needs-original item has no blocking or decision issue on this field" % where,
                    "add one whose title says what is needed, e.g. \"Needs the original %s\"" % (what or "materials"))
            elif what and not any(what_in(what, _str(i.get("title"))) for i in titled):
                add("%s: no issue title on this item names what is needed (%s)" % (where, what),
                    "the researcher sees the issue title as the status: put the item's `what` in it")
            if any(i.get("severity") == "decision" for i in titled) and not any(i.get("severity") == "blocking" for i in titled) \
                    and not _str(m.get("provisional")).strip():
                add("%s: a pending item under a decision issue runs with a stand-in: describe it in "
                    "extensions.material.provisional" % where,
                    "say what the adapter shows meanwhile (labelled as a stand-in); or make the issue blocking and let "
                    "the arms that need it refuse to run")
            if any(s.get("found") for s in search):
                add("%s: pending, but a search entry says it was found" % where,
                    "use the found source (found-open or found-private), or correct the search record")
        if status == "left-out":
            if not any(i.get("severity") == "decision" for i in mine):
                add("%s: left out by the researcher needs a decision issue (\"Left out by the researcher: %s\")"
                    % (where, what), "")
            if not any(x.get("field") == where or (what and what.lower() in _str(x.get("what")).lower()) for x in excluded):
                add("%s: left out by the researcher, but capabilities.json run.excluded does not name it" % where,
                    'add {"what": "%s", "field": "%s", "reason": "left out by the researcher", "arms": [...]}'
                    % (what, where))
        if status == "stand-in":
            if f.get("origin") != "implementation":
                add("%s: an accepted stand-in is origin implementation, not %r" % (where, f.get("origin")), "")
            if not re.search(r"stand.?in", _str(f.get("label")), re.I):
                add("%s: an accepted stand-in says so in its label (\"... (stand-in accepted by the researcher)\")"
                    % where, "")
        if status in ("supplied", "found-private"):
            rel = norm_rel(m.get("file"))
            folder = RESEARCHER_DIR if status == "supplied" else PRIVATE_DIR
            if status == "supplied" and f.get("origin") != "researcher":
                add("%s: researcher-supplied material is origin researcher, not %r" % (where, f.get("origin")), "")
            if status == "found-private" and f.get("origin") not in ("verbatim", "unknown"):
                add("%s: material from a source without an open license is origin verbatim (a reference to the file)"
                    % where, "")
            if f.get("state") != "confirmed":
                add("%s: %s material is state confirmed" % (where, status), "")
            if not under(rel, folder) or not (root / rel).is_file():
                add("%s: %s material must be a file under %s/ (got %r)" % (where, status, folder, rel),
                    "save it there and name it in extensions.material.file")
            elif status == "supplied" and _str(_dict(recorded.get(rel)).get("license")) != RESEARCHER_LICENSE:
                add("%s: sources/SOURCE.json does not record %s as %s" % (where, rel, RESEARCHER_LICENSE),
                    "run the build skill's sources.py (it records files under %s/ that way)" % RESEARCHER_DIR)
            elif status == "found-private":
                external.add(rel)
                url = norm_rel(_dict(recorded.get(rel)).get("url"))
                if not any(s.get("found") and s.get("url") and norm_rel(s.get("url")) == url for s in search):
                    add("%s: found-private needs the search entry it was found in (where, url of the file, found: true)"
                        % where, "")
            if prose[0] > SHORT:
                add("%s: the program holds the material's text (%d words); keep it only in %s"
                    % (where, prose[0], rel or folder + "/"),
                    'the value is a reference ({"file": "%s"}); the package reads the file at run time'
                    % (rel or folder + "/<name>"))
        if status == "found-open":
            if f.get("origin") != "verbatim":
                add("%s: material found in an open source is transcribed verbatim (origin verbatim)" % where, "")
            paths = [norm_rel(e.get("path")) or paper for e in cited]
            if not paths:
                add("%s: cite the evidence in the open source it was copied from" % where, "")
            for rel in paths:
                if not under(rel, OPEN_DIR):
                    add("%s: found-open evidence must come from the file saved under %s/ (got %s)" % (where, OPEN_DIR, rel),
                        "save the openly licensed file under %s/ and cite it" % OPEN_DIR)
                    continue
                external.add(rel)
                text = " ".join(words(text_of(root / rel)))
                padded = " %s " % text
                keys = set(_value_keys(f.get("value")))
                missing_text = [s for s in strings(f.get("value")) if any(re.search(r"[^\W\d_]", x) for x in words(s))
                                and not (s in keys and len(words(s)) < 2) and " %s " % " ".join(words(s)) not in padded]
                if not text or missing_text:
                    add("%s: the transcribed value does not occur in %s%s" % (
                        where, rel, " (no readable text)" if not text else ": \"%s...\"" % missing_text[0][:60]),
                        "copy the words exactly from the file (save a text copy when the original is not readable)")
            urls = {norm_rel(_dict(recorded.get(r)).get("url")) for r in paths}
            if not any(s.get("found") and s.get("url") and norm_rel(s.get("url")) in urls for s in search):
                add("%s: found-open needs the search entry it was found in (where, url of the file, found: true)" % where, "")

    # external sources: provenance and no participant data
    for p in sorted(Path(root / OPEN_DIR).rglob("*")) if (root / OPEN_DIR).is_dir() else []:
        if p.is_file() and not p.name.startswith("."):
            external.add(p.relative_to(root).as_posix())
    for p in sorted(Path(root / PRIVATE_DIR).rglob("*")) if (root / PRIVATE_DIR).is_dir() else []:
        if p.is_file() and not p.name.startswith("."):
            external.add(p.relative_to(root).as_posix())
    # participant data anywhere under sources/ (it belongs in human-data/, and never feeds the materials)
    for p in sorted((root / "sources").rglob("*")) if (root / "sources").is_dir() else []:
        rel = p.relative_to(root).as_posix()
        if p.is_file() and rel not in external and not private_rel(rel) and rel != "sources/SOURCE.json":
            why = looks_like_data(p)
            if why:
                flag("%s looks like participant data (%s): keep human data in human-data/, never under sources/"
                     % (rel, why), "move it to human-data/ (never published) or delete it")
    for rel in sorted(external):
        entry = _dict(recorded.get(rel))
        missing_keys = [k for k in ("url", "license", "linkedToPaper", "version") if not _str(entry.get(k)).strip()]
        if not entry:
            add("sources/SOURCE.json does not record %s" % rel, "run the build skill's sources.py with --url, "
                "--linked and --source-version for it")
            continue
        if missing_keys:
            add("sources/SOURCE.json: %s lacks %s" % (rel, ", ".join(missing_keys)),
                "record where it was downloaded (url), its license as stated, how it is tied to this paper "
                "(linkedToPaper: DOI, title or author match, or the link it was found through) and which version it is")
        lic = _str(entry.get("license"))
        lic_ev = _str(entry.get("licenseEvidence"))
        if under(rel, OPEN_DIR) and (not OPEN_LICENSE.match(lic) or not LICENSE_WORDS.search(lic_ev) or NO_LICENSE.search(lic_ev)):
            add("sources/SOURCE.json: %s is under %s/ without an open license and where it is stated (license %s)"
                % (rel, OPEN_DIR, lic or "none"),
                "record the license and the words or page that state it (--license, --license-evidence); a file "
                "without an open license goes to %s/ and is used only in this project" % PRIVATE_DIR)
        why = looks_like_data(root / rel)
        if why:
            add("%s looks like participant data (%s): never download trial-level responses" % (rel, why),
                "delete it; when the sequences participants saw exist only in data files, ask the researcher")
    if any_original and not [s for s in _list(record.get("searches")) if isinstance(s, dict) and _str(s.get("where")).strip()]:
        add("sources/SOURCE.json records no `searches`, although materials are missing",
            'record each place searched: {"where": "OSF search by DOI", "query": "...", "url": "...", "date": "...", '
            '"result": "found ... / nothing"} (sources.py keeps the key)')

    # researcher and private files stay out of everything that can be published
    for rel in sorted(p.relative_to(root).as_posix() for p in researcher_files(root)):
        if _str(_dict(recorded.get(rel)).get("license")) != RESEARCHER_LICENSE:
            add("sources/SOURCE.json does not record %s as %s" % (rel, RESEARCHER_LICENSE), "run the build skill's sources.py")
    for p in private_files(root):
        rel = p.relative_to(root).as_posix()
        if not text_of(p).strip() and not any(q != p and q.stem == p.stem and text_of(q).strip()
                                              for q in p.parent.glob(p.stem + ".*")):
            flag("%s has no readable text, so no check can see whether it is copied elsewhere" % rel,
                 "save a text copy beside it (%s.txt) with its words as supplied" % Path(rel).with_suffix(""))
    for shown, src, text in leaks(root, gate_files(root)):
        add("%s copies the private material %s (\"%s ...\")" % (shown, src, text[:60]),
            "keep researcher-supplied and not-openly-licensed materials only in %s/ or %s/; reference the file "
            "(the package reads it at run time)" % PRIVATE_DIRS)
    return {"problems": problems, "notes": notes, "items": items}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--json", help="write the report here")
    a = ap.parse_args(argv)
    report = check(a.root)
    if a.json:
        Path(a.json).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for msg, fix in report["problems"]:
        print("PROBLEM %s" % msg + ("\n        fix: %s" % fix if fix else ""))
    for line in report["notes"]:
        print("note    " + line)
    counts = {}
    for it in report["items"]:
        key = it["kind"] if it["kind"] == "schema-enough" else "needs-original/%s" % it["status"]
        counts[key] = counts.get(key, 0) + 1
    if counts:
        print("items   " + ", ".join("%s %d" % kv for kv in sorted(counts.items())))
    if report["problems"]:
        print("FAIL %d materials problem(s)" % len(report["problems"]))
        return 1
    print("PASS materials")
    return 0


if __name__ == "__main__":
    sys.exit(main())
