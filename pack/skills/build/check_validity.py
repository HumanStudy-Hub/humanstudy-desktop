#!/usr/bin/env python3
"""Check that the runnable package replays what the original participants experienced.

    python .opencode/skills/build/check_validity.py .   [--package package/<slug>] [--json report.json]

check_package.py runs it; it must print PASS before the package can be marked ready. Five checks:

  not told       every sentence of the paper saying participants were not told something, had to learn
                 or discover it, or were kept unaware of it is listed in a `not-told` field of
                 program.json (on the procedure node), and no prompt text the build wrote contains that
                 information (the entry's `terms`). Text transcribed verbatim from the paper's
                 participant materials (instructions, debriefing) is the participants' own text and is
                 not a leak.
  memory         a task that asks one participant many times and carries their earlier trials into
                 later prompts records that design as a `replay-memory` decision field; the default is
                 what participants plausibly saw, so a full trial log needs evidence that participants
                 saw one, or a researcher's decision.
  unparsed       one unparsed reply must not drop a whole participant (`valid = all(...)` over trials):
                 record unparsed replies per trial and apply the paper's own exclusion rule.
  instructions   a participant-instruction field the paper does not print is `missing` with a
                 `decision` issue (the researcher supplies the text or accepts the stand-in wording),
                 never `blocking` and never `check`.
  not-told field program.json has a `not-told` field (a list; [] when the paper says nothing was withheld).

How the prompts are read: the adapter's run_sessions is run with a stand-in model in a confined child
(sandbox_run.py, on a copy of the package laid out like the project: no keys, no network, writes only in a
scratch folder), once over all arms and, when that stops at the call cap, once per arm; every distinct
prompt line is recorded. When the adapter cannot run (a blocked study), its string literals and
materials/materials.json are read instead.

Limits (heuristics, documented so nobody mistakes a PASS for proof):
  - The paper scan finds the usual phrasings ("were not told", "had to learn", "were unaware", "cover
    story", ...). A withheld fact phrased otherwise is found only if you list it yourself: do so.
  - A leak is found only when the prompt contains one of the entry's terms. Choose terms a leaking prompt
    would have to contain (the words of the withheld rule: "yellow", "can be selected", "upper circle");
    the terms must include at least one word of the printed statement. Words of other not-told
    sentences are printed as notes when build-written text contains them; read them.
  - Timing is not checked: verbatim text that reveals a rule later (a debriefing) is accepted anywhere.
  - The memory check reads prompt growth and the prompt function's parameters; a log passed in another
    way (a chat transcript) is found only by its growth.
Standard library plus the PDF reader check_quotes.py uses.
"""
import argparse
import ast
import json
import random
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_quotes  # noqa: E402
import check_verbatim  # noqa: E402

PARTICIPANT = re.compile(
    r"\b(?:participants?|subjects?|respondents?|volunteers?|players?|children|students?|individuals|people|"
    r"they|patients|observers?|listeners?|raters?|workers|decision.makers|infants|adults)\b", re.I)
TRIGGERS = [re.compile(p, re.I) for p in (
    r"\b(?:were|was|are|is) (?:not|never) (?:explicitly |directly |initially |ever |specifically )?"
    r"(?:told|informed|instructed|shown|given|made aware|explained|cued)\b",
    r"\bwithout (?:being|having been) (?:explicitly )?(?:told|informed|instructed|shown)\b",
    r"\b(?:were|was|remained|are|kept) (?:unaware|naive|naïve|uninformed|blind)\b",
    r"\bhad to (?:learn|discover|infer|figure out|work out|find out)\b",
    r"\b(?:received|given|provided with|had) no (?:explicit |prior |further )?(?:information|instructions?|explanation|knowledge)\b",
    r"\bno (?:explicit |prior )?(?:information|instructions?|explanation) (?:was|were) (?:given|provided)\b",
    r"\bcover story\b", r"\bled to believe\b", r"\bdeceived\b")]
STOP = set("""a an the and or of to in on at by for with from as that this these those is are was were be been
being it its their they them he she his her we our you your not no only both how when what which who whom
whether if then than so such could would should can may might must had has have do did does about into
also there here each other more most less any all some one two first second""".split())
HISTORY_PARAM = re.compile(r"hist|past|previous|earlier|log|memory|transcript|record|trials?_so_far|seen", re.I)
UNPARSED = re.compile(r"""["']?\bvalid["']?\s*[:=]\s*all\s*\(""")
INSTRUCTION = re.compile(r"instruction", re.I)
MATERIAL_FIELD = re.compile(r"instruction|debrief|briefing|item|question|prompt|stimul|scenario|vignette|scale|"
                            r"script|screen|message|text|wording|consent|cover", re.I)
