#!/usr/bin/env python3
"""prompt-lint v1.4.0 — deterministic linter for compiled prompts (Annex D, framework v5.7.0).

Closes the "ghost contract" gap: this is the reference implementation of the external
verification layer specified in Section 0.5. It performs string operations the LLM
should never be trusted to do on its own output: placeholder audits, runtime-key
manifest checks, orphan-citation cross-reference, guardrail completeness, token
budget estimation, recursion-machinery detection in recursive targets, and a
heuristic scan for accidentally-embedded secrets.

Usage:
    python prompt_lint.py compiled_prompt.md [--token-budget N] [--recursive-target]
    cat compiled_prompt.md | python prompt_lint.py - [--json]
    python prompt_lint.py --version

Exit codes: 0 = PASS · 1 = GATE_FAIL (a FAIL-severity finding is present) ·
2 = usage/IO error · 3 = DEGRADED (WARN-only findings; shippable per Annex C §7,
but distinct from a clean PASS so CI can choose to gate on it or not).
No third-party dependencies. Token estimate is chars/4 (documented approximation;
swap in tiktoken if available — see estimate_tokens()).

v1.1 changelog (validated against Review 1/2 of prompt_lint, Review 2 of PromptNexus,
Review KIMI, Review DeepSeek — see accompanying validation report for what was and
wasn't confirmed):
  - Gate 3 (ORPHAN_CLAIMS): fixed lexicographic sort of numeric source ids (sorted
    ["10","2"] as strings before; now sorts by int value). Matches the JS port.
  - Gate 6 (TOKEN_BUDGET): `if token_budget:` skipped a budget of exactly 0; now
    `is not None`. Matches the JS port's `!= null` check.
  - Gate 2 (TOKEN_SPAM): now counts against the same fence/backtick-stripped text
    Gates 1/4/5/7 already use, instead of raw, unstripped text. This reconciles the
    Python/JS divergence (the JS port already used the stripped text) and, as a side
    effect, removes the old all-or-nothing exemption where a single backtick-quoted
    mention of a tag anywhere in the document exempted unlimited raw spam elsewhere.
  - Gate 7 (CLAIM_DISCIPLINE): tightened the 100% regex to allow zero-or-more spaces
    (`100%accurate` previously slipped through).
  - `estimate_tokens(text)` is now computed once per `lint()` call instead of twice.
  - Added "bias" to the safety-tier guardrail clause set (§4 Bias & Fairness Shield
    had zero coverage at any tier — validated gap, see report).
  - Added `--rag-target` (mirrors `--recursive-target`): when a compiled prompt
    declares RAG/retrieval evidence handling, checks for the presence of the §4 RAG
    Shield's operational language. Off by default — same opt-in shape as Gate 5.
  - Added Gate 8 (SECRET_LEAK_SCAN, WARN): heuristic regex scan for accidentally
    embedded API keys/tokens in the compiled prompt's own text. This is distinct
    from the GUARDRAIL_GAP "sanitiz" check, which only verifies the compiled prompt
    *instructs* the target agent to redact PII — it does not scan the compiler's
    own output for a leaked secret.
  - Added `--version`.
  - NOT changed (claims investigated and found unsupported by the source — see
    report): PLACEHOLDER_AUDIT already strips fences before auditing in both
    Python and JS; no change needed there.

v1.3.0 changelog:
  - Added Gate ADVERSARIAL_RESILIENCE (opt-in, --adversarial). Scores the prompt against
    adversarial/corpus.json via the shared deterministic scorer and fails if any of the
    three §4 surfaces (input/source/ledger) has zero defense signal, or if overall
    coverage is below --adversarial-floor (default 0.5). This discharges framework §8's
    written promise to run a test set rather than emit [ASSUMPTION:adversarial_untested].
    Substring proxy, not proof — the app's semantic gate tier judges the property; this
    is the fast offline floor both share. No-ops (with a WARN) if the corpus isn't found.
  - --semantic-note: prints the one-line reminder that deterministic gates gate and
    judged gates advise, for CI logs.

Gate 7b (DUPLICATE_INSTRUCTION, unversioned addendum, WARN, additive/non-breaking):
  - A whitespace-normalized paragraph appearing 2+ times verbatim in the audited text
    now fires a WARN. Targets the failure mode where an instruction/guardrail block
    gets double-pasted during iterative editing (Harden/Refine passes) — harmless to
    token count alone, but a silent contradiction risk the moment only one copy is
    ever edited again. 60-char floor exempts incidental short repeats (a bullet, a
    divider) that are normal document structure, not a defect. Same threshold and
    truncation in the JS port (PromptNexus.jsx); parity.mjs does not compare detail
    strings, only gate name + severity, so exact wording is free to differ.

v1.2.2 changelog:
  - SECRET_PATTERNS quantifiers bounded on both ends (was: `+`, `{20,}`, `{8,}`).
    Unbounded quantifiers scanned quadratically against long non-matching runs —
    linting a ~500 KB prompt hung for minutes on the pii_email pattern alone.
    Found by running the JS port's own test suite against a 600k-char input.
    Same fix applied to the JS port in PromptNexus.jsx.

v1.2.1 addendum (this pass — validated directly against framework_v5_7_0_core.md,
orchestration_protocol_v1_1.md, and PromptNexus.jsx as actually uploaded, not just the
review text):
  - Fence stripping now honors the CommonMark length rule — a fence opened with N
    backticks closes only on >=N backticks, so ``` lines inside a ```` block are
    content, not toggles. [already present on arrival, confirmed correct]
  - QUTM_CEILINGS was missing "guarded" (4x per framework §5.9) — `--stakes guarded`
    was not even a valid argparse choice, despite GUARDED being v5.7.0's marquee
    fix. Added.
  - Gate 9 (DELIMITER_ENTROPY) dropped its raw-text fallback for documents with a
    "Data Isolation" heading. That fallback bypassed strip_documentation_spans
    specifically for this gate, so a compliant BLOCK V that illustrates the old,
    deprecated short-nonce form as a backtick-quoted counter-example would
    raw-text-scan as a FAIL. The real, delivered nonce in BLOCK V is prose in the
    live prompt body, never fenced, so scanning audit_text loses nothing realistic.
  - --safety-tier help text clarified: it now gates GUARDED+ (per framework §6
    "FAIL at GUARDED+, WARN below"), not literally SAFETY-CRITICAL only. The flag
    name is kept for CLI stability; only the help text changed.

v1.2 changelog (framework v5.7.0 release — sources: Comprehensive Analysis §3.2/§4.1/§4.2,
Review 2 of prompt_lint §3, Review KIMI §1.2/§1.3, Review DeepSeek §3.1):
  - Fence stripping rewritten as a line-based state machine: an UNCLOSED fence now
    strips to EOF (documented, deterministic) instead of the old dot-all regex
    silently not matching and leaving the whole block auditable.
  - Gate 8 extended with PII heuristics (email, intl phone) alongside secret keys.
  - Gate 9 (DELIMITER_ENTROPY, FAIL, auto): if the prompt declares a Data Isolation
    section or uses [INPUT_START_*] delimiters, the hex suffix must be >=32 chars
    (>=128-bit) per framework §4. The old 6-hex example is brute-forceable.
  - Gate 10 (QUTM_CEILING, FAIL, opt-in): --stakes {safety-critical,high,medium,low}
    [--naive-tokens N] computes cost_ratio = estimate/naive and enforces the §5.9
    ceilings (12x / 6x / 2.5x / 1.2x). Ceilings previously had zero enforcement.
  - --provider {anthropic,openai,google,ollama}: context-limit WARN + tokenizer note.
  - --quiet (findings only on failure) and --first-fail (stop at first FAIL) for CI.
  - Full type annotations on lint() and helpers.
"""

