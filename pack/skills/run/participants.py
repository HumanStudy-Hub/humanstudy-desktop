"""Who the AI participants of a protocol run are. App-owned (not vendored).

The study owns the state and the step; who plays f is the researcher's choice, recorded with the run. That choice
lives in the project at simulation/participants.json (written by the agent when the researcher describes who
should take part; the Run simulation approval carries its SHA-256):

    {"version": 1, "mode": "paper"}                    # default, also when the file is absent: sample-matched
    {"version": 1, "mode": "custom",
     "groups": [{"id": "students", "weight": 2, "persona": "A first-year psychology student.",
                 "attributes": {"age": {"min": 18, "max": 22}, "gender": {"woman": 0.6, "man": 0.4},
                                "country": "United States", "occupation": ["student"], "education": "...",
                                "notes": "free text"}}, ...],
     "system": "optional full system prompt with {{persona}} {{age}} {{gender}} {{country}} {{occupation}} ..."}
    {"version": 1, "mode": "blank"}                    # no persona, the bare prompt (for comparison)

- paper: each participant's persona comes from the paper's own description of its sample (protocol.json
  meta.sample, then program.json `participants` nodes): the population as printed, an age drawn from a printed
  mean and SD (or range), a gender drawn from printed counts or percentages. Anything the paper does not state is
  left out, never made up.
- custom: groups split each condition's participants by weight (largest remainder, as the web's persona groups),
  and attributes are drawn per participant from the group's ranges.
- Draws use a random generator keyed by the spec's SHA-256, the seed, the condition and the participant's index,
  so a resumed run plays the same people. The condition never appears in what the participant is told.
"""
from __future__ import annotations

import hashlib
import json
import random
import re
from pathlib import Path

SPEC_PATH = "simulation/participants.json"
MODES = ("paper", "custom", "blank")
PLACEHOLDERS = ("persona", "age", "gender", "country", "occupation", "education", "group")
CHOICE_ATTRS = ("gender", "country", "occupation", "education")
MAX_GROUPS, MAX_PERSONA, MAX_SYSTEM, MAX_TEXT = 12, 1500, 3000, 300
# What budget.py reserves for the persona/override part of every system prompt (JSON-escaped bytes); a spec whose
# prompts are longer is refused at run time rather than overrunning the approved token budget.
PERSONA_BUDGET_BYTES = 4000


class SpecError(ValueError):
    pass


# ------------------------------------------------------------------------------------------------ validation
def _text(v, where, limit=MAX_TEXT):
    if not isinstance(v, str) or not v.strip():
        raise SpecError("%s must be non-empty text" % where)
    if len(v) > limit:
        raise SpecError("%s is longer than %d characters" % (where, limit))
    return v.strip()


def _num(v, where, lo=None, hi=None):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
        raise SpecError("%s must be a number" % where)
    if (lo is not None and v < lo) or (hi is not None and v > hi):
        raise SpecError("%s must be between %s and %s" % (where, lo, hi))
    return v


def _choice(v, where):
    """text | [text] | {text: weight} -> {text: weight}."""
    if isinstance(v, str):
        return {_text(v, where): 1}
    if isinstance(v, list) and v:
        return {_text(x, "%s[%d]" % (where, i)): 1 for i, x in enumerate(v)}
    if isinstance(v, dict) and v:
        out = {_text(k, where): _num(w, "%s.%s" % (where, k), 0) for k, w in v.items()}
        if sum(out.values()) <= 0:
            raise SpecError("%s needs a weight above 0" % where)
        return out
    raise SpecError("%s must be text, a list of texts or {text: weight}" % where)


def _age(v, where):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return {"value": int(_num(v, where, 1, 120))}
    if not isinstance(v, dict) or set(v) - {"min", "max", "mean", "sd"}:
        raise SpecError("%s must be a number, {min, max} or {mean, sd[, min, max]}" % where)
    out = {k: _num(v[k], "%s.%s" % (where, k), 0, 120) for k in v}
    if "mean" in out and "sd" not in out or "sd" in out and "mean" not in out:
        raise SpecError("%s needs both mean and sd" % where)
    if "mean" not in out and not ("min" in out and "max" in out):
        raise SpecError("%s needs {min, max} or {mean, sd}" % where)
    if "min" in out and "max" in out and out["min"] > out["max"]:
        raise SpecError("%s.min is above %s.max" % (where, where))
    return out