DESIGNS = ("none", "last-trial", "summary", "full-log", "conversation", "other")
FULL = ("full-log", "conversation")
CALL_CAP = 2500          # stand-in calls over all arms before the capture stops
ARM_CAP = 600            # per arm, when the first pass hit CALL_CAP
MIN_TRIALS = 10          # calls per participant that make a task a repeated-trial task


class _Stop(BaseException):
    """Raised by the stand-in model at the call cap; BaseException so an adapter's `except Exception` keeps it."""


# ---- reading --------------------------------------------------------------------------------------

def _json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _package(root, given=None):
    if given:
        return Path(given).resolve()
    found = sorted(d for d in (root / "package").glob("*") if (d / "task/adapter.py").is_file()) \
        if (root / "package").is_dir() else []
    return found[0] if len(found) == 1 else None


def _paper(root, program):
    if (root / "paper.pdf").is_file():
        return root / "paper.pdf"
    name = (program.get("source") or {}).get("filename")
    return root / name if name and (root / name).is_file() else None


def _fields(program):
    for n in program.get("nodes") or []:
        if isinstance(n, dict):
            for f in n.get("fields") or []:
                if isinstance(f, dict):
                    yield n, f


def norm(text):
    return check_quotes.normalise(text if isinstance(text, str) else json.dumps(text, ensure_ascii=False))


def has_phrase(text_norm, term_norm):
    return bool(term_norm) and re.search(r"(?<![\w])" + re.escape(term_norm) + r"(?![\w])", text_norm) is not None


# ---- the paper: what participants were not told -----------------------------------------------------

def statements(pages):
    """[(page, trigger, context)]: sentences that say participants were not told something (one per passage)."""
    out = []
    for number, text in enumerate(pages, 1):
        flat = re.sub(r"\s+", " ", re.sub(r"(\w)-\s*\n\s*(\w)", r"\1\2", text or ""))
        found = sorted((m for pat in TRIGGERS for m in pat.finditer(flat)), key=lambda m: m.start())
        last = -10 ** 6
        for m in found:
            if m.start() - last < 300:   # the same passage, found by another phrase
                continue
            left = flat.rfind(". ", 0, max(0, m.start() - 1))
            start = max(left + 2 if left >= 0 else 0, m.start() - 300)
            stop = flat.find(". ", m.end())
            context = flat[start:(stop + 1 if 0 <= stop < m.end() + 300 else m.end() + 300)]
            if PARTICIPANT.search(context):
                out.append((number, m.group(0), context.strip()))
                last = m.start()
    return out


def _covered(hit, entries):
    page, trigger, context = hit
    want = norm(context)
    for e in entries:
        if not isinstance(e.get("page"), int) or abs(e["page"] - page) > 1:
            continue
        got = norm(e.get("statement") or "")
        if not got:
            continue
        short, long_ = (want, got) if len(want) <= len(got) else (got, want)
        if short in long_ or check_quotes.match(short, long_) >= 0.75 or check_quotes.match(long_, short) >= 0.75:
            return True
    return False


def inventory(program):
    """(entries, problems, has_field)."""
    entries, problems, has_field = [], [], False
    for n, f in _fields(program):
        if f.get("id") != "not-told":
            continue
        has_field = True
        where = "%s.not-told" % n.get("id")
        value = f.get("value")
        if f.get("state") == "missing":
            continue
        if not isinstance(value, list):
            problems.append(("%s: value must be a list of entries ([] when the paper says nothing was withheld)" % where,
                             'write [{"statement": "<the printed sentence>", "page": 7, "withheld": "...", "terms": [...]}]'))
            continue
        for i, e in enumerate(value):
            at = "%s[%d]" % (where, i)
            if not isinstance(e, dict):
                problems.append(("%s: an entry is an object" % at, ""))
                continue
            e = dict(e, _where=at)
            entries.append(e)
            if not str(e.get("statement") or "").strip() or not isinstance(e.get("page"), int):
                problems.append(("%s: needs the printed `statement` and its `page`" % at,
                                 "copy the sentence as printed and give its physical page"))
            if str(e.get("notApplicable") or "").strip():
                continue
            terms = [t for t in e.get("terms") or [] if isinstance(t, str) and len(norm(t)) >= 3]
            if not str(e.get("withheld") or "").strip() or not terms:
                problems.append(("%s: needs `withheld` (what participants did not know) and `terms` (words a prompt "
                                 "that leaks it would contain)" % at,
                                 'or `notApplicable` with the reason when the sentence is not about participants'))
            elif not any(has_phrase(norm(e.get("statement")), norm(t)) for t in terms):
                problems.append(("%s: no term is a word of the printed statement" % at,
                                 "include the statement's own words for the withheld rule among the terms"))
    return entries, problems, has_field


