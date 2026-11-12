"""What a public protocol release may contain (the platform release rules): one list, defined here, imported by
HumanStudy-Bench (scripts/research/protocols.py) and mirrored by the desktop fork allowlist.

`*` stays inside one path segment; `dir/**` is everything below dir. NEVER wins over PUBLIC_PATHS."""
import fnmatch

PUBLIC_PATHS = (
    "study.json", "protocol.json", "effects.json", "program.json", "capabilities.json",
    "review/fidelity-review-*.md", "review/checks-latest.json",
    "sources/SOURCE.json", "sources/open/**", "sourcetext/*", "variants/*.json", "artifacts/**", "package/**",
)

# never public, whatever PUBLIC_PATHS says
NEVER = ("sources/researcher/**", "sources/private/**", "runs/**", "paper/**",
         "bundle.json", "**/runs/**", "**/records.jsonl")


def match(name, pattern):
    """`*` inside one segment; `dir/**` = anything below dir; `**/x` = x at any depth."""
    if pattern.startswith("**/"):
        parts = name.split("/")
        return any(match("/".join(parts[i:]), pattern[3:]) for i in range(len(parts)))
    if pattern.endswith("/**"):
        return name.startswith(pattern[:-2])
    a, b = name.split("/"), pattern.split("/")
    return len(a) == len(b) and all(fnmatch.fnmatchcase(x, y) for x, y in zip(a, b))


def is_public(name):
    """True when a path (relative, '/'-separated) may be published in a release."""
    if not name or name.startswith("/") or ".." in name.split("/"):
        return False
    return not any(match(name, p) for p in NEVER) and any(match(name, p) for p in PUBLIC_PATHS)


# ------------------------------------------------------------------------------------- distribution tiers (§3.6)
# A release projection: participant-facing verbatim text of a non-hosted source is replaced by a same-length
# placeholder and listed under protocol["distribution"]["held"] with its text_sha256 and locator. Everything else —
# flow, conditions, response formats, rules, units, exclusions, effects with their reported numbers, every cite's
# source / page / label — ships for every tier. hsenv.rehydrate puts the text back on the user's machine.
import copy
import json
import re
import unicodedata

from . import distribution as _d

PROJECTION_FORMAT = "hsenv-projection/1"
HSENV_VERSION = "0.8.1"
_CITE_KEY = re.compile(r"(^|_)cites?$")
_NOTE_KEY = re.compile(r"(^|_)note(s)?$|_note_|^note_")
# keys of data / text dicts whose strings are never on-screen text
_STRUCT = frozenset(("id", "code", "style", "mark", "type", "src", "sha256", "size", "if", "expr", "kind", "widget",
                     "colspan", "rowspan", "read", "start", "end", "lang", "format"))
# cite fields that ship as they are for every tier; any other string in a cite of a non-hosted source is withheld,
# because evidence / where / quote fields may quote the source
# in data only these keys hold non-text strings (a data value may be called type / kind / format and still be text)
_ITEM_KNOWN = frozenset(("value", "text", "spans", "id", "type", "style", "if", "reviewable", "reviewable_on", "piped",
                         "piped_from"))
_RESP_KNOWN = frozenset(("prompt", "instruction", "prefix", "suffix", "required_message", "min_chars_message",
                         "na_option", "button", "prefill", "columns", "widget_params", "anchors", "validate", "options",
                         "prompt_spans", "id", "kind", "widget", "prompt_style", "if", "start", "shuffle_options",
                         "integer", "required", "soft_required", "shows_value", "gridlines", "range_visible",
                         "start_visible", "step", "range", "depends_on", "min_chars", "coding"))
_DATA_SKIP = frozenset(("src", "sha256", "if", "expr"))   # the only data keys the quote net never reads
_DATA_STRUCT = frozenset(("id", "code", "src", "sha256", "style", "mark", "if", "expr", "colspan", "rowspan", "read",
                          "size", "start", "end"))
CITE_KEEP = frozenset(("label", "source", "page", "read", "file", "qid", "block", "part", "table", "licence",
                       "region"))
# hostable licences: CC-BY, CC0, public domain. NC / ND never; CC-BY-SA is tier link (no share-alike on the package)
_HOSTED_LICENCE = re.compile(r"cc-?by(?:-(?:1\.0|2\.0|2\.5|3\.0|4\.0|[1-4]))?|cc0(?:-1\.0)?|public-domain|pdm(?:-1\.0)?")
_WHOLE_MIN = 6   # shorter held texts ("Yes") are not scanned (guessable anyway; accepted limit)
_SCAN_MIN = 16   # held texts of at least this many canonical characters are searched for in every shipped string


class ProjectionError(ValueError):
    pass


def hosted_licence_ok(licence):
    """CC-BY (1.0-4.0), CC0 or public domain, written in any usual way ("CC BY 4.0", "CC-BY-4.0 International",
    "CC0 1.0 Universal"). NC, ND, SA, IGO and anything else: False (tier link or user)."""
    if not isinstance(licence, str):
        return False
    t = unicodedata.normalize("NFKC", licence)
    t = re.sub(r"[\u200b-\u200d\u2060\ufeff\u00ad]", "", t).strip().lower()
    t = re.sub(r"[\s_\u2010-\u2015-]+", "-", t)
    t = re.sub(r"-(?:international|universal|generic|unported)$", "", t)
    return t.isascii() and bool(_HOSTED_LICENCE.fullmatch(t))


def _ptr(path):
    return "".join("/" + str(t).replace("~", "~0").replace("/", "~1") for t in path)


def _own(o, key=None):
    """The cite field that applies to o (or to o[key]): `<key>_cite`, then `cite`, then `cites`."""
    for k in ((key + "_cite",) if key else ()) + ("cite", "cites"):
        if isinstance(o, dict) and _cites(o.get(k)):
            return o[k]
    return None


def _cites(field):
    if isinstance(field, dict):
        return [field] if "label" in field or "source" in field else [v for v in field.values() if isinstance(v, dict)]
    if isinstance(field, list):
        return [c for c in field if isinstance(c, dict)]
    return []


def _slots(p):
    """Every participant-facing text position: (path, container, key, cite field, kind). kind 'image' = an image
    dict (its picture file), 'text' = a string, 'maybe' = a string under a key that is usually structural (data
    id / code / start / end / style …, data *_note, validate equals / contains, unknown presentation keys): held
    when it locates in its source, shipped otherwise."""
    out = []

    def tips(spans, path, cite):
        for i, sp in enumerate(spans if isinstance(spans, list) else []):
            if isinstance(sp, dict) and isinstance(sp.get("tooltip"), str):
                out.append((path + [i, "tooltip"], sp, "tooltip", cite, "text"))

    def span_or_cell(o):   # a span {start, end, style} or a table cell {text, mark, colspan}: keys are structural
        return isinstance(o.get("start"), int) and isinstance(o.get("end"), int) or "colspan" in o or "rowspan" in o

    def node(o, path, cite, in_data=False):
        """data, or a text / image / table value: strings inherit the nearest cite. Under data a key named *_note
        is material like any other (only the schema's own note keys elsewhere are operator remarks)."""
        if isinstance(o, dict):
            c = _own(o) or cite   # a dict holding `expr` may still carry cited text beside it
            if isinstance(o.get("src"), str):
                out.append((path, o, None, c, "image"))
            for k, v in o.items():
                if _CITE_KEY.search(k) or k == "expr":
                    continue
                kc = o[k + "_cite"] if _cites(o.get(k + "_cite")) else c   # a sibling `<key>_cite` names its source
                if isinstance(v, str) and (k in (_DATA_STRUCT if in_data else _STRUCT) or _NOTE_KEY.search(k)):
                    if in_data and kc is not None and not span_or_cell(o):
                        out.append((path + [k], o, k, kc, "maybe"))   # material if it is in the source
                    continue
                if not in_data and _NOTE_KEY.search(k):
                    continue
                if k == "spans" or k == "prompt_spans":
                    tips(v, path + [k], kc)
                elif isinstance(v, str):
                    if kc is not None:
                        out.append((path + [k], o, k, kc, "text"))
                else:
                    node(v, path + [k], kc, in_data)
        elif isinstance(o, list):
            for i, v in enumerate(o):
                if isinstance(v, str):
                    if cite is not None:
                        out.append((path + [i], o, i, cite, "text"))
                else:
                    node(v, path + [i], cite, in_data)

    def text_at(obj, key, path, cite, kind="text"):
        v = obj.get(key)
        if isinstance(v, str):
            if cite is not None:
                out.append((path + [key], obj, key, cite, kind))
        elif isinstance(v, (dict, list)):
            node(v, path + [key], cite)

    node(p.get("data"), ["data"], None, True)
    for sid, st in (p.get("stages") or {}).items():
        if not isinstance(st, dict):
            continue
        sp, sc = ["stages", sid], _own(st)
        for i, it in enumerate(st.get("content") or []):
            if isinstance(it, dict):
                for key in ("value", "text"):   # both, when an item carries both
                    text_at(it, key, sp + ["content", i], _own(it) or sc)
                for key in it:   # any other string on an item (caption, alt …): held if it is in the source
                    if key not in _ITEM_KNOWN and not _CITE_KEY.search(key) and not _NOTE_KEY.search(key):
                        text_at(it, key, sp + ["content", i], _own(it, key) or _own(it) or sc, "maybe")
                tips(it.get("spans"), sp + ["content", i, "spans"], _own(it) or sc)
        for i, r in enumerate(st.get("responses") or []):
            if not isinstance(r, dict):
                continue
            rp, rc = sp + ["responses", i], _own(r)
            for key in ("prompt", "instruction", "prefix", "suffix", "required_message", "min_chars_message",
                        "na_option", "button", "prefill", "columns", "widget_params"):
                text_at(r, key, rp, _own(r, key) or rc)
            for key in [k for k in r if k.endswith("_message") and k not in ("required_message", "min_chars_message")]:
                text_at(r, key, rp, _own(r, key) or rc)
            for key in r:   # any other string on a response (placeholder …): held if it is in the source
                if key not in _RESP_KNOWN and not key.endswith("_message") and not _CITE_KEY.search(key) \
                        and not _NOTE_KEY.search(key):
                    text_at(r, key, rp, _own(r, key) or rc, "maybe")
            tips(r.get("prompt_spans"), rp + ["prompt_spans"], r.get("prompt_cite") or rc)
            text_at(r, "anchors", rp, _own(r, "anchors") or rc)
            if isinstance(r.get("validate"), dict):
                vd = r["validate"]
                for key in [k for k in vd if "message" in k]:
                    if key == "message_label" and vd[key] == "missing" and vd.get("message") is None:
                        continue   # explicit absence of feedback, not participant wording
                    text_at(vd, key, rp + ["validate"], _own(vd, key) or _own(vd) or rc)
                for key in ("equals", "contains", "pattern"):   # the answer the screen accepted: source text?
                    text_at(vd, key, rp + ["validate"], _own(vd) or rc, "maybe")
            oc = _own(r, "options") or rc
            for j, o in enumerate(r["options"] if isinstance(r.get("options"), list) else []):
                if isinstance(o, dict):
                    text_at(o, "label", rp + ["options", j], _own(o) or oc)
                    tips(o.get("spans"), rp + ["options", j, "spans"], _own(o) or oc)
        pres = st.get("presentation")
        if isinstance(pres, dict):
            pc = _own(st, "presentation") or _own(pres) or sc   # presentation_cite, presentation.cite, the stage's
            text_at(pres, "button", sp + ["presentation"], _own(pres, "button") or pc)
            for key in pres:
                if key != "button" and not _CITE_KEY.search(key) and not _NOTE_KEY.search(key):
                    text_at(pres, key, sp + ["presentation"], _own(pres, key) or pc, "maybe")
        for key in ("required_message_page", "validate_page_message"):
            text_at(st, key, sp, _own(st, key) or sc)
        for key in ("sum_to", "single_switch"):
            if isinstance(st.get(key), dict):
                text_at(st[key], "message", sp + [key], _own(st[key]) or sc)
        for i, vp in enumerate(st.get("validate_page") or []):
            if isinstance(vp, dict):
                text_at(vp, "message", sp + ["validate_page", i], _own(vp) or sc)
    def flow(o, path):   # texts a sync node shows each member (`events`), cited on the node
        if isinstance(o, dict):
            if isinstance(o.get("events"), list):
                for i, ev in enumerate(o["events"]):
                    if isinstance(ev, str):
                        if _own(o) is not None:
                            out.append((path + ["events", i], o["events"], i, _own(o), "text"))
                    elif isinstance(ev, dict):
                        node(ev, path + ["events", i], _own(o))
            for k, v in o.items():
                if k != "events" and not _CITE_KEY.search(k):
                    flow(v, path + [k])
        elif isinstance(o, list):
            for i, v in enumerate(o):
                flow(v, path + [i])
    flow(p.get("flow"), ["flow"])
    for i, role in enumerate(p.get("roles") or [] if isinstance(p.get("roles"), list) else []):
        if isinstance(role, dict) and isinstance(role.get("shown"), dict):
            node(role["shown"], ["roles", i, "shown"], None)
    return out


