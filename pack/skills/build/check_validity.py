#!/usr/bin/env python3
"""Check that the runnable package replays what the original participants experienced.

    python .opencode/skills/build/check_validity.py .   [--package package/<slug>] [--json report.json]

check_package.py runs it; it must print PASS before the package can be marked ready. The checks:

  not told       every sentence of the paper saying participants were not told something, had to learn
                 or discover it, or were kept unaware of it is listed in a `not-told` field of
                 program.json (on the procedure node), and no prompt text the build wrote contains that
                 information (the entry's `terms`). Text transcribed verbatim from the paper's
                 participant materials (instructions, debriefing) is the participants' own text and is
                 not a leak.
  memory         a task that asks one participant many times and carries their earlier trials into
                 later prompts records that design as a `replay-memory` decision field; the default is
                 what participants plausibly saw, so a full trial log needs evidence that participants
                 saw one, or a researcher's decision. Read from the prompts in order: a prompt that says
                 earlier screens or answers are shown ("your earlier answers", "the previous screen", "the
                 screens above") must carry some of this participant's; a design that carries memory
                 (last-trial, summary, same-screen, full-log, conversation) must put something the
                 participant already saw or answered into a later prompt (`none` with its decision issue is
                 allowed); and no prompt shows an internal identifier: a condition or arm id (or an
                 id-like part of one), a survey question id (QID14), a screen or material id from
                 materials.json, a condition/variable/record/material node id of program.json. An id that
                 the participants' own materials print is text, not a leak.
  arms           every arm the package declares (study.json runnableArms, the adapter's ARMS ...) runs on its
                 own with arms=[id] for n = 1 (or 2 for pairs); an arm that cannot run yet refuses with a
                 clear error under a `blocking` issue or returns a session record marked blocked. A crash
                 (KeyError, TypeError, ...) is a problem. Names that only task.json gives are run, and their
                 errors are notes (task.json may name experiments or cells, not arm ids).
  screens        (prompt_context.py) a question with an answer key is asked with the instruction screens
                 before it in the program's flow, and a question asked round after round keeps the screens it
                 was asked with; the stand-in answers keys correctly so the run gets past a quiz. Declared
                 exceptions: materials.json screenMemory (repeats, notCarried) with evidence.
  identical arms an effect of effects.json whose treatment and reference arms send identical prompts in their
                 own stand-in runs is listed in a capabilities.json run.excluded entry's `effects` (with a
                 reason): a population difference is not a manipulation the replay can test.
  defaults       an answer that could not be read is never turned into a number in task/adapter.py
                 (`v if v is not None else 0`, `page.value(..) or 0`, `if v is None: v = 0`, where v holds
                 page.value(...)), in any task/*.py but the reader.
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

Older builds: the memory-claim, carried-memory and identifier rules of `memory`, the `arms` rule, and the screens,
identical-arms and defaults rules block only a
package built under the current contract (it carries task/replies.py, see contract.py); for an older package
they are printed as WARN lines and returned under "warnings", and the check still prints PASS.

Limits (heuristics, documented so nobody mistakes a PASS for proof):
  - The paper scan finds the usual phrasings ("were not told", "had to learn", "were unaware", "cover
    story", ...). A withheld fact phrased otherwise is found only if you list it yourself: do so.
  - A leak is found only when the prompt contains one of the entry's terms. Choose terms a leaking prompt
    would have to contain (the words of the withheld rule: "yellow", "can be selected", "upper circle");
    the terms must share a content word with `withheld`. The printed statement must be cited on its page.
    Entries marked `notApplicable` are printed with their reason. Words of other not-told
    sentences are printed as notes when build-written text contains them; read them.
  - Timing is not checked: verbatim text that reveals a rule later (a debriefing) is accepted anywhere.
  - The memory check reads prompt growth and the prompt function's parameters; a log passed in another
    way (a chat transcript) is found only by its growth.
  - "Carries" is read line by line on the first prompts of each run (numbers masked): a line kept from the
    previous prompt that is not in every prompt, or a new line holding a recent reply of the stand-in. A
    stimulus that happens to repeat looks like memory, so the rule catches adapters that never carry
    anything, not every gap. Identifiers are found only among the ids the package names.
Standard library plus the PDF reader check_quotes.py uses.
"""
import argparse
import ast
import hashlib
import json
import random
import re
import shutil
import sys
import time
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_quotes  # noqa: E402
import check_verbatim  # noqa: E402
import contract  # noqa: E402  older packages get the newer prompt rules as warnings
import prompt_context  # noqa: E402  instruction screens before keyed questions, rules in later rounds, identical arms
from check_replies import NONCE_ENV, child_nonce, marked, new_nonce  # noqa: E402  report lines carry a nonce

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
MATERIAL_METADATA = re.compile(r"^(?:licen[cs]e|copyright|numbering)(?:[_-]?.*)?$", re.I)
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
# plural or "all": the earlier trials, not the last one ("the outcome of the previous trial" is last-trial)
_SEEN = r"(?:choices|outcomes|trials|responses|rounds|decisions|selections|rewards|earnings|payoffs|results)"
HISTORY_WORDS = re.compile(
    r"\b(?:their|his|her|own|participants'?|subjects'?|the|all) (?:own )?(?:previous|earlier|past|prior|preceding) " + _SEEN +
    r"|\bhistory of (?:their |the |all )?(?:previous |past )?(?:choices?|outcomes?|trials?|responses?|rewards?)"
    r"|\b(?:choice|outcome|reward|trial|response|payoff) histor(?:y|ies)\b"
    r"|\ball (?:of )?(?:their|the) (?:previous |earlier |past )?" + _SEEN + r" (?:so far|were (?:shown|displayed|visible))"
    r"|\b(?:shown|displayed|visible|presented)\b[^.]{0,60}\b(?:previous|earlier|past|prior|preceding) " + _SEEN +
    r"|\b(?:previous|earlier|past|prior|preceding) " + _SEEN + r"[^.]{0,40}\b(?:were|remained) (?:shown|displayed|visible|presented)",
    re.I)
MATERIAL_FIELD = re.compile(r"instruction|debrief|briefing|item|question|prompt|stimul|scenario|vignette|scale|"
                            r"script|screen|message|text|wording|consent|cover", re.I)
DESIGNS = ("none", "last-trial", "summary", "same-screen", "full-log", "conversation", "other")
SCREEN_WORDS = re.compile(r"\b(?:same|one|single) (?:web ?)?(?:page|screen)\b|\ball (?:of )?(?:the )?(?:\w+ )?(?:items|questions)\b"
                          r"[^.]{0,60}\b(?:together|simultaneously|at once|on (?:one|a single|the same) (?:page|screen))"
                          r"|\b(?:items|questions) (?:were |was )?(?:presented|shown|displayed) (?:together|simultaneously|at once)",
                          re.I)
FORM_WORDS = re.compile(r"\b(?:items?|questions?|questionnaires?|survey|form|scales?|inventory)\b", re.I)
MAX_TERM_WORDS = 3
# a not-told sentence about someone other than the participants (blind experimenters, other studies)
OTHERS = re.compile(r"\b(?:experimenters?|researchers?|raters?|coders?|assessors?|interviewers?|confederates?|"
                    r"investigators?|staff|clinicians?|animals?|rats?|mice|monkeys?)\b", re.I)
FULL = ("full-log", "conversation")
CALL_CAP = 2500          # stand-in calls over all arms before the capture stops
ARM_CAP = 600            # per arm (every arm study.json or task.json names is run on its own)
MIN_TRIALS = 10          # calls per participant that make a task a repeated-trial task
SEQ_CAP = 60             # prompts per run kept in order for the memory rules
SEQ_CHARS = 400000       # and at most this many characters of them


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
            elif not any(content_words(t) & content_words(e.get("withheld")) for t in terms):
                problems.append(("%s: no term shares a word with `withheld`" % at,
                                 "the terms are the words of the withheld fact: a prompt that leaks it would contain them"))
    return entries, problems, has_field


def content_words(text):
    return {w for w in norm(text or "").split() if len(w) >= 3 and w not in STOP and w not in FRAME and not w.isdigit()}


def subject_of(statement):
    """The words just before the "were not told" phrase: whose knowledge the sentence is about."""
    text = re.sub(r"\s+", " ", str(statement or ""))
    m = next((m for pat in TRIGGERS for m in [pat.search(text)] if m), None)
    return " ".join(text[:m.start()].split()[-4:]) if m else text


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


def _exact_on_page(entry, pages):
    """The semantic-term exception needs the actual cited page, not a fuzzy or adjacent match."""
    page = entry.get("page")
    if not isinstance(page, int) or not 1 <= page <= len(pages):
        return False
    canonical = lambda text: " ".join(unicodedata.normalize("NFKC", text).split())
    stmt = canonical(str(entry.get("statement") or ""))
    return bool(stmt and stmt in canonical(pages[page - 1]))


# ---- the package: the prompts ----------------------------------------------------------------------

def _standin(prompt):
    """A reply that parses in most tasks: an option the prompt's last lines offer, else "1"."""
    tail = (prompt if isinstance(prompt, str) else json.dumps(prompt))[-300:]
    options = re.findall(r"\b([A-Z]{2,6}|[1-9])\b", tail)
    options += re.findall(r"[\"'\u201c\u2018]([a-z][a-z-]{1,15})[\"'\u201d\u2019]", tail)   # 'left' / "accept"
    options += [w for w in ("yes", "no") if re.search(r"\b%s\b" % w, tail, re.I)]
    return random.Random(len(tail)).choice(options) if options else "1"


def _keyed(question):
    return getattr(question, "key", None) is not None


def _keyed_answer(question):
    """What a participant who understood the instructions types for one question (replies.Question)."""
    kind = getattr(question, "kind", "choice")
    key = getattr(question, "key", None)
    codes = [str(c) for c in getattr(question, "codes", None) or []]
    if kind == "number":
        if key is not None:
            return str(key[0] if isinstance(key, (list, tuple)) and key else key)
        low = getattr(question, "minimum", None)
        return str(int(low) if isinstance(low, (int, float)) and float(low).is_integer() else (low if low is not None else 0))
    if kind == "text":
        return "No comment."
    if key is not None:
        try:
            picked = [codes[i] for i in question.key_indices()]
        except Exception:  # noqa: BLE001  an older Question: the key as written
            picked = [str(k) for k in (key if isinstance(key, (list, tuple)) else [key])]
        if picked:
            return ", ".join(picked)
    return codes[0] if codes else "1"


class StandIn:
    """The stand-in model of the prompt capture. As a plain callable it replies as _standin always did; replies.ask
    calls answer_for (with the questions), and a page with an answer key (a comprehension quiz) is answered
    correctly, so the run reaches what comes after the quiz. Pages without a key get the old reply."""

    def __init__(self, cap, prompts, replies, meta, table):
        self.cap, self.prompts, self.replies, self.meta, self.table = cap, prompts, replies, meta, table
        self.seen = {}   # prompt -> screens shown: a repeated screen is read once

    def _record(self, prompt, qids=(), keyed=False, texts=()):
        if len(self.prompts) >= self.cap:
            raise _Stop()
        text = prompt if isinstance(prompt, str) else json.dumps(prompt, ensure_ascii=False)
        self.prompts.append(text)
        if self.table and text not in self.seen and len(self.seen) < 5000:
            self.seen[text] = prompt_context.present(text, self.table)
        shown = (self.seen[text] if text in self.seen else prompt_context.present(text, self.table)) if self.table else []
        self.meta.append({"q": [str(q)[:120] for q in qids][:12], "k": keyed, "s": shown,
                          "t": [str(t)[:300] for t in texts][:12]})
        return text

    def __call__(self, prompt, *a, **k):
        text = self._record(prompt)
        self.replies.append(_standin(text))
        return self.replies[-1]

    def answer_for(self, prompt, questions, attempt=0, final=True):
        questions = list(questions or [])
        keyed = any(_keyed(q) for q in questions)
        # a question is the same question again only with the same id and the same text (a round, not a block)
        text = self._record(prompt, [_qkey(q) for q in questions], keyed,
                            [getattr(q, "text", "") or "" for q in questions])
        if not keyed:
            reply = _standin(text)
        elif len(questions) == 1:
            reply = _keyed_answer(questions[0])
        else:
            reply = "\n".join("Q%d: %s" % (n, _keyed_answer(q)) for n, q in enumerate(questions, 1))
        self.replies.append(reply)
        return reply


RUN_MARK = "@@RUN@@"
CAPTURE_MARK = "@@CAPTURE@@"


