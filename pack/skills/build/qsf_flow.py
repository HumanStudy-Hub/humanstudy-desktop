#!/usr/bin/env python3
"""Read a Qualtrics survey export (.qsf) in the order participants saw it, and check that a package uses only
what the survey flow shows.

    python .opencode/skills/build/qsf_flow.py sources/open/<file>.qsf                     outline
    python .opencode/skills/build/qsf_flow.py sources/open/<file>.qsf --json .humanstudy/tmp/<file>.flow.json
    python .opencode/skills/build/qsf_flow.py --check .        package check (every .qsf under sources/)

A .qsf file is the survey's design, not its responses. It lists every question ever written for the survey,
including ones in the "Trash / Unused Questions" block and blocks that are not in the survey flow. Participants
only saw the blocks the survey flow reaches, in the flow's order, with its randomisers, branches and each
question's display logic, validation and answer order. This reader turns that structure into a deterministic
record so a build follows the survey instead of guessing from the raw JSON. (Ported from HumanStudy-Bench
agent_pipeline/qsf_flow.py; the reader is the same, the package check follows the desktop project layout.)

Output (``read_survey``):

- ``flow``: the survey flow in order. Elements are ``block`` (a reference to a block, by id), ``randomizer``
  (``present`` of ``of`` elements, ``evenly``), ``branch`` (``condition`` in plain words, then its elements),
  ``group``, ``embedded_data`` (fields and the values the flow sets), ``end_survey`` and anything else Qualtrics
  allows, kept with its type and a note.
- ``blocks``: each reachable block, in first-appearance order: question order, pages (page breaks, or questions
  per page under advanced randomisation), the block's question randomisation, and each question with its text,
  choices in display order, answer-order randomisation, display logic, skip logic and validation (forced or
  requested response, correct-answer custom validation with its message, content checks).
- ``not_reachable``: blocks and questions participants never saw (the Trash block, blocks missing from the flow,
  questions in no block, questions an advanced randomisation never displays), with the reason.
- ``notes``: anything the reader could not interpret fully.

``correct_answer_checks(report)`` lists every shown question whose validation accepts only a correct answer
(whether or not the response is forced): a package asks each with the correct options as its key.

Text: HTML becomes plain text with line breaks kept. Emphasis is kept as markers: ``**bold**``, ``*italic*`` and
``<u>underlined</u>``. ``text_plain`` has no markers.

Package check (``problems(root, package=None) -> [(message, fix)]``, called by check_package.py). For every .qsf
under sources/ (open/, private/, researcher/) that has a survey flow, survey text of at least MIN_WORDS words that
only an unreachable question carries fails when it appears in
  - a program.json field whose evidence cites that .qsf by `path` (or whose extensions.material.file is it);
  - a materials/materials.json entry whose nearest declared source is that .qsf (`source`, `sourceFile`, `path`,
    `file`, `sourceId` naming its path or file name, or `evidenceIds` whose evidence cites it);
  - a string literal of task/adapter.py (read with ast, never imported or run).
An item marked {"qsfReachability": "not-shown"} (or listed under a key such as `notShown`) is not participant
text, but neither its id nor its question id (`qsfId`/`qid`) may appear in task/adapter.py literals, task/task.json
or the program steps. An item marked "mixed" needs state `check` and must also hold text the flow shows. A project
without a .qsf, or whose .qsf has no survey flow, passes with no work.
For the shown questions it also fails a program.json field or materials.json item that transcribes a question
(its full text, a line only that question prints, or its qid/tag on the item) and
  - drops the question's pictures (``<img>`` in its text or choices) without declaring them: an `images`/`figure`
    key on the item or its parent, a sibling field with state missing, or a capabilities.json run.excluded /
    task.json replayAdaptations entry naming the question, its tag, its arms or the item's path;
  - lists a slider's opt-out box (the "NA" label, Configuration.NotApplicable) beside its anchors, as if it were a
    point on the scale (the anchors are the numbered labels, in order);
  - asks a question that display logic shows only after another answer in the same prompt as that question, or
    without the controlling question at all (unless the adapter names the controlling qid).

Limits: the reader reports logic; it does not evaluate it. Display logic and branch conditions are rendered from
the export's structured fields (falling back to Qualtrics's own description) and a person or agent decides what
they imply. JavaScript attached to a question (which can hide, time or auto-advance it), loop & merge, quotas, web
services, authenticators and end-of-survey messages (stored in the account's message library, not in the export)
are reported but not interpreted. Survey-level options such as the back button are copied from the export. The
reader never opens response data: it accepts only a Qualtrics survey export (a JSON object with ``SurveyEntry``
and ``SurveyElements``). Strings shorter than MIN_WORDS words ("Not at all") are never attributed to one question.
Standard library only.
"""
from __future__ import annotations

import argparse
import html
import json
import posixpath
import re
import sys
from pathlib import Path
from typing import Any, Iterable

READER_VERSION = 1
PIPE_RE = re.compile(r"\$\{[^}]+\}")
HIDDEN_TYPES = {"Timing", "Meta", "Captcha"}  # recorded silently, or not a question participants answer
OPERATORS = {
    "Selected": "is selected", "NotSelected": "is not selected", "EqualTo": "=", "NotEqualTo": "≠",
    "GreaterThan": ">", "GreaterThanOrEqual": "≥", "LessThan": "<", "LessThanOrEqual": "≤",
    "Contains": "contains", "DoesNotContain": "does not contain", "Displayed": "was displayed",
    "NotDisplayed": "was not displayed", "Empty": "is empty", "NotEmpty": "is not empty",
    "MatchesRegex": "matches", "StartsWith": "starts with", "EndsWith": "ends with",
}
SELECTORS = {
    "SAVR": "single answer, vertical", "SAHR": "single answer, horizontal", "SACOL": "single answer, columns",
    "MAVR": "multiple answers, vertical", "MAHR": "multiple answers, horizontal", "MACOL": "multiple answers, columns",
    "DL": "dropdown list", "SB": "select box", "MSB": "multi-select box", "TB": "text / graphic",
    "SL": "single line", "ML": "multiple lines", "ESTB": "essay box", "FORM": "form", "PW": "password",
    "Likert": "Likert matrix", "Bipolar": "bipolar matrix", "TE": "text entry matrix", "HSLIDER": "horizontal slider",
}
TYPES = {"MC": "multiple choice", "DB": "text / graphic", "TE": "text entry", "Matrix": "matrix",
         "Slider": "slider", "RO": "rank order", "CS": "constant sum", "SBS": "side by side",
         "Timing": "page timer", "Meta": "browser meta info", "PGR": "pick, group and rank",
         "HL": "heat map", "HotSpot": "hot spot", "Draw": "signature", "FileUpload": "file upload",
         "Captcha": "captcha", "NPS": "net promoter score"}


class NotASurveyExport(ValueError):
    pass


# --------------------------------------------------------------------------- text

def html_to_text(value: Any, markers: bool = True) -> str:
    """Survey HTML as plain text, keeping paragraphs and (optionally) emphasis."""
    if not isinstance(value, str):
        return ""
    text = re.sub(r"(?is)<(script|style)\b.*?</\1\s*>", "", value)
    text = re.sub(r"\s+", " ", text)  # a line break in the HTML source renders as a space
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</?(p|div|li|ul|ol|h[1-6]|tr|table|blockquote)\b[^>]*>", "\n", text)
    if markers:
        text = re.sub(r"(?i)<(strong|b)\b[^>]*>", "**", text)
        text = re.sub(r"(?i)</(strong|b)\s*>", "**", text)
        text = re.sub(r"(?i)<(em|i)\b[^>]*>", "*", text)
        text = re.sub(r"(?i)</(em|i)\s*>", "*", text)
        text = re.sub(r"(?i)<u\b[^>]*>", "\x01", text)
        text = re.sub(r"(?i)</u\s*>", "\x02", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text).replace("\xa0", " ").replace("\r", "")
    text = text.replace("\x01", "<u>").replace("\x02", "</u>")
    if markers:
        # Empty or doubled markers left by adjacent tags (<b></b>, <strong><b>).
        text = re.sub(r"\*\*\s*\*\*", "", text)
        text = text.replace("<u></u>", "")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


IMG_RE = re.compile(r"(?is)<img\b[^>]*>")


def _images(value: Any) -> list[dict]:
    """Every <img> in survey HTML: {"src", "alt"}. The picture itself is not in the export (Qualtrics hosts it)."""
    if not isinstance(value, str):
        return []
    out = []
    for tag in IMG_RE.findall(value):
        src = re.search(r"""(?is)\bsrc\s*=\s*["']?([^"'\s>]+)""", tag)
        alt = re.search(r"""(?is)\balt\s*=\s*(["'])(.*?)\1""", tag)
        out.append({"src": html.unescape(src.group(1)) if src else "",
                    "alt": html.unescape(alt.group(2)).strip() if alt else ""})
    return out


def _short(text: str, n: int = 90) -> str:
    one = re.sub(r"\s+", " ", text).strip()
    return one if len(one) <= n else one[: n - 1].rstrip() + "…"


# --------------------------------------------------------------------------- loading

def load_qsf(path: Path) -> dict:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8", errors="replace"))
    except ValueError as exc:
        raise NotASurveyExport(f"{path} is not JSON, so it is not a Qualtrics survey export") from exc
    if not isinstance(data, dict) or not isinstance(data.get("SurveyElements"), list):
        raise NotASurveyExport(f"{path} has no SurveyElements, so it is not a Qualtrics survey export (.qsf)")
    return data


def _elements(data: dict, kind: str) -> list[dict]:
    return [e for e in data.get("SurveyElements", []) if isinstance(e, dict) and e.get("Element") == kind]


def _blocks(data: dict) -> dict[str, dict]:
    blocks: dict[str, dict] = {}
    for element in _elements(data, "BL"):
        payload = element.get("Payload")
        items = payload.values() if isinstance(payload, dict) else payload if isinstance(payload, list) else []
        for block in items:
            if isinstance(block, dict) and isinstance(block.get("ID"), str):
                blocks[block["ID"]] = block
    return blocks


