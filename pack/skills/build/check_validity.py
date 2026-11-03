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
  unparsed       one unparsed reply must not drop a whole participant (all(...)/any(...) over the trials'
                 parse status): record unparsed replies per trial and apply the paper's own exclusion rule
                 (a line that applies it carries `# exclusion: <evidence id>` whose quote states the rule).
  instructions   a participant-instruction field the paper does not print is `missing` with a
                 `decision` issue (the researcher supplies the text or accepts the stand-in wording), or
                 `blocking` when the adapter refuses to run without it; never `check`.
  not-told field program.json has a `not-told` field (a list; [] when the paper says nothing was withheld).

How the prompts are read: the adapter's run_sessions is run with a stand-in model in a confined child
(sandbox_run.py, on a copy of the package laid out like the project: no keys, no network, writes only in a
scratch folder; sleeps are skipped), once over all arms and once per arm study.json or task.json names; every
distinct prompt line is recorded. An adapter that does not finish with the stand-in model fails. When the adapter cannot run (a blocked study), its string literals and
materials/materials.json are read instead.

Limits (heuristics, documented so nobody mistakes a PASS for proof):
  - The paper scan finds the usual phrasings ("were not told", "had to learn", "were unaware", "cover
    story", ...). A withheld fact phrased otherwise is found only if you list it yourself: do so.
  - A leak is found only when the prompt contains one of the entry's terms. Choose terms a leaking prompt
    would have to contain (the words of the withheld rule: "yellow", "can be selected", "upper circle");
    the terms must include a content word of the printed statement (not "told", "participants", "the")
    and share a word with `withheld`. Entries marked `notApplicable` are printed with their reason. Words of other not-told
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
    r"patients|observers?|listeners?|raters?|workers|decision.makers|infants|adults)\b", re.I)
REFERENCES = re.compile(r"^\s*(?:references|bibliography|literature cited|works cited)\s*$", re.I | re.M)
TRIGGERS = [re.compile(p, re.I) for p in (
    r"\b(?:were|was|are|is) (?:not|never) (?:explicitly |directly |initially |ever |specifically )?"
    r"(?:told|informed|instructed|shown|given|made aware|explained|cued)\b",
    r"\bwithout (?:being|having been) (?:explicitly )?(?:told|informed|instructed|shown)\b",
    r"\b(?:were|was|remained|are|kept) (?:unaware|naive|naïve|uninformed)\b",
    r"\bhad to (?:learn|discover|infer|figure out|work out|find out)\b",
    r"\b(?:received|given|provided with|had) no (?:explicit |prior |further )?(?:information|instructions?|explanation|knowledge)\b",
    r"\bno (?:explicit |prior )?(?:information|instructions?|explanation) (?:was|were) (?:given|provided)\b",
    r"\bcover story\b", r"\bled to believe\b", r"\bdeceived\b")]
STOP = set("""a an the and or of to in on at by for with from as that this these those is are was were be been
being it its their they them he she his her we our you your not no only both how when what which who whom
whether if then than so such could would should can may might must had has have do did does about into
also there here each other more most less any all some one two first second""".split())
PROVENANCE = re.compile(r"quote|evidence|source|citation|provenance|note|comment|page", re.I)
HISTORY_PARAM = re.compile(r"hist|past|previous|earlier|log|memory|transcript|record|trials?_so_far|seen", re.I)
PARSE_STATUS = re.compile(r"pars|\bvalid\b|\bok\b|\b(?:choice|response|answer|reply|rating|decision)\w*\b.{0,40}\bis (?:not )?None",
                          re.I)
VALID_FLAG = re.compile(r"valid|\bok\b|complete|includ|keep|usable|exclu", re.I)
TRIALS = re.compile(r"trial|resp|answer|choice|repl|round|item|rating", re.I)
EXCLUSION_MARK = re.compile(r"#\s*exclusion:\s*([\w.-]+)", re.I)
EXCLUDED_WHO = re.compile(r"participant|subject|respondent|respons|answer|trial|incomplete|fail|missing|attention|"
                          r"data|session|catch", re.I)