def _placeholders(text, where):
    bad = sorted(set(re.findall(r"\{\{\s*([^}]*?)\s*\}\}", text)) - set(PLACEHOLDERS))
    if bad:
        raise SpecError("%s uses unknown placeholder(s) %s (known: %s)" % (where, bad, ", ".join(PLACEHOLDERS)))


def validate(spec) -> dict:
    """The spec, normalised (choices as {text: weight}); SpecError says what is wrong in plain words."""
    if not isinstance(spec, dict):
        raise SpecError("participants.json must be one JSON object")
    extra = set(spec) - {"version", "mode", "groups", "system", "note"}
    if extra:
        raise SpecError("participants.json has unknown field(s) %s" % sorted(extra))
    if spec.get("version", 1) != 1:
        raise SpecError("participants.json version must be 1")
    mode = spec.get("mode", "paper")
    if mode not in MODES:
        raise SpecError("mode must be one of %s" % ", ".join(MODES))
    out = {"version": 1, "mode": mode}
    if "note" in spec:
        out["note"] = _text(spec["note"], "note", MAX_PERSONA)
    if "system" in spec:
        if mode == "blank":
            raise SpecError("mode blank uses the bare prompt: remove system, or use mode paper or custom")
        out["system"] = _text(spec["system"], "system", MAX_SYSTEM)
        _placeholders(out["system"], "system")
    if mode != "custom":
        if "groups" in spec:
            raise SpecError("groups are for mode custom")
        return out
    groups = spec.get("groups")
    if not isinstance(groups, list) or not 1 <= len(groups) <= MAX_GROUPS:
        raise SpecError("mode custom needs 1 to %d groups" % MAX_GROUPS)
    seen, norm = set(), []
    for i, g in enumerate(groups):
        where = "groups[%d]" % i
        if not isinstance(g, dict) or set(g) - {"id", "label", "weight", "persona", "attributes"}:
            raise SpecError("%s must be an object with id, label, weight, persona, attributes" % where)
        gid = g.get("id", "g%d" % (i + 1))
        if not isinstance(gid, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,40}", gid) or gid in seen:
            raise SpecError("%s.id must be a short unique name (letters, digits, - _ .)" % where)
        seen.add(gid)
        ng = {"id": gid, "weight": _num(g.get("weight", 1), where + ".weight", 0)}
        if ng["weight"] <= 0:
            raise SpecError("%s.weight must be above 0" % where)
        if "label" in g:
            ng["label"] = _text(g["label"], where + ".label", 80)
        if "persona" in g:
            ng["persona"] = _text(g["persona"], where + ".persona", MAX_PERSONA)
        attrs = g.get("attributes") or {}
        if not isinstance(attrs, dict) or set(attrs) - {"age", *CHOICE_ATTRS, "notes"}:
            raise SpecError("%s.attributes may hold age, gender, country, occupation, education, notes" % where)
        na = {}
        if "age" in attrs:
            na["age"] = _age(attrs["age"], where + ".attributes.age")
        for k in CHOICE_ATTRS:
            if k in attrs:
                na[k] = _choice(attrs[k], "%s.attributes.%s" % (where, k))
        if "notes" in attrs:
            na["notes"] = _text(attrs["notes"], where + ".attributes.notes", MAX_PERSONA)
        if na:
            ng["attributes"] = na
        if "persona" not in ng and not na:
            raise SpecError("%s needs a persona or attributes" % where)
        norm.append(ng)
    out["groups"] = norm
    return out


def load(project: Path):
    """-> (normalised spec, sha256 of the file bytes) or ({"version": 1, "mode": "paper"}, None) when absent."""
    path = Path(project) / SPEC_PATH
    if not path.is_file():
        return {"version": 1, "mode": "paper"}, None
    raw = path.read_bytes()
    try:
        spec = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise SpecError("participants.json is not valid JSON: %s" % e)
    return validate(spec), hashlib.sha256(raw).hexdigest()


# ------------------------------------------------------------------------------------------------ sampling
def split(total: int, weights: list) -> list:
    """Largest remainder (HumanStudy-Bench playground/personas.py _counts, humanstudy-hub-web persona-groups.ts):
    every group keeps at least one participant when there are enough to go around."""
    if total <= 0:
        return [0] * len(weights)
    s = float(sum(weights))
    exact = [w / s * total for w in weights]
    counts = [int(x) for x in exact]
    if len(weights) <= total:
        counts = [max(1, c) for c in counts]
    while sum(counts) > total:
        counts[counts.index(max(counts))] -= 1
    order = sorted(range(len(weights)), key=lambda i: exact[i] - int(exact[i]), reverse=True)
    k = 0
    while sum(counts) < total:
        counts[order[k % len(order)]] += 1
        k += 1
    return counts