def _questions(data: dict) -> dict[str, dict]:
    questions: dict[str, dict] = {}
    for element in _elements(data, "SQ"):
        payload = element.get("Payload")
        if isinstance(payload, dict):
            qid = payload.get("QuestionID") or element.get("PrimaryAttribute")
            if isinstance(qid, str):
                questions[qid] = payload
    return questions


def _is_trash(block: dict) -> bool:
    if block.get("Type"):
        return str(block["Type"]).lower() == "trash"
    return str(block.get("Description", "")).strip().lower() == "trash / unused questions"


# --------------------------------------------------------------------------- logic

def _choice_text(questions: dict[str, dict], qid: str, choice: str) -> str:
    q = questions.get(qid, {})
    choices = q.get("Choices") if isinstance(q.get("Choices"), dict) else {}
    item = choices.get(str(choice))
    if isinstance(item, dict):
        return html_to_text(item.get("Display"), markers=False)
    return f"choice {choice}"


def _answer_text(questions: dict[str, dict], qid: str, answer: str) -> str:
    q = questions.get(qid, {})
    answers = q.get("Answers") if isinstance(q.get("Answers"), dict) else {}
    item = answers.get(str(answer))
    return html_to_text(item.get("Display"), markers=False) if isinstance(item, dict) else f"column {answer}"


def _operand(locator: Any, questions: dict[str, dict]) -> str:
    """A q://QID/... locator as words."""
    if not isinstance(locator, str):
        return str(locator)
    match = re.match(r"q://(QID\d+)/([A-Za-z]+)(?:/([^/]+))?(?:/([^/]+))?", locator)
    if not match:
        return locator
    qid, what, first, second = match.groups()
    if what == "SelectableChoice" and first:
        return f'"{_choice_text(questions, qid, first)}"'
    if what == "SelectableAnswer" and first and second:
        return f'row "{_choice_text(questions, qid, first)}" → "{_answer_text(questions, qid, second)}"'
    if what in ("ChoiceTextEntryValue", "ChoiceNumericEntryValue") and first:
        return f'the text typed for "{_choice_text(questions, qid, first)}"'
    if what in ("ChoiceTextEntryValue", "QuestionText"):
        return "the answer typed"
    return f"{what} {first or ''} {second or ''}".strip()


def _expression(expr: dict, questions: dict[str, dict]) -> str:
    kind = expr.get("LogicType")
    operator = OPERATORS.get(str(expr.get("Operator")), str(expr.get("Operator", "")))
    right = expr.get("RightOperand")
    right_text = "" if right in (None, "") else f" {str(right).strip()}"
    if kind == "Question" and isinstance(expr.get("QuestionID"), str):
        qid = expr["QuestionID"]
        q = questions.get(qid, {})
        label = f'{qid} ({q.get("DataExportTag", "")}: "{_short(html_to_text(q.get("QuestionText"), False), 60)}")'
        left = _operand(expr.get("LeftOperand") or expr.get("ChoiceLocator"), questions)
        return f"{label} {left} {operator}{right_text}".strip()
    if kind == "EmbeddedField":
        return f"embedded data {expr.get('LeftOperand')} {operator}{right_text}".strip()
    description = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", str(expr.get("Description") or "")))).strip()
    description = re.sub(r"^(If|And|Or)\s+", "", description)
    return description or json.dumps({k: v for k, v in expr.items() if k != "Description"}, ensure_ascii=False)


def render_logic(logic: Any, questions: dict[str, dict]) -> str:
    """A Qualtrics BooleanExpression (display, branch, skip or validation logic) in words."""
    if not isinstance(logic, dict):
        return ""
    groups = [(k, v) for k, v in logic.items() if str(k).isdigit() and isinstance(v, dict)]
    rendered: list[str] = []
    for index, (_, group) in enumerate(sorted(groups, key=lambda kv: int(kv[0]))):
        parts: list[str] = []
        exprs = [(k, v) for k, v in group.items() if str(k).isdigit() and isinstance(v, dict)]
        for position, (_, expr) in enumerate(sorted(exprs, key=lambda kv: int(kv[0]))):
            text = _expression(expr, questions)
            if position:
                text = f"{str(expr.get('Conjuction') or expr.get('Conjunction') or 'And').upper()} {text}"
            parts.append(text)
        body = " ".join(parts)
        if index:
            joiner = group.get("Conjuction") or group.get("Conjunction") or group.get("Type")
            joiner = joiner if str(joiner).lower() in ("and", "or") else "Or"
            body = f"{str(joiner).upper()} ({body})"
        elif len(groups) > 1:
            body = f"({body})"
        rendered.append(body)
    return " ".join(rendered)


def _logic_expressions(logic: Any) -> Iterable[dict]:
    if isinstance(logic, dict):
        for key, value in logic.items():
            if str(key).isdigit() and isinstance(value, dict):
                if "LogicType" in value or "Operator" in value:
                    yield value
                else:
                    yield from _logic_expressions(value)


def _logic_record(logic: Any, questions: dict[str, dict]) -> dict | None:
    if not isinstance(logic, dict) or not any(True for _ in _logic_expressions(logic)):
        return None
    record: dict[str, Any] = {"condition": render_logic(logic, questions)}
    if "inPage" in logic:
        record["in_page"] = bool(logic.get("inPage"))
    depends = sorted({e["QuestionID"] for e in _logic_expressions(logic) if isinstance(e.get("QuestionID"), str)})
    fields = sorted({str(e.get("LeftOperand")) for e in _logic_expressions(logic) if e.get("LogicType") == "EmbeddedField"})
    if depends:
        record["depends_on_questions"] = depends
    if fields:
        record["depends_on_embedded_data"] = fields
    return record


# --------------------------------------------------------------------------- questions

def _randomisation(q: dict) -> dict | None:
    rand = q.get("Randomization")
    if isinstance(rand, str):
        rand = {"Type": rand}
    if not isinstance(rand, dict):
        return None
    kind = str(rand.get("Type", "None"))
    if kind in ("None", "", "false"):
        return None
    if kind == "All":
        return {"type": "all", "summary": "answer options shown in a new random order for each participant"}
    if kind == "RandomSubset":
        return {"type": "subset", "show": rand.get("TotalRandSubset"),
                "summary": f"a random {rand.get('TotalRandSubset')} of the answer options are shown, in random order"}
    if kind == "Advanced":
        advanced = rand.get("Advanced") if isinstance(rand.get("Advanced"), dict) else {}
        return {"type": "advanced", "fixed_order": advanced.get("FixedOrder"),
                "randomize_all": advanced.get("RandomizeAll"), "random_subset": advanced.get("RandomSubSet"),
                "undisplayed": advanced.get("Undisplayed"), "total_random_subset": advanced.get("TotalRandSubset"),
                "summary": "advanced answer-order randomisation: options in fixed_order stay; '{~Randomized~}' "
                           "slots are filled at random from randomize_all; undisplayed options are never shown"}
    if kind == "Flip" or rand.get("Type") == "ReverseOrder":
        return {"type": "flip", "summary": "answer options shown in order or reversed, at random"}
    return {"type": kind, "summary": f"answer-order randomisation of type {kind!r} (not interpreted)"}


def _validation(q: dict, questions: dict[str, dict]) -> dict:
    settings = q.get("Validation", {}).get("Settings", {}) if isinstance(q.get("Validation"), dict) else {}
    settings = settings if isinstance(settings, dict) else {}
    force = str(settings.get("ForceResponse", "OFF"))
    force_type = str(settings.get("ForceResponseType", ""))
    # ForceResponse decides; ForceResponseType only says which kind when it is on
    # (an "OFF" question can keep a remembered type from an earlier setting).
    if force == "RequestResponse" or (force == "ON" and force_type == "RequestResponse"):
        response = "requested"
    elif force == "ON":
        response = "forced"
    else:
        response = "optional"
    record: dict[str, Any] = {"response": response}
    if response == "requested":
        record["response_note"] = "the participant is asked to answer but may continue without answering"
    kind = settings.get("Type")
    if kind and kind != "None":
        record["type"] = kind
    if kind == "CustomValidation":
        custom = settings.get("CustomValidation", {}) if isinstance(settings.get("CustomValidation"), dict) else {}
        logic = custom.get("Logic")
        record["must_satisfy"] = render_logic(logic, questions)
        message = custom.get("Message")
        if isinstance(message, dict):
            record["message_description"] = html_to_text(message.get("description"), markers=False) or None
            record["message_note"] = ("the export stores only the description of a message in the account's "
                                      "message library; it may be the shown text (\"The answer is incorrect. "
                                      "Please choose again.\") or just the message's name (\"Require "
                                      "response\"). The shown text is not in the export")
        own = [e for e in _logic_expressions(logic) if e.get("QuestionID") == q.get("QuestionID")
               and e.get("Operator") == "Selected"]
        locators = [str(e.get("LeftOperand") or e.get("ChoiceLocator") or "") for e in own]
        choice_ids = [m.group(1) for loc in locators for m in [re.search(r"/SelectableChoice/([^/]+)$", loc)] if m]
        conjunctions = {str(e.get("Conjuction") or e.get("Conjunction") or "").lower()
                        for e in list(_logic_expressions(logic))[1:]}
        if choice_ids and len(choice_ids) == len(list(_logic_expressions(logic))) and conjunctions <= {"", "or"}:
            record["correct_choices"] = [{"id": c, "text": _choice_text(questions, q["QuestionID"], c)}
                                         for c in choice_ids]
            record["summary"] = ("only the correct answer is accepted (" + " or ".join(
                f'"{c["text"]}"' for c in record["correct_choices"]) + "); any other answer is refused"
                + (f' (message description: "{record["message_description"]}")' if record.get("message_description") else "")
                + " and the participant must answer again")
        else:
            record["summary"] = ("the answer must satisfy the condition in must_satisfy, otherwise it is refused"
                                 + (f' with the message "{record["message_description"]}"' if record.get("message_description") else ""))
    elif kind == "ContentType":
        content = settings.get("ContentType")
        record["content"] = content
        detail = settings.get(str(content)) if isinstance(settings.get(str(content)), dict) else None
        if detail:
            record["limits"] = detail
    elif kind in ("MinChoices", "MaxChoices", "MinChar", "MaxChar", "ChoiceRange", "TotalChars"):
        record["limits"] = {k: v for k, v in settings.items() if k in
                            ("MinChoices", "MaxChoices", "MinChars", "MaxChars", "TotalChars")}
    return record


