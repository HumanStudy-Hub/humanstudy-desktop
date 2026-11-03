#!/usr/bin/env python3
"""Check how the build handled participant materials the paper does not print.

    python .opencode/skills/build/check_materials.py .        [--json report.json]

Every material item the paper does not print in full carries `extensions.material` on its program field:

    {"kind": "schema-enough" | "needs-original",
     "what": "Study 4 instruction screens (both framings)",      the item, as the researcher would name it
     "mentioned": "SI p. 2, Study 4 procedure",                  where the paper mentions it
     "basis": "...",            schema-enough: the printed description the value follows
     "status": "pending" | "found-open" | "supplied" | "stand-in" | "left-out",   needs-original only
     "search": [{"where": "SI appendix (OSF)", "url": "...", "found": false}],   open places looked in
     "asked": "2026-11-03" | null,                               when the consolidated question was asked
     "answer": "the researcher's answer, in a few words",         for stand-in and left-out
     "file": "sources/researcher/s4-instructions.txt"}            for supplied

Rules (each a problem; PASS only without any):

  schema-enough   the study runs faithfully from a structure the paper describes (sequences drawn from a printed
                  distribution, counts, orders, key mappings, display format). The field is filled by the build:
                  origin `derived` (with `derivation`) or `implementation` (with `basis`), citing the evidence that
                  describes it, never `missing`, never on a blocking issue. It is never participant-visible wording
                  (instructions, items, vignettes, screen or debriefing text, images, audio): those are
                  needs-original whatever the label says. Its value holds structure, not prose: a string of more
                  than SHORT words must be copied from a cited quote.
  needs-original  verbatim instrument text or stimuli that cannot be reconstructed. Never invented:
                  pending     state `missing`, no value, an issue on the field (blocking or decision) whose title
                              names `what`, so the status the researcher sees says what is needed
                  found-open  origin `verbatim`, evidence from a file under sources/ that sources/SOURCE.json
                              records with an open license and its evidence; never participant data
                  supplied    origin `researcher`; the text stays in `file` under sources/researcher/ (recorded
                              with license `researcher-supplied`); the program holds a reference, not the text
                  stand-in    the researcher accepted a stand-in: origin `implementation`, labelled "stand-in",
                              `answer` says what they accepted
                  left-out    the researcher chose to leave it out: state `missing`, no value, `answer`, and a
                              capabilities.json run.excluded entry naming `what` (or `field: node.field`)
  researcher      text from files under sources/researcher/ (materials the researcher supplied, which stay in
                  the researcher's project) appears nowhere in program.json, package/ or artifacts/; the
                  package reads the file at run time. Community and agent exports leave the folder out
                  and refuse to export while that text appears in a published file.

Notes (not problems): a missing participant-material field without `extensions.material` (classify it).
Standard library plus the PDF reader check_quotes.py uses.
"""
import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

KINDS = ("schema-enough", "needs-original")
STATUSES = ("pending", "found-open", "supplied", "stand-in", "left-out")
RESEARCHER_DIR = "sources/researcher"
RESEARCHER_LICENSE = "researcher-supplied"
SHORT = 12          # letter words a schema-enough value may hold in phrases no cited quote prints
SHINGLE = 8         # words in a row that count as a copy of a researcher-supplied text
# Participant-visible wording and media: never reconstructed from a description.
WORDING = re.compile(
    r"instruction|wording|briefing|debrief|consent|cover.?story|screen.?text|text of|\btext\b|\bitems?\b|"
    r"question(?:naire)?s?\b|vignette|scenario|\bstory|stories|passage|narrative|script|dialog|message|prompt|"
    r"statement|sentence|word.?list|image|picture|photo|drawing|figure|video|audio|sound|recording|\bfaces?\b|"
    r"verbatim|transcript|\blabels?\b", re.I)
MATERIAL = re.compile(r"instruction|debrief|briefing|item|question|prompt|stimul|scenario|vignette|scale|script|screen|"
                      r"message|text|wording|consent|cover|sequence|trial.?list|material|lotter|image|picture", re.I)