def _pick(choice: dict, rng):
    items = [(k, w) for k, w in choice.items() if w > 0]
    return rng.choices([k for k, _ in items], weights=[w for _, w in items])[0]


def draw_age(age: dict, rng):
    if "value" in age:
        return age["value"]
    if "mean" in age:
        lo = max(age.get("min", age["mean"] - 2.5 * age["sd"]), 1)
        hi = age.get("max", age["mean"] + 2.5 * age["sd"])
        return int(round(min(max(rng.gauss(age["mean"], age["sd"]), lo), hi)))
    return rng.randint(int(age["min"]), int(age["max"]))


def draw(attrs: dict, rng) -> dict:
    """Concrete attributes for one participant from a group's (or the paper's) distributions."""
    out = {}
    if attrs.get("age"):
        out["age"] = draw_age(attrs["age"], rng)
    for k in CHOICE_ATTRS:
        if attrs.get(k):
            v = _pick(attrs[k], rng)
            if v is not None:
                out[k] = v
    if attrs.get("notes"):
        out["notes"] = attrs["notes"]
    return out


def _rng(*parts) -> random.Random:
    return random.Random(hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest())


# ------------------------------------------------------------------------------------------------ the paper's sample
MARK = re.compile(r"\b(?:study|experiment|exp\.?)\s*(\d+)\b", re.I)
AGE_MEAN = re.compile(r"\b(?:M\s*age|mean\s+age|average\s+age|age[sd]?\s*[:(,]?\s*M)\s*(?:was|of|=|:|,)?\s*(\d{1,2}(?:\.\d+)?)", re.I)
AGE_SD = re.compile(r"^[^.;]{0,30}?(?:\bSD\s*[=:]?\s*|±\s*)(\d{1,2}(?:\.\d+)?)", re.I)
AGE_RANGE = re.compile(r"\b(?:aged|ages|age range|ranging in age from|age(?:s)? (?:ranged|range) from)\s*(?:from|=|:|was)?\s*"
                       r"(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,3})\b", re.I)
PCT = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*%\s*(?:were\s+|of\s+(?:the\s+)?(?:participants|sample)\s+(?:were\s+)?)?(female|women|woman|male|men|man)\b", re.I)
COUNT = re.compile(r"\b(\d{1,6})\s+(?:were\s+)?(female|females|women|male|males|men)\b", re.I)
WOMEN = ("female", "females", "women", "woman")
DESC_FIELDS = re.compile(r"population|setting|sample|recruit|demograph|account|description|who|country|location", re.I)
COUNT_FIELDS = re.compile(r"^n[-_]|compensation|pay|exclu", re.I)


def study_number(arm: dict):
    m = re.match(r"\s*(?:study|experiment|exp\.?)\s*(\d+)", str(arm.get("label") or ""), re.I) or \
        re.search(r"(\d+)$", str(arm.get("id") or ""))
    return int(m.group(1)) if m else None


def segment(text: str, k) -> str | None:
    """The part of `text` about study k ("Study 1: … ; Study 2: …"); the whole text when it names no study; None
    when it names other studies only (its figures are then not this study's)."""
    marks = list(MARK.finditer(text))
    if not marks:
        return text
    for i, m in enumerate(marks):
        if k is not None and int(m.group(1)) == k:
            return text[m.end(): marks[i + 1].start() if i + 1 < len(marks) else len(text)]
    return None