def _on_page(entry, pages):
    page = entry.get("page")
    if not isinstance(page, int) or not pages:
        return True
    if not 1 <= page <= len(pages):
        return False
    near = " ".join(norm(pages[p - 1]) for p in (page - 1, page, page + 1) if 1 <= p <= len(pages))
    if len(near) < 40:
        return True   # no text layer: compared with the page image by the researcher
    stmt = norm(entry.get("statement") or "")
    return stmt in near or check_quotes.match(stmt, near) >= check_quotes.CLOSE


# ---- the package: the prompts ----------------------------------------------------------------------

def _standin(prompt):
    """A reply that parses in most tasks: an option the prompt's last lines offer, else "1"."""
    tail = (prompt if isinstance(prompt, str) else json.dumps(prompt))[-300:]
    options = re.findall(r"\b([A-Z]{2,6}|[1-9])\b", tail)
    return random.Random(len(tail)).choice(options) if options else "1"


def capture(pkg):
    """Run in a child process: record every prompt run_sessions sends. Prints one JSON line."""
    import importlib.util
    sys.path.insert(0, str(pkg / "task"))
    spec = importlib.util.spec_from_file_location("hs_validity_adapter", pkg / "task/adapter.py")
    mod = importlib.util.module_from_spec(spec)
    out = {"runs": [], "error": None}
    try:
        spec.loader.exec_module(mod)
    except BaseException as exc:  # noqa: BLE001
        out["error"] = "adapter import failed: %s" % exc
        print("@@CAPTURE@@" + json.dumps(out))
        return

    def run(arms, cap):
        prompts = []

        def llm(prompt, *a, **k):
            if len(prompts) >= cap:
                raise _Stop()
            prompts.append(prompt if isinstance(prompt, str) else json.dumps(prompt, ensure_ascii=False))
            return _standin(prompts[-1])
        rec = {"arms": arms, "calls": 0, "sessions": None, "capped": False, "error": None}
        try:
            sessions = mod.run_sessions(llm, 20261102, 1, arms=arms) if arms else mod.run_sessions(llm, 20261102, 1)
            rec["sessions"] = len(sessions) if isinstance(sessions, list) else None
        except _Stop:
            rec["capped"] = True
        except BaseException as exc:  # noqa: BLE001  a blocked study raises; keep what was sent
            rec["error"] = "%s: %s" % (type(exc).__name__, str(exc)[:300])
        rec["calls"] = len(prompts)
        rec["lengths"] = [len(p) for p in prompts]
        lines = {}
        for p in prompts:   # distinct lines: a growing trial log adds one line per trial, not one copy per prompt
            for line in p.splitlines():
                if line.strip() and len(lines) < 50000:
                    lines.setdefault(line[:4000], None)
        rec["lines"] = list(lines)
        return rec

    first = run(None, CALL_CAP)
    out["runs"].append(first)
    if first["capped"]:
        study = _json(pkg / "study.json") or {}
        task = _json(pkg / "task/task.json") or {}
        names = list(study.get("runnableArms") or [])
        arms = task.get("arms")
        names += [a for a in arms if isinstance(a, str)] if isinstance(arms, list) else []
        names += [c.get("arm") or c.get("id") for c in task.get("conditions") or [] if isinstance(c, dict)
                  and c.get("runnable", True)] if isinstance(task.get("conditions"), list) else []
        for arm in [a for a in dict.fromkeys(names) if a][:8]:
            out["runs"].append(run([arm], ARM_CAP))
    print("@@CAPTURE@@" + json.dumps(out, ensure_ascii=False))