_DIST_KEYS = ("tier", "licence", "attribution", "url", "doi", "sha256", "format")


def _source_distribution(key, d, declared, data):
    """A checked distribution entry for one source (raises ProjectionError); only the documented keys ship."""
    d = {k: v for k, v in d.items() if v is not None and k in _DIST_KEYS}
    if d["tier"] == "hosted":
        if not hosted_licence_ok(d.get("licence")):
            raise ProjectionError("source %r: tier hosted needs CC-BY, CC0 or public domain (CC-BY-SA, NC and ND "
                                  "sources are tier link or user); got %r" % (key, d.get("licence")))
        if not str(d.get("attribution") or "").strip():
            raise ProjectionError("source %r: tier hosted needs an attribution" % key)
        return d
    # the file sha256 is provenance only (the builder's copy); it never gates reading on the user's machine
    sha = d.get("sha256") or (declared.get("sha256") if isinstance(declared, dict) else None)
    if data is not None:
        sha = _d.sha256(data)   # what the locators were built and self-tested on
        d.setdefault("format", _d.sniff(data))
    if isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{64}", sha):
        d["sha256"] = sha
    else:
        d.pop("sha256", None)
    if d["tier"] == "link" and not (re.match(r"https?://", str(d.get("url") or "")) or
                                    re.match(r"10\.\d{4,}/\S+$", str(d.get("doi") or ""))):
        raise ProjectionError("source %r: tier link needs an http(s) url or a DOI" % key)
    return d