def capture(pkg, nonce=""):
    """Run in a child process: record every prompt run_sessions sends. Prints one `@@RUN@@<nonce>@@<json>` line
    per run and a closing `@@CAPTURE@@<nonce>@@<json>` line; the nonce is read (and removed from the
    environment) before the adapter is imported, so package code cannot print a line the parent trusts."""
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
        print(marked(CAPTURE_MARK, nonce, json.dumps(out)))
        return

    project = pkg.parent.parent
    table = {}
    try:
        table = prompt_context.probes(_json(project / "program.json") or {}, _json(pkg / "materials/materials.json") or {})
    except Exception:  # noqa: BLE001  no screens known: the screen rules have nothing to read
        table = {}

    def run(arms, cap, n=1, emit=True):
        prompts, replies, meta = [], [], []
        llm = StandIn(cap, prompts, replies, meta, table)
        rec = {"arms": list(arms or []), "calls": 0, "sessions": None, "capped": False, "error": None, "errorType": None, "n": n}
        try:
            sessions = mod.run_sessions(llm, 20261102, n, arms=arms) if arms else mod.run_sessions(llm, 20261102, n)
            rec["sessions"] = len(sessions) if isinstance(sessions, list) else None
        except _Stop:
            rec["capped"] = True
        except BaseException as exc:  # noqa: BLE001  a blocked study raises; keep what was sent
            rec["error"] = "%s: %s" % (type(exc).__name__, str(exc)[:300])
            rec["errorType"] = type(exc).__name__
        rec["calls"] = len(prompts)
        rec["calls_meta"] = meta
        rec["digest"] = prompt_context.digest(prompts)
        rec["lengths"] = [len(p) for p in prompts]
        # what the model relay is charged: the request body as humanstudy_llm encodes it (json.dumps, ASCII)
        rec["bodyChars"] = sum(len(json.dumps(p)) for p in prompts)
        lines = {}
        for p in prompts:   # distinct lines: a growing trial log adds one line per trial, not one copy per prompt
            for line in p.splitlines():
                if line.strip() and len(lines) < 50000:
                    lines.setdefault(line[:4000], None)
        rec["lines"] = list(lines)
        # the first prompts in order, with the stand-in's replies: what one participant carries from screen to screen
        seq, size = [], 0
        for p, r in zip(prompts[:SEQ_CAP], replies):
            size += len(p)
            if seq and size > SEQ_CHARS:
                break
            seq.append([p, r])
        rec["seq"] = seq
        if emit:
            # ASCII: a raw U+2028 or \x85 in a prompt would split the marker line
            print(marked(RUN_MARK, nonce, json.dumps(rec)), flush=True)   # kept if a later run hangs
        return rec

    names = arm_names(pkg, mod)
    # arms an effect contrasts first: only the first 12 named arms get a run of their own
    lookup = prompt_context.arm_lookup(_json(pkg / "task/task.json"), names)
    contrasted = {a for e in _obj(_json(project / "effects.json")).get("effects") or [] if isinstance(e, dict)
                  for k in ("treatment", "reference") if isinstance(_obj(e.get("contrast")).get(k), str)
                  for a in lookup.get(_obj(e.get("contrast"))[k].strip().casefold(), ())}
    names = sorted(names, key=lambda a: a not in contrasted)
    # one participant per named arm (at least two) in the default call, then every named arm on its own:
    # an arm the default call never reaches is still read
    out["runs"].append(run(None, CALL_CAP, n=min(12, max(2, len(names)))))
    # arm ids the package itself declares (task.json `arms`/`conditions` may name experiments or cells instead)
    declared = set(_names(_obj(_json(pkg / "study.json")).get("runnableArms")))
    for attr in ("RUNNABLE_ARMS", "ARMS", "RUNNABLE", "CONDITIONS"):
        declared |= {a for a in _names(getattr(mod, attr, None)) if isinstance(a, str)}
    for arm in names[:12]:
        rec = run([arm], ARM_CAP, emit=False)
        if rec["error"] and not rec["calls"]:   # a pair or group design needs an even n
            rec = run([arm], ARM_CAP, n=2, emit=False)
        rec["declared"] = arm in declared
        print(marked(RUN_MARK, nonce, json.dumps(rec)), flush=True)
        out["runs"].append(rec)
    print(marked(CAPTURE_MARK, nonce, json.dumps({"error": out["error"]}, ensure_ascii=False)), flush=True)


def _names(value):
    """Arm names (strings only) from a list of names or {id|arm|name} objects, or a mapping keyed by name."""
    if isinstance(value, dict):
        names = [k for k, v in value.items() if not (isinstance(v, dict) and v.get("runnable") is False)]
    elif isinstance(value, (list, tuple)):
        names = [a if isinstance(a, str) else a.get("arm") or a.get("id") or a.get("name") for a in value
                 if isinstance(a, str) or (isinstance(a, dict) and a.get("runnable", True))]
    else:
        return []
    return [n for n in names if isinstance(n, str) and n]


def _obj(value):
    return value if isinstance(value, dict) else {}


def arm_names(pkg, mod=None):
    """Every arm the package names: study.json runnableArms, task.json arms/conditions, the adapter's ARMS."""
    study = _obj(_json(pkg / "study.json"))
    task = _obj(_json(pkg / "task/task.json"))
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
        nonce = new_nonce()
        run = sandbox_run.run_python(Path(__file__).resolve(), ["--capture", str(copy)], cwd=copy, work=work,
                                     timeout=timeout, env={NONCE_ENV: nonce})
    return read_capture(run.stdout, nonce, run.timed_out, run.stderr, timeout)


def _run_record(rec):
    """A run record as capture() writes it, or None: a dict with list `arms` (strings) and list `lines`
    (strings); the other fields are kept only with their own types."""
    if not isinstance(rec, dict) or not isinstance(rec.get("arms"), list) or not isinstance(rec.get("lines"), list):
        return None
    if not all(isinstance(a, str) for a in rec["arms"]) or not all(isinstance(l, str) for l in rec["lines"]):
        return None
    out = dict(rec)
    for key, kind in (("calls", int), ("n", int), ("capped", bool), ("declared", bool)):
        if key in out and (not isinstance(out[key], kind) or (kind is int and isinstance(out[key], bool))):
            out[key] = kind()
    for key in ("error", "errorType"):
        if out.get(key) is not None and not isinstance(out[key], str):
            out[key] = str(out[key])
    for key in ("lengths",):
        out[key] = [x for x in out.get(key) or [] if isinstance(x, int)] if isinstance(out.get(key), list) else []
    out["digest"] = out["digest"] if isinstance(out.get("digest"), str) else None
    meta = out.get("calls_meta") if isinstance(out.get("calls_meta"), list) else []
    clean = lambda x: re.sub(r"[\x00-\x1f\x7f]", " ", x)[:160]   # ids are package text: printed in the report
    out["calls_meta"] = [{"q": [clean(q) for q in m.get("q") or [] if isinstance(q, str)][:12]
                          if isinstance(m.get("q"), list) else [],
                          "k": m.get("k") is True,
                          "s": [clean(x) for x in m.get("s") or [] if isinstance(x, str)][:200]
                          if isinstance(m.get("s"), list) else [],
                          "t": [str(x)[:300] for x in m.get("t") or [] if isinstance(x, str)][:12]
                          if isinstance(m.get("t"), list) else []}
                         for m in meta[:CALL_CAP + ARM_CAP] if isinstance(m, dict)]
    out["seq"] = [p for p in out.get("seq") or [] if isinstance(p, list) and len(p) == 2
                  and all(isinstance(x, str) for x in p)] if isinstance(out.get("seq"), list) else []
    return out


def read_capture(stdout, nonce, timed_out=False, stderr="", timeout=300):
    """The capture report from the child's stdout: only lines carrying this run's nonce, and only run records of
    the shape capture() writes. A marker line without the nonce (package code printing its own) is ignored."""
    run_head, capture_head = marked(RUN_MARK, nonce, ""), marked(CAPTURE_MARK, nonce, "")
    lines = (stdout or "").splitlines()
    runs = []
    for l in lines:
        if nonce and l.startswith(run_head):
            try:
                rec = _run_record(json.loads(l[len(run_head):]))
            except ValueError:
                rec = None
            if rec is not None:
                runs.append(rec)
    if timed_out:
        return {"runs": runs, "error": "the adapter did not finish within %ds with a stand-in model" % timeout,
                "unfinished": True}
    line = next((l for l in lines[::-1] if nonce and l.startswith(capture_head)), None)
    if line is None:
        return {"runs": runs, "error": "the adapter could not be run: " + (stderr or stdout or "")[-400:]}
    try:
        closing = json.loads(line[len(capture_head):])
    except ValueError:
        return {"runs": runs, "error": "the prompt capture was cut off"}
    error = closing.get("error") if isinstance(closing, dict) else "the prompt capture was not a record"
    return {"error": error if error is None or isinstance(error, str) else str(error), "runs": runs}


def _docstrings(tree):
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(getattr(first, "value", None), ast.Constant):
                out.add(id(first.value))
    return out


def static_texts(pkg):
    """String literals of the adapter and materials, excluding provenance and license metadata."""
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
                if not PROVENANCE.search(str(k)) and not MATERIAL_METADATA.match(str(k)):
                    walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    walk(_json(pkg / "materials/materials.json"))
    return texts


def participant_text(program, root=None):
    """Normalised pieces of verbatim participant materials (the participants' own text, not a leak), including the
    original materials the researcher supplied (sources/researcher/, see check_materials.py)."""
    pieces = []
    for n, f in _fields(program):
        m = (f.get("extensions") or {}).get("material") if isinstance(f.get("extensions"), dict) else None
        if root is not None and isinstance(m, dict) and m.get("kind") == "needs-original" and m.get("status") in (
                "supplied", "found-private"):
            import check_materials
            rel = str(m.get("file") or "")
            if check_materials.private_rel(rel) and (Path(root) / rel).is_file():
                pieces += [p for p in check_verbatim.segments(check_materials.text_of(Path(root) / rel))
                           if len(p.split()) >= 3]
            continue
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


# ---- the prompts in order: memory claims, carried screens, internal identifiers --------------------------

# The adapter says earlier screens or answers are in the prompt. "The question above" is the current screen.
CLAIM = re.compile(
    r"\b(?:your|the|my) (?:own )?(?:earlier|previous|preceding|past|prior) (?:screens?|pages?|answers?|responses?|"
    r"choices?|ratings?|decisions?|parts?|trials?|rounds?)\b"
    r"|\b(?:screens?|pages?|answers?|responses?|choices?|ratings?|decisions?) (?:that )?(?:you (?:have )?"
    r"(?:saw|seen|gave|given|answered|made|chose) |shown |given )?(?:above|earlier|before|so far)\b"
    r"|\b(?:what you (?:saw|answered|chose|said) (?:above|earlier|before))", re.I)
CARRYING = ("last-trial", "summary", "same-screen", "full-log", "conversation")
MIN_SEQ = 3              # prompts per participant before "carries nothing" is judged
ID_KEY = re.compile(r"(?i)(^id$|_id$|Id$|^qid$|^qsfid$|screenid|^qsftag$|^tag$)")
ID_SKIP = re.compile(r"(?i)(^id$|_id$|Id$|^qid$|^qsfid$|^key$|^ref$|^tag$|^qsftag$|pointer|^arm$|^arms$|^condition$|"
                     r"^conditions$|^cell$|^study$|^studies$|^source|path$|^evidence)")
QID = re.compile(r"(?<![A-Za-z0-9_])QID\d+(?![A-Za-z0-9_])")
# exceptions that are a bug in the adapter; any other (RuntimeError, FileNotFoundError, a NotReady class) is a refusal
CRASH = ("KeyError", "IndexError", "TypeError", "AttributeError", "NameError", "UnboundLocalError", "ZeroDivisionError",
         "StopIteration", "AssertionError", "ValueError", "JSONDecodeError", "RecursionError")


def _line_key(line):
    """A prompt line with numbers masked: trial 3 of the same screen is the same line as trial 2."""
    return re.sub(r"\d+", "#", re.sub(r"\s+", " ", line).strip())


def carried(seq):
    """For each prompt of one run in order: does it carry something this participant already saw or answered?
    A line carries when it was in the previous prompt too and is not in every prompt of the run (the fixed
    instructions); or when a line new since a recent prompt holds the reply given to it."""
    keys = [{_line_key(l) for l in p.splitlines() if l.strip()} for p, _ in seq]
    fixed = set.intersection(*keys) if keys else set()
    out = [False]
    for j in range(1, len(seq)):
        prompt = seq[j][0]
        hit = any(len(k) >= 8 and k not in fixed for k in keys[j] & keys[j - 1])
        for i in range(max(0, j - 3), j):
            reply = (seq[i][1] or "").strip()
            if hit or not reply or len(reply) > 40:
                continue
            token = re.compile(r"(?<![\w])" + re.escape(reply) + r"(?![\w])", re.I)
            hit = any(token.search(l) and _line_key(l) not in keys[i] and _line_key(l) not in fixed
                      for l in prompt.splitlines())
        out.append(hit)
    return out


def _per_participant(r):
    return r["calls"] / max(1, r.get("sessions") or r.get("n") or 1)


def _label(r):
    return "arm %s" % r["arms"][0] if r.get("arms") else "the default run"


def memory_claims(runs, pieces):
    """[(where, line)]: a prompt says earlier screens or answers are shown but carries none of them."""
    out = []
    for r in runs:
        seq = r.get("seq") or []
        flags = carried(seq)
        for j, (prompt, _) in enumerate(seq):
            if j == 0 or flags[j]:
                continue
            for line in prompt.splitlines():
                if CLAIM.search(authored(line, pieces)) and CLAIM.search(line):
                    out.append(("%s prompt %d" % (_label(r), j + 1), line.strip()[:160]))
                    break
            if len(out) >= 3:
                return out
    return out


def carries_nothing(runs):
    """Runs of one participant asked several times whose later prompts carry nothing they already saw."""
    return [_label(r) for r in runs if len(r.get("seq") or []) >= MIN_SEQ and _per_participant(r) >= MIN_SEQ
            and not any(carried(r["seq"])[1:])]


