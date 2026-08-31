# ADR-0014: A malformed response is not demo mode

**Status:** Accepted — 30 August 2026
**Authorises:** `MALFORMED_RESPONSE` in `provider-failure` 1.1.0, and the second placeholder Core will produce for it.
**Related:** ADR-0002 (contract-first design), ADR-0005 (application/orchestration boundary).

## Context

Demo mode is the mechanism this repository is built around. When no provider answers, the
Application classifies the failure and Core deterministically maps it to
`⟦WORKFLOW DEMO — no model⟧`. The placeholder is not decoration; `demoPlaceholder` in
`core/src/stages/stage-kit.ts` emits, in words:

> No output was produced. The text you are reading is a placeholder,
> not model output, and nothing below it was generated.

Every one of the eight categories in `provider-failure` 1.0.0 makes that sentence true.
`TIMEOUT`, `RATE_LIMIT`, `AUTH`, `UNAVAILABLE`, `INVALID_REQUEST`, `CONTENT_FILTER`,
`INTERNAL` and `CANCELLED` differ in cause and in whether a retry helps. Structurally they
are one situation: **no response arrived.**

A local model breaks that assumption, and this is the first change that introduces one. A
model reached over `localhost:11434` answers. The answer can still be unusable — JSON wrapped
in conversational prose, a truncated object, an unclosed fence, an empty completion. The call
succeeded. Bytes came back. The model *did* run.

Both proposal documents driving this work specify routing that outcome to the demo marker:

> If parsing fails after repair, classify as `STRUCTURED_OUTPUT_FAILURE` and emit
> `⟦WORKFLOW DEMO — malformed local output⟧`.

## Decision

**Do not.** A malformed response gets its own category and its own placeholder.

`provider-failure` 1.1.0 adds `MALFORMED_RESPONSE`, defined as *a response arrived and could
not be used* — the only value in the enum that means the model answered. A follow-up PR adds
the Core mapping and a distinct marker; this ADR authorises the split, and the contract lands
first per ADR-0002.

## Why

**The demo placeholder would become a false statement.** "No output was produced" is not a
hedge or a stylistic choice — it is a factual claim about the run, and it is what makes the
marker worth trusting. Emitting it about a run where a model produced 800 tokens of
unparseable text is a lie in the cheaper direction, and it is exactly the class of failure the
mechanism exists to prevent.

**The marker's meaning is load-bearing elsewhere.** `⟦WORKFLOW DEMO — no model⟧` is pinned as
a literal in `core/src/eval/detectors.ts` and `core/src/eval/probes.ts`, and
`TRUTH_BOUNDARY.md`'s opening entry rested on it: *nothing here has ever talked to a model*. If
the marker can also mean "a model talked and we could not read it", that entry stops being
checkable by the marker, and the first local run would silently weaken a claim the build
enforces.

> **Since 31 August 2026 the first local run has happened**, and the separation this ADR
> argued for is what let the boundary be re-declared rather than quietly abandoned. The entry
> now reads *local models have answered; nothing this repository REPORTS came from one* —
> a narrower claim that is still checkable, precisely because a degraded stage and a stage
> whose answer could not be read carry different markers.

**The two outcomes need different responses.** "No provider answered" is an environment
problem: no key, no daemon, wrong port. "The model answered unusably" is a model or prompt
problem: wrong temperature, too small a model, a stage instruction the model cannot follow. An
operator shown the same text for both is sent to debug the wrong thing. `retriable` differs
too — resampling a stochastic model may well parse, where an `AUTH` failure never will.

**It is the same distinction the comparator already enforces.** A suite below the discordance
floor is `refused`, not `inconclusive`, because "we could not have seen anything" and "we
looked and saw nothing" must not collapse into one verdict. This is that rule applied one
layer down: "no model ran" and "a model ran and we could not use it" are different facts, and
a system that reports them identically has thrown one away.

## Consequences

**Easier.** An operator can tell an unreachable provider from an unusable model without
reading logs. `providerAnswered` gives every call site one predicate instead of a
category list each has to keep correct.

**Harder.** Two placeholders now exist, so anything that recognises "this text is a
placeholder" has to recognise both. That matters more than it sounds: `isDemoText` exists
because `refine` was observed rewriting a degraded placeholder into clean-looking prose with
no marker on it — the run still reported `demo_mode: true` while the artifact stopped saying
so. A second marker that the laundering predicate does not know about would reopen exactly
that hole, on the path that now actually reaches a model. The follow-up PR must widen the
predicate, not add a parallel one.

**To revisit.** `PipelineOutcome.demo_mode` is a boolean, and a run where the model answered
unusably is not demo mode by this ADR's own reasoning — but it is not a clean run either.
Whether that field needs a third state, or a sibling, is deferred until the adapter exists and
there is a real run to look at. Deciding it now would be designing against an imagined shape.

## Alternatives rejected

**Reuse `INTERNAL`.** It reads as "the provider had a fault", the response never arrives, and
it would put the demo placeholder back on a run that reached a model. It fails for the same
reason as every other existing value.

**Name it `STRUCTURED_OUTPUT_FAILURE`,** as the proposals do. That scopes the value to
structured output when the situation is general — an empty completion and a truncated one are
the same structural event and neither is about structure. `MALFORMED_RESPONSE` also mirrors
`INVALID_REQUEST`: our request was bad, versus their response was bad.

**Infer it downstream from the message.** The Application would have to decide by inspecting
text, which is precisely what typed failures exist to stop — `provider-failure`'s own
description says adapters return this "so the Application can classify without parsing
messages".
