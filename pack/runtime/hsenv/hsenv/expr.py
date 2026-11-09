"""A small, safe expression language for protocol rules (DESIGN.md §3.4).

Python syntax, restricted: literals, names, subscripts, attribute-free calls to whitelisted functions,
arithmetic, comparisons, boolean logic, conditional expressions, list/tuple/dict displays and
comprehensions. No attributes, no lambdas, no imports, no dunder names.

Resource limits (protocol-route review 1, S1): an expression can never allocate or loop without bound. Integers are
capped at MAX_INT_BITS, strings/lists/tuples at MAX_SIZE elements (nested containers counted in full), comprehension
iterations per evaluation at MAX_ITER, range() at MAX_SIZE, %-format widths at MAX_FORMAT_WIDTH, source text at
MAX_SOURCE characters and syntax nesting at MAX_DEPTH. `+ * ** %` run through checked helpers that refuse a result
over a limit before building it. Every violation is an ExprError naming the limit.
"""
import ast
import math
import re
import threading

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


MAX_INT_BITS = 4096          # about 1233 decimal digits
MAX_SIZE = 1_000_000         # elements of a str / list / tuple / dict / set, nested containers counted in full
MAX_ITER = 2_000_000         # comprehension iterations per evaluate() call
MAX_ALLOC = 20_000_000       # elements built by sequence operations / str() / list() per evaluate() call
MAX_FORMAT_WIDTH = 1000      # %-format field width / precision
MAX_SOURCE = 200_000         # characters of one expression
MAX_DEPTH = 200              # syntax-tree nesting


def _limit(msg):
    raise ExprError("expression limit: %s" % msg)


_budget = threading.local()   # per evaluate() call (and per thread): [iterations left, elements left]


def _charge(n, what="elements"):
    b = getattr(_budget, "b", None)
    if b is None:     # called outside evaluate() (e.g. checks calling number()): per-operation caps only
        return
    b[1] -= n
    if b[1] < 0:
        _limit("over %d %s built in one evaluation" % (MAX_ALLOC, what))


def _size(x, budget=MAX_SIZE):
    """Elements of x counted through nested containers; stops counting once over budget (cheap on aliased lists)."""
    if isinstance(x, (str, bytes)):
        return len(x)
    if isinstance(x, (list, tuple, set, frozenset, dict)):
        n = len(x)
        if n > budget:
            return n
        for v in (x.values() if isinstance(x, dict) else x):
            if isinstance(v, (str, bytes, list, tuple, set, frozenset, dict)):
                n += _size(v, budget - n)
                if n > budget:
                    return n
        return n
    return 1


def _check_int(v):
    if isinstance(v, int) and not isinstance(v, bool) and v.bit_length() > MAX_INT_BITS:
        _limit("integer over %d bits" % MAX_INT_BITS)
    return v


def _hs_add(a, b):
    if isinstance(a, (str, list, tuple)) and isinstance(b, (str, list, tuple)):
        n = _size(a) + _size(b)
        if n > MAX_SIZE:
            _limit("sequence over %d elements" % MAX_SIZE)
        _charge(n)
    return _check_int(a + b)


def _hs_sub(a, b):
    return _check_int(a - b)


def _seq_times(seq, n):
    if isinstance(n, bool):
        n = int(n)
    if n > 0 and _size(seq) * n > MAX_SIZE:
        _limit("sequence over %d elements" % MAX_SIZE)
    _charge(max(0, len(seq) * n))


def _hs_mul(a, b):
    if isinstance(a, (str, list, tuple)) and isinstance(b, int):
        _seq_times(a, b)
    elif isinstance(b, (str, list, tuple)) and isinstance(a, int):
        _seq_times(b, a)
    elif isinstance(a, int) and isinstance(b, int) and a.bit_length() + b.bit_length() > MAX_INT_BITS + 1:
        _limit("integer over %d bits" % MAX_INT_BITS)
    return _check_int(a * b)


def _hs_pow(a, b):
    if isinstance(a, int) and isinstance(b, int) and not isinstance(b, bool) and b > 1 and abs(a) > 1:
        if (abs(a).bit_length() - 1) * b > MAX_INT_BITS:
            _limit("integer over %d bits" % MAX_INT_BITS)
    return _check_int(a ** b)