def project(protocol, tiers=None, sources=None, extractors=None, strict=True,
            pdf_extractor_family=_d.PDF_EXTRACTOR_FAMILY):
    """The distributable projection of a protocol, and a report.

    tiers       {source key: {tier, licence, attribution, url, sha256, format}}; overrides meta.sources[k].distribution.
                A source with neither is tier "user" (never hosted by default).
    sources     {source key: bytes}: the builder's private copies, used to compute and self-test every locator
    extractors  {"pdf": fn(bytes) -> [page texts]}: in a release exactly the PDF extractor the app ships
                (hsenv.distribution.pdfium_extractor(); its name and version go into every PDF locator and the app
                refuses any other). pdf_extractor_family: the required name prefix (None: any, for tests only).
    strict      True (every release): a verbatim / reported text that cannot be located, a source without the
                fields its tier needs, a cite naming an undeclared source, or held text inside a string that cannot
                be withheld (an expression, an id, a key) raises ProjectionError. False only for analysis: problems
                are listed in report["errors"].

    Held = every participant-facing text or image whose cites (any label but `missing`) name only non-hosted
    sources. A `derived` text that cannot be located in its source is our own wording and ships (listed in
    report["derived_shipped"] for review). The projection runs in the engine as it is: held texts are placeholders
    of the same length (U+2591), so flow, response formats and rules can be previewed without the text."""
    p = copy.deepcopy(protocol)
    cite_paths = _cite_paths(protocol)

    def computed(path, key=None):   # the computed rule with cite-ness decided by value
        return _computed(path, key, cite_paths)
    original_literals = _literals(protocol, cite_paths)
    sources = sources or {}
    meta = p.setdefault("meta", {})
    msrc = meta.get("sources") if isinstance(meta.get("sources"), dict) else {}
    tiers = tiers or {}
    errors = []
    dists = {}
    for k in sorted(set(msrc) | set(tiers)):
        declared = msrc.get(k)
        d = tiers.get(k) or (declared.get("distribution") if isinstance(declared, dict) else None) or {"tier": "user"}
        if not isinstance(d, dict) or d.get("tier") not in _d.TIERS:
            raise ProjectionError("source %r: distribution.tier must be one of %s" % (k, ", ".join(_d.TIERS)))
        if d["tier"] == "hosted":
            d = _source_distribution(k, dict(d), declared, sources.get(k))
        dists[k] = {x: y for x, y in d.items() if x in _DIST_KEYS}

    def tier(src):
        return (dists.get(src) or {}).get("tier", "user")

    def per_item(src):   # PDF parts never span a page: a stamp between pages cannot break them
        return (dists.get(src) or {}).get("format") == "pdf" or (
            src in sources and _d.sniff(sources[src]) == "pdf")

    held, held_texts, unlocated, unknown, withheld_files, derived_shipped = {}, [], [], set(), [], []
    scopes = {}

    def source_scope(src):
        if src not in scopes:
            data = sources.get(src)
            fmt = (dists.get(src) or {}).get("format") or (_d.sniff(data) if data is not None else None)
            scopes[src] = (fmt, _d.Scope(_d.units(fmt, data, extractors)) if data is not None else None)
        return scopes[src]

    def source_runs():
        """THE SourceRuns of every supplied non-hosted source (one instance for the whole projection)."""
        if "runs" not in low_cache:
            streams = []
            for k in sorted(sources):
                if k in dists and tier(k) != "hosted":
                    sc = source_scope(k)[1]
                    if sc is not None:
                        streams += [(k, sc.full(w)[0]) for w in ("plain", "dehyph")]
            low_cache["runs"] = SourceRuns(streams)
        return low_cache["runs"]

    def quotes_source(text):   # the one rule (SourceRuns.quoted): does a text quote a non-hosted source?
        return source_runs().quoted(text) is not None

    def hosted_prints(c, text):
        """A verbatim / reported cite of a hosted source exempts the text; when the builder supplied the hosted
        file, only if the text is in it."""
        if tier(c.get("source")) != "hosted" or c.get("label") not in ("verbatim", "reported"):
            return False
        if not isinstance(text, str):
            return True
        if c.get("source") not in sources:
            hosted_missing.add(str(c.get("source")))   # strict: the hosted file must be supplied to exempt
            return not strict
        fmt, sc = source_scope(c.get("source"))
        return sc is not None and _d.make_locator(text, fmt, sc.units, extractors, scope=sc) is not None

    hosted_unconfirmed, low_cache, hosted_missing, non_nfc, uncited_images = [], {}, set(), [], []
    verified_hosted_slots = set()
    any_non_hosted = any(d.get("tier") != "hosted" for d in dists.values())
    for path, cont, key, cf, kind in _slots(p):
        if computed(path):
            continue   # never held: the engine computes with it (source text there is a _literals error)
        cs = [c for c in _cites(cf) if c.get("label") in ("verbatim", "reported", "derived")]
        if kind == "image" and not _cites(cf) and any_non_hosted:
            uncited_images.append(_ptr(path))   # a picture must say where it comes from (or `missing`)
        if not cs:
            continue   # uncited / missing: it ships (uncited source text is caught below)
        value = cont.get("src") if kind == "image" else cont[key]
        hosted_matches = [c for c in cs if hosted_prints(c, value)]
        if hosted_matches:
            # Remember only this exact text slot, with verified original bytes. A
            # matching restricted reference must not override a licensed source.
            for c in hosted_matches:
                src = c.get("source")
                declared = msrc.get(src) or {}
                sha = (dists.get(src) or {}).get("sha256") or declared.get("sha256")
                if kind != "image" and src in sources and sha == _d.sha256(sources[src]):
                    verified_hosted_slots.add(tuple(path))
            continue   # a hosted source prints it: it ships
        if any(tier(c.get("source")) == "hosted" and c.get("label") in ("verbatim", "reported") for c in cs) \
                and not any(tier(c.get("source")) != "hosted" for c in cs):
            if all(c.get("source") in sources for c in cs):
                hosted_unconfirmed.append(_ptr(path))   # cited to a hosted source that does not print it
            continue
        c = ([x for x in cs if x.get("label") == "verbatim"] or [x for x in cs if x.get("label") == "reported"]
             or cs)[0]
        src, label = c.get("source"), c.get("label")
        if src not in dists:
            unknown.add(str(src))
        if kind == "image":
            hid = "h%d" % (len(held) + 1)
            reg = _d.region_locator(src, c.get("page"), cont.get("region") or c.get("region"))
            held[hid] = {"path": _ptr(path), "source": src, "kind": "image", "sha256": cont.get("sha256"),
                         "locator": reg or {"format": "image", "page": c.get("page")}}
            withheld_files.append(cont["src"])
            continue
        text = cont[key]
        if not _d.canon_only(text):
            continue   # whitespace only
        if unicodedata.normalize("NFC", text) != text:
            non_nfc.append(_ptr(path))
        entry = {"path": _ptr(path), "source": src, "kind": "text", "length": len(text),
                 "text_sha256": _d.text_sha256(text)}
        if kind == "maybe":   # usually structural: held only when it is in the source
            fmt, scope = source_scope(src)
            loc = None
            if scope is not None and len(_d.canon_only(text)) >= 8:
                loc = _d.make_locator(text, fmt, scope.units, extractors, scope=scope, per_unit=per_item(src))
            if loc is None:
                if scope is not None and len(_d.canon_only(text)) >= 8 and quotes_source(text):
                    unlocated.append({"path": entry["path"], "source": src, "label": label,
                                      "why": "quotes a non-hosted source but cannot be located"})
                continue
            entry["locator"] = loc
        elif c.get("read") == "image":
            reg = c.get("region")
            if reg is None and "lines" in path:   # a line of an image (a dict with src): the image's own region
                img = _d._get(p, _ptr(path[:len(path) - path[::-1].index("lines") - 1]))
                if isinstance(img, dict) and isinstance(img.get("src"), str):
                    reg = img.get("region") or (_cites(_own(img)) or [{}])[0].get("region")
            entry["locator"] = _d.region_locator(src, c.get("page"), reg) or {"format": "image_reading",
                                                                              "page": c.get("page")}
        else:
            fmt, scope = source_scope(src)
            loc = None
            if scope is not None:
                pg = c.get("page")
                hint = pg - 1 if isinstance(pg, int) and fmt == "pdf" else None
                loc = _d.make_locator(text, fmt, scope.units, extractors, hint, scope=scope, per_unit=per_item(src))
            if loc is None and label == "derived" and scope is not None and not quotes_source(text):
                derived_shipped.append(entry["path"])   # our own wording: nothing of the source in it
                continue
            if loc is None:
                unlocated.append({"path": entry["path"], "source": src, "label": label,
                                  "why": "no source file given" if scope is None else
                                  ("a derived text that quotes the source but cannot be located" if label == "derived"
                                   else "not found in the source")})
                entry["locator"] = {"format": fmt, "page": c.get("page")}
            else:
                entry["locator"] = loc
        hid = "h%d" % (len(held) + 1)
        held[hid] = entry
        held_texts.append(text)
        cont[key] = _d.PLACEHOLDER * len(text)
    if uncited_images:
        errors.append("%d image(s) without a cite while a source is not hosted (cite it, or label it missing): %s" % (
            len(uncited_images), ", ".join(uncited_images[:10])))
    if hosted_missing:
        errors.append("hosted source(s) %s: supply the hosted file so every exempted text is checked against it" %
                      ", ".join(sorted(hosted_missing)))
    if non_nfc:
        errors.append("%d held text(s) are not NFC (normalise text and spans at build time): %s" % (
            len(non_nfc), ", ".join(non_nfc[:10])))
    if hosted_unconfirmed:
        errors.append("%d text(s) cited to a hosted source are not in the supplied hosted file: %s" % (
            len(hosted_unconfirmed), ", ".join(hosted_unconfirmed[:10])))
    for e in held.values():   # a region must lie on a page the builder's file has
        lc = e["locator"]
        if lc.get("format") == "region" and lc["source"] in sources:
            f_, sc = source_scope(lc["source"])
            if sc is not None and f_ == "pdf" and lc["page"] > len(sc.units):
                errors.append("region of %s on page %d, but the source has %d pages" % (
                    e["path"], lc["page"], len(sc.units)))
    if pdf_extractor_family:
        bad = sorted({e["locator"].get("extractor") for e in held.values() if e["locator"].get("format") == "pdf"
                      and not str(e["locator"].get("extractor")).startswith(pdf_extractor_family)})
        if bad:
            errors.append("PDF locators must be written by the extractor the app ships (%s…): got %s" % (
                pdf_extractor_family, ", ".join(map(str, bad))))

    # operator side: quotes of a non-hosted source outside the screen (meta notes, cite evidence, conflicts) are held
    # the same way when they can be located (rehydration restores them), otherwise withheld for good
    counts = {"operator_held": 0, "withheld": 0}

    def hold_operator(cont, key, src, page=None, always=True, at=None):
        if at is not None and computed(at):
            return   # a computed position is never held or withheld (_literals / _scan refuse source text there)
        text = cont[key]
        if not isinstance(text, str) or _is_withheld(text) or not _d.canon_only(text):
            return
        if set(text) == {_d.PLACEHOLDER}:
            return
        fmt, scope = source_scope(src) if src in dists else (None, None)
        loc = None
        if scope is not None:
            hint = page - 1 if isinstance(page, int) and fmt == "pdf" else None
            loc = _d.make_locator(text, fmt, scope.units, extractors, hint, scope=scope, per_unit=per_item(src))
        if loc is None:
            if always:
                cont[key] = _d.WITHHELD + _d.sha256(text)[:16]
                counts["withheld"] += 1
            return
        held["h%d" % (len(held) + 1)] = {"path": None, "source": src, "kind": "text", "role": "operator",
                                          "length": len(text), "text_sha256": _d.text_sha256(text), "locator": loc,
                                          "_ref": (cont, key)}
        held_texts.append(text)
        cont[key] = _d.PLACEHOLDER * len(text)
        counts["operator_held"] += 1

    def withheld_source(c):   # a cite without a source fails closed (treated as non-hosted)
        return isinstance(c, dict) and tier(c.get("source")) != "hosted"

    def operator_walk(o, path):
        if isinstance(o, dict):
            cs = [c for c in _cites(_own(o)) if c.get("label") in ("verbatim", "reported")]
            if path[:1] not in _SCREEN_TOP and cs and all(withheld_source(c) for c in cs):
                for k_ in list(o):   # a quote outside the screen: its text (or answer, line …) is the source's
                    if isinstance(o[k_], str) and k_ not in _STRUCT and not _CITE_KEY.search(k_) \
                            and not _NOTE_KEY.search(k_) and (k_ == "text" or (
                                re.search(r"\s", o[k_].strip()) and len(_d.canon_only(o[k_])) >= _SCAN_MIN)):
                        hold_operator(o, k_, cs[0].get("source"), cs[0].get("page"), always=(k_ == "text"),
                                      at=path + [k_])
            for k, v in o.items():
                is_cite = tuple(str(x) for x in path + [k]) in cite_paths   # a cite by value (the one decision)
                if is_cite:
                    for c in _cites(v):
                        if withheld_source(c):
                            for ck in list(c):
                                if ck in CITE_KEEP or _CITE_KEY.search(ck):
                                    continue
                                if isinstance(c[ck], str):
                                    hold_operator(c, ck, c.get("source"), c.get("page"), at=path + [k, ck])
                                elif isinstance(c[ck], list):
                                    for i in range(len(c[ck])):
                                        if isinstance(c[ck][i], str):
                                            hold_operator(c[ck], i, c.get("source"), c.get("page"),
                                                          at=path + [k, ck, i])
                                elif c[ck] is not None and not isinstance(c[ck], (int, float, bool)):
                                    c[ck] = _d.WITHHELD + _d.sha256(repr(c[ck]))[:16]
                                    counts["withheld"] += 1
                    continue
                operator_walk(v, path + [k])
        elif isinstance(o, list):
            for i, v in enumerate(o):
                operator_walk(v, path + [i])
    for k in list(p):
        if k != "distribution":
            operator_walk(p[k], [k])

    # coding cases quoted from a source (the paper's coded examples) are that source's text: held when they locate
    # in the case's own cite source or in the coding rule's cite source; invented cases (ours) ship
    def cases_walk(o):
        if isinstance(o, dict):
            if isinstance(o.get("cases"), list):
                rule_cs = [c for c in _cites(_own(o)) if withheld_source(c)]
                for case in o["cases"]:
                    if not isinstance(case, dict) or not isinstance(case.get("text"), str):
                        continue
                    own = [c for c in _cites(_own(case)) if c.get("label") in ("verbatim", "reported")]
                    if own:
                        if all(withheld_source(c) for c in own):
                            hold_operator(case, "text", own[0].get("source"), own[0].get("page"))
                    elif rule_cs and len(_d.canon_only(case["text"])) >= 4:
                        hold_operator(case, "text", rule_cs[0].get("source"), rule_cs[0].get("page"), always=False)
            for v in o.values():
                cases_walk(v)
        elif isinstance(o, list):
            for v in o:
                cases_walk(v)
    cases_walk({k: v for k, v in p.items() if k != "distribution"})

    # any other string of >= _QUOTE_MIN canonical characters found word for word in a non-hosted source the builder
    # supplied: held (or withheld) outside data / stages / roles; inside them it is source text without a cite
    others = [(k, sc) for k, (f_, sc) in list(scopes.items()) if sc is not None and tier(k) != "hosted"]
    for k in sorted(set(sources) - set(scopes)):
        if k in dists and tier(k) != "hosted":
            others.append((k, source_scope(k)[1]))
    uncited, key_quotes = [], []
    found_in = None
    if others:
        runs = source_runs()   # the same single instance as the slot checks
        found_in, whole_in_source = runs.quoted, runs.whole   # the one run / whole rule (quoted = run or whole)

        def screen_quote(text):   # operator / uncited screen text: run rule, whole rule for CJK only
            return runs.quoted(text, latin=False)

        def bound_cell_key(path, key):
            # Reported interaction cells use level_a|level_b as an index, not prose.
            # Levels themselves remain subject to normal computed/literal checks.
            if len(path) != 5 or path[:2] != ["analysis", "effects"] or path[3:] != ["reported", "cells"]:
                return False
            effects = (p.get("analysis") or {}).get("effects")
            if not isinstance(effects, list) or not isinstance(path[2], int):
                return False
            effect = effects[path[2]]
            c = effect.get("compute") if isinstance(effect, dict) else None
            if not isinstance(c, dict) or c.get("op") != "interaction":
                return False
            aa, bb = c.get("a_levels"), c.get("b_levels")
            if not isinstance(aa, list) or not isinstance(bb, list):
                return False
            if not all(isinstance(x, str) and _IDENT.fullmatch(x) for x in aa + bb):
                return False
            return key in {a + "|" + b for a in aa for b in bb}

        def quote_walk(o, path):
            if isinstance(o, dict):
                items = list(o.items())
                for k in o:   # a dict key cannot be withheld: source text in a key is an error, everywhere
                    if isinstance(k, str) and not bound_cell_key(path, k) and not _TOKEN.fullmatch(k.strip()) and \
                            (found_in(k) is not None or whole_in_source(k)):   # the same rules as for values
                        key_quotes.append(_ptr(path + [k]))
            elif isinstance(o, list):
                items = list(enumerate(o))
            else:
                return
            skip = _DATA_SKIP if path[:1] == ["data"] else _STRUCT   # under data, start / end / id / code are text too
            for k, v in items:
                if isinstance(v, str) and ((path[:2] == ["meta", "sources"] and len(path) == 3 and k in _BIB)
                                           or (path == ["meta"] and k == "citation")):
                    continue   # bibliographic strings (the citation, a source's title …); _scan still checks them
                if isinstance(v, str):
                    if tuple(path + [k]) in verified_hosted_slots:
                        continue   # exact, cited, licensed and hash-verified text only
                    if computed(path, k):
                        continue   # computed: never held or withheld; the computed check below refuses quotes
                    if _is_withheld(v) or set(v) == {_d.PLACEHOLDER} or _TOKEN.fullmatch(v.strip()):
                        continue   # a URL, DOI, hash or path printed in the source is not a quote
                    if k in skip and _IDENT.fullmatch(v.strip()):
                        continue   # a structural key exempts only its own token-shaped value
                    src = screen_quote(v)
                    if src is None:
                        continue
                    operator = _operator(path + [k], cite_paths)   # the one operator-vs-material decision
                    if path[:1] in _SCREEN_TOP and not operator:
                        uncited.append({"path": _ptr(path + [k]), "source": src})
                    elif k in skip:
                        key_quotes.append(_ptr(path + [k]) + " (structural value)")   # cannot be withheld
                    else:
                        hold_operator(o, k, src)
                elif not (path == ["meta"] and k == "citation") and k != "distribution":
                    quote_walk(v, path + [k])   # subtrees under structural keys are read like any other
        for k in list(p):
            if k != "distribution":
                quote_walk(p[k], [k])
    # string literals inside expressions, flow `for … in` lists and vars cannot be held (the engine computes with
    # them): one found in a supplied non-hosted source is an error; without sources they are only counted
    lit_hits, lit_unchecked = [], 0
    for lpath, lit in original_literals:   # taken from the protocol before anything was held or withheld
        if found_in is None:
            if len(_skel(lit)) >= 6:
                lit_unchecked += 1
        elif found_in(lit) is not None:   # the one run / whole rule (SourceRuns.quoted)
            lit_hits.append(lpath)
    computed_images = []

    def image_walk(o, path):
        if isinstance(o, dict):
            if isinstance(o.get("src"), str) and computed(path):
                computed_images.append(_ptr(path))
            for k, v in o.items():
                image_walk(v, path + [k])
        elif isinstance(o, list):
            for i, v in enumerate(o):
                image_walk(v, path + [i])
    for k, v in protocol.items():
        if k in _ENGINE_TOPS:
            image_walk(v, [k])
    if computed_images:
        errors.append("%d image(s) at computed positions (a picture there is never held; move it into data or a stage "
                      "with a cite): %s" % (len(computed_images), ", ".join(computed_images[:10])))
    if lit_hits:
        errors.append("%d source text(s) inside expressions / computed positions (release.COMPUTED: vars, conditions, "
                      "flow lists, unit fields, populations …), which cannot be held (move the text into data with a "
                      "cite): %s" % (len(lit_hits), ", ".join(lit_hits[:10])))
    if key_quotes:
        errors.append("%d dict key(s) / structural value(s) are source text (cannot be withheld): %s" % (
            len(key_quotes), ", ".join(key_quotes[:10])))
    if uncited:
        errors.append("%d on-screen string(s) (data / stages / roles / flow) are source text without a cite: %s" % (
            len(uncited), ", ".join(u["path"] for u in uncited[:10])))

    for k in sorted({e["source"] for e in held.values()} & set(dists)):   # sources that hold text: full check
        try:
            dists[k] = _source_distribution(k, dists[k], msrc.get(k), sources.get(k))
        except ProjectionError as e:
            errors.append(str(e))
    if unknown:
        errors.append("cites name sources missing from meta.sources: %s" % ", ".join(sorted(unknown)))
    if unlocated:
        errors.append("%d held text(s) cannot be located: %s" % (
            len(unlocated), "; ".join("%s (%s: %s)" % (u["path"], u["source"], u["why"]) for u in unlocated[:10])))
    replaced, leaks, screen_fragments = _scan(p, held_texts, cite_paths)
    if leaks:
        errors.append("held text inside shipped strings that cannot be withheld: %s" % ", ".join(leaks[:10]))
    if strict and errors:
        raise ProjectionError(" | ".join(errors))
    # operator entries were found by reference: their JSON pointers now
    if any("_ref" in e for e in held.values()):
        _fill_paths(p, held)

    for k, d in dists.items():
        if k in msrc:
            msrc[k] = dict(msrc[k], distribution=d) if isinstance(msrc[k], dict) else {"name": msrc[k],
                                                                                         "distribution": d}
    p["distribution"] = {
        "format": PROJECTION_FORMAT, "hsenv": HSENV_VERSION, "placeholder": _d.PLACEHOLDER, "held": held,
        "strict": bool(strict),
        "attribution": [{"source": k, "licence": d.get("licence"), "attribution": d.get("attribution")}
                        for k, d in sorted(dists.items()) if d.get("tier") == "hosted"]}
    report = {
        "held": len(held), "by_source": {}, "errors": errors, "unlocated": unlocated,
        "unknown_sources": sorted(unknown), "derived_shipped": derived_shipped,
        "requires_reading": sorted(h for h, e in held.items() if e["locator"].get("format") == "image_reading"),
        "regions": sorted(h for h, e in held.items() if e["locator"].get("format") == "region"),
        "quote_scan_unchecked": sorted(k for k, d in dists.items() if d.get("tier") != "hosted"
                                       and k not in sources),
        "literals_in_source": lit_hits, "literals_unchecked": lit_unchecked, "screen_fragments": screen_fragments,
        "withheld_files": sorted(set(withheld_files)), "operator_held": counts["operator_held"],
        "withheld": counts["withheld"] + replaced, "uncited_source_text": uncited,
        "tiers": {k: d.get("tier") for k, d in dists.items()}}
    for e in held.values():
        report["by_source"][e["source"]] = report["by_source"].get(e["source"], 0) + 1
    return p, report


