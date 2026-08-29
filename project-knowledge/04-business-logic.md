# Business logic

Everything here is **pure** unless stated. Core owns the decisions; the Application owns the
effects.

---

## 1. The 16 gates — `core/src/gates/`

Pure functions of `(text, options) → GateResult` with verdict `PASS | WARN | FAIL`.

| Gate | v | Catches |
|---|---|---|
| `SECRET_LEAK_SCAN` | 1.1.0 | API keys, tokens, emails, phone numbers |
| `CLAIM_DISCIPLINE` | 1.1.0 | "guarantee", "100% accurate" — unearned certainty |
| `PLACEHOLDER_AUDIT` | 1.0.0 | `<<ROLE>>` left unfilled |
| `RUNTIME_KEY_UNDECLARED` | **1.1.0** | `[[API_HOST]]` with no declaration. Diverges from the source (ADR-0010) |
| `SOURCE_LEDGER_MISSING` | 1.0.0 | citations with no ledger |
| `ORPHAN_CLAIMS` | 1.0.0 | claims citing nothing |
| `GUARDRAIL_GAP` | 1.0.0 | missing bias/sanitisation language |
| `TOKEN_SPAM` | 1.0.0 | `[ACK]`-style repetition (threshold: **more than 8**) |
| `RECURSION_MACHINERY_PRESENT` | 1.0.0 | recursion scaffolding (armed by option) |
| `RAG_SHIELD_GAP` | 1.0.0 | retrieval guards absent (armed by option) |
| `DUPLICATE_INSTRUCTION` | 1.0.0 | repeated blocks (60-character floor) |
| `DELIMITER_ENTROPY` | 1.0.0 | delimiters under a 32-hex minimum |
| `TOKEN_BUDGET` | 1.0.0 | estimate over a declared ceiling |
| `QUTM_CEILING` | **1.1.0** | ratio ceiling, not armed below a 120-token baseline. Diverges from the source (ADR-0011) |
| `CONTEXT_LIMIT` | 1.0.0 | context overflow |
| `ADVERSARIAL_RESILIENCE` | 1.0.0 | takes an **injected** corpus |

`runGate(id, text, options)` throws on an unknown id rather than silently returning nothing.
Eight of the sixteen do nothing until an option arms them.

**Every gate is checked against the frozen Python linter** (`sources/v5/prompt_lint.py`) by
the differential oracle — 2,784 verdicts, of which 17 differ deliberately (ADR-0010, ADR-0011).
`gate_version` is per **gate**, not per module, and `core/test/ported-gates.test.ts` pins all
sixteen pairs — a behaviour change without a version bump has to be a conscious edit. See ADR-0007: parity between two implementations of
one design is structurally blind to a defect they *share*, and the frozen fixtures document
three shipped bugs that survived a passing parity suite for exactly that reason.

## 2. The 11 stages — `core/src/stages/`

```
deconstruct → calibrate → compile → harden → critique → refine
            → lint → critic → preview → cost_estimate → tone_check
```

Each exposes `decide(input, run_id) → GenerationRequest` and `reduce(classified) → state`.

### Depth plan — `planForContext(ctx)`

Stakes maps to depth, and depth selects which stages run:

| Stakes | Stages |
|---|---|
| `LOW` | 6 of 11 |
| `MEDIUM` | default |
| `SAFETY-CRITICAL` | all 11 |

A depth plan **omitting** stages is not the same as **skipping** them: a successful `TINY`
run has no `SKIPPED` entries at all.

### Gate feedback loop — `decideGateFeedback(ctx, plan)`

A gate FAIL routes back to `refine` carrying its message. **Six named reasons not to loop**,
each returned explicitly:

1. topology is not reflexive
2. the cap is spent or undeclared
3. the verdict is not `GATE_FAIL`
4. the plan omits `refine` or `lint`
5. the output is a demo placeholder
6. the verdict is `GATE_FAIL` but no gate returned a FAIL — nothing to feed back

Capped-and-still-failing and declined-because-clean both return `retry: false`, so the
*reason* is the only thing separating them. `lintStatus` stays `GATE_FAIL` on a capped run,
so a run that exhausted its budget cannot read as a clean pass.

**The cap is derived, not chosen.** Each round re-runs `refine` then `lint` — exactly two
executions — so `check:depth` prices it:

```
11 stages + 3 rounds → 17 worst case → 0.995^17 = 91.84%  ✓ (target 90%)
11 stages + 6 rounds → 23 worst case → 0.995^23 = 89.11%  ✗ fails the build
```

*"Why 3?"* is answered by arithmetic. `revision-entry` 1.3.0 adds `feedback_round` so a
bundle longer than its plan carries a record of why.

## 3. Statistics — `core/src/eval/sizing.ts`, `compare.ts`

### The exact significance floor

Under McNemar the statistic is binomial(d, 0.5), so the smallest two-sided p-value **any**
arrangement of d discordant units can reach is `2 × 0.5^d`:

| d | min p | can reject at α=0.05? |
|---|---|---|
| 3 | 0.2500 | no |
| 4 | 0.1250 | no |
| 5 | 0.0625 | no |
| **6** | **0.0313** | **yes** |

`eval/compile-smoke.json` carried the sentence *"resolving a difference takes six flips, not
one"* in a comment since it was written, and **no code knew it**. Now `floorDiscordant(alpha)`
does.

This is **not** post-hoc power (a monotone function of the p-value, carrying no information).
It is the *support of the test statistic* — a property of the design. Nothing is computed
from the p-value.

Two consequences:

- A suite below the floor is **refused**, not "inconclusive". *"We could not have seen
  anything"* and *"we looked and saw nothing"* must not collapse into one verdict.
- **Multiplicity correction can move the bar out of reach entirely.** At a family of 100,
  α = 0.0005 needs 12 discordant units; an 11-case suite has 11. A hundred comparisons
  against it is not a stricter search, it is a search that cannot return anything.

### The sizing rule, and its three hidden assumptions

`n ≳ z²/(2Δ²)` — quoted in three documents as *"the sizing rule"* — is the conditional
McNemar rule with **three parameters pinned and none written down**:

| Assumption added | items @ 2 pp |
|---|---|
| as quoted: one-sided z, 50% power, p_d = 0.5 | 3,382 |
| two-sided z, as the test is actually run | 4,802 |
| …and at 80% power | **9,812** |

Together **2.9×**. The corrected form is:

```
n ≳ (z_α + z_β)² · p_d / Δ²
```

Cross-checked against something outside the repo: τ²-bench reports 114 paired tasks resolving
~15 pp, which the new rule reproduces at p_d ≈ 0.33. The old rule says 61.

Independently corroborated by `PromptNexus-6.2/STATISTICAL_VALIDATION_REPORT.md`, which was on
disk unread and lists **9,812** and **4,802** in its own MDE table from an unpaired two-group
framing.

### Clustered data

Perturbation expansion is `cases × perturbations` — a within-case product, i.e. clustered.
Four variants of one brief are four *looks at one question*, not four questions.
`clusteredPaired()` analyses at the level of the independent unit: each cluster contributes
one signed difference, and the same exact binomial is applied to those signs.

The comparator **refuses** `exact-mcnemar` on clustered data rather than reporting a caveated
number. A caveat beside a p-value gets the p-value quoted and the caveat dropped.

### Detector-recall equalization

Runs scored by detectors of unequal sensitivity are not comparable — an intervention has been
observed appearing to *raise* hallucination by 10–15 points purely because structured output
made failures easier to find. `deriveEqualization()` computes the gap from both runs' measured
recall and refuses when it exceeds the suite's granularity.

`gap_bound` is the suite's own `detectable_delta` rather than a chosen constant, and that
carries a guarantee: with recall r and true rate f, a measured delta is `r_b·f_b − r_c·f_c`;
holding true rates equal isolates the artifact at `f·(r_b − r_c)`, whose magnitude is at most
`|Δr|` because `f ≤ 1`. **So a pure recall artifact can never on its own clear the reporting
threshold.**

## 4. The release gate — `core/src/release/promote.ts`

**Three** preconditions, then five **conditions**, all conjunctive.

Preconditions (the instrument before the measurement):

| Code | Refuses when |
|---|---|
| `development-lineage` | the baseline is not on the `benchmark` lineage — a cycle in the grading order |
| `pointer-mismatch` | the comparison, run and baseline do not refer to each other consistently |
| `dangling-ref` | the evidence names retained content that no longer resolves |