def _choices(q: dict, questions: dict[str, dict], key: str, order_key: str) -> list[dict]:
    choices = q.get(key) if isinstance(q.get(key), dict) else {}
    order = q.get(order_key) if isinstance(q.get(order_key), list) else list(choices)
    recodes = q.get("RecodeValues") if key == "Choices" and isinstance(q.get("RecodeValues"), dict) else {}
    out: list[dict] = []
    seen: set[str] = set()
    for cid in [str(c) for c in order] + [c for c in map(str, choices) if c not in map(str, order)]:
        if cid in seen or cid not in choices:
            continue
        seen.add(cid)
        item = choices[cid] if isinstance(choices[cid], dict) else {"Display": str(choices[cid])}
        if not html_to_text(item.get("Display"), markers=False) and str(item.get("TextEntry", "")).lower() != "true" \
                and not _images(item.get("Display")):
            continue   # a placeholder; an option that is only a picture is kept (its images say so)
        record: dict[str, Any] = {"id": cid, "text": html_to_text(item.get("Display")),
                                  "text_plain": html_to_text(item.get("Display"), markers=False)}
        if cid in recodes:
            record["recode"] = recodes[cid]
        if str(item.get("TextEntry", "")).lower() == "true":
            record["text_entry"] = True
        if str(item.get("ExclusiveAnswer", "")).lower() == "true":
            record["exclusive"] = True
        if _images(item.get("Display")):
            record["images"] = _images(item.get("Display"))
        logic = _logic_record(item.get("DisplayLogic"), questions)
        if logic:
            record["display_logic"] = logic
        out.append(record)
    return out


def _question(q: dict, questions: dict[str, dict], notes: list[str]) -> dict:
    qid = str(q.get("QuestionID"))
    qtype, selector, sub = q.get("QuestionType"), q.get("Selector"), q.get("SubSelector")
    raw = q.get("QuestionText", "")
    record: dict[str, Any] = {
        "qid": qid, "tag": q.get("DataExportTag"),
        "type": "/".join(str(x) for x in (qtype, selector, sub) if x),
        "kind": ", ".join(dict.fromkeys(x for x in (TYPES.get(str(qtype), str(qtype)),
                                                     SELECTORS.get(str(selector), "")) if x)),
        "participant_visible": qtype not in HIDDEN_TYPES,
        "text": html_to_text(raw), "text_plain": html_to_text(raw, markers=False),
    }
    choices = _choices(q, questions, "Choices", "ChoiceOrder")
    if (qtype == "TE" and selector != "FORM") or qtype in HIDDEN_TYPES:
        choices = []  # leftover placeholders ("Click to write Choice 1") that a text box never shows
    if choices:
        record["choices" if qtype != "Matrix" else "rows"] = choices
        record["choice_order_note"] = "listed in display order (the export's ChoiceOrder)"
    answers = _choices(q, questions, "Answers", "AnswerOrder")
    if answers:
        record["columns"] = answers
    if isinstance(q.get("ColumnLabels"), list) and q["ColumnLabels"]:
        record["column_labels"] = [html_to_text(c.get("Display") if isinstance(c, dict) else c) for c in q["ColumnLabels"]]
    if qtype == "Slider" and isinstance(q.get("Configuration"), dict):
        config = q["Configuration"]
        record["scale"] = {k: config.get(k) for k in ("CSSliderMin", "CSSliderMax", "GridLines", "NumDecimals",
                                                      "SnapToGrid", "ShowValue") if k in config}
        labels = q.get("Labels") if isinstance(q.get("Labels"), dict) else {}
        # Numbered labels are the scale's anchors, in order; "NA" is the text of the separate opt-out box
        # (Configuration.NotApplicable), never a point on the scale.
        numbered = sorted((kv for kv in labels.items() if str(kv[0]).isdigit()), key=lambda kv: int(kv[0]))
        if numbered:
            record["scale"]["labels"] = [html_to_text(v.get("Display") if isinstance(v, dict) else v) for _, v in numbered]
        na = labels.get("NA")
        if str(config.get("NotApplicable", "")).lower() == "true" or na:
            text = html_to_text(na.get("Display") if isinstance(na, dict) else na) or "N/A"
            record["scale"]["not_applicable"] = text
            record["scale"]["not_applicable_note"] = (f"{text!r} is a separate opt-out box beside each slider; it is "
                                                      "not an anchor and not a value on the scale")
    images = _images(raw) + [img for c in choices for img in c.get("images", [])]
    if images:
        record["images"] = images
    rand = _randomisation(q)
    if rand:
        record["choice_randomisation"] = rand
    logic = _logic_record(q.get("DisplayLogic") or q.get("InPageDisplayLogic"), questions)
    if logic:
        record["display_logic"] = logic
    skips = q.get("SkipLogic")
    skips = list(skips.values()) if isinstance(skips, dict) else skips if isinstance(skips, list) else []
    if skips:
        record["skip_logic"] = [{
            "when": f'{_operand(s.get("ChoiceLocator") or s.get("Locator"), questions)} '
                    f'{OPERATORS.get(str(s.get("Condition")), str(s.get("Condition", "")))}'.strip(),
            "skip_to": s.get("SkipToDescription") or s.get("SkipToDestination")} for s in skips if isinstance(s, dict)]
    record["validation"] = _validation(q, questions)
    defaults = q.get("DefaultChoices")
    if defaults not in (None, False, "", [], {}):
        record["default_answer"] = defaults
    pipes = sorted(set(PIPE_RE.findall(str(raw)) + [p for c in choices for p in PIPE_RE.findall(c["text"])]))
    if pipes:
        record["piped_text"] = pipes
    if q.get("QuestionJS"):
        record["has_javascript"] = True
        notes.append(f"{qid} has JavaScript, which can hide, time or auto-advance it; read it before relying on this record")
    if isinstance(q.get("DynamicChoices"), dict):
        record["carry_forward"] = {"from": q["DynamicChoices"].get("Locator"),
                                   "note": "the options shown are carried forward from another question's answers"}
    if isinstance(q.get("SearchSource"), dict) and q["SearchSource"]:
        source = q["SearchSource"]
        record["autocomplete"] = {"free_response": str(source.get("AllowFreeResponse", "")).lower() == "true",
                                  "note": "the text box suggests entries from a Qualtrics list that is not in the "
                                          "export; label that list missing (a list elsewhere in the file, e.g. in "
                                          "the Trash block, is not this list)"}
    return record


# --------------------------------------------------------------------------- blocks and flow

def _block_record(block: dict, questions: dict[str, dict], notes: list[str]) -> tuple[dict, list[str]]:
    """The block as shown, and the question ids an advanced randomisation never displays."""
    options = block.get("Options") if isinstance(block.get("Options"), dict) else {}
    elements = [e for e in block.get("BlockElements") or [] if isinstance(e, dict)]
    order = [e["QuestionID"] for e in elements if e.get("Type") == "Question" and isinstance(e.get("QuestionID"), str)]
    pages: list[list[str]] = [[]]
    for element in elements:
        if element.get("Type") == "Page Break":
            if pages[-1]:
                pages.append([])
        elif element.get("Type") == "Question" and isinstance(element.get("QuestionID"), str):
            pages[-1].append(element["QuestionID"])
    pages = [p for p in pages if p]
    record: dict[str, Any] = {"id": block.get("ID"), "description": block.get("Description"),
                              "type": block.get("Type")}
    undisplayed: list[str] = []
    shuffled: list[str] = []
    mode = str(options.get("RandomizeQuestions", "false"))
    if mode == "Advanced":
        randomization = options.get("Randomization") if isinstance(options.get("Randomization"), dict) else {}
        advanced = randomization.get("Advanced") if isinstance(randomization.get("Advanced"), dict) else {}
        undisplayed = [q for q in advanced.get("Undisplayed") or [] if isinstance(q, str)]
        per_page = int(str(advanced.get("QuestionsPerPage") or 0) or 0) if str(advanced.get("QuestionsPerPage") or 0).isdigit() else 0
        record["question_randomisation"] = {
            "type": "advanced", "fixed_order": advanced.get("FixedOrder"),
            "randomize_all": advanced.get("RandomizeAll"), "random_subset": advanced.get("RandomSubSet"),
            "total_random_subset": advanced.get("TotalRandSubset"), "undisplayed": undisplayed,
            "questions_per_page": per_page,
            "even_presentation": bool(randomization.get("EvenPresentation")),
            "summary": "questions in fixed_order keep their place; each '{~Randomized~}' slot is filled with a "
                       "question from randomize_all in a new random order per participant"
                       + ("; random_subset questions are drawn at random" if advanced.get("RandomSubSet") else "")
                       + ("; undisplayed questions are never shown" if undisplayed else "")}
        fixed = advanced.get("FixedOrder") if isinstance(advanced.get("FixedOrder"), list) else []
        pool = iter([q for q in advanced.get("RandomizeAll") or [] if isinstance(q, str)])
        subset = [q for q in advanced.get("RandomSubSet") or [] if isinstance(q, str)]
        slots = []
        for slot in fixed:
            if slot == "{~Randomized~}":
                slot = next(pool, None)
            elif slot == "{~SubSet~}":
                slot = subset.pop(0) if subset else None  # drawn at random from random_subset
            if isinstance(slot, str) and slot not in undisplayed:
                slots.append(slot)
        shuffled = [q for q in advanced.get("RandomizeAll") or [] if isinstance(q, str)]
        shuffled += [q for q in advanced.get("RandomSubSet") or [] if isinstance(q, str)]
        record["question_randomisation"]["note"] = ("pages list the randomised questions in their base order; "
                                                    "their order among the randomised slots differs per participant")
        if per_page > 0 and slots:
            pages = [slots[i:i + per_page] for i in range(0, len(slots), per_page)]
            record["paging_note"] = (f"advanced randomisation sets {per_page} questions per page; Qualtrics uses that "
                                     "instead of the block's page breaks")
        else:
            record["paging_note"] = ("pages follow the block's page breaks; check them, because Qualtrics may lay out "
                                     "a randomised block differently")
    elif mode not in ("false", "", "None"):
        record["question_randomisation"] = {"type": mode, "options": {k: v for k, v in options.items()
                                                                      if "andom" in k},
                                            "summary": f"question randomisation {mode!r}: questions shown in random "
                                                       "order (see options for subset sizes)"}
        notes.append(f"block {block.get('ID')} uses question randomisation {mode!r}; its exact paging is not interpreted")
    looping = options.get("Looping")
    if looping not in (None, "None", "", False):
        record["loop_and_merge"] = {"looping": looping, "options": options.get("LoopingOptions")}
        notes.append(f"block {block.get('ID')} uses loop & merge ({looping}); repeats are not expanded here")
    record["question_order"] = order
    record["pages"] = []
    for i, page in enumerate(pages):
        entry: dict[str, Any] = {"page": i + 1, "questions": [q for q in page if q not in undisplayed]}
        if any(q in shuffled for q in entry["questions"]):
            entry["randomised"] = [q for q in entry["questions"] if q in shuffled]
        record["pages"].append(entry)
    record["questions"] = []
    for qid in order:
        if qid in undisplayed:
            continue
        if qid not in questions:
            notes.append(f"block {block.get('ID')} lists {qid}, which the export does not contain")
            continue
        record["questions"].append(_question(questions[qid], questions, notes))
    return record, undisplayed


