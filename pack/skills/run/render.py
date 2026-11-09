"""The default renderer: a State as plain text, and a helper that turns a chat model into an f.

This is ONE choice of how a participant is shown the screen. It is part of f (the user's side), not of the
study: replace it with your own renderer (`"renderer": "path/to/file.py:fn"` in the f-spec) whenever you want a
different presentation. Whatever renderer a run used is recorded (name + sha256) in runs/<stamp>/run.json.

What render_state does, and nothing more:
- screen items and questions in the page's layout order (state.screen.order; "button" places the continue button);
- every option with its code (o1, o2 …), which is what the answer must name; text boxes on options are marked;
- question settings humans saw (range, anchors, step, required, instruction, prefix/suffix, N/A box);
- styled spans, item styles and prompt styles as light markup: **bold**, *italic*, _underline_, [style: …]
  for anything else;
- images by their opaque id and any verified text lines on them (the picture itself is not described: a
  text-only model does not see it — make_chat_f(images=True) sends the pictures as image parts instead);
- earlier screens' items (state.seen), each marked whether it can still be re-read; an item that is not
  reviewable is shown as remembered text with the mark "not reviewable — you cannot go back to it";
- the participant's own earlier answers, events, timing and navigation values, and the page's error message.
It adds no instructions of its own about the study and never mentions conditions, hypotheses or the paper.
"""
import json
import re

MARK = {"bold": ("**", "**"), "italic": ("*", "*"), "underline": ("_", "_")}


def _styled(text, spans):
    """Spans as markup inserted at their boundaries, so nested and overlapping spans are all kept."""
    if not isinstance(text, str) or not spans:
        return text if isinstance(text, str) else ("" if text is None else str(text))
    opens, closes = {}, {}
    for k, sp in enumerate(s for s in spans if isinstance(s, dict)):
        st, en = sp.get("start"), sp.get("end")
        if not (isinstance(st, int) and isinstance(en, int) and 0 <= st < en <= len(text)):
            continue
        style = str(sp.get("style", ""))
        a, b = MARK.get(style, ("[%s: " % style, "]"))
        opens.setdefault(st, []).append((-en, k, a))     # a longer span opens first (outside)
        closes.setdefault(en, []).append((-st, k, b))    # and closes last
    out = []
    for i in range(len(text) + 1):
        out += [m for _, _, m in sorted(closes.get(i, []), reverse=True)]
        out += [m for _, _, m in sorted(opens.get(i, []))]
        if i < len(text):
            out.append(text[i])
    return "".join(out)


def _line(x):
    return _styled(x.get("text"), x.get("spans")) if isinstance(x, dict) else str(x)


def _whole(text, style):
    """A style on the whole item or prompt (item.style / response.prompt_style): bold/italic/underline as the same
    light markup, heading as "## ", bullet as "• ", anything else (colour, size, font) as [style: …]."""
    if not text or not isinstance(style, str) or not style.strip():
        return text
    toks = style.split()
    out, rest = text, []
    for t in toks:
        if t in MARK:
            out = MARK[t][0] + out + MARK[t][1]
        elif t not in ("heading", "bullet"):
            rest.append(t)
    if rest:
        out = "[style: %s] %s" % (" ".join(rest), out)
    if "bullet" in toks:
        out = "• " + out
    if "heading" in toks:
        out = "## " + out
    return out


def render_item(it):
    if it.get("text") is not None:
        return _whole(_styled(it["text"], it.get("spans")), it.get("style"))
    parts = []
    if it.get("src"):
        size = it.get("size") or {}
        dims = " (%s)" % ", ".join("%s %s px" % (k, v) for k, v in size.items()) if size else ""
        parts.append("[%s %s%s]" % (it.get("type", "image"), it["src"], dims))
    for ln in it.get("lines") or []:
        parts.append(_line(ln))
    for row in it.get("rows") or []:
        parts.append(" | ".join(_line(c) if isinstance(c, dict) else str(c) for c in row))
    return "\n".join(parts)


