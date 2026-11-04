#!/usr/bin/env python3
"""Every answer a participant gives must reach the session record.

    python .opencode/skills/build/recorded_answers.py package/<slug>

check_package.py runs it for packages that use the shared reply reader (task/replies.py); a package
whose adapter does not import replies is not checked (it passes and nothing is printed).

A participant who is asked a question and answers it has produced data. When the adapter asks the
question but drops the answer (a wrap-up page shown and its replies thrown away), the researcher cannot
apply any later coding rule to it, and the run silently differs from the survey, where every answer was
stored.

How: one participant per condition with a deterministic offline stand-in (no network, no model calls),
answering through replies.ask's `answer_for` hook. Then, for each question the participant answered, the
same participant runs again with only that one answer changed (another option, other text, another
number). If the sessions run_sessions returns are identical, the answer was never recorded. Keyed
questions (comprehension and attention checks, consent) are skipped: their answers decide the flow.

The package's code runs only in a confined child (sandbox_run.py) on a copy laid out like the project:
no keys, no network, writes only in a scratch folder; pauses are skipped. Never in this process.

Limits: a package whose runs are not reproducible from the seed is not judged (noted, not failed); a run
that crashes or hangs is left to the smoke test; at most MAX_RERUNS reruns and TIME_BUDGET seconds, so a
very long package is checked only in part (noted). Ported from HumanStudy-Bench
agent_pipeline/recorded_answers.py. Standard library only.
"""
from __future__ import annotations

import hashlib
import importlib.util
import inspect
import io
import json
import math
import sys
import time
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
MAX_CALLS = 400        # per run
MAX_RERUNS = 160       # per package
TIME_BUDGET = 100.0    # seconds for the whole check
CHECK_TIMEOUT = 150
MARK = "@@ANSWERS@@"


class _Stop(BaseException):
    """Ends a run at the call cap; a BaseException so an adapter's ``except Exception`` cannot hide it."""


class Answerer:
    """A stand-in participant whose every answer is fixed by its position in the session,
    except one answer that ``change`` replaces with an alternative."""

    def __init__(self, change: tuple | None = None) -> None:
        self.change = change          # (call number, question id, which alternative)
        self.calls = 0
        self.asked: list = []         # (call number, question) for every answered question

    def __call__(self, prompt: str, *a: Any, **k: Any) -> str:  # a call that bypasses replies.ask
        self.calls += 1
        if self.calls > MAX_CALLS:
            raise _Stop()
        return "1"

    def _answer(self, call: int, question: Any, alternative: int) -> str:
        kind = getattr(question, "kind", "text")
        key = getattr(question, "key", None)
        if kind == "choice":
            options = list(getattr(question, "options", []) or [])
            codes = list(getattr(question, "codes", []) or [])
            keyed = question.key_indices() if key is not None else []
            if keyed:
                return ", ".join(codes[i] for i in keyed) if getattr(question, "multiple", False) else codes[keyed[0]]
            index = (call + alternative) % len(options)
            if getattr(question, "multiple", False) and alternative and len(options) > 1:
                return ", ".join(codes[i] for i in sorted({index, (index + 1) % len(options)}))
            return codes[index]
        if kind == "number":
            if key is not None:
                return str(key[0] if isinstance(key, (list, tuple)) and key else key)
            low = getattr(question, "minimum", None)
            high = getattr(question, "maximum", None)
            low = 0 if low is None else low
            high = low + 10 if high is None else high
            span = max(1, int(high - low))
            value = low + ((call + alternative) % (span + 1))
            return str(int(value) if getattr(question, "integer", True) else float(value))
        if key is not None:
            return str(key[0] if isinstance(key, (list, tuple)) and key else key)
        # Words and digits both differ between versions, so an adapter that keeps only a number
        # pulled out of free text still sees a different answer.
        return "My answer, version %s, is %d." % ("abcdefgh"[alternative % 8], 17 + 31 * alternative + call)

    def answer_for(self, prompt: str, questions: Any, attempt: int = 0, final: bool = True, **_: Any) -> str:
        self.calls += 1
        if self.calls > MAX_CALLS:
            raise _Stop()
        questions = list(questions)
        replies = []
        for question in questions:
            alternative = 0
            if self.change and self.change[0] == self.calls and self.change[1] == question.id:
                alternative = self.change[2]
            if attempt == 0:
                self.asked.append({"call": self.calls, "question": question})
            replies.append(self._answer(self.calls, question, alternative))
        if len(questions) == 1:
            return replies[0]
        return "\n".join("Q%d: %s" % (number, reply) for number, reply in enumerate(replies, 1))


