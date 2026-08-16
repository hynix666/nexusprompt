#!/usr/bin/env python3
"""serve.py — the entire backend for standalone PromptNexus. Python 3.9+ stdlib only.

Three jobs:
  1. serve the built single-page app
  2. proxy LLM calls so the API key stays server-side and never reaches the browser
  3. expose prompt_lint.py over HTTP for callers that want the canonical linter

Run:
    ANTHROPIC_API_KEY=sk-... python3 serve.py
    python3 serve.py --port 8080 --host 127.0.0.1

Security posture — the proxy is the only part of this system that holds a secret, so:
  * binds loopback by default; --host 0.0.0.0 requires --i-know-this-is-exposed
  * the client never supplies a URL. It names a provider; the upstream is a fixed
    entry in ALLOWLIST. This is the difference between a proxy and an open relay.
  * the one provider needing a path tail (Gemini puts the model in the URL) has that
    tail validated against a strict pattern before it is appended
  * keys are read from the environment and never logged, never echoed, never sent to
    a provider other than the one they belong to
  * request bodies are never logged — they contain prompts, and prompts contain
    whatever the user pasted in
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LINTER = ROOT.parent / "prompt_lint.py"
MAX_BODY = 2 * 1024 * 1024          # 2 MB accepted
MAX_DRAIN = 16 * 1024 * 1024        # discard up to this much of an oversized body
UPSTREAM_TIMEOUT = 120              # seconds

# name -> (upstream base URL, env var holding the key, header builder, tail pattern)
# A provider absent from this table cannot be reached. That is the whole point.
ALLOWLIST = {
    "anthropic": {
        "url": "https://api.anthropic.com/v1/messages",
        "env": "ANTHROPIC_API_KEY",
        "headers": lambda key: {"x-api-key": key, "anthropic-version": "2023-06-01"},
        "tail": None,
    },
    "openai": {
        "url": "https://api.openai.com/v1/chat/completions",
        "env": "OPENAI_API_KEY",
        "headers": lambda key: {"Authorization": f"Bearer {key}"},
        "tail": None,
    },
    "google": {
        "url": "https://generativelanguage.googleapis.com/v1beta",
        "env": "GOOGLE_API_KEY",
        "headers": lambda key: {"x-goog-api-key": key},
        # Gemini carries the model in the path. Validated, not concatenated blindly:
        # an unchecked tail is a path-traversal vector into an allowlisted host.
        "tail": re.compile(r"^/models/[A-Za-z0-9._:-]{1,64}:generateContent$"),
    },
    "ollama": {
        "url": os.environ.get("OLLAMA_URL", "http://localhost:11434/api/chat"),
        "env": None,                # local, no auth
        "headers": lambda key: {},
        "tail": None,
    },
}


def load_linter():
    """Import prompt_lint.py from the bundle root, if present."""
    if not LINTER.exists():
        return None
    import importlib.util
    spec = importlib.util.spec_from_file_location("prompt_lint", LINTER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


PROMPT_LINT = load_linter()


class Handler(BaseHTTPRequestHandler):
    server_version = "PromptNexus"

    # ── plumbing ────────────────────────────────────────────────────────
    def log_message(self, fmt, *args):
        # Method, path, and status only. Bodies hold prompts and would hold keys.
        sys.stderr.write(f"{self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}\n")

    def _send(self, code, payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        # No Access-Control-Allow-Origin: same-origin only. Serving the page from the
        # same host is also what makes OpenAI/Gemini/Ollama reachable at all — none of
        # them send CORS headers for browser origins.
        self.end_headers()
        self.wfile.write(body)

    def _drain(self, declared):
        """Discard an oversized body so the client can read our response."""
        remaining = min(declared, MAX_DRAIN)
        while remaining > 0:
            chunk = self.rfile.read(min(65536, remaining))
            if not chunk:
                break
            remaining -= len(chunk)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return None
        return self.rfile.read(length)

    # ── routes ──────────────────────────────────────────────────────────
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/health":
            return self._send(200, {"ok": True, "linter": bool(PROMPT_LINT)})
        if path == "/api/providers":
            # Booleans only. Never the key, never a prefix of the key.
            return self._send(200, {
                name: {"configured": bool(cfg["env"] is None or os.environ.get(cfg["env"]))}
                for name, cfg in ALLOWLIST.items()
            })
        return self._serve_static(path)

    def do_POST(self):
        # Length check first, before routing or auth: an oversized body should be
        # refused for the same reason at every endpoint. (Caught by tests/test_server.py:
        # the auth check used to answer first, so a 3 MB body got a 401.)
        declared = int(self.headers.get("Content-Length") or 0)
        if declared > MAX_BODY:
            # Answering without draining races the client's write and it sees a reset
            # instead of the 413 — the second bug this line caused. Discard in bounded
            # chunks so the response is actually delivered, then close.
            self._drain(declared)
            self.close_connection = True
            return self._send(413, {"error": {"message":
                f"body too large ({declared} bytes, limit {MAX_BODY})"}})
        path = self.path.split("?")[0]
        if path == "/api/lint":
            return self._lint()
        if path.startswith("/api/llm/"):
            return self._proxy(path[len("/api/llm/"):])
        self._send(404, {"error": {"message": "no such endpoint"}})

    # ── static ──────────────────────────────────────────────────────────
    def _serve_static(self, path):
        rel = path.lstrip("/") or "index.html"
        target = (ROOT / rel).resolve()
        # `str(target).startswith(str(ROOT))` is the classic prefix-without-separator flaw:
        # with ROOT=/app/standalone, a sibling /app/standalonefoo passes the prefix test.
        # is_relative_to compares path components, so a shared name prefix can't escape.
        if not target.is_relative_to(ROOT) or not target.is_file():
            return self._send(404, {"error": {"message": "not found"}})
        types = {".html": "text/html; charset=utf-8", ".js": "text/javascript",
                 ".css": "text/css", ".json": "application/json", ".md": "text/markdown",
                 ".svg": "image/svg+xml"}
        self._send(200, target.read_bytes(), types.get(target.suffix, "application/octet-stream"))

    # ── lint ────────────────────────────────────────────────────────────
    def _lint(self):
        if not PROMPT_LINT:
            return self._send(501, {"error": {"message": "prompt_lint.py not found next to the app"}})
        raw = self._read_body()
        if raw is None:
            return self._send(413, {"error": {"message": "body too large"}})
        try:
            req = json.loads(raw or b"{}")
            return self._send(200, PROMPT_LINT.lint(
                req.get("text", ""),
                token_budget=req.get("tokenBudget"),
                recursive_target=bool(req.get("recursiveTarget")),
                safety_tier=bool(req.get("safetyTier")),
                include_fences=bool(req.get("includeFences")),
                rag_target=bool(req.get("ragTarget")),
                stakes=req.get("stakes"),
                naive_tokens=req.get("naiveTokens"),
                provider=req.get("provider"),
            ))
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            self._send(400, {"error": {"message": f"bad lint request: {exc}"}})

    # ── proxy ───────────────────────────────────────────────────────────
    def _reject_unread(self, code, message):
        """Error-exit on a path that has NOT consumed the request body.

        The body is still sitting in the socket; on a keep-alive connection those bytes
        would be parsed as the next request line. Close the connection rather than drain,
        since these are all client errors and the connection has no further value.
        """
        self.close_connection = True
        return self._send(code, {"error": {"message": message}})

    def _proxy(self, remainder):
        name, _, tail = remainder.partition("/")
        cfg = ALLOWLIST.get(name)
        if not cfg:
            return self._reject_unread(404, f"unknown provider '{name}'")

        url = cfg["url"]
        if tail:
            tail = "/" + tail
            if not cfg["tail"] or not cfg["tail"].match(tail):
                return self._reject_unread(400, "invalid upstream path")
            url += tail
        elif cfg["tail"]:
            return self._reject_unread(400, f"{name} requires a model path")

        key = os.environ.get(cfg["env"]) if cfg["env"] else ""
        if cfg["env"] and not key:
            return self._reject_unread(401, f"{cfg['env']} is not set on the server. "
                                            f"Export it and restart; the browser never sees it.")

        body = self._read_body()
        if body is None:
            return self._send(413, {"error": {"message": "body too large"}})

        headers = {"Content-Type": "application/json", **cfg["headers"](key)}
        try:
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as resp:
                self._send(resp.status, resp.read())
        except urllib.error.HTTPError as exc:
            # Pass the provider's own error through; it is the useful one.
            self._send(exc.code, exc.read() or json.dumps(
                {"error": {"message": f"HTTP {exc.code}"}}).encode())
        except urllib.error.URLError as exc:
            hint = " (is `ollama serve` running?)" if name == "ollama" else ""
            self._send(502, {"error": {"message": f"upstream unreachable{hint}: {exc.reason}"}})
        except TimeoutError:
            self._send(504, {"error": {"message": f"upstream timed out after {UPSTREAM_TIMEOUT}s"}})


def main():
    ap = argparse.ArgumentParser(description="Standalone PromptNexus server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--i-know-this-is-exposed", action="store_true",
                    help="required to bind a non-loopback address (the proxy holds your API keys)")
    ap.add_argument("--offline", action="store_true",
                    help="strictly model-free: empty the LLM proxy allowlist, skip all key "
                         "handling. Only static hosting + /api/lint remain. Nothing calls out.")
    args = ap.parse_args()

    if args.offline:
        # Hard guarantee: no upstream is reachable, no key is read. Matches the app's
        # model-free default — the server cannot proxy an LLM even if asked.
        ALLOWLIST.clear()

    if args.host not in ("127.0.0.1", "localhost", "::1") and not args.i_know_this_is_exposed:
        sys.exit(f"refusing to bind {args.host}: this process holds your API keys and has no "
                 f"authentication. Put it behind a reverse proxy with auth, or pass "
                 f"--i-know-this-is-exposed.")

    if not (ROOT / "index.html").exists():
        sys.exit(f"index.html missing in {ROOT} — run ./build.sh first.")

    configured = [n for n, c in ALLOWLIST.items()
                  if c["env"] is None or os.environ.get(c["env"])]
    print(f"PromptNexus → http://{args.host}:{args.port}")
    if args.offline:
        print("  mode: OFFLINE / model-free — LLM proxy disabled, nothing calls out")
    else:
        print(f"  providers configured: {', '.join(configured) or 'none — set ANTHROPIC_API_KEY'}")
    print(f"  linter: {'prompt_lint.py loaded' if PROMPT_LINT else 'not found (browser linter still works)'}")
    try:
        ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
