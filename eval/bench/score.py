#!/usr/bin/env python3
"""Score a built program.json against a HumanStudy-Bench study's curated ground truth.

    python eval/bench/score.py <bench>/studies/study_001 <project>/program.json [--json out.json]

Recall of curated facts, not a full grade: Bench's scope is sometimes narrower or wider than the
paper, and its curators summarise some materials. Five measures:

Only curated values printed in the paper's text layer count (Bench also derives values and, for one
study, takes them from a later paper); those are reported as notInPaper. Scanned papers have no
text layer, so nothing is filtered and they are reported separately.

  sample sizes   each sub-study n in specification.json appears in the program's participants
  statistics     every number of each reported test (e.g. F(1, 312) = 49.1) appears together in one
                 program field or quote
  data points    numeric values in original_data_points (means, percentages, counts > 10) appear in
                 the program; a percentage also matches as its complement (23% yes = 77% no)
  materials      curated material texts printed in the paper that appear word for word (90%+) in the
                 program's verbatim fields; curators' summaries are counted as notInPaper
  quotes         check_quotes.py: program quotes found on their cited pages
"""
import argparse
import difflib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NUM = re.compile(r"(?<![\w.])[-−]?(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)")


def numbers(text):
    out = []
    for m in NUM.findall(str(text)):
        m = m.replace("−", "-")
        # "2,100" may be a thousand separator, "F(1,312)" two numbers: keep both readings
        for part in [m.replace(",", "")] + (m.split(",") if "," in m else []):
            try:
                out.append(float(part))
            except ValueError:
                pass
    return out


def same(a, b):
    a, b = abs(a), abs(b)  # sign conventions differ (differences, reversed scales)
    tol = 0.051 if b >= 1 else 0.0051
    return abs(a - b) <= tol


LABEL = re.compile(r"\b(?:problem|version|table|model|study|experiment|exp|session|condition|game|round|"
                   r"period|item|question|figure|fig|h|hypothesis|part|treatment)\.?\s*[ivx\d]+[a-z]?\b", re.I)
SAMPLE = re.compile(r"\b[nN]\s*=\s*[\d,]+")


def stat_parts(text):
    """A curated statistics string -> lists of numbers that must appear together (labels and n removed)."""
    parts = []
    for piece in re.split(r";|\n", str(text)):
        nums = [x for x in numbers(SAMPLE.sub(" ", LABEL.sub(" ", piece)))
                if not any(same(x, a) for a in (0.05, 0.01, 0.001, 0.1))]
        if nums:
            parts.append(nums)
    return parts


def paper_numbers(project):
    """Numbers printed in the project's paper and sources (text layer). None when the PDF is scanned."""
    sys.path.insert(0, str(HERE.parents[1] / "pack/skills/build"))
    import check_quotes
    pdfs = [project / "paper.pdf"] + sorted((project / "sources").glob("*.pdf")) if (project / "sources").is_dir() \
        else [project / "paper.pdf"]
    text = "\n".join("\n".join(check_quotes.Pdf(p).load()) for p in pdfs if p.is_file())
    if len(text.strip()) < 2000:
        return None, None
    return numbers(text), words(text)


def words(text):
    return re.sub(r"[^\w%]+", " ", str(text).lower()).split()


def texts(program):
    """Every text unit of the program: field values (with labels) and evidence quotes."""
    units = []
    for n in program.get("nodes", []):
        for f in n.get("fields", []):
            units.append(("%s %s %s" % (n.get("title", ""), f.get("label", ""), json.dumps(f.get("value"), ensure_ascii=False)),
                          n.get("kind"), f.get("origin")))
        units.append((n.get("summary", "") or "", n.get("kind"), None))
    for s in program.get("steps", []):
        if isinstance(s.get("rule"), dict):
            units.append((json.dumps(s["rule"].get("value"), ensure_ascii=False), "step", s["rule"].get("origin")))
    for e in program.get("evidence", []):
        units.append((e.get("quote", ""), "evidence", None))
    return units


