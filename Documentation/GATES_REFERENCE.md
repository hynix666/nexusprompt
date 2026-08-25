# Lint Gates Reference

This table is the **target** inventory: the 16 gates emitted by `prompt_lint.py`, the linter in `files_4.zip`, each to be ported as a pure function returning a `GateResult` (see `CONTRACTS.md`).

> **Built so far: 2 of 16.** `SECRET_LEAK_SCAN` and `CLAIM_DISCIPLINE` are implemented in `core/src/gates/`, registered in `registry.ts`, and verified against the frozen linter by `npm run differential`. The other fourteen are named below and nowhere else — `npm run differential` prints them as "not yet ported" on every run, and `scripts/ported-gates.json` pins the set so it cannot shrink unnoticed.
>
> An earlier version of this line said "`core/gates/` implements 16 gates" in the present tense, and that each gate ships with a fixture test and a property test. Both were written before any code existed, and neither was corrected when it did. The two that exist do have fixture and property tests; that is a description of two files, not a policy anything enforces.

> **Counted, not inherited.** This table previously claimed 17 gates, listed one (`GUARDRAIL_COMPLETENESS`) that exists in no source, and omitted two that do. The inventory below is the verified set — see [`SOURCE_VERIFICATION.md`](./SOURCE_VERIFICATION.md). The source implements these as inline checks inside a single `lint()` function; porting them as 16 separately testable pure functions is a decomposition, and gate-by-gate behavioral parity against `fixtures.json` is the exit criterion for that work.

## Which sixteen — the lineage question

The frozen v5 linter emits exactly the sixteen ids below, and `core/src/gates/registry.ts`
registers the same sixteen. `scripts/differential.ts` fails when the two sets disagree, so
this cannot drift silently.

A **sibling lineage** — the System Prompt Builder, at v6.2.x — also has sixteen gates, but
not the same sixteen: it carries `JSON_SCHEMA_MALFORMED` where this one carries
`CONTEXT_LIMIT`. That is a difference between two descendants of the v5 framework, not a
gate this port dropped. Adding it here would mean a seventeenth gate with no counterpart in
the oracle, which is a decision (and an ADR), not a bug fix. Recorded so the next audit
comparing the two trees does not have to re-derive it.

Two gates deliberately **diverge** from the frozen linter, each declared in
`scripts/divergence-allowlist.json` with a reason and an ADR — see the table below.

Verdicts below are **read from the emission sites** in `prompt_lint.py`, not from prior documentation. An earlier revision of this table stated the wrong verdict for five gates — most consequentially `SECRET_LEAK_SCAN`, documented as FAIL when the source deliberately emits WARN because "a hit means *look here*, not proof."

