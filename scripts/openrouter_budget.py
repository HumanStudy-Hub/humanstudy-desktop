"""Local batch-only, text chat relay with a reserved per-paper dollar budget.

One request at a time; reserve the model's entire context plus capped output before forwarding.
Missing usage is charged at that reservation. No upstream retry and no native paid search/plugins.
"""
import json
import math
import secrets
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class BudgetRelay:
    def __init__(self, key, model, budget, metadata, endpoint="https://openrouter.ai/api/v1/chat/completions"):
        if not math.isfinite(budget) or budget <= 0:
            raise ValueError("budget must be positive and finite")
        pricing = metadata["pricing"]
        if pricing.get("overrides"):
            raise ValueError("tiered model pricing is not supported by this budget guard")
        # Native search/media are rejected below; caching hints are removed recursively.
        covered = {"prompt", "completion", "input_cache_read", "input_cache_write", "input_cache_write_1h", "web_search", "overrides"}
        if any(float(value or 0) != 0 for key, value in pricing.items() if key not in covered):
            raise ValueError("model has unsupported additional pricing")
        self.prompt_price = float(pricing["prompt"])
        self.output_price = float(pricing["completion"])
        self.input_reservation_price = max(self.prompt_price, *(float(pricing.get(k) or 0) for k in ("input_cache_write", "input_cache_write_1h")))
        if any(not math.isfinite(x) or x < 0 for x in (self.prompt_price, self.output_price, self.input_reservation_price)):
            raise ValueError("invalid model prices")
        self.context = int(metadata["context_length"])
        self.output_limit = min(8192, int(metadata.get("top_provider", {}).get("max_completion_tokens") or 8192))
        if self.context <= 0 or self.output_limit <= 0:
            raise ValueError("invalid model limits")
        self.model, self.budget, self.endpoint = model, budget, endpoint
        self.key, self.token = key, secrets.token_urlsafe(32)
        self.charged = 0.0
        self.records = []
        self.lock = threading.Lock()
        relay = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def fail(self, status, message):
                body = json.dumps({"error": {"message": message, "type": "budget_guard"}}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                if self.path != "/v1/chat/completions" or self.headers.get("Authorization") != "Bearer " + relay.token:
                    return self.fail(403, "Invalid batch relay request")
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 < length <= 4_000_000:
                        return self.fail(413, "Batch request exceeds relay limit")
                    body = json.loads(self.rfile.read(length))
                    relay.validate(body)
                except (ValueError, TypeError, KeyError):
                    return self.fail(400, "Only text/function-tool requests for the configured model are supported")
                with relay.lock:
                    reserve = relay.context * relay.input_reservation_price + relay.output_limit * relay.output_price
                    if relay.charged + reserve > relay.budget:
                        return self.fail(402, "Per-paper budget reached; no further request was sent")
                    relay.charged += reserve
                    cost = None
                    generation = None
                    completed = False
                    interrupted = False
                    try:
                        req = urllib.request.Request(relay.endpoint, data=json.dumps(body).encode(), headers={
                            "Authorization": "Bearer " + relay.key, "Content-Type": "application/json"})
                        with urllib.request.urlopen(req, timeout=180) as upstream:
                            self.send_response(200)
                            self.send_header("Content-Type", upstream.headers.get("Content-Type", "text/event-stream"))
                            self.send_header("Connection", "close")
                            self.end_headers()
                            if body.get("stream"):
                                for line in upstream:
                                    if line.strip() == b"data: [DONE]":
                                        completed = True
                                    if line.startswith(b"data: ") and line.strip() != b"data: [DONE]":
                                        try:
                                            item = json.loads(line[6:])
                                            if item.get("error"):
                                                interrupted = True
                                            generation = item.get("id", generation)
                                            usage = item.get("usage") or {}
                                            if isinstance(usage.get("cost"), (int, float)):
                                                cost = usage["cost"]
                                        except (ValueError, TypeError):
                                            pass
                                    self.wfile.write(line)
                                    self.wfile.flush()
                            else:
                                raw = upstream.read()
                                item = json.loads(raw)
                                generation = item.get("id")
                                cost = (item.get("usage") or {}).get("cost")
                                self.wfile.write(raw)
                                completed = not item.get("error")
                    except urllib.error.HTTPError as exc:
                        interrupted = True
                        self.fail(exc.code, "OpenRouter request rejected (HTTP %s)" % exc.code)
                    except (OSError, ValueError):
                        # A disconnected paid request may still finish; keep the whole reservation.
                        interrupted = True
                    finally:
                        exact = completed and not interrupted and isinstance(cost, (int, float)) and not isinstance(cost, bool) and math.isfinite(cost) and 0 <= cost <= reserve
                        if exact:
                            relay.charged -= reserve - cost
                        relay.records.append({"generationId": generation, "costUsd": cost if exact else None,
                                              "reservedUsd": reserve, "chargedUsd": cost if exact else reserve})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def validate(self, body):
        allowed = {"model", "messages", "stream", "stream_options", "max_tokens", "max_completion_tokens",
                   "temperature", "top_p", "top_k", "stop", "seed", "frequency_penalty", "presence_penalty",
                   "tools", "tool_choice", "parallel_tool_calls", "response_format", "reasoning",
                   "include_reasoning", "user", "n", "usage", "provider"}
        if not isinstance(body, dict) or set(body) - allowed or body.get("n", 1) != 1:
            raise ValueError("unbudgeted request feature")
        if body.get("model") != self.model or body.get("plugins") or body.get("web_search_options"):
            raise ValueError("unsupported request")
        if any(t.get("type") != "function" for t in body.get("tools", [])):
            raise ValueError("native tools are not budgeted")
        def remove_cache(value):
            if isinstance(value, dict):
                value.pop("cache_control", None)
                for child in value.values():
                    remove_cache(child)
            elif isinstance(value, list):
                for child in value:
                    remove_cache(child)
        remove_cache(body)
        for message in body.get("messages", []):
            content = message.get("content")
            if isinstance(content, list):
                if any(part.get("type") != "text" for part in content):
                    raise ValueError("media is not budgeted")
                for part in content:
                    part.pop("cache_control", None)
            message.pop("cache_control", None)
        for tool in body.get("tools", []):
            tool.pop("cache_control", None)
        body.pop("max_completion_tokens", None)
        body["max_tokens"] = min(self.output_limit, int(body.get("max_tokens") or self.output_limit))
        if body["max_tokens"] < 1:
            raise ValueError("invalid output limit")
        body["provider"] = {"max_price": {"prompt": self.prompt_price * 1e6, "completion": self.output_price * 1e6, "request": 0, "image": 0}}
        body["usage"] = {"include": True}

    def __enter__(self):
        self.thread.start()
        return self

    @property
    def base_url(self):
        return "http://127.0.0.1:%d/v1" % self.server.server_port

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