# a shipped string sharing a run of >= _QUOTE_MIN canonical characters (about four words) with a non-hosted source is
# a quote: held when it locates, else withheld (outside data / stages) or an error (inside). Index: K-character
# windows at every STEP-th source position, so any common run of K + STEP - 1 characters is found.
_K, _STEP = 20, 4
_QUOTE_MIN = _K + _STEP - 1
# bibliographic fields: the paper's own title / authors / venue are facts that identify the source, not its text
_BIB = frozenset(("title", "authors", "author", "journal", "venue", "publisher", "doi", "year", "citation", "paper",
                  "volume", "issue", "pages", "editors", "booktitle"))
_IDENT = re.compile(r"[A-Za-z0-9_.:/#@+-]{1,80}")   # an id / code / format token (ASCII, no spaces)
_TOKEN = re.compile(r"(?:[a-z][a-z0-9+.-]*://|doi:|10\.[0-9]{4,}/)[\x21-\x7e]*|[0-9a-fA-F]{16,}"
                    r"|\.{0,2}/[\w./~-]+|(?:[\w.~-]+/)+[\w~-]+\.[a-z0-9]{1,8}", re.I | re.A)   # ASCII only: a CJK sentence with a slash is never a token
_SCREEN_TOP = (["data"], ["stages"], ["roles"], ["flow"])   # top-level parts that hold participant-facing text
_LIT_MIN = 12   # expression / flow-list / vars literals this long are searched for in the supplied sources


# confusable letters folded to their Latin look-alike in every leak scan (Cyrillic / Greek homoglyphs), after
# case folding; the scans compare _fold() forms, never served text
_SKELETON = str.maketrans({"а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i",
                           "ј": "j", "ѕ": "s", "ԁ": "d", "ɡ": "g", "һ": "h", "ӏ": "l", "ԛ": "q", "ԝ": "w",
                           "ο": "o", "α": "a", "ε": "e", "ρ": "p", "τ": "t", "ν": "v", "ι": "i", "κ": "k",
                           "υ": "u", "χ": "x", "μ": "u", "ѵ": "v", "ɩ": "i", "ı": "i"})


def _cmp(canonical):
    """The comparison form of an already canonical stream: full NFKC (fullwidth / halfwidth digits and Latin, ７ / 7,
    Ａ / A, become one), case-folded, confusables mapped to Latin. Comparison only: never served, never in a
    locator (restore ops are built on the canonical form, which keeps letters and digits as they are)."""
    return unicodedata.normalize("NFKC", canonical).lower().translate(_SKELETON)