EXCLUSION_WORDS = re.compile(r"exclu|remov|discard|omit|drop|not (?:included|analy[sz]ed)", re.I)
INSTRUCTION = re.compile(r"instruction|briefing|wording", re.I)
# words that say "not told" (or name the participants) and so ground nothing about what was withheld
FRAME = set("""told tell informed inform instructed instruct instructions instruction shown show given give aware unaware
naive naïve uninformed blind learn learned learnt discover discovered infer inferred figure work find out explicit
explicitly directly initially ever specifically cued explained explanation information knowledge prior further
cover story believe led deceived kept remained participant participants subject subjects respondent respondents
volunteers player players children student students individuals people patients observers listeners raters
workers infants adults never were was are task experiment study""".split())
_SEEN = r"(?:choices?|outcomes?|trials?|responses?|rounds?|decisions?|selections?|rewards?|earnings|payoffs?|results?)"
HISTORY_WORDS = re.compile(
    r"\b(?:their|his|her|own|participants'?|subjects'?|the) (?:own )?(?:previous|earlier|past|prior|preceding) " + _SEEN +
    r"|\bhistory of (?:their |the |all )?(?:previous |past )?" + _SEEN +
    r"|\b(?:choice|outcome|reward|trial|response|payoff) histor(?:y|ies)\b"
    r"|\ball (?:of )?(?:their|the) (?:previous |earlier |past )?" + _SEEN + r" (?:so far|were (?:shown|displayed|visible))"
    r"|\b(?:shown|displayed|visible|presented)\b[^.]{0,60}\b(?:previous|earlier|past|prior|preceding) " + _SEEN +
    r"|\b(?:previous|earlier|past|prior|preceding) " + _SEEN + r"[^.]{0,40}\b(?:were|was|remained) (?:shown|displayed|visible|presented)",
    re.I)
MATERIAL_FIELD = re.compile(r"instruction|debrief|briefing|item|question|prompt|stimul|scenario|vignette|scale|"
                            r"script|screen|message|text|wording|consent|cover", re.I)
DESIGNS = ("none", "last-trial", "summary", "same-screen", "full-log", "conversation", "other")
SCREEN_WORDS = re.compile(r"\b(?:same|one|single|a) (?:web ?)?(?:page|screen)\b|\ball (?:of )?(?:the )?(?:\w+ )?(?:items|questions)\b"
                          r"[^.]{0,60}\b(?:together|simultaneously|at once|on (?:one|a single|the same) (?:page|screen))"
                          r"|\b(?:items|questions) (?:were |was )?(?:presented|shown|displayed) (?:together|simultaneously|at once)",
                          re.I)
MAX_TERM_WORDS = 3
# a not-told sentence about someone other than the participants (blind experimenters, other studies)
OTHERS = re.compile(r"experimenters?|researchers?|raters?|coders?|assessors?|interviewers?|confederates?|"
                    r"investigators?|staff|clinicians?|blind to|double.blind|et al|(?:previous|prior|other|earlier) "
                    r"(?:studies|work|research)|animals?|rats?|mice|monkeys?", re.I)
FULL = ("full-log", "conversation")
CALL_CAP = 2500          # stand-in calls over all arms before the capture stops
ARM_CAP = 600            # per arm (every arm study.json or task.json names is run on its own)
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
        ref = REFERENCES.search(text or "")
        if ref and number > 1:   # the reference list: titles of other studies, not this one's procedure
            text = text[:ref.start()]
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
        if ref and number > 1:
            break
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
            long_terms = [t for t in terms if len(norm(t).split()) > MAX_TERM_WORDS]
            if long_terms:
                problems.append(("%s: terms are short phrases a leaking prompt would contain (at most %d words): %s"
                                 % (at, MAX_TERM_WORDS, ", ".join(repr(t) for t in long_terms[:3])),
                                 'split them: "red key", "pays more", not "they had to learn that the red key"'))
            if not str(e.get("withheld") or "").strip() or not terms:
                problems.append(("%s: needs `withheld` (what participants did not know) and `terms` (words a prompt "
                                 "that leaks it would contain)" % at,
                                 'or `notApplicable` with the reason when the sentence is not about participants'))
            elif not any(has_phrase(norm(e.get("statement")), norm(t)) and content_words(t) for t in terms):
                problems.append(("%s: no term is a content word of the printed statement (words like \"told\", "
                                 "\"participants\" or \"the\" do not count)" % at,
                                 "include the statement's own words for the withheld rule among the terms"))
            elif not any(content_words(t) & content_words(e.get("withheld")) for t in terms):
                problems.append(("%s: no term shares a word with `withheld`" % at,
                                 "the terms are the words of the withheld fact: a prompt that leaks it would contain them"))
    return entries, problems, has_field


