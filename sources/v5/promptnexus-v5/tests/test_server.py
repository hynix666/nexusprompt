#!/usr/bin/env python3
"""tests/test_server.py — standalone/serve.py end to end.

Starts the real server on an ephemeral port and exercises it over HTTP. The proxy is
the only component holding a secret, so most of this file is about what it refuses:
unknown providers, path tails that escape the allowlisted host, oversized bodies, and
non-loopback binds without an explicit acknowledgement.

    python3 tests/test_server.py [-v]
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVE = os.path.join(ROOT, "standalone", "serve.py")
VERBOSE = "-v" in sys.argv
PASSED = FAILED = 0


def check(name, cond, detail=""):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        if VERBOSE:
            print(f"  PASS  {name}")
    else:
        FAILED += 1
        print(f"  FAIL  {name}{(' — ' + detail) if detail else ''}")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def request(url, data=None, method=None, timeout=10):
    """Return (status, body_text). HTTP errors are results here, not exceptions."""
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method=method or ("POST" if data else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        return 0, str(exc)


def main():
    if not os.path.exists(SERVE):
        print("standalone/serve.py not present — skipping server suite")
        return 0
    if not os.path.exists(os.path.join(ROOT, "standalone", "index.html")):
        print("standalone/index.html missing — run standalone/build.sh first")
        return 1

    print("standalone server")
    port = free_port()
    env = {**os.environ}
    # Deliberately unset: the 401 path is the interesting one, and a real key must
    # never be a prerequisite for the suite to pass.
    for var in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"):
        env.pop(var, None)

    proc = subprocess.Popen([sys.executable, SERVE, "--port", str(port)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(50):  # wait for bind
            if request(f"{base}/api/health")[0] == 200:
                break
            time.sleep(0.1)

        # ── routing ────────────────────────────────────────────────────
        code, body = request(f"{base}/api/health")
        check("health responds 200", code == 200)
        check("health reports the linter", json.loads(body or "{}").get("linter") is True, body)

        code, body = request(f"{base}/")
        check("serves index.html", code == 200 and "<title>PromptNexus" in body)
        code, _ = request(f"{base}/app.js")
        check("serves the bundle", code == 200)
        code, _ = request(f"{base}/nope.js")
        check("unknown static path is 404", code == 404)

        # ── secrets never cross the wire ───────────────────────────────
        code, body = request(f"{base}/api/providers")
        providers = json.loads(body)
        check("providers lists all four", set(providers) == {"anthropic", "openai", "google", "ollama"})
        check("providers exposes booleans only",
              all(set(v) == {"configured"} and isinstance(v["configured"], bool)
                  for v in providers.values()), body)
        check("ollama needs no key", providers["ollama"]["configured"] is True)
        check("unset provider reports unconfigured", providers["anthropic"]["configured"] is False)

        # ── proxy refusals ─────────────────────────────────────────────
        payload = json.dumps({"model": "x", "messages": []}).encode()

        code, body = request(f"{base}/api/llm/anthropic", payload)
        check("missing key is 401, not a crash", code == 401, f"got {code}")
        check("401 names the env var, not the key", "ANTHROPIC_API_KEY" in body)

        code, body = request(f"{base}/api/llm/evilcorp", payload)
        check("unknown provider is 404", code == 404, f"got {code}")
        check("unknown provider is named back safely", "evilcorp" in body)

        code, _ = request(f"{base}/api/llm/google", payload)
        check("gemini without a model path is 400", code == 400)

        for escape in ("google/../../../etc/passwd",
                       "google/models/../../v1beta/x:generateContent",
                       "google/models/x:generateContent/../../evil",
                       "anthropic/extra/path"):
            code, _ = request(f"{base}/api/llm/{escape}", payload)
            check(f"tail rejected: {escape[:38]}", code == 400, f"got {code}")

        code, _ = request(f"{base}/api/llm/anthropic", b"x" * (3 * 1024 * 1024))
        check("oversized body is 413", code == 413, f"got {code}")

        code, _ = request(f"{base}/api/nonsense", payload)
        check("unknown api endpoint is 404", code == 404)

        # Pre-read error paths leave the request body in the socket; on keep-alive those
        # bytes would be parsed as the next request. They must close the connection.
        serve_src = open(SERVE, encoding="utf-8").read()
        proxy_src = serve_src[serve_src.index("def _proxy"):serve_src.index("def main(")]
        check("no pre-read error path in _proxy uses bare _send",
              "_send(404" not in proxy_src and "_send(401" not in proxy_src
              and '_send(400' not in proxy_src,
              "an early error exit skips _reject_unread and leaves the body unread")
        check("_reject_unread closes the connection",
              "close_connection = True" in serve_src[serve_src.index("def _reject_unread"):
                                                     serve_src.index("def _proxy")])

        # ── static traversal ───────────────────────────────────────────
        for escape in ("/../prompt_lint.py", "/../../etc/passwd", "/..%2fserve.py"):
            code, _ = request(f"{base}{escape}")
            check(f"traversal blocked: {escape}", code == 404, f"got {code}")

        # Sibling-prefix traversal: with ROOT=/…/standalone, a directory /…/standalonefoo
        # shares the string prefix and passed the old startswith() check. is_relative_to
        # compares path components, so it cannot. Created next to ROOT for the probe.
        sib = os.path.join(os.path.dirname(os.path.join(ROOT, "standalone")), "standalonefoo")
        os.makedirs(sib, exist_ok=True)
        with open(os.path.join(sib, "leak.txt"), "w") as fh:
            fh.write("SECRET")
        try:
            code, body = request(f"{base}/../standalonefoo/leak.txt")
            check("sibling-prefix traversal blocked", code == 404 and "SECRET" not in body,
                  f"got {code} — prefix check let a sibling directory through")
        finally:
            os.remove(os.path.join(sib, "leak.txt"))
            os.rmdir(sib)

        # ── lint endpoint ──────────────────────────────────────────────
        code, body = request(f"{base}/api/lint", json.dumps(
            {"text": "anti-override scope fact-grounding"}).encode())
        check("lint returns PASS on a clean prompt", code == 200 and json.loads(body)["status"] == "PASS", body)

        code, body = request(f"{base}/api/lint", json.dumps(
            {"text": "fill <<SLOT>>", "safetyTier": True}).encode())
        result = json.loads(body) if code == 200 else {}
        check("lint honors options", code == 200 and result.get("status") == "GATE_FAIL", body)
        check("lint agrees with the CLI gate names",
              any(f["gate"] == "PLACEHOLDER_AUDIT" for f in result.get("findings", [])))

        code, _ = request(f"{base}/api/lint", b"{not json")
        check("malformed lint body is 400", code == 400, f"got {code}")
    finally:
        proc.terminate()
        proc.wait(timeout=5)

    # ── bind guard (no server needed) ──────────────────────────────────
    out = subprocess.run([sys.executable, SERVE, "--host", "0.0.0.0", "--port", str(free_port())],
                         capture_output=True, text=True, timeout=20)
    check("refuses to bind 0.0.0.0 unacknowledged", out.returncode != 0)
    check("refusal explains why", "API keys" in (out.stderr + out.stdout))

    print(f"\n{PASSED} passed, {FAILED} failed")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