def _embedded(element: dict) -> list[dict]:
    fields = []
    for field in element.get("EmbeddedData", []) if isinstance(element.get("EmbeddedData"), list) else []:
        if not isinstance(field, dict):
            continue
        source = field.get("Type")
        value = field.get("Value")
        fields.append({"field": field.get("Field") or field.get("Description"),
                       "value": value if source == "Custom" else None,
                       "set_by": "the survey flow" if source == "Custom" else
                                 "the panel, URL or Qualtrics (not set by the flow)" if source == "Recipient" else source})
    return fields


def _flow(elements: Any, questions: dict[str, dict], blocks: dict[str, dict], seen: list[str], notes: list[str]) -> list[dict]:
    out: list[dict] = []
    for element in elements if isinstance(elements, list) else []:
        if not isinstance(element, dict):
            continue
        kind = element.get("Type")
        flow_id = element.get("FlowID")
        if kind in ("Block", "Standard", "Default"):
            bid = element.get("ID")
            block = blocks.get(str(bid))
            node: dict[str, Any] = {"type": "block", "flow_id": flow_id, "block_id": bid,
                                    "description": block.get("Description") if block else None}
            if block is None:
                node["note"] = "this block is not in the export"
                notes.append(f"flow {flow_id} shows block {bid}, which the export does not contain")
            elif _is_trash(block):
                node["note"] = "the Trash block is never shown, even when the flow names it"
            elif bid not in seen:
                seen.append(str(bid))
            if element.get("Autofill"):
                node["autofill"] = element.get("Autofill")
            out.append(node)
        elif kind == "BlockRandomizer" or kind == "Randomizer":
            children = _flow(element.get("Flow"), questions, blocks, seen, notes)
            subset = element.get("SubSet")
            try:
                present = int(subset)
            except (TypeError, ValueError):
                present = len(children)
            even = bool(element.get("EvenPresentation"))
            if present >= len(children):
                summary = f"shows all {len(children)} elements below, in a random order for each participant"
            else:
                summary = (f"shows {present} of the {len(children)} elements below, chosen at random"
                           + (" (evenly presented: Qualtrics balances how often each is shown)" if even else
                              " (not evenly presented: a plain random draw)"))
            out.append({"type": "randomizer", "flow_id": flow_id, "present": present, "of": len(children),
                        "evenly": even, "summary": summary, "elements": children})
        elif kind == "Branch":
            logic = element.get("BranchLogic")
            out.append({"type": "branch", "flow_id": flow_id, "description": element.get("Description"),
                        "condition": render_logic(logic, questions),
                        "summary": "the elements below run only for participants who meet the condition",
                        "elements": _flow(element.get("Flow"), questions, blocks, seen, notes)})
        elif kind == "Group":
            out.append({"type": "group", "flow_id": flow_id, "description": element.get("Description"),
                        "elements": _flow(element.get("Flow"), questions, blocks, seen, notes)})
        elif kind == "EmbeddedData":
            out.append({"type": "embedded_data", "flow_id": flow_id, "fields": _embedded(element)})
        elif kind == "EndSurvey":
            options = element.get("Options") if isinstance(element.get("Options"), dict) else {}
            out.append({"type": "end_survey", "flow_id": flow_id, "termination": options.get("SurveyTermination"),
                        "message_id": options.get("EOSMessage"),
                        "note": "ends the survey here; a custom end message is in the account's message library, "
                                "not in the export"})
        else:
            node = {"type": str(kind), "flow_id": flow_id,
                    "note": f"flow element {kind!r} is not interpreted by this reader; read it in the export"}
            if "Flow" in element:
                node["elements"] = _flow(element.get("Flow"), questions, blocks, seen, notes)
            notes.append(f"flow {flow_id}: element type {kind!r} is reported but not interpreted")
            out.append(node)
    return out


def read_survey(data: dict) -> dict:
    notes: list[str] = []
    questions = _questions(data)
    blocks = _blocks(data)
    flows = _elements(data, "FL")
    entry = data.get("SurveyEntry") if isinstance(data.get("SurveyEntry"), dict) else {}
    options = next((e.get("Payload") for e in _elements(data, "SO") if isinstance(e.get("Payload"), dict)), {})
    entry = entry if isinstance(entry, dict) else {}
    seen: list[str] = []
    if not flows:
        notes.append("the export has no survey flow (FL element), so nothing can be confirmed as shown")
        flow: list[dict] = []
    else:
        payload = flows[0].get("Payload") if isinstance(flows[0].get("Payload"), dict) else {}
        flow = _flow(payload.get("Flow"), questions, blocks, seen, notes)
    reachable_blocks: dict[str, dict] = {}
    undisplayed: dict[str, str] = {}
    for bid in seen:
        record, hidden = _block_record(blocks[bid], questions, notes)
        reachable_blocks[bid] = record
        for qid in hidden:
            undisplayed[qid] = bid
    shown = {q["qid"] for b in reachable_blocks.values() for q in b["questions"]}
    block_of = {qid: bid for bid, b in blocks.items() for e in b.get("BlockElements") or []
                if isinstance(e, dict) for qid in [e.get("QuestionID")] if isinstance(qid, str)}
    not_blocks = []
    for bid, block in blocks.items():
        if bid in reachable_blocks:
            continue
        reason = ("the Trash / Unused Questions block: never shown to participants" if _is_trash(block)
                  else "not in the survey flow: never shown to participants")
        not_blocks.append({"id": bid, "description": block.get("Description"), "type": block.get("Type"),
                           "questions": [e.get("QuestionID") for e in block.get("BlockElements") or []
                                         if isinstance(e, dict) and e.get("QuestionID")], "reason": reason})
    not_questions = []
    for qid, q in questions.items():
        if qid in shown:
            continue
        bid = block_of.get(qid)
        if qid in undisplayed:
            reason = f"set as undisplayed by the advanced randomisation of block {undisplayed[qid]}"
        elif bid is None:
            reason = "in no block: never shown"
        elif _is_trash(blocks[bid]):
            reason = "in the Trash / Unused Questions block: never shown"
        else:
            reason = f"in block {bid} ({blocks[bid].get('Description')}), which the survey flow never shows"
        not_questions.append({"qid": qid, "tag": q.get("DataExportTag"), "block": bid, "reason": reason,
                              "text_plain": html_to_text(q.get("QuestionText"), markers=False),
                              "choices": [c["text_plain"] for c in _choices(q, questions, "Choices", "ChoiceOrder")],
                              "columns": [c["text_plain"] for c in _choices(q, questions, "Answers", "AnswerOrder")]})
    return {
        "reader": "qsf_flow.py", "reader_version": READER_VERSION,
        "survey": {"id": entry.get("SurveyID"), "name": entry.get("SurveyName"), "language": entry.get("SurveyLanguage"),
                   "options": {"back_button": str(options.get("BackButton", "")).lower() == "true",
                               "next_button": html_to_text(options.get("NextButton"), False) or None,
                               "previous_button": html_to_text(options.get("PreviousButton"), False) or None,
                               "progress_bar": options.get("ProgressBarDisplay")}},
        "flow": flow,
        "block_order": list(reachable_blocks),
        "blocks": reachable_blocks,
        "not_reachable": {"blocks": not_blocks, "questions": not_questions},
        "notes": sorted(set(notes)),
    }


def read_qsf(path: Path) -> dict:
    return read_survey(load_qsf(path))


def correct_answer_checks(report: dict) -> list[dict]:
    """Every question participants saw that accepts only a correct answer (custom validation).

    This holds whether or not the response is forced: Qualtrics refuses any other
    answer, and an empty one, until the participant chooses a correct option. A
    package asks each of these with the correct options as its ``key``.
    """
    checks = []
    for block in (report.get("blocks") or {}).values():
        for question in block.get("questions") or []:
            correct = (question.get("validation") or {}).get("correct_choices")
            if not correct:
                continue
            by_id = {c.get("id"): c for c in question.get("choices") or [] if isinstance(c, dict)}
            checks.append({
                "qid": question.get("qid"), "tag": question.get("tag"), "text": question.get("text_plain") or "",
                "options": [c.get("text_plain", "") for c in question.get("choices") or [] if isinstance(c, dict)],
                "correct": [by_id.get(c.get("id"), {}).get("text_plain") or html_to_text(c.get("text"), markers=False)
                            for c in correct],
                "response": (question.get("validation") or {}).get("response"),
            })
    return checks


# --------------------------------------------------------------------------- reachable text (validator)