def content_words(text):
    return {w for w in norm(text or "").split() if len(w) >= 3 and w not in STOP and w not in FRAME and not w.isdigit()}


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
    options += re.findall(r"[\"'\u201c\u2018]([a-z][a-z-]{1,15})[\"'\u201d\u2019]", tail)   # 'left' / "accept"
    options += [w for w in ("yes", "no") if re.search(r"\b%s\b" % w, tail, re.I)]
    return random.Random(len(tail)).choice(options) if options else "1"


def capture(pkg):
    """Run in a child process: record every prompt run_sessions sends. Prints one JSON line."""
    import importlib.util
    import time
    time.sleep = lambda *a, **k: None   # a pause between trials (rate limits, pacing) is not waited out
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

    def run(arms, cap, n=1):
        prompts = []

        def llm(prompt, *a, **k):
            if len(prompts) >= cap:
                raise _Stop()
            prompts.append(prompt if isinstance(prompt, str) else json.dumps(prompt, ensure_ascii=False))
            return _standin(prompts[-1])
        rec = {"arms": arms, "calls": 0, "sessions": None, "capped": False, "error": None}
        try:
            sessions = mod.run_sessions(llm, 20261102, n, arms=arms) if arms else mod.run_sessions(llm, 20261102, n)
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
        print("@@RUN@@" + json.dumps(rec, ensure_ascii=False), flush=True)   # kept if a later run hangs
        return rec

    names = arm_names(pkg, mod)
    # one participant per named arm (at least two) in the default call, then every named arm on its own:
    # an arm the default call never reaches is still read
    out["runs"].append(run(None, CALL_CAP, n=min(12, max(2, len(names)))))
    for arm in names[:12]:
        out["runs"].append(run([arm], ARM_CAP))
    print("@@CAPTURE@@" + json.dumps({"error": out["error"]}, ensure_ascii=False), flush=True)


def _names(value):
    """Arm names from a list of names or {id|arm|name} objects, or a mapping keyed by name."""
    if isinstance(value, dict):
        return [k for k, v in value.items() if not (isinstance(v, dict) and v.get("runnable") is False)]
    if isinstance(value, (list, tuple)):
        return [a if isinstance(a, str) else a.get("arm") or a.get("id") or a.get("name") for a in value
                if isinstance(a, str) or (isinstance(a, dict) and a.get("runnable", True))]
    return []


def arm_names(pkg, mod=None):
    """Every arm the package names: study.json runnableArms, task.json arms/conditions, the adapter's ARMS."""
    study = _json(pkg / "study.json") or {}
    task = _json(pkg / "task/task.json") or {}
    names = _names(study.get("runnableArms")) + _names(task.get("arms")) + _names(task.get("conditions"))
    for attr in ("RUNNABLE_ARMS", "ARMS", "RUNNABLE", "CONDITIONS"):
        names += _names(getattr(mod, attr, None))
    return [a for a in dict.fromkeys(names) if isinstance(a, str) and a]


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
    runs = []
    for l in run.stdout.splitlines():
        if l.startswith("@@RUN@@"):
            try:
                runs.append(json.loads(l[len("@@RUN@@"):]))
            except ValueError:
                pass
    if run.timed_out:
        return {"runs": runs, "error": "the adapter did not finish within %ds with a stand-in model" % timeout,
                "unfinished": True}
    line = next((l for l in run.stdout.splitlines()[::-1] if l.startswith("@@CAPTURE@@")), None)
    if line is None:
        return {"runs": runs, "error": "the adapter could not be run: " + (run.stderr or run.stdout)[-400:]}
    try:
        return dict(json.loads(line[len("@@CAPTURE@@"):]), runs=runs)
    except ValueError:
        return {"runs": runs, "error": "the prompt capture was cut off"}


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
            for k, x in v.items():
                if not PROVENANCE.search(str(k)):   # the paper's own sentences quoted as evidence are not prompts
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
    if len(t.split()) >= 2 and any(t in p for p in pieces):
        return ""   # one line of a verbatim passage the prompt wraps over several lines
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