def render_response(r):
    head = "Question %s (%s%s)" % (r["id"], r["kind"], "" if r.get("required", True) else ", optional")
    lines = [head]
    prompt = _whole(_styled(r.get("prompt"), r.get("prompt_spans")), r.get("prompt_style"))
    if prompt:
        lines.append(prompt)
    if r.get("instruction"):
        lines.append(str(r["instruction"]))
    for o in r.get("options") or []:
        lines.append("  %s) %s%s" % (o["code"], _styled(o.get("label"), o.get("spans")),
                                     "  [has a text box]" if o.get("text_entry") else ""))
    extra = []
    if "range" in r:
        extra.append("range %s" % (r["range"],))
    if "step" in r:
        extra.append("step %s" % r["step"])
    if r.get("anchors"):
        extra.append("labels %s" % json.dumps(r["anchors"], ensure_ascii=False))
    if "start" in r:
        extra.append("starts at %s" % r["start"])
    if "prefill" in r:
        extra.append("already filled in: %s" % json.dumps(r["prefill"], ensure_ascii=False))
    for k in ("prefix", "suffix"):
        if r.get(k):
            extra.append("%s %r" % (k, r[k]))
    if r.get("integer"):
        extra.append("whole numbers")
    if r.get("min_chars"):
        extra.append("at least %s characters" % r["min_chars"])
    if r.get("na_option"):
        extra.append('has a "not applicable" box (answer "NA")')
    if r.get("columns"):
        extra.append("columns %s" % json.dumps(r["columns"], ensure_ascii=False))
    if r.get("widget"):
        extra.append("shown as %s" % r["widget"])
    if "shows_value" in r:
        extra.append("the chosen value is %s" % ("shown" if r["shows_value"] else "not shown"))
    if "gridlines" in r:
        extra.append("gridlines %s" % json.dumps(r["gridlines"], ensure_ascii=False))
    if r.get("widget_params"):
        extra.append("widget settings %s" % json.dumps(r["widget_params"], ensure_ascii=False))
    if r.get("soft_required"):
        extra.append("you are asked to answer but may skip")
    if extra:
        lines.append("  (" + "; ".join(extra) + ")")
    return "\n".join(lines)


def render_state(state):
    """A State as plain text (see the module docstring). Returns '' for a finished or waiting state."""
    if state.get("done") or state.get("waiting"):
        return ""
    sc = state["screen"]
    byid = {x["id"]: ("item", x) for x in sc.get("items", [])}
    byid.update({r["id"]: ("resp", r) for r in sc.get("responses", [])})
    order = list(sc.get("order") or [])
    if not order:
        order = [x["id"] for x in sc.get("items", [])] + [r["id"] for r in sc.get("responses", [])]
    order += [k for k in byid if k not in order]   # anything the layout left out still appears, at the end
    button = sc.get("button")
    blocks = ["=== Page %s ===" % state.get("page", state.get("step"))]
    placed_button = False
    for k in order:
        if k == "button":
            blocks.append("[Button: %s]" % (button or "Continue"))
            placed_button = True
            continue
        kind, x = byid.get(k, (None, None))
        if kind == "item":
            blocks.append(render_item(x))
        elif kind == "resp":
            blocks.append(render_response(x))
    if not placed_button:
        blocks.append("[Button: %s]" % (button or "Continue"))
    if state.get("events"):
        blocks.append("Messages on this page:\n" + "\n".join("- %s" % e for e in state["events"]))
    if state.get("timing"):
        blocks.append("Timing: %s" % json.dumps(state["timing"], ensure_ascii=False))
    if state.get("navigation"):
        blocks.append("Navigation: %s" % json.dumps(state["navigation"], ensure_ascii=False))
    if state.get("error"):
        blocks.append("The page did not accept your answers:\n" +
                      "\n".join("- %s: %s" % (k, v) for k, v in state["error"].items()))
    seen = state.get("seen") or []
    if seen:
        out = ["--- Earlier pages ---"]
        for it in seen:
            mark = "reviewable — you can look at it again" if it.get("reviewable") else \
                "not reviewable — you cannot go back to it"
            out.append("(page %s; %s) %s" % (it.get("step"), mark, render_item(it)))
        blocks.append("\n".join(out))
    ans = state.get("answered") or []
    if ans:
        out = ["--- Your earlier answers ---"]
        for a in ans:
            v = json.dumps(a.get("value"), ensure_ascii=False)
            out.append("(page %s) %s -> %s%s" % (a.get("step"), a.get("prompt") or a.get("response"), v,
                                                 " (typed: %s)" % a["text"] if a.get("text") else ""))
        blocks.append("\n".join(out))
    return "\n\n".join(b for b in blocks if b)