def _strings(value, skip=ID_SKIP):
    """Participant-facing strings of materials.json: identifier and provenance fields left out."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            if not skip.search(str(k)) and not PROVENANCE.search(str(k)):
                yield from _strings(v, skip)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v, skip)


def identifier_like(token):
    """An internal id, not a word: snake_case, dotted, camelCase, letters with digits, or a-hyphenated-tag."""
    if len(token) < 4 or not re.fullmatch(r"[A-Za-z0-9_.\-]+", token) or not re.search(r"[A-Za-z]", token):
        return False
    return bool(re.search(r"[_.]", token) or re.search(r"[a-z][A-Z]", token)
                or (re.search(r"\d", token) and re.search(r"[A-Za-z]{2,}", token))
                or re.fullmatch(r"[a-z]+(-[a-z0-9]+)+", token))


def material_ids(value):
    """Screen, question and tag ids of materials.json (values of id-like keys)."""
    found = set()
    if isinstance(value, dict):
        for k, v in value.items():
            if isinstance(v, str) and ID_KEY.search(str(k)):
                found.add(v)
            found |= material_ids(v)
    elif isinstance(value, list):
        for v in value:
            found |= material_ids(v)
    return found


def leaked_ids(pkg, program, runs):
    """{identifier: where}: condition, screen, question or variable ids in prompt text the participant reads.
    An id that is also text of the participants' materials (a word the screen prints) is not one."""
    materials = _json(pkg / "materials/materials.json")
    arms = list(dict.fromkeys(arm_names(pkg) + [a for r in runs for a in r.get("arms") or []]))
    candidates = set()
    for arm in arms:
        candidates.add(arm)
        candidates |= {part for part in re.split(r"[-_.:/\s]+", arm) if part}
    candidates |= material_ids(materials)
    candidates |= {n.get("id") for n in program.get("nodes") or [] if isinstance(n, dict) and isinstance(n.get("id"), str)
                   and n.get("kind") in ("condition", "variable", "record", "material", "materials")}
    visible = "\n".join(list(_strings(materials)) + [f.get("value") if isinstance(f.get("value"), str)
                                                     else json.dumps(f.get("value"), ensure_ascii=False)
                                                     for _, f in _fields(program) if f.get("origin") == "verbatim"])
    visible = visible.casefold()
    candidates = {c for c in candidates if isinstance(c, str) and identifier_like(c) and c.casefold() not in visible}
    pattern = re.compile(r"(?<![A-Za-z0-9_])(" + "|".join(re.escape(c) for c in sorted(candidates, key=len, reverse=True))
                         + r")(?![A-Za-z0-9_])", re.I) if candidates else None
    lookup = {c.casefold(): c for c in candidates}
    found = {}
    for r in runs:
        for line in r.get("lines") or []:
            for m in (pattern.finditer(line) if pattern else ()):
                found.setdefault(lookup.get(m.group(1).casefold(), m.group(1)), _label(r))
            for m in QID.finditer(line):
                if m.group(0).casefold() not in visible:
                    found.setdefault(m.group(0), _label(r))
    return found


def unread_defaults(path):
    """[(line, code)]: an answer that could not be read replaced by a number (`v if v is not None else 0`,
    `page.value("c") or 0`, `0 if v is None else v`, `if v is None: v = 0`, `answer.get("value", 0)`,
    `answer.get("value") or 0`), for an answer: page.value(...), page.answers[...], a parse(...)/ask(...) result,
    or a name assigned from one. The participant's missing reply would enter the data as a decision they never
    made."""
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
    except (OSError, SyntaxError, ValueError):
        return []
    lines = source.splitlines()
    number = lambda n: isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and not isinstance(n.value, bool)
    answers = set()

    def called(n):
        f = n.func if isinstance(n, ast.Call) else None
        name = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else ""
        return name

    def answer(n):
        """An expression that holds a participant's answer (or its value)."""
        for x in ast.walk(n):
            if isinstance(x, ast.Call) and called(x) in ("value", "ask", "parse", "parse_number", "parse_choice",
                                                          "parse_text"):
                return True
            if isinstance(x, ast.Attribute) and x.attr == "answers":
                return True
            if isinstance(x, ast.Name) and (x.id in answers or x.id == "answers"):
                return True
        return False

    for _ in range(3):                                   # names assigned from an answer, and from those
        answers |= {t.id for a in ast.walk(tree) if isinstance(a, ast.Assign) and answer(a.value)
                    for t in a.targets if isinstance(t, ast.Name)}
    is_none = lambda n, op: isinstance(n, ast.Compare) and len(n.ops) == 1 and isinstance(n.ops[0], op) \
        and answer(n.left) and isinstance(n.comparators[0], ast.Constant) and n.comparators[0].value is None
    value_get = lambda n: isinstance(n, ast.Call) and called(n) == "get" and n.args \
        and isinstance(n.args[0], ast.Constant) and n.args[0].value == "value" and answer(n.func.value)
    out = []
    for node in ast.walk(tree):
        hit = False
        if isinstance(node, ast.IfExp) and number(node.orelse) and is_none(node.test, ast.IsNot):
            hit = True                                    # v if v is not None else 0
        elif isinstance(node, ast.IfExp) and number(node.body) and is_none(node.test, ast.Is):
            hit = True                                    # 0 if v is None else v
        elif isinstance(node, ast.If) and is_none(node.test, ast.Is) and isinstance(node.test.left, ast.Name) and any(
                isinstance(b, ast.Assign) and number(b.value) and any(
                    isinstance(t, ast.Name) and t.id == node.test.left.id for t in b.targets) for b in node.body):
            hit = True                                    # if v is None: v = 0
        elif isinstance(node, ast.BoolOp) and isinstance(node.op, ast.Or) and number(node.values[-1]) \
                and any(answer(v) for v in node.values[:-1]):
            hit = True                                    # page.value("c") or 0, v or 0
        elif value_get(node) and len(node.args) > 1 and number(node.args[1]):
            hit = True                                    # page.answers["c"].get("value", 0)
        if hit:
            out.append((node.lineno, lines[node.lineno - 1].strip()))
    return sorted(set(out))


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


# ---- the analysis run: every runnable arm with a keyed stand-in, scored as the playground scores it ----------

PROBE_MARK = "@@PROBE@@"
PROBE_N = 10             # sessions per runnable arm, as a small playground run
PROBE_BIG_N = 40         # once more when an effect is still not computed at PROBE_N (too few, or a real fault?)
PROBE_TIMEOUT = 360      # the confined child (check_readiness.PACKAGE_TIMEOUT counts it)
PROBE_SOFT = 200         # seconds after which the child starts no further probe run
PROBE_ARMS = 24          # arms probed for memory, answer gates and unread answers (within PROBE_SOFT)
PROBE_QUESTIONS = 8      # questions per arm forced to each option or left unread
PROBE_OPTIONS = 6        # options tried per question
PROBE_ASKS = 1500        # asks per session in one probe run before it is stopped (an adapter recruiting forever)
PROBE_HARD = 300         # seconds after which every probe run is stopped where it is
UNREAD = "Hmm, I am not sure what to say here."
SHIPPED_REPLIES = Path(__file__).resolve().parent / "package_files" / "replies.py"
EFFECTS_CORE = Path(__file__).resolve().parent.parent / "export" / "agent"
# an effect block whose reason is an exception's text: the analysis crashed (a type error caught by the package)
CRASH_REASON = re.compile(r"\b[A-Z]\w*(?:Error|Exception)\b|unsupported operand|not subscriptable|"
                          r"has no attribute|object is not|invalid literal|could not convert|not supported between|"
                          r"must be (?:real number|str|int)|Traceback")
NO_KEY = re.compile(r"returned nothing for key|has no key|no effect_estimates entry")
NO_VARIANCE = re.compile(r"(?i)varian|variation|constant|all (?:the )?same|identical|singular|no spread|zero sd")
COMPLETED = ("completed", "complete")


def _qkey(q):
    """A question is the same question only with the same id and the same text (a round, not a block)."""
    return "%s#%s" % (getattr(q, "id", "?"), hashlib.sha1(
        str(getattr(q, "text", "")).encode("utf-8", "replace")).hexdigest()[:8])


def _qsum(q):
    return {"key": _qkey(q), "id": str(getattr(q, "id", "?"))[:80], "text": str(getattr(q, "text", "") or "")[:300],
            "kind": str(getattr(q, "kind", "choice")), "keyed": getattr(q, "key", None) is not None,
            "required": bool(getattr(q, "required", True)),
            "options": [str(o)[:80] for o in (getattr(q, "options", None) or [])][:12]}


class _Runaway(BaseException):
    """Ends a probe run that does not finish (raised through the adapter's own `except Exception`)."""


DEADLINE = [None]


class _Probe:
    """The keyed stand-in of the analysis run: the shipped replies.StubParticipant, answering every keyed question
    correctly, with each reply drawn from the prompt rather than from the call order, so two runs of one arm differ
    only where they are told to: `alt` {ask index: another draw}, `force` {question key: option index, for every ask
    of it}, `unread` {ask index: question key left unread on every attempt}, `unread_first` (a question key whose
    first ask stays unread). An ask is one replies.ask() call (its retries are the same ask)."""

    def __init__(self, replies, seed, alt=None, force=None, unread=None, unread_first=None, n=PROBE_N):
        self.limit = PROBE_ASKS * max(1, n)
        self.stub = replies.StubParticipant(seed, noise=0.0, use_keys=True)
        self.seed, self.alt, self.force = seed, dict(alt or {}), dict(force or {})
        self.unread, self.unread_first, self.first_at = dict(unread or {}), unread_first, None
        self.asks, self.log, self.prompts, self.replies, self.current = 0, [], [], [], -1
        self.seen = {}

    def _tick(self):
        if self.asks > self.limit:
            raise _Runaway("more than %d asks in one run of the arm" % self.limit)
        if DEADLINE[0] is not None and time.monotonic() > DEADLINE[0]:
            raise _Runaway("the analysis run's time ran out")

    def _draw(self, text, salt=""):
        """Seed the stub from the prompt and how often this prompt came before: participants who read the same
        screen still answer differently, and a run repeated with one change answers the same elsewhere."""
        seen = self.seen[text] = self.seen.get(text, 0) + 1
        h = hashlib.sha256(("%s\x00%s\x00%d\x00%s" % (self.seed, salt, seen, text)).encode("utf-8", "replace")).hexdigest()
        self.stub.rng = random.Random(int(h[:16], 16))

    def __call__(self, prompt, *a, **k):     # a direct llm(prompt) call (an adapter without replies.ask)
        text = prompt if isinstance(prompt, str) else json.dumps(prompt, ensure_ascii=False)
        self._tick()
        self.current = self.asks
        self.asks += 1
        self.prompts.append(text)
        self.log.append([])
        self._draw(text, "alt%s" % self.alt[self.current] if self.current in self.alt else "")
        reply = self.stub(text)
        self.replies.append(reply)
        return reply

    def answer_for(self, prompt, questions, attempt=0, final=True):
        originals = list(questions or [])
        questions = [self.stub._current(q) for q in originals]
        text = prompt if isinstance(prompt, str) else json.dumps(prompt, ensure_ascii=False)
        keys = [_qkey(q) for q in questions]
        if attempt == 0:
            self._tick()
            self.current = self.asks
            self.asks += 1
            self.prompts.append(text)
            self.log.append([_qsum(q) for q in originals])
            if self.unread_first in keys and self.first_at is None:
                self.first_at = self.current
        i = self.current
        unread = {self.unread[i]} if i in self.unread else set()
        if self.unread_first in keys and self.first_at == i:
            unread.add(self.unread_first)
        forced = {k: self.force[k] for k in keys if k in self.force}
        self._draw(text, "alt%s" % self.alt[i] if i in self.alt else "")
        if not unread and not forced:
            reply = self.stub.answer_for(text, questions, attempt=attempt, final=True)
        else:
            parts = []
            for n, (q, k) in enumerate(zip(questions, keys), 1):
                if k in unread:
                    parts.append(UNREAD if len(questions) == 1 else "not sure")
                elif k in forced and q.kind == "choice" and forced[k] < len(q.codes):
                    parts.append(q.codes[forced[k]])
                else:
                    parts.append(self.stub._one(q, self.stub._region(text, n, len(questions))))
            reply = parts[0] if len(parts) == 1 else "\n".join("Q%d: %s" % (n, x) for n, x in enumerate(parts, 1))
        if attempt == 0:
            self.replies.append(reply)
        return reply


class _Tracked(dict):
    """A session dict that remembers keys the analysis asked for and did not find (key drift: `fwd` read, `fwd4`
    written). Used only for the diagnosis, never for the verdict."""
    where = "session"
    misses = []

    def get(self, key, default=None):
        if not dict.__contains__(self, key):
            _Tracked.misses.append((self.where, str(key)))
        return dict.get(self, key, default)

    def __getitem__(self, key):
        if not dict.__contains__(self, key):
            _Tracked.misses.append((self.where, str(key)))
        return dict.__getitem__(self, key)


class _TrackedEvaluation(_Tracked):
    where = "evaluation"


def _wrap(value, cls=_Tracked):
    if isinstance(value, dict):
        return cls({k: _wrap(v, cls) for k, v in value.items()})
    if isinstance(value, list):
        return [_wrap(v, cls) for v in value]
    return value