`dangling-ref` is the reachability half of `pointer-mismatch`: pointer consistency says the
three ids agree, this says the artifacts they name can still be inspected. The oracle is
injected because existence is an effect — the Application resolves refs through a
`ContentStore` and hands Core `true`/`false`; Core only composes the decision. An **absent**
oracle means the deployment keeps no content plane and reachability is not checked, which is
the pre-lineage behaviour. A present-but-failing oracle must **throw**, never return false, so
a broken store cannot masquerade as "all content gone" — a wrong refusal wearing the right
words.

The five:

| Condition | Holds when |
|---|---|
| `significance` | verdict is `improved` **and** `attainable === true`. An absent attainability record refuses — unknown is not the same as fine |
| `no_regression` | no failure mode's pass **rate** dropped by more than the suite's granularity |
| `within_budget` | `cost.budget_exceeded === false` |
| `judge_calibration` | derived from `run.grader_health`, **not** from whether a judge was passed in — otherwise the condition is opt-out |
| `detector_equalization` | `comparison.equalization.equalized === true` |

- A refusal **writes nothing**. There is no half-promotion.
- `no_regression` catches the trade the aggregate hides: overall up ten points while one
  category collapses. The threshold is the suite's declared granularity rather than zero — at
  zero a single stochastic flip blocks every promotion, and a gate that never passes is one
  that gets bypassed.
- **Rollback re-evaluates nothing.** Restoring a shipped configuration is always allowed;
  requiring evidence to go back would mean a bad promotion could not be undone without first
  producing the evidence that would have prevented it.
- `current()` is a **query** over the promotion list, not a stored pointer. A pointer that has
  to be maintained is a pointer that drifts.

## 5. Routing — `core/src/routing/policy.ts`

`decideRoute(policy) → RouteDecision`, then `reduceRouteOutcome(policy, current, outcome) →
RouteDecision | null`. Returns a **terminal null** on success rather than the same decision
again — a caller looping until the decision stops changing would otherwise spin forever.

### The refusal that matters more than the policy

```ts
admitCostJustification({ justification: "cost", qualityVerdict }) → refused
```

A router is adopted on a cost number, and the quality argument beside it is nearly always
*"the comparison came back inconclusive, so quality held."* **That reads a superiority test
backwards.** `inconclusive` says the suite could not separate the two configurations — with
these suites it says very little. Establishing equivalence is a different procedure with a
different null: non-inferiority against a declared margin. None is implemented, so it refuses
and *names* the missing procedure.

Refused **even when quality also improved** — promote that on the quality result, or the next
candidate uses the path without one.

## 6. Judge policy — `core/src/eval/judge-policy.ts`

`admitJudge()` returns ordered refusals. **Order matters**: self-preference is checked first
because it invalidates the verdict regardless of calibration.

| Code | Meaning |
|---|---|
| `self-preference` | the judge's family is the family under test — a cycle in the grading order |
| `verifier-checkable` | a deterministic detector can settle this; a judge is expensive, biased, and itself needs evaluating |
| `no-calibration` | an unmeasured instrument is not evidence |
| `stale-calibration` | measured before the judge contract last changed |
| `expired-calibration` | older than `max_age_days`, **even though nothing changed** — judges drift in 60–90 days |
| `below-threshold` | agreement under the rubric's declared floor |

`measuredBiases()` reports which of five named biases a panel has actually measured. Absent is
reported as **absent**, never as zero — zero reads as measured-and-fine.

The judge's input *contains the model's own output*, so grading is prompt injection with the
attacker already inside the loop. The candidate is fenced with a **content-derived nonce** it
cannot predict, and the judge prompt runs through `DELIMITER_ENTROPY` before being sent.

## 7. The anchor — `core/src/eval/anchor.ts`

The first suite here sized to certify a promotion. 4,906 cases.

**Ground truth is derived, never authored.** For each candidate:

1. generate a base text + gate options from the seed
2. record which gates are silent
3. inject one more generated fragment
4. re-run the registry
5. keep the case **only if exactly one previously-silent gate now fires** — that gate is the
   label

Requiring *exactly one* matters: a fragment tripping three gates is a case where "did this set
catch the defect" has three answers.