def drops_participant(path):
    """[(line, code)] for all(...)/any(...) over the trials' parse status: one reply decides for the participant.

    Read: all(t["parsed"] ...), all(t["valid"] ...), all(t["choice"] is not None ...) and their any() forms,
    over the trials or assigned to a validity flag. Not read: asserts (a smoke test) and all(not ...) (every
    reply unparsed: the model does not answer the task at all)."""
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
    except (OSError, SyntaxError, ValueError):
        return []
    lines = source.splitlines()
    asserts = {id(n) for a in ast.walk(tree) if isinstance(a, ast.Assert) for n in ast.walk(a)}
    out = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("all", "any")
                and len(node.args) == 1 and isinstance(node.args[0], (ast.GeneratorExp, ast.ListComp, ast.SetComp))):
            continue
        arg = node.args[0]
        if id(node) in asserts or (isinstance(arg.elt, ast.UnaryOp) and isinstance(arg.elt.op, ast.Not)):
            continue
        status = ast.get_source_segment(source, arg.elt) or ""
        over = " ".join(ast.get_source_segment(source, g.iter) or "" for g in arg.generators)
        before = lines[node.lineno - 1][:node.col_offset]
        none_test = isinstance(arg.elt, ast.Compare) and any(isinstance(op, (ast.Is, ast.IsNot)) for op in arg.elt.ops) \
            and any(isinstance(c, ast.Constant) and c.value is None for c in arg.elt.comparators)
        if PARSE_STATUS.search(status) or (none_test and (TRIALS.search(over) or VALID_FLAG.search(before))):
            out.append((node.lineno, lines[node.lineno - 1].strip()))
    return sorted(set(out))