def _keys(value, acc=None):
    acc = set() if acc is None else acc
    if isinstance(value, dict):
        for k, v in value.items():
            acc.add(str(k))
            _keys(v, acc)
    elif isinstance(value, (list, tuple)):
        for v in value:
            _keys(v, acc)
    return acc


def _statuses(sessions):
    out = {}
    for s in sessions or []:
        status = str(s.get("status")) if isinstance(s, dict) else "?"
        out[status] = out.get(status, 0) + 1
    return out


def _not_completed(sessions):
    return sum(1 for s in sessions or [] if not isinstance(s, dict) or s.get("status") not in COMPLETED)


def _people(session):
    """Participants one session record holds: a group game's record lists its members."""
    sizes = [len(v) for k, v in session.items() if isinstance(v, list) and re.fullmatch(
        r"(?i)members|participants|players|subjects|group(?:_members)?|agents", str(k))
        and v and all(isinstance(x, (dict, str)) for x in v)]
    return max(sizes + [1])


def _computed(block):
    v = block.get("value") if isinstance(block, dict) else None
    return isinstance(block, dict) and block.get("status") == "computed" and isinstance(v, (int, float)) \
        and not isinstance(v, bool) and v == v and abs(v) != float("inf")


def _load(path, name):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    if str(path.parent) not in sys.path:
        sys.path.insert(0, str(path.parent))
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _run(adapter, probe, seed, n, arm):
    try:
        got = adapter.run_sessions(probe, seed, n, arms=[arm]) if arm is not None else adapter.run_sessions(probe, seed, n)
    except _Runaway as exc:
        return None, "stopped: %s" % exc
    except Exception as exc:  # noqa: BLE001  the arm's own error: the smoke test and the arms rule report it
        return None, "%s: %s" % (type(exc).__name__, str(exc)[:300])
    return ([s for s in got if isinstance(s, dict)] if isinstance(got, list) else []), None


def _score(ec, module, effects, sessions):
    """(evaluation, {effect id: block}, error), exactly as study_core.result: evaluate(sessions), then
    effects_core.compute (op package: effect_estimates(evaluation)[compute.key])."""
    try:
        evaluation = module.evaluate(sessions)
    except Exception as exc:  # noqa: BLE001
        return None, {}, "evaluate() raised %s: %s" % (type(exc).__name__, str(exc)[:300])
    try:
        blocks = ec.compute(effects, sessions, evaluation, module)
    except Exception as exc:  # noqa: BLE001  effects_core catches only Key/Type/Value/ZeroDivision errors
        return evaluation, {}, "effect_estimates() raised %s: %s" % (type(exc).__name__, str(exc)[:300])
    return evaluation, {b.get("effectId"): b for b in blocks if isinstance(b, dict)}, None


def _counts(blocks, ids):
    """{effect id: n} of the computed blocks (n as the block reports it)."""
    out = {}
    for eid in ids:
        b = blocks.get(eid) or {}
        if _computed(b) and isinstance(b.get("n"), (int, float)) and not isinstance(b.get("n"), bool):
            out[eid] = b["n"]
    return out


def _diagnose(ec, module, effects, sessions):
    """Keys the analysis read and no session carries (with the keys that are close: drift), and keys
    effect_estimates read from evaluate()'s result that evaluate() does not return (a dropped `_sessions`)."""
    import difflib
    _Tracked.misses = []
    have = _keys(sessions)
    returned = set()
    try:
        wrapped = _wrap(sessions)
        evaluation = module.evaluate(wrapped)
        returned = _keys(evaluation)
        ec.compute(effects, wrapped, _wrap(evaluation, _TrackedEvaluation), module)
    except Exception:  # noqa: BLE001  a crash is reported from the plain run
        pass
    drift, dropped = {}, []
    for where, key in _Tracked.misses:
        if where == "session" and key not in have and len(key) >= 3 and key not in drift:
            near = {h for h in have if h != key and (h.startswith(key) or key.startswith(h)) and len(h) >= 3
                    and abs(len(h) - len(key)) <= 3}
            near |= set(difflib.get_close_matches(key, sorted(have), 3, 0.8))
            if near:
                drift[key] = sorted(near)[:4]
        elif where == "evaluation" and key not in returned and key not in dropped:
            dropped.append(key)
    return drift, dropped[:6]


def _blocks(prompts):
    """A block number per prompt: consecutive prompts that share a line (not one every prompt has) are one task."""
    keys = [{_line_key(l) for l in p.splitlines() if len(l.strip()) >= 20} for p in prompts]
    fixed = set.intersection(*keys) if keys else set()
    out, block = [], 0
    for k in range(len(prompts)):
        if k and not ((keys[k] & keys[k - 1]) - fixed):
            block += 1
        out.append(block)
    return out


def _scored(log):
    return [i for i, qs in enumerate(log) if any(q["kind"] != "text" and not q["keyed"] for q in qs)]