ANSWER_FORMAT = ('Reply with one JSON object mapping each question id on this page to your answer: an option code '
                 '(e.g. "o2") for single choice, a list of codes for multiple choice, a number for number/scale/'
                 'slider questions, a string for text. For an option with a text box use {"code": "o3", "text": '
                 '"..."}. Leave an optional question out to skip it.')


def parse_json_answers(text):
    """The first {...} JSON object in a model reply (fenced or not)."""
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    cands = [m.group(1)] if m else []
    for start in [i for i, ch in enumerate(text) if ch == "{"]:
        depth = 0
        for i in range(start, len(text)):
            depth += {"{": 1, "}": -1}.get(text[i], 0)
            if depth == 0:
                cands.append(text[start:i + 1])
                break
    for c in cands:
        try:
            v = json.loads(c)
            if isinstance(v, dict):
                return v
        except ValueError:
            continue
    raise ValueError("no JSON object in the reply")


def image_parts(state, asset_path):
    """OpenAI-style image parts for every image on the current screen whose file f may read (ctx.asset_path gives
    a copy under the run folder); remote images are passed by URL."""
    import base64
    import mimetypes
    parts = []
    for it in (state.get("screen") or {}).get("items", []):
        src = it.get("src")
        if not isinstance(src, str):
            continue
        if src.startswith(("http://", "https://")):
            parts.append({"type": "image_url", "image_url": {"url": src}, "item": it["id"]})
            continue
        path = asset_path(src) if asset_path else None
        if path:
            mime = mimetypes.guess_type(path)[0] or "image/png"
            data = base64.b64encode(open(path, "rb").read()).decode()
            parts.append({"type": "image_url", "image_url": {"url": "data:%s;base64,%s" % (mime, data)},
                          "item": it["id"]})
    return parts


def make_chat_f(complete, persona=None, system=None, render=render_state, parse=parse_json_answers, images=False):
    """An f from a chat callable the HOST supplies: complete(messages) -> reply text. The host owns the model, the
    key and the client; nothing here reads a key or a file. Memory: the State already carries earlier pages
    (seen) and answers (answered), so each call is one fresh conversation of system + rendered page. Retries are
    the runner's (`retries` in the f-spec).

    images=False (default): the model gets text only; a picture appears as its opaque id and any verified text
    lines on it — the model does NOT see the image, and run.json says so. images=True: the user message becomes a
    list of parts [text, image_url…] (OpenAI/OpenRouter format) with the current screen's images; use it only when
    the host's model and client accept images."""
    sys_text = system if system is not None else (
        (persona.strip() + "\n\n" if persona else "") +
        "You are taking part in a study. Each message shows the page in front of you. " + ANSWER_FORMAT)

    def f(state, ctx=None):
        text = render(state)
        content = text
        if images:
            parts = image_parts(state, getattr(ctx, "asset_path", None))
            if parts:
                content = [{"type": "text", "text": text}] + [{k: v for k, v in x.items() if k != "item"}
                                                               for x in parts]
        msgs = [{"role": "system", "content": sys_text}, {"role": "user", "content": content}]
        reply = complete(msgs)
        ans = parse(reply)
        if ctx is not None:
            ctx.note = {"reply": reply[:4000]}
            if images and content is not text:
                ctx.note["images_sent"] = len(content) - 1
        return ans

    f.description = {"renderer": getattr(render, "__name__", str(render)), "persona": persona,
                     "system": sys_text, "memory": "state only (seen + answered); one fresh call per page",
                     "images": ("sent as image parts with the current screen" if images else
                                "NOT shown: text only; images appear as opaque ids and their verified text lines")}
    return f
