# Judge-scored provider comparison pilot — design

**Status:** Design approved 4 September 2026. Not yet built.
**Sub-project:** 4, an offshoot of 2 and 3 rather than a planned fourth phase (noise floor → provider-facing anchor → judge → **judge-scored comparison pilot**). Whether a full anchor follows is this pilot's own open question, not a fifth phase already decided.
**Depends on:** `application/src/judge-bundle.ts` and `HostedJudgeTransport` (sub-project 3, merged), `eval/brief-pilot.json` and its generator (sub-project 2), `eval/judge-calibration.json` (does not exist yet — a prerequisite of this work, not an input already in hand)

## Goal

Sub-project 2 asked whether a suite of model-sensitive briefs, scored by binary pass/fail detectors, could resolve a difference between two models more cheaply than the hand-written smoke suite. The measured answer was no: Δ = 0.4 pp, p = 0.5716, 72% of generated cases still constant, implied size 137,356 — recorded as "does not pay" in `TRUTH_BOUNDARY.md`.

This sub-project asks the same question with a different instrument. A binary detector can only ever report 0 or 1 per case; the brief-fidelity judge reports an integer 0–12 (four rubric dimensions, 0–3 each). A finer-grained score might separate two models on cases where pass/fail could not. Reusing the *exact same 100 briefs* (same seed, same generator) makes the comparison to sub-project 2's own finding direct rather than approximate.

**This is a pilot, not the anchor.** Its job is to produce one real number — the observed effect size and its implied full-anchor size under continuous scoring — and report pays/does not pay, exactly as sub-project 2 did.

## Scope

**In:**
- Running `build-judge-calibration.ts` for real (prerequisite: a judge with no measured calibration is refused by `admitJudge` before it can grade anything).
- Running the pilot for real: 100 briefs × 2 models (`phi4-mini:latest`, `lfm2.5-thinking:latest`), real local pipeline runs, real `judgeBundle` gradings against `claude-opus-5`.
- `core/src/eval/compare-graded.ts` — the paired-bootstrap comparator for continuous scores.
- `core/src/eval/sizing.ts` additions — `requiredPairedSizeContinuous`.
- A `comparison.schema.json` amendment making `equalization` nullable (see Contract changes).
- `scripts/judge-pilot.ts` — the composition-root orchestration script.
- A findings doc, written from the real measurement.

**Out:**
- Any change to the judge rubric, `GuardedJudge`, or `HostedJudgeTransport` — reused exactly as built.
- Pairwise (side-by-side) judge grading. The judge only ever grades one candidate absolutely against the brief; a comparison is two independent absolute gradings, paired afterward. Building a pairwise-comparison judge transport is a different, larger piece of work with its own position-bias considerations, and is not needed to answer this pilot's question.
- `gpt-oss:20b` and `gemma4:e4b` — same exclusion sub-project 2 made, same reasons (cost, within-model spread).
- The full anchor itself. This pilot sizes a possible future anchor; it does not build one.
- Any change to the eval-suite runner (`run-eval.ts`) or the single-stage/pipeline suite split. This pilot drives `runPipeline` directly, not through the eval-suite machinery at all.

## Architecture

### 1. `core/src/eval/compare-graded.ts` (new, pure)

```ts
export interface GradedCaseOutcome {
  case_id: string;
  score: number;
  cluster_id?: string;
}

export interface CompareGradedInput {
  comparison_id: string;
  candidate_run_id: string;
  baseline_id: string;
  candidate: readonly GradedCaseOutcome[];
  baseline: readonly GradedCaseOutcome[];
  suite: Pick<EvalSuite, "resolution" | "significance_protocol">;
  comparisons_in_family: number;
  alpha: number;
  correction?: "none" | "bonferroni";
}

export function compareGraded(input: CompareGradedInput): Comparison;
```

