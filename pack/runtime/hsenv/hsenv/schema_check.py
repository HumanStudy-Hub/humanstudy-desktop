"""Validate a protocol.json, study.json or run.json against the frozen v1 schemas (stdlib only).

    python -m hsenv.schema_check studies/<id>/protocol.json
    python -m hsenv.schema_check studies/*/protocol.json --kind protocol --json
    python -m hsenv.schema_check study.json --verify-sha      # also recompute protocol.sha256 next to it

Exit status: 0 = valid (warnings allowed), 1 = errors, 2 = usage / unreadable file.

The schemas are JSON Schema draft 2020-12. This module carries its own validator for the subset they
use ($ref to local $defs, type, enum, const, pattern, minimum/maximum, minLength, minItems/maxItems,
items, prefixItems, properties, patternProperties, additionalProperties, required, minProperties, anyOf,
oneOf, allOf, not), so the runtime needs nothing outside the standard library; any other
draft-2020-12 validator gives the same verdict on errors (tests cross-check with jsonschema). Two annotation keywords, ignored by other validators, produce warnings:

    x-report-unknown: true    on a permissive object: keys not named in properties/patternProperties
                              are accepted but listed (undocumented fields for the maintainers)
    x-legacy-values: [...]    on an enum: values accepted for legacy protocols but not part of the
                              documented vocabulary (DESIGN.md); each use is a warning

Protocols then get a cross-reference pass (cross_check) for what JSON Schema cannot say: every literal
on-screen text has a cite, and every `where.arm` under `analysis` names an arm of the protocol. Its findings
are errors.

schema_version: a file that declares "schema_version": "1" is v1. A file without it is legacy
(accepted, one warning); any other value is an error.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

SCHEMA_VERSION = "1"
KINDS = ("protocol", "study", "run")
_TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
    "integer": lambda v: (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer()),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
}


# ------------------------------------------------------------------------------------------ schemas
def schema_dir():
    """The source tree's hsenv/schema/ when running from a checkout, else the installed package data
    (hsenv.schema, a namespace package inside the wheel). Returns a Path or importlib Traversable."""
    src = Path(__file__).resolve().parent.parent / "schema"
    if (src / "protocol.v1.json").is_file():
        return src
    from importlib.resources import files
    return files("hsenv.schema")


_CACHE = {}


def load_schema(kind):
    if kind not in KINDS:
        raise ValueError("unknown kind %r (one of %s)" % (kind, ", ".join(KINDS)))
    if kind not in _CACHE:
        _CACHE[kind] = json.loads(schema_dir().joinpath("%s.v1.json" % kind).read_text(encoding="utf-8"))
    return _CACHE[kind]


# ---------------------------------------------------------------------------------------- validator
class _V:
    def __init__(self, root):
        self.root = root
        self.errors, self.warnings = [], []
        self._re = {}

    def rx(self, p):
        if p not in self._re:
            self._re[p] = re.compile(p)
        return self._re[p]

    def ref(self, r):
        if not r.startswith("#/"):
            raise ValueError("only local $ref supported: %r" % r)
        node = self.root
        for part in r[2:].split("/"):
            node = node[part.replace("~1", "/").replace("~0", "~")]
        return node

    def check(self, v, s, path, errs, warns):
        """Append (path, message) to errs/warns. Returns nothing."""
        if s is True or s is None:
            return
        if s is False:
            errs.append((path, "not allowed here"))
            return
        if "$ref" in s:
            self.check(v, self.ref(s["$ref"]), path, errs, warns)
        t = s.get("type")
        if t is not None:
            ts = t if isinstance(t, list) else [t]
            if not any(_TYPES[x](v) for x in ts):
                errs.append((path, "expected %s, got %s" % ("|".join(ts), _tname(v))))
                return
        if "const" in s and v != s["const"]:
            errs.append((path, "must be %s" % json.dumps(s["const"])))
        if "enum" in s:
            if v not in s["enum"]:
                errs.append((path, "%s not one of %s" % (json.dumps(v)[:80], ", ".join(map(json.dumps, s["enum"])))))
            elif v in s.get("x-legacy-values", ()):
                warns.append((path, "legacy value %s (not in the documented vocabulary)" % json.dumps(v)))
        if isinstance(v, str):
            if "pattern" in s and not self.rx(s["pattern"]).search(v):
                errs.append((path, "%s does not match %s" % (json.dumps(v)[:80], s["pattern"])))
            if len(v) < s.get("minLength", 0):
                errs.append((path, "shorter than %d" % s["minLength"]))
        if _TYPES["number"](v):
            if "minimum" in s and v < s["minimum"]:
                errs.append((path, "%s < minimum %s" % (v, s["minimum"])))
            if "maximum" in s and v > s["maximum"]:
                errs.append((path, "%s > maximum %s" % (v, s["maximum"])))
        if isinstance(v, list):
            if len(v) < s.get("minItems", 0):
                errs.append((path, "fewer than %d items" % s["minItems"]))
            if "maxItems" in s and len(v) > s["maxItems"]:
                errs.append((path, "more than %d items" % s["maxItems"]))
            pre = s.get("prefixItems", [])
            for i, x in enumerate(v):
                sub = pre[i] if i < len(pre) else s.get("items")
                if sub is not None:
                    self.check(x, sub, "%s[%d]" % (path, i), errs, warns)
        if isinstance(v, dict):
            if len(v) < s.get("minProperties", 0):
                errs.append((path, "fewer than %d fields" % s["minProperties"]))
            for k in s.get("required", ()):
                if k not in v:
                    errs.append((path, "missing required field %r" % k))
            props, pats = s.get("properties", {}), s.get("patternProperties", {})
            unknown = []
            for k, x in v.items():
                sub_path = "%s.%s" % (path, k) if path else k
                hit = False
                if k in props:
                    hit = True
                    self.check(x, props[k], sub_path, errs, warns)
                for p, ps in pats.items():
                    if self.rx(p).search(k):
                        hit = True
                        self.check(x, ps, sub_path, errs, warns)
                if not hit:
                    ap = s.get("additionalProperties", True)
                    if ap is False:
                        errs.append((sub_path, "unknown field"))
                    else:
                        if ap is not True:
                            self.check(x, ap, sub_path, errs, warns)
                        if s.get("x-report-unknown"):
                            unknown.append(k)
            if unknown:
                warns.append((path or "(top)", "undocumented field(s): %s" % ", ".join(sorted(unknown))))
        for sub in s.get("allOf", ()):
            self.check(v, sub, path, errs, warns)
        if "anyOf" in s or "oneOf" in s:
            branches = s.get("anyOf") or s.get("oneOf")
            results = []
            for sub in branches:
                e, w = [], []
                self.check(v, sub, path, e, w)
                results.append((e, w))
            ok = [r for r in results if not r[0]]
            if "oneOf" in s and len(ok) > 1:
                errs.append((path, "matches %d branches of oneOf" % len(ok)))
            if ok:
                warns.extend(ok[0][1])
            else:   # report the closest branch (fewest errors, then deepest), not a bare "no match"
                best = min(results, key=lambda r: (len(r[0]), -max(len(p) for p, _ in r[0])))
                hint = s.get("x-name")
                if hint:
                    errs.append((path, "not a valid %s" % hint))
                errs.extend(best[0])
        if "not" in s:
            e = []
            self.check(v, s["not"], path, e, [])
            if not e:
                errs.append((path, "matches a forbidden form"))


def _tname(v):
    for n in ("null", "boolean", "integer", "number", "string", "array", "object"):
        if _TYPES[n](v):
            return n
    return type(v).__name__


# ------------------------------------------------------------------------------------------ helpers
def canonical_sha256(data):
    """sha256 of the canonical JSON (sort_keys, default separators). Its first 16 hex characters are
    hsenv.engine.Protocol.version, so a run's protocol.sha256 and the engine's version agree."""
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def protocol_sha256(path):
    return canonical_sha256(json.loads(Path(path).read_text(encoding="utf-8")))


def detect_kind(path, data):
    name = Path(path).name
    for k in KINDS:
        if name == "%s.json" % k or name.endswith(".%s.json" % k):
            return k
    if isinstance(data, dict):
        if "stages" in data and "flow" in data:
            return "protocol"
        if "model" in data and "seeds" in data:
            return "run"
        if "quality" in data:
            return "study"
    return None


_CITE_KEY = re.compile(r"(^|_)cites?$")


def _has_cite(o):
    return isinstance(o, dict) and any(_CITE_KEY.search(k) for k in o)


def _literal_text(v):
    """Non-empty text written into the protocol (not computed by an expr): a string, a {text} dict, or a list of
    those (lines)."""
    if isinstance(v, str):
        return bool(v.strip())
    if isinstance(v, dict) and "expr" not in v:
        return isinstance(v.get("text"), str) and bool(v["text"].strip())
    if isinstance(v, list):
        return any(_literal_text(x) for x in v)
    return False


def _cited(v, *holders):
    """True when literal text v carries a cite: on any holder (item, response, option) or on the text itself
    (every line of a list)."""
    if any(_has_cite(h) for h in holders) or _has_cite(v):
        return True
    if isinstance(v, list):
        return all(_has_cite(x) or not _literal_text(x) for x in v)
    return False


_MISSING_EXPR = re.compile(r"""data\s*\[\s*['"]missing['"]\s*\]""")
_UNKNOWN = object()


def _arm_cond(src, arm):
    """Evaluate a flow/item condition that depends on `arm` alone (arm == 'x', arm in (...), not/and/or of those).
    -> True/False, or _UNKNOWN when it reads anything else (then both branches count as reachable)."""
    import ast
    try:
        node = ast.parse(src, mode="eval").body
    except (SyntaxError, ValueError, RecursionError):
        return _UNKNOWN

    def ev(n):
        if isinstance(n, ast.BoolOp):
            vals = [ev(x) for x in n.values]
            if isinstance(n.op, ast.And):
                return False if False in vals else (_UNKNOWN if _UNKNOWN in vals else True)
            return True if True in vals else (_UNKNOWN if _UNKNOWN in vals else False)
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.Not):
            v = ev(n.operand)
            return v if v is _UNKNOWN else not v
        if isinstance(n, ast.Constant) and isinstance(n.value, bool):
            return n.value
        if isinstance(n, ast.Compare) and len(n.ops) == 1 and isinstance(n.left, ast.Name) and n.left.id == "arm":
            try:
                right = ast.literal_eval(n.comparators[0])
            except (ValueError, SyntaxError, TypeError):
                return _UNKNOWN
            op = n.ops[0]
            if isinstance(op, ast.Eq):
                return arm == right
            if isinstance(op, ast.NotEq):
                return arm != right
            if isinstance(op, (ast.In, ast.NotIn)) and isinstance(right, (list, tuple, set)):
                return (arm in right) == isinstance(op, ast.In)
        return _UNKNOWN
    return ev(node)