def _fold(text):
    """What leak scans compare: canonical form, then _cmp."""
    return _cmp(_d.canon_only(text))


# scripts written without spaces between words (CJK, Thai, Lao, Khmer, Myanmar): matched by substring like CJK
_UNSPACED = ((0x0E00, 0x0EFF), (0x1000, 0x109F), (0x1780, 0x17FF))


def _wide(ch):
    if unicodedata.east_asian_width(ch) in ("W", "F"):
        return True
    o = ord(ch)
    return any(a <= o <= b for a, b in _UNSPACED)


_K_WIDE = 8   # CJK: a run of 8 wide characters (a short sentence) counts as a quote
# a leading enumerator, matched on the folded form (NFKC: "（1）" is "(1)"): 1. 1) (1) 1、 1: item 1: • - – *
# a leading enumerator, matched on the folded form (NFKC: "（1）" is "(1)", "①" is "1"): 1. 1) (1) 1、 1.1 i. (ii)
# a) 一、 Item 1: Q1a. 質問1： 문항 1. bullets
_ENUM = re.compile(r"^(?:(?:item|question|q|質問|问题|题|문항)\d{1,3}(?:[a-z](?=[.):]))?[.):]?"
                   r"|[a-z]{1,5}\d{1,3}[.)]|no\.?\d{1,3}[.):]?|\[\]"
                   r"|\(?\d{1,3}(?:\.\d{1,3})*(?:[a-z](?=[.)、:]))?[.)、:]?"
                   r"|\(?(?:[ivx]{1,5}|[a-z])[.)]|\((?:[ivx]{1,5}|[a-z])\)"
                   r"|[一二三四五六七八九十]{1,3}[、.]|[\u2460-\u2473\u2474-\u2487\u2488-\u249b\u24b6-\u24e9]"
                   r"|[•\-–*·□☐○●◯■◻▪])")
# a trailing marker: a short parenthetical (reverse-keyed "(R)", "（反向）", "(역)") or a footnote sign
_TRAIL = re.compile(r"(?:\([^()]{1,24}\)|\[[^\[\]]{1,24}\]|[*†‡§]+)$")
_TAG = re.compile(r"<[A-Za-z/!][^<>\n]*>")   # one line: "A<B … B>A" across lines is text, not a tag


def _is_withheld(v):
    """Only an exact withheld marker is exempt from the scans (never a string that merely starts with the word)."""
    return isinstance(v, str) and re.fullmatch(_d.WITHHELD + r"[0-9a-f]{16}", v) is not None


def _skel(text):
    """The alphanumeric skeleton the held-text check compares: folded (canonical, case-folded, confusables mapped),
    then only letters, digits and CJK kept — punctuation, symbols and spacing differences never hide a copy."""
    return "".join(ch for ch in _fold(text) if ch.isalnum())


def _forms(s):
    """THE forms of a string every leak comparison looks at (no caller normalises on its own): the string as it is,
    HTML-unescaped repeatedly until stable (capped at 8 rounds: "&amp;amp;lt;" and deeper), and each of those with
    single-line tags `<[A-Za-z/!][^<>\\n]*>` replaced by a space (a tag hides nothing; angle-bracket text such as
    "Press <Enter>" stays text in the untagged-free form). NFKC, case and confusables are handled downstream by
    _fold / _skel."""
    import html as _html
    if not isinstance(s, str):
        return []
    out = [s]
    while "&" in out[-1] and len(out) < 9:
        u = _html.unescape(out[-1])
        if u == out[-1]:
            break
        out.append(u)
    out += [_TAG.sub(" ", x) for x in out if "<" in x]
    return list(dict.fromkeys(out))


class HeldIndex:
    """THE held-text check, shared by the projection scan, scanned JSON files and hosted sourcetext, so the three
    cannot drift. On the alphanumeric skeleton (_skel):
      whole     the skeleton (also with a leading enumerator / trailing digit run removed) equals a held text's of
                6-15 characters; or contains a whole held text (a CJK held text of >= 6 characters counts inside a
                sentence, since CJK has no word boundaries); or the string hashes to a held text / part
      fragment  a 16-character skeleton fragment, or an 8-character CJK skeleton run, of a held text
    hit(s) -> None | "whole" | "fragment"."""

    def __init__(self, texts=(), hashes=()):
        self.frags, self.wide, self.whole, self.fulls, self.cjk = set(), set(), set(), [], []
        self.hashes = set(hashes)
        self.digits = any(_skel(t).isdigit() for t in texts)
        for t in texts:
            c = _skel(t)
            if len(c) >= _SCAN_MIN:
                self.fulls.append(c)
                self.frags.update(c[i:i + _SCAN_MIN] for i in range(len(c) - _SCAN_MIN + 1))
            elif len(c) >= _WHOLE_MIN:
                self.whole.add(c)
                if any(_wide(ch) for ch in c):   # CJK, also with digits / Latin inside (过去7天…)
                    self.cjk.append(c)
            self.wide.update(_cjk_windows(c))   # the shared CJK window rule (SourceRuns uses the same)

    def __bool__(self):
        return bool(self.frags or self.wide or self.whole or self.hashes)

    def _candidates(self, s):
        out = set()
        scale = re.sub(r"(?:\s+\d+)+(?:\s+n/?a)?\s*$|\s+n/a\s*$", "", s, flags=re.I)   # a printed response scale
        for raw in {s, scale}:   # tags / entities: _forms already gave every form to hit()
            f = "".join(ch for ch in _fold(raw) if ch.isalnum() or ch in "().、:•-–*·†‡§[]□☐○●◯■◻▪")
            for g in {f, _TRAIL.sub("", f)}:
                for h in {g, _ENUM.sub("", g), _ENUM.sub("", _ENUM.sub("", g))}:   # nested "1. (a)"
                    out.add(_skel_of(_TRAIL.sub("", h)))
                    out.add(_skel_of(h))
        out |= {re.sub(r"\d+$", "", x) for x in list(out)}   # trailing digits (a scale printed without spaces)
        return out

    def hit(self, s, short=True):
        """short=False (one ASCII token: an id, a code, a layout entry, a key): the whole-string rule for short held
        texts is not applied — `gender` is not the label "Gender:" being shipped (a single word is not protectable
        and is guessable from its hash anyway); fragments and hashes still are."""
        r = [self._hit(x, short) for x in _forms(s)]
        return "whole" if "whole" in r else "fragment" if "fragment" in r else None

    _forms = staticmethod(_forms)

    def _hit(self, s, short=True):
        if "\t" in s:   # tab-separated columns: each cell is a candidate too
            for cell in s.split("\t"):
                if cell.strip() and cell != s and self.hit(cell, short) == "whole":
                    return "whole"
        c = _skel(s)
        if short and ((self._candidates(s) & self.whole) or any(x in c for x in self.cjk)):
            return "whole"
        if _d.text_sha256(s) in self.hashes or _d.sha256(_d.canon_only(s)) in self.hashes:
            return "whole"
        if any(c[i:i + _SCAN_MIN] in self.frags for i in range(len(c) - _SCAN_MIN + 1)) or \
                any(w in self.wide for w in _cjk_windows(c)):
            # a whole held text inside implies one of its fragments: only now look for the whole one
            return "whole" if any(x in c for x in self.fulls) else "fragment"
        return None

    def shares(self, s, n):
        """s (any of its _forms) shares a run of n skeleton characters with a held text."""
        for form in _forms(s):
            c = _skel(form)
            if any(c[i:i + n] in x for x in self.fulls for i in range(len(c) - n + 1)):
                return True
        return False

    def text_file(self, content):
        """A plain-text file carries no held text: decoded strictly (UTF-8), HTML entities unescaped, line-end
        hyphenation joined, digit-only lines dropped, then the whole document and each line checked. False on any
        hit or a decoding error."""
        try:
            text = content.decode("utf-8") if isinstance(content, (bytes, bytearray)) else str(content)
        except UnicodeDecodeError:
            return False
        text = _d._HYPHEN_BREAK.sub("", text)   # entities and tags: hit() checks every form of each line
        all_lines = text.splitlines()
        lines = [ln for ln in all_lines if not re.fullmatch(r"[\s\d.,;:()\[\]-]*", ln)]
        if self.digits:   # an all-digit held text (a code, a number sequence): digit-only lines are kept
            lines = [ln for ln in all_lines if ln.strip()]
        if self.hit("\n".join(lines)):
            return False
        cells = [c for ln in lines if "\t" in ln for c in ln.split("\t") if c.strip()]   # tab-separated columns
        return not any(self.hit(x) for x in lines + cells)


def _skel_of(folded):
    return "".join(ch for ch in folded if ch.isalnum())


_UNIT = re.compile(r"[a-z0-9]+|.", re.S)
_CJK_MIN = 5   # CJK characters a CJK window needs (digits and Latin never count: 在0到100之间 is no window)


def _cjk_window(w):
    """True when a skeleton string holds a CJK window (see _cjk_windows)."""
    return next(_cjk_windows(w), None) is not None


def _cjk_windows(sk):
    """THE CJK window rule (HeldIndex and SourceRuns both use it): windows of 8 skeleton characters with at least 5
    CJK characters, and windows of 7 skeleton units holding an ASCII run, where each maximal ASCII run is one unit
    (我使用ChatGPT写作业: `chatgpt` counts once), with at least 6 CJK units, or 5 when the window holds Latin letters
    (次Q音乐App听歌) — digits and Latin never count toward the CJK share (过去12个月里, 在0到100之间 and 每天使用TikTok are no window) — so digits and Latin inside a Chinese item count toward the run and punctuation never breaks
    it (the skeleton has none). Yields the window strings."""
    if not any(_wide(ch) for ch in sk):
        return
    for i in range(0, len(sk) - _K_WIDE + 1):   # 8 characters, >= 5 of them CJK (过去7天我睡得, 我用AI写过作业)
        w = sk[i:i + _K_WIDE]
        if sum(1 for ch in w if _wide(ch)) >= _CJK_MIN:
            yield w
    units = _UNIT.findall(sk)
    if len(units) < len(sk):   # an ASCII run counting as one unit (我使用ChatGPT写作业): 7 units, >= 6 of them CJK
        n = _K_WIDE - 1
        for i in range(0, len(units) - n + 1):
            w = units[i:i + n]
            cjk = sum(1 for u in w if len(u) == 1 and _wide(u))
            lettered = any(u.isascii() and any(c.isalpha() for c in u) for u in w)
            if any(len(u) > 1 for u in w) and (cjk >= n - 1 or (cjk >= n - 2 and lettered)):
                yield "\x01" + "".join(w)   # a unit window: never equal to a character window


