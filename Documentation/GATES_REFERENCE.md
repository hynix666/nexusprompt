# Lint Gates Reference

`core/gates/` implements **16 gates**, ported from the linter in `files_4.zip` — the latest revision of `prompt_lint.py`, which emits 16 distinct gate IDs. Every gate is a pure function returning a `GateResult` (see `CONTRACTS.md`). Each gate has both fixture tests and at least one property test asserting an invariant, not just an example.

> **Counted, not inherited.** This table previously claimed 17 gates, listed one (`GUARDRAIL_COMPLETENESS`) that exists in no source, and omitted two that do. The inventory below is the verified set — see [`SOURCE_VERIFICATION.md`](./SOURCE_VERIFICATION.md). The source implements these as inline checks inside a single `lint()` function; porting them as 16 separately testable pure functions is a decomposition, and gate-by-gate behavioral parity against `fixtures.json` is the exit criterion for that work.

Verdicts below are **read from the emission sites** in `prompt_lint.py`, not from prior documentation. An earlier revision of this table stated the wrong verdict for five gates — most consequentially `SECRET_LEAK_SCAN`, documented as FAIL when the source deliberately emits WARN because "a hit means *look here*, not proof."

| Gate ID | Checks | Verdict triggers |
|---|---|---|
| `PLACEHOLDER_AUDIT` | Every `{{variable}}`-style placeholder is declared somewhere in the prompt's runtime-variable section | FAIL if an undeclared placeholder is referenced |
| `RUNTIME_KEY_UNDECLARED` | Runtime keys used in logic are declared before use | FAIL on first undeclared reference |
| `SOURCE_LEDGER_MISSING` | Any claim of external fact carries a source reference | FAIL when citations are present but no ledger exists |
| `ADVERSARIAL_RESILIENCE` | Prompt resists known jailbreak/injection patterns from `core/scorer`'s corpus | FAIL below the corpus pass-rate threshold; WARN in a middle band |
| `QUTM_CEILING` | Quoted-untrusted-text-to-model ratio stays under budget | FAIL over the ceiling for the declared tier (`safety-critical` 12.0 → `low` 1.2) |
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

**No gate reads catalog data.** An earlier revision of this document described two catalog-linked gates resolving `technique_id`s through `catalog/tools/gate-extensions/`. That directory does not exist, and neither do the gates — the technique catalog and the gate set are independent in every source. If a technique-marker gate is wanted, it is new work with a new ADR, not a port.

## Gate governance

Each gate has a stable `gate_id` and an independently incremented `gate_version` (see `GateResult` in `CONTRACTS.md`). The `gate_id` is permanent — retiring a gate means marking it retired, never reusing the identifier. `gate_version` bumps whenever the gate's verdict behavior changes for any input, so a stored `GateResult` always records which implementation produced it. Gate versions are distinct from contract schema versions and from the Core build hash; all three appear in a revision's `execution_provenance`.

## Adding a gate

A new gate needs: the pure function in `core/gates/`, a fixture test, at least one property test asserting an invariant, and a `GateResult`-compliant return shape. CI enforces the property-test requirement.

A `scripts/new-gate.ts` generator to scaffold all four is **planned, not built** — it exists in no source archive, despite earlier drafts of this document and `CONTRIBUTING.md` instructing contributors to use it. Write the files by hand until it does, and keep the checklist above as the review standard.

## Running gates standalone

```
npm run verify:gates -- --input path/to/prompt.md
```
Produces a JSON array of `GateResult`s and a human-readable summary. No network access is used or permitted inside gate evaluation.