# A license that lets anyone use the file: Creative Commons (any terms), public domain, common open source licenses.
OPEN_LICENSE = re.compile(r"^(?:CC-BY(?:-(?:NC|ND|SA))*(?:-[1-4]\.0)?|CC0-1\.0|CC0|PDDL-1\.0|ODC-By-1\.0|ODbL-1\.0|MIT|"
                          r"Apache-2\.0|BSD-[23]-Clause|GPL-[23]\.0(?:-only|-or-later)?|LGPL-[23]\.[01](?:-only|-or-later)?|"
                          r"MPL-2\.0|Unlicense|public-domain)$", re.I)
# File names that look like participant responses rather than materials.
DATA_EXT = {".csv", ".tsv", ".xlsx", ".xls", ".sav", ".dta", ".rds", ".rdata", ".feather", ".parquet", ".mat", ".zip"}
DATA_NAME = re.compile(r"data|subj|sub-|participant|respon|raw|session|ppt|choices|behav|trialdata|results", re.I)
TEXT_EXT = {".txt", ".md", ".json", ".csv", ".tsv", ".html", ".htm", ".py", ".xml", ".yaml", ".yml", ".js", ".css", ".svg"}


def _json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def words(text):
    return re.findall(r"[^\W_]+", (text or "").lower())


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from strings(v)


def empty(value):
    return value is None or (isinstance(value, (str, list, dict)) and not (value.strip() if isinstance(value, str) else value))


def fields(program):
    for n in program.get("nodes") or []:
        if isinstance(n, dict):
            for f in n.get("fields") or []:
                if isinstance(f, dict):
                    yield n, f


def material_of(f):
    ext = f.get("extensions") if isinstance(f.get("extensions"), dict) else {}
    m = ext.get("material")
    return m if isinstance(m, dict) else None


def prose_words(value, quotes):
    """(letter words, first phrase) over the value's phrases of 4+ letter words that no quote prints. Numbers do not
    count, so a printed or drawn sequence of values is structure, not prose."""
    qwords = " " + " ".join(words(quotes)) + " "
    total, first = 0, ""
    for s in strings(value):
        alpha = [w for w in words(s) if re.search(r"[^\W\d_]", w)]
        if len(alpha) >= 4 and " %s " % " ".join(words(s)) not in qwords:
            total += len(alpha)
            first = first or " ".join(s.split())
    return total, first


def is_wording(n, f, m):
    return bool(WORDING.search(" ".join(str(x) for x in (f.get("id"), f.get("label"), (m or {}).get("what")) if x)))


def researcher_rel(rel):
    rel = str(rel or "").replace("\\", "/").lstrip("./")
    return rel == RESEARCHER_DIR or rel.startswith(RESEARCHER_DIR + "/")


def text_of(path):
    """Readable text of a supplied file (text, PDF, .docx); '' when it has none we can read."""
    path = Path(path)
    suffix = path.suffix.lower()
    try:
        if suffix == ".pdf":
            import check_quotes
            return "\n".join(check_quotes.Pdf(path).load() or [])
        if suffix == ".docx":
            with zipfile.ZipFile(path) as z:
                return re.sub(r"<[^>]+>", " ", z.read("word/document.xml").decode("utf-8", "replace"))
        if suffix == ".json":
            data = _json(path)
            return "\n".join(strings(data)) if data is not None else path.read_text(encoding="utf-8", errors="replace")
        if suffix in TEXT_EXT or not suffix:
            return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""
    return ""


def researcher_files(root):
    folder = Path(root) / RESEARCHER_DIR
    if not folder.is_dir() or folder.is_symlink():
        return []
    return sorted(p for p in folder.rglob("*") if p.is_file() and not p.name.startswith("."))


def private_paths(root):
    """Project-relative paths that are the researcher's own materials: sources/researcher/** and every file
    sources/SOURCE.json records with license `researcher-supplied`."""
    root = Path(root)
    out = {p.relative_to(root).as_posix() for p in researcher_files(root)}
    record = _json(root / "sources/SOURCE.json") or {}
    for f in record.get("files") or []:
        if isinstance(f, dict) and str(f.get("license") or "").lower() == RESEARCHER_LICENSE and f.get("path"):
            out.add(str(f["path"]))
    return out