def leaves(obj, key=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if "note" in k.lower() or "description" in k.lower():
                continue
            yield from leaves(v, k)
    elif isinstance(obj, list):
        for v in obj:
            yield from leaves(v, key)
    elif isinstance(obj, (int, float)) and not isinstance(obj, bool):
        yield key, float(obj)


def score(study_dir, program_path):
    study_dir, program_path = Path(study_dir), Path(program_path)
    gt = json.loads((study_dir / "source/ground_truth.json").read_text(encoding="utf-8"))
    spec = json.loads((study_dir / "source/specification.json").read_text(encoding="utf-8"))
    program = json.loads(program_path.read_text(encoding="utf-8"))
    units = texts(program)
    unit_nums = [numbers(t) for t, _, _ in units]
    all_nums = [x for ns in unit_nums for x in ns]
    has = lambda v: any(same(x, v) for x in all_nums)
    result = {"study": study_dir.name, "programStudies": len(program.get("studies", []))}
    printed, paper_words = paper_numbers(program_path.parent)
    in_paper = (lambda v: True) if printed is None else (lambda v: any(same(x, v) for x in printed))
    result["scanned"] = printed is None

    # sample sizes
    subs = (spec.get("participants") or {}).get("by_sub_study") or {}
    ns = [(k, v.get("n")) for k, v in subs.items() if isinstance(v, dict) and isinstance(v.get("n"), (int, float))]
    if not ns and isinstance((spec.get("participants") or {}).get("n"), (int, float)):
        ns = [("total", spec["participants"]["n"])]
    part_nums = [x for (t, kind, _), nums in zip(units, unit_nums) if kind in ("participants", "design", "condition", "result", "evidence") for x in nums]
    hits = [(k, n, any(same(x, n) for x in part_nums)) for k, n in ns if in_paper(n)]
    result["sampleSizes"] = {"found": sum(h for *_, h in hits), "total": len(hits),
                             "notInPaper": len(ns) - len(hits),
                             "missed": ["%s n=%g" % (k, n) for k, n, h in hits if not h]}

    # statistics
    tests = [t for st in gt.get("studies", []) for f in st.get("findings", []) for t in f.get("statistical_tests", [])]
    stat = {"found": 0, "total": 0, "notInPaper": 0, "missed": []}
    for t in tests:
        for want in stat_parts(t.get("reported_statistics", "")):
            if not all(in_paper(w) for w in want):
                stat["notInPaper"] += 1  # curated or derived by Bench, not printed in the source
                continue
            stat["total"] += 1
            if any(all(any(same(x, w) for x in nums) for w in want) for nums in unit_nums):
                stat["found"] += 1
            else:
                stat["missed"].append(t.get("reported_statistics"))
    stat["missed"] = stat["missed"][:20]
    result["statistics"] = stat

    # data points
    points = []
    for st in gt.get("studies", []):
        for f in st.get("findings", []):
            for key, v in leaves((f.get("original_data_points") or {}).get("data", {})):
                if abs(v) <= 10 and float(v).is_integer():
                    continue  # small counts and codes match by chance
                points.append((key, v))
    dp = {"found": 0, "total": 0, "notInPaper": 0, "missed": []}
    for key, v in points:
        complement = "percent" in key.lower() and 0 <= v <= 100
        if not (in_paper(v) or (complement and in_paper(100 - v))):
            dp["notInPaper"] += 1
            continue
        dp["total"] += 1
        if has(v) or (complement and has(100 - v)):
            dp["found"] += 1
        else:
            dp["missed"].append("%s=%g" % (key, v))
    dp["missed"] = dp["missed"][:20]
    result["dataPoints"] = dp

    # materials
    verbatim = " ".join(t for t, _, origin in units if origin == "verbatim")
    vw = words(verbatim)
    mats, curated = [], 0
    for path in sorted((study_dir / "source/materials").glob("*.json")):
        m = json.loads(path.read_text(encoding="utf-8"))
        items = [m.get("instructions", "")] + [i.get("question", "") for i in m.get("items", []) if isinstance(i, dict)]
        for text in items:
            w = words(text)
            if len(w) < 15:
                continue
            share = lambda hay: sum(b.size for b in difflib.SequenceMatcher(None, w, hay, autojunk=False)
                                    .get_matching_blocks()) / len(w)
            if paper_words is not None and share(paper_words) < 0.9:
                curated += 1  # a curator's summary, not printed in the paper: nothing to copy verbatim
                continue
            mats.append(share(vw))
    mats.sort()
    result["materials"] = {"items": len(mats), "median": round(mats[len(mats) // 2], 3) if mats else None,
                           "atLeast90": sum(m >= 0.9 for m in mats), "notInPaper": curated}

    # quotes
    sys.path.insert(0, str(HERE.parents[1] / "pack/skills/build"))
    import check_quotes
    q = check_quotes.check(program_path)
    result["quotes"] = q["counts"]
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("study")
    ap.add_argument("program")
    ap.add_argument("--json")
    a = ap.parse_args(argv)
    r = score(a.study, a.program)
    if a.json:
        Path(a.json).write_text(json.dumps(r, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(r, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
