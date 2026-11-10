"""Regenerate the invented projection fixture of test_original_text.py (CC0-1.0: made-up materials about a morning
walk; no real study, paper or person).

    HSENV_SRC=<public hsenv checkout at v0.8.1> <runtime python> make_fixture.py

Needs the public engine's hsenv.release (not vendored in the app) and pypdfium2 (the runtime has it). Writes
protocol.json (the projection), handout.txt (tier link), booklet.html (tier user) and leaflet.pdf (tier user, PDF).
"""
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, os.environ["HSENV_SRC"])
sys.path.insert(0, str(HERE.parents[1]))
from hsenv import distribution as D, release  # noqa: E402
from test_runtime_lib import make_pdf  # noqa: E402

HANDOUT = ("Morning Walk Survey\n"
           "Thank you for joining this short study about walking before breakfast.\n"
           "Please answer every question as honestly as you can.\n").encode("utf-8")
BOOKLET = ("<html><body><h1>Booklet</h1>"
           "<p>How many minutes did you walk this morning?</p>"
           "<p>Did you see a neighbour on the way?</p>"
           "</body></html>").encode("utf-8")
LEAFLET = make_pdf(["Cover page of the invented leaflet", "Remember to drink a glass of water first."])


def cite(source, label="verbatim", page=1):
    return {"label": label, "source": source, "page": page}


PROTOCOL = {
    "id": "fixture-walk",
    "meta": {"title": "An invented morning walk study (not a real paper)",
             "sources": {
                 "handout": {"title": "Morning Walk Survey handout",
                             "distribution": {"tier": "link", "url": "https://example.org/invented/handout.txt",
                                              "licence": "all rights reserved"}},
                 "booklet": {"title": "Walking booklet", "distribution": {"tier": "user"}},
                 "leaflet": {"title": "Water leaflet", "distribution": {"tier": "user"}},
                 "paper": {"title": "An invented morning walk study"}}},
    "data": {},
    "arms": [{"id": "control", "n_paper": 10}, {"id": "treatment", "n_paper": 10}],
    "stages": {
        "intro": {"content": [{"id": "t", "value": "Thank you for joining this short study about walking before "
                                                     "breakfast.", "cite": cite("handout")},
                              {"id": "w", "value": "Remember to drink a glass of water first.",
                               "cite": cite("leaflet", page=2)}]},
        "q": {"responses": [{"id": "minutes", "kind": "number",
                             "prompt": "How many minutes did you walk this morning?",
                             "prompt_cite": cite("booklet")},
                            {"id": "pick", "kind": "choice", "prompt": "Did you see a neighbour on the way?",
                             "prompt_cite": cite("booklet"),
                             "options": [{"code": "a", "label": "Yes"}, {"code": "b", "label": "No"}]}]},
    },
    "flow": {"seq": [{"stage": "intro"}, {"stage": "q"}]},
    "units": {"s": {"per": "session",
                    "fields": {"pick": "answer('q.pick')",
                               "picked_a": "None if answer('q.pick') is None else (1 if answer('q.pick') == 'a' else 0)"},
                    "cites": {"picked_a": {"label": "derived", "source": "paper", "page": 1}}}},
    "analysis": {"effects": [{"id": "saw_neighbour", "unit": "s",
                              "contrast": {"kind": "two_groups", "treatment": "treatment", "reference": "control"},
                              "compute": {"op": "proportion_difference", "field": "picked_a", "success": [1],
                                          "groupBy": "arm"},
                              "reported": {"cells": {"treatment": {"k": 14, "n": 20}, "control": {"k": 8, "n": 20}},
                                           "cite": {"label": "reported", "source": "paper", "page": 1}}}]},
    "keyed": {"answers": {"q.pick": "'a' if arm == 'treatment' else 'b'", "q.minutes": "20"}},
}

if __name__ == "__main__":
    proj, report = release.project(PROTOCOL, sources={"handout": HANDOUT, "booklet": BOOKLET, "leaflet": LEAFLET},
                                   extractors={"pdf": D.pdfium_extractor()})
    (HERE / "protocol.json").write_text(json.dumps(proj, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    (HERE / "handout.txt").write_bytes(HANDOUT)
    (HERE / "booklet.html").write_bytes(BOOKLET)
    (HERE / "leaflet.pdf").write_bytes(LEAFLET)
    print(json.dumps({"held": sorted(proj["distribution"]["held"]), "errors": report.get("errors")}, indent=1))