def shingles(text, size=SHINGLE):
    w = words(text)
    if len(w) < size:
        return {" ".join(w)} if len(w) >= 4 else set()
    return {" ".join(w[i:i + size]) for i in range(len(w) - size + 1)}


def researcher_shingles(root):
    """{shingle: source file} over every researcher-supplied text."""
    out = {}
    root = Path(root)
    for rel in sorted(private_paths(root)):
        path = root / rel
        if path.is_file() and not path.is_symlink():
            for s in shingles(text_of(path)):
                out.setdefault(s, rel)
    return out


def published_text(path):
    suffix = path.suffix.lower()
    if suffix == ".json":
        data = _json(path)
        if data is not None:
            return "\n".join(strings(data))
    if suffix in TEXT_EXT:
        text = path.read_text(encoding="utf-8", errors="replace")
        return re.sub(r"\\[ntr]", " ", text) if suffix in (".py", ".js") else text
    if suffix in (".pdf", ".docx"):
        return text_of(path)
    return ""


def leaks(root, paths, known=None):
    """[(published path, researcher file, words)] for every file in `paths` (absolute or project-relative) that
    holds a run of SHINGLE words from a researcher-supplied text."""
    root = Path(root)
    known = researcher_shingles(root) if known is None else known
    if not known:
        return []
    out = []
    for p in paths:
        path = Path(p) if Path(p).is_absolute() else root / p
        if not path.is_file() or path.is_symlink():
            continue
        text = published_text(path)
        if not text:
            continue
        sizes = {len(s.split()) for s in known}
        hit = None
        w = words(text)
        for size in sorted(sizes, reverse=True):
            for i in range(max(0, len(w) - size + 1)):
                s = " ".join(w[i:i + size])
                if s in known:
                    hit = (s, known[s])
                    break
            if hit:
                break
        if hit:
            try:
                shown = path.relative_to(root).as_posix()
            except ValueError:
                shown = str(p)
            out.append((shown, hit[1], hit[0]))
    return out


def published_files(root):
    """What the program's exports carry from the project: program.json, package/, artifacts/."""
    root = Path(root)
    out = [root / "program.json"]
    for top in ("package", "artifacts"):
        folder = root / top
        if folder.is_dir() and not folder.is_symlink():
            out += sorted(p for p in folder.rglob("*") if p.is_file() and "__pycache__" not in p.parts)
    return out