import argparse
import json
import math
import os
import re
import sys

SEVERITY_FAIL = "FAIL"
SEVERITY_WARN = "WARN"

REQUIRED_GUARDRAIL_CLAUSES = [
    "anti-override",
    "scope",
    "fact-grounding",
]
SAFETY_TIER_EXTRA_CLAUSES = [
    "sanitiz",       # input sanitization / sanitisation
    "recursion",
    "conflict",      # conflict-priority
    "bias",          # §4 Bias & Fairness Shield — previously unchecked at any tier
]
RECURSION_MACHINERY_TOKENS = [
    "[MEM_STATE]", "[ACTIVE_MEM_STATE]", "compilation depth",
    "{{COMPILATION_DEPTH}}", "{{STAKES_LEVEL}}", "meta-compiler",
]
# §4 RAG Shield 4-branch operational test: at minimum the compiled prompt should name
# the insufficient-retrieval acknowledgment token. This is a weak substring proxy for
# "the RAG Shield language is present," not a semantic check that the test is applied
# correctly — same limitation as GUARDRAIL_GAP generally (see docstring / report).
RAG_SHIELD_CLAUSES = [
    "insufficient_retrieval",
    "rejected_context",
]
# Heuristic, non-exhaustive patterns for secrets accidentally embedded in a compiled
# prompt's own text (e.g. a copy-pasted exemplar containing a real key). This is a
# different check from the "sanitiz" guardrail-clause-presence check above: that one
# verifies the compiled prompt *instructs* the target agent to redact PII at runtime;
# this one scans the compiler's own output for a leaked secret. WARN severity only —
# it is a heuristic scan, not a guarantee of absence.
SECRET_PATTERNS = [
    # Every quantifier here is BOUNDED on both ends. An open-ended `+` or `{n,}`
    # against a long non-matching run makes the scan quadratic (each start position
    # consumes the whole run, then backtracks one char at a time) — a 500 KB prompt
    # took minutes. Real keys and addresses fit inside these caps comfortably.
    (r"sk-ant-[A-Za-z0-9_-]{20,128}", "anthropic_api_key"),
    (r"sk-[A-Za-z0-9]{20,128}", "generic_sk_key"),
    (r"AKIA[0-9A-Z]{16}", "aws_access_key_id"),
    (r"ghp_[A-Za-z0-9]{30,128}", "github_token"),
    (r"xox[baprs]-[A-Za-z0-9-]{10,128}", "slack_token"),
    # PII heuristics (v1.2) — same WARN posture; a hit means "look here", not proof.
    (r"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}", "pii_email"),
    (r"\+[0-9][0-9 ().-]{8,20}[0-9]", "pii_phone_intl"),
]

