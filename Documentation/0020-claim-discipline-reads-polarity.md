# ADR-0020: CLAIM_DISCIPLINE reads polarity; a denial of a guarantee is not a guarantee

**Status:** Accepted — 12 September 2026
**Authorises:** entry 8 in `scripts/divergence-allowlist.json`.
**Related:** ADR-0007 (the differential oracle is permanent), ADR-0010 and ADR-0011 (prior
divergences that fix a source defect), ADR-0017 (an extension rather than a fix).

## Context

`CLAIM_DISCIPLINE` flags unearned certainty in a compiled prompt. Both implementations match
the same regex over the whole text:

```python
r"\bguarantee[sd]?\b|\b100%\s*(?:accurate|safe|deterministic)\b"
```

A regex has no polarity. "We guarantee delivery" and "No guarantees on absolute accuracy" are
the same string as far as it is concerned, and both are flagged.

Until Phase 9 that was a suspicion. ADR-0007 named a neighbouring case — `guarantee-free`
matching on a hyphen boundary — as a candidate divergence and then declined it, correctly,
because the source shares it and an entry would have been stale on arrival.

## What changed: it was measured

`eval/precision-corpus/` holds 1,513 compiled prompts from eight models, and every gate firing
over them carries an adjudication (`eval/precision-adjudications.json`). `CLAIM_DISCIPLINE`
fired **19 times**, and **every one was a sentence refusing to guarantee something**:

| prompt says | gate says |
|---|---|
| "No guarantees on absolute accuracy or real-time updates." | unhedged claim |
| "It does NOT provide legal advice, perform substantive testing, or guarantee audit outcomes." | unhedged claim |
| "Never state that a process is *guaranteed* to work." | unhedged claim |
| "…avoiding authoritative guarantees." | unhedged claim |
| "Avoid certainty language (e.g. 'you must', 'this ensures', 'we guarantee')." | unhedged claim |

That is an exact 95% interval of **0.0%–17.6%** for this gate's firings being real defects:
`check:precision` computes it, and it is the worst of any gate measured.

The compounding detail is what settles the decision. The compile stage's own system prompt
(`core/src/stages/stage-kit.ts`) orders the model:

> never assert that a compiled prompt "guarantees" jailbreak-resistance, hallucination-freedom,
> or determinism — describe guardrails as reducing likelihood

So the pipeline instructs a model to disclaim guarantees, and then the gate flags it for
complying. A model that obeys the prompt scores worse than one that ignores it.

## Decision

The port reads the LINE around each match and ignores the match when that line

- negates, forbids or restricts the guarantee (`no`, `not`, `never`, `without`, `avoid…`,
  `cannot`, `refrain…`, `prohibit…`, `restrict…`, `exclud…`, `instead of`, `rather than`), or
- quotes it as a phrase being named rather than asserted, which on a line-sized window falls out
  of the same rule: the clause that bans the phrase carries the negation.

**The unit is the line, not the document.** A disclaimer in one bullet must not launder a claim
made in another; `claim-discipline.test.ts` pins that with a document containing one of each.

The line, rather than the sentence, because splitting on full stops broke five of the nineteen
cases on punctuation rather than meaning: `e.g.` severed a quoted `"guaranteed refund"` from the
`avoid certainty language` clause that governed it. A compiled prompt is a Markdown list, so the
bullet is the unit its author wrote in. The cost: a single line that both asserts and denies a
guarantee is excused. No such line occurs in the 1,513 prompts measured.

The gate goes to **1.2.0** — minor, not patch, for the same reason ADR-0017 gives in reverse:
it returns PASS on inputs it previously called WARN, which changes lint outcomes for callers
even though no existing true positive was reversed.

## What is deliberately NOT changed

`guarantee-free` still WARNs in both implementations. A hyphen is a word boundary, nothing in
that phrase is a denial, and ADR-0007's reasoning stands: the source shares the false positive,
there is no divergence to declare, and `claim-discipline.test.ts` keeps it pinned as WARN.

## Consequences

- One more permanent difference from the frozen linter, declared in the allowlist with a
  demonstration that fails the build if the divergence ever disappears.
- The gate can now miss a claim built out of a negation ("it is not true that we cannot
  guarantee this"). That shape did not occur in 1,513 prompts, and a gate that flags every
  disclaimer to catch it is the worse trade — the measurement is what says so.
- The 19 adjudications for this gate become stale and are removed with it, and the truth
  boundary's per-gate pins move: `check:precision` enforces both.
- The precision figure for `CLAIM_DISCIPLINE` is now unmeasured rather than 0.0%–17.6%: it
  fires nowhere on this corpus, and a corpus it never fires on cannot say whether it is right
  when it does. Measuring it again needs prompts that assert a guarantee, which these models,
  under this system prompt, do not write.