Mirrors `compare.ts`'s refusal-first shape:
- Refuses if `significance_protocol !== "bootstrap-ci"` (the suite's declared intent doesn't match the test being asked to run it — same principle as the existing clustered/mcnemar mismatch refusal).
- Refuses if candidate and baseline case sets don't match exactly (a paired test needs the same cases on both sides — identical wording to the existing check).
- Refuses if surviving paired n is below `MIN_BOOTSTRAP_N` (see Statistical design) — a *stated* floor, not a derived one.
- Otherwise computes the paired differences, runs the bootstrap, and returns a `Comparison` with `protocol.test: "paired-bootstrap"`, `protocol.confidence_interval` set, `equalization: null`.

A suite-kind predicate — `isGradedSuite(suite): boolean`, exported from `compare-graded.ts`, checking `significance_protocol === "bootstrap-ci"` — is the single answer to "which comparator does this suite want," mirroring `isPipelineCase`'s role for the pipeline/single-stage split. Callers (the new pilot script, and any future graded suite) check this before choosing `compare` vs `compareGraded`, so a suite can never be silently scored by the wrong one.

### 2. `core/src/eval/sizing.ts` — `requiredPairedSizeContinuous`

```ts
/**
 * Items needed to resolve a true paired-mean difference of `delta`, given the observed
 * standard deviation of the paired differences. The continuous analog of
 * `requiredPairedSize`: n ≳ (z_α + z_β)² · sd² / Δ².
 *
 * Unlike discordanceRate, sd is not bounded to (0, 1] — a 0-12 score's paired differences
 * range over [-12, 12], so sd is validated only as > 0.
 */
export function requiredPairedSizeContinuous(
  delta: number,
  sd: number,
  assumptions: Pick<SizingAssumptions, "alpha" | "power">,
): number;
```

Cross-checked by a test asserting it reduces to `requiredPairedSize` in the Bernoulli limit (variance of a ±1/0 discordance indicator at rate `p_d` is `p_d`, so `requiredPairedSizeContinuous(delta, sqrt(p_d), {alpha, power})` must equal `requiredPairedSize(delta, {alpha, power, discordanceRate: p_d})`), the same cross-check discipline `LEGACY_ASSUMPTIONS` already uses to keep the old and corrected binary rules from drifting apart.

### 3. `scripts/judge-pilot.ts` (new, composition root)

Imports concrete adapters directly (`LocalRevisionStore`, `LocalContentStore`, `LocalEvidenceStore`, `HostedJudgeTransport`, a local-proxy or Ollama `ProviderTransport` per model), exactly as `scripts/judge.ts` does. Refuses up front if `ANTHROPIC_API_KEY` is unset or `eval/judge-calibration.json` is missing/stale/below threshold — the same fail-closed posture `scripts/judge.ts` already has, not a new one.

### 4. Findings doc

`docs/superpowers/plans/YYYY-MM-DD-judge-pilot-findings.md`, dated to the day it is actually run (not written in advance), structured like `brief-pilot-findings.md`: observed Δ, bootstrap CI, survived n (vs. nominal 100), implied full-anchor size via `requiredPairedSizeContinuous`, constant-case fraction (cases where both models scored identically), and an explicit pays/does-not-pay verdict compared directly against sub-project 2's Δ = 0.4 pp finding.

## Data flow

1. Regenerate the 100 brief-pilot cases from seed 1 using the existing generator; extract each case's `brief` text. No detectors, no `run-eval.ts`, no eval-suite runner — this pilot never touches that machinery.
2. For each brief × each of `{phi4-mini:latest, lfm2.5-thinking:latest}`: run the real `runPipeline` at **TINY** depth (cheapest depth that still reaches `compile`) into a fresh `LocalRevisionStore`/`LocalContentStore` pair. 200 real pipeline runs. Cost: local GPU-time only, no API spend.
3. For each of the 200 runs, call `judgeBundle()` unchanged. It resolves the compiled prompt via the existing backward search, refuses degraded/demo runs, and grades via `HostedJudgeTransport` (`claude-opus-5`, `runs: 3`). 600 real Anthropic API calls.
4. Pair the two models' `judgement.verdict.verdict` values by `case_id` (the brief's id). Briefs where either side's run was refused (demo-mode, missing content, etc.) are dropped from the paired set — not imputed, not zero-filled.
5. Feed both score sequences into `compareGraded`. Write the resulting `Comparison` and both `judgement` records to the evidence plane. Write the findings doc from the real output.