def _record_texts(record: dict) -> list[str]:
    texts = [record.get("text_plain") or ""]
    for key in ("choices", "rows", "columns"):
        for item in record.get(key, []) or []:
            texts.append(item.get("text_plain", "") if isinstance(item, dict) else str(item))
    texts += [html_to_text(t, False) for t in record.get("column_labels", []) or []]
    labels = (record.get("scale") or {}).get("labels") if isinstance(record.get("scale"), dict) else None
    texts += [html_to_text(t, False) for t in labels or []]
    if isinstance(record.get("scale"), dict) and record["scale"].get("not_applicable"):
        texts.append(record["scale"]["not_applicable"])
    message = (record.get("validation") or {}).get("message_description")
    if message:
        texts.append(message)
    return [t for t in texts if t]


def text_sets(report: dict) -> tuple[list[str], list[tuple[str, str, str]]]:
    """Texts participants could see, and (text, qid, reason) for texts they never saw."""
    reachable = [t for b in report["blocks"].values() for q in b["questions"] for t in _record_texts(q)]
    unreachable: list[tuple[str, str, str]] = []
    for q in report["not_reachable"]["questions"]:
        for text in [q.get("text_plain") or ""] + list(q.get("choices", [])) + list(q.get("columns", [])):
            if text:
                unreachable.append((text, q["qid"] + (f" ({q['tag']})" if q.get("tag") else ""), q["reason"]))
    return reachable, unreachable


# Package keys under which a build may list what it left out, by id (never as participant material).
EXCLUDED_KEY_RE = re.compile(r"(?i)(not[_ -]?(shown|reachable|transcribed|used|in[_ -]?flow)|unused|excluded|"
                             r"unreachable|trash|omitted)")
# An item can say so itself: {"qsfReachability": "not-shown"} (or "shown": false).
MARKER_KEY = "qsfReachability"
MARKER_VALUE = "not-shown"
ITEM_LABEL_KEYS = ("origin", "evidence_label", "evidenceLabel", "label")
ITEM_LABELS = ("verbatim", "reported", "derived", "missing", "researcher", "implementation", "unknown")
# Keys that describe an item rather than hold what participants read.
METADATA_KEYS = frozenset((
    "id", "ids", "what", "note", "notes", "reason", "rationale", "derivation", "comment",
    "comments", "why", "kind", "type", "tag", "qsfTag", "qsfId", "qid", "study", "studyIds", "arm",
    "evidence", "evidenceIds", "locator", "sourceId", "sourceIds", "source", "sourceFile", "path", "file",
    "version", "versionUsed", "status", "origin", "state", "evidenceLabel", "label_source", "sha256"))
SOURCE_ID_KEYS = ("sourceId", "sourceIds", "source")
SOURCE_PATH_KEYS = ("sourceFile", "path", "file", "source")
MIN_WORDS = 5  # shorter strings ("Not at all", "Very good") are too common to attribute to one question


def _squash(text: str) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", " ", text)).replace("*", "")
    text = (text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
            .replace("–", "-").replace("—", "-").replace("\xa0", " "))
    return re.sub(r"\s+", "", text).casefold()


def _words(text: str) -> int:
    return len(re.findall(r"\w+", text))


class _Reach:
    """What one survey's flow shows, for asking whether a package string was ever shown."""

    def __init__(self, report: dict):
        reachable, unreachable = text_sets(report)
        self.reachable = "\x00".join(_squash(t) for t in reachable)
        # Unused copies of text the flow also shows are not evidence of anything.
        self.unreachable = [(_squash(t), qid, reason) for t, qid, reason in unreachable
                            if _words(t) >= MIN_WORDS and _squash(t) not in self.reachable]
        shown = [q for b in report["blocks"].values() for q in b["questions"]]
        # Screens participants saw with pictures, sliders with an opt-out box, questions shown only after an answer.
        self.images = [q for q in shown if q.get("images")]
        self.opt_outs = [q for q in shown if isinstance(q.get("scale"), dict) and q["scale"].get("not_applicable")]
        self.conditional = [q for q in shown if (q.get("display_logic") or {}).get("depends_on_questions")]
        self.tags = {q["qid"]: q.get("tag") for q in shown}
        self.shown_questions = shown
        # lines (8+ words) that only one shown question carries: boilerplate ("You will be able to advance the page
        # shortly") never ties a package string to one screen
        counts: dict[str, int] = {}
        for q in shown:
            for line in {_squash(x) for x in (q.get("text_plain") or "").split("\n") if _words(x) >= 8}:
                counts[line] = counts.get(line, 0) + 1
        self.unique_lines = {line for line, n in counts.items() if n == 1}
        self.shown_texts = [_squash(q.get("text_plain") or "") for q in shown]

    def matches(self, question: dict, text: str, ancestors: list) -> bool:
        """The package string (or an item above it, by question id or export tag) is this question's text."""
        for item in ancestors:
            for key in SELECTOR_KEYS + ("tag", "qsfTag"):
                if item.get(key) and item.get(key) in (question.get("qid"), question.get("tag")):
                    return True
        hay = _squash(text)
        if not hay:
            return False
        whole = question.get("text_plain") or ""
        needles = [whole] if _words(whole) >= MIN_WORDS and "${" not in whole else []
        needles += [line for line in whole.split("\n") if _words(line) >= 8 and "${" not in line
                    and _squash(line) in self.unique_lines]
        if any(_squash(n) in hay for n in needles if _squash(n)):
            return True
        return _words(text) >= MIN_WORDS + 3 and len(hay) >= 40 and hay in _squash(whole) \
            and sum(hay in s for s in self.shown_texts) == 1

    def shown(self, text: str) -> bool:
        """Text of at least MIN_WORDS words that a question participants saw carries."""
        return _words(text) >= MIN_WORDS and _squash(text) in self.reachable

    def never_shown(self, text: str) -> tuple[str, str] | None:
        """(qid, reason) when text is survey wording only an unreachable question carries."""
        pieces = [text] + [line for line in re.split(r"\n+", text) if line.strip() != text.strip()]
        for piece in pieces:
            if _words(piece) < MIN_WORDS:
                continue
            needle = _squash(piece)
            if not needle or needle in self.reachable:
                continue
            for hay, qid, reason in self.unreachable:
                if needle in hay or (len(hay) >= 25 and hay in needle):
                    return qid, reason
        return None


MIXED_VALUE = "mixed"  # holds shown text and never-shown text; a person checks it (state "check")
SELECTOR_KEYS = ("id", "qsfId", "qid")  # export tags are not unique (Trash copies reuse them)


def _marked_not_shown(node: dict) -> bool:
    return node.get(MARKER_KEY) == MARKER_VALUE


def _marked_mixed(node: dict) -> bool:
    return node.get(MARKER_KEY) == MIXED_VALUE and node.get("state") == "check"


def _is_item(node: Any) -> bool:
    """An object the repair guard tracks on its own (it carries an evidence label or a state)."""
    return isinstance(node, dict) and (any(node.get(k) in ITEM_LABELS for k in ITEM_LABEL_KEYS)
                                       or node.get("state") in ("confirmed", "check", "missing", "decision"))


def _own_strings(item: dict) -> list[str]:
    """Participant strings of one item, not counting nested items (the guard judges those separately)."""
    out: list[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, str):
            out.append(value)
        elif isinstance(value, dict):
            for key, child in value.items():
                if key in METADATA_KEYS or EXCLUDED_KEY_RE.search(str(key)) or key == MARKER_KEY or _is_item(child):
                    continue
                walk(child)
        elif isinstance(value, list):
            for child in value:
                if not _is_item(child):
                    walk(child)

    walk({k: v for k, v in item.items()})
    return out


def _ids_marked_not_shown(materials: Any) -> list[str]:
    ids: list[str] = []

    def walk(value: Any, excluded: bool) -> None:
        if isinstance(value, dict):
            if excluded or _marked_not_shown(value):
                ids.extend(value[k] for k in SELECTOR_KEYS if isinstance(value.get(k), str) and value[k])
            for key, child in value.items():
                walk(child, excluded or bool(EXCLUDED_KEY_RE.search(str(key))))
        elif isinstance(value, list):
            for child in value:
                if isinstance(child, str) and excluded:
                    ids.append(child)
                else:
                    walk(child, excluded)

    walk(materials, False)
    return ids