def prompts_of(pkg, timeout=300):
    """Capture the prompts in a confined child on a copy of the package laid out like the project."""
    import sandbox_run
    from check_package import BESIDE_PROGRAM
    with sandbox_run.work_dir(prefix="check-validity-") as work:
        copy = work / "project" / "package" / pkg.name
        sandbox_run.copy_tree(pkg, copy, ignore=shutil.ignore_patterns("__pycache__", ".git"))
        project = pkg.parent.parent
        if pkg.parent.name == "package" and (project / "program.json").is_file():
            for f in project.iterdir():  # only what the project format puts beside program.json
                if f.is_file() and not f.is_symlink() and (f.name in BESIDE_PROGRAM or f.suffix.lower() == ".pdf"):
                    shutil.copy2(f, work / "project" / f.name)
            if (project / "sources").is_dir() and not (project / "sources").is_symlink():
                sandbox_run.copy_tree(project / "sources", work / "project" / "sources")
        run = sandbox_run.run_python(Path(__file__).resolve(), ["--capture", str(copy)], cwd=copy, work=work,
                                     timeout=timeout)
    if run.timed_out:
        return {"runs": [], "error": "the adapter did not finish within %ds with a stand-in model" % timeout}
    line = next((l for l in run.stdout.splitlines()[::-1] if l.startswith("@@CAPTURE@@")), None)
    if line is None:
        return {"runs": [], "error": "the adapter could not be run: " + (run.stderr or run.stdout)[-400:]}
    try:
        return json.loads(line[len("@@CAPTURE@@"):])
    except ValueError:
        return {"runs": [], "error": "the prompt capture was cut off"}


def _docstrings(tree):
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(getattr(first, "value", None), ast.Constant):
                out.add(id(first.value))
    return out


def static_texts(pkg):
    """String literals of the adapter (not docstrings) and every string of materials.json."""
    texts = []
    try:
        tree = ast.parse((pkg / "task/adapter.py").read_text(encoding="utf-8"))
        skip = _docstrings(tree)
        texts += [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)
                  and id(n) not in skip and len(n.value) >= 3]
    except (OSError, SyntaxError, ValueError):
        pass

    def walk(v):
        if isinstance(v, str):
            texts.append(v)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    walk(_json(pkg / "materials/materials.json"))
    return texts


def participant_text(program):
    """Normalised pieces of verbatim participant materials (the participants' own text, not a leak)."""
    pieces = []
    for n, f in _fields(program):
        if f.get("origin") != "verbatim":
            continue
        if n.get("kind") not in ("material", "materials") and not MATERIAL_FIELD.search("%s %s" % (f.get("id"), f.get("label"))):
            continue
        pieces += [p for p in check_verbatim.segments(f.get("value")) if len(p.split()) >= 3]
    return sorted(set(pieces), key=len, reverse=True)


def authored(text, pieces):
    t = norm(text)
    for p in pieces:
        if p in t:
            t = t.replace(p, " | ")
    return t


def _snippet(text_norm, term_norm):
    m = re.search(r"(?<![\w])" + re.escape(term_norm) + r"(?![\w])", text_norm)
    return text_norm[max(0, m.start() - 60):m.end() + 60] if m else ""


def history_params(pkg):
    """(param names, full) for prompt functions that take the participant's earlier trials."""
    try:
        tree = ast.parse((pkg / "task/adapter.py").read_text(encoding="utf-8"))
    except (OSError, SyntaxError, ValueError):
        return [], False
    names, full = [], False
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) or "prompt" not in fn.name.lower():
            continue
        params = [a.arg for a in fn.args.args + fn.args.kwonlyargs if HISTORY_PARAM.search(a.arg)]
        for p in params:
            names.append("%s(%s)" % (fn.name, p))
            for node in ast.walk(fn):
                # iterating over or joining the whole history; a subscript (history[-1], history[-5:]) is partial
                if isinstance(node, (ast.For, ast.comprehension)) and isinstance(node.iter, ast.Name) and node.iter.id == p:
                    full = True
                if isinstance(node, (ast.For, ast.comprehension)) and isinstance(node.iter, ast.Call) \
                        and any(isinstance(a, ast.Name) and a.id == p for a in node.iter.args):
                    full = True
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "join" \
                        and any(isinstance(a, ast.Name) and a.id == p for a in node.args):
                    full = True
    return names, full


def grows(lengths):
    """True when prompts keep getting longer: a log of earlier trials is carried along."""
    if len(lengths) < MIN_TRIALS:
        return False
    changes = [b - a for a, b in zip(lengths, lengths[1:]) if b != a]
    return bool(changes) and sum(1 for c in changes if c > 0) >= 0.6 * len(changes) and lengths[-1] >= 2 * min(lengths[:3])