def _skel_stream(canonical):
    """The skeleton of an already canonical stream (a source)."""
    return "".join(ch for ch in _cmp(canonical) if ch.isalnum())


def _lettered(sk):
    """A run must hold a letter or a CJK character: digits alone (a printed scale, a code list) are not a quote."""
    return any(ch.isalpha() for ch in sk)


class SourceRuns:
    """THE source run / whole rule, on the alphanumeric skeleton (the same comparison form as HeldIndex), shared by
    the quote net (`found_in`), the computed-position check (strings, literals, keys) and scanned JSON:
      run    a text shares a run of >= _QUOTE_MIN skeleton characters with a source, or a CJK window (_cjk_window)
      whole  a text's skeleton (>= _LIT_MIN characters, >= 6 when it has a CJK character; not one ASCII token)
             appears whole in a source
    Both look at every _forms of the text."""

    def __init__(self, streams):
        """streams: [(source key, canonical stream)]."""
        self.skels = [(k, _skel_stream(x)) for k, x in streams]
        self.index, self.wide = {}, {}   # window -> every source holding it
        for k, sk in self.skels:
            for i in range(0, max(0, len(sk) - _K + 1), _STEP):
                self.index.setdefault(hash(sk[i:i + _K]), set()).add(k)
            for w in _cjk_windows(sk):
                self.wide.setdefault(w, set()).add(k)

    def __bool__(self):
        return bool(self.skels)

    def _confirm(self, sk, k, i, memo):
        """A run of _QUOTE_MIN characters through the index hit at text position i is in source k. The source
        windows sit at every _STEP-th position, so such a run starts within _STEP - 1 characters before i; each
        (source, run) is checked once per found() call (memo)."""
        full = None
        for j in range(max(0, i - (_QUOTE_MIN - _K)), i + 1):
            run = sk[j:j + _QUOTE_MIN]
            if len(run) < _QUOTE_MIN or not _lettered(run):
                continue
            key = (k, run)
            if key not in memo:
                if full is None:
                    full = [x for kk, x in self.skels if kk == k]
                memo[key] = any(run in f for f in full)
            if memo[key]:
                return True
        return False

    def found(self, text):
        """The source sharing a run with any form of the text, or None. A run holds at least one letter or CJK
        character (a printed 1-20 scale is not a quote)."""
        memo = {}
        for form in _forms(text):
            sk = _skel(form)
            for i in range(0, len(sk) - _K + 1):
                # every indexed piece is a lead, digit-only ones too: _confirm itself requires a lettered run
                for k in sorted(self.index.get(hash(sk[i:i + _K]), ())):   # confirm against every source
                    if self._confirm(sk, k, i, memo):
                        return k
            if self.wide:
                for w in _cjk_windows(sk):
                    if w in self.wide:
                        return sorted(self.wide[w])[0]
        return None

    def whole(self, text, latin=True):
        """The source containing some form of the text whole, or None. latin=False: CJK texts only (operator and
        uncited screen text, where a short Latin phrase — a country, a citation label, "ground squirrel" — is a
        fact rather than a quote, and the run rule covers longer Latin text)."""
        if _IDENT.fullmatch(text.strip()):
            return None
        for form in _forms(text):
            sk = _skel(form)
            cjk = any(_wide(ch) for ch in sk)
            if not cjk and not latin:
                continue
            need = 6 if cjk else _LIT_MIN
            if len(sk) >= need and _lettered(sk):
                for k, f in self.skels:
                    if sk in f:
                        return k
        return None

    def quoted(self, text, latin=True):
        """The run or the whole rule: the source the text quotes, or None. latin=False: whole rule for CJK only."""
        return self.found(text) or self.whole(text, latin)


def _is_cite(d):
    return d.get("label") in ("verbatim", "reported", "derived", "missing") and isinstance(d.get("source"), str)


def _literals(p, cites=None):
    """(path, string) of every string at a COMPUTED position, its string literals when it parses as a Python
    expression, and those literals joined (a sentence assembled from short pieces). Display strings are never parsed:
    an item such as '"…" (R)' is text, not a call."""
    import ast

    def parse(src):
        """(string literals in source order, joined concatenations) of an expression string. A body that is a string
        constant (also implicit adjacent literals "a" "b") yields its value. Only operands that concatenate are
        joined: `+` chains, `%` formatting, the engine's `join(sep, [...])` — never if-expression branches,
        comparisons or lists."""
        if "'" not in src and '"' not in src:
            return [], []
        try:
            tree = ast.parse(src.strip(), mode="eval")
        except (SyntaxError, ValueError, RecursionError, MemoryError):
            return [], []
        consts = [n for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)]
        pieces = [n.value for n in sorted(consts, key=lambda n: (n.lineno, n.col_offset))]

        def strs(node):
            return isinstance(node, ast.Constant) and isinstance(node.value, str)

        def chain(node):   # operands of a + chain, left to right
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
                return chain(node.left) + chain(node.right)
            return [node]
        joined = []
        for node in ast.walk(tree):
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
                ops = [n.value for n in chain(node) if strs(n)]
                if len(ops) >= 2:
                    joined.append("".join(ops))
            elif isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod) and strs(node.left):
                rhs = node.right.elts if isinstance(node.right, ast.Tuple) else [node.right]
                joined.append(node.left.value + "".join(n.value for n in rhs if strs(n)))
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "join" \
                    and len(node.args) == 2 and strs(node.args[0]) and isinstance(node.args[1], (ast.List, ast.Tuple)):
                joined.append(node.args[0].value.join(n.value for n in node.args[1].elts if strs(n)))   # join(sep, xs)
        return pieces, joined

    def walk(o, path):
        if isinstance(o, dict):
            for k, v in o.items():
                if (_CITE_KEY.search(k) or _NOTE_KEY.search(k)) and not _computed(path + [k], None, cites) and \
                        _classify([str(x) for x in path + [k]], cites)[-1] != _NAME:
                    continue   # cites and notes are operator text (an author-chosen name is not): quote net
                walk(v, path + [k])
        elif isinstance(o, list):
            for i, v in enumerate(o):
                walk(v, path + [i])
        elif isinstance(o, str) and _computed(path, None, cites):   # display strings are never parsed as Python
            yield_.append((_ptr(path), o))   # the value the engine uses
            pieces, joined = parse(o)
            for x in pieces + joined:   # literals (a bare constant's value too) and real concatenations
                yield_.append((_ptr(path), x))
    yield_ = []
    for k, v in p.items():
        if k not in ("meta", "distribution"):
            walk(v, [k])
    return yield_


def _fill_paths(p, held):
    """JSON pointers of held entries found by reference (operator side)."""
    want = {}
    for e in held.values():
        if "_ref" in e:
            cont, key = e.pop("_ref")
            want[(id(cont), key)] = e

    def walk(o, path):
        if isinstance(o, dict):
            it = o.items()
        elif isinstance(o, list):
            it = enumerate(o)
        else:
            return
        for k, v in it:
            e = want.get((id(o), k))
            if e is not None:
                e["path"] = _ptr(path + [k])
            walk(v, path + [k])
    walk({k: v for k, v in p.items() if k != "distribution"}, [])
    for e in held.values():
        if e.get("path") is None:
            raise ProjectionError("internal: a held operator string lost its position")


# THE registry of positions the engine (or the checks) evaluates as an expression or computes with as a value
# (hsenv/engine.py: every `ev({"expr": …})` and `ev(spec)` site; checks.py: coding `apply`). `*` = one path
# segment, `**` = any number. A string at a computed position is never held and never withheld: source or held text
# there is a strict error (moving the text into data with a cite is the fix). tests/test_distribution.py checks
# this list against engine.py so the two cannot drift.
COMPUTED = (
    ("vars", "**"),                          # vars: initial values and update rules
    ("**", "expr"),                          # any {"expr": …} value spec (Session.ev)
    ("**", "if"), ("**", "until"),            # flow / item / response / exclusion conditions
    ("**", "pending_if"),                    # exclusion pending_if
    ("**", "if_valid"),                      # stage validate_page[].if_valid
    ("coding", "*", "apply"),                # coding rule (checks run every case through it)
    ("flow", "**", "in", "**"),              # flow `for … in [values]`
    ("flow", "**", "let", "*"), ("flow", "**", "set", "*"), ("flow", "**", "loop"),
    ("flow", "**", "compute", "*"),          # sync compute (per member)
    ("units", "*", "fields", "*"),           # unit field specs
    ("**", "population", "values"), ("**", "population", "group_by"),   # exclusion and analysis populations
    ("keyed", "answers", "*"),               # keyed answers: expressions the checks evaluate (fuzz / self-test)
)


def _match(path, pattern):
    if not pattern:
        return not path
    if pattern[0] == "**":
        return any(_match(path[i:], pattern[1:]) for i in range(len(path) + 1))
    return bool(path) and (pattern[0] == "*" or pattern[0] == path[0]) and _match(path[1:], pattern[1:])


# the top-level parts the engine reads (data is read only through expressions, never evaluated itself)
_ENGINE_TOPS = frozenset(("vars", "flow", "stages", "units", "exclusions", "analysis", "keyed", "coding", "roles"))


_NAME = "\x00name"   # an author-chosen name, as the classifier sees it: matches `*`, never a keyword