def stats(text: str) -> dict:
    """Age and gender figures printed in one passage: {"age": {...}, "gender": {...}} with only what it states."""
    out = {}
    m = AGE_MEAN.search(text)
    if m:
        sd = AGE_SD.search(text[m.end():])
        out["age"] = {"mean": float(m.group(1))}
        if sd and float(sd.group(1)) > 0:
            out["age"]["sd"] = float(sd.group(1))
    r = AGE_RANGE.search(text)
    if r and int(r.group(1)) <= int(r.group(2)):
        out.setdefault("age", {}).update(min=int(r.group(1)), max=int(r.group(2)))
    pct = {("woman" if w.lower() in WOMEN else "man"): float(p) / 100 for p, w in PCT.findall(text)}
    cnt = {}
    for n, w in COUNT.findall(text):
        cnt.setdefault("woman" if w.lower() in WOMEN else "man", int(n))
    total = re.search(r"\bN\s*=\s*(\d[\d,]*)", text)
    if pct and all(0 <= v <= 1 for v in pct.values()) and sum(pct.values()) <= 1.0001:
        g = dict(pct)
    elif len(cnt) == 2 and sum(cnt.values()) > 0:
        g = {k: v / sum(cnt.values()) for k, v in cnt.items()}
    elif len(cnt) == 1 and total and 0 < next(iter(cnt.values())) <= int(total.group(1).replace(",", "")):
        g = {k: v / int(total.group(1).replace(",", "")) for k, v in cnt.items()}
    else:
        g = {}
    if g:
        if len(g) == 1:   # only one share printed: the rest is the other gender, unless the paper says otherwise
            (k, v), = g.items()
            g["man" if k == "woman" else "woman"] = max(0.0, 1 - v)
        rest = 1 - sum(g.values())
        if rest > 0.001:
            g[None] = rest   # neither stated: the participant's gender is then left out
        out["gender"] = g
    return out


def _clean(text: str) -> str:
    """The population as printed, without counts: parentheticals holding numbers and a trailing study breakdown go."""
    t = re.sub(r"\s*\([^()]*\d[^()]*\)", "", text)
    t = re.split(r":\s*(?=(?:study|experiment|exp\.?)\s*\d)", t, flags=re.I)[0]
    t = re.split(r"(?<=[a-z0-9)])\.\s", t)[0].strip().rstrip(".;,")
    t = re.sub(r"^(?:the\s+)?(?:n\s*=\s*)?\d[\d,]*\s+", "", t, flags=re.I)   # "120 undergraduates" -> "undergraduates"
    return t[:MAX_TEXT]