# ---- the check -------------------------------------------------------------------------------------

def check(root, package=None, capture_prompts=True):
    root = Path(root).resolve()
    program = _json(root / "program.json")
    if not isinstance(program, dict):
        return {"problems": [("program.json is missing or not JSON", "")], "notes": [], "method": None}
    problems, notes = [], []
    add = lambda msg, fix="": problems.append((msg, fix))
    pkg = _package(root, package)
    paper = _paper(root, program)
    pages = check_quotes.Pdf(paper).load() if paper and paper.suffix.lower() == ".pdf" else []

    # not-told field and inventory
    entries, bad, has_field = inventory(program)
    problems += bad
    if not has_field:
        add("program.json has no `not-told` field: what the paper says participants were not told is not recorded",
            'add to the procedure node a field {"id": "not-told", "label": "What participants were not told", '
            '"origin": "reported", "state": "confirmed", "value": [...], "evidenceIds": [...]} ([] when the paper '
            'says nothing was withheld)')
    for e in entries:
        if not _on_page(e, pages):
            add("%s: the statement is not on p. %s" % (e["_where"], e.get("page")),
                "copy the sentence as printed and cite the page it is on")
    for hit in statements(pages):
        if not _covered(hit, entries):
            add("p. %d says \"...%s...\" but no not-told entry lists it" % (hit[0], hit[2][:220]),
                "add an entry with the printed statement, what was withheld and the terms a leaking prompt would "
                "contain; or `notApplicable` with the reason when it is not about what participants knew")

    # prompts
    method, runs, texts = None, [], []
    if pkg is None:
        notes.append("no package/<slug>/task/adapter.py: prompts not checked")
    else:
        cap = prompts_of(pkg) if capture_prompts else {"runs": [], "error": "capture off"}
        runs = [r for r in cap.get("runs") or [] if r.get("calls")]
        if runs:
            method = "prompts sent by run_sessions with a stand-in model (%s calls)" % sum(r["calls"] for r in runs)
            texts = [p for r in runs for p in r.get("lines") or []]
            for r in cap.get("runs") or []:
                if r.get("error"):
                    notes.append("run_sessions%s stopped: %s" % (" arm %s" % r["arms"] if r.get("arms") else "", r["error"]))
        else:
            method = "string literals of task/adapter.py and materials/materials.json (the adapter did not run: %s)" % (
                cap.get("error") or next((r.get("error") for r in cap.get("runs") or [] if r.get("error")), "no prompts"))
            texts = static_texts(pkg)
        pieces = participant_text(program)
        written = [authored(t, pieces) for t in dict.fromkeys(texts)]
        for e in entries:
            if str(e.get("notApplicable") or "").strip():
                continue
            for term in e.get("terms") or []:
                tn = norm(term) if isinstance(term, str) else ""
                if len(tn) < 3:
                    continue
                hit = next((w for w in written if has_phrase(w, tn)), None)
                if hit is not None:
                    add("%s: a prompt the build wrote tells participants what they were not told (%s): \"...%s...\""
                        % (e["_where"], term, _snippet(hit, tn)),
                        "remove it from the prompt: participants had to discover it. Only text the paper prints as "
                        "participant material (transcribed verbatim) may contain it")
        for page, trigger, context in statements(pages):
            words = [w for w in norm(context).split() if len(w) >= 5 and w not in STOP and not w.isdigit()]
            seen = sorted({w for w in words for t in written if has_phrase(t, w)})
            if seen:
                notes.append("p. %d (%s): build-written prompt text contains its words %s; check it does not tell "
                             "participants what they had to discover" % (page, trigger, ", ".join(seen[:10])))

        # memory
        params, full_static = history_params(pkg)
        growth = any(grows(r.get("lengths") or []) for r in runs)
        per_participant = max([r["calls"] / max(1, r["sessions"] or 1) for r in runs if r.get("sessions")] or
                              [r["calls"] for r in runs] or [0])
        carries = growth or (full_static and params)
        memory = [(n, f) for n, f in _fields(program) if f.get("id") == "replay-memory"]
        if (carries or params or per_participant >= MIN_TRIALS) and not memory:
            how = ("every prompt carries the earlier trials (%s)" % (", ".join(params) or "the prompts grow") if carries
                   else "its prompt function takes %s" % ", ".join(params) if params
                   else "it is a repeated-trial task")
            add("the package asks each participant %s times%s and %s, but program.json records no `replay-memory` "
                "decision" % (int(per_participant) or "many", " or more" if any(r.get("capped") for r in runs) else "", how),
                'add to the procedure node {"id": "replay-memory", "label": "What a participant remembers between '
                'trials", "origin": "implementation", "state": "decision", "value": {"design": "none | last-trial | '
                'summary | full-log | conversation | other", "shows": "...", "participantsSaw": "...", '
                '"expectedImpact": "..."}, "evidenceIds": [...]} and a decision issue; the default is what '
                'participants plausibly saw')
        for n, f in memory:
            v = f.get("value") if isinstance(f.get("value"), dict) else {}
            where = "%s.replay-memory" % n.get("id")
            if v.get("design") not in DESIGNS:
                add("%s: value.design must be one of %s" % (where, ", ".join(DESIGNS)), "")
            for k in ("shows", "participantsSaw", "expectedImpact"):
                if not str(v.get(k) or "").strip():
                    add("%s: value.%s is empty" % (where, k), "say it in one sentence")
            researcher = f.get("origin") == "researcher"
            if v.get("design") in FULL and not researcher and not f.get("evidenceIds"):
                add("%s: a %s is not what participants saw unless the paper says so" % (where, v.get("design")),
                    "default to what participants plausibly saw (the current screen, the last outcome, a counter "
                    "they saw), or cite the evidence that they saw their earlier trials; a researcher may decide otherwise")
            if carries and v.get("design") not in FULL + ("other",):
                add("%s: design is %r but the prompts carry every earlier trial (%s)"
                    % (where, v.get("design"), "growing prompts" if growth else ", ".join(params)),
                    "make the adapter match the recorded design, or record the design it implements")
            if f.get("state") == "decision" and not any(i.get("nodeId") == n.get("id") and i.get("fieldId") == "replay-memory"
                                                        and i.get("severity") == "decision" for i in program.get("issues") or []):
                add("%s: a decision needs its decision issue (nodeId %s, fieldId replay-memory)" % (where, n.get("id")),
                    "state the expected impact in the issue so the researcher can choose")

        # unparsed replies
        for rel in ("task/adapter.py", "evaluation/evaluation.py"):
            try:
                lines = (pkg / rel).read_text(encoding="utf-8").splitlines()
            except OSError:
                continue
            for i, line in enumerate(lines, 1):
                if UNPARSED.search(line):
                    add("%s:%d: one unparsed reply drops the whole participant (%s)" % (rel, i, line.strip()[:120]),
                        "record unparsed replies per trial (e.g. trial['parsed'] = False) and exclude trials or "
                        "participants only by the paper's own rule")

    # missing instructions: one rule
    issues = [i for i in program.get("issues") or [] if isinstance(i, dict)]
    for n, f in _fields(program):
        if f.get("state") != "missing" or not INSTRUCTION.search("%s %s" % (f.get("id"), f.get("label"))):
            continue
        for i in issues:
            if i.get("nodeId") == n.get("id") and i.get("fieldId") == f.get("id") and i.get("severity") != "decision":
                add("%s: issue %s on missing participant instructions has severity %r" % (
                    "%s.%s" % (n.get("id"), f.get("id")), i.get("id"), i.get("severity")),
                    "missing instruction wording is a `decision`: the researcher supplies the printed text or accepts "
                    "the stand-in wording the adapter uses (say which in suggestedAction); it is never written "
                    "into a verbatim field")
    return {"problems": problems, "notes": notes, "method": method}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["--capture"]:
        capture(Path(argv[1]).resolve())
        return 0
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--package", help="package/<slug> (default: the only package of the project)")
    ap.add_argument("--json", help="write the report here")
    a = ap.parse_args(argv)
    report = check(a.root, a.package)
    if a.json:
        Path(a.json).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for msg, fix in report["problems"]:
        print("PROBLEM %s" % msg + ("\n        fix: %s" % fix if fix else ""))
    for line in report["notes"]:
        print("note    " + line)
    if report["method"]:
        print("prompts read from: " + report["method"])
    if report["problems"]:
        print("FAIL %d validity problem(s)" % len(report["problems"]))
        return 1
    print("PASS package validity")
    return 0


if __name__ == "__main__":
    sys.exit(main())
