"""A small, safe expression language for protocol rules (DESIGN.md §3.4).

Python syntax, restricted: literals, names, subscripts, attribute-free calls to whitelisted functions,
arithmetic, comparisons, boolean logic, conditional expressions, list/tuple/dict displays and
comprehensions. No attributes, no lambdas, no imports, no dunder names.
"""
import ast
import math
import re

ALLOWED = (
    ast.Expression, ast.Constant, ast.Name, ast.Load, ast.Store, ast.Subscript, ast.Slice,
    ast.Call, ast.keyword, ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.IfExp,
    ast.List, ast.Tuple, ast.Dict, ast.Set, ast.ListComp, ast.GeneratorExp, ast.comprehension,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow, ast.USub, ast.UAdd, ast.Not,
    ast.And, ast.Or, ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.In, ast.NotIn, ast.Is, ast.IsNot,
)
if hasattr(ast, "Index"):
    ALLOWED = ALLOWED + (ast.Index,)


class ExprError(ValueError):
    pass


def _num(x):   # numbers and booleans (True = 1); never strings such as "NA"
    return isinstance(x, (int, float))


def _mean(xs):   # skips missing and non-numeric answers ("NA" from a Not Applicable box)
    xs = [x for x in xs if _num(x)]
    return sum(xs) / len(xs) if xs else None


_WORDS = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen "
                                       "fourteen fifteen sixteen seventeen eighteen nineteen twenty".split())}
_TENS = {"thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90, "hundred": 100}


def number(text, cents_to_dollars=False):
    """The first number in a free-text answer: '5', '$0.05', '5 cents', 'five', '-3', '–3', '1,000'. None if absent.
    Part of declared coding rules (DESIGN §3.4); never used to read choices."""
    if text is None:
        return None
    if isinstance(text, (int, float)):
        return text
    t = str(text).lower().replace("\u2212", "-").replace("\u2013", "-").replace("\u2014", "-")
    m = re.search(r"(-?\$?\s*\d[\d,]*(?:\.\d+)?|-?\$?\.\d+)\s*(cents?|¢)?", t)
    if m:
        v = float(m.group(1).replace("$", "").replace(",", "").replace(" ", ""))
        if m.group(2) and cents_to_dollars:
            v = v / 100
        return v
    for w in re.findall(r"[a-z]+", t):
        if w in _WORDS:
            return float(_WORDS[w])
        if w in _TENS:
            return float(_TENS[w])
    return None


BASE_FUNCS = {
    "number": number,
    "replace": lambda text, old, new: str(text).replace(old, new),
    "sub": lambda pattern, repl, text: re.sub(pattern, repl, text or "", flags=re.I) if len(pattern) < 500 else text,
    "normalize": lambda text: re.sub(r"\s+", " ", re.sub(r"[*_`~]+", " ", str(text or ""))).strip(),
    "join": lambda sep, xs: str(sep).join(str(x) for x in xs),
    "money": lambda x, places=2: ("%%.%df" % int(places)) % float(x),
    "search": lambda pattern, text: bool(re.search(pattern, text or "", re.I)),
    "len": len, "sum": lambda xs: sum(x for x in xs if _num(x)),
    "numeric": lambda xs: [x for x in xs if _num(x)], "min": min, "max": max, "abs": abs,
    "round": round, "mean": _mean, "any": any, "all": all, "sorted": sorted, "list": list, "range": range,
    "int": int, "enumerate": enumerate, "zip": zip, "float": float, "str": str, "bool": bool,
    "count": lambda xs, v=True: sum(1 for x in xs if x == v),
    "clip": lambda x, lo, hi: max(lo, min(hi, x)),
    "exp": math.exp, "log": math.log, "sqrt": math.sqrt, "atan": math.atan, "atan2": math.atan2, "degrees": math.degrees,
    "lower": lambda s: s.lower() if isinstance(s, str) else s,
}

_cache = {}


def compile_expr(src):
    if src in _cache:
        return _cache[src]
    try:
        tree = ast.parse(src, mode="eval")
    except SyntaxError as e:
        raise ExprError("syntax error in %r: %s" % (src, e.msg))
    for node in ast.walk(tree):
        if not isinstance(node, ALLOWED):
            raise ExprError("%s not allowed in %r" % (type(node).__name__, src))
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise ExprError("name %r not allowed" % node.id)
        if isinstance(node, ast.Call) and not isinstance(node.func, ast.Name):
            raise ExprError("only plain function calls allowed in %r" % src)
    code = compile(tree, "<expr>", "eval")
    _cache[src] = code
    return code


def names_in(src):
    return {n.id for n in ast.walk(ast.parse(src, mode="eval")) if isinstance(n, ast.Name)}


def evaluate(src, names, funcs=None):
    code = compile_expr(src)
    env = dict(BASE_FUNCS)
    if funcs:
        env.update(funcs)
    env.update(names)
    env["__builtins__"] = {}
    try:
        return eval(code, env)
    except ExprError:
        raise
    except Exception as e:  # report which rule failed, never crash the session silently
        raise ExprError("error evaluating %r: %s: %s" % (src, type(e).__name__, e))
