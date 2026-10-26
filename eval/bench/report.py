#!/usr/bin/env python3
"""Turn results.json from run.py into a markdown table with totals.

    python eval/bench/report.py <work>/results.json > report.md
"""
import json
import sys


def frac(d):
    return "%d/%d" % (d["found"], d["total"]) if d and d.get("total") else "–"


def main(path):
    data = json.load(open(path, encoding="utf-8"))
    rows = data["rows"]
    tot = {"sampleSizes": [0, 0], "statistics": [0, 0], "dataPoints": [0, 0], "materials": [0, 0]}
    scan = {"sampleSizes": [0, 0], "statistics": [0, 0], "dataPoints": [0, 0], "materials": [0, 0]}
    q = {"found": 0, "all": 0}
    out = ["Model: %s" % data.get("model"), "",
           "| Study | Text | Built (min) | Checks | Ready | Sample sizes | Statistics | Data points | Materials ≥90% | Quotes found |",
           "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for r in rows:
        s = r.get("score") or {}
        for k in tot:
            if s.get(k):
                bucket = scan if s.get("scanned") else tot
                bucket[k][0] += s[k]["atLeast90"] if k == "materials" else s[k]["found"]
                bucket[k][1] += s[k]["items"] if k == "materials" else s[k]["total"]
        quotes = s.get("quotes") or {}
        q["found"] += quotes.get("found", 0)
        q["all"] += sum(v for k, v in quotes.items() if k != "unchecked")
        checks = "program %s, package %s" % ("✓" if r.get("programComplete") else "✗",
                                             "✓" if r.get("package") else ("–" if r.get("package") is None else "✗"))
        mats = s.get("materials") or {}
        out.append("| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
            r["study"], ("scan" if s.get("scanned") else "text") if s else "–", r.get("minutes", "–"), checks, r.get("readiness") or "–",
            frac(s.get("sampleSizes")), frac(s.get("statistics")), frac(s.get("dataPoints")),
            "%s/%s" % (mats.get("atLeast90"), mats.get("items")) if mats.get("items") else "–",
            ("%d/%d" % (quotes.get("found", 0), sum(v for k, v in quotes.items() if k != "unchecked"))
             if sum(v for k, v in quotes.items() if k != "unchecked") else "scanned") if quotes else "–"))
    pct = lambda a, b: "%d/%d (%.0f%%)" % (a, b, 100.0 * a / b) if b else "–"
    line = lambda t: "sample sizes %s · statistics %s · data points %s · verbatim materials %s" % (
        pct(*t["sampleSizes"]), pct(*t["statistics"]), pct(*t["dataPoints"]), pct(*t["materials"]))
    cost = sum(r.get("costUsd") or 0 for r in rows)
    minutes = [r["minutes"] for r in rows if r.get("minutes") is not None]
    out += ["", "Text PDFs: " + line(tot), "", "Scanned PDFs: " + line(scan),
            "", "Build time median %s min; total cost $%.2f" % (sorted(minutes)[len(minutes) // 2] if minutes else "–", cost),
            "", "Quotes found on their cited page (where a text layer exists): %s" % pct(q["found"], q["all"]), ""]
    print("\n".join(out))


if __name__ == "__main__":
    main(sys.argv[1])