> Hand-labelling would have been **wrong**, not merely tedious. This corpus contains a
> citation that silences *both* citation gates by declaring itself inside an empty ledger, and
> a secret that stops being a finding inside a fence. Context decides.

Sized from measurement: a 4,000-case pilot put p_d at 0.2477 → rounded up to 0.25 →
`requiredPairedSize(0.02, {α: .05, power: .8, p_d: .25})` = 4,906. Observed on the real run:
0.2519.

**Compares two sets that partition the registry.** Full-versus-full-minus-one is theatre: a
subset cannot catch more than its superset, so the null is known false before any case is
scored.

Result: `IMPROVED`, delta 24.34 pp, 1,236 discordant, p = 4.94e-324.

Two findings from building it: **7 of 16 gates add no unique coverage** on this corpus, and
the p-value **underflows to zero at 1,075 discordant units** (now clamped).

## 8. Budget — `core/src/eval/budget.ts`

`admitRun()` decides **before dispatch**, refusing rather than truncating: a partially
executed suite is not an `EvalRun` — its aggregate would be a score over whichever cases
happened to fit, published under the name of a suite that means something else.

Four things it got wrong, all fixed 29 August and all the same shape — a cap that reads as
enforced and is not:

- **The eleven-stage path never called it.** `application/src/pipeline.ts` referenced
  `admitRun` zero times, and that is the path the CLI wires a real provider into. It is sized
  now by `plannedPipelineCalls(plan, …)` from the plan *actually selected* — `planForContext`
  returns six stages at TINY — plus one generating execution per feedback round, times
  attempts. The per-round figure is **measured, not read**: at caps of 0/1/2/3 an eleven-stage
  run performs 8/9/10/11 provider calls.
- **`truncate_suite` admitted with a cap nothing honoured.** It returned `admit: true` and a
  reduced `allowedCalls` that `eval.ts` referenced zero times, so declaring it ran the whole
  suite. It now **refuses**, and says how many calls would have fit. Honest truncation is not
  slicing the case list: `EvalRun` would have to record that it was truncated, which is a
  contract change that lands first.
- **Token rates were unvalidated.** A negative rate makes `usd` negative, so `exceeds` compares
  a negative number against a positive cap and returns false — the more the run spends, the
  further under budget it looks. `NaN` defeats it the same way.
- **A declared `max_usd` was reported as "within budget" without being checked.** No caller
  passes an estimate and `runSuite` is never given a rate, so a dollar cap is enforced at
  *neither* end. The fail-open stands — refusing on an unknown would block every run against a
  provider that reports no usage, and a test has pinned that deliberately since the function
  landed — but `Admission.unenforced` now names it and it reaches the CLI. **A fail-open
  somebody chose and a fail-open nobody knew about are different things.**

### The cache key, and a correction to ADR-0008

ADR-0008 specified `(config_hash, case_hash)` and said that key "is what makes 100-trial
protocols affordable". **Both halves cannot hold.** A repeated-trial protocol exists *because*
decoding is stochastic; keyed on config and case alone, trials 2–100 are cache hits of trial 1
— one sample reported as a hundred, with a measured variance of exactly zero and a confident
interval around it.

```ts
cacheKey(config, case, trial, decoding) =
  isDeterministic(decoding) ? `${config}:${case}` : `${config}:${case}:t${trial}`
```

`isDeterministic`: temperature 0 → yes. **A null temperature is not** — it records that the
provider deprecated the parameter, and a deprecated parameter is not a promise of greedy
decoding, it is the absence of a control. Only null + an explicit seed counts.

**Failures are never cached.** A `ProviderFailure` is a statement about the provider at a
moment; caching one turns a transient outage into a permanent answer and would pin a run to
the demo placeholder for as long as the cache lived. Consequence worth stating: a suite full
of failing cases stays expensive to repeat.

## 9. Perturbations — `core/src/eval/perturbations.ts`

Five seeded perturbations via an LCG (no `Math.random` — Core is pure). Four are
expectation-preserving; one deliberately is not, and **gets its own cluster**, because it asks
a different question and pooling it would commit the exact error clustering exists to prevent.

`cluster_id` is written by the expander and **never by a suite author** — hand-assigned
clustering would make every downstream confidence figure depend on how someone chose to group
cases.