# Gate 3 — a citation is a bracketed, comma-separated list of S-ids. The old
# `\[S(\d+)(?:,[^\]]*)?\]` captured only the first id and swallowed the rest, so
# `[S1,S2]` silently uncited S2 — a defect both v5 copies shared, so parity was blind.
# This shape matches `[S1]`, `[S1,S2]`, `[S1, S2,S3]` and nothing else, so prose like
# `[S1, p. 42]` does not leak a page number as a source.
CITATION_RE = re.compile(r"\[S\d+(?:\s*,\s*S?\d+)*\]")

# Gate 9 (v1.2) — §4 anti-override delimiters must carry >=32 hex chars (>=128-bit).
DELIMITER_RE = re.compile(r"\[INPUT_(?:START|END)_([0-9a-fA-F]+)\]")

# Gate 10 (v1.2) — §5.9 QUTM cost-ratio ceilings, output-tokens vs naive baseline,
# inclusive of framework/verification overhead by construction (the estimate covers
# the whole compiled artifact).
QUTM_CEILINGS = {"safety-critical": 12.0, "high": 6.0, "guarded": 4.0, "medium": 2.5, "low": 1.2}

# --provider context limits (WARN only; estimates are heuristic).
PROVIDER_CONFIGS = {
    "anthropic": {"context_limit": 200_000},
    "openai":    {"context_limit": 128_000},
    "google":    {"context_limit": 1_048_576},
    "ollama":    {"context_limit": 128_000},
}


