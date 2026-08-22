# Phase 1 — Skeleton

Structure only. Each section carries BRIEF / INPUTS / DONE WHEN / DISCHARGES. A section with no DISCHARGES was cut.

Standing invariants I1–I7 and the measured baseline are in [GROUND_TRUTH](./GROUND_TRUTH.md) and are assumed by every section below.

---

## Part 0 — Corpus integrity

**BRIEF** — The corpus is the evidence base for the catalog and for every design claim in `Documentation/`. It has 62 duplicate files and no manifest, and four documents state a size no command reproduces. Fix the measurement, not the four numbers.
**INPUTS** — GROUND_TRUTH "Size of the corpus"; `sources/MANIFEST.json` as the working pattern; ADR-0008 lines 12, 201 and `PROMPT_ENGINEERING_ENVIRONMENT.md` line 54.
**DONE WHEN** — `npm run check:corpus` prints the deduplicated count and exits non-zero when any document states a corpus size that disagrees with it.
**DISCHARGES** — `PDF/MANIFEST.json`; `scripts/check-corpus.mjs`; a `check:claims` generalization of `scripts/check-plan.mjs`.

## Part 1 — The claim checker, generalized

**BRIEF** — `check:plan` verifies 15 claims in one document. Three stale counts live in documents it does not read, one of which is a routing rule. The guard's scope is narrower than its name.
**INPUTS** — AUDIT B-1, B-2, B-3; `scripts/check-plan.mjs`.
**DONE WHEN** — a planted wrong count in *any* `Documentation/*.md` fails the build, proven by mutation in both directions (must-fire, must-not-fire).
**DISCHARGES** — `scripts/check-claims.mjs`; `npm run check:claims` in `verify`; the three corrected counts.

## Part 2 — The evidence plane

**BRIEF** — `EvalRun`, `Baseline`, `Comparison` and promotion records have schemas and no home. Persistence today is `RevisionEntry` bundles only. Name the plane, give it one port, and make immutability structural rather than conventional.
**INPUTS** — ADR-0008 "Scalability logic"; `contracts/{eval-run,baseline,comparison}.schema.json`; `adapters/storage-local/src/index.ts`; the revision-persistence design of 21 Aug.
**DONE WHEN** — an `EvalRun` written by Pipeline B is readable by Pipeline C through a port neither names an adapter for, and a second write under the same id is refused.
**DISCHARGES** — `EvidenceStore` port in `contracts/index.ts`; `adapters/evidence-local`; conformance suite.

## Part 3 — Execution plane: making the Nth experiment cheap

**BRIEF** — No eval run has ever called a model. The three mechanisms that make repeated-trial protocols affordable — content-addressed caching, bounded fan-out, batch submission — do not exist. This is what "scalable" means here, per `PROMPT_ENGINEERING_ENVIRONMENT.md` §0.
**INPUTS** — ADR-0008 "Execution is embarrassingly parallel"; Anthropic Batch API (50% rate) and prompt caching (~90% on the cached prefix) — external, `MAP` E-1; `application/src/invoke.ts` retry policy.
**DONE WHEN** — a 100-trial suite runs with `provider_calls` strictly less than `cases × trials`, `cache_hits` non-zero, and `budget_exceeded` enforced *before* the spend rather than reported after.
**DISCHARGES** — `application/src/execute.ts`; `CacheStore` port; `cost` block populated for real; budget enforcement in the request path.

## Part 4 — Gate verdicts as a bounded control signal

**BRIEF** — ADR-0008 action item 4. Sixteen gates produce structured textual failure messages that currently terminate a stage. Making them feedback into `refine` is the inner-loop form of reflective optimization, and the messages are already the right shape for it.
**INPUTS** — ADR-0008 Pipeline A "Change required"; GEPA (arXiv 2507.19457, ICLR 2026 oral) on reflective textual feedback beating scalar reward — `MAP` E-2; `core/src/stages/pipeline.ts` reducer; `core/src/gates/registry.ts`.
**DONE WHEN** — a brief that fails `PLACEHOLDER_AUDIT` on first compile passes after bounded re-refinement, the cap is in the contract not a comment, and the smoke suite shows the change's sign.
**DISCHARGES** — `GateFeedback` in `contracts/index.ts`; reducer change in `core/src/stages/pipeline.ts`; cap in `configuration.schema.json`; a suite case that measures it.

## Part 5 — The judge adapter and its bias panel