def excused(path, line_no, evidence):
    """A `# exclusion: <evidence id>` comment just above, citing a quote that states an exclusion rule."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return False
    for text in lines[max(0, line_no - 3):line_no]:
        m = EXCLUSION_MARK.search(text)
        quote = (evidence.get(m.group(1)) or {}).get("quote") or "" if m else ""
        if m and EXCLUSION_WORDS.search(quote) and EXCLUDED_WHO.search(quote):
            return quote
    return False


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
    issues_on = {(i.get("nodeId"), i.get("fieldId")) for i in program.get("issues") or [] if isinstance(i, dict)
                 and i.get("severity") in ("check", "decision")}
    not_applicable = 0
    for e in entries:
        if str(e.get("notApplicable") or "").strip():
            not_applicable += 1
            notes.append("%s marked not applicable: %s" % (e["_where"], str(e["notApplicable"])[:200]))
            node_id = e["_where"].split(".not-told", 1)[0]
            if not OTHERS.search(str(e.get("statement") or "")) and (node_id, "not-told") not in issues_on:
                add("%s: marked not applicable, but the statement is about the participants" % e["_where"],
                    "list what was withheld and its terms; if it truly does not limit what participants may be told, "
                    "add a `check` issue on this field (nodeId %s, fieldId not-told) saying why, so the researcher "
                    "confirms it" % node_id)
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
        if cap.get("unfinished"):
            add("%s: run_sessions must finish with a stand-in model (no network, sleeps skipped)" % cap["error"],
                "a loop that retries until the reply parses never ends with a model that does not comply: record "
                "the reply as unparsed and go on")
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
                'summary | same-screen | full-log | conversation | other", "shows": "...", "participantsSaw": "...", '
                '"expectedImpact": "..."}, "evidenceIds": [...]} and a decision issue; the default is what '
                'participants plausibly saw (a questionnaire whose items share a page: same-screen, so earlier '
                'items stay visible)')
        for n, f in memory:
            v = f.get("value") if isinstance(f.get("value"), dict) else {}
            where = "%s.replay-memory" % n.get("id")
            if v.get("design") not in DESIGNS:
                add("%s: value.design must be one of %s" % (where, ", ".join(DESIGNS)), "")
            for k in ("shows", "participantsSaw", "expectedImpact"):
                if not str(v.get(k) or "").strip():
                    add("%s: value.%s is empty" % (where, k), "say it in one sentence")
            researcher = f.get("origin") == "researcher"
            full = v.get("design") in FULL or (carries and v.get("design") == "other")
            quotes = [ev.get("quote") or "" for ev in program.get("evidence") or [] if isinstance(ev, dict)
                      and ev.get("id") in (f.get("evidenceIds") or [])]
            if full and not researcher and not any(HISTORY_WORDS.search(q) for q in quotes):
                add("%s: a prompt that carries every earlier trial (design %r) is not what participants saw unless "
                    "the paper says so" % (where, v.get("design")),
                    "default to what participants plausibly saw (the current screen, the last outcome, a counter "
                    "they saw), or cite the evidence that says participants saw their earlier trials (a quote about "
                    "their previous choices, history or record); a researcher may decide otherwise")
            if v.get("design") == "same-screen" and not researcher and not any(SCREEN_WORDS.search(q) for q in quotes):
                add("%s: design same-screen (earlier items stay visible) needs evidence that they were shown together"
                    % where, "cite the quote that says the items were on one page or screen (a questionnaire, a form)")
            if carries and v.get("design") not in FULL + ("other", "same-screen"):
                add("%s: design is %r but the prompts carry every earlier trial (%s)"
                    % (where, v.get("design"), "growing prompts" if growth else ", ".join(params)),
                    "make the adapter match the recorded design, or record the design it implements")
            if f.get("state") == "decision" and not any(i.get("nodeId") == n.get("id") and i.get("fieldId") == "replay-memory"
                                                        and i.get("severity") == "decision" for i in program.get("issues") or []):
                add("%s: a decision needs its decision issue (nodeId %s, fieldId replay-memory)" % (where, n.get("id")),
                    "state the expected impact in the issue so the researcher can choose")

        # unparsed replies
        evidence = {ev.get("id"): ev for ev in program.get("evidence") or [] if isinstance(ev, dict)}
        for rel in ("task/adapter.py", "evaluation/evaluation.py"):
            for line_no, code in drops_participant(pkg / rel):
                quote = excused(pkg / rel, line_no, evidence)
                if quote:
                    notes.append("%s:%d applies the paper's exclusion rule: \"%s\"" % (rel, line_no, quote[:200]))
                    continue
                add("%s:%d: one unparsed reply drops the whole participant (%s)" % (rel, line_no, code[:120]),
                    "record unparsed replies per trial (e.g. trial['parsed'] = False) and exclude trials or "
                    "participants only by the paper's own rule; when the paper prints that rule, put "
                    "`# exclusion: <evidence id>` on the line above (the quote must state the exclusion)")

    # missing instructions: one rule (blocking only when the adapter refuses to run without the text)
    runs_whole = any(r.get("calls") and not r.get("error") for r in runs)
    issues = [i for i in program.get("issues") or [] if isinstance(i, dict)]
    for n, f in _fields(program):
        if f.get("state") != "missing" or not INSTRUCTION.search("%s %s" % (f.get("id"), f.get("label"))):
            continue
        mine = [i for i in issues if i.get("nodeId") == n.get("id") and i.get("fieldId") in (f.get("id"), None, "")]
        if not any(i.get("severity") == "decision" or (i.get("severity") == "blocking" and not runs_whole) for i in mine):
            add("%s.%s: missing participant instructions have no `decision` issue" % (n.get("id"), f.get("id")),
                "add a decision issue on this field: the researcher supplies the printed text or accepts the "
                "stand-in wording the adapter uses (say which in suggestedAction)")
        for i in mine:
            if i.get("severity") == "check" or (i.get("severity") == "blocking" and runs_whole):
                add("%s: issue %s on missing participant instructions has severity %r" % (
                    "%s.%s" % (n.get("id"), f.get("id")), i.get("id"), i.get("severity")),
                    "missing instruction wording is a `decision` (the researcher supplies the printed text or accepts "
                    "the stand-in wording the adapter uses; say which in suggestedAction), or `blocking` only when the "
                    "adapter refuses to run without it (this one runs); never a `check`, and never written into a "
                    "verbatim field")
    return {"problems": problems, "notes": notes, "method": method, "notApplicable": not_applicable}


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
    na = report.get("notApplicable")
    print("PASS package validity" + (" (%d not-told entr%s marked not applicable: see the notes)"
                                     % (na, "y" if na == 1 else "ies") if na else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