_FMT = re.compile(r"%(?:\([^)]*\))?[-#0 +]*(\*|\d+)?(?:\.(\*|\d+))?")


def _hs_mod(a, b):
    if isinstance(a, str):   # %-formatting: refuse huge widths ('%0999999999d') and '*' widths
        for m in _FMT.finditer(a):
            for g in m.groups():
                if g == "*" or (g and int(g) > MAX_FORMAT_WIDTH):
                    _limit("format width over %d" % MAX_FORMAT_WIDTH)
        if _size(b) > MAX_SIZE:
            _limit("value over %d elements" % MAX_SIZE)
        out = a % b
        if len(out) > MAX_SIZE:
            _limit("string over %d characters" % MAX_SIZE)
        _charge(len(out))
        return out
    return _check_int(a % b)


_OPS = {ast.Add: "_hs_add", ast.Sub: "_hs_sub", ast.Mult: "_hs_mul", ast.Pow: "_hs_pow", ast.Mod: "_hs_mod"}


class _Guard(ast.NodeTransformer):
    """Rewrites a validated tree: checked arithmetic, counted comprehension loops."""

    def visit_BinOp(self, node):
        self.generic_visit(node)
        name = _OPS.get(type(node.op))
        if name is None:
            return node
        return ast.copy_location(ast.Call(func=ast.Name(id=name, ctx=ast.Load()), args=[node.left, node.right],
                                          keywords=[]), node)

    def visit_comprehension(self, node):
        self.generic_visit(node)
        node.iter = ast.copy_location(ast.Call(func=ast.Name(id="_hs_iter", ctx=ast.Load()), args=[node.iter],
                                               keywords=[]), node.iter)
        return node


def _hs_iter(xs):
    """Every comprehension loop of one evaluate() call draws on one iteration budget."""
    b = getattr(_budget, "b", None)
    for x in xs:
        if b is not None:
            b[0] -= 1
            if b[0] < 0:
                _limit("over %d loop iterations" % MAX_ITER)
        yield x


_GUARDS = {"_hs_iter": _hs_iter, "_hs_add": _hs_add, "_hs_sub": _hs_sub, "_hs_mul": _hs_mul, "_hs_pow": _hs_pow,
           "_hs_mod": _hs_mod}


def _range(*a):
    r = range(*a)
    if len(r) > MAX_SIZE:
        _limit("range over %d elements" % MAX_SIZE)
    return r


def _str(x=""):
    if _size(x) > MAX_SIZE:
        _limit("value over %d elements" % MAX_SIZE)
    out = str(x)
    _charge(len(out))
    return out


def _list(xs=()):
    out = list(xs)
    if len(out) > MAX_SIZE:
        _limit("list over %d elements" % MAX_SIZE)
    _charge(len(out))
    return out


def _sorted(xs, **kw):
    out = sorted(xs, **kw)
    if len(out) > MAX_SIZE:
        _limit("list over %d elements" % MAX_SIZE)
    _charge(len(out))
    return out


def _join(sep, xs):
    xs = [_str(x) for x in xs]
    if len(str(sep)) * len(xs) + sum(map(len, xs)) > MAX_SIZE:
        _limit("string over %d characters" % MAX_SIZE)
    out = str(sep).join(xs)
    _charge(len(out))
    return out


def _replace(text, old, new):
    text = _str(text)
    k = text.count(old) if old else len(text) + 1
    if len(text) + k * max(0, len(new) - len(old)) > MAX_SIZE:
        _limit("string over %d characters" % MAX_SIZE)
    out = text.replace(old, new)
    _charge(len(out))
    return out