def check(root):
    root = Path(root).resolve()
    program = _json(root / "program.json")
    if not isinstance(program, dict):
        return {"problems": [("program.json is missing or not JSON", "")], "notes": [], "items": []}
    problems, notes, items = [], [], []
    add = lambda msg, fix="": problems.append((msg, fix))
    evidence = {e.get("id"): e for e in program.get("evidence") or [] if isinstance(e, dict)}
    issues = [i for i in program.get("issues") or [] if isinstance(i, dict)]
    record = _json(root / "sources/SOURCE.json") or {}
    recorded = {f.get("path"): f for f in record.get("files") or [] if isinstance(f, dict)}
    caps = _json(root / "capabilities.json")
    excluded = ((caps or {}).get("run") or {}).get("excluded") or [] if isinstance(caps, dict) else []
    paper = "paper.pdf" if (root / "paper.pdf").is_file() else ((program.get("source") or {}).get("filename") or "paper.pdf")

    for n, f in fields(program):
        where = "%s.%s" % (n.get("id"), f.get("id"))
        m = material_of(f)
        if m is None:
            if f.get("state") == "missing" and (n.get("kind") in ("material", "materials") or
                                                MATERIAL.search("%s %s" % (f.get("id"), f.get("label")))):
                notes.append("%s: missing participant material without extensions.material; classify it as "
                             "schema-enough or needs-original (build skill, 'Materials the paper does not print')" % where)
            continue
        kind, what = m.get("kind"), str(m.get("what") or "").strip()
        status = m.get("status") if kind == "needs-original" else "filled"
        items.append({"field": where, "kind": kind, "what": what, "status": status})
        mine = [i for i in issues if i.get("nodeId") == n.get("id") and i.get("fieldId") in (f.get("id"), None, "")]
        if kind not in KINDS:
            add("%s: extensions.material.kind must be schema-enough or needs-original" % where, "")
            continue
        if not what:
            add("%s: extensions.material.what is empty" % where,
                "name the item as the researcher would (\"Study 4 instruction screens, both framings\")")
        cited = [evidence[e] for e in f.get("evidenceIds") or [] if e in evidence]
        quotes = " ".join(str(e.get("quote") or "") for e in cited)

        if kind == "schema-enough":
            if is_wording(n, f, m):
                add("%s: participant-visible wording or media is never schema-enough (%s)" % (where, what or f.get("label")),
                    "make it needs-original: look in licensed open sources, then ask the researcher; never write the "
                    "words yourself")
            if f.get("origin") not in ("derived", "implementation"):
                add("%s: a schema-enough value is filled by the build: origin derived or implementation, not %r"
                    % (where, f.get("origin")), "verbatim and reported are for printed text and printed facts")
            if f.get("origin") == "implementation" and not str(m.get("basis") or "").strip():
                add("%s: schema-enough implementation needs extensions.material.basis" % where,
                    "say which printed description the value follows (with its page)")
            if f.get("state") == "missing" or empty(f.get("value")):
                add("%s: schema-enough means the build fills it from the paper's description; it has no value" % where,
                    "fill it from the cited description, or classify it needs-original if the description is not enough")
            if not any(str(e.get("quote") or "").strip() for e in cited):
                add("%s: schema-enough needs the evidence that describes the structure" % where,
                    "cite the passage that prints the distribution, count, order or mapping the value follows")
            prose = prose_words(f.get("value"), quotes)
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
        if status not in STATUSES:
            add("%s: extensions.material.status must be one of %s" % (where, ", ".join(STATUSES)), "")
            continue
        if not str(m.get("mentioned") or "").strip():
            add("%s: extensions.material.mentioned is empty" % where,
                "say where the paper mentions the item (page and section), so the researcher can find it")
        search = m.get("search")
        if not isinstance(search, list) or any(not isinstance(s, dict) or not str(s.get("where") or "").strip()
                                               for s in search):
            add("%s: extensions.material.search must list the open places looked in ({where, url, found})" % where,
                "list the supplement and every repository the paper links; [] only when it links none")
        if m.get("asked") in (None, "", False) and status == "pending":
            notes.append("%s: %s has not been asked about yet; ask the researcher in the one consolidated materials "
                         "question" % (where, what))
        value_words = max([len(words(s)) for s in strings(f.get("value"))] or [0])

        if status in ("pending", "left-out"):
            if f.get("state") != "missing" or not empty(f.get("value")):
                add("%s: %s needs the original and has none yet: state missing and no value (%s)"
                    % (where, what, "left out by the researcher" if status == "left-out" else "pending"),
                    "never fill it with your own wording; a stand-in is used only once the researcher accepts it "
                    "(status stand-in)")
            if f.get("origin") in ("verbatim", "reported"):
                add("%s: origin %s claims printed text that the paper does not print" % (where, f.get("origin")),
                    "origin unknown, state missing")
        if status == "pending":
            titled = [i for i in mine if i.get("severity") in ("blocking", "decision")]
            if not titled:
                add("%s: pending needs-original item has no blocking or decision issue" % where,
                    "add one whose title says what is needed, e.g. \"Needs the original %s\"" % (what or "materials"))
            elif what and not any(what.lower() in str(i.get("title") or "").lower() for i in titled):
                add("%s: no issue title on this item names what is needed (%s)" % (where, what),
                    "the researcher sees the issue title as the status: put the item's `what` in it")
        if status == "left-out":
            if not str(m.get("answer") or "").strip():
                add("%s: left-out needs the researcher's answer in extensions.material.answer" % where, "")
            if caps is not None and not any(isinstance(x, dict) and (
                    x.get("field") == where or (what and what.lower() in str(x.get("what") or "").lower()))
                    for x in excluded):
                add("%s: left out by the researcher, but capabilities.json run.excluded does not name it" % where,
                    'add {"what": "%s", "field": "%s", "reason": "left out by the researcher", "arms": [...]}'
                    % (what, where))
        if status == "stand-in":
            if f.get("origin") != "implementation":
                add("%s: an accepted stand-in is origin implementation, not %r" % (where, f.get("origin")), "")
            label = " ".join([str(f.get("label") or "")] + list(strings(f.get("value"))))
            if "stand-in" not in label.lower() and "stand in" not in label.lower():
                add("%s: an accepted stand-in must say it is one (label or value contains \"stand-in\")" % where, "")
            if not str(m.get("answer") or "").strip():
                add("%s: stand-in without the researcher's acceptance in extensions.material.answer" % where,
                    "only the researcher accepts a stand-in; until then the item stays pending")
        if status == "supplied":
            rel = str(m.get("file") or "")
            if f.get("origin") != "researcher":
                add("%s: researcher-supplied material is origin researcher, not %r" % (where, f.get("origin")), "")
            if not researcher_rel(rel) or not (root / rel).is_file():
                add("%s: supplied material must be a file under %s/ (got %r)" % (where, RESEARCHER_DIR, rel),
                    "save the pasted or uploaded text there and name it in extensions.material.file")
            elif str((recorded.get(rel) or {}).get("license") or "") != RESEARCHER_LICENSE:
                add("%s: sources/SOURCE.json does not record %s as %s" % (where, rel, RESEARCHER_LICENSE),
                    "run the build skill's sources.py (it records files under %s/ that way)" % RESEARCHER_DIR)
            if value_words > SHORT:
                add("%s: the program holds the researcher's text (%d words); keep it only in %s"
                    % (where, value_words, rel or RESEARCHER_DIR + "/"),
                    'the value is a reference ({"file": "%s"}); the package reads the file at run time'
                    % (rel or RESEARCHER_DIR + "/<name>"))
        if status == "found-open":
            if f.get("origin") != "verbatim":
                add("%s: material found in an open source is transcribed verbatim (origin verbatim)" % where, "")
            paths = [str(e.get("path") or paper) for e in cited]
            if not paths:
                add("%s: cite the evidence in the open source it was copied from" % where, "")
            for rel in paths:
                entry = recorded.get(rel)
                if rel == paper or not rel.startswith("sources/") or researcher_rel(rel):
                    add("%s: found-open evidence must come from the open source saved under sources/ (got %s)"
                        % (where, rel), "save the supplement or repository file under sources/ and cite it")
                    continue
                lic = str((entry or {}).get("license") or "unknown")
                if not OPEN_LICENSE.match(lic) or not str((entry or {}).get("licenseEvidence") or "").strip():
                    add("%s: %s is not recorded with an open license and where it is stated (license %s)"
                        % (where, rel, lic),
                        "use a file only when its page or repository states an open license; record it with "
                        "sources.py --license and --license-evidence; otherwise ask the researcher")
                if Path(rel).suffix.lower() in DATA_EXT and DATA_NAME.search(Path(rel).name):
                    add("%s: %s looks like participant data, not materials" % (where, rel),
                        "never use participant data as materials; take the stimulus or instruction file instead, or ask")
            if not any(isinstance(s, dict) and s.get("found") and s.get("url") for s in search or []):
                add("%s: found-open needs the search entry it was found in (where, url, found: true)" % where, "")

    # researcher-supplied text stays in sources/researcher/
    for rel in sorted(private_paths(root)):
        if researcher_rel(rel) and str((recorded.get(rel) or {}).get("license") or "") != RESEARCHER_LICENSE:
            add("sources/SOURCE.json does not record %s as %s" % (rel, RESEARCHER_LICENSE),
                "run the build skill's sources.py")
    for shown, src, text in leaks(root, published_files(root)):
        add("%s copies researcher-supplied text from %s (\"%s ...\")" % (shown, src, text[:60]),
            "keep the researcher's materials only in %s/; reference the file (the package reads it at run time)"
            % RESEARCHER_DIR)
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
