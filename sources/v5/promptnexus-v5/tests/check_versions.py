#!/usr/bin/env python3
"""tests/check_versions.py — cross-artifact consistency for the framework bundle.

The failure mode this exists for: an artifact describing something that isn't there,
or claiming a version another artifact contradicts. It has happened repeatedly —
the Quick-Select Card sat at v5.6.0 pointing readers at a core document that had been
superseded and removed, while the core's own footer claimed the card as part of the
shipped set. Nothing caught it but a human rereading five files.

Checks are derived from the artifacts themselves. There is deliberately no separate
manifest file: a manifest is one more thing to drift.

    python3 tests/check_versions.py [-v]
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERBOSE = "-v" in sys.argv
PASSED, FAILED = 0, 0


SKIPPED = 0


def skip(name, reason):
    """Report a check that could not run. Never silently omit one.

    A check that vanishes is indistinguishable from one that passed, which is the
    exact failure the gate ledger was built to surface. The v5 distribution has
    no promptnexus-v6/ directory, so the generation checks cannot run there — and
    that must be visible in the output, not inferred from a lower total.
    """
    global SKIPPED
    SKIPPED += 1
    print(f"  SKIP  {name} — {reason}")


def check(name, cond, detail=""):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        if VERBOSE:
            print(f"  PASS  {name}")
    else:
        FAILED += 1
        print(f"  FAIL  {name}{(' — ' + detail) if detail else ''}")


def read(name):
    path = os.path.join(ROOT, name)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def main():
    print("cross-artifact consistency")

    shipped = sorted(f for f in os.listdir(ROOT) if os.path.isfile(os.path.join(ROOT, f)))
    core_name = next((f for f in shipped if f.startswith("framework_v") and f.endswith("_core.md")), None)
    card_name = next((f for f in shipped if f.startswith("quick_select_card_")), None)
    proto_name = next((f for f in shipped if f.startswith("orchestration_protocol_")), None)
    lib_name = next((f for f in shipped if f.startswith("domain_pattern_library_")), None)
    has_eval = os.path.isdir(os.path.join(ROOT, "eval")) and \
        os.path.exists(os.path.join(ROOT, "eval", "harness.py"))
    has_adv = os.path.isdir(os.path.join(ROOT, "adversarial")) and \
        os.path.exists(os.path.join(ROOT, "adversarial", "scorer.py"))

    check("core document present", core_name is not None)
    check("quick-select card present", card_name is not None)
    check("orchestration protocol present", proto_name is not None)
    check("domain pattern library present", lib_name is not None,
          "core §0 and §2 both reference it as a shipped artifact")
    check("adversarial corpus + scorer present", has_adv,
          "framework §8 references the corpus as the discharged test set")
    check("eval harness present", has_eval,
          "core footer lists eval/ as a shipped artifact")
    if not core_name:
        print(f"\n{PASSED} passed, {FAILED} failed")
        return 1

    core = read(core_name)
    card = read(card_name) if card_name else ""
    proto = read(proto_name) if proto_name else ""
    app = read("PromptNexus.jsx") or ""
    linter = read("prompt_lint.py") or ""

    # ── declared versions agree ──────────────────────────────────────────
    core_ver = re.search(r"CORE v(\d+\.\d+\.\d+)", core)
    check("core declares a version", core_ver is not None)
    core_ver = core_ver.group(1) if core_ver else "?"

    card_ver = re.search(r"QUICK-SELECT CARD v(\d+\.\d+\.\d+)", card or "")
    check("card version matches core", card_ver and card_ver.group(1) == core_ver,
          f"core {core_ver} vs card {card_ver.group(1) if card_ver else 'none'}")

    manifest_linter = re.search(r"Linter: v(\d+\.\d+(?:\.\d+)?)", core)
    actual_linter = subprocess.run([sys.executable, os.path.join(ROOT, "prompt_lint.py"), "--version"],
                                   capture_output=True, text=True).stdout
    check("core footer linter version matches prompt_lint --version",
          manifest_linter and manifest_linter.group(1) in actual_linter,
          f"footer {manifest_linter.group(1) if manifest_linter else 'none'} vs {actual_linter.strip()}")

    manifest_proto = re.search(r"Protocol doc: v(\d+\.\d+)", core)
    proto_ver = re.search(r"ORCHESTRATION PROTOCOL v(\d+\.\d+)", proto or "")
    check("core footer protocol version matches the protocol",
          manifest_proto and proto_ver and manifest_proto.group(1) == proto_ver.group(1),
          f"footer {manifest_proto and manifest_proto.group(1)} vs doc {proto_ver and proto_ver.group(1)}")

    wire_core = re.search(r"Wire protocol: (\d+\.\d+)", core)
    wire_proto = re.search(r"\[PROTOCOL:(\d+\.\d+)\]", proto or "")
    check("wire protocol version agrees",
          wire_core and wire_proto and wire_core.group(1) == wire_proto.group(1),
          f"core {wire_core and wire_core.group(1)} vs protocol {wire_proto and wire_proto.group(1)}")

    # ── no artifact points at a document that isn't shipped ──────────────
    for name, text in (("core", core), ("card", card), ("protocol", proto), ("pattern library", read(lib_name) or "")):
        # `framework v5.6.0+` states a compatibility floor and is not a pointer to a
        # document, so only bare references are checked. (Caught as a false positive
        # against the protocol's own compatibility line on this suite's first run.)
        for ref in set(re.findall(r"framework v(\d+\.\d+\.\d+)(?!\+)", text or "")):
            check(f"{name} references only the shipped core (v{ref})", ref == core_ver,
                  f"references v{ref}, shipped core is v{core_ver}")

    # ── gate names agree across spec, CLI, and app ───────────────────────
    contract = re.search(r"Verification Gate Contract.*", core)
    spec_gates = set(re.findall(r"\b([A-Z][A-Z_]{5,})\b", contract.group(0))) if contract else set()
    spec_gates -= {"GATE_FAIL", "NAME", "WARN", "FAIL", "GUARDED"}
    cli_gates = set(re.findall(r'"gate":\s*"([A-Z_]+)"', linter))
    app_gates = set(re.findall(r'gate:\s*"([A-Z_]+)"', app))
    # ADVERSARIAL_RESILIENCE is scorer-backed: the CLI surfaces it as a lint finding,
    # the app computes it through scoreResilience() and renders it in its own panel
    # rather than as a lintPrompt finding. Parity of the SCORER is enforced in parity.mjs;
    # here we just exempt it from the finding-name set comparison.
    SCORER_BACKED = {"ADVERSARIAL_RESILIENCE"}
    check("app implements scoreResilience for the scorer-backed gate",
          "function scoreResilience" in app or "scoreResilience" in app)
    check("CLI and app implement the same lint-finding gates",
          (cli_gates - SCORER_BACKED) == app_gates,
          f"cli-only {sorted((cli_gates - SCORER_BACKED) - app_gates)}, app-only {sorted(app_gates - (cli_gates - SCORER_BACKED))}")
    check("every implemented gate is named in the spec contract", cli_gates <= spec_gates,
          f"undocumented: {sorted(cli_gates - spec_gates)}")
    check("every gate in the spec contract is implemented", spec_gates <= cli_gates,
          f"unimplemented: {sorted(spec_gates - cli_gates)}")

    # The contract states a gate COUNT ("Annex D — N gates"); it must equal the number of
    # gate names it then lists, or the header contradicts its own body. (Caught during the
    # source audit: the contract said "14 gates" while enumerating 15.)
    count_claim = re.search(r"Annex D\s*[—-]\s*(\d+)\s*gates", core)
    if count_claim:
        claimed_n = int(count_claim.group(1))
        check("gate-count claim in the contract matches the gates listed",
              claimed_n == len(spec_gates),
              f"contract says {claimed_n} gates but lists {len(spec_gates)}")

    # ── stakes tiers agree across spec, CLI, and app ─────────────────────
    cli_tiers = set(re.findall(r'"(safety-critical|high|guarded|medium|low)":\s*[\d.]+', linter))
    app_tiers = {t.lower() for t in re.findall(r'\{id:"([A-Z-]+)",\s*color', app)}
    check("CLI and app agree on stakes tiers", cli_tiers == app_tiers,
          f"cli {sorted(cli_tiers)} vs app {sorted(app_tiers)}")
    for tier in cli_tiers:
        check(f"stakes tier '{tier}' appears in the core spec",
              tier.upper() in core or tier in core)

    # ── the footer's declared component count matches reality ────────────
    # This check exists because it was ABSENT: the footer said "FIVE artifacts" for
    # three releases while the changelog below it said NINE, and nothing caught it —
    # check_versions compared names, never the count word. A rationale doc rereading
    # five files by hand found it. Now it's mechanical.
    WORD = {"one":1,"two":2,"three":3,"four":4,"five":5,"six":6,"seven":7,"eight":8,
            "nine":9,"ten":10,"eleven":11,"twelve":12}
    m = re.search(r"Ships as ([A-Za-z]+) (?:artifacts|components)", core, re.I)
    if not m:
        check("footer declares a component count", False, "no 'Ships as N' line found")
    else:
        declared = WORD.get(m.group(1).lower())
        # Count what's actually shipped: top-level doc/code artifacts + component dirs.
        # Companion docs describe the system; they are not components OF it.
        # Companion docs describe the system; they are not components OF it. The v6 review
        # documents a different generation entirely, so counting it as a v5 component
        # would inflate the framework's own manifest.
        # Not components OF the framework: documentation about it, reviews of a
        # different generation, and build/distribution tooling. pack.py ships and
        # is load-bearing, but it packages the components rather than being one —
        # counting it would inflate the manifest the footer asserts.
        COMPANION = {"README.md", "DESIGN_RATIONALE.md", "design_reasoning.md",
                     "REVIEW-promptnexus-v6.md", "pack.py"}
        doc_artifacts = [f for f in shipped
                         if f.endswith((".md", ".py", ".jsx")) and f not in COMPANION]
        # dirs that are shipped components (not build/cache)
        comp_dirs = [d for d in ("adversarial", "eval", "standalone", "tests")
                     if os.path.isdir(os.path.join(ROOT, d))]
        actual = len(doc_artifacts) + len(comp_dirs)
        check(f"footer component count ({declared}) matches disk ({actual})",
              declared == actual,
              f"footer says {declared}, found {len(doc_artifacts)} files + {len(comp_dirs)} dirs = {actual}")

    # ── the card must not over-escalate a GUARDED task ───────────────────
    check("card carries the GUARDED path", "GUARDED" in (card or ""),
          "a bare safety keyword must not HALT to the full manual (Annex C §6)")

    # ── the committed standalone bundle must not be older than its source ─
    # Known-limitation closure: editing PromptNexus.jsx and skipping build.sh ships stale
    # code silently. This is §9's "local consistency, global inconsistency" in miniature.
    import hashlib
    app_src = os.path.join(ROOT, "PromptNexus.jsx")
    bundle = os.path.join(ROOT, "standalone", "app.js")
    if os.path.exists(bundle) and os.path.exists(app_src):
        src_hash = hashlib.sha256(open(app_src, "rb").read()).hexdigest()
        stamped = re.search(r"build-src-sha256:([0-9a-f]{64})", open(bundle, encoding="utf-8").read())
        check("standalone/app.js carries a build-src stamp", stamped is not None,
              "app.js has no build-src-sha256 stamp — rebuild with standalone/build.sh")
        if stamped:
            check("standalone/app.js is built from the current PromptNexus.jsx",
                  stamped.group(1) == src_hash,
                  "source changed since the bundle was built — run standalone/build.sh")
    else:
        check("standalone bundle + source both present",
              os.path.exists(bundle) and os.path.exists(app_src),
              "expected standalone/app.js and PromptNexus.jsx")

    # ── the protocol §9 DESYNC enumeration must be genuinely exhaustive ──
    # §9 labels its subtype list "exhaustive". That is a normative claim with no mechanism:
    # a future turn could emit [DESYNC:SOMETHING_NEW] in code and the claim would silently
    # go false — the same drift class we already police for gate names and versions, one
    # artifact over. This makes "exhaustive" enforced, and makes "spec-only vs implemented"
    # a tracked status instead of a silent gap.
    proto = read(proto_name) if proto_name else ""
    if proto and "DESYNC" in proto:
        # subtypes named in the §9 table (rows like "| LEDGER | ... |")
        sec9 = proto[proto.find("## 9."):] if "## 9." in proto else proto
        table_subtypes = set(re.findall(r"^\|\s*([A-Z][A-Z_]+)\s*\|", sec9, re.M))
        # every DESYNC subtype emitted or named anywhere in code + specs
        sources = [core, proto, read("prompt_lint.py") or "", app]
        for extra in ("eval/harness.py", "eval/reliability.py", "adversarial/scorer.py"):
            p = os.path.join(ROOT, extra)
            if os.path.exists(p):
                sources.append(open(p, encoding="utf-8").read())
        emitted = set()
        for src in sources:
            emitted |= set(re.findall(r"DESYNC:([A-Z][A-Z_]+)", src))
        emitted.discard("SUBTYPE")  # the <SUBTYPE> placeholder, not a real value

        check("protocol §9 claims to be exhaustive", "exhaustive" in sec9.lower())
        undeclared = sorted(emitted - table_subtypes)
        check("every emitted DESYNC subtype is in the §9 table (exhaustive claim holds)",
              not undeclared,
              f"emitted but not enumerated: {undeclared} — add to §9 or the 'exhaustive' claim is false")

        # Honest status tracking: a subtype in the table that appears in NO code file is
        # spec-only. That's allowed, but it must be visible, not silently claimed as live.
        code_sources = [read("prompt_lint.py") or "", app]
        for extra in ("eval/harness.py", "eval/reliability.py", "adversarial/scorer.py",
                      "standalone/serve.py"):
            p = os.path.join(ROOT, extra)
            if os.path.exists(p):
                code_sources.append(open(p, encoding="utf-8").read())
        code_blob = "\n".join(code_sources)
        implemented = {s for s in table_subtypes if f"DESYNC:{s}" in code_blob}
        spec_only = sorted(table_subtypes - implemented)
        # This is not a failure — it's a reported status. The check passes; it prints the
        # ledger so "specified but unexecuted" is never a surprise.
        check("§9 enumeration status is knowable (implemented vs spec-only tracked)", True)
        if spec_only and VERBOSE:
            print(f"        spec-only DESYNC subtypes (enumerated, not yet emitted in code): {spec_only}")

    # The app states its gate count in two places (the stat bar and the Lint tab label);
    # both must equal the number of gates lintPrompt actually implements. ADVERSARIAL_
    # RESILIENCE is scorer-backed and surfaced separately, so it is NOT one of them.
    # (Caught by an external source audit: a previous "fix" set the label to 15 while the
    # browser linter implements 14, so the two UI claims disagreed with each other.)
    lint_body = app[app.find("function lintPrompt"):app.find("function analyzePromptHeuristics")]
    browser_gates = set(re.findall(r'gate:\s*"([A-Z_]+)"', lint_body))
    stat_claim = re.search(r'l:"(\d+)",\s*sub:"Lint Gates"', app)
    label_claim = re.search(r"Prompt to lint \((\d+) deterministic gates", app)
    if stat_claim:
        check("app stat-bar gate count matches lintPrompt",
              int(stat_claim.group(1)) == len(browser_gates),
              f'stat bar says {stat_claim.group(1)}, lintPrompt implements {len(browser_gates)}')
    if label_claim:
        check("Lint tab label gate count matches lintPrompt",
              int(label_claim.group(1)) == len(browser_gates),
              f'label says {label_claim.group(1)}, lintPrompt implements {len(browser_gates)}')
    if stat_claim and label_claim:
        check("the app's two gate-count claims agree with each other",
              stat_claim.group(1) == label_claim.group(1),
              f'stat bar {stat_claim.group(1)} vs label {label_claim.group(1)}')

    # ── the two generations must stay honestly described ────────────────
    # A successor generation (promptnexus-v6) now sits in this directory. The top-level
    # README states which artifact owns what; these checks stop that statement from
    # becoming the very drift it documents.
    v6 = os.path.join(ROOT, "promptnexus-v6")
    top_readme = read("README.md") or ""
    if not os.path.isdir(v6):
        for name in ("top-level README acknowledges the v6 generation",
                     "v6 still ships no meta-compiler spec (v5 remains the compiler)",
                     "README's linter-implementation count matches reality"):
            skip(name, "promptnexus-v6/ not present (expected in a v5-only distribution)")
    if os.path.isdir(v6):
        check("top-level README acknowledges the v6 generation",
              "promptnexus-v6" in top_readme,
              "a successor is present but the README does not mention it")

        # v6 is a verification toolchain, not a meta-compiler. If that ever changes, the
        # README's central claim ("deleting v5 would delete the compiler") goes stale.
        v6_docs = os.path.join(v6, "docs")
        compiler_spec = []
        if os.path.isdir(v6_docs):
            for name in os.listdir(v6_docs):
                p = os.path.join(v6_docs, name)
                if os.path.isfile(p) and "<optimized_prompt>" in open(p, encoding="utf-8", errors="ignore").read():
                    compiler_spec.append(name)
        check("v6 still ships no meta-compiler spec (v5 remains the compiler)",
              not compiler_spec,
              f"v6 now contains a compiler spec ({compiler_spec}) — the README's ownership table is stale")

        # The linter count the README states must match reality. Three implementations is
        # the documented open problem; a fourth (or a silent retirement) must not pass.
        impls = []
        if os.path.exists(os.path.join(ROOT, "prompt_lint.py")):
            impls.append("prompt_lint.py")
        if "function lintPrompt" in app:
            impls.append("PromptNexus.jsx")
        if os.path.isdir(os.path.join(v6, "packages", "core", "src", "lint")):
            impls.append("promptnexus-v6")
        stated = "exists three times" in top_readme
        check("README's linter-implementation count matches reality",
              (len(impls) == 3) == stated,
              f"found {len(impls)} implementations {impls}; README says three: {stated}")

    tail = f", {SKIPPED} skipped" if SKIPPED else ""
    print(f"\n{PASSED} passed, {FAILED} failed{tail}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