def _sub(pattern, repl, text):
    if len(pattern) >= 500:
        return text
    text = text or ""
    if _size(text) > MAX_SIZE // 10:
        _limit("regex input over %d characters" % (MAX_SIZE // 10))
    out = re.sub(pattern, repl, text, flags=re.I)
    if len(out) > MAX_SIZE:
        _limit("string over %d characters" % MAX_SIZE)
    _charge(len(out))
    return out


def _search(pattern, text):
    text = text or ""
    if _size(text) > MAX_SIZE // 10:
        _limit("regex input over %d characters" % (MAX_SIZE // 10))
    return bool(re.search(pattern, text, re.I))


def _money(x, places=2):
    places = int(places)
    if not 0 <= places <= 20:
        _limit("money places outside 0-20")
    return ("%%.%df" % places) % float(x)


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
    t = _str(text).lower().replace("\u2212", "-").replace("\u2013", "-").replace("\u2014", "-")
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
    "replace": _replace,
    "sub": _sub,
    "normalize": lambda text: re.sub(r"\s+", " ", re.sub(r"[*_`~]+", " ", _str(text or ""))).strip(),
    "join": _join,
    "money": _money,
    "search": _search,
    "len": len, "sum": lambda xs: sum(x for x in xs if _num(x)),
    "numeric": lambda xs: [x for x in xs if _num(x)], "min": min, "max": max, "abs": abs,
    "round": round, "mean": _mean, "any": any, "all": all, "sorted": _sorted, "list": _list, "range": _range,
    "int": int, "enumerate": enumerate, "zip": zip, "float": float, "str": _str, "bool": bool,
    "count": lambda xs, v=True: sum(1 for x in xs if x == v),
    "clip": lambda x, lo, hi: max(lo, min(hi, x)),
    "exp": math.exp, "log": math.log, "sqrt": math.sqrt, "atan": math.atan, "atan2": math.atan2, "degrees": math.degrees,
    "lower": lambda s: s.lower() if isinstance(s, str) else s,
}

_cache = {}


def compile_expr(src):
    if src in _cache:
        return _cache[src]
    if not isinstance(src, str):
        raise ExprError("expression is not a string: %r" % (src,))
    if len(src) > MAX_SOURCE:
        _limit("source over %d characters" % MAX_SOURCE)
    try:
        tree = ast.parse(src, mode="eval")
    except SyntaxError as e:
        raise ExprError("syntax error in %r: %s" % (src[:200], e.msg))
    except (RecursionError, MemoryError):
        _limit("nesting too deep")
    if _depth(tree) > MAX_DEPTH:
        _limit("nesting over %d levels" % MAX_DEPTH)
    for node in ast.walk(tree):
        if not isinstance(node, ALLOWED):
            raise ExprError("%s not allowed in %r" % (type(node).__name__, src))
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise ExprError("name %r not allowed" % node.id)
        if isinstance(node, ast.Call) and not isinstance(node.func, ast.Name):
            raise ExprError("only plain function calls allowed in %r" % src)
    tree = ast.fix_missing_locations(_Guard().visit(tree))
    try:
        code = compile(tree, "<expr>", "eval")
    except (RecursionError, MemoryError):
        _limit("nesting too deep")
    _cache[src] = code
    return code


def _depth(tree):
    best, stack = 0, [(tree, 1)]
    while stack:
        n, d = stack.pop()
        best = max(best, d)
        if d > MAX_DEPTH:
            return d
        stack.extend((c, d + 1) for c in ast.iter_child_nodes(n))
    return best


def names_in(src):
    return {n.id for n in ast.walk(ast.parse(src, mode="eval")) if isinstance(n, ast.Name)}


def evaluate(src, names, funcs=None):
    code = compile_expr(src)
    env = dict(BASE_FUNCS)
    if funcs:
        env.update(funcs)
    env.update(names)
    env.update(_GUARDS)   # after names: a name can never replace a guard (user names cannot start with "_")
    env["__builtins__"] = {}
    prev = getattr(_budget, "b", None)
    _budget.b = [MAX_ITER, MAX_ALLOC]
    try:
        out = eval(code, env)
    except ExprError:
        raise
    except (MemoryError, RecursionError) as e:
        raise ExprError("expression limit: %s evaluating %r" % (type(e).__name__, src[:200]))
    except Exception as e:  # report which rule failed, never crash the session silently
        raise ExprError("error evaluating %r: %s: %s" % (src[:500], type(e).__name__, e))
    finally:
        _budget.b = prev
    if _size(out) > MAX_SIZE:
        _limit("result over %d elements" % MAX_SIZE)
    return _check_int(out)