def _memory(adapter, replies, arm, seed, n, base):
    """Does anything a participant answered in one task reach the prompts of a later task? Each tested answer is
    redrawn (another option) and the run repeated: a later block's prompt that changes carries it."""
    prompts = base.prompts
    blocks = _blocks(prompts)
    scored = _scored(base.log)
    if len(prompts) < 4 or not blocks or blocks[-1] < 1 or not scored:
        return {"judged": False, "asks": len(prompts), "blocks": (blocks[-1] + 1) if blocks else 0}
    again = _Probe(replies, seed)
    _run(adapter, again, seed, n, arm)
    if again.prompts != prompts:      # an adapter that varies run to run cannot be compared with itself
        return {"judged": False, "asks": len(prompts), "reason": "the same run sent different prompts twice"}
    tests = []
    for j in dict.fromkeys(i for i in (scored[0], scored[len(scored) // 2]) if blocks[i] < blocks[-1]):
        test = None
        # a redrawn reply may say the same answer in other words: try a few, and stop at one a later task shows
        for salt in range(1, 7):
            alt = _Probe(replies, seed, alt={j: salt})
            _run(adapter, alt, seed, n, arm)
            if len(alt.replies) <= j or alt.replies[j] == base.replies[j]:
                continue
            other = alt.prompts
            changed = [k for k in range(j + 1, max(len(prompts), len(other)))
                       if k >= len(prompts) or k >= len(other) or prompts[k] != other[k]]
            later = [k for k in changed if k >= len(blocks) or blocks[k] > blocks[j]]
            if test is None or len(later) > test["laterBlocks"]:
                test = {"ask": j, "block": blocks[j], "changed": len(changed), "laterBlocks": len(later)}
            if later:
                break
        if test:
            tests.append(test)
    return {"judged": bool(tests), "asks": len(prompts), "blocks": blocks[-1] + 1, "tests": tests,
            "stateless": bool(tests) and all(t["laterBlocks"] == 0 for t in tests)}


def _probe(pkg, replies, ec):
    start = time.monotonic()
    DEADLINE[0] = start + PROBE_HARD
    late = lambda: time.monotonic() - start > PROBE_SOFT  # noqa: E731
    project = pkg.parent.parent
    task = _obj(_json(pkg / "task/task.json"))
    adapter = _load(pkg / "task/adapter.py", "hs_probe_adapter")
    module = _load(pkg / "evaluation/evaluation.py", "hs_probe_evaluation") \
        if (pkg / "evaluation/evaluation.py").is_file() else None
    arms = replies.runnable_arms(task)[0] or [None]
    try:
        table = prompt_context.probes(_json(project / "program.json") or {}, _json(pkg / "materials/materials.json") or {})
    except Exception:  # noqa: BLE001  no screens known: the check-stimulus rule has nothing to read
        table = {}
    out = {"arms": {}, "effects": {}, "memory": {}, "gates": [], "unreadOutcome": [], "groupDrop": [],
           "questions": {}, "notJudged": []}
    base, sessions_of = {}, {}
    for i, arm in enumerate(arms):
        seed = 20261106 + 101 * i
        probe = _Probe(replies, seed)
        got, err = _run(adapter, probe, seed, PROBE_N, arm)
        name = arm if arm is not None else "(all arms)"
        out["arms"][name] = {"error": err, "asks": probe.asks, "statuses": _statuses(got)}
        if err and err.startswith("stopped:"):
            out["notJudged"].append("arm %s (%s)" % (name, err))
        grouped = {tuple(sorted(q["text"][:160] for q in qs)) for qs in probe.log if len(qs) >= 2}
        out["arms"][name]["grouped"] = [list(g) for g in sorted(grouped)[:40]]
        out["arms"][name]["singles"] = sorted({qs[0]["text"][:160] for qs in probe.log if len(qs) == 1})[:300]
        out["arms"][name]["calls"] = [{"k": any(q["keyed"] for q in qs), "t": [q["text"][:200] for q in qs][:8],
                                       "s": prompt_context.present(prompt, table) if table else []}
                                      for prompt, qs in list(zip(probe.prompts, probe.log))[:150]]
        out["arms"][name]["summary"] = next((l.strip()[:200] for p in probe.prompts for l in p.splitlines()
                                             if SUMMARY_LINE.search(l)), None)
        base[name], sessions_of[name] = (probe, seed, arm), got or []
        for qs in probe.log:
            for q in qs:
                if len(out["questions"]) < 400:
                    out["questions"].setdefault(q["key"], q)
    sessions = [s for got in sessions_of.values() for s in got]
    effects = _json(project / "effects.json")
    listed = [e for e in (effects or {}).get("effects") or [] if isinstance(e, dict) and isinstance(e.get("id"), str)] \
        if isinstance(effects, dict) else []
    excluded = prompt_context.excluded_effects(_json(project / "capabilities.json"))
    out["excluded"] = sorted(excluded)
    live = [e["id"] for e in listed if e["id"] not in excluded]
    blocks = {}
    if listed and module is not None and sessions:
        evaluation, blocks, error = _score(ec, module, effects, sessions)
        out["effectsError"] = error
        try:
            returned = module.effect_estimates(evaluation) if hasattr(module, "effect_estimates") else {}
            out["keysReturned"] = sorted(map(str, returned or {}))[:80]
        except Exception:  # noqa: BLE001  effects_core reports it per effect (a crash), or _score did
            out["keysReturned"] = None
        for e in listed:
            comp = _obj(e.get("compute"))
            b = blocks.get(e["id"]) or {}
            fields = [comp.get(k) for k in ("field", "withField") if isinstance(comp.get(k), str)]
            out["effects"][e["id"]] = {
                "op": comp.get("op"), "key": comp.get("key"), "status": b.get("status"), "computed": _computed(b),
                "reason": str(b.get("reason") or "")[:300], "n": b.get("n"), "study": e.get("studyId"),
                "missingFields": [f for f in fields if not any(ec.field(s, f) is not None for s in sessions)]}
        bad = [eid for eid in live if not out["effects"][eid]["computed"]]
        if bad and not out.get("effectsError"):
            out["drift"], out["dropped"] = _diagnose(ec, module, effects, sessions)
            small = [eid for eid in bad if not CRASH_REASON.search(out["effects"][eid]["reason"])
                     and not NO_KEY.search(out["effects"][eid]["reason"])]
            if small and not late():
                more, cut = [], None
                for i, (name, (probe, seed, arm)) in enumerate(base.items()):
                    got, big_err = _run(adapter, _Probe(replies, seed + 7, n=PROBE_BIG_N), seed + 7, PROBE_BIG_N, arm)
                    more += got or []
                    if big_err and big_err.startswith("stopped"):
                        cut = big_err
                _, big, big_error = _score(ec, module, effects, more)
                big_error = cut or big_error
                out["bigN"] = PROBE_BIG_N
                out["bigStatuses"] = _statuses(more)
                for eid in small:
                    b = big.get(eid) or {}
                    out["effects"][eid]["big"] = {"computed": _computed(b),
                                                  "reason": str(big_error or b.get("reason") or "")[:300]}
            elif small:
                out["notJudged"].append("a run of %d sessions per arm (time)" % PROBE_BIG_N)
    # one arm at a time, one participant (or a pair): memory across tasks, answer gates, unread answers
    counted = _counts(blocks, live) if blocks else {}
    for i, (name, (probe, seed, arm)) in enumerate(list(base.items())[:PROBE_ARMS]):
        if late():
            out["notJudged"].append("arms after %s (time)" % name)
            break
        one_seed, n1 = seed + 1, 1
        one = _Probe(replies, one_seed)
        got, err = _run(adapter, one, one_seed, 1, arm)
        if err or not got:
            one, n1 = _Probe(replies, one_seed), 2
            got, err = _run(adapter, one, one_seed, 2, arm)
        if err or not one.asks:
            continue
        out["memory"][name] = _memory(adapter, replies, arm, one_seed, n1, one)
        asked = {}
        for qs in one.log:
            for q in qs:
                asked.setdefault(q["key"], q)
        # a question whose answer decides completed or excluded is a check: it needs key=
        for q in [q for q in asked.values() if q["kind"] == "choice" and not q["keyed"] and len(q["options"]) >= 2][
                :PROBE_QUESTIONS]:
            if late():
                break
            outcome = {}
            for k in range(min(len(q["options"]), PROBE_OPTIONS)):
                forced = _Probe(replies, one_seed, force={q["key"]: k})
                got_k, err_k = _run(adapter, forced, one_seed, n1, arm)
                if err_k or not got_k:
                    continue
                left = [s for s in got_k if s.get("status") not in COMPLETED]
                status = "completed" if not left else "%s%s" % (left[0].get("status"), (
                    " (%s)" % str(left[0].get("exclusion_reason"))[:120]) if left[0].get("exclusion_reason") else "")
                outcome.setdefault(status, []).append(q["options"][k])
                if "completed" in outcome and len(outcome) > 1:
                    break
            if "completed" in outcome and len(outcome) > 1:
                out["gates"].append({"arm": name, "id": q["id"], "text": q["text"], "outcome": outcome})
        # an optional answer the analysis uses: when it is unread, the session must not stay completed with no outcome
        if counted and sessions and not late():
            _, with_one, _ = _score(ec, module, effects, sessions + got)
            own = {eid: n - counted.get(eid, 0) for eid, n in _counts(with_one, live).items()}
            own = {eid: d for eid, d in own.items() if d > 0}
            for q in [q for q in asked.values() if not q["required"] and q["kind"] != "text"][:PROBE_QUESTIONS]:
                if not own or late():
                    break
                lost_probe = _Probe(replies, one_seed, unread_first=q["key"])
                got_q, err_q = _run(adapter, lost_probe, one_seed, n1, arm)
                if err_q or not got_q or _not_completed(got_q) > _not_completed(got):
                    continue
                _, with_q, _ = _score(ec, module, effects, sessions + got_q)
                mine = {eid: n - counted.get(eid, 0) for eid, n in _counts(with_q, live).items()}
                lost = sorted(eid for eid in own if mine.get(eid, 0) <= 0)
                if lost:
                    out["unreadOutcome"].append({"arm": name, "id": q["id"], "text": q["text"], "lost": lost,
                                                 "none": all(mine.get(eid, 0) <= 0 for eid in own)})
        # one unread reply in a multi-participant run: how many sessions stop being completed?
        group_probe = probe
        scored = _scored(group_probe.log)
        for m in dict.fromkeys(scored[len(scored) * k // 3] for k in (1, 2) if scored):
            if late():
                break
            q = next(q for q in group_probe.log[m] if q["kind"] != "text" and not q["keyed"])
            hit = _Probe(replies, seed, unread={m: q["key"]})
            got_m, err_m = _run(adapter, hit, seed, PROBE_N, arm)
            if err_m or got_m is None:
                continue
            was = sessions_of.get(name) or []
            newly = [s for k, s in enumerate(got_m) if s.get("status") not in COMPLETED
                     and (k >= len(was) or was[k].get("status") in COMPLETED)]
            # only a record that holds several people: separate records that change are other answers drawn after a
            # shorter session, not this reply's doing
            groups = [s for s in newly if _people(s) >= 2]
            people = sum(_people(s) for s in groups)
            if people >= 2:
                newly = groups
                out["groupDrop"].append({"arm": name, "id": q["id"], "text": q["text"], "sessions": len(newly),
                                         "people": people, "statuses": _statuses(got_m)})
                break
    out["seconds"] = round(time.monotonic() - start, 1)
    return out


def _probe_child(pkg, nonce):
    """In the confined child: the analysis run on the package copy; one marker line."""
    import contextlib
    import importlib.util
    import io
    import os
    import time
    time.sleep = lambda *a, **k: None
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("humanstudy_replies_shipped", SHIPPED_REPLIES)
    replies = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = replies
    spec.loader.exec_module(replies)
    sys.path.insert(0, str(EFFECTS_CORE))
    import effects_core as ec
    here = str(Path(__file__).resolve().parent)
    while here in sys.path:   # the package imports its own siblings, never a checker module
        sys.path.remove(here)
    sys.path.remove(str(EFFECTS_CORE))
    os.chdir(pkg)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            report = _probe(pkg, replies, ec)
    except BaseException as exc:  # noqa: BLE001  an import error in the package is a finding, not a crash
        report = {"error": "%s: %s" % (type(exc).__name__, str(exc)[:300])}
    print(marked(PROBE_MARK, nonce, json.dumps(report, default=str, ensure_ascii=True)), flush=True)


def _project_copy(pkg, work, root=None):
    """A copy of the package at work/project/package/<slug> with what the format puts beside program.json (from the
    project root the check was given, else the package's grandparent)."""
    from check_package import BESIDE_PROGRAM
    copy = work / "project" / "package" / pkg.name
    sandbox_run_mod().copy_tree(pkg, copy, ignore=shutil.ignore_patterns("__pycache__", ".git"))
    project = Path(root) if root is not None else pkg.parent.parent
    if (root is not None or pkg.parent.name == "package") and (project / "program.json").is_file():
        for f in project.iterdir():  # only what the project format puts beside program.json
            if f.is_file() and not f.is_symlink() and (f.name in BESIDE_PROGRAM or f.suffix.lower() == ".pdf"):
                shutil.copy2(f, work / "project" / f.name)
        if (project / "sources").is_dir() and not (project / "sources").is_symlink():
            sandbox_run_mod().copy_tree(project / "sources", work / "project" / "sources")
    return copy


def sandbox_run_mod():
    import sandbox_run
    return sandbox_run


def probe_of(pkg, timeout=PROBE_TIMEOUT, root=None):
    """The analysis run of the package, confined (sandbox_run.py): its report, or {"error": ...}."""
    from check_replies import read_marked
    with sandbox_run_mod().work_dir(prefix="check-analysis-") as work:
        copy = _project_copy(pkg, work, root)
        nonce = new_nonce()
        run = sandbox_run_mod().run_python(Path(__file__).resolve(), ["--probe", str(copy)], cwd=copy, work=work,
                                           timeout=timeout, env={NONCE_ENV: nonce})
    if run.timed_out:
        return {"error": "the analysis run did not finish within %d s" % timeout, "timedOut": True}
    report, forged = read_marked(run.stdout, PROBE_MARK, nonce)
    if forged:
        return {"error": "the analysis run's report cannot be trusted: " + forged}
    if not isinstance(report, dict):
        return {"error": "the analysis run could not be run: " + ((run.stderr or run.stdout or "").strip()[-400:]
                                                                  or "no output")}
    return report


# ---- rules on the analysis run and on the prompts as sent (batch-2 reviews) ---------------------------------

# Qualtrics and Word export text that is never part of a participant's screen
EXPORT_MARKS = re.compile(r"\b(?:Start|End) of Block\b|^\s*Page Break\s*$|\$\{[^}\n]{1,120}\}|\bDefault Question Block\b|"
                          r"</?w:[A-Za-z]+|<(?:div|span|br|p|strong|em|font|img|table|tr|td|ul|li)\b[^>]*>|&nbsp;",
                          re.I | re.M)
CHECK_TEXT = re.compile(r"(?i)comprehension (?:question|check|test)|attention check|paying attention|"
                        r"recall (?:question|check|test)|manipulation check|"
                        r"which of the following (?:was|were|is|did|happened)|was not mentioned|were not mentioned|"
                        r"according to the (?:story|scenario|text|vignette|passage|description)\b.{0,80}\?|"
                        r"what (?:did|was|were) .{0,60}\b(?:in|from) the (?:story|scenario|text|vignette|passage)")
ATTENTION_TEXT = re.compile(r"(?i)attention check|paying attention|to (?:show|indicate|confirm|prove) (?:that )?you(?:'re| are)"
                            r" (?:reading|attentive|paying)|this is an attention|comprehension (?:question|check)|"
                            r"manipulation check|please (?:select|choose|click|pick|type|enter|write) (?:the (?:word|number|"
                            r"option|answer) )?[\"'“‘]")
STIMULUS_NAME = re.compile(r"(?i)vignette|scenario|stimul|\bstor(?:y|ies)\b|passage|article|case description|reading text")
SUMMARY_LINE = re.compile(r"(?i)\b(?:your|the) (?:own )?(?:answers?|choices?|decisions?|responses?|selections?) (?:so far|until now|"
                          r"up to now|(?:on|from) (?:the )?(?:previous|earlier) (?:pages?|days?|screens?|questions?))"
                          r"|\byou (?:have )?(?:chose|chosen|answered|selected|picked|decided) .{0,40}\b(?:so far|previously)")
WITHIN_TEXT = re.compile(r"(?i)within[- ](?:subjects?|participants?|persons?)|repeated[- ]measures?|"
                         r"(?:each|every|all) participants? (?:completed|answered|did|rated|read|faced|saw|went through|"
                         r"took part in) (?:all|each|both|every)\b")
WITHIN_SESSION = re.compile(r"(?i)(?:each|every|all) participants? (?:completed|answered|did|rated|read|faced|saw|went through|"
                            r"took part in) (?:all|each of|every one of) (?:the )?(?:\w+ ){0,2}(?:scenarios|vignettes|"
                            r"studies|experiments|tasks|stories|problems)|(?:scenario|vignette|story|study) order "
                            r"(?:was |were )?(?:randomi[sz]ed|random|counterbalanced)|order of the (?:\w+ )?(?:scenarios|"
                            r"vignettes|studies|experiments|stories|problems) (?:was |were )?(?:randomi[sz]ed|random|"
                            r"counterbalanced)|all (?:\w+ ){0,2}(?:studies|scenarios|vignettes) in (?:one|a single) "
                            r"(?:session|survey)")
SPLIT_TEXT = re.compile(r"(?i)\bone (?:scenario|vignette|study|story|task|problem) (?:per|for each) (?:ai )?"
                        r"(?:participant|agent|session)")
TEXTY = {"text", "te", "open", "open-ended", "open ended", "free", "free text", "freetext", "essay", "string", "textentry",
         "text entry", "text_entry", "short answer"}
CHOICEY = {"choice", "mc", "multi", "multiple", "multiple choice", "radio", "select", "single", "dropdown", "checkbox",
           "multi-select", "single choice"}
NUMBERY = {"number", "numeric", "integer", "float", "slider", "number entry", "numeric entry"}


def _within_effect(e):
    con = _obj(e.get("contrast"))
    return e.get("design") in ("within", "correlational") or con.get("kind") in ("association", "paired")


def _association(e):
    con, comp = _obj(e.get("contrast")), _obj(e.get("compute"))
    return e.get("design") == "within" and (con.get("kind") == "association" or comp.get("op") == "correlation")


def _design_texts(program):
    return [str(f.get("value")) for n, f in _fields(program) if n.get("kind") == "design"
            and isinstance(f.get("value"), str)]


def _ids(listed, limit=8):
    listed = list(listed)
    return ", ".join(listed[:limit]) + (" and %d more" % (len(listed) - limit) if len(listed) > limit else "")


def _arm_statuses(probe):
    return "; ".join("%s: %s" % (arm, ", ".join("%d %s" % (n, s) for s, n in sorted((r.get("statuses") or {}).items()))
                                 or "no sessions")
                     for arm, r in list((probe.get("arms") or {}).items())[:8])


def effect_rules(root, pkg, probe, newer, warn, notes):
    """effects.json: every effect not listed in capabilities.json run.excluded[].effects computes a number on the
    analysis run (10 keyed stand-in sessions per runnable arm, evaluate() then effects_core.compute, as the
    playground does). Returns the summary line."""
    effects = _json(root / "effects.json")
    if not isinstance(effects, dict):
        return None
    if probe.get("error"):
        (newer if probe.get("timedOut") else warn)("the analysis run could not judge the effects: %s" % probe["error"],
             "make `run_sessions` and `evaluate` run offline with the stand-in (python check_validity.py . shows it)")
        return None
    results = probe.get("effects") or {}
    excluded = set(probe.get("excluded") or [])
    live = [eid for eid in results if eid not in excluded]
    ran = [a for a, r in (probe.get("arms") or {}).items() if not r.get("error") and (r.get("statuses") or {})]
    completed = sum((r.get("statuses") or {}).get(s, 0) for r in (probe.get("arms") or {}).values() for s in COMPLETED)
    sessions = "(analysis run, %d keyed stand-in sessions per arm: %s)" % (PROBE_N, _arm_statuses(probe))
    if not (pkg / "evaluation/evaluation.py").is_file():
        return None
    if results and not live and ran:
        newer("no effect of effects.json is computed from the arms the package runs (%s): all %d effects are listed in "
              "capabilities.json run.excluded" % (", ".join(ran[:8]), len(results)),
              "write the effects of the studies the replay runs (the paper's tests of those arms, with their reported "
              "numbers), or leave those arms out of the package; an export with no computable effect has nothing to "
              "compare")
    elif ran and results:
        effects_list = [e for e in effects.get("effects") or [] if isinstance(e, dict)]
        task = _obj(_json(pkg / "task/task.json"))
        studies = {c.get("study") for c in _obj_list(task.get("conditions")) if c.get("id") in ran and c.get("study")}
        covered = {e.get("studyId") for e in effects_list if e.get("id") in live}
        idle = sorted(s for s in studies if isinstance(s, str) and s not in covered)
        if idle and any(e.get("studyId") for e in effects_list):
            warn("studies %s run (task.json conditions) but no effect of effects.json that is not excluded belongs to "
                 "them" % ", ".join(idle[:6]),
                 "add the paper's tests of these studies to effects.json, or say in the report why they have none")
    if probe.get("effectsError"):
        newer("the analysis cannot score the replay: %s %s" % (probe["effectsError"], sessions),
              "fix evaluation/evaluation.py so evaluate(sessions) and effect_estimates(evaluate(sessions)) run on the "
              "sessions run_sessions returns (the playground calls them exactly so)")
        return "analysis run: evaluate() failed"
    crash, nokey, field, small_ok, stub, other, unjudged = [], [], [], [], [], [], []
    stopped = [a for a, r in (probe.get("arms") or {}).items() if str(r.get("error") or "").startswith("stopped")]
    for eid in live:
        r = results[eid]
        if r.get("computed"):
            continue
        reason = r.get("reason") or ""
        big = r.get("big") or {}
        if CRASH_REASON.search(reason) or CRASH_REASON.search(big.get("reason") or ""):
            crash.append((eid, reason or big.get("reason")))
        elif NO_KEY.search(reason):
            nokey.append((eid, r.get("key")))
        elif r.get("missingFields"):
            field.append((eid, r["missingFields"]))
        elif big.get("computed"):
            small_ok.append(eid)
        elif NO_VARIANCE.search(big.get("reason") or reason):
            stub.append((eid, big.get("reason") or reason))
        elif probe.get("drift") or probe.get("dropped"):
            other.append((eid, reason))
        elif not big or str(big.get("reason") or "").startswith("stopped") or stopped:
            unjudged.append(eid)
        else:
            other.append((eid, big.get("reason") or reason))
    if crash:
        reasons = sorted({x for _, x in crash})
        newer("%d effect(s) never compute because the analysis crashes: %s; e.g. \"%s\" %s"
              % (len(crash), _ids(e for e, _ in crash), reasons[0][:200], sessions),
              "the evaluation must turn the recorded answers into numbers itself: a choice answer is the option's label "
              "(replies Page.value), so map it to the scale's code before averaging; then rerun check_package.py")
    if nokey:
        returned = probe.get("keysReturned")
        newer("%d effect(s) name a compute.key that effect_estimates() does not return: %s%s"
              % (len(nokey), _ids("%s (key %r)" % kv for kv in nokey),
                 "; it returns %s" % _ids(returned or [], 10) if returned is not None else ""),
              "make effects.json compute.key and evaluation.effect_estimates() use the same names")
    if field:
        newer("%d effect(s) read session fields no session carries: %s" % (len(field), _ids(
            "%s (%s)" % (e, ", ".join(f)) for e, f in field)),
              "make effects.json compute.field name the field run_sessions writes (a dotted path into the session)")
    if other:
        cause = []
        for key, near in sorted((probe.get("drift") or {}).items()):
            cause.append("the analysis reads %r, which no session carries (the sessions have %s)"
                         % (key, ", ".join(repr(x) for x in near)))
        for key in probe.get("dropped") or []:
            cause.append("effect_estimates() reads evaluation[%r], which evaluate() does not return" % key)
        if cause:
            newer("%d effect(s) never compute: %s; %s"
                  % (len(other), _ids(e for e, _ in other), "; ".join(cause[:4])),
                  "use one name for each answer in task/adapter.py and evaluation/evaluation.py, and return from "
                  "evaluate() everything effect_estimates() reads; a key mismatch looks like \"too few participants\"")
        else:
            newer("%d effect(s) do not compute even with %d keyed stand-in sessions per arm: %s; e.g. \"%s\" %s"
                  % (len(other), probe.get("bigN") or PROBE_N, _ids(e for e, _ in other), other[0][1][:200], sessions),
                  "find why the analysis gets no data for them (an exclusion every session hits, a check without its "
                  "key=, an arm that never completes); or list them in capabilities.json run.excluded[].effects with "
                  "the reason they cannot be computed by the replay")
    if stub:
        warn("%d effect(s) compute no value on the stand-in run because the answers do not vary (%s; e.g. \"%s\"); the "
             "stand-in cannot tell whether real replies would" % (len(stub), _ids(e for e, _ in stub), stub[0][1][:160]),
             "check that a model's free-text or numeric answer is read and scored as the paper scores it")
    if unjudged:
        notes.append("analysis run: %s not computed with %d sessions per arm, and the larger run did not finish "
                     "(time or a stopped arm): not judged" % (_ids(unjudged), PROBE_N))
    if small_ok:
        notes.append("analysis run: %s compute only with %d sessions per arm (10 were too few)"
                     % (_ids(small_ok), probe.get("bigN") or PROBE_N))
    for item in probe.get("notJudged") or []:
        notes.append("analysis run: not judged: %s" % item)
    done = sum(1 for eid in live if results[eid].get("computed") or results[eid].get("big", {}).get("computed"))
    return "%d of %d effects compute (%d excluded by capabilities.json; %d completed stand-in sessions)" % (
        done, len(live), len(results) - len(live), completed)


def _obj_list(value):
    if isinstance(value, dict):
        value = [dict(v, id=k) if isinstance(v, dict) else {"id": k} for k, v in value.items()]
    return [v for v in value or [] if isinstance(v, dict)] if isinstance(value, list) else []


def unread_rules(probe, newer, warn):
    """One unread reply never ends several sessions (a group); an optional answer the analysis uses never leaves a
    completed session without its outcome; a choice that decides completed or excluded is keyed."""
    for g in probe.get("groupDrop") or []:
        newer("arm %s: one unread reply (to %s \"%s\") removed %d participants (%d session record(s)), not only the "
              "participant who gave it (%s)"
              % (g["arm"], g["id"], g["text"][:100], g.get("people", g["sessions"]), g["sessions"],
                 ", ".join("%d %s" % (n, s) for s, n in sorted(g["statuses"].items()))),
              "an unparsed reply is recorded on its trial and the participant is kept (build SKILL.md, unparsed "
              "replies): the group plays on with what the original screen showed for a missing decision; drop people or "
              "groups only by the paper's own rule (a timeout dropout is not an unread reply), with `# exclusion:`")
    fix = ("an answer the analysis needs is required (its loss ends the session as `unparsed`, so the loss is "
           "counted and reported), or the session records it as unparsed and evaluate() reports how many were lost")
    by_arm = {}
    for u in probe.get("unreadOutcome") or []:
        by_arm.setdefault((u["arm"], bool(u["none"])), []).append(u)
    for (arm, none), found in sorted(by_arm.items(), key=lambda kv: (not kv[0][1], kv[0][0])):
        if not none:
            continue
        lost = sorted({e for u in found for e in u["lost"]})
        newer("arm %s: when one answer to %s (required=False) is unread, the session stays `completed` but counts in no "
              "effect at all: a completed session with no outcome (%s)"
              % (arm, "; ".join("%s \"%s\"" % (u["id"], u["text"][:80]) for u in found[:3])
                 + (" and %d more" % (len(found) - 3) if len(found) > 3 else ""), _ids(lost, 6)), fix)
    partial = [(arm, found) for (arm, none), found in sorted(by_arm.items()) if not none]
    if partial:   # the session still counts elsewhere: a loss to report, not a broken record
        arm, found = partial[0]
        warn("when one optional answer (required=False) is unread, the session stays `completed` but drops out of "
             "effects that use it, in %d arm(s) (%s); e.g. arm %s: %s \"%s\" (%s)"
             % (len(partial), _ids((a for a, _ in partial), 6), arm, found[0]["id"], found[0]["text"][:80],
                _ids(sorted({e for u in found for e in u["lost"]}), 6)), fix)
    for g in probe.get("gates") or []:
        outcome = g.get("outcome") or {}
        other = "; ".join("%s -> %s" % (" / ".join(v[:3]), k) for k, v in outcome.items() if k != "completed")
        newer("arm %s: question %s \"%s\" decides whether a session is completed (%s) or not (%s), but it is asked "
              "without key=" % (g["arm"], g["id"], g["text"][:120], " / ".join(outcome.get("completed", [])[:3]), other),
              "a comprehension, attention, consent or screening question is asked with key= (the correct option); the "
              "keyed stand-in then passes it as an attentive participant would, and the smoke test shows every gate is "
              "passable")


def asymmetric_any(path):
    """[(line, code)]: an any()/all() over answers that settles as True while some answers are unread, but needs every
    answer read to settle as False (`if any(v == "Yes" for v in vals): return True` then `return None if any(v is None
    for v in vals) else False`): unread answers then drop "no" sayers and keep "yes" sayers."""
    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
    except (OSError, SyntaxError, ValueError):
        return []
    lines = source.splitlines()

    def over(call):
        """(iterable name, elt) of any(... for v in NAME) / all(...), or None."""
        if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id in ("any", "all")
                and len(call.args) == 1 and isinstance(call.args[0], (ast.GeneratorExp, ast.ListComp))):
            return None
        gen = call.args[0]
        if len(gen.generators) != 1 or not isinstance(gen.generators[0].iter, ast.Name):
            return None
        return gen.generators[0].iter.id, gen.elt, call.func.id

    def none_test(elt):
        return isinstance(elt, ast.Compare) and any(isinstance(op, (ast.Is, ast.IsNot)) for op in elt.ops) \
            and any(isinstance(c, ast.Constant) and c.value is None for c in elt.comparators)

    def value_test(elt):
        return isinstance(elt, ast.Compare) and any(isinstance(op, (ast.Eq, ast.NotEq, ast.In, ast.NotIn)) for op in elt.ops) \
            and not none_test(elt)

    out = []
    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        settles, waits = {}, {}
        for node in ast.walk(fn):
            if isinstance(node, ast.If):
                got = over(node.test)
                if got and got[2] == "any" and value_test(got[1]) and any(isinstance(b, ast.Return) for b in node.body):
                    settles.setdefault(got[0], node.lineno)
            if isinstance(node, ast.IfExp):
                got = over(node.test)
                yields_none = any(isinstance(x, ast.Constant) and x.value is None for x in (node.body, node.orelse))
                if got and none_test(got[1]) and yields_none:
                    waits.setdefault(got[0], node.lineno)
                if got and got[2] == "any" and value_test(got[1]) and isinstance(node.body, ast.Constant) \
                        and isinstance(node.orelse, ast.IfExp):
                    settles.setdefault(got[0], node.lineno)
            if isinstance(node, ast.If):
                got = over(node.test)
                if got and none_test(got[1]) and any(isinstance(b, ast.Return) and isinstance(b.value, ast.Constant)
                                                     and b.value.value is None for b in node.body):
                    waits.setdefault(got[0], node.lineno)
        for name, line in settles.items():
            if name in waits and line <= waits[name]:
                out.append((line, lines[line - 1].strip()))
    return sorted(set(out))


def static_unread_rules(pkg, warn):
    for rel in ("task/adapter.py", "evaluation/evaluation.py"):
        for line_no, code in asymmetric_any(pkg / rel):
            warn("%s:%d: an any()/all() over answers keeps a result when some answers are unread but needs every answer "
                 "read for the other result (%s): unread replies then remove one kind of answer more than the other"
                 % (rel, line_no, code[:120]),
                 "treat an unread answer the same way whatever the others say: the aggregate is unread (None) whenever "
                 "an answer it needs is unread, or count only read answers in both directions; report how many were "
                 "unread")


def prompt_text_rules(root, pkg, program, runs, pieces, newer, warn):
    """Export markup in a prompt as sent, condition or hypothesis names, and build-written prose that materials.json
    does not hold."""
    marks = {}
    for r in runs:
        for line in r.get("lines") or []:
            m = EXPORT_MARKS.search(line)
            if m:
                marks.setdefault(m.group(0).strip()[:40], (_label(r), line.strip()[:160]))
    if marks:
        newer("prompts as sent carry survey or Word export text no participant saw: " + "; ".join(
            "%r in %s (\"%s\")" % (k, w, l) for k, (w, l) in list(marks.items())[:5]),
              "build each screen from its text (docx_text.py for Word, qsf_flow.py for Qualtrics), never from export "
              "lines: block markers (\"Start of Block\"), page breaks, piped-text codes (${...}) and markup are not "
              "screen text; check the consent and first screens of the dumped prompts")
    materials = _json(pkg / "materials/materials.json")
    visible = " ".join(norm(t) for t in _strings(materials))
    visible += " " + " ".join(pieces)
    names = {}
    task = _obj(_json(pkg / "task/task.json"))
    for c in _obj_list(task.get("conditions")):
        if isinstance(c.get("title"), str):
            names[c["title"]] = "condition title"
    for n in program.get("nodes") or []:
        if isinstance(n, dict) and n.get("kind") in ("condition", "hypothesis") and isinstance(n.get("title"), str):
            names[n["title"]] = "%s title" % n["kind"]
    effects = _obj(_json(root / "effects.json"))
    for h in effects.get("hypotheses") or []:
        if isinstance(h, dict) and isinstance(h.get("label"), str):
            names[h["label"]] = "hypothesis label"
    leaks = []
    lines = "\n".join(norm(l) for r in runs for l in r.get("lines") or [])
    for name, what in names.items():
        nn = norm(name)
        if len(nn.split()) >= 3 and nn not in visible and has_phrase(lines, nn):
            leaks.append("%s %r" % (what, name))
    if leaks:
        newer("prompts name the design the participant must not know: " + "; ".join(leaks[:5]),
              "never show condition, arm or hypothesis names; a participant must not read their condition from the "
              "prompt")
    # build-written prose sent to participants: in an adapter string literal, not in materials.json
    try:
        tree = ast.parse((pkg / "task/adapter.py").read_text(encoding="utf-8"))
        skip = _docstrings(tree)
        literals = [norm(n.value) for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)
                    and id(n) not in skip and len(n.value.split()) >= 10]
    except (OSError, SyntaxError, ValueError):
        literals = []
    stand_ins = " ".join(norm(t) for k, v in _obj(materials).items() if re.search(r"(?i)stand.?in", str(k))
                         for t in _strings(v))
    asked = {norm(t) for r in runs for c in r.get("calls_meta") or [] for t in c.get("t") or []}
    asked = " \n ".join(a for a in asked if a)
    written = {}
    for r in runs:
        for line in r.get("lines") or []:
            nl = norm(line)
            if len(nl.split()) < 10 or nl in visible or nl in stand_ins or nl in asked:
                continue
            rest = authored(line, pieces)
            if len([w for w in rest.split() if w != "|"]) < 10:
                continue
            if any(nl in lit for lit in literals):
                written.setdefault(line.strip()[:160], _label(r))
    if written:
        warn("prompts carry build-written prose that materials/materials.json does not hold or label as a stand-in: "
             + "; ".join("\"%s\" (%s)" % kv for kv in list(written.items())[:3])
             + (" and %d more" % (len(written) - 3) if len(written) > 3 else ""),
             "use the printed screen text; when no source prints it, put the wording in materials.json `standIns` "
             "with a decision issue so the researcher sees it, and never claim it is what the screen showed")


def check_rules(program, materials, probe, newer):
    """A comprehension, attention or recall question is not answered with the stimulus it tests on screen again,
    unless a cited source says the stimulus stayed visible (materials.json screenMemory.repeats). Read from the
    analysis run (each arm on its own, every check answered as an attentive participant would)."""
    table = prompt_context.screens(program)
    names = {n.get("id"): "%s %s" % (n.get("id"), n.get("title") or "") for n in program.get("nodes") or []
             if isinstance(n, dict)}
    stimuli = {s for s, v in table.items() if not v.get("instruction") and STIMULUS_NAME.search(names.get(s, ""))}
    if not stimuli:
        return
    declared = {d["screen"] for d in prompt_context.declarations(materials)["repeats"]}
    gates = {norm(g.get("text") or "") for g in probe.get("gates") or []}
    found = {}
    for arm, r in (probe.get("arms") or {}).items():
        seen = set()
        for i, c in enumerate(r.get("calls") or []):
            texts = c.get("t") or []
            shown = set(c.get("s") or [])
            if c.get("k") or any(CHECK_TEXT.search(t) for t in texts) or any(norm(t) in gates for t in texts):
                for s in sorted((shown & stimuli & seen) - declared):
                    found.setdefault(s, ("arm %s ask %d" % (arm, i + 1), (texts or ["?"])[0][:100]))
            seen |= shown
    if found:
        newer("a check question is answered with the stimulus it tests on screen again (the participant read it "
              "earlier and answers from memory unless a source says it stayed visible): " + "; ".join(
                  "%s shown with \"%s\" (%s)" % (s, q, w) for s, (w, q) in list(found.items())[:4]),
              "send the comprehension, attention or recall question without the stimulus text; only when a cited source "
              "says the text stayed on screen, declare it in materials/materials.json screenMemory.repeats with its "
              "evidenceIds")


def summary_rules(probe, pieces, newer):
    """A running list of the participant's earlier answers must not undo a manipulation of how many decisions are
    visible at once: one arm asks a set of questions on one screen, another asks them one per screen and shows "your
    answers so far" (read from the analysis run, every arm on its own)."""
    arms = probe.get("arms") or {}
    found = []
    for arm, r in arms.items():
        summary = r.get("summary")
        if not summary or not authored(summary, pieces).strip(" |"):
            continue   # the original screens printed it: it is what the humans saw
        singles = {norm(t) for t in r.get("singles") or [] if norm(t)}
        for other, o in arms.items():
            if other != arm and any(len({norm(t) for t in g} & singles) >= 2 for g in o.get("grouped") or []):
                found.append((arm, summary[:100], other))
                break
    if found:
        newer("a running summary of earlier answers works against the manipulation: " + "; ".join(
            "arm %s shows \"%s\" while arm %s presents the same questions on one screen, so the summary hands the "
            "one-at-a-time arm what its screens withhold" % f for f in found[:3]),
              "carry only what that condition's screens showed (the original said \"in the previous page you "
              "indicated...\" only where it did); conditions that differ by how many decisions are visible at once must "
              "keep that difference in the prompts")


def question_rules(pkg, probe, newer, warn):
    """An attention or comprehension check is keyed; the adapter asks a question as the kind its material declares."""
    gates = {g.get("id") for g in probe.get("gates") or []}
    questions = list((probe.get("questions") or {}).values())
    loose = [q for q in questions if not q.get("keyed") and q.get("id") not in gates
             and ATTENTION_TEXT.search(q.get("text") or "")]
    if loose:
        warn("questions read like an attention or comprehension check but are asked without key=: " + "; ".join(
            "%s \"%s\"" % (q["id"], q["text"][:100]) for q in loose[:4]),
             "give key= the answer the original survey required (the check passes for an attentive participant); if the "
             "question is not a check, ignore this")
    materials = _json(pkg / "materials/materials.json")
    declared = []

    def walk(v):
        if isinstance(v, dict):
            kind = next((str(v[k]).strip().lower() for k in ("type", "kind", "questionType", "qtype", "response")
                         if isinstance(v.get(k), str)), None)
            text = v.get("text") if isinstance(v.get("text"), str) else None
            if kind and text and len(norm(text).split()) >= 5:
                declared.append((kind, norm(text), v.get("tag") or v.get("id") or v.get("qid")))
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
    walk(materials)
    if not declared:
        return
    adaptations = norm(json.dumps([_obj(materials).get("replayAdaptations"),
                                   _obj(_json(pkg / "task/task.json")).get("replayAdaptations"),
                                   _obj(_json(pkg / "study.json")).get("replayAdaptations")], ensure_ascii=False))
    group = lambda k: "text" if k in TEXTY else "choice" if k in CHOICEY else "number" if k in NUMBERY else None  # noqa
    wrong = []
    for kind, text, tag in declared:
        want = group(kind)
        if want is None:
            continue
        for q in questions:
            asked = q.get("kind")
            qt = norm(q.get("text") or "")
            if not qt or text not in qt:
                continue
            if want == asked or (want == "number" and asked == "choice"):
                continue
            if want == "text" and len(text) < 0.8 * len(qt):
                continue   # a "text" display block quoted inside a longer question's stem is not that question
            if tag and norm(str(tag)) and has_phrase(adaptations, norm(str(tag))):
                continue
            wrong.append((tag or q.get("id"), kind, asked, q.get("text", "")[:90]))
            break
    if wrong:
        newer("the adapter asks questions as another kind than materials.json declares: " + "; ".join(
            "%s declared %s, asked as %s (\"%s\")" % w for w in wrong[:4]),
              "ask each question as the screen asked it (a \"type the word\" box is free text, read and scored as the "
              "survey scored it); a change of question type is a replay adaptation: record it in replayAdaptations "
              "naming the question, with its likely effect")


def memory_rules(root, pkg, program, probe, newer):
    """Within-person outcomes need what the participant carried from task to task, or the researcher's decision."""
    effects = _obj(_json(root / "effects.json"))
    excluded = set(probe.get("excluded") or [])
    live = [e for e in effects.get("effects") or [] if isinstance(e, dict) and e.get("id") not in excluded]
    stateless = {a: m for a, m in (probe.get("memory") or {}).items() if m.get("stateless")}
    memory = [(n, f) for n, f in _fields(program) if f.get("id") == "replay-memory"]
    none = [n.get("id") for n, f in memory if _obj(f.get("value")).get("design") == "none"]
    decided = any(f.get("origin") == "researcher" for _, f in memory) or any(
        isinstance(i, dict) and i.get("fieldId") == "replay-memory" and i.get("severity") == "blocking"
        for i in program.get("issues") or [])
    texts = _design_texts(program)
    within_text = [t for t in texts if WITHIN_TEXT.search(t) or WITHIN_SESSION.search(t)]
    asks = max([m.get("asks") or 0 for m in (probe.get("memory") or {}).values()] + [0])
    evidence = "; ".join("arm %s: %d prompts in %d tasks, a redrawn answer changed no prompt of a later task"
                         % (a, m.get("asks"), m.get("blocks")) for a, m in list(stateless.items())[:3])
    assoc = [e["id"] for e in live if _association(e)]
    if stateless and assoc:
        newer("effects %s are associations between answers one participant gave on separately prompted tasks, but each "
              "task is a fresh call that carries nothing of the participant's earlier tasks (%s): the association is "
              "set by construction, not by the participant" % (_ids(assoc), evidence),
              "give each participant what the humans carried from task to task (one conversation, or their earlier "
              "screens and answers as the memory design records them), or list these effects in capabilities.json "
              "run.excluded[].effects with that reason")
        return
    within = [e["id"] for e in live if _within_effect(e)]
    if (within or within_text) and (stateless or (none and asks >= 2)) and not decided:
        newer("the outcomes are within-person (%s) but the replay gives a participant no memory across screens (%s); "
              "that is recorded only as a non-blocking decision" % (
                  "effects " + _ids(within, 5) if within else "design: \"%s\"" % within_text[0][:120],
                  evidence or "replay-memory design 'none' on %s" % ", ".join(none[:4])),
              "carry what the participants carried (their earlier screens and answers, or one conversation), or make "
              "the replay-memory issue `blocking` so the researcher decides before anything runs (or record the "
              "researcher's choice, origin `researcher`), stating the expected effect on these outcomes")


def split_rules(root, pkg, program, newer):
    """One human who did several scenarios or studies is one agent, not one agent per scenario."""
    task = _obj(_json(pkg / "task/task.json"))
    conditions = [c for c in _obj_list(task.get("conditions")) if c.get("status") != "blocked"]
    studies = {c.get("study") for c in conditions if c.get("study")}
    if len(studies) < 2:
        return
    texts = _design_texts(program)
    said = next((t for t in texts if WITHIN_SESSION.search(t)), None)
    adaptations = task.get("replayAdaptations")
    declared = next((t for t in [task.get("agents")] + (adaptations if isinstance(adaptations, list) else [])
                     if isinstance(t, str) and SPLIT_TEXT.search(t)), None)
    if not (said or declared):
        return
    caps = _json(root / "capabilities.json")
    excluded = prompt_context.excluded_effects(caps)
    effects = _obj(_json(root / "effects.json"))
    split_effects = [e.get("id") for e in effects.get("effects") or [] if isinstance(e, dict)
                     and e.get("studyId") in studies and e.get("id") not in excluded]
    if said and split_effects:
        newer("each participant took part in several of the studies or scenarios (\"%s\"), but every AI participant "
              "answers one (%d conditions over %d studies); effects %s still compare with humans who did them all%s"
              % (said[:140], len(conditions), len(studies), _ids(split_effects, 6),
                 " (the package says so: \"%s\")" % declared[:100] if declared else ""),
              "run one AI participant through the sequence a human saw (the survey's order and randomisation, with "
              "what they carried), or list every affected effect in capabilities.json run.excluded[].effects with that "
              "reason (and record the paper's first-answered estimates where it prints them)")
        return True
    return False


# ---- the check -------------------------------------------------------------------------------------

def screen_rules(root, pkg, program, runs, newer):
    """Keyed questions and later rounds carry the instruction screens; effects never contrast identical arms."""
    materials = _json(pkg / "materials/materials.json") or {}
    table = prompt_context.screens(program)
    skip = {d["screen"] for d in prompt_context.declarations(materials)["notCarried"]}
    for msg, fix in prompt_context.declaration_problems(materials, program):
        newer(msg, fix)
    own = [r for r in runs if r.get("arms")]
    read = own or runs   # each arm from its own run: a screen of another arm never counts
    # notCarried waives later rounds only: a quiz comes right after its instructions, which the human had just read
    keyed = [g for r in read for g in prompt_context.keyed_gaps(r, table)]
    if keyed:
        newer("questions with an answer key are asked without the instructions they test (each model call has no "
              "memory, so the participant model has not read them): "
              + "; ".join("%s (%s) lacks %s" % (", ".join(q[:4]) + (" ..." if len(q) > 4 else ""), where, ", ".join(need))
                          for where, q, need in keyed[:prompt_context.MAX_FINDINGS]),
              "put this participant's own earlier instruction screens (the material text as printed) into the prompt "
              "of every keyed question (a quiz, a check), as the memory design carries them; or, when the paper "
              "shows the rule text again on that screen, repeat it and declare it in materials/materials.json "
              "screenMemory.repeats with its evidence")
    rounds = [g for r in read for g in prompt_context.round_gaps(r, table, skip)]
    if rounds:
        newer("a repeated question loses the instruction screens it was asked with before (a later round or part "
              "does not restate the rules): "
              + "; ".join("'%s' (%s) is asked without %s" % (q, where, ", ".join(dropped))
                          for where, q, dropped in rounds[:prompt_context.MAX_FINDINGS]),
              "carry the earlier instruction screens into every later round of the same participant (part 1's rules "
              "stay in part 2's prompts); only when the paper says the rules were no longer visible, declare "
              "materials/materials.json screenMemory.notCarried with its evidence")
    # only runs that finished: two runs stopped at the call cap may share a prefix and differ later (a debriefing
    # that comes in session 4)
    digests = {r["arms"][0]: r["digest"] for r in own if len(r["arms"]) == 1 and r.get("digest")
               and r.get("calls") and not r.get("error") and not r.get("capped")}
    effects = _json(root / "effects.json")
    if isinstance(effects, dict) and len(digests) >= 2:
        excluded = prompt_context.excluded_effects(_json(root / "capabilities.json"))
        same = prompt_context.identical_contrasts(effects, _json(pkg / "task/task.json"), digests, excluded)
        if same:
            newer("effects contrast arms whose prompts are identical, so the replay cannot produce a difference "
                  "between them: " + "; ".join("%s (%s vs %s)" % (eid, "/".join(t), "/".join(r)) for eid, t, r in same[:8])
                  + (" and %d more" % (len(same) - 8) if len(same) > 8 else ""),
                  "when the arms differ only by sample, site, country or population, list these effects in a "
                  "capabilities.json run.excluded entry {\"what\": ..., \"reason\": \"population difference, not a "
                  "manipulation\", \"effects\": [...]} (without `arms`, so each arm's own effects still run); or give "
                  "the arms the persona or population difference the paper reports, written into the prompt")


def check(root, package=None, capture_prompts=True):
    root = Path(root).resolve()
    program = _json(root / "program.json")
    if not isinstance(program, dict):
        return {"problems": [("program.json is missing or not JSON", "")], "notes": [], "method": None,
                "warnings": []}
    problems, notes, warnings = [], [], []
    add = lambda msg, fix="": problems.append((msg, fix))
    pkg = _package(root, package)
    # The rules added with the shared reply reader block only packages built under that contract (contract.py);
    # a package built before it gets them as warnings, so a project that was ready stays ready.
    current = contract.current_contract(pkg)
    newer = add if current else (lambda msg, fix="": warnings.append((msg, fix)))
    paper = _paper(root, program)
    pages = check_quotes.Pdf(paper).load() if paper and paper.suffix.lower() == ".pdf" else []
    # a scanned PDF loads as empty pages: judge the whole document, so citing a blank page cannot skip a rule
    has_text = sum(len(norm(p or "")) for p in pages) >= 40

    # not-told field and inventory
    entries, bad, has_field = inventory(program)
    problems += bad
    if not has_field:
        add("program.json has no `not-told` field: what the paper says participants were not told is not recorded",
            'add to the procedure node a field {"id": "not-told", "label": "What participants were not told", '
            '"origin": "reported", "state": "confirmed", "value": [...], "evidenceIds": [...]} ([] when the paper '
            'says nothing was withheld)')
    issues_on = {}
    for i in program.get("issues") or []:
        if isinstance(i, dict) and i.get("severity") in ("check", "decision"):
            key = (i.get("nodeId"), i.get("fieldId"))
            issues_on[key] = issues_on.get(key, 0) + 1
    need = {}   # notApplicable entries about the participants, per node: one check issue each
    not_applicable = 0
    for e in entries:
        if str(e.get("notApplicable") or "").strip():
            not_applicable += 1
            notes.append("%s marked not applicable: %s" % (e["_where"], str(e["notApplicable"])[:200]))
            node_id = e["_where"].split(".not-told", 1)[0]
            if not OTHERS.search(subject_of(e.get("statement"))):
                need[node_id] = need.get(node_id, 0) + 1
            if need.get(node_id, 0) > issues_on.get((node_id, "not-told"), 0):
                add("%s: marked not applicable, but the statement is about the participants" % e["_where"],
                    "list what was withheld and its terms; if it truly does not limit what participants may be told, "
                    "add a `check` issue on this field (nodeId %s, fieldId not-told) saying why, so the researcher "
                    "confirms it" % node_id)
        if not _on_page(e, pages):
            add("%s: the statement is not on p. %s" % (e["_where"], e.get("page")),
                "copy the sentence as printed and cite the page it is on")
        if not str(e.get("notApplicable") or "").strip():
            terms = [t for t in e.get("terms") or [] if isinstance(t, str)]
            uses_statement = any(has_phrase(norm(e.get("statement") or ""), norm(t)) and
                                 content_words(t) & content_words(e.get("withheld")) for t in terms)
            # Without a text layer nothing can be compared (as in _on_page). The rule came after the shared reply
            # reader contract, so an older package gets it as a warning and a ready project stays ready.
            if terms and not uses_statement and has_text and not _exact_on_page(e, pages):
                newer("%s: semantic terms require the exact statement on the cited page" % e["_where"],
                    "copy the printed statement and cite its page, or include a content term from the statement")
    for hit in statements(pages):
        if not _covered(hit, entries):
            add("p. %d says \"...%s...\" but no not-told entry lists it" % (hit[0], hit[2][:220]),
                "add an entry with the printed statement, what was withheld and the terms a leaking prompt would "
                "contain; or `notApplicable` with the reason when it is not about what participants knew")

    # prompts
    method, runs, texts, arm_refused, analysis = None, [], [], False, None
    if pkg is None:
        notes.append("no package/<slug>/task/adapter.py: prompts not checked")
    else:
        cap = prompts_of(pkg) if capture_prompts else {"runs": [], "error": "capture off"}
        runs = [r for r in cap.get("runs") or [] if r.get("calls")]
        arm_refused = any(r.get("error") and r.get("arms") for r in cap.get("runs") or [])
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
        pieces = participant_text(program, root)
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
        per_participant = max([r["calls"] / max(1, r.get("sessions") or r.get("n") or 1) for r in runs] or [0])
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
            if v.get("design") == "same-screen" and not researcher and not any(
                    SCREEN_WORDS.search(q) and FORM_WORDS.search(q) for q in quotes):
                add("%s: design same-screen (earlier items stay visible) needs evidence that they were shown together"
                    % where, "cite the quote that says the questionnaire's items were on one page or shown together; a trial "
                    "task is not a questionnaire")
            if carries and v.get("design") not in FULL + ("other", "same-screen"):
                add("%s: design is %r but the prompts carry every earlier trial (%s)"
                    % (where, v.get("design"), "growing prompts" if growth else ", ".join(params)),
                    "make the adapter match the recorded design, or record the design it implements")
            if f.get("state") == "decision" and not any(i.get("nodeId") == n.get("id") and i.get("fieldId") == "replay-memory"
                                                        and i.get("severity") == "decision" for i in program.get("issues") or []):
                add("%s: a decision needs its decision issue (nodeId %s, fieldId replay-memory)" % (where, n.get("id")),
                    "state the expected impact in the issue so the researcher can choose")

        # what the prompts claim and carry, and what they must not show (read only from prompts actually sent)
        if runs:
            shown = pieces + [p for t in _strings(_json(pkg / "materials/materials.json"))
                              for p in check_verbatim.segments(t) if len(p.split()) >= 3]
            claims = memory_claims(runs, sorted(set(shown), key=len, reverse=True))
            if claims:
                newer("prompts say earlier screens or answers are shown but carry none of this participant's earlier "
                    "screens or answers: " + "; ".join("%s (\"%s\")" % c for c in claims),
                    "send what the line promises (this participant's own earlier screens and answers) or remove "
                    "the claim; never refer to screens the prompt does not contain")
            designs = {(f.get("value") or {}).get("design") for _, f in memory if isinstance(f.get("value"), dict)}
            if designs & set(CARRYING):
                empty = carries_nothing(runs)
                if empty:
                    newer("replay-memory design %s carries memory, but no later prompt of %s carries anything the "
                        "participant already saw or answered" % ("/".join(sorted(designs & set(CARRYING))),
                                                                  ", ".join(empty[:4])),
                        "make the adapter put what the design says into each later prompt of the same participant "
                        "(the last outcome, the summary, the items already on the page, the earlier screens and "
                        "answers), or record design `none` with its decision issue")
            leaked = leaked_ids(pkg, program, runs)
            if leaked:
                listed = sorted(leaked.items())[:8]
                newer("participant prompts contain internal identifiers the participant never saw: "
                    + ", ".join("'%s' (%s)" % kv for kv in listed) + (" and more" if len(leaked) > 8 else ""),
                    "never show condition or arm ids, survey question ids (QID14), screen or material ids or "
                    "variable names; key replies by neutral labels (q1, q2, or the number printed on the screen) "
                    "so a participant cannot read their condition from the prompt")
            screen_rules(root, pkg, program, runs, newer)
        defaults = [(path.name, line_no, code) for path in sorted((pkg / "task").glob("*.py")) if path.name != "replies.py"
                    for line_no, code in unread_defaults(path)]
        for name, line_no, code in defaults:
            newer("task/%s:%d: an answer that could not be read becomes a number (%s)" % (name, line_no, code[:120]),
                  "keep it unread (None) and record the reply as unparsed: never 0 or any default. Ask per-round "
                  "answers with replies.Question(..., retry=True) so one unreadable reply is asked again first; what "
                  "other participants see in its place must be what the original screen showed")
        blocking = any(isinstance(i, dict) and i.get("severity") == "blocking" for i in program.get("issues") or [])
        for r in cap.get("runs") or []:
            # the default run's errors, and names task.json gives that are not arm ids, stay notes
            if not r.get("arms") or not r.get("declared") or not r.get("error") or r.get("capped"):
                continue
            crash = (r.get("errorType") or r["error"].split(":", 1)[0]) in CRASH
            if blocking and not crash:
                continue   # a deliberate refusal of an arm that needs what a blocking issue asks for
            newer("run_sessions(arms=%r, n=%s) raised %s" % (r["arms"], r.get("n"), r["error"][:200])
                + (" (a crash, not a refusal)" if crash else " but program.json has no `blocking` issue"),
                "every condition must run with arms=[its id] for a small n (1, or 2 for pairs); an arm that cannot run "
                "yet raises a clear error naming what it needs under a `blocking` issue, or returns a session record "
                'marked blocked ({"arm": ..., "condition": ..., "blocked": "<what is needed>"})')

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

        # the analysis run: effects compute, unread answers, answer gates, memory across tasks (batch-2 reviews)
        warn = lambda msg, fix="": warnings.append((msg, fix))  # noqa: E731  a heuristic: printed, never a failure
        hung = "did not finish" in str(cap.get("error") or "")   # already a failure; a second wait adds nothing
        probe = probe_of(pkg, root=root) if capture_prompts and not hung and (
            (root / "effects.json").is_file() or current) else {}
        analysis = effect_rules(root, pkg, probe, newer, warn, notes) if probe else None
        split = split_rules(root, pkg, program, newer)
        if probe and not probe.get("error"):
            unread_rules(probe, newer, warn)
            question_rules(pkg, probe, newer, warn)
            if not split:
                memory_rules(root, pkg, program, probe, newer)
            summary_rules(probe, participant_text(program, root), newer)
            check_rules(program, _json(pkg / "materials/materials.json") or {}, probe, newer)
        static_unread_rules(pkg, warn)
        if runs:
            prompt_text_rules(root, pkg, program, runs, pieces, newer, warn)

    # missing instructions: one rule (blocking only when the adapter refuses to run without the text)
    # Blocking is right when the adapter refuses to run without the text: the whole study, or the arms that need it
    # (some arm run stops with an error while others run).
    runs_whole = any(r.get("calls") and not r.get("error") for r in runs) and not arm_refused
    issues = [i for i in program.get("issues") or [] if isinstance(i, dict)]
    for n, f in _fields(program):
        if f.get("state") != "missing" or not INSTRUCTION.search("%s %s" % (f.get("id"), f.get("label"))):
            continue
        mine = [i for i in issues if i.get("nodeId") == n.get("id") and i.get("fieldId") in (f.get("id"), None, "")]
        wrong = [i for i in mine if i.get("severity") == "check" or (i.get("severity") == "blocking" and runs_whole)]
        if not wrong and not any(i.get("severity") == "decision" or (i.get("severity") == "blocking" and not runs_whole)
                                 for i in mine):
            add("%s.%s: missing participant instructions have no `decision` issue" % (n.get("id"), f.get("id")),
                "add a decision issue on this field: the researcher supplies the printed text or accepts the "
                "stand-in wording the adapter uses (say which in suggestedAction)")
        for i in wrong:
            add("%s: issue %s on missing participant instructions has severity %r" % (
                "%s.%s" % (n.get("id"), f.get("id")), i.get("id"), i.get("severity")),
                "missing instruction wording is a `decision` (the researcher supplies the printed text or accepts "
                "the stand-in wording the adapter uses; say which in suggestedAction), or `blocking` only when the "
                "adapter refuses to run without it (this one runs); never a `check`, and never written into a "
                "verbatim field")
    return {"problems": problems, "notes": notes, "method": method, "notApplicable": not_applicable,
            "warnings": warnings, "currentContract": current, "analysis": analysis}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["--capture"]:
        nonce = child_nonce()   # before the adapter is imported
        capture(Path(argv[1]).resolve(), nonce)
        return 0
    if argv[:1] == ["--probe"]:
        nonce = child_nonce()   # before any package code is imported
        _probe_child(Path(argv[1]).resolve(), nonce)
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
    for msg, fix in report.get("warnings") or []:
        print("WARN    %s%s" % (msg, "" if report.get("currentContract") else
                                " (older build: blocking once rebuilt with task/replies.py)")
              + ("\n        fix: %s" % fix if fix else ""))
    for line in report["notes"]:
        print("note    " + line)
    if report["method"]:
        print("prompts read from: " + report["method"])
    if report.get("analysis"):
        print("analysis run: " + report["analysis"])
    if report["problems"]:
        print("FAIL %d validity problem(s)" % len(report["problems"]))
        return 1
    na = report.get("notApplicable")
    print("PASS package validity" + (" (%d not-told entr%s marked not applicable: see the notes)"
                                     % (na, "y" if na == 1 else "ies") if na else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