def _reached_stages(flow, arm):
    """Stages an arm can reach: conditions that depend on the arm alone are followed exactly, any other condition
    keeps both branches."""
    out = set()

    def walk(n):
        if isinstance(n, list):
            for x in n:
                walk(x)
            return
        if not isinstance(n, dict):
            return
        cond = _arm_cond(n["if"], arm) if isinstance(n.get("if"), str) else True
        if "then" in n or "else" in n:
            if cond is not False:
                walk(n.get("then"))
            if cond is not True:
                walk(n.get("else"))
            return
        if cond is False:
            return
        if isinstance(n.get("stage"), str):
            out.add(n["stage"])
        pg = n.get("page")
        if isinstance(pg, str):
            out.add(pg)
        elif isinstance(pg, list):
            out.update(x for x in pg if isinstance(x, str))
        for k in ("seq", "shuffle", "do", "repeat"):
            if isinstance(n.get(k), (list, dict)):
                walk(n[k])
    walk(flow)
    return out


def _gaps(o, arm, path):
    """On-screen places in a stage that show a missing gap to this arm: a {text: null, cite: missing} value, an
    element whose own cite is labelled missing, or an expr reading data['missing'] (cites are not on screen)."""
    found = []
    if isinstance(o, dict):
        if isinstance(o.get("if"), str) and _arm_cond(o["if"], arm) is False:
            return found   # an item this arm never sees
        c = o.get("cite")
        if isinstance(c, dict) and c.get("label") == "missing" and "kind" not in o and ("value" in o or "text" in o):
            found.append((path, "labelled missing"))   # a shown item/text; a response's own cite is about its setup
        elif "text" in o and o["text"] is None:
            found.append((path, "null text"))
        if isinstance(o.get("expr"), str) and _MISSING_EXPR.search(o["expr"]):
            found.append((path, "reads data['missing']"))
        for k, v in o.items():
            if not _CITE_KEY.search(k) and not re.search(r"(^|_)note(s)?$|_note_|^note_", k):
                found += _gaps(v, arm, "%s.%s" % (path, k))
    elif isinstance(o, list):
        for i, v in enumerate(o):
            found += _gaps(v, arm, "%s[%d]" % (path, i))
    return found