def _text_strings(value: Any, path: str) -> Iterable[tuple[str, str]]:
    """Strings participants would read: skips metadata keys, left-out lists and items marked not shown."""
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        if _marked_not_shown(value) or _marked_mixed(value):
            return
        for key, item in value.items():
            if not EXCLUDED_KEY_RE.search(str(key)) and key not in METADATA_KEYS:
                yield from _text_strings(item, f"{path}.{key}" if path else str(key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _text_strings(item, f"{path}[{index}]")



def _mixed_items(value: Any, path: str = "") -> list[tuple[str, dict]]:
    found: list[tuple[str, dict]] = []
    if isinstance(value, dict):
        if _marked_mixed(value):
            found.append((path, value))
        for key, child in value.items():
            found += _mixed_items(child, f"{path}.{key}" if path else str(key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found += _mixed_items(child, f"{path}[{index}]")
    return found


def _unchecked_mixed(value: Any, path: str = "") -> list[str]:
    """Paths of objects marked "mixed" without state check."""
    found: list[str] = []
    if isinstance(value, dict):
        if value.get(MARKER_KEY) == MIXED_VALUE and value.get("state") != "check":
            found.append(path)
        for key, child in value.items():
            found += _unchecked_mixed(child, f"{path}.{key}" if path else str(key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found += _unchecked_mixed(child, f"{path}[{index}]")
    return found


# --------------------------------------------------------------------------- package check (desktop project layout)

SOURCES_DIR = "sources"
PACKAGE_DIR = "package"


def _load_json(path: Path) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _norm(rel: Any) -> str:
    """A cited path as a project path: no fragment, no leading ./ or ../ (a package cites ../../sources/...)."""
    if not isinstance(rel, str) or not rel.strip():
        return ""
    rel = posixpath.normpath(rel.strip().replace("\\", "/").split("#", 1)[0])
    while rel.startswith("../"):
        rel = rel[3:]
    return "" if rel in (".", "..") else rel.lstrip("/")


def qsf_files(root: Path) -> list[str]:
    """Every .qsf under sources/ (open, private, researcher), as project paths."""
    base = Path(root) / SOURCES_DIR
    if not base.is_dir():
        return []
    return sorted(p.relative_to(root).as_posix() for p in base.rglob("*")
                  if p.suffix.lower() == ".qsf" and p.is_file() and not p.is_symlink())


def survey_reaches(root: Path) -> dict[str, _Reach]:
    """Per .qsf with a survey flow (project path): what its flow shows. Exports the reader cannot follow are skipped."""
    reach: dict[str, _Reach] = {}
    for rel in qsf_files(root):
        try:
            data = load_qsf(Path(root) / rel)
            if not _elements(data, "FL"):
                continue  # without a survey flow nothing can be judged unreachable
            reach[rel] = _Reach(read_survey(data))
        except Exception:  # never a build failure: an export this reader cannot follow is skipped
            continue
    return reach


def _namer(reach: dict[str, _Reach]):
    """name(value) -> the .qsf it names (by project path, or by file name when that is unique), else None."""
    by_base: dict[str, list[str]] = {}
    for rel in reach:
        by_base.setdefault(posixpath.basename(rel).casefold(), []).append(rel)

    def name(value: Any) -> str | None:
        rel = _norm(value)
        if not rel:
            return None
        if rel in reach:
            return rel
        hits = by_base.get(posixpath.basename(rel).casefold(), [])
        return hits[0] if len(hits) == 1 and "/" not in rel else None

    return name


def _evidence_paths(program: Any) -> dict[str, str]:
    evidence = program.get("evidence") if isinstance(program, dict) else None
    return {e["id"]: _norm(e.get("path")) for e in evidence if isinstance(e, dict) and isinstance(e.get("id"), str)} \
        if isinstance(evidence, list) else {}


def _program_fields(program: Any) -> Iterable[tuple[dict, dict]]:
    nodes = program.get("nodes") if isinstance(program, dict) else None
    for node in nodes if isinstance(nodes, list) else []:
        fields = node.get("fields") if isinstance(node, dict) else None
        for field in fields if isinstance(fields, list) else []:
            if isinstance(field, dict):
                yield node, field


def _declared(node: dict, evidence: dict[str, str]) -> set[str]:
    """The sources an object declares (normalised). Ids always count; a path counts when it names a source file
    (under sources/, or a PDF); evidenceIds count by the path their evidence cites."""
    refs: set[str] = set()
    for key in set(SOURCE_ID_KEYS) | set(SOURCE_PATH_KEYS):
        value = node.get(key)
        for item in value if isinstance(value, list) else [value]:
            candidates: list[tuple[str, str]] = []
            if isinstance(item, str):
                candidates = [(key, item)]
            elif isinstance(item, dict):
                candidates = [(k, v) for k, v in item.items() if k in ("id", "sourceId", "path") and isinstance(v, str)]
            for k, v in candidates:
                rel = _norm(v)
                if rel and (k in SOURCE_ID_KEYS or k == "id" or rel.startswith(SOURCES_DIR + "/")
                            or rel.lower().endswith((".pdf", ".qsf"))):
                    refs.add(rel)
    for eid in _id_list(node.get("evidenceIds")):
        if evidence.get(eid):
            refs.add(evidence[eid])
    return refs


def _scoped(value: Any, path: str, scope_of, inherited: frozenset) -> Iterable[tuple[str, str, frozenset]]:
    """(path, text, the .qsf files in scope) for participant strings; the nearest declared source decides."""
    if isinstance(value, dict):
        if _marked_not_shown(value) or _marked_mixed(value):
            return
        declared = scope_of(value)
        scope = declared if declared is not None else inherited
        for key, item in value.items():
            if EXCLUDED_KEY_RE.search(str(key)) or key in METADATA_KEYS or key == MARKER_KEY:
                continue
            child = f"{path}.{key}" if path else str(key)
            if isinstance(item, str):
                if scope:
                    yield child, item, scope
            else:
                yield from _scoped(item, child, scope_of, scope)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            if isinstance(item, str):
                if inherited:
                    yield f"{path}[{index}]", item, inherited
            else:
                yield from _scoped(item, f"{path}[{index}]", scope_of, inherited)


def _literals(adapter: Path) -> list[tuple[int, str]]:
    import ast
    try:
        tree = ast.parse(adapter.read_text(encoding="utf-8"))
    except (OSError, SyntaxError, ValueError):
        return []
    return [(n.lineno, n.value) for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)]


def _references(pkg: Path, program: Any) -> set[str]:
    """Every string the run uses to pick material: adapter literals, task/task.json and program.json steps."""
    refs = {text for _, text in _literals(pkg / "task/adapter.py")}

    def walk(value: Any) -> None:
        if isinstance(value, str):
            refs.add(value)
        elif isinstance(value, dict):
            for key, child in value.items():
                if not EXCLUDED_KEY_RE.search(str(key)):
                    walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(_load_json(pkg / "task/task.json"))
    walk(program.get("steps") if isinstance(program, dict) else None)
    return refs


def _packages(root: Path, package: Path | None) -> list[Path]:
    if package is not None:
        return [Path(package)]
    base = Path(root) / PACKAGE_DIR
    return sorted(p for p in base.iterdir() if p.is_dir() and not p.is_symlink()) if base.is_dir() else []


FIX_UNREACHABLE = ("take it out of the participant material; to keep it on record, move it under notShown or mark its "
                   "item \"qsfReachability\": \"not-shown\"; if the paper says participants saw it, ask the researcher "
                   "about the difference (Survey files)")


def _id_list(value: Any) -> list[str]:
    """The string ids of an evidenceIds list; anything else (a string, a number, a mapping) holds none."""
    return [i for i in value if isinstance(i, str)] if isinstance(value, list) else []


def problems(root: Path, package: Path | None = None) -> list[tuple[str, str]]:
    """Survey text only unreachable questions carry, and items marked never shown, kept out of the run.

    root is the project folder; package is package/<slug> (default: every folder under package/). Returns
    [(message, fix)]; empty when the project has no .qsf with a survey flow. A record of a shape the check
    does not expect never crashes it: the failure is one problem line, not a traceback.
    """
    return findings(root, package)[0]


def findings(root: Path, package: Path | None = None) -> tuple:
    """(problems, warnings). The transcription rules (pictures, opt-out boxes, display logic) came with build
    contract 3: below study.json buildContract 3 (the package given, else any package of the project) their
    findings are warnings, so a project that was ready stays ready."""
    here = str(Path(__file__).resolve().parent)
    if here not in sys.path:
        sys.path.insert(0, here)
    import contract
    strict = contract.rules_level(root, package)
    older: list = []
    try:
        found = _problems(root, package, None if strict else older)
        return found, [(m + contract.OLDER_THAN_3, h) for m, h in older]
    except Exception as exc:  # noqa: BLE001  a malformed project must not stop the package check
        return [("the survey-flow check could not complete (%s: %s)" % (type(exc).__name__, str(exc)[:160]),
                 "check program.json and materials/materials.json for records of the wrong shape (check_program.py "
                 "names them); if they are fine, report this with the .qsf")], []


# Declaring what a transcription leaves out: a key such as "images" / "figure" with a value, a note that names the
# picture, or a capabilities.json run.excluded / task.json replayAdaptations entry that names it (by question id or
# export tag, or by an arm the item belongs to).
IMAGE_KEY_RE = re.compile(r"(?i)imag|figure|picture|graphic|\bimg|photo|media|visual")
IMAGE_WORD_RE = re.compile(r"(?i)\b(images?|pictures?|photos?|photographs?|figures?|graphics?|charts?|flags?|logos?|"
                           r"drawings?|illustrations?|graphs?|maps?|ladder)\b")
LOGIC_KEY_RE = re.compile(r"(?i)display.?logic|shown?.?(if|when|after)|only.?(if|when|after)|^conditions?$|condition$|"
                          r"depends|branch|logic")
LOGIC_WORD_RE = re.compile(r"(?i)\b(only (if|when|after)|shown (if|when|after|only)|display logic|"
                           r"if (they|the participant|participants) (chose|answered|selected|said|ticked))\b")
NOTE_KEYS = ("note", "notes", "what", "why", "reason", "label", "comment", "comments", "adaptation", "adaptations",
             "missing", "dropped", "replayAdaptation", "replayAdaptations", "description")


def _items_with_parents(value: Any, path: str = "", parents: tuple = ()) -> Iterable[tuple[str, str, list]]:
    """(path, text, the dicts above it, nearest first) for every participant string; metadata and left-out keys
    are skipped as in _text_strings."""
    if isinstance(value, str):
        yield path, value, list(reversed(parents))
    elif isinstance(value, dict):
        if _marked_not_shown(value):
            return
        for key, item in value.items():
            if not EXCLUDED_KEY_RE.search(str(key)) and key not in METADATA_KEYS and key not in NOTE_KEYS:
                yield from _items_with_parents(item, f"{path}.{key}" if path else str(key), parents + (value,))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _items_with_parents(item, f"{path}[{index}]", parents)


def _truthy(value: Any) -> bool:
    return value not in (None, False, "", [], {}, 0)


def _declares(ancestors: list, key_re, word_re) -> bool:
    """The item or the object right above it says so (a note at the top of a file is not about one screen)."""
    for item in ancestors[:2]:
        for key, value in item.items():
            if key_re.search(str(key)) and (value is True if re.match(r"(?i)has", str(key)) else _truthy(value)):
                return True
            if key in NOTE_KEYS and any(word_re.search(s) for s in _strings_in(value)):
                return True
    return False


def _strings_in(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in _strings_in(v)]
    if isinstance(value, list):
        return [s for v in value for s in _strings_in(v)]
    return []


def _declarations(root: Path, pkg: Path | None) -> list[tuple[str, frozenset]]:
    """(text, arms) of every run.excluded entry and replayAdaptations entry: what the build says it left out."""
    out = []
    caps = _load_json(Path(root) / "capabilities.json")
    run = caps.get("run") if isinstance(caps, dict) and isinstance(caps.get("run"), dict) else {}
    for entry in run.get("excluded") or [] if isinstance(run.get("excluded"), list) else []:
        if isinstance(entry, dict):
            arms = entry.get("arms") if isinstance(entry.get("arms"), list) else []
            out.append((" ".join(_strings_in({k: v for k, v in entry.items() if k != "arms"})),
                        frozenset(str(a) for a in arms)))
    task = _load_json(pkg / "task/task.json") if pkg is not None else None
    adaptations = task.get("replayAdaptations") if isinstance(task, dict) else None
    for entry in adaptations if isinstance(adaptations, list) else []:
        arms = entry.get("arms") if isinstance(entry, dict) and isinstance(entry.get("arms"), list) else []
        out.append((" ".join(_strings_in(entry)), frozenset(str(a) for a in arms)))
    return out


def _declared_elsewhere(question: dict, where: str, declarations, word_re) -> bool:
    segments = set(re.split(r"[.\[\]\s/]+", where))
    names = {question.get("qid"), question.get("tag")} - {None, ""}
    # a distinctive part of the item's path ("joint" in studies.s2.joint) named in the entry
    words = {s for s in segments if re.fullmatch(r"[A-Za-z][\w-]{3,}", s) and not GENERIC_PATH_RE.fullmatch(s)}
    for text, arms in declarations:
        if not word_re.search(text):
            continue
        if arms & segments or any(re.search(r"(?<![\w-])%s(?![\w-])" % re.escape(str(n)), text) for n in names | words
                                  if n):
            return True
    return False


GENERIC_PATH_RE = re.compile(r"(?i)pages?\d*|texts?|questions?|items?|studies|study|shared|conditions?|arms?|screens?|"
                             r"materials?|values?|blocks?|options?|choices?|anchors?|labels?|instructions?|json|"
                             r"program|package|high|low|control")


def _transcription_problems(root: Path, reach: dict, program: dict, packages: list[Path]) -> list[tuple[str, str]]:
    """Pictures, opt-out boxes and display logic of shown questions that a transcription drops without saying so."""
    sources: list[tuple[str, Any, Path | None]] = []   # (label, value, package)
    nodes = program.get("nodes") if isinstance(program.get("nodes"), list) else []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        for field in node.get("fields") if isinstance(node.get("fields"), list) else []:
            if isinstance(field, dict) and not _marked_not_shown(field):
                # the node's other fields count as items above the value (a sibling "figure" field declares it)
                siblings = {f.get("id"): True for f in node["fields"] if isinstance(f, dict) and f is not field
                            and f.get("state") == "missing"}
                material = (field.get("extensions") or {}).get("material") if isinstance(field.get("extensions"), dict) else None
                holder = dict({k: v for k, v in siblings.items() if isinstance(k, str)}, **({"note": material.get("what")}
                              if isinstance(material, dict) and material.get("what") else {}))
                sources.append((f"program.json {node.get('id')}.{field.get('id')}", {"value": field.get("value"),
                                "_declared": holder or {}}, None))
    for pkg in packages:
        label = pkg.relative_to(root).as_posix() if pkg.resolve().is_relative_to(root) else pkg.name
        materials = _load_json(pkg / "materials/materials.json")
        if materials is not None:
            sources.append((f"{label}/materials/materials.json", materials, pkg))
    out: list[tuple[str, str]] = []
    adapters = {pkg: {t for _, t in _literals(pkg / "task/adapter.py")} for pkg in packages}
    seen: set[tuple] = set()
    for label, value, pkg in sources:
        declarations = _declarations(root, pkg if pkg is not None else (packages[0] if packages else None))
        strings = list(_items_with_parents(value))
        if isinstance(value, dict) and "_declared" in value:   # a program field: its node's missing fields count
            strings = [(p, t, [value["_declared"]] + a) for p, t, a in strings if not p.startswith("_declared")]
        for rel, r in reach.items():
            for q in r.images:
                hits = [(p, t, a) for p, t, a in strings if r.matches(q, t, a)]
                undeclared = [(p, t, a) for p, t, a in hits if not _declares(a, IMAGE_KEY_RE, IMAGE_WORD_RE)
                              and not _declared_elsewhere(q, f"{label} {p}", declarations, IMAGE_WORD_RE)]
                if undeclared and (label, undeclared[0][0], "img") not in seen:
                    seen.add((label, undeclared[0][0], "img"))
                    srcs = ", ".join(_short(i.get("alt") or i.get("src") or "?", 60) for i in q["images"][:2])
                    out.append((f"{label} {undeclared[0][0]} transcribes {q['qid']} ({q.get('tag')}) of {rel}, a screen "
                                f"that also shows {len(q['images'])} picture(s) ({srcs}), but declares no picture"
                                + (f" ({len(undeclared)} places)" if len(undeclared) > 1 else ""),
                                "the replay shows the text without the picture: add it from an open copy, or declare "
                                "it (an `images`/`figure` entry with state missing on the item, or a capabilities.json "
                                "run.excluded entry naming the question or its arms) and never call the screen complete"))
            for p, item, parent in _lists(value):
                texts = [str(x).strip().casefold() for x in item if isinstance(x, str)]
                candidates = [q for q in r.opt_outs if q["scale"]["not_applicable"].strip().casefold() in texts
                              and {str(x).strip().casefold() for x in q["scale"].get("labels") or []} & set(texts)]
                # the slider the item names (by id or tag) first; otherwise the first with these anchors
                candidates.sort(key=lambda q: not r.matches(q, "", [parent]))
                for q in candidates[:1]:
                    if (label, p, "na") not in seen:
                        seen.add((label, p, "na"))
                        out.append((f"{label} {p} lists {q['scale']['not_applicable']!r} among the anchors of "
                                    f"{q['qid']} ({q.get('tag')}): in the survey it is a separate opt-out box, not a "
                                    f"point on the {q['scale'].get('CSSliderMin', 0)}-{q['scale'].get('CSSliderMax', 100)} "
                                    f"scale (anchors: {', '.join(q['scale'].get('labels') or [])})",
                                    "keep the anchors as the survey numbers them and give the opt-out its own key "
                                    "(e.g. \"optOut\": \"Not Applicable\"); never put it at the low end of the scale"))
            for q in r.conditional:
                if _words(q.get("text_plain") or "") < MIN_WORDS:
                    continue
                # the adapter names the question the condition reads by its id (a tag is also how it fetches text)
                literals = adapters.get(pkg, set()) if pkg is not None else set().union(*adapters.values()) \
                    if adapters else set()
                if set(q["display_logic"]["depends_on_questions"]) & literals:
                    continue
                hits = [(p, t, a) for p, t, a in strings if r.matches(q, t, a)
                        and not _declares(a, LOGIC_KEY_RE, LOGIC_WORD_RE)]
                controllers = [c for c in r.shown_questions if c["qid"] in q["display_logic"]["depends_on_questions"]]
                ctrl_hits = [p for p, t, a in strings for c in controllers if r.matches(c, t, a)]
                # Decidable cases only: the question it depends on is not transcribed at all, or both are asked in
                # one prompt (items of one questions/items list, or one object), so the answer cannot gate it.
                # Separate pages may be gated by the adapter's own loop (a chain of "continue?" screens) and are
                # left to the reviewer.
                if set(p for p, _, _ in hits) & set(ctrl_hits):
                    continue   # the two questions carry the same text: the package string cannot tell them apart
                hits = [h for h in hits if any(_same_screen(h[0], c) for c in ctrl_hits)] if ctrl_hits else hits
                if hits and (label, rel, q["qid"], "logic") not in seen:
                    seen.add((label, rel, q["qid"], "logic"))
                    out.append((f"{label} {hits[0][0]} transcribes {q['qid']} ({q.get('tag')}) of {rel}, which the "
                                f"survey shows only if {_short(q['display_logic']['condition'], 140)}; "
                                + ("it is asked in the same prompt as that question, so the answer cannot decide it"
                                   if ctrl_hits else "nothing on the item or in the adapter says so"),
                                "show it only under that condition (the adapter reads the earlier answer) and record "
                                "the condition on the item (\"shownIf\": ...); qsf_flow.py's outline prints it"))
    return out


SCREEN_LIST_RE = re.compile(r"(?i)(^|[._])(questions?|items?|fields?|prompts?)$")


def _same_screen(a: str, b: str) -> bool:
    """Two package paths are asked in one prompt: items of one questions/items list, or strings of one object.
    One string (the same text for both questions) decides nothing."""
    if a == b:
        return False
    ma, mb = re.match(r"^(.*)\[\d+\](.*)$", a), re.match(r"^(.*)\[\d+\](.*)$", b)
    if ma and mb and ma.group(1) == mb.group(1) and SCREEN_LIST_RE.search(ma.group(1).rsplit(".", 1)[-1]):
        return True
    return a.rsplit(".", 1)[0] == b.rsplit(".", 1)[0] and "." in a


def _lists(value: Any, path: str = "", parent: dict | None = None) -> Iterable[tuple[str, list, dict]]:
    """(path, list, the dict holding it) for every list in a value."""
    if isinstance(value, dict):
        for key, item in value.items():
            yield from _lists(item, f"{path}.{key}" if path else str(key), value)
    elif isinstance(value, list):
        yield path, value, parent or {}
        for index, item in enumerate(value):
            yield from _lists(item, f"{path}[{index}]", parent)


def _problems(root: Path, package: Path | None, older: list | None = None) -> list[tuple[str, str]]:
    root = Path(root).resolve()
    reach = survey_reaches(root)
    if not reach:
        return []
    name = _namer(reach)
    program = _load_json(root / "program.json")
    program = program if isinstance(program, dict) else {}
    evidence = _evidence_paths(program)
    out: list[tuple[str, str]] = []
    hits: dict[tuple[str, str], list] = {}

    def report(where: str, text: str, rels: Iterable[str]) -> None:
        for rel in rels:
            hit = reach[rel].never_shown(text)
            if hit:
                item = re.match(r"^(.*?\[\d+\])", where)
                key = (item.group(1) if item else where, f"{hit[0]} of {rel}")
                hits.setdefault(key, [hit[1], text, 0])[2] += 1
                return

    # program.json fields whose evidence cites a .qsf
    for node, field in _program_fields(program):
        if _marked_not_shown(field) or _marked_mixed(field):
            continue
        cited = {name(evidence.get(e)) for e in _id_list(field.get("evidenceIds"))}
        material = (field.get("extensions") or {}).get("material") if isinstance(field.get("extensions"), dict) else None
        if isinstance(material, dict):
            cited.add(name(material.get("file")))
        rels = sorted(r for r in cited if r)
        if rels:
            for _, text in _text_strings(field.get("value"), ""):
                report(f"program.json {node.get('id')}.{field.get('id')}", text, rels)

    def scope_of(node: dict) -> frozenset | None:
        declared = _declared(node, evidence)
        return frozenset(r for r in map(name, declared) if r) if declared else None

    marked_fields: list[str] = []
    for node, field in _program_fields(program):
        if _marked_not_shown(field):
            marked_fields += [field[k] for k in ("qsfId", "qid") if isinstance(field.get(k), str) and field[k]]
            marked_fields.append(f"{node.get('id')}.{field.get('id')}")
    mixed = [(f"program.json {n.get('id')}.{f.get('id')}", {"value": f.get("value")})
             for n, f in _program_fields(program) if _marked_mixed(f)]
    unchecked = [f"program.json {n.get('id')}.{f.get('id')}" for n, f in _program_fields(program)
                 if f.get(MARKER_KEY) == MIXED_VALUE and f.get("state") != "check"]

    for pkg in _packages(root, package):
        label = pkg.relative_to(root).as_posix() if pkg.resolve().is_relative_to(root) else pkg.name
        materials = _load_json(pkg / "materials/materials.json")
        if materials is not None:
            for where, text, rels in _scoped(materials, "", scope_of, frozenset()):
                report(f"{label}/materials/materials.json {where}", text, sorted(rels))
            mixed += [(f"{label}/materials/materials.json {p}".rstrip(), v) for p, v in _mixed_items(materials)]
            unchecked += [f"{label}/materials/materials.json {p}".rstrip() for p in _unchecked_mixed(materials)]
        for line, text in _literals(pkg / "task/adapter.py"):
            if _words(text) >= MIN_WORDS:
                report(f"{label}/task/adapter.py line {line}", text, sorted(reach))
        used = _references(pkg, program)
        marked = list(dict.fromkeys((_ids_marked_not_shown(materials) if materials is not None else []) + marked_fields))
        for item_id in marked:
            if item_id in used:
                out.append((f"{label}: item {item_id!r} is marked as never shown in the survey (or listed as left "
                            "out), but task/adapter.py, task/task.json or the program steps still use it",
                            "the run must not show it: remove the reference, or, if participants did see it, drop "
                            "the marker and cite the shown question"))

    for where in dict.fromkeys(unchecked):
        out.append((f"{where} is marked \"qsfReachability\": \"mixed\" without state \"check\"",
                    "give the item state check and ask the researcher one plain question about it"))
    for where, item in mixed:
        own = _own_strings({k: v for k, v in item.items() if k not in (MARKER_KEY, "state")})
        if not any(r.shown(text) for text in own for r in reach.values()):
            out.append((f"{where} is marked \"qsfReachability\": \"mixed\" but holds no text participants saw",
                        "an item with only never-shown text is removed or marked \"not-shown\""))
    for (where, qid), (reason, text, count) in hits.items():
        more = f" and {count - 1} more of its strings" if count > 1 else ""
        out.append((f"{where} uses survey text from {qid}, which participants never saw ({reason}; see qsf_flow.py's "
                    f"not_reachable list): {_short(text, 70)!r}{more}", FIX_UNREACHABLE))
    (out if older is None else older).extend(_transcription_problems(root, reach, program, _packages(root, package)))
    return out




# --------------------------------------------------------------------------- outline

def outline(report: dict) -> str:
    lines = [f"Survey {report['survey'].get('name')!r} ({report['survey'].get('id')}): flow in order",
             f"Back button: {'yes' if report['survey']['options']['back_button'] else 'no'}", ""]
    blocks = report["blocks"]

    def walk(nodes: list[dict], depth: int) -> None:
        pad = "  " * depth
        for node in nodes:
            kind = node["type"]
            if kind == "block":
                block = blocks.get(node["block_id"])
                lines.append(f"{pad}- Block {node['description']!r} [{node['block_id']}]"
                             + (f" — {node['note']}" if node.get("note") else ""))
                if block and node.get("block_id") and not node.get("_printed"):
                    rand = block.get("question_randomisation")
                    if rand:
                        lines.append(f"{pad}    question order: {rand['summary']}")
                        if rand.get("fixed_order"):
                            lines.append(f"{pad}    fixed_order {rand['fixed_order']}, randomize_all {rand.get('randomize_all')}")
                    by_id = {q["qid"]: q for q in block["questions"]}
                    for page in block["pages"]:
                        lines.append(f"{pad}    page {page['page']}:" + (
                            f" (order of {', '.join(page['randomised'])} is random per participant)"
                            if page.get("randomised") else ""))
                        for qid in page["questions"]:
                            q = by_id.get(qid)
                            if not q:
                                continue
                            flags = []
                            v = q["validation"]
                            if v["response"] != "optional":
                                flags.append(f"{v['response']} response")
                            if v.get("correct_choices"):
                                flags.append("correct answer required: " + "; ".join(c["text"] for c in v["correct_choices"])
                                             + (f" (message description: {v['message_description']!r})" if v.get("message_description") else ""))
                            elif v.get("type"):
                                flags.append(f"validation {v['type']}")
                            if q.get("choice_randomisation"):
                                flags.append("answer order randomised")
                            if q.get("display_logic"):
                                flags.append(f"shown only if {q['display_logic']['condition']}")
                            if q.get("skip_logic"):
                                flags.append("skip logic")
                            if q.get("autocomplete"):
                                flags.append("autocomplete from a list not in the export")
                            if q.get("carry_forward"):
                                flags.append("options carried forward from another question")
                            if not q["participant_visible"]:
                                flags.append("not visible (recorded silently)")
                            lines.append(f"{pad}      {qid} {q.get('tag')!s} [{q['kind']}]: {_short(q['text_plain'])}")
                            for key, label in (("choices", "options"), ("rows", "rows"), ("columns", "columns")):
                                if q.get(key):
                                    order = ("base order, shuffled per participant" if key != "columns"
                                             and q.get("choice_randomisation") else "display order")
                                    lines.append(f"{pad}        {label} ({order}): "
                                                 + " | ".join(_short(c["text_plain"], 40) for c in q[key]))
                            if q.get("column_labels"):
                                lines.append(f"{pad}        column labels: " + " | ".join(q["column_labels"]))
                            scale = q.get("scale") if isinstance(q.get("scale"), dict) else {}
                            if scale.get("labels"):
                                lines.append(f"{pad}        scale {scale.get('CSSliderMin', '')}-{scale.get('CSSliderMax', '')}"
                                             " anchors: " + " | ".join(scale["labels"]))
                            if scale.get("not_applicable"):
                                lines.append(f"{pad}        opt-out box {scale['not_applicable']!r} (separate from the "
                                             "scale, not an anchor)")
                            if q.get("images"):
                                lines.append(f"{pad}        IMAGES: {len(q['images'])} picture(s) on this screen "
                                             "(not in the export): " + " | ".join(
                                                 _short(i.get("alt") or i.get("src") or "?", 50) for i in q["images"][:3]))
                            if flags:
                                lines.append(f"{pad}        " + "; ".join(flags))
            elif kind == "randomizer":
                lines.append(f"{pad}- Randomizer [{node['flow_id']}]: {node['summary']}")
                walk(node["elements"], depth + 1)
            elif kind == "branch":
                lines.append(f"{pad}- Branch [{node['flow_id']}] if {node['condition']}:")
                walk(node["elements"], depth + 1)
            elif kind == "group":
                lines.append(f"{pad}- Group {node.get('description')!r} [{node['flow_id']}]")
                walk(node["elements"], depth + 1)
            elif kind == "embedded_data":
                lines.append(f"{pad}- Embedded data: " + ", ".join(
                    f"{f['field']} = {f['value']!r}" if f["value"] is not None else f"{f['field']} (from {f['set_by']})"
                    for f in node["fields"]))
            elif kind == "end_survey":
                lines.append(f"{pad}- End of survey")
            else:
                lines.append(f"{pad}- {kind} [{node.get('flow_id')}]: {node.get('note')}")
                walk(node.get("elements", []), depth + 1)

    walk(report["flow"], 0)
    lines += ["", "Never shown to participants (do not use as participant material):"]
    for block in report["not_reachable"]["blocks"]:
        lines.append(f"- Block {block['description']!r} [{block['id']}]: {block['reason']} "
                     f"({len(block['questions'])} questions)")
    loose = [q for q in report["not_reachable"]["questions"] if not q.get("block")
             or q["block"] not in {b["id"] for b in report["not_reachable"]["blocks"]}]
    for q in loose:
        lines.append(f"- {q['qid']} {q.get('tag')}: {q['reason']}")
    if report["notes"]:
        lines += ["", "Notes:"] + [f"- {n}" for n in report["notes"]]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read a Qualtrics .qsf survey export in the order participants saw it.")
    parser.add_argument("qsf", type=Path, nargs="?")
    parser.add_argument("--json", type=Path, help="also write the full record as JSON to this path")
    parser.add_argument("--check", type=Path, metavar="PROJECT", help="check the project's packages against every .qsf")
    parser.add_argument("--package", type=Path, help="with --check: only this package/<slug>")
    args = parser.parse_args(argv)
    if args.check is not None:
        found, older = findings(args.check, args.package)
        for message, fix in found:
            print(f"PROBLEM {message}" + (f"\n        fix: {fix}" if fix else ""))
        for message, fix in older:
            print(f"WARN    {message}" + (f"\n        fix: {fix}" if fix else ""))
        print(f"FAIL {len(found)} survey problem(s)" if found else "PASS survey files")
        return 1 if found else 0
    if args.qsf is None:
        parser.error("give a .qsf file, or --check <project>")
    try:
        report = read_qsf(args.qsf)
    except (NotASurveyExport, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(outline(report))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
