# ADR-0011: QUTM_CEILING does not arm below a named baseline floor

**Status:** Accepted — 25 August 2026
**Authorises:** entry 2 in `scripts/divergence-allowlist.json`, and the `only_when_options`
field it needed.
**Related:** ADR-0007 (the differential oracle is permanent), ADR-0010 (the sibling divergence).

## Context

`QUTM_CEILING` enforces a cost ratio: the compiled artifact's token estimate divided by a
naive-prompt baseline, against a per-tier ceiling. The port inherited the source's arming
condition, which is simply "a stakes tier was declared":

```python
baseline = naive_tokens if naive_tokens is not None else 400
cost_ratio = math.floor((est / max(1, baseline)) * 100 + 0.5) / 100
```

A compiled system prompt is *necessarily* many times longer than the brief it was compiled
from. That is the entire point of compiling one. So the ratio, at a short baseline, measures
the brief's brevity rather than the prompt's bloat. Measured against a correct 900-token
prompt:

| baseline | ratio | `guarded` ceiling 4× | `safety-critical` ceiling 12× |
|---|---|---|---|
| 1 token | 900 | FAIL | FAIL |
| 40 tokens | 22.5 | FAIL | FAIL |
| 120 tokens | 7.5 | FAIL | PASS |
| 230 tokens | 3.91 | PASS | PASS |

The tiered ceilings do not rescue it — `low`'s 1.2× ceiling fails at a full 400-token
baseline with a ratio of 2.25. The System Prompt Builder recorded the same finding as B7,
measuring 5.6× against its flat 4× ceiling on a correct prompt and 318× on an empty brief,
and fixed it with a `QUTM_MIN_BASELINE_TOKENS` floor of 120.

## Decision

`QUTM_CEILING` does not arm when the baseline is below **`QUTM_MIN_BASELINE_TOKENS = 120`**.
It reports `QUTM_CEILING.baseline_too_small` — a distinct message code, not a bare pass.

The constant is **named and exported from `lint-primitives.ts`**, not spelled into the
comparison. A threshold inlined at its call site is a guard whose scope nothing can state,
which is how a check ends up quietly narrower than its name.

The floor is checked **after** the unknown-tier refusal. A misspelled tier is a configuration
error and must surface whatever the baseline is; ordering the floor first would hide a typo
until someone happened to supply a long brief.

## Why no absolute prompt-token floor

The System Prompt Builder paired its baseline floor with an absolute one — the gate applied
only above 600 prompt tokens. That second floor is **not** adopted here, and the reason is
specific rather than stylistic.

`scripts/differential.ts` carries a boundary case named `qutm-ceiling-crossing`: 1,932
characters at a 400-token baseline, giving a ratio of 1.2075. Half-up rounding yields 1.21 and
fails `low`'s 1.2 ceiling; truncation yields 1.20 and passes. A mutation probe added that case
because it is the **only shape in which half-up rounding is observable** — and rounding is the
cross-language hazard `budget.ts` exists to guard, the one no amount of parity testing can
surface because each side is internally consistent.

That case is 483 prompt tokens. A 600-token floor would disarm it, silently deleting the
repository's only rounding detector as a side effect of an unrelated fix. The baseline floor
alone already covers the reported defect: at a baseline of 120 or more, a prompt must exceed
480 tokens to reach even a 4× ratio, so it is substantial by construction.

## Consequences

**The divergence is option-shaped, and the allowlist had to grow to say so.** It appears for
*any* text whose baseline is under the floor, so the only text regex covering it is `.*` — and
a blanket `.*` entry pinning `FAIL`/`PASS` would also excuse `qutm-ceiling-crossing`, because
a rounding drift produces exactly that verdict pair. Declaring one deliberate difference must
not cost an unrelated regression detector.

`scripts/divergence-allowlist.json` entries therefore accept `only_when_options`, a narrowing
constraint on the case's options (`lt`, `lte`, `gt`, `gte`, `eq`). An option a case does not
carry is **not** satisfied: absence must not excuse by omission. An unknown operator fails the
allowlist rather than reading as satisfied. This is the second addition to ADR-0007's original
`{gate, case, reason, adr}` sketch, after pinning both verdicts, and is recorded here rather
than left as an undocumented divergence from the divergence mechanism.

A mutation probe confirms the narrowing is load-bearing rather than decorative: with
`only_when_options` present, mutating `halfUp2` to truncation still fails the build; with the
field removed and the same mutation applied, the build passes.

**`naiveTokens: 0` moved where it is observable.** The source's "an explicit 0 is a baseline,
not a falsy default" fix is still enforced, but now via message code — `baseline_too_small`
for an explicit 0 versus `exceeded` for an absent option defaulting to 400. Reintroducing
`options.naiveTokens || 400` substitutes 400 for the 0 and produces `exceeded`, which the
suite catches. A verdict-only comparison would not.

**The gate still bites.** Tests pin that bloated output above the floor still fails, at two
tiers. A floor that disarmed the gate everywhere would be a deletion wearing a threshold.

## The version this moved

`QUTM_CEILING` goes to **1.1.0**, for the reason ADR-0010 records: `gate_version` is a
provenance claim persisted in every revision, and this change altered when the gate arms.
`TOKEN_BUDGET` and `CONTEXT_LIMIT` share `budget.ts` and stay at 1.0.0 — which is only
expressible because the version constants were split per gate rather than per module.

## Alternatives rejected

**Raise the ceilings instead.** The ceilings are framework §5.9 values with their own lineage;
changing them to work around a denominator problem would misattribute the defect and diverge
on far more cases.

**Leave it faithful and document it.** The gate is unclearable for the layout the framework
prescribes, so every real run would carry a standing false FAIL. A caveat beside a failing
gate gets the gate disabled, not the caveat read.