def _alternatives(question: Any) -> int:
    """How many different answers the check can give this question (0: not checked)."""
    if getattr(question, "key", None) is not None:
        return 0
    kind = getattr(question, "kind", "text")
    if kind == "choice":
        return min(2, len(getattr(question, "options", []) or []) - 1)
    if kind == "number":
        low, high = getattr(question, "minimum", None), getattr(question, "maximum", None)
        return 0 if low is not None and high is not None and high <= low else 1
    return 1


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _import(path: Path, name: str) -> Any:
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _jsonable(value: Any, depth: int = 0) -> Any:
    if depth > 30:
        return None
    if isinstance(value, dict):
        return {str(k): _jsonable(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v, depth + 1) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    try:
        return float(value)  # numpy scalars
    except (TypeError, ValueError):
        return str(value)


def condition_ids(task: Any) -> list:
    if not isinstance(task, dict):
        return []
    ids: list = []
    for key in ("conditions", "arms"):
        items = task.get(key) or []
        if isinstance(items, dict):
            items = list(items)
        for item in items:
            value = item.get("id") if isinstance(item, dict) else item
            if isinstance(value, str) and value and value not in ids:
                ids.append(value)
    return ids


def check(root: Path) -> dict:
    """Run in the confined child only: it imports and runs the package's adapter."""
    time.sleep = lambda *a, **k: None   # pacing between calls is not waited out
    sys.dont_write_bytecode = True
    while str(HERE) in sys.path:  # the package imports its own siblings, never a checker module
        sys.path.remove(str(HERE))
    report: dict = {"dropped": [], "checked": 0, "skipped": None}
    task = _load_json(root / "task/task.json")
    try:
        with redirect_stdout(io.StringIO()):
            adapter = _import(root / "task/adapter.py", "humanstudy_answers_adapter")
    except BaseException as exc:  # noqa: BLE001
        report["skipped"] = "adapter not importable (%s)" % type(exc).__name__
        return report
    run_sessions = getattr(adapter, "run_sessions", None)
    if not callable(run_sessions):
        report["skipped"] = "no run_sessions"
        return report
    try:
        accepts_arms = "arms" in inspect.signature(run_sessions).parameters
    except (TypeError, ValueError):
        accepts_arms = False
    arms = (condition_ids(task) if accepts_arms else []) or [None]
    started = time.monotonic()
    tested: set = set()
    reruns = 0

    def run(arm, change=None):
        answerer = Answerer(change)
        try:
            with redirect_stdout(io.StringIO()):
                sessions = run_sessions(answerer, 0, 1, arms=[arm]) if arm is not None else run_sessions(answerer, 0, 1)
        except _Stop:
            return None, answerer
        except BaseException:  # noqa: BLE001 - a crash is the smoke test's business
            return None, answerer
        text = json.dumps(_jsonable(sessions), sort_keys=True, default=str)
        return hashlib.sha256(text.encode()).hexdigest(), answerer

    for arm in arms:
        if time.monotonic() - started > TIME_BUDGET or reruns >= MAX_RERUNS:
            report["skipped"] = "time budget reached; later conditions not checked"
            break
        base, answerer = run(arm)
        if base is None or not answerer.asked:
            continue
        again, _ = run(arm)
        if again != base:
            report["skipped"] = "sessions differ between two runs with the same seed; answers not checked"
            break
        for asked in answerer.asked:
            question = asked["question"]
            text = " ".join(str(getattr(question, "text", "") or "").split())
            identity = "%s|%s" % (question.id, text[:200])
            options = _alternatives(question)
            if identity in tested or not options:
                continue
            tested.add(identity)
            same = True
            for alternative in range(1, options + 1):
                if time.monotonic() - started > TIME_BUDGET or reruns >= MAX_RERUNS:
                    same = False
                    break
                reruns += 1
                changed, _ = run(arm, (asked["call"], question.id, alternative))
                if changed is None or changed != base:
                    same = False
                    break
            report["checked"] += 1
            if same:
                report["dropped"].append({"condition": arm, "prompt": asked["call"], "question": question.id,
                                          "text": text[:90]})
    return report


def confined_report(package_root: Path, timeout: int = CHECK_TIMEOUT) -> dict | None:
    """check() in a confined child on a copy laid out like the project; None when it gave no report."""
    import sandbox_run
    from check_replies import copy_like_project
    with sandbox_run.work_dir(prefix="recorded-answers-") as work:
        copy = copy_like_project(Path(package_root), work)
        run = sandbox_run.run_python(Path(__file__).resolve(), ["--child", str(copy)], cwd=copy, work=work,
                                     timeout=timeout)
    if run.timed_out:
        return None
    line = next((l for l in run.stdout.splitlines()[::-1] if l.startswith(MARK)), None)
    try:
        report = json.loads(line[len(MARK):]) if line else None
    except ValueError:
        return None
    return report if isinstance(report, dict) else None


def _judge(package_root, timeout: int = CHECK_TIMEOUT) -> tuple:
    """(applies, report or None, [(message, fix)])."""
    from check_replies import IMPORTS
    root = Path(package_root).resolve()
    try:
        adapter = (root / "task/adapter.py").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False, None, []
    if not IMPORTS.search(adapter):
        return False, None, []
    report = confined_report(root, timeout)
    dropped = (report or {}).get("dropped") or []
    if not dropped:
        return True, report, []
    shown = "; ".join("'%s' (condition %s, prompt %s)" % (d.get("text") or d.get("question"), d.get("condition"),
                                                          d.get("prompt")) for d in dropped[:5])
    more = " and %d more" % (len(dropped) - 5) if len(dropped) > 5 else ""
    return True, report, [(
        "recorded answers: participants are asked questions whose answers never reach the session record "
        "run_sessions returns: %s%s. Changing the answer changes nothing in the session" % (shown, more),
        "store every answer a participant gives in the session (wrap-up and comment questions too, under a "
        "neutral key), even when the analysis does not use it (build SKILL.md section 3, 'Record every answer')")]


def problems(package_root, timeout: int = CHECK_TIMEOUT) -> list:
    """[(message, fix)] for check_package.py; [] when the package does not use replies.py or could not be judged."""
    return _judge(package_root, timeout)[2]


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["--child"] and len(argv) == 2:
        report = check(Path(argv[1]).resolve())
        print(MARK + json.dumps(report, ensure_ascii=False, default=str), flush=True)
        return 0
    if len(argv) != 1:
        print("usage: recorded_answers.py package/<slug>", file=sys.stderr)
        return 2
    applies, report, found = _judge(argv[0])
    if not applies:
        return 0  # an older package without the shared reader: nothing to say
    if report is None:
        print("note    the check gave no report (the adapter hung or crashed; the smoke test reports why)")
    elif report.get("skipped"):
        print("note    " + str(report["skipped"]))
    for msg, fix in found:
        print("PROBLEM %s\n        fix: %s" % (msg, fix))
    if found:
        print("FAIL answers dropped")
        return 1
    print("PASS every answer reaches the session record (%d checked)" % ((report or {}).get("checked") or 0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