def estimate_tokens(text: str) -> int:
    """Deterministic ~4 chars/token, identical to the JS port and the v6 core.

    Verdicts must not depend on which optional packages happen to be installed.
    The previous `try: import tiktoken` made TOKEN_BUDGET / QUTM_CEILING /
    CONTEXT_LIMIT environment-dependent and broke cross-language parity whenever
    tiktoken was present in one runtime and absent in the other — the differential
    oracle would have reported a disagreement caused by the environment, not the
    code. chars/4 is the contract all three implementations agree on. If exact
    tokenization is ever needed, add an explicit --tokenizer flag, never an
    ambient import.
    """
    return max(1, len(text) // 4)


def _clause_present(clause: str, low: str) -> bool:
    """Left-anchored word-boundary match for a guardrail clause.

    `\bscope` rejects "telescope" but accepts "scope:"/"scoped"; `\bbias` rejects
    "unbiased" but accepts "biases". The right edge stays free so stems ("sanitiz")
    still match their inflections. The old unanchored `clause in low` counted a
    clause as present inside any unrelated word — a false-clean on a safety gate.
    """
    return re.search(rf"\b{re.escape(clause)}", low) is not None


def extract_runtime_manifest(text: str) -> set:
    """Runtime Variables must be declared in a manifest section (P8 fix).
    Accepts a section headed 'Runtime Variables' listing [[KEY]] tokens."""
    declared = set()
    m = re.search(r"#+\s*Runtime Variables.*?(?=\n#|\Z)", text, re.S | re.I)
    if m:
        declared.update(re.findall(r"\[\[([A-Za-z0-9_:-]+)\]\]", m.group(0)))
    return declared


def extract_source_ledger_ids(text: str) -> set:
    """Collect S-ids defined in a source ledger table/rows like `[S3]` in a
    'Source ledger' section; fall back to any `[Sn]` on a table row."""
    ids = set()
    m = re.search(r"#+\s*Source ledger.*?(?=\n#|\Z)", text, re.S | re.I)
    scope = m.group(0) if m else ""
    # Only table rows count as declarations. Scanning the section for any [Sn]
    # let a citation *inside* the ledger section declare itself: a heading with
    # no entries, followed by prose citations, silenced both this gate and
    # ORPHAN_CLAIMS and the artifact passed. Found by tests/differential.mjs,
    # which compares against the independent v6 implementation — the parity
    # harness could not see it, because both v5 copies shared the defect.
    for sid in re.findall(r"^\s*\|\s*\[S(\d+)\]", scope, re.M):
        ids.add(sid)
    if not ids:  # fallback: table rows anywhere, ledger section or not
        for sid in re.findall(r"^\s*\|\s*\[S(\d+)\]", text, re.M):
            ids.add(sid)
    return ids


def strip_documentation_spans(text: str) -> str:
    """Remove fenced code blocks and inline backtick spans before auditing.
    Rationale: documents that *describe* the placeholder syntax (e.g. `<<...>>`
    in prose, or template schemas inside ``` fences) must not trip Gate 1.
    Lint targets the live prompt body; illustrative/template spans are exempt.
    To lint a template's fenced content itself, pass --include-fences.

    v1.2: line-based state machine instead of a dot-all regex. A fence opened
    with ``` and never closed strips to EOF — deterministic and safe-side
    (unclosed template block stays exempt rather than becoming auditable)."""
    out_lines = []
    fence_len = 0  # 0 = not in a fence; else backtick count of the OPEN fence
    for line in text.split("\n"):
        stripped_line = line.lstrip()
        if stripped_line.startswith("```"):
            ticks = len(stripped_line) - len(stripped_line.lstrip("`"))
            if fence_len == 0:
                fence_len = ticks            # opening fence
                continue
            if ticks >= fence_len:           # CommonMark: close needs >= open length
                fence_len = 0
                continue
            # shorter fence inside a longer one is CONTENT (e.g. ``` inside ````)
        if fence_len == 0:
            out_lines.append(line)
    stripped = "\n".join(out_lines)
    return re.sub(r"`[^`\n]*`", "", stripped)


def _score_adversarial(text):
    """Bridge to adversarial/scorer.py.

    Returns (result, reason). result is None when scoring could not run, and reason
    distinguishes an absent scorer from a broken one — reporting "corpus not found" for a
    malformed corpus.json would be a misleading diagnostic on a gate whose entire purpose
    is honesty about what was actually verified.
    """
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "adversarial", "scorer.py")
    if not os.path.exists(path):
        return None, "scorer not found at adversarial/scorer.py"
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("adv_scorer", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.score_resilience(text), None
    except Exception as exc:  # corpus malformed, import error, etc.
        return None, f"scorer failed to run: {type(exc).__name__}: {exc}"


def lint(text: str, token_budget: "int | None" = None, recursive_target: bool = False,
         safety_tier: bool = False, include_fences: bool = False, rag_target: bool = False,
         stakes: "str | None" = None, naive_tokens: "int | None" = None,
         provider: "str | None" = None, adversarial: bool = False,
         adversarial_floor: float = 0.5) -> dict:
    findings = []
    audit_text = text if include_fences else strip_documentation_spans(text)
    est = estimate_tokens(text)  # computed once; reused by Gate 6 and the return value

    # Gate 1 — Placeholder audit: <<...>> must be zero; [[...]] must be declared.
    unfilled = re.findall(r"<<[^<>]+>>", audit_text)
    if unfilled:
        findings.append({"gate": "PLACEHOLDER_AUDIT", "severity": SEVERITY_FAIL,
                         "details": sorted(set(unfilled))})
    declared = extract_runtime_manifest(text)
    used_runtime = set(re.findall(r"\[\[([A-Za-z0-9_:-]+)\]\]", audit_text))
    undeclared = used_runtime - declared
    if undeclared:
        findings.append({"gate": "RUNTIME_KEY_UNDECLARED", "severity": SEVERITY_FAIL,
                         "details": sorted(undeclared)})

    # Gate 2 — Bracket-token balance (terminal mode): every [TAG] opened in the
    # emission-order spec should appear at most defined once per spec line.
    # Counts against audit_text (already fence/backtick-stripped) rather than raw
    # text, so a tag documented once in prose doesn't blanket-exempt genuine spam
    # elsewhere, and so this matches the JS port's behavior (PromptNexus.jsx).
    dup_tags = [t for t in ("[ACK]", "[EXEC]", "[CLI]", "[MEM_STATE]")
                if audit_text.count(t) > 8]
    if dup_tags:
        findings.append({"gate": "TOKEN_SPAM", "severity": SEVERITY_WARN,
                         "details": dup_tags})

    # Gate 3 — Orphan-citation cross-reference (evidence mode).
    cited = set()
    for _m in CITATION_RE.finditer(audit_text):
        cited.update(re.findall(r"\d+", _m.group(0)))
    ledger = extract_source_ledger_ids(text)
    if cited:
        # key=int: cited/ledger are strings from regex groups, so a plain sorted()
        # is lexicographic ("10" before "2"); sort by numeric value instead.
        orphans = sorted(cited - ledger, key=int) if ledger else sorted(cited, key=int)
        if orphans and not ledger:
            findings.append({"gate": "SOURCE_LEDGER_MISSING", "severity": SEVERITY_FAIL,
                             "details": f"citations present ({len(cited)}) but no ledger section found"})
        elif orphans:
            findings.append({"gate": "ORPHAN_CLAIMS", "severity": SEVERITY_FAIL,
                             "details": [f"S{o}" for o in orphans]})

    # Gate 4 — Guardrail completeness.
    low = audit_text.lower()
    missing = [c for c in REQUIRED_GUARDRAIL_CLAUSES if not _clause_present(c, low)]
    if safety_tier:
        missing += [c for c in SAFETY_TIER_EXTRA_CLAUSES if not _clause_present(c, low)]
    if missing:
        findings.append({"gate": "GUARDRAIL_GAP",
                         "severity": SEVERITY_FAIL if safety_tier else SEVERITY_WARN,
                         "details": missing})

    # Gate 5 — Recursion machinery in recursive targets (strip, don't rename).
    if recursive_target:
        present = [t for t in RECURSION_MACHINERY_TOKENS if t.lower() in low]
        if present:
            findings.append({"gate": "RECURSION_MACHINERY_PRESENT",
                             "severity": SEVERITY_FAIL, "details": present})

    # Gate 5b — RAG Shield presence, opt-in via --rag-target (new in v1.1).
    # §4's RAG Shield previously had zero linter coverage at any tier. Like Gate 5,
    # this only fires when the caller asserts the target is a RAG/retrieval agent —
    # non-RAG targets legitimately have no reason to mention these tokens.
    if rag_target:
        missing_rag = [c for c in RAG_SHIELD_CLAUSES if c not in low]
        if len(missing_rag) == len(RAG_SHIELD_CLAUSES):
            findings.append({"gate": "RAG_SHIELD_GAP", "severity": SEVERITY_FAIL,
                             "details": "no RAG Shield acknowledgment token found "
                                        f"(expected one of: {RAG_SHIELD_CLAUSES})"})

    # Gate 6 — Token budget. `is not None` (not truthiness) so --token-budget 0
    # still runs the check instead of silently skipping it.
    if token_budget is not None:
        if est > token_budget:
            findings.append({"gate": "TOKEN_BUDGET", "severity": SEVERITY_FAIL,
                             "details": f"estimated {est} > budget {token_budget}"})

    # Gate 7 — Claim discipline (mechanical subset). \s* (not a literal space) so
    # "100%accurate" is caught alongside "100% accurate".
    overclaims = re.findall(r"\bguarantee[sd]?\b|\b100%\s*(?:accurate|safe|deterministic)\b",
                            low)
    if overclaims:
        findings.append({"gate": "CLAIM_DISCIPLINE", "severity": SEVERITY_WARN,
                         "details": sorted(set(overclaims))})

    # Gate 7b — Duplicate instruction block (new). A whitespace-normalized paragraph
    # (blank-line-separated block) that appears 2+ times verbatim usually means a
    # guardrail/instruction block got double-pasted during iterative editing, not
    # that repetition was intended. It wastes tokens now, and silently becomes a
    # contradiction the moment only one copy gets edited later. Paragraphs under the
    # length floor are exempt — a repeated bullet or divider is normal document
    # structure, not a defect; this targets substantive instruction blocks only.
    # Matches the JS port's threshold (60 chars) and truncation (96 chars) exactly,
    # though per parity.mjs detail strings are not compared, only gate+severity.
    para_counts: "dict[str, int]" = {}
    for para in re.split(r"\n\s*\n", audit_text):
        normalized = re.sub(r"\s+", " ", para).strip()
        if len(normalized) < 60:
            continue
        para_counts[normalized] = para_counts.get(normalized, 0) + 1
    dup_details = [
        f"{n}× — {p if len(p) <= 96 else p[:93] + '…'}"
        for p, n in para_counts.items() if n > 1
    ]
    if dup_details:
        findings.append({"gate": "DUPLICATE_INSTRUCTION", "severity": SEVERITY_WARN,
                         "details": dup_details})

    # Gate 8 — Secret-leak scan (new in v1.1, WARN, heuristic and non-exhaustive).
    # Checked against audit_text: a secret pattern shown as a documentation example
    # inside a fence/backtick span (e.g. "looks like sk-ant-...") is not a leak.
    leaked = sorted({label for pattern, label in SECRET_PATTERNS
                     if re.search(pattern, audit_text)})
    if leaked:
        findings.append({"gate": "SECRET_LEAK_SCAN", "severity": SEVERITY_WARN,
                         "details": leaked})

    # Gate 9 — Delimiter entropy (auto-armed). Fires when the compiled prompt uses
    # [INPUT_START_*] delimiters. Scanned on audit_text (fence/backtick-stripped),
    # consistent with every other gate. v1.2 originally fell back to raw `text`
    # whenever a "Data Isolation" heading was present, on the theory that the
    # declared nonce might otherwise hide inside a schema fence — but BLOCK V's
    # actual delivered nonce is prose in the live prompt body, never fenced, so
    # that fallback bought nothing while reopening exactly the false-positive
    # hole strip_documentation_spans exists to close: a compliant BLOCK V that
    # illustrates the *old, deprecated* short-nonce form as a counter-example
    # (in backticks, e.g. "not `[INPUT_START_ab12cd]`") would raw-text-scan as
    # a FAIL. Found while validating v1.2 against framework_v5_7_0_core.md.
    weak = sorted({m for m in DELIMITER_RE.findall(audit_text) if len(m) < 32})
    if weak:
        findings.append({"gate": "DELIMITER_ENTROPY", "severity": SEVERITY_FAIL,
                         "details": [f"{w} ({len(w)} hex chars < 32 minimum)" for w in weak]})

    # Gate 10 — QUTM cost ceiling (v1.2, opt-in via --stakes). cost_ratio compares
    # the compiled artifact's token estimate against a naive-prompt baseline
    # (--naive-tokens; defaults to 400 — a one-paragraph unstructured prompt).
    cost_ratio = None
    if stakes:
        # `0` is an explicit baseline, not an absent one: only None means "unset".
        # The truthiness form silently substituted 400 for a caller-supplied 0 —
        # the same defect the v1.2.1 changelog records fixing for TOKEN_BUDGET,
        # left unfixed on its sibling parameter. max(1, ...) below keeps the
        # division safe, so an explicit 0 yields est/1, matching the core.
        baseline = naive_tokens if naive_tokens is not None else 400
        # Half-up via floor(x*100+0.5)/100, bitwise-identical to the JS port.
        # Python round() is banker's and diverges from JS Math.round() at .005
        # boundaries — est=1 / baseline=200 gives 0.0 here and 0.01 there.
        cost_ratio = math.floor((est / max(1, baseline)) * 100 + 0.5) / 100
        ceiling = QUTM_CEILINGS[stakes]
        if cost_ratio > ceiling:
            findings.append({"gate": "QUTM_CEILING", "severity": SEVERITY_FAIL,
                             "details": f"cost_ratio {cost_ratio} > {ceiling} ceiling for {stakes}"})

    # Provider context-limit advisory (v1.2, opt-in via --provider).
    if provider and provider in PROVIDER_CONFIGS:
        limit = PROVIDER_CONFIGS[provider]["context_limit"]
        if est > limit:
            findings.append({"gate": "CONTEXT_LIMIT", "severity": SEVERITY_WARN,
                             "details": f"estimated {est} > {provider} context limit {limit}"})

    # Gate — ADVERSARIAL_RESILIENCE (v1.3, opt-in). Runs the shared corpus scorer.
    # An undefended surface is a hard FAIL: it's one systemic hole the prompt has no
    # language against. Low overall coverage is also a FAIL, below --adversarial-floor.
    if adversarial:
        scored, why = _score_adversarial(text)
        if scored is None:
            findings.append({"gate": "ADVERSARIAL_RESILIENCE", "severity": SEVERITY_WARN,
                             "details": f"cannot score ({why}) — treat as [ASSUMPTION:adversarial_untested]"})
        else:
            if scored["undefended_surfaces"]:
                findings.append({"gate": "ADVERSARIAL_RESILIENCE", "severity": SEVERITY_FAIL,
                                 "details": [f"undefended surface: {s}" for s in scored["undefended_surfaces"]]})
            elif scored["score"] < adversarial_floor:
                findings.append({"gate": "ADVERSARIAL_RESILIENCE", "severity": SEVERITY_FAIL,
                                 "details": f"resilience {scored['score']:.0%} < floor {adversarial_floor:.0%}"})

    status = "PASS"
    if any(f["severity"] == SEVERITY_FAIL for f in findings):
        status = "GATE_FAIL"
    elif findings:
        status = "DEGRADED"
    result = {"status": status, "findings": findings, "token_estimate": est}
    if cost_ratio is not None:
        result["cost_ratio"] = cost_ratio
    return result


def main():
    ap = argparse.ArgumentParser(description="Deterministic linter for compiled prompts")
    ap.add_argument("path", nargs="?", help="file path or '-' for stdin")
    ap.add_argument("--token-budget", type=int, default=None)
    ap.add_argument("--recursive-target", action="store_true",
                    help="target prompt was compiled under the recursion ceiling")
    ap.add_argument("--rag-target", action="store_true",
                    help="target prompt does retrieval/RAG evidence handling (§4 RAG Shield)")
    ap.add_argument("--safety-tier", action="store_true",
                    help="apply the GUARDED+ guardrail completeness set (pass this for "
                         "GUARDED, HIGH, and SAFETY-CRITICAL stakes — framework §6 says FAIL "
                         "at GUARDED+, not just SAFETY-CRITICAL; the flag name predates the "
                         "GUARDED tier and is kept for CLI stability, not literal accuracy)")
    ap.add_argument("--include-fences", action="store_true",
                    help="also audit fenced code blocks / inline code spans")
    ap.add_argument("--stakes", choices=sorted(QUTM_CEILINGS),
                    help="enforce the §5.9 QUTM cost-ratio ceiling for this stakes level")
    ap.add_argument("--naive-tokens", type=int, default=None,
                    help="baseline naive-prompt token count for --stakes (default 400)")
    ap.add_argument("--provider", choices=sorted(PROVIDER_CONFIGS),
                    help="context-limit advisory for the target provider")
    ap.add_argument("--adversarial", action="store_true",
                    help="score against adversarial/corpus.json (§8 resilience benchmark)")
    ap.add_argument("--adversarial-floor", type=float, default=0.5,
                    help="minimum overall resilience when --adversarial is set (default 0.5)")
    ap.add_argument("--quiet", action="store_true",
                    help="print findings only when status is not PASS")
    ap.add_argument("--first-fail", action="store_true",
                    help="exit 1 immediately after printing the first FAIL finding")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--version", action="store_true", help="print version and exit")
    args = ap.parse_args()

    if args.version:
        print("prompt-lint 1.4.0 (framework v5.7.0, Annex D reference implementation)")
        sys.exit(0)
    if not args.path:
        ap.error("the following arguments are required: path")

    try:
        # Byte-exact: the differential oracle hands v6 the raw bytes, so v5 must see
        # the same. Universal-newline translation turned \r\n into \n on this side
        # only, letting the two implementations lint different inputs.
        if args.path == "-":
            text = sys.stdin.buffer.read().decode("utf-8")
        else:
            with open(args.path, encoding="utf-8", newline="") as fh:
                text = fh.read()
    except OSError as e:
        print(f"prompt-lint: {e}", file=sys.stderr)
        sys.exit(2)

    result = lint(text, args.token_budget, args.recursive_target, args.safety_tier,
                  include_fences=args.include_fences, rag_target=args.rag_target,
                  stakes=args.stakes, naive_tokens=args.naive_tokens,
                  provider=args.provider, adversarial=args.adversarial,
                  adversarial_floor=args.adversarial_floor)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        ratio = f" cost_ratio={result['cost_ratio']}" if "cost_ratio" in result else ""
        if not (args.quiet and result["status"] == "PASS"):
            print(f"[{result['status']}] token_estimate={result['token_estimate']}{ratio}")
            for f in result["findings"]:
                print(f"  {f['severity']:4} {f['gate']}: {f['details']}")
                if args.first_fail and f["severity"] == SEVERITY_FAIL:
                    sys.exit(1)
    # 0 PASS · 1 GATE_FAIL · 3 DEGRADED — distinct so CI doesn't have to parse
    # stdout/JSON to tell a hard failure from a shippable-with-warnings result.
    sys.exit({"PASS": 0, "GATE_FAIL": 1, "DEGRADED": 3}[result["status"]])


if __name__ == "__main__":
    main()
