"""Language-model access for simulations in the HumanStudy research runtime.

    from humanstudy_llm import llm, chat
    reply = llm("You are participant 3 ... Answer 1-7.")
    reply = chat([{"role": "system", "content": "..."}, {"role": "user", "content": "..."}])

Calls the HumanStudy Hub hosted proxy (OpenAI-compatible POST {base}/chat/completions).
Environment, all set by the desktop app (nothing is read from or written to disk):
  HUMANSTUDY_HOSTED_BASEURL   proxy base URL
  HUMANSTUDY_DESKTOP_KEY      the signed-in account's key (never logged, never written)
  HUMANSTUDY_SERVER_BYPASS    optional, sent as x-vercel-protection-bypass
  HUMANSTUDY_SIM_MODEL        participant model; default: the model selected in the app (HUMANSTUDY_MODEL)
  HUMANSTUDY_LLM_CONCURRENCY  max calls in flight (default 8)
Every call appends a line (no prompt text) to <project>/.humanstudy/tmp/llm-usage.jsonl.
Standard library only.
"""
from __future__ import annotations

import json
import os
import random
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

__all__ = ["llm", "chat", "llm_many", "LLMError", "LLMConfigError", "model_name", "usage_log_path"]

DEFAULT_MODEL = "anthropic/claude-haiku-5.5"
MAX_ATTEMPTS = 6
RETRY_STATUS = {408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524}


class LLMError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class LLMConfigError(LLMError):
    pass


_sem_lock = threading.Lock()
_sem: threading.BoundedSemaphore | None = None
_sem_size = 0
_log_lock = threading.Lock()


def _concurrency() -> int:
    try:
        return max(1, int(os.environ.get("HUMANSTUDY_LLM_CONCURRENCY", "8")))
    except ValueError:
        return 8


def _semaphore() -> threading.BoundedSemaphore:
    global _sem, _sem_size
    n = _concurrency()
    with _sem_lock:
        if _sem is None or n != _sem_size:
            _sem, _sem_size = threading.BoundedSemaphore(n), n
        return _sem


def model_name() -> str:
    return os.environ.get("HUMANSTUDY_SIM_MODEL") or os.environ.get("HUMANSTUDY_MODEL") or DEFAULT_MODEL


def usage_log_path() -> Path:
    """<project>/.humanstudy/tmp/llm-usage.jsonl; the project is HUMANSTUDY_PROJECT_DIR, else the nearest
    parent of the working directory that has a .humanstudy folder, else the working directory."""
    root = os.environ.get("HUMANSTUDY_PROJECT_DIR")
    if root:
        base = Path(root)
    else:
        cwd = Path.cwd().resolve()
        base = next((p for p in [cwd, *cwd.parents] if (p / ".humanstudy").is_dir()), cwd)
    return base / ".humanstudy" / "tmp" / "llm-usage.jsonl"


def _log(entry: dict) -> None:
    try:
        path = usage_log_path()
        with _log_lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass  # logging must never break a simulation


def _config() -> tuple[str, dict]:
    base = (os.environ.get("HUMANSTUDY_HOSTED_BASEURL") or "").rstrip("/")
    key = os.environ.get("HUMANSTUDY_DESKTOP_KEY")
    if not base or not key:
        raise LLMConfigError(
            "No model access: HUMANSTUDY_HOSTED_BASEURL / HUMANSTUDY_DESKTOP_KEY are not set. "
            "Run this from the HumanStudy desktop app while signed in."
        )
    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {key}",
        "user-agent": "humanstudy-desktop-runtime/1",
    }
    bypass = os.environ.get("HUMANSTUDY_SERVER_BYPASS")
    if bypass:
        headers["x-vercel-protection-bypass"] = bypass
    return base, headers


def _backoff(attempt: int, retry_after: str | None) -> float:
    if retry_after:
        try:
            return min(60.0, max(0.0, float(retry_after)))
        except ValueError:
            pass
    return min(30.0, 1.5 * 2**attempt) * (0.5 + random.random() / 2)


def chat(
    messages: list[dict],
    *,
    model: str | None = None,
    temperature: float | None = None,
    max_tokens: int | None = None,
    seed: int | None = None,
    timeout: float = 180.0,
    full: bool = False,
    **extra,
):
    """One chat completion. Returns the reply text, or the whole response dict when full=True.
    Retries 429/5xx and network errors with exponential backoff (honours Retry-After)."""
    base, headers = _config()
    body: dict = {"model": model or model_name(), "messages": messages}
    if temperature is not None:
        body["temperature"] = temperature
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    if seed is not None:
        body["seed"] = seed
    body.update(extra)
    data = json.dumps(body).encode("utf-8")
    last = "unknown error"
    last_status: int | None = None
    started = time.time()
    with _semaphore():
        for attempt in range(MAX_ATTEMPTS):
            retry_after = None
            try:
                req = urllib.request.Request(base + "/chat/completions", data=data, headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=timeout) as res:
                    payload = json.loads(res.read().decode("utf-8"))
                choice = (payload.get("choices") or [{}])[0]
                text = (choice.get("message") or {}).get("content")
                if text is None:
                    raise LLMError("the model returned no content", None)
                if isinstance(text, list):  # content parts
                    text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
                u = payload.get("usage") or {}
                _log({
                    "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
                    "model": payload.get("model") or body["model"],
                    "ok": True,
                    "attempts": attempt + 1,
                    "ms": int((time.time() - started) * 1000),
                    "prompt_tokens": u.get("prompt_tokens"),
                    "completion_tokens": u.get("completion_tokens"),
                    "total_tokens": u.get("total_tokens"),
                })
                return payload if full else text
            except urllib.error.HTTPError as e:
                last_status = e.code
                detail = e.read().decode("utf-8", "replace")[:300]
                last = f"HTTP {e.code}: {detail}"
                retry_after = e.headers.get("retry-after")
                if e.code not in RETRY_STATUS:
                    break
            except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError, OSError) as e:
                last_status = None
                last = f"{type(e).__name__}: {e}"
            if attempt < MAX_ATTEMPTS - 1:
                time.sleep(_backoff(attempt, retry_after))
    _log({
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z",
        "model": body["model"], "ok": False, "attempts": attempt + 1,
        "ms": int((time.time() - started) * 1000), "status": last_status, "error": last[:200],
    })
    raise LLMError(f"model call failed after {attempt + 1} attempt(s): {last}", last_status)


def llm(prompt: str, *, system: str | None = None, **kw) -> str:
    """Single-prompt convenience: llm(prompt) -> reply text. kw as for chat()."""
    msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": prompt}]
    return chat(msgs, **kw)


def llm_many(prompts: list[str], *, workers: int | None = None, **kw) -> list[str]:
    """llm() over many prompts in parallel (bounded by HUMANSTUDY_LLM_CONCURRENCY); order preserved."""
    with ThreadPoolExecutor(max_workers=workers or _concurrency()) as ex:
        return list(ex.map(lambda p: llm(p, **kw), prompts))
