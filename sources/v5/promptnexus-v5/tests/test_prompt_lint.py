#!/usr/bin/env python3
"""Regression suite for prompt_lint.py (framework v5.7.0, Annex D).

Runs the shared fixture corpus, then the checks a corpus can't express:
performance against a large input, and CLI surface (exit codes, flags).

    python3 tests/test_prompt_lint.py [-v]

Exit 0 = all passed, 1 = failures. No third-party dependencies.
"""
import importlib.util
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LINTER = os.path.join(ROOT, "prompt_lint.py")
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures.json")
VERBOSE = "-v" in sys.argv

_spec = importlib.util.spec_from_file_location("prompt_lint", LINTER)
pl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pl)

PASSED, FAILED = 0, 0


def check(name, cond, detail=""):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        if VERBOSE:
            print(f"  PASS  {name}")
    else:
        FAILED += 1
        print(f"  FAIL  {name}{(' — ' + detail) if detail else ''}")


def lint_case(case, text):
    o = case.get("options", {})
    return pl.lint(
        text,
        token_budget=o.get("tokenBudget"),
        recursive_target=o.get("recursiveTarget", False),
        safety_tier=o.get("safetyTier", False),
        include_fences=o.get("includeFences", False),
        rag_target=o.get("ragTarget", False),
        stakes=o.get("stakes"),
        naive_tokens=o.get("naiveTokens"),
        provider=o.get("provider"),
    )


CASE_TIMEOUT_S = 15


def lint_isolated(name):
    """Run one case in a child process under a hard timeout.

    Large fixtures run isolated because a pathological pattern doesn't fail an
    in-process run — it wedges the suite. Reverting the bounded quantifiers used to
    hang here for minutes with no output, which is strictly worse than a red build.
    """
    try:
        out = subprocess.run([sys.executable, os.path.abspath(__file__), "--case", name],
                             capture_output=True, text=True, timeout=CASE_TIMEOUT_S)
        return json.loads(out.stdout)
    except (subprocess.TimeoutExpired, json.JSONDecodeError):
        return None


def load_cases():
    with open(FIXTURES, encoding="utf-8") as fh:
        data = json.load(fh)
    for case in data["cases"]:
        text = case["text"]
        if case.get("pad_to_chars"):  # keep the fixture file small
            text = text.replace("PAD", "x" * (case["pad_to_chars"] - len(text)))
        yield case, text


def run_corpus():
    print("\ncorpus (shared with tests/parity.mjs)")
    for case, text in load_cases():
        if case.get("pad_to_chars"):
            result = lint_isolated(case["name"])
            if result is None:
                check(f"{case['name']}: completes within {CASE_TIMEOUT_S}s", False, "TIMED OUT")
                continue
        else:
            result = lint_case(case, text)
        got_status = result["status"]
        want_status = case["expect"]["status"]
        check(f"{case['name']}: status", got_status == want_status,
              f"expected {want_status}, got {got_status}")

        got = sorted((f["gate"], f["severity"]) for f in result["findings"])
        want = sorted(tuple(x) for x in case["expect"]["findings"])
        check(f"{case['name']}: findings", got == want, f"expected {want}, got {got}")

        if "details_order" in case:  # ordering matters for a few gates
            spec = case["details_order"]
            hit = next((f for f in result["findings"] if f["gate"] == spec["gate"]), None)
            check(f"{case['name']}: detail order",
                  hit is not None and list(hit["details"]) == spec["expect"],
                  f"expected {spec['expect']}, got {hit and hit.get('details')}")


def timed_lint(payload_expr):
    """Elapsed seconds for a lint run in a child process, or None on timeout."""
    code = (f"import importlib.util,time;"
            f"s=importlib.util.spec_from_file_location('pl',{LINTER!r});"
            f"m=importlib.util.module_from_spec(s);s.loader.exec_module(m);"
            f"t=time.time();r=m.lint({payload_expr});"
            f"print(round(time.time()-t,3), any(f['gate']=='SECRET_LEAK_SCAN' for f in r['findings']))")
    try:
        out = subprocess.run([sys.executable, "-c", code], capture_output=True,
                             text=True, timeout=CASE_TIMEOUT_S).stdout.split()
        return float(out[0]), out[1] == "True"
    except subprocess.TimeoutExpired:
        return None, False


def run_performance():
    # Regression: unbounded quantifiers in SECRET_PATTERNS scanned quadratically.
    # A ~500 KB prompt took minutes before the patterns were bounded on both ends.
    print("\nperformance")
    big = "'anti-override scope fact-grounding ' + 'x'*600000"

    elapsed, _ = timed_lint(big)
    check(f"600k chars lints within {CASE_TIMEOUT_S}s"
          + (f" ({elapsed:.2f}s)" if elapsed else " (TIMED OUT)"), elapsed is not None)

    elapsed, found = timed_lint(big + " + ' mail jane.doe@example.com'")
    check(f"600k chars + PII within {CASE_TIMEOUT_S}s"
          + (f" ({elapsed:.2f}s)" if elapsed else " (TIMED OUT)"), elapsed is not None)
    check("PII still detected at size", found)


def cli(args, stdin=None):
    proc = subprocess.run([sys.executable, LINTER] + args, input=stdin,
                          capture_output=True, text=True, timeout=60)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def run_cli():
    print("\nCLI surface")
    code, out, _ = cli(["--version"])
    check("--version exits 0", code == 0)
    check("--version reports 1.4.0", "1.4.0" in out, out)

    clean = "anti-override scope fact-grounding\n"
    check("PASS exits 0", cli(["-"], clean)[0] == 0)
    check("DEGRADED exits 3", cli(["-"], clean + "we guarantee it\n")[0] == 3)
    check("GATE_FAIL exits 1", cli(["-"], clean + "<<SLOT>>\n")[0] == 1)

    code, out, _ = cli(["-", "--json"], clean)
    try:
        parsed = json.loads(out)
        check("--json emits parseable JSON", parsed["status"] == "PASS")
    except json.JSONDecodeError as exc:
        check("--json emits parseable JSON", False, str(exc))

    check("--quiet silent on PASS", cli(["-", "--quiet"], clean)[1] == "")
    check("--quiet speaks on failure", cli(["-", "--quiet"], clean + "<<S>>")[1] != "")

    # Every QUTM tier must be a valid choice, GUARDED included (it wasn't, once).
    for tier in ("safety-critical", "high", "guarded", "medium", "low"):
        check(f"--stakes {tier} accepted", cli(["-", "--stakes", tier], clean)[0] in (0, 1, 3))

    code, out, err = cli(["/nonexistent/path.md"])
    check("missing file exits 2", code == 2, f"got {code}")
    check("missing file writes to stderr", err != "")

    code, out, _ = cli(["-", "--stakes", "low", "--json"], clean)
    check("cost_ratio present with --stakes", '"cost_ratio"' in out)
    code, out, _ = cli(["-", "--json"], clean)
    check("cost_ratio absent without --stakes", '"cost_ratio"' not in out)


def child_mode(name):
    for case, text in load_cases():
        if case["name"] == name:
            print(json.dumps(lint_case(case, text)))
            return 0
    print(f"unknown case: {name}", file=sys.stderr)
    return 2


def main():
    if "--case" in sys.argv:
        return child_mode(sys.argv[sys.argv.index("--case") + 1])
    print("prompt-lint regression suite")
    run_corpus()
    run_performance()
    run_cli()
    print(f"\n{PASSED} passed, {FAILED} failed")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