**BRIEF** — `judge-verdict` captures position randomization and chance-corrected agreement. Current practice names five biases; three are uncaptured. A judge is an instrument, and an unmeasured instrument is not evidence (I5's argument, one level up).
**INPUTS** — `contracts/judge-verdict.schema.json`; external judge-bias practice — `MAP` E-3 (position, verbosity, self-preference, format, calibration drift; κ ≥ 0.6 floor, ≥ 0.8 strong; monthly re-calibration; judge swap = suite migration); ADR-0008 "the judge is never the model under test".
**DONE WHEN** — the judge adapter refuses to grade when `judge_id` shares a model family with the configuration under test, and a verdict without a non-stale calibration fails the run.
**DISCHARGES** — `adapters/judge-*`; `judge-verdict` v1.1.0 with the bias panel; routing check against `verification_status`.

## Part 6 — Perturbations

**BRIEF** — A suite of clean inputs overstates every result it reports. Perturbations are part of the suite, and they create *clustered* cases — which changes the statistics in Part 7.
**INPUTS** — ADR-0008 "Perturbations are part of the suite"; `eval-case.schema.json`; clustering consequence from arXiv 2411.00640 — `MAP` E-4.
**DONE WHEN** — every case in the anchor suite has ≥1 perturbed variant, seeded and reproducible, and the run records the cluster each case belongs to.
**DISCHARGES** — `core/src/eval/perturbations.ts` + registry; `cluster_id` on `EvalCase`; `eval-suite` version bump.

## Part 7 — Statistics: clusters, power, and what the comparator may say

**BRIEF** — The comparator is exact-binomial McNemar over discordant pairs. Correct for independent paired binary outcomes; **wrong once perturbations cluster the cases**, where naive standard errors understate by up to 3×. Power must be computed before a suite is trusted, not after a result is wanted.
**INPUTS** — `core/src/eval/compare.ts` (`mcnemar`, `requiredAnchorSize`); arXiv 2411.00640 (clustered SEs, paired variance reduction, bootstrap CIs, power analysis) — `MAP` E-4; the n₀ ≳ z²/(2Δ²) anchor bound already in `PROMPT_ENGINEERING_ENVIRONMENT.md` §4.
**DONE WHEN** — the comparator refuses (`inconclusive`) rather than reporting a p-value when the suite is clustered and the test assumes independence, and a planted 2-point difference is detected at the declared anchor size and missed below it.
**DISCHARGES** — `core/src/eval/cluster.ts`; `significance_protocol` required on `eval-suite`; `comparison` v2.1.0.

## Part 8 — Pipeline C, release and promotion

**BRIEF** — Zero configurations have been promoted because there is no promotion path. A promotion that cannot name the run justifying it is not a promotion, and `CAPABILITY_MATRIX.md` finally gets its generator.
**INPUTS** — ADR-0008 Pipeline C; `contracts/baseline.schema.json` + its pending-implementation entry; `CAPABILITY_MATRIX.md` ("asserts nothing"); external prompt-CI practice — `MAP` E-5.
**DONE WHEN** — `promote` refuses without (significance ∧ no-regression ∧ within-budget ∧ non-stale judge calibration ∧ equalized detectors), and `CAPABILITY_MATRIX.md` is generated with a `--check` mode.
**DISCHARGES** — `application/src/promote.ts`; `scripts/generate-matrix.mjs`; `Promotion` contract.

## Part 9 — Loop D, monitoring

**BRIEF** — Offline evaluation catches regressions you introduce; monitoring catches the ones that happen to you. The hook exists on every provenance record and is read by nothing. Cheapest item with the widest coverage.
**INPUTS** — ADR-0008 Loop D and action item 5; `ExecutionProvenance.provider_model_fingerprint`; OTel GenAI status — `MAP` E-6.
**DONE WHEN** — a changed fingerprint fails the build and names the baseline suite to re-run; a production failure can be appended to a suite as a case in one command.
**DISCHARGES** — `scripts/check-fingerprint.mjs`; `fingerprints.json` pin; `promptnexus case add`.

## Part 10 — Routing

**BRIEF** — A decision made repeatedly deserves a contract. Policy is pure (Core), selection and invocation are effects (Application) — no new layer. Blocked behind Parts 3 and 7: a router trained against an unmeasured objective optimizes toward whatever the objective actually rewards.
**INPUTS** — `PROMPT_ENGINEERING_ENVIRONMENT.md` §2 and LLMRouter's five-part decomposition; ADR-0005.
**DONE WHEN** — a router is added by implementing a routing method and a loss function plus one registry line, and is evaluated on quality *and* cost under the same `EvalRun` protocol as any configuration.
**DISCHARGES** — `core/src/routing/`; `RoutingPolicy` on `Configuration`.

## Part 11 — Pipeline E, the optimizer

**BRIEF** — Last, deliberately. It amplifies a weak evaluator more than any other component. GEPA's economics (10 examples, 20–100 evaluations) change the affordability argument but not the ordering.
**INPUTS** — `PROMPT_ENGINEERING_ENVIRONMENT.md` §§3–4 (meta-harness, three invariants, anchor sizing, Goodhart alarm); GEPA — `MAP` E-2.
**DONE WHEN** — every proposal is an `EvalRun`; the gate registry and oracle sit outside the optimizer's write surface, proven by a probe; the generalization ratio is alarmed.
**DISCHARGES** — deferred. This part is **specified, not scheduled**.

---

## Dependency order

```
Part 0 ──┐
Part 1 ──┴─► (no inbound dependencies — build first)

Part 2 ─► Part 3 ─► Part 6 ─► Part 7 ─► Part 8 ─► Part 10 ─► Part 11
              └────► Part 5 ────────────┘
Part 4  (independent of 2–8; needs only the smoke suite that exists)
Part 9  (independent — needs only ExecutionProvenance, which exists)
```

**No inbound dependencies: Parts 0, 1, 4, 9.** These are buildable today and three of them are cheap. Parts 10 and 11 must not start before Part 7 exists.