def rule2_gaps(data):
    """DESIGN §2 rule 2, statically: a runnable arm must never reach a screen that shows a missing gap.
    -> [(path, msg)] (one per stage element, naming the first arm that reaches it)."""
    errs, seen = [], set()
    if not isinstance(data, dict) or not isinstance(data.get("stages"), dict) or not isinstance(data.get("arms"), list):
        return errs
    for a in data["arms"]:
        if not isinstance(a, dict) or a.get("runnable") is False:
            continue
        for sn in sorted(_reached_stages(data.get("flow"), a.get("id"))):
            st = data["stages"].get(sn)
            if not isinstance(st, dict):
                continue
            for key in ("content", "responses"):
                for path, why in _gaps(st.get(key), a.get("id"), "stages.%s.%s" % (sn, key)):
                    if path not in seen:
                        seen.add(path)
                        errs.append((path, "runnable arm %r reaches a missing gap (%s): DESIGN §2 rule 2 — mark the "
                                           "arm runnable: false or supply the text" % (a.get("id"), why)))
    return errs


def cross_check(data, validator=None, warns=None):
    """Protocol checks that JSON Schema cannot express. -> [(path, msg)] errors.

    - every literal on-screen text (stage content value/text, response prompt/instruction, option label) has a
      cite (DESIGN §2 rule 2): on the item, response or option, or on the text dict itself;
    - every arm named in a `where.arm` anywhere under `analysis` is an arm of the protocol;
    - no duplicate response id within a stage, no reversed numeric range (a duplicate option code within a
      response is a warning: a study may score two options the same, e.g. False and Don't know both 0); every analysis target/effect `unit` is a key of `units`;
    - DESIGN §2 rule 2 (rule2_gaps): no runnable arm reaches an on-screen missing gap;
    - with a validator: every cite nested inside meta (below its top-level keys, which the schema checks) is a
      valid cite."""
    errs = []
    if not isinstance(data, dict):
        return errs
    stages = data.get("stages") if isinstance(data.get("stages"), dict) else {}
    for sn, st in stages.items():
        if not isinstance(st, dict):
            continue
        for i, it in enumerate(st.get("content") or [] if isinstance(st.get("content"), list) else []):
            if not isinstance(it, dict):
                continue
            v = it.get("value", it.get("text"))
            if _literal_text(v) and not _cited(v, it):
                errs.append(("stages.%s.content[%d]" % (sn, i), "on-screen text without a cite (id %r)" % it.get("id")))
        for i, r in enumerate(st.get("responses") or [] if isinstance(st.get("responses"), list) else []):
            if not isinstance(r, dict):
                continue
            base = "stages.%s.responses[%d]" % (sn, i)
            for k in ("prompt", "instruction"):
                if _literal_text(r.get(k)) and not _cited(r[k], r):
                    errs.append((base + "." + k, "on-screen text without a cite (response %r)" % r.get("id")))
            for j, o in enumerate(r.get("options") if isinstance(r.get("options"), list) else []):
                if isinstance(o, dict) and _literal_text(o.get("label")) and not _cited(o["label"], o, r):
                    errs.append(("%s.options[%d].label" % (base, j), "on-screen text without a cite"))
        ids = [r.get("id") for r in st.get("responses") if isinstance(r, dict)] \
            if isinstance(st.get("responses"), list) else []
        for rid in sorted({x for x in ids if isinstance(x, str) and ids.count(x) > 1}):
            errs.append(("stages.%s.responses" % sn, "duplicate response id %r" % rid))
        for i, r in enumerate(st.get("responses") or [] if isinstance(st.get("responses"), list) else []):
            if not isinstance(r, dict):
                continue
            base = "stages.%s.responses[%d]" % (sn, i)
            if isinstance(r.get("options"), list):
                codes = [json.dumps(o.get("code")) for o in r["options"] if isinstance(o, dict) and "code" in o]
                for c in sorted({c for c in codes if codes.count(c) > 1}):
                    (warns if warns is not None else errs).append(
                        (base + ".options", "duplicate option code %s: the record cannot tell these options apart "
                                            "(fine if the paper scores them the same)" % c))
            rg = r.get("range")
            if isinstance(rg, list) and len(rg) == 2 and all(_TYPES["number"](x) for x in rg) and rg[0] > rg[1]:
                errs.append((base + ".range", "reversed range %s (low first)" % json.dumps(rg)))
    arms = {a.get("id") for a in data.get("arms") or [] if isinstance(a, dict)} if isinstance(data.get("arms"), list) else set()
    units = set(data["units"]) if isinstance(data.get("units"), dict) else set()
    an = data.get("analysis") if isinstance(data.get("analysis"), dict) else {}
    for k in ("targets", "effects"):
        for i, x in enumerate(an.get(k) if isinstance(an.get(k), list) else []):
            if isinstance(x, dict) and isinstance(x.get("unit"), str) and x["unit"] not in units:
                errs.append(("analysis.%s[%d].unit" % (k, i), "unknown unit %r (not in units)" % x["unit"]))
    if validator is not None and isinstance(data.get("meta"), dict):   # cites nested anywhere inside meta
        def cites(o, path, depth):
            if isinstance(o, dict):
                for k, x in o.items():
                    p = "%s.%s" % (path, k)
                    if depth > 0 and _CITE_KEY.search(k):
                        e = []
                        validator.check(x, {"$ref": "#/$defs/citeField"}, p, e, [])
                        errs.extend(e)
                    else:
                        cites(x, p, depth + 1)
            elif isinstance(o, list):
                for i, x in enumerate(o):
                    cites(x, "%s[%d]" % (path, i), depth + 1)
        cites(data["meta"], "meta", 0)

    def walk(o, path):
        if isinstance(o, dict):
            for k, x in o.items():
                p = "%s.%s" % (path, k)
                if k == "where" and isinstance(x, dict) and "arm" in x:
                    for a in x["arm"] if isinstance(x["arm"], list) else [x["arm"]]:
                        if a not in arms:
                            errs.append((p + ".arm", "unknown arm %s" % json.dumps(a)[:80]))
                walk(x, p)
        elif isinstance(o, list):
            for i, x in enumerate(o):
                walk(x, "%s[%d]" % (path, i))
    walk(data.get("analysis"), "analysis")
    errs.extend(rule2_gaps(data))
    return errs