def _cite_paths(protocol):
    """Paths (tuples of str) whose value IS a cite: a cite dict, a list of them, or a map name -> cite dict. Cite-ness
    is decided by the value, never by the key's name."""
    out = set()
    plain = CITE_KEEP | {"quote", "evidence", "note", "notes", "where", "conflict"}

    def one(d, strict):
        # on screen parts a dict shaped like a cite (a news stimulus {headline, source, label}) is a cite only when
        # it has no keys beyond a cite's own; elsewhere the shape is enough
        return _is_cite(d) and (not strict or set(d) <= plain or all(_CITE_KEY.search(k) or _NOTE_KEY.search(k)
                                                                     for k in set(d) - plain))

    def is_cite_value(v, strict):
        if isinstance(v, dict):
            return one(v, strict) or (bool(v) and all(isinstance(x, dict) and one(x, strict) for x in v.values()))
        return isinstance(v, list) and bool(v) and all(isinstance(x, dict) and one(x, strict) for x in v)

    def walk(o, path):
        if isinstance(o, dict):
            for k, v in o.items():
                strict = str((path + [k])[0]) in ("data", "stages", "roles", "flow") \
                    and not (isinstance(k, str) and _CITE_KEY.search(k))   # under a cite-named key: a cite
                if is_cite_value(v, strict):
                    out.add(tuple(str(x) for x in path + [k]))
                walk(v, path + [k])
        elif isinstance(o, list):
            for i, v in enumerate(o):
                walk(v, path + [i])
    walk(protocol, [])
    return frozenset(out)


def _operator(raw, cites):
    """THE operator-vs-material decision (one function, used by the quote net): a position is operator text when it
    lies inside a cite (decided by value: the cite paths), or — outside data and vars — under a note key that is not
    an author-chosen name. Under data and vars a note-named string is material: the engine may display it
    (data['panel_note']), so it is held / refused like any other text, never withheld."""
    raw = [str(x) for x in raw]
    if any(tuple(raw[:j + 1]) in cites for j in range(len(raw))):
        return True
    if raw and raw[0] in ("data", "vars"):
        return False
    full = _classify(raw, cites)
    return any(full[j] != _NAME and _NOTE_KEY.search(x) for j, x in enumerate(raw))


def _classify(full, cites=None):
    """The path with every author-chosen name segment replaced by _NAME: the child of vars / let / set / compute /
    fields, and stage, unit and coding ids. A name is never matched against reserved words (`apply`, `if`, `expr` …)
    nor against the cite / note key patterns: `vars.bonus_note` is a var, a stage called `apply` is a stage."""
    out = []
    for i, seg in enumerate(full):
        prev = out[i - 1] if i else None
        if ((i == 1 and full[0] in ("vars", "stages", "units", "coding")) or
                (i == 2 and full[:2] == ["keyed", "answers"]) or
                (prev in ("let", "set", "compute", "fields") and i >= 2)) and \
                (cites is not None or not _CITE_KEY.search(seg)):
            out.append(_NAME)   # without cite paths, a `<name>_cite` sibling stays a cite by its name
        else:
            out.append(seg)
    return out


def _computed(path, key=None, cites=None):
    """The position path (+ key) is in COMPUTED, or lies inside one — under a part the engine reads, and never inside
    a cite or a note (operator text, even under a computed ancestor). Author-chosen names (see _classify) are
    neither keywords nor cite / note keys."""
    raw = [str(x) for x in (list(path) + ([key] if key is not None else []))]
    full = _classify(raw, cites)
    if not full or full[0] not in _ENGINE_TOPS:
        return False
    if cites is not None:   # project(): a cite by its value (the cite paths), a note by the schema key pattern
        for j, x in enumerate(raw):
            if tuple(raw[:j + 1]) in cites:
                return False
            if full[j] != _NAME and _NOTE_KEY.search(x):
                return False
    elif any(x != _NAME and (_CITE_KEY.search(x) or _NOTE_KEY.search(x)) for x in full):
        return False
    for i in range(len(full), 0, -1):   # the position itself, or an ancestor that is computed
        if any(_match(full[:i], pat) for pat in COMPUTED):
            return True
    return False


def _scan(p, held_texts, cites=None):
    """Every shipped string against every held text, by the shared HeldIndex rule. Outside the screen a hit is
    withheld; in an expression, id or key it is a leak (error). On screen (data / stages / roles / flow) a string
    containing or equal to a held text, or sharing a run of >= _QUOTE_MIN characters with one, is a leak; a shorter
    shared fragment is reported (`screen_fragments`). Returns (replaced, leaks, screen_fragments)."""
    index = HeldIndex(held_texts)
    if not index:
        return 0, [], []
    replaced, leaks, screen = 0, [], []

    def check(cont, k, v, path, struct):
        nonlocal replaced
        if _is_withheld(v) or (v and set(v) == {_d.PLACEHOLDER}):
            return
        h = index.hit(v, short=not _IDENT.fullmatch(v.strip()))   # one ASCII token (an id, a code): no short rule
        if h is None:
            return
        if struct:
            leaks.append(_ptr(path))
        elif path[:1] in _SCREEN_TOP:
            if h == "whole" or index.shares(v, _QUOTE_MIN):
                leaks.append(_ptr(path))   # replacing would serve a marker as text
            else:
                screen.append(_ptr(path))
        else:
            cont[k], replaced = _d.WITHHELD + _d.sha256(v)[:16], replaced + 1

    def walk(o, path, struct=False):
        if isinstance(o, dict):
            for k in list(o):
                if isinstance(k, str) and index.hit(k, short=not _IDENT.fullmatch(k.strip())):
                    leaks.append(_ptr(path + [k]) + " (key)")
                v = o[k]
                if isinstance(v, str):   # an id / code / expression / var holding held text: error, never withheld
                    check(o, k, v, path + [k], struct or k in _STRUCT or _computed(path, k, cites))
                else:
                    walk(v, path + [k], False)
        elif isinstance(o, list):
            for i, v in enumerate(o):
                if isinstance(v, str):
                    check(o, i, v, path + [i], struct or _computed(path, i, cites))
                else:
                    walk(v, path + [i], struct)
    for k in list(p):
        if k == "distribution":
            continue
        if isinstance(p[k], str):
            if index.hit(p[k]):
                leaks.append("/" + k)
        else:
            walk(p[k], [k])
    return replaced, leaks, screen


_SCANNED_JSON = ("effects.json", "study.json", "capabilities.json", "sources/source.json", "program.json")


def _bib_position(path, name, source_keys=()):
    """Bibliographic positions whose string values are exempt from the quote-run check (never from the held-text
    check): a top-level title / authors / journal / doi / year …, a string directly under a top-level `paper` or
    `citation` object, and in sources/SOURCE.json a source entry's own bibliographic field."""
    if not path or not isinstance(path[-1], str) or path[-1] not in _BIB:
        return False
    if name == "program.json":
        return False   # all Program bibliography is explicitly source-bound
    if len(path) == 1:
        return True
    if len(path) == 2 and path[0] in ("paper", "citation"):
        return True
    if name == "sources/source.json":   # a declared source's own entry only
        if len(path) == 2 and path[0] in source_keys:
            return True
        if len(path) == 3 and path[0] == "sources" and path[1] in source_keys:
            return True
    return False


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _json_quotes(content, sources_lowered, held_hashes=frozenset(), held_texts=(), name="", source_keys=(), verified_paths=frozenset()):
    """True when no string in a JSON document is held text — whole-string equality (case-folded) with a held text of
    6-15 characters, a shared 16-character fragment with a longer one, or the hash of a held text / part, checked
    for every string and key without exception — and no string outside a bibliographic position shares a
    quote-length run with a non-hosted source."""
    try:
        doc = json.loads(content, object_pairs_hook=_unique_json_object) if isinstance(content, (bytes, str)) else content
    except ValueError:
        return False
    index = HeldIndex(held_texts, held_hashes)
    hits = []

    def held_hit(o):   # HeldIndex.hit unescapes and untags itself
        return index.hit(o, short=not _IDENT.fullmatch(o.strip())) is not None   # one ASCII token: no short rule

    runs = SourceRuns([(str(i), x) for i, x in enumerate(sources_lowered)])

    def quote(o):   # the one run / whole rule (SourceRuns), as for operator text in the projection
        return runs.quoted(o, latin=False) is not None

    def walk(o, path):
        if isinstance(o, dict):
            for k, v in o.items():
                if isinstance(k, str) and (held_hit(k) or (not _TOKEN.fullmatch(k.strip()) and quote(k))):
                    hits.append(k)   # a key: held text or a source quote (keys have no bibliographic exemption)
                walk(v, path + [k])
        elif isinstance(o, list):
            for i, v in enumerate(o):
                walk(v, path + [i])
        elif isinstance(o, str):
            if held_hit(o):
                hits.append(o)
                return
            if tuple(path) in verified_paths or _TOKEN.fullmatch(o.strip()) or _bib_position(path, name, source_keys):
                return
            if quote(o):
                hits.append(o)
    walk(doc, [])
    return not hits


def _recover_held(held, sources, extractors, held_texts):
    """(texts, hashes) of every held item, recovered from the supplied sources as rehydration does (texts without a
    locator from `held_texts`, checked against their hash; pictures by hash only), or None when one cannot be."""
    hashes, texts, scopes_ = set(), [], {}
    for hid_, e in held.items():
        if not isinstance(e, dict):
            continue
        hashes.add(e.get("text_sha256"))
        lc = e.get("locator") if isinstance(e.get("locator"), dict) else {}
        hashes.update(p_.get("canon_sha256") for p_ in lc.get("parts") or [] if isinstance(p_, dict))
        if e.get("kind") == "image":
            continue
        if not lc.get("parts"):
            t = (held_texts or {}).get(hid_)
            if not isinstance(t, str) or _d.text_sha256(t) != e.get("text_sha256"):
                return None
            texts.append(t)
            continue
        src = e.get("source")
        if src not in (sources or {}):
            return None
        if src not in scopes_:
            try:
                scopes_[src] = _d.Scope(_d.units(lc.get("format") or _d.sniff(sources[src]), sources[src], extractors))
            except Exception:   # noqa: BLE001 - no extractor / unreadable file: cannot recover, so refuse
                return None
        t = _d.find(scopes_[src], lc, e.get("text_sha256"))
        if t is None:
            return None
        texts.append(t)
    hashes.discard(None)
    return texts, hashes


def _text_free_of_held(content, texts, hashes):
    return HeldIndex(texts, hashes).text_file(content)


