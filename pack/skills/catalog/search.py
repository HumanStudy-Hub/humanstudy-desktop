#!/usr/bin/env python3
"""Read-only Hub search. Full pagination is snapshot-bound; no credentials or model API needed."""
import argparse
import json
import urllib.parse
import urllib.request
from pathlib import Path

BASE = "https://humanstudy-hub.com/api/research"


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=30) as response:
        return json.load(response)


def search(query, all_pages=False):
    offset, snapshot, items = 0, None, []
    while True:
        result = get("/search?" + urllib.parse.urlencode({"q": query, "offset": offset, "limit": 100}))
        if snapshot is not None and result["snapshot"] != snapshot:
            raise RuntimeError("The catalog changed during pagination. Repeat the search for a consistent collection.")
        snapshot = result["snapshot"]
        items.extend({k: v for k, v in paper.items() if k in {
            "id", "title", "authors", "year", "description", "aliases", "currentRevision",
            "coverage", "capabilities", "matchedBy", "resources", "studies"}}
                     for paper in result["items"])
        next_offset = result.get("nextOffset")
        if not all_pages or next_offset is None:
            return {"snapshot": snapshot, "scope": result["scope"], "source": result["source"],
                    "total": result["total"], "nextOffset": next_offset, "items": items}
        if next_offset <= offset:
            raise RuntimeError("Invalid pagination cursor")
        offset = next_offset


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query", nargs="?", default="")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--paper")
    parser.add_argument("--output", help="Save complete results inside this project instead of printing a large tool response")
    args = parser.parse_args()
    if args.paper:
        if not args.paper.startswith("paper_") or not all(c in "0123456789abcdef" for c in args.paper[6:]) or len(args.paper) != 30:
            parser.error("Invalid stable paper identity")
        result = get("/papers/" + args.paper)
    else:
        result = search(args.query, args.all)
    if args.output:
        target = Path(args.output).resolve()
        if not target.is_relative_to(Path.cwd().resolve()):
            parser.error("The output must stay inside the research project")
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            parser.error("Choose a new filename; existing research files are never overwritten")
        target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"file": str(target), "snapshot": result.get("snapshot"), "total": result.get("total"), "scope": result.get("scope")}))
    else:
        print(json.dumps(result, ensure_ascii=False, indent=2))