def _texts(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _texts(v)
    elif isinstance(value, list):
        for v in value:
            yield from _texts(v)


def paper_sources(protocol: dict, program: dict | None, arm: dict) -> list:
    """[(where, text, describes the population)] for one arm, most specific first: protocol.json meta.sample, then
    the program's participants nodes for this arm's study (all of them when the program has one study only)."""
    out = []
    sample = (protocol.get("meta") or {}).get("sample")
    if isinstance(sample, str):
        out.append(("protocol.meta.sample", sample, True))
    elif isinstance(sample, dict):
        for k, v in sample.items():
            if isinstance(v, str) and k not in ("cite", "note"):
                out.append(("protocol.meta.sample.%s" % k, v, bool(DESC_FIELDS.search(k))))
    if not isinstance(program, dict):
        return out
    studies = [s for s in program.get("studies") or [] if isinstance(s, dict)]
    k = study_number(arm)
    label = str(arm.get("label") or "").lower()
    match = {s.get("id") for s in studies if s.get("id") == arm.get("id")
             or (label and str(s.get("title") or "").lower().split(":")[0].strip() == label.split(":")[0].strip())}
    if not match and k is not None and len(studies) >= k:
        empirical = [s for s in studies if s.get("type") != "analysis"]
        match = {empirical[k - 1].get("id")} if len(empirical) >= k else set()
    for n in program.get("nodes") or []:
        if not isinstance(n, dict) or n.get("kind") != "participants":
            continue
        ids = n.get("studyIds") or []
        if ids and not (set(ids) & match) and len(studies) > 1:
            continue
        for f in n.get("fields") or []:
            if not isinstance(f, dict) or f.get("state") == "missing" or f.get("value") is None:
                continue
            name = "%s %s" % (f.get("id", ""), f.get("label", ""))
            for t in _texts(f.get("value")):
                out.append(("program.%s.%s" % (n.get("id"), f.get("id")), t,
                            bool(DESC_FIELDS.search(name)) and not COUNT_FIELDS.search(str(f.get("id", "")))))
    return out


def paper_profile(protocol: dict, program: dict | None, arm: dict) -> dict:
    """What the paper states about one arm's participants: {"description", "age", "gender", "age_mean_only",
    "sources"}; keys it does not state are absent."""
    k = study_number(arm)
    prof, used = {}, []
    for where, text, describes in paper_sources(protocol, program, arm):
        if describes and "description" not in prof:
            d = _clean(text)
            if d and not re.fullmatch(r"[\d\s,.;:()%-]*", d):
                prof["description"] = d
                used.append(where)
        part = segment(text, k)
        if part is None:
            continue
        st = stats(part)
        for key in ("age", "gender"):
            if key in st and key not in prof:
                prof[key] = st[key]
                used.append(where)
    if "age" in prof and "sd" not in prof["age"] and not ("min" in prof["age"] and "max" in prof["age"]):
        prof["age_mean_only"] = prof.pop("age")["mean"]   # a mean alone: stated about the sample, not drawn
    prof["sources"] = sorted(set(used))
    return prof


# ------------------------------------------------------------------------------------------------ personas
GENDER_WORD = {"woman": "woman", "man": "man"}


def persona_text(group_persona: str | None, attrs: dict, sample: str | None = None, age_mean: float | None = None) -> str:
    lines = []
    if group_persona:
        lines.append(group_persona)
    gender = attrs.get("gender")
    if gender in GENDER_WORD:
        age = attrs.get("age")
        article = "an" if age is not None and (str(age).startswith("8") or age in (11, 18)) else "a"
        lines.append("You are %s %s%s." % (article, "%s-year-old " % age if age is not None else "", gender))
    else:
        if "age" in attrs:
            lines.append("You are %s years old." % attrs["age"])
        if gender:
            lines.append("Your gender: %s." % gender.rstrip("."))
    for k, label in (("country", "You live in"), ("occupation", "Your occupation:"), ("education", "Your education:")):
        if attrs.get(k):
            lines.append("%s %s." % (label, attrs[k].rstrip(".")))
    if attrs.get("notes"):
        lines.append(attrs["notes"])
    if sample:
        lines.append("You are one of the study's participants, whom the paper describes as: %s." % sample.rstrip("."))
    if age_mean is not None:
        lines.append("The participants' mean age was %s." % ("%g" % age_mean))
    return "\n".join(lines)


def fill(template: str, values: dict) -> str:
    return re.sub(r"\{\{\s*(\w+)\s*\}\}", lambda m: str(values.get(m.group(1), "") or ""), template)


def people(spec: dict, sha: str | None, protocol: dict, program: dict | None, plan: dict, group_size: dict,
           seeds: list, opaque) -> dict:
    """{(opaque id, member): person} for every planned participant. `opaque(seed, arm, index)` is the run's
    participant id (run_study's HMAC); members are p1, p2 … within a group. A person is {"group", "attributes",
    "persona", "system"|None}; persona/system never name the condition."""
    out, arms = {}, {a.get("id"): a for a in protocol.get("arms") or [] if isinstance(a, dict)}
    key = sha or "default"
    for seed in seeds:
        for arm_id, n in sorted(plan.items()):
            g = int(group_size.get(arm_id) or 1)
            slots = [None] * (n * g)
            if spec["mode"] == "custom":
                counts = split(n * g, [x["weight"] for x in spec["groups"]])
                slots = [x for x, c in zip(spec["groups"], counts) for _ in range(c)]
                _rng("assign", key, seed, arm_id).shuffle(slots)
            prof = paper_profile(protocol, program, arms.get(arm_id, {"id": arm_id})) if spec["mode"] == "paper" else {}
            for i in range(n):
                for m in range(g):
                    rng = _rng("person", key, seed, arm_id, i, m)
                    grp = slots[i * g + m]
                    if spec["mode"] == "custom":
                        attrs = draw(grp.get("attributes") or {}, rng)
                        persona = persona_text(grp.get("persona"), attrs)
                    elif spec["mode"] == "paper":
                        attrs = draw({k: v for k, v in prof.items() if k in ("age", "gender")}, rng)
                        persona = persona_text(None, attrs, prof.get("description"), prof.get("age_mean_only"))
                    else:
                        attrs, persona = {}, ""
                    out[(opaque(seed, arm_id, i), "p%d" % (m + 1))] = {
                        "group": grp["id"] if grp else None, "attributes": attrs, "persona": persona}
    return out


def summary(spec: dict, protocol: dict, program: dict | None, arms: list | None = None) -> str:
    """One plain line on who takes part (run.json, the results page)."""
    if spec["mode"] == "blank":
        return "Blank: the model with no persona (the bare prompt)"
    if spec["mode"] == "custom":
        gs = spec["groups"]
        names = ", ".join("%s (%g)" % (g.get("label") or g["id"], g["weight"]) for g in gs[:4]) + (" …" if len(gs) > 4 else "")
        return "Custom: %d group%s by weight: %s%s" % (len(gs), "" if len(gs) == 1 else "s", names,
                                                     "; own system prompt" if spec.get("system") else "")
    descs = []
    for a in protocol.get("arms") or []:
        if not isinstance(a, dict) or a.get("runnable") is False or (arms and a.get("id") not in arms):
            continue
        p = paper_profile(protocol, program, a)
        bits = [p.get("description") or "the paper does not describe its participants"]
        if "age" in p:
            bits.append("age ~%g" % p["age"]["mean"] if "mean" in p["age"] else "age %s-%s" % (p["age"]["min"], p["age"]["max"]))
        elif "age_mean_only" in p:
            bits.append("mean age %g" % p["age_mean_only"])
        if p.get("gender", {}).get("woman") is not None:
            bits.append("%d%% women" % round(100 * p["gender"]["woman"]))
        if not any(x.startswith(bits[0]) for x in descs):
            descs.append(", ".join(bits))
    return "Sample-matched: " + ("; ".join(descs) or "the paper does not describe its participants")


# ------------------------------------------------------------------------------------------------ prompt and reply
TAKE_PART = ("You are taking part in a study. Each message shows the page in front of you. Take part as this person "
             "would: answer from their point of view, knowledge and feelings, not as an AI assistant.")
THINK_FORMAT = ("On every page, first write one to three short sentences in the first person (under 60 words): your "
                "honest reaction or reasoning as this person. Then end your reply with your answers as one JSON object "
                "in a ```json fenced block, with nothing after it. In the JSON, map each question id on this page to "
                'your answer: an option code (e.g. "o2") for single choice, a list of codes for multiple choice, a '
                "number for number/scale/slider questions, a string for text. For an option with a text box use "
                '{"code": "o3", "text": "..."}. Leave an optional question out to skip it. A page without questions '
                "gets {}.")
# What the relay and budget.py reserve per image sent to the model (model-relay.ts IMAGE_RESERVE_TOKENS): an image
# costs the model tokens by its pixels, not by its base64 bytes, and Claude models stay under this per image.
IMAGE_RESERVE_TOKENS = 5000
IMAGE_PART_BYTES = 64     # the JSON around one image part ({"type": "image_url", "image_url": {"url": ...}})
# Models known to accept image parts. Anything else runs text only and run.json says so.
IMAGE_MODELS = re.compile(r"^(?:anthropic/)?claude-(?:haiku|sonnet|opus)-(?:[5-9]|\d\d)\b", re.I)


def system_text(persona: str = "", override: str | None = None, values: dict | None = None) -> str:
    """The participant's system prompt: the persona (or the researcher's own prompt with its placeholders filled),
    how to take part, and the reply format, which is always appended so every reply can be read."""
    if override:
        head = fill(override, dict(values or {}, persona=persona))
        return head.strip() + "\n\n" + THINK_FORMAT
    return (persona.strip() + "\n\n" if persona.strip() else "") + TAKE_PART + "\n\n" + THINK_FORMAT


def budget_system() -> str:
    """The longest system prompt a run may send, as budget.py sizes it."""
    return system_text("x" * PERSONA_BUDGET_BYTES)


def fits_budget(system: str) -> bool:
    return len(json.dumps(system)) <= len(json.dumps(budget_system()))


FENCE = re.compile(r"```(?:json|JSON)?\s*(\{.*?\})\s*```", re.S)


def split_reply(text: str):
    """-> (reasoning, answers): the LAST fenced JSON object in the reply (else the last complete {...} object), and
    the text before it. Braces inside the reasoning are never taken for the answer. ValueError when there is none."""
    for m in reversed(list(FENCE.finditer(text))):
        try:
            v = json.loads(m.group(1))
        except ValueError:
            continue
        if isinstance(v, dict):
            return text[:m.start()].strip(), v
    best = None
    for start in [i for i, ch in enumerate(text) if ch == "{"]:
        depth = 0
        for i in range(start, len(text)):
            depth += {"{": 1, "}": -1}.get(text[i], 0)
            if depth == 0:
                try:
                    v = json.loads(text[start:i + 1])
                except ValueError:
                    break
                if isinstance(v, dict) and (best is None or i > best[1] or (i == best[1] and start < best[0])):
                    best = (start, i, v)
                break
    if best is None:
        raise ValueError("no JSON object in the reply")
    return text[:best[0]].strip().rstrip("`").strip(), best[2]


def parse_answer(text: str) -> dict:
    return split_reply(text)[1]