def validate(data, kind):
    """-> {"kind", "valid", "legacy", "errors": [(path, msg)], "warnings": [(path, msg)]}

    Protocols also get the cross-reference pass (cross_check) after the schema."""
    v = _V(load_schema(kind))
    errs, warns = [], []
    legacy = isinstance(data, dict) and "schema_version" not in data
    if legacy:
        warns.append(("schema_version", "absent: legacy file (pre-v1); validated against v1, add "
                                        '"schema_version": "1" once it passes'))
    v.check(data, v.root, "", errs, warns)
    if kind == "protocol":
        errs.extend(cross_check(data, v, warns))
    return {"kind": kind, "valid": not errs, "legacy": legacy, "errors": errs, "warnings": warns}


def validate_file(path, kind=None, verify_sha=False):
    path = Path(path)
    data = json.loads(path.read_text(encoding="utf-8"))
    kind = kind or detect_kind(path, data)
    if kind is None:
        raise ValueError("%s: cannot tell protocol/study/run; pass --kind" % path)
    r = validate(data, kind)
    r["file"] = str(path)
    if kind == "protocol":
        r["sha256"] = canonical_sha256(data)
    if verify_sha and kind == "study" and isinstance(data.get("protocol"), dict):
        rel = data["protocol"].get("path") or "protocol.json"
        pf = path.parent / rel
        if pf.is_file():
            got = protocol_sha256(pf)
            if got != data["protocol"].get("sha256"):
                r["errors"].append(("protocol.sha256", "does not match %s (%s)" % (rel, got)))
                r["valid"] = False
        else:
            r["warnings"].append(("protocol.path", "%s not found; sha256 not verified" % rel))
    return r


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m hsenv.schema_check", description=__doc__.split("\n")[0])
    ap.add_argument("files", nargs="+")
    ap.add_argument("--kind", choices=KINDS)
    ap.add_argument("--json", action="store_true", help="one JSON report per file")
    ap.add_argument("--quiet", "-q", action="store_true", help="errors only, no warnings")
    ap.add_argument("--verify-sha", action="store_true", help="study.json: recompute the protocol sha256")
    a = ap.parse_args(argv)
    status, out = 0, []
    for f in a.files:
        try:
            r = validate_file(f, a.kind, a.verify_sha)
        except (OSError, ValueError) as e:   # json.JSONDecodeError is a ValueError
            print("%s: %s" % (f, e), file=sys.stderr)
            status = max(status, 2)
            continue
        if not r["valid"]:
            status = max(status, 1)
        if a.json:
            out.append(r)
            continue
        print("%s: %s %s%s (%d errors, %d warnings)" % (
            f, r["kind"], "VALID" if r["valid"] else "INVALID", " [legacy]" if r["legacy"] else "",
            len(r["errors"]), len(r["warnings"])))
        for p, m in r["errors"]:
            print("  ERROR   %s: %s" % (p or "(top)", m))
        if not a.quiet:
            for p, m in r["warnings"]:
                print("  warning %s: %s" % (p or "(top)", m))
    if a.json:
        print(json.dumps(out if len(out) != 1 else out[0], indent=1, ensure_ascii=False))
    return status


if __name__ == "__main__":
    sys.exit(main())
