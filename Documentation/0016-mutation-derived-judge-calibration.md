# ADR-0016: Judge calibration is measured against mutation-derived ground truth, not human labels

**Status:** Accepted — 3 September 2026
**Authorises:** `eval/judge-validation-fixtures.json`, `core/src/eval/judge-calibration.ts`,
`scripts/build-judge-calibration.ts`, `eval/judge-calibration.json`.
**Related:** ADR-0010, ADR-0011 (the differential oracle's declared-divergence pattern, which
this ADR follows for a different instrument), `core/src/eval/judge-policy.ts` (the `Calibration`
type this measurement satisfies).

## Context

`admitJudge` (`core/src/eval/judge-policy.ts`) refuses to let any judge grade anything without a
`Calibration` — a chance-corrected agreement value, against a named reference, that clears a
declared threshold. The type's own doc comment is explicit about what that reference is meant to
be:

> "Current production guidance is explicit that a judge contract is (pinned model id, versioned
> rubric, hashed template) and that re-calibration against human labels is required on every
> change to any of them."

This repository has no human-annotation infrastructure. Building one — recruiting or contracting
raters, writing a rating interface, running inter-rater reliability checks on the raters
themselves — is a substantially larger undertaking than the judge this ADR is calibrating, and
nothing else in this repository currently needs it.

## Decision

Calibrate the brief-fidelity judge against a **mutation-derived** reference instead. Twelve
clean `(brief, compiled_prompt)` pairs are hand-authored, each with four single-dimension
mutations — a deliberate, known change that should degrade exactly one of the rubric's four
dimensions (domain captured, constraints honored, completeness, no overreach) while leaving the
other three unaffected. A mutation is kept in the measurement only if it **isolates**: the judge's
score on its targeted dimension drops by at least 2 points from the clean baseline, and the other
three dimensions stay within 1 point of it. This is the same discipline
`core/src/eval/anchor.ts` already uses for gate recall — a label is *derived* from an injected,
known change, kept only when it isolates cleanly, rather than authored by a person.

For each surviving fixture, each dimension's judge score is binarized (a score of 1 or less counts
as "degraded"; 2 or 3 counts as "clean") and compared against the mutation's authored label
(which dimension it targets, and which dimensions it does not). Cohen's kappa between the judge's
classification and the mutation-derived label becomes `Calibration.value`.
`reference: "mutation-derived-v1"` names what it is — not a name implying human origin.
`threshold: 0.60` (the lower end of reported practice for a debugging signal rather than a
release gate); `max_age_days: 30` (the reference set is static, but the hosted model behind it is
not — a provider can change the model silently, and the cadence guards against that, not against
the reference drifting).

## Why hand-authored fixtures, not generated ones

`core/src/eval/anchor.ts` generates its 4,906 cases because a gate trigger is structural: inject
a text fragment, check whether a gate fires. A rubric mutation is semantic — "swap the domain,"
"drop a named constraint" — and proceduralizing that would require a domain model of brief
content this pipeline does not have. Twelve pairs, hand-authored once, is the tractable
alternative.

## What this does NOT establish

**Agreement with an actual human rater.** The calibration is internally consistent with the
rubric's own stated failure modes — it shows the judge can tell "the brief said X and the
compiled prompt did Y instead" from "the brief said X and the compiled prompt honored it," on the
twelve scenarios this suite covers. Whether a person reading the same brief and compiled prompt
would agree with the judge's score is unmeasured, on any scenario, including these twelve.

**Reliability on briefs unlike these fixtures.** The mutation suite covers exactly four failure
shapes (wrong domain, dropped constraint, added feature, missing requirement) applied to twelve
hand-picked scenarios. A fidelity failure that does not resemble one of these four — a subtly
wrong tone, an internal contradiction the brief did not create — is untested.

**Anything about the judge model's capability in general.** This calibrates one model, one
rubric, one prompt template, against one fixture set. `admitJudge`'s `stale-calibration` and
`expired-calibration` checks exist precisely because none of these findings transfer across a
model, rubric, or template change — a new calibration is required, not assumed to still hold.

**Freedom from position bias.** Every verdict this measurement produces carries
`position_randomized: true`, but brief-fidelity grading presents a single candidate against a
single brief — there are no alternatives whose order could be permuted, so the flag records a
randomization that had nothing to randomize and is true only vacuously. The
`judge-verdict` schema makes the field mandatory because a *comparative* judging surface must
declare it, and `core/src/eval/judge-policy.ts` reads it as one of the bias controls a panel
claims; neither is evidence that position bias was controlled for here. It was not measured,
because on this surface it cannot arise. A future comparative judge on this rubric would have to
randomize for real, and must not inherit this `true` as though the question were already settled.

## Consequences

**Easier:** the brief-fidelity judge can be calibrated and used without building human-annotation
infrastructure this repository has no other need for.

**Harder:** the calibration's authority is weaker than what `admitJudge`'s type was written
expecting. A reader who assumes "calibrated" means "validated against human judgment" is wrong,
and this ADR exists specifically so that assumption has somewhere to be corrected.

**To revisit:** if human-labeled calibration data is ever built for another purpose in this
repository, recalibrate the brief-fidelity judge against it and compare the two kappa values. A
large disagreement between mutation-derived and human-derived calibration would itself be a
finding about whether derived ground truth is a reasonable substitute for judge calibration in
general, not just for this one judge.

## Alternatives rejected

**No calibration at all, with `admitJudge`'s check bypassed or weakened.** Rejected outright —
`core/src/eval/judge-policy.ts` and `application/src/judge.ts` are explicitly out of scope for
this work (see the design spec), and weakening a guard that exists specifically to prevent an
uncalibrated judge from being trusted is the one thing this project must not do while claiming to
add a judge.

**Cross-model agreement as a proxy** (two different hosted models judging the same fixtures,
measuring their agreement with each other). Rejected: this measures whether two judges agree with
each other, not whether either is right. Two systematically-biased judges could agree perfectly
while both being wrong in the same direction, which is a documented failure mode judge-reliability
research already names (self-preference, when both judges belong to a similar model family).