| Gate ID | Checks | Verdict triggers |
|---|---|---|
| `PLACEHOLDER_AUDIT` | Every `{{variable}}`-style placeholder is declared somewhere in the prompt's runtime-variable section | FAIL if an undeclared placeholder is referenced |
| `RUNTIME_KEY_UNDECLARED` (1.1.0) | Runtime keys used in logic are declared before use | FAIL on first undeclared reference. **Diverges from the source** — the manifest is a declaration list, not a span to end-of-file, so a *use* cannot declare itself (ADR-0010) |
| `SOURCE_LEDGER_MISSING` | Any claim of external fact carries a source reference | FAIL when citations are present but no ledger exists |
| `ADVERSARIAL_RESILIENCE` | Prompt resists known jailbreak/injection patterns from `core/scorer`'s corpus | FAIL below the corpus pass-rate threshold; WARN in a middle band |
| `QUTM_CEILING` (1.1.0) | Quoted-untrusted-text-to-model ratio stays under budget | FAIL over the ceiling for the declared tier (`safety-critical` 12.0 → `low` 1.2). **Diverges from the source** — not armed below a 120-token baseline, where the ratio measures the brief's brevity rather than the prompt's bloat (ADR-0011) |
| `DELIMITER_ENTROPY` | Anti-override delimiters carry ≥32 hex characters (≥128 bits) | FAIL on insufficient entropy |
| `CONTEXT_LIMIT` | Estimated token count stays under the target model's context window | WARN over the provider's configured limit |
| `SECRET_LEAK_SCAN` | Heuristic scan for credentials and PII in the compiled prompt's own text | **WARN** on any match — a hit indicates where to look, not a proven leak |
| `RAG_SHIELD_GAP` | Retrieved/untrusted content is fenced and instructed-against for instruction-following | FAIL when the shield instruction is absent (opt-in via `--rag-target`) |
| `ORPHAN_CLAIMS` | Every citation resolves to an entry in the source ledger | FAIL on an orphaned citation |
| `GUARDRAIL_GAP` | Declared risk categories have a corresponding guardrail instruction | **FAIL at safety tier, WARN below it** — severity is conditional on the declared tier |
| `RECURSION_MACHINERY_PRESENT` | Recursive instruction machinery appears where the target is not flagged recursive | FAIL when recursion tokens are present (opt-in via the recursive-target flag) |
| `TOKEN_BUDGET` | Compiled prompt fits the declared token budget for its stage | FAIL over budget |
| `TOKEN_SPAM` | Repetitive filler and padding that inflate token count without adding instruction | WARN on repetition threshold |
| `DUPLICATE_INSTRUCTION` | The same instruction is not issued more than once, where restatement can conflict or dilute | WARN on duplicated instruction |
| `CLAIM_DISCIPLINE` | No unhedged claims about live capability where `demo_mode` is true | **WARN** when demo-mode output presents itself as live |

Two gates carry conditional severity — `GUARDRAIL_GAP` (tier-dependent) and `ADVERSARIAL_RESILIENCE` (banded by score). Both must be ported as conditionals; flattening either to a single verdict silently changes behavior. The remaining gates emit one severity unconditionally.

**Confirmed against the fixture corpus.** Every severity above matches the expected `(gate, severity)` pair asserted in `sources/v5/fixtures.json`, which was written independently of this table — `GUARDRAIL_GAP` appears there as two cases, one `WARN` below the safety tier and one `FAIL` at it. Fifteen of the sixteen gates have fixture coverage; `ADVERSARIAL_RESILIENCE` has none, because it is opt-in and needs the adversarial corpus at runtime. Do not read a green fixture run as full gate coverage.

**No gate reads catalog data.** An earlier revision of this document described two catalog-linked gates resolving `technique_id`s through `catalog/tools/gate-extensions/`. That directory does not exist, and neither do the gates — the technique catalog and the gate set are independent in every source. If a technique-marker gate is wanted, it is new work with a new ADR, not a port.

## Gate governance

Each gate has a stable `gate_id` and an independently incremented `gate_version` (see `GateResult` in `CONTRACTS.md`). The `gate_id` is permanent — retiring a gate means marking it retired, never reusing the identifier. `gate_version` bumps whenever the gate's verdict behavior changes for any input, so a stored `GateResult` always records which implementation produced it. Gate versions are distinct from contract schema versions and from the Core build hash; all three appear in a revision's `execution_provenance`.

## Adding a gate

A new gate needs: the pure function in `core/gates/`, a fixture test, at least one property test asserting an invariant, a `GateResult`-compliant return shape, and an entry in `scripts/ported-gates.json` so the differential oracle knows to compare it.

**Nothing enforces the property-test requirement.** This line previously said CI did. CI now exists (23 August 2026) and runs `npm run verify` on every push — boundary check, typecheck, source-freeze check, tests, then the oracle — but *that* is still what runs, and it will not notice a missing property test. The requirement remains a review convention.

A `scripts/new-gate.ts` generator to scaffold all four is **planned, not built** — it exists in no source archive, despite earlier drafts of this document and `CONTRIBUTING.md` instructing contributors to use it. Write the files by hand until it does, and keep the checklist above as the review standard.

## Running gates standalone

```
npm run verify:gates -- --input path/to/prompt.md
```
Produces a JSON array of `GateResult`s and a human-readable summary. No network access is used or permitted inside gate evaluation.