## Statistical design

`compareGraded` computes, for each surviving paired brief, `diff = candidate_score - baseline_score` (both integers 0–12, so `diff` is an integer in [-12, 12]). It then runs a **paired percentile bootstrap**: resample the n diffs with replacement `BOOTSTRAP_RESAMPLES` times, compute the mean each time, and take the `alpha/2` and `1 - alpha/2` percentiles of the resulting distribution as `protocol.confidence_interval`. The verdict is `improved`/`regressed` iff that interval excludes 0 (sign given by the observed mean diff), else `inconclusive`.

Two constants are fixed and exported, not caller-supplied, so the function stays a pure, deterministic mapping from data to result without adding new fields to the `protocol` schema:

```ts
export const BOOTSTRAP_RESAMPLES = 10_000;
export const BOOTSTRAP_SEED = 1;
export const MIN_BOOTSTRAP_N = 20;
```

`BOOTSTRAP_SEED` shares a value with `anchor.ts` and the brief-pilot generator's own seed 1, but is an unrelated constant in its own RNG stream — it seeds only the bootstrap resampler here, not brief generation. Resampling uses the same seeded generator discipline `anchor.ts` established (`rng(seed)` from `core/src/eval/generator.ts`) — Core cannot touch `Math.random`, and the purity harness traps it.

**Stated, not derived:** unlike `floorDiscordant`'s exact combinatorial floor for McNemar (`2 · 0.5^d`, assumption-free), a percentile bootstrap's coverage is asymptotic. There is no equivalent exact floor. `MIN_BOOTSTRAP_N = 20` is a stated, literature-common rule-of-thumb for percentile-bootstrap reasonableness — recorded as an assumption with a name, the same posture `LEGACY_ASSUMPTIONS` already takes toward the binary rule's hidden 50%/50% defaults, not as a proven property of the design.