def distributable(name, projection, content=None, sources=None, extractors=None, held_texts=None):
    """is_public(name), and not a file that may carry text of a non-hosted source. While any source is not hosted
    (or anything is held): package/** is refused; declared hosted originals require exact licensed bytes.
    Program and allowed review files require all pinned restricted sources and quote/held-text scans.
    Program cited quotes and summary overlap windows may use exact verified hosted provenance.
    artifacts/** only ship when the projection still references them as an
    image it did not hold. sourcetext/ files and blind readings ship only for a hosted source with nothing held.
    Names are compared normalised (posix normpath) and case-folded, except sourcetext/ names: `sourcetext/<key>.txt`
    or `sourcetext/<key>#…` must name a declared hosted source key exactly. variants/** is refused (a variant needs
    its own projection); effects.json, study.json, capabilities.json and sources/SOURCE.json ship only when their
    `content` is given and shares no quote-length run with any non-hosted source in `sources` ({key: bytes}), and
    is free of held text. Held texts with a locator are recovered from `sources`; held texts without one (image
    readings, regions) must be supplied by the builder in `held_texts` ({held id: text}, checked against their
    text_sha256), or the file is refused. Pictures are checked by hash only. While anything is held, a hosted
    source's sourcetext ships only with `content` (plus every non-hosted source and held_texts) free of held text.
    protocol.json ships only when `content` is the projection itself."""
    import posixpath
    if not is_public(name):
        return False
    n = posixpath.normpath(name)
    if n != name and not is_public(n):
        return False
    low = n.lower()
    srcs = (projection.get("meta") or {}).get("sources") or {}
    tiers = {str(k).lower(): ((v.get("distribution") or {}).get("tier") if isinstance(v, dict) else None) or "user"
             for k, v in (srcs.items() if isinstance(srcs, dict) else [])}
    held = (projection.get("distribution") or {}).get("held") or {}
    held = held if isinstance(held, dict) else {}
    all_hosted = all(t == "hosted" for t in tiers.values()) and not held
    cited = {str(h.get("source")).lower() for h in held.values() if isinstance(h, dict)}
    if low.startswith("sourcetext/"):
        base = n[len("sourcetext/"):]
        key = base.split("#", 1)[0] if "#" in base else (base[:-4] if base.endswith(".txt") else None)
        exact = {str(k): (v.get("distribution") or {}).get("tier") if isinstance(v, dict) else None
                 for k, v in (srcs.items() if isinstance(srcs, dict) else [])}
        held_src = {str(h.get("source")) for h in held.values() if isinstance(h, dict)}
        if key is None or exact.get(key) != "hosted" or key in held_src:
            return False
        if not held:
            return True
        # something is held (for another source): a hosted paper may reprint it. Ship only checked content.
        if content is None or any(str(k) not in (sources or {}) for k, t in exact.items() if t != "hosted"):
            return False
        rec = _recover_held(held, sources, extractors, held_texts)
        return rec is not None and _text_free_of_held(content, *rec)
    if low == "protocol.json":   # the protocol ships only as this projection
        if content is None:
            return False
        try:
            doc = json.loads(content, object_pairs_hook=_unique_json_object) if isinstance(content, (bytes, str)) else content
        except ValueError:
            return False
        return doc == projection and (projection.get("distribution") or {}).get("strict") is True
    if low.startswith("variants/"):
        return all_hosted
    if low.startswith("sources/open/") and not all_hosted:
        if held or not isinstance(content, bytes) or (projection.get("distribution") or {}).get("strict") is not True:
            return False
        for record in srcs.values():
            if not isinstance(record, dict) or record.get("file") != n:
                continue
            d = record.get("distribution") or {}
            sha = d.get("sha256") or record.get("sha256")
            if d.get("tier") == "hosted" and hosted_licence_ok(d.get("licence")) and d.get("attribution") and sha == _d.sha256(content):
                return True
        return False
    review_text = low.startswith("review/") and low.endswith((".md", ".txt", ".json"))
    if (low in _SCANNED_JSON or review_text) and not all_hosted:
        if content is None or not sources:
            return False
        declared = [str(k) for k, t in ((k, (v.get("distribution") or {}).get("tier") if isinstance(v, dict) else None)
                                        for k, v in (srcs.items() if isinstance(srcs, dict) else []))
                    if t != "hosted"]
        if any(k not in sources for k in declared):
            return False   # every non-hosted source must be scanned against
        if low == "program.json" or review_text:
            if (projection.get("distribution") or {}).get("strict") is not True:
                return False
            for k in declared:
                record = srcs.get(k) or {}
                sha = (record.get("distribution") or {}).get("sha256") or record.get("sha256")
                if sha != _d.sha256(sources[k]):
                    return False
        low_src = []
        for k, b in sources.items():
            d = (srcs.get(k) or {}).get("distribution") if isinstance(srcs.get(k), dict) else None
            if isinstance(d, dict) and d.get("tier") == "hosted":
                continue
            try:
                fmt = (d or {}).get("format") or _d.sniff(b)
                sc = _d.Scope(_d.units(fmt, b, extractors))
            except Exception:   # noqa: BLE001 - no extractor / unreadable file: cannot scan, so refuse
                return False
            low_src += [sc.full(w)[0] for w in ("plain", "dehyph")]
        rec = _recover_held(held, sources, extractors, held_texts)
        if rec is None:
            return False
        texts, hashes = rec
        if review_text and not low.endswith(".json"):
            if isinstance(content, bytes):
                try:
                    content = content.decode("utf-8")
                except UnicodeDecodeError:
                    return False
            if not isinstance(content, str):
                return False
            content = {"review": content}
        verified = set()
        if low == "program.json":
            try:
                doc = json.loads(content, object_pairs_hook=_unique_json_object) if isinstance(content, (str, bytes)) else content
                evidence = doc.get("evidence") or []
                by_id = {e.get("id"): e for e in evidence if isinstance(e, dict)}
                cache = {}
                def licensed(text, e):
                    key = e.get("sourceId")
                    record = srcs.get(key) or {}
                    d = record.get("distribution") or {}
                    raw = sources.get(key)
                    if not isinstance(text, str) or raw is None or d.get("tier") != "hosted" or not hosted_licence_ok(d.get("licence")) or not d.get("attribution"):
                        return False
                    if (d.get("sha256") or record.get("sha256")) != _d.sha256(raw) or e.get("path") != record.get("file"):
                        return False
                    if key not in cache:
                        fmt = d.get("format") or _d.sniff(raw)
                        cache[key] = (fmt, _d.Scope(_d.units(fmt, raw, extractors)))
                    fmt, scope = cache[key]
                    return _d.make_locator(text, fmt, scope.units, extractors, scope=scope) is not None
                # Program bibliographic strings are not implicitly trusted; bind
                # them to the declared licensed source and actual source bytes.
                primary = doc.get("source")
                if isinstance(primary, dict):
                    for key, record in srcs.items():
                        if isinstance(record, dict) and primary.get("filename") == record.get("file"):
                            e = {"sourceId": key, "path": record.get("file")}
                            for field, text in primary.items():
                                if field in _BIB and licensed(text, e):
                                    verified.add(("source", field))
                            if licensed(doc.get("title"), e):
                                verified.add(("title",))
                for i, e in enumerate(evidence):
                    if isinstance(e, dict) and licensed(e.get("quote"), e):
                        verified.add(("evidence", i, "quote"))
                restricted = SourceRuns([(str(i), x) for i, x in enumerate(low_src)])
                def covered(text, ids):
                    # Summaries can contain shared phrases: every restricted window,
                    # not merely the first hit, must also occur in verified cited sources.
                    allowed = []
                    for eid in ids:
                        e = by_id.get(eid) if isinstance(eid, str) else None
                        if e and licensed(e.get("quote"), e):
                            scope = cache[e["sourceId"]][1]
                            allowed.extend(_skel_stream(scope.full(w)[0]) for w in ("plain", "dehyph"))
                    if not allowed:
                        return False
                    allowed_wide = {w for source in allowed for w in _cjk_windows(source)}
                    for form in _forms(text):
                        sk = _skel(form)
                        for window in _cjk_windows(sk):
                            if window in restricted.wide and window not in allowed_wide:
                                return False
                        windows = {sk[i:i + _QUOTE_MIN] for i in range(max(0, len(sk) - _QUOTE_MIN + 1))}
                        if any(_wide(ch) for ch in sk) and len(sk) >= 6:
                            windows.add(sk)
                        for window in windows:
                            if _lettered(window) and any(window in source for _, source in restricted.skels) and not any(window in source for source in allowed):
                                return False
                    return True
                def fields(o, path):
                    if isinstance(o, dict):
                        ids = o.get("evidenceIds") or []
                        if isinstance(ids, list) and isinstance(o.get("value"), str) and covered(o["value"], ids):
                            verified.add(tuple(path + ["value"]))
                        for k, v in o.items(): fields(v, path + [k])
                    elif isinstance(o, list):
                        for i, v in enumerate(o): fields(v, path + [i])
                fields(doc, [])
            except (ValueError, TypeError, AttributeError, KeyError):
                return False
        return _json_quotes(content, low_src, hashes, texts, low, set(srcs) if isinstance(srcs, dict) else set(), verified)
    if low.startswith(("review/", "package/", "sources/open/")) or low == "program.json":
        return all_hosted

    def norm(src):
        return posixpath.normpath(src).lower().lstrip("/") if isinstance(src, str) else None
    held_imgs, shipped_imgs = set(), set()
    for h in held.values():
        if isinstance(h, dict) and h.get("kind") == "image":
            try:
                held_imgs.add(norm(_d._get(projection, h["path"]).get("src")))
            except (KeyError, IndexError, ValueError, AttributeError, TypeError):
                pass

    def walk(o):
        if isinstance(o, dict):
            if isinstance(o.get("src"), str):
                shipped_imgs.add(norm(o["src"]))
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk({k: v for k, v in projection.items() if k in ("data", "stages", "roles", "flow")})   # image objects only
    shipped_imgs -= held_imgs

    def names(srcs_):
        return any(x and (low == x or low.endswith("/" + x) or x.endswith("/" + low)) for x in srcs_)
    if names(held_imgs):
        return False
    if low.startswith("artifacts/") and not all_hosted:
        return names(shipped_imgs)
    return True