**Granularity still generalizes.** `resolution.detectable_delta = 1/n` holds unchanged: `verdict` is always an integer 0–12 (`HostedJudgeTransport`'s `score_out_of_range` check enforces this), so the sum over n briefs is always an integer and the mean has exactly `1/n` granularity — the identical argument that holds for binary detectors, of which 0/1 is the special case. `check:sizing`'s existing `detectable_delta` rule applies to a graded pilot suite with no changes.

## Contract changes

`contracts/comparison.schema.json` (2.2.0 → 2.3.0): `equalization` becomes nullable. It exists to carry *detector*-recall equalization evidence, and a judge-graded comparison has no detectors — there is nothing to equalize, and nothing was equalized. Setting `equalized: true` when nothing was checked, or forcing any other placeholder value, is exactly the kind of vacuous claim ADR-0016 already had to name once for `position_randomized` on single-candidate gradings. `null` means "not applicable to this comparison's outcome type," extending this repository's existing convention that null means unmeasured/inapplicable, never a fudged value standing in for zero.

Changes required: `contracts/comparison.schema.json` (`"equalization": {"type": ["object", "null"], ...}`, kept in `required` — the key must be present, its value may be null), `contracts/index.ts` (`equalization: Equalization | null`), `contracts/CHANGELOG.md`, `test/contract-conformance.test.ts` (a case asserting a null-equalization `Comparison` validates). This lands as its own reviewed step, before any code that produces a graded `Comparison` — the same contract-first sequencing every prior change in this codebase has followed.

`protocol.test: "paired-bootstrap"` and `protocol.confidence_interval` already exist in `comparison.schema.json` 2.2.0, unused until now — no other contract change is needed there.

## Error handling and refusals

- `compareGraded` refuses (never guesses) on: mismatched case sets, a declared `significance_protocol` other than `bootstrap-ci`, or a surviving paired n below `MIN_BOOTSTRAP_N`.
- `judgeBundle` already refuses per-run on demo-mode and missing/degraded content — unchanged. A brief where either model's run degrades is dropped from the paired set entirely; the pilot does not retry, impute, or substitute.
- `scripts/judge-pilot.ts` refuses up front (before spending anything) if `ANTHROPIC_API_KEY` is unset or the calibration artifact is missing, stale, or below threshold — reusing `validateCalibrationArtifact` from `scripts/judge.ts`'s own guard, not a second implementation of it.
- The findings doc reports the actual survived n, not the nominal 100 — the same discipline sub-project 2 used reporting its real discordant-unit count rather than assuming its nominal case count carried through.

## Live-execution plan

Two separately-confirmed steps, each with real external cost — not bundled into a single "the design is approved, therefore run everything" action:

1. **Calibration**: `ANTHROPIC_API_KEY=... npx tsx scripts/build-judge-calibration.ts` — 60 calls to `claude-opus-5`. Must produce kappa ≥ 0.6 or the pilot is blocked; `admitJudge` refuses an uncalibrated or below-threshold judge by construction, not by a check this script adds.
2. **The pilot**: `scripts/judge-pilot.ts`, requiring `phi4-mini:latest` and `lfm2.5-thinking:latest` available locally (already used for sub-project 2) and `ANTHROPIC_API_KEY` set — 600 calls to `claude-opus-5`, plus 200 local pipeline runs at TINY depth (GPU-time only).

## Testing strategy

- `core/test/compare-graded.test.ts`: pure unit tests over hand-built score arrays — every refusal branch, the bootstrap's sign and zero-exclusion logic, the stated minimum-n floor, the granularity check, `isGradedSuite`.
- `core/test/sizing.test.ts`: extend for `requiredPairedSizeContinuous`, including the Bernoulli-limit cross-check against `requiredPairedSize`.
- `application/test/judge-pilot.test.ts`: the orchestration script driven end-to-end against `ScriptedProvider`/`CapturingJudge` fakes, in the same style as `judge-bundle-real-run.test.ts` — real `runPipeline`, real local storage, fake transports, asserting the full 200-run/pairing/comparison wiring is correct. This, not the real 600-call run, is what `npm test` and `npm run verify` exercise; the live run stays a manual, explicitly-confirmed step outside CI, exactly as `build-judge-calibration.ts` already is.
- `test/contract-conformance.test.ts`: a `Comparison` fixture with `equalization: null` validates against the 2.3.0 schema.

## What this does NOT establish

- **Not a general graded-suite capability.** `compareGraded` is built and proven against this one pilot's shape (0–12 integer judge scores). A future graded suite with a different scale or a genuinely continuous (non-integer) metric may need its granularity argument re-derived — the `1/n` generalization here relies specifically on `verdict` being an enforced integer.
- **Not evidence about `gpt-oss:20b` or `gemma4:e4b`,** deliberately excluded, same as sub-project 2.
- **Not the anchor.** A pays verdict here sizes a possible anchor; it does not build one, and the anchor's own design (rubric stability across a larger run, judge cost at anchor scale, whether `runs: 3` self-consistency remains affordable at thousands of gradings) is future work.
- **Not evidence that continuous scoring is "better" in general** — only whether it resolves a bigger gap on these 100 briefs, this rubric, this judge, this model pair. A different rubric or judge model could behave differently.
- **Not reproducible as a live measurement.** The suite (100 briefs from seed 1) and the bootstrap (fixed seed 1, 10,000 resamples) are both deterministic and checked. The local models are stochastic and unpinned in temperature, same limitation sub-project 2 already documented.

## Consequences

**Easier:** answering "did switching instruments help" with a real, directly comparable number instead of a guess — same briefs, same seed, only the scoring instrument changes.

**Harder:** running this costs real money against a live judge model, twice (calibration, then the pilot), and both steps are irreversible spend once started — which is why each stays its own explicitly-confirmed action rather than something this design approves in advance.

**To revisit:** if this pilot pays, the anchor's size comes from *its* observed sd and Δ, not from an assumption — and, as with sub-project 2, the two must not be conflated, since they describe different suites and different instruments.
