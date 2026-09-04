# Judge-scored provider comparison pilot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pieces sub-project 4 needs to re-ask sub-project 2's model-comparison question with a continuous judge score instead of binary detectors — a new paired-bootstrap comparator, a small contract fix that lets a detector-less comparison validate honestly, and an orchestration path that runs the 100 brief-pilot briefs through two models and the existing judge — leaving the two real, money-spending measurement runs (calibration, then the pilot itself) as explicit manual steps performed after this plan's code is merged and green.

**Architecture:** `core/src/eval/compare-graded.ts` is a new pure comparator, structurally parallel to `core/src/eval/compare.ts` but scoring paired continuous outcomes via a seeded percentile bootstrap instead of exact McNemar. `application/src/judge-pilot.ts` is a new Application-layer orchestration function — parallel to `application/src/judge-bundle.ts` — that drives real `runPipeline` calls into storage ports and the existing `judgeBundle` per brief per model, then feeds the paired scores to `compareGraded`. `scripts/judge-pilot.ts` is the thin CLI composition root that wires concrete adapters, mirroring `scripts/judge.ts` exactly. One contract change makes `Comparison.equalization` nullable, landing first.

**Tech Stack:** TypeScript, Vitest, the existing NexusPrompt layer stack (Contracts → Core → Application → Adapters → Shells/scripts). No new dependencies.

**Spec:** [docs/superpowers/specs/2026-09-04-judge-scored-comparison-pilot-design.md](../specs/2026-09-04-judge-scored-comparison-pilot-design.md)

## Global Constraints

- Core (`core/src/**`) may not import `node:fs`, `node:crypto`, `fetch`, or touch `Math.random`/`Date.now`/`new Date()` — enforced by `scripts/check-boundaries.mjs` and `core/test/purity.setup.ts`. `compare-graded.ts`'s bootstrap must use `rng(seed)` from `core/src/eval/generator.ts`, never `Math.random`.
- Adapters may not import `core/`, `application/`, or `shells/`. Application may not import `adapters/` — only a composition root (`scripts/*.ts`, `shells/cli/src/composition-root.ts`) may name a concrete adapter.
- Use `npm`, not `pnpm`.
- Every contract change is its own reviewed step, landing before any code that depends on it — Task 1 here, before Tasks 2–4.
- Never run `npm run build:hash` before `git add`-ing new files in the same commit — `scripts/build-hash.mjs` enumerates via `git ls-files`, so an unstaged new file is silently excluded and `check:hash`/`check:truth` fail on the committed state. Stage first, hash second, then verify the committed tree matches (e.g. `git stash -u` and re-run `npm run verify`) before trusting a pre-commit run.
- The two live, money-spending measurement runs (`build-judge-calibration.ts`, then `judge-pilot.ts`) are explicitly **not** tasks in this plan. No task here sets `ANTHROPIC_API_KEY` or calls a real model or a real hosted judge. Task 6 documents how to run them by hand, afterward.
- `eval/brief-pilot.json`, `core/src/eval/brief-generator.ts`, `application/src/judge-bundle.ts`, `adapters/provider-hosted-judge/src/index.ts`, and `core/src/eval/judge-calibration.ts` are reused unchanged. No task modifies them.

---

## Task 1: Contract change — `Comparison.equalization` becomes nullable

**Files:**
- Modify: `contracts/comparison.schema.json`
- Modify: `contracts/index.ts:220` (CONTRACT_VERSIONS), `contracts/index.ts:824-844` (Comparison interface)
- Modify: `contracts/CHANGELOG.md`
- Modify: `test/contract-conformance.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Comparison.equalization: {...} | null` — Task 2's `compareGraded` returns `equalization: null`.

- [ ] **Step 1: Write the failing contract-conformance test**

Add this test to `test/contract-conformance.test.ts`, right after the existing `"comparison requires equalization — evidence is not optional"` test (around line 830):

```ts
  it("comparison accepts a null equalization for a comparison with no detectors", () => {
    // A judge-graded comparison has no detector recall to equalize — null means "not
    // applicable to this outcome type", not "unmeasured and treated as passing".
    expect(validators["comparison"]({
      comparison_id: "c", candidate_run_id: "a", baseline_id: "b",
      verdict: "improved", delta: 0.5,
      protocol: {
        test: "paired-bootstrap", trials: 1, alpha: 0.05, comparisons_in_family: 1,
        confidence_interval: [0.1, 0.9],
      },
      equalization: null,
    })).toBe(true);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/contract-conformance.test.ts -t "null equalization"`
Expected: FAIL — `equalization` schema currently declares `"type": "object"`, which rejects `null`.

- [ ] **Step 3: Make `equalization` nullable in the schema**

In `contracts/comparison.schema.json`, change the `$id` on line 3 from `.../comparison/2.2.0` to `.../comparison/2.3.0`, and change the `equalization` property (currently `"type": "object"` at line ~140) to:

```json
    "equalization": {
      "type": ["object", "null"],
      "description": "Evidence that both runs' detectors had comparable recall, DERIVED from the two runs' measured recall blocks rather than asserted by a caller. This replaced a boolean in 1.0.0. The boolean was never computed anywhere — a summary readable without consulting evidence is a summary that gets read instead of the evidence, which is how the guard came to check nothing. Keeping it beside this object would have preserved that. Null since 2.3.0: a comparison over a detector-less outcome (a judge score, not a detector pass/fail) has nothing to equalize, and forcing a placeholder value here would be exactly the vacuous claim ADR-0016 already had to name once for position_randomized on single-candidate gradings — null means not applicable, never a fudged zero.",
```

Leave `required`, `properties`, and everything else inside the object unchanged — `required`/`properties` only constrain instances that are objects, so a `null` instance still validates once `type` admits it.

- [ ] **Step 4: Update the TypeScript type**

In `contracts/index.ts`, change the `Comparison` interface's `equalization` field (currently opens at line 824 with a comment above it):

```ts
  /**
   * Derived from both runs' measured recall, never supplied. Replaced a boolean in 1.0.0
   * that nothing computed — the guard the comparator advertised was a field callers filled in.
   * Null for a comparison with no detector-based outcome (a graded/judge score) to equalize.
   */
  equalization: {
    equalized: boolean;
    /** Null when recall was missing or unmeasurable — a refusal, not a value. */
    max_gap: number | null;
    /** = suite.resolution.detectable_delta. Derived, so it tightens as a suite grows. */
    gap_bound: number;
    /** Minimum across detectors over BOTH runs — the blunter instrument sets the resolution. */
    effective_recall: number | null;
    /** detectable_delta / effective_recall. Equals detectable_delta when recall is 1. */
    adjusted_resolution: number | null;
    per_detector: Array<{
      detector_id: string;
      candidate_recall: number | null;
      baseline_recall: number | null;
      gap: number | null;
    }>;
  } | null;
}
```

Also bump `contracts/index.ts:220`: `comparison: "2.2.0"` → `comparison: "2.3.0"`.

- [ ] **Step 5: Add the CHANGELOG entry**

Entries in `contracts/CHANGELOG.md` are newest first, headed `### \`schema\` OLD → **NEW** (minor|major|patch)` (see the existing `### \`provider-failure\` 1.0.0 → **1.1.0** (minor — widened enum)` entry for the exact style). Insert this new entry immediately after the file's opening blockquote and versioning-convention prose, before the first existing `###` entry:

```markdown
### `comparison` 2.2.0 → **2.3.0** (minor)

`equalization` is now `object | null`. It carries evidence that both runs' *detectors* had
comparable recall, and a judge-graded comparison (paired-bootstrap over continuous scores) has
no detectors at all — nothing to equalize, and nothing was equalized. Setting `equalized: true`
when nothing was checked, or any other placeholder value, would be the same vacuous claim
ADR-0016 already had to name once for `position_randomized` on single-candidate gradings. Null
means *not applicable to this comparison's outcome type*, joining this repository's existing
convention that null means unmeasured/inapplicable, never a fudged value standing in for zero.

Additive: `required` is unchanged, so the key must still be present, and every existing
producer of `Comparison` (`compare()`) still returns a non-null object — only a new producer
(`compareGraded()`) returns `null`.
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/contract-conformance.test.ts`
Expected: PASS, including the new test and every pre-existing `"comparison"` test (the `"requires equalization"` test still expects `false` when the key is *absent* — that is unaffected by making its value nullable).

- [ ] **Step 7: Typecheck and full contract suite**

Run: `npx tsc --noEmit && npx vitest run test/contract-conformance.test.ts core/test application/test`
Expected: no new type errors. `compare.ts`'s existing callers of `Comparison` still compile because they always produce a non-null `equalization` object — narrowing a field from `T` to `T | null` never breaks a producer that still returns `T`.

- [ ] **Step 8: Commit**

```bash
git add contracts/comparison.schema.json contracts/index.ts contracts/CHANGELOG.md test/contract-conformance.test.ts
git commit -m "contracts: allow Comparison.equalization to be null for detector-less comparisons"
```

---

## Task 2: `core/src/eval/compare-graded.ts` — the paired-bootstrap comparator

**Files:**
- Create: `core/src/eval/compare-graded.ts`
- Test: `core/test/compare-graded.test.ts`

**Interfaces:**
- Consumes: `Comparison`, `EvalSuite` from `../../../contracts/index.js`; `rng` from `./generator.js`.
- Produces: `GradedCaseOutcome { case_id: string; score: number; cluster_id?: string }`, `CompareGradedInput`, `compareGraded(input: CompareGradedInput): Comparison`, `isGradedSuite(suite: Pick<EvalSuite, "significance_protocol">): boolean`, `BOOTSTRAP_RESAMPLES = 10_000`, `BOOTSTRAP_SEED = 1`, `MIN_BOOTSTRAP_N = 20` — Task 4 imports `compareGraded`, `isGradedSuite`, and `GradedCaseOutcome`.

- [ ] **Step 1: Write the failing tests**

Create `core/test/compare-graded.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  compareGraded, isGradedSuite, MIN_BOOTSTRAP_N,
  type GradedCaseOutcome,
} from "../src/eval/compare-graded.js";

const gradedSuite = {
  resolution: { detectable_delta: 0.01, confidence: 0.95 },
  significance_protocol: "bootstrap-ci" as const,
};

function scores(n: number, fill: (i: number) => number): GradedCaseOutcome[] {
  return Array.from({ length: n }, (_, i) => ({ case_id: `c${i}`, score: fill(i) }));
}

describe("isGradedSuite", () => {
  it("is true only for bootstrap-ci", () => {
    expect(isGradedSuite({ significance_protocol: "bootstrap-ci" })).toBe(true);
    expect(isGradedSuite({ significance_protocol: "exact-mcnemar" })).toBe(false);
    expect(isGradedSuite({ significance_protocol: "clustered-paired" })).toBe(false);
  });
});

describe("compareGraded", () => {
  it("refuses a suite that does not declare bootstrap-ci", () => {
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(25, () => 8), baseline: scores(25, () => 8),
      suite: { ...gradedSuite, significance_protocol: "exact-mcnemar" as const },
      comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("refused");
    expect(cmp.refusal_reason).toMatch(/bootstrap-ci/);
    expect(cmp.equalization).toBeNull();
  });

  it("refuses mismatched case sets", () => {
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(25, () => 8),
      baseline: [{ case_id: "different", score: 8 }],
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("refused");
    expect(cmp.refusal_reason).toMatch(/case sets differ/);
  });

  it("refuses below the stated minimum-n floor", () => {
    const n = MIN_BOOTSTRAP_N - 1;
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(n, () => 10), baseline: scores(n, () => 6),
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("refused");
    expect(cmp.refusal_reason).toMatch(new RegExp(String(MIN_BOOTSTRAP_N)));
  });

  it("reports improved when the candidate scores consistently higher", () => {
    // 30 cases, candidate always 4 points ahead — a bootstrap CI on this should exclude 0
    // in every direction with 10,000 resamples of a constant-signed difference.
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(30, () => 9), baseline: scores(30, () => 5),
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("improved");
    expect(cmp.delta).toBeCloseTo(4, 10);
    expect(cmp.protocol.test).toBe("paired-bootstrap");
    expect(cmp.protocol.confidence_interval).not.toBeNull();
    const [lo, hi] = cmp.protocol.confidence_interval!;
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeGreaterThan(0);
    expect(cmp.equalization).toBeNull();
  });

  it("reports regressed when the baseline scores consistently higher", () => {
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(30, () => 5), baseline: scores(30, () => 9),
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("regressed");
    expect(cmp.delta).toBeCloseTo(-4, 10);
  });

  it("reports inconclusive when scores are identical on every case", () => {
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(30, () => 7), baseline: scores(30, () => 7),
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("inconclusive");
    expect(cmp.delta).toBe(0);
  });

  it("reports inconclusive, not improved or regressed, when the CI straddles zero", () => {
    // Alternating +1/-1 differences: mean is 0 but not every case agrees, unlike the
    // identical-scores case above — this exercises the CI-straddles-zero branch specifically,
    // not the zero-delta short-circuit.
    const n = 30;
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(n, (i) => (i % 2 === 0 ? 7 : 6)),
      baseline: scores(n, (i) => (i % 2 === 0 ? 6 : 7)),
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("inconclusive");
  });

  it("is deterministic across repeated calls with the same input", () => {
    const input = {
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: scores(30, (i) => 5 + (i % 3)),
      baseline: scores(30, (i) => 4 + (i % 4)),
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    };
    const first = compareGraded(input);
    const second = compareGraded(input);
    expect(second).toEqual(first);
  });

  it("refuses when either side has no cases", () => {
    const cmp = compareGraded({
      comparison_id: "cmp", candidate_run_id: "a", baseline_id: "b",
      candidate: [], baseline: [],
      suite: gradedSuite, comparisons_in_family: 1, alpha: 0.05,
    });
    expect(cmp.verdict).toBe("refused");
    expect(cmp.refusal_reason).toMatch(/no cases/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run core/test/compare-graded.test.ts`
Expected: FAIL — `core/src/eval/compare-graded.ts` does not exist yet.

- [ ] **Step 3: Implement `compare-graded.ts`**

Create `core/src/eval/compare-graded.ts`:

```ts
/**
 * The paired-bootstrap comparator, for continuous per-case scores rather than binary
 * pass/fail. `compare.ts`'s own comment has said since before this module existed: "graded
 * and free-form metrics need [bootstrap-ci] and no suite here produces them yet." This is
 * that comparator, built for exactly one shape of graded outcome so far: the brief-fidelity
 * judge's integer 0-12 rubric sum (application/src/judge-bundle.ts).
 *
 * Pure. Text and scores only — no provider, no clock, no filesystem. The bootstrap resampler
 * is seeded explicitly rather than reaching for `Math.random`, which `core/test/purity.setup.ts`
 * traps; determinism here means the same input always produces the same Comparison, not that
 * the resampling is somehow non-random.
 *
 * ── Why a separate function rather than a branch inside `compare()` ─────────────────
 *
 * `compare()` already treats "the declared protocol does not match the data's structure" as
 * a refusal-worthy problem — that is exactly what its clustered/mcnemar mismatch check does.
 * Boolean `passed` and continuous `score` are different enough shapes of data that retrofitting
 * one function to branch on both invites the same silent-wrong-runner failure this repository
 * already fixed once, for pipeline vs. single-stage eval suites: a suite scored by the wrong
 * comparator produces a real-looking Comparison record for the wrong reason.
 *
 * ── Why a stated floor, not a derived one ────────────────────────────────────────────
 *
 * `floorDiscordant` in sizing.ts gives McNemar an EXACT floor: under the null the test
 * statistic is binomial(d, 0.5), so `2 * 0.5^d` is provably the smallest attainable two-sided
 * p-value at d discordant units. A percentile bootstrap has no equivalent — its coverage is
 * asymptotic, not exact, and there is no arithmetic identity pinning a minimum n the way
 * `floorDiscordant` pins one. `MIN_BOOTSTRAP_N` below is a stated, literature-common
 * rule-of-thumb, recorded as an assumption with a name — the same posture `LEGACY_ASSUMPTIONS`
 * in sizing.ts already takes toward the binary rule's hidden 50%/50% defaults — not a proof.
 */

import type { Comparison, EvalSuite } from "../../../contracts/index.js";
import { rng } from "./generator.js";

export interface GradedCaseOutcome {
  case_id: string;
  score: number;
  /** The independent unit this outcome belongs to. Absent means the case is its own cluster. */
  cluster_id?: string;
}

export interface CompareGradedInput {
  comparison_id: string;
  candidate_run_id: string;
  baseline_id: string;
  candidate: readonly GradedCaseOutcome[];
  baseline: readonly GradedCaseOutcome[];
  suite: Pick<EvalSuite, "resolution" | "significance_protocol">;
  /** How many comparisons this one belongs to. 1 means a standalone comparison. */
  comparisons_in_family: number;
  /** Nominal significance level, before correction. */
  alpha: number;
  correction?: "none" | "bonferroni";
}

/** Bootstrap resamples per comparison. Fixed, not caller-chosen, so the function stays pure. */
export const BOOTSTRAP_RESAMPLES = 10_000;
/**
 * Seeds only the bootstrap resampler here — an unrelated constant from anchor.ts's and the
 * brief-pilot generator's own seed 1, which seed brief GENERATION, a different concern.
 */
export const BOOTSTRAP_SEED = 1;
/**
 * Stated, not derived — see the module header. A common rule-of-thumb floor for percentile
 * bootstrap CIs to be reasonably well-behaved, not a proven property of this design.
 */
export const MIN_BOOTSTRAP_N = 20;

/** Which comparator a suite wants, mirroring `isPipelineCase`'s role for the other suite split. */
export function isGradedSuite(suite: Pick<EvalSuite, "significance_protocol">): boolean {
  return suite.significance_protocol === "bootstrap-ci";
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Linear-interpolated percentile of an already-sorted array. */
function percentile(sorted: readonly number[], p: number): number {
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Paired percentile bootstrap over n signed differences. Deterministic given `seed`. */
function bootstrapCI(
  diffs: readonly number[],
  alpha: number,
  resamples: number,
  seed: number,
): [number, number] {
  const rand = rng(seed);
  const n = diffs.length;
  const means: number[] = new Array(resamples);
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += diffs[Math.floor(rand() * n)];
    means[b] = sum / n;
  }
  means.sort((a, b) => a - b);
  return [percentile(means, alpha / 2), percentile(means, 1 - alpha / 2)];
}

export function compareGraded(input: CompareGradedInput): Comparison {
  const {
    comparison_id, candidate_run_id, baseline_id, candidate, baseline,
    suite, comparisons_in_family, alpha,
  } = input;
  const correction = input.correction ?? (comparisons_in_family > 1 ? "bonferroni" : "none");
  const correctedAlpha = correction === "bonferroni" ? alpha / comparisons_in_family : alpha;

  const refuse = (reason: string): Comparison => ({
    comparison_id, candidate_run_id, baseline_id,
    verdict: "refused", refusal_reason: reason, delta: null,
    protocol: { test: "none", trials: 1, alpha: correctedAlpha, comparisons_in_family, correction },
    equalization: null,
  });

  if (!isGradedSuite(suite)) {
    return refuse(
      `suite declares significance_protocol "${suite.significance_protocol}", not "bootstrap-ci" ` +
      `— compareGraded only scores suites that declare a graded/continuous outcome.`,
    );
  }
  if (candidate.length === 0 || baseline.length === 0) {
    return refuse("one side has no cases");
  }

  const baseById = new Map(baseline.map((o) => [o.case_id, o.score]));
  const paired = candidate.filter((o) => baseById.has(o.case_id));
  if (paired.length !== candidate.length || paired.length !== baseline.length) {
    return refuse(
      `case sets differ — ${candidate.length} candidate, ${baseline.length} baseline, ` +
      `${paired.length} shared; a paired test needs the same cases on both sides`,
    );
  }
  if (paired.length < MIN_BOOTSTRAP_N) {
    return refuse(
      `this suite has ${paired.length} paired case(s); a percentile bootstrap is stated ` +
      `(not derived — see the module header) to need at least ${MIN_BOOTSTRAP_N} for its ` +
      `interval to be reasonable. Below that, reporting a CI would dress up noise as precision.`,
    );
  }

  const diffs = paired.map((o) => o.score - baseById.get(o.case_id)!);
  const delta = mean(diffs);

  const resolution = suite.resolution.detectable_delta;
  if (Math.abs(delta) > 0 && Math.abs(delta) < resolution) {
    return {
      comparison_id, candidate_run_id, baseline_id,
      verdict: "inconclusive",
      refusal_reason: `delta ${delta.toFixed(4)} is below this suite's resolution of ${resolution.toFixed(4)}`,
      delta,
      protocol: {
        test: "paired-bootstrap", trials: 1, alpha: correctedAlpha, comparisons_in_family,
        correction, effective_n: paired.length,
      },
      equalization: null,
    };
  }

  if (delta === 0) {
    return {
      comparison_id, candidate_run_id, baseline_id,
      verdict: "inconclusive",
      refusal_reason: "no difference — the two sides scored identically on every case",
      delta,
      protocol: {
        test: "paired-bootstrap", trials: 1, alpha: correctedAlpha, comparisons_in_family,
        correction, effective_n: paired.length, confidence_interval: [0, 0],
      },
      equalization: null,
    };
  }

  const [lo, hi] = bootstrapCI(diffs, correctedAlpha, BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED);
  const protocol = {
    test: "paired-bootstrap" as const,
    trials: 1,
    alpha: correctedAlpha,
    comparisons_in_family,
    correction,
    confidence_interval: [lo, hi] as [number, number],
    effective_n: paired.length,
  };

  if (lo <= 0 && hi >= 0) {
    return {
      comparison_id, candidate_run_id, baseline_id,
      verdict: "inconclusive",
      refusal_reason: `${((1 - correctedAlpha) * 100).toFixed(1)}% bootstrap CI ` +
        `[${lo.toFixed(4)}, ${hi.toFixed(4)}] includes 0`,
      delta, protocol, equalization: null,
    };
  }

  return {
    comparison_id, candidate_run_id, baseline_id,
    verdict: delta > 0 ? "improved" : "regressed",
    refusal_reason: null,
    delta, protocol, equalization: null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run core/test/compare-graded.test.ts`
Expected: PASS, all 10 tests.

- [ ] **Step 4a: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. Vitest transpiles without type-checking, so this is the step that actually
catches a type error in the new module.

- [ ] **Step 5: Purity and boundary checks**

Run: `npm run lint:boundaries && npx vitest run core/test/purity.setup.ts core/test/compare-graded.test.ts`
Expected: PASS — `compare-graded.ts` imports nothing from `node:*` and never calls `Math.random`, `Date.now`, or `new Date()`.

- [ ] **Step 6: Commit**

```bash
git add core/src/eval/compare-graded.ts core/test/compare-graded.test.ts
git commit -m "eval: compareGraded, a paired-bootstrap comparator for continuous judge scores"
```

---

## Task 3: `core/src/eval/sizing.ts` — `requiredPairedSizeContinuous`

**Files:**
- Modify: `core/src/eval/sizing.ts`
- Modify: `core/test/sizing.test.ts`

**Interfaces:**
- Consumes: `SizingAssumptions`, `zAlpha`, `zPower` (already private to `sizing.ts`), `requiredPairedSize` (existing export, used only in the cross-check test).
- Produces: `requiredPairedSizeContinuous(delta: number, sd: number, assumptions: Pick<SizingAssumptions, "alpha" | "power">): number` — used by the findings-doc instructions in Task 6, not by any other task's code.

- [ ] **Step 1: Write the failing tests**

`core/test/sizing.test.ts` currently opens with:

```ts
import { describe, it, expect } from "vitest";
import {
  LEGACY_ASSUMPTIONS, STATED_ASSUMPTIONS, attainable, floorDiscordant, legacyAnchorSize,
  minAttainableP, requiredPairedSize, resolvableDelta,
} from "../src/eval/sizing.js";
```

Change the second import to add `requiredPairedSizeContinuous`:

```ts
import {
  LEGACY_ASSUMPTIONS, STATED_ASSUMPTIONS, attainable, floorDiscordant, legacyAnchorSize,
  minAttainableP, requiredPairedSize, requiredPairedSizeContinuous, resolvableDelta,
} from "../src/eval/sizing.js";
```

Then add this `describe` block to the file (top-level, alongside the existing `describe("the exact significance floor", ...)` block):

```ts
  describe("requiredPairedSizeContinuous", () => {
    it("rejects a non-positive delta", () => {
      expect(() => requiredPairedSizeContinuous(0, 1, { alpha: 0.05, power: 0.8 }))
        .toThrow(/positive delta/);
      expect(() => requiredPairedSizeContinuous(-1, 1, { alpha: 0.05, power: 0.8 }))
        .toThrow(/positive delta/);
    });

    it("rejects a non-positive sd", () => {
      expect(() => requiredPairedSizeContinuous(1, 0, { alpha: 0.05, power: 0.8 }))
        .toThrow(/positive sd/);
      expect(() => requiredPairedSizeContinuous(1, -2, { alpha: 0.05, power: 0.8 }))
        .toThrow(/positive sd/);
    });

    it("reduces to requiredPairedSize in the Bernoulli limit", () => {
      // Var(±1/0 discordance indicator at rate p_d) = p_d, so sd = sqrt(p_d) is the
      // continuous rule's input that specializes to the binary rule at the same delta.
      const pd = 0.2778; // sub-project 1's measured discordance rate
      const delta = 0.08;
      const assumptions = { alpha: 0.05, power: 0.8 };
      const continuous = requiredPairedSizeContinuous(delta, Math.sqrt(pd), assumptions);
      const binary = requiredPairedSize(delta, { ...assumptions, discordanceRate: pd });
      expect(continuous).toBe(binary);
    });

    it("grows with sd and shrinks with a larger delta", () => {
      const assumptions = { alpha: 0.05, power: 0.8 };
      const small = requiredPairedSizeContinuous(2, 1, assumptions);
      const largerSd = requiredPairedSizeContinuous(2, 2, assumptions);
      const largerDelta = requiredPairedSizeContinuous(4, 1, assumptions);
      expect(largerSd).toBeGreaterThan(small);
      expect(largerDelta).toBeLessThan(small);
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run core/test/sizing.test.ts -t "requiredPairedSizeContinuous"`
Expected: FAIL — `requiredPairedSizeContinuous` is not exported yet.

- [ ] **Step 3: Implement it**

In `core/src/eval/sizing.ts`, add this after `requiredPairedSize` (which ends just before `resolvableDelta`):

```ts
/**
 * The continuous analog of `requiredPairedSize`: items needed to resolve a true paired-mean
 * difference of `delta`, given the observed standard deviation of the paired differences.
 * `n ≳ (z_α + z_β)² · sd² / Δ²` — reduces exactly to `requiredPairedSize` when `sd = sqrt(p_d)`,
 * since Var(a ±1/0 discordance indicator at rate p_d) is p_d. See `sizing.test.ts`'s
 * Bernoulli-limit cross-check, the same discipline `LEGACY_ASSUMPTIONS` uses to keep the old
 * and corrected binary rules from drifting apart.
 *
 * Unlike `discordanceRate`, `sd` is not bounded to (0, 1] — a 0-12 score's paired differences
 * range over [-12, 12], so `sd` is validated only as strictly positive.
 */
export function requiredPairedSizeContinuous(
  delta: number,
  sd: number,
  assumptions: Pick<SizingAssumptions, "alpha" | "power">,
): number {
  const { alpha, power } = assumptions;
  if (!(delta > 0)) {
    throw new Error(`requiredPairedSizeContinuous needs a positive delta, got ${delta}.`);
  }
  if (!(sd > 0)) {
    throw new Error(`requiredPairedSizeContinuous needs a positive sd, got ${sd}.`);
  }
  const z = zAlpha(alpha) + zPower(power);
  return Math.ceil((z * z * sd * sd) / (delta * delta));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run core/test/sizing.test.ts`
Expected: PASS, including every pre-existing test in the file (nothing else in `sizing.ts` changed).

- [ ] **Step 4a: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add core/src/eval/sizing.ts core/test/sizing.test.ts
git commit -m "eval: requiredPairedSizeContinuous, the paired-t-test analog for graded scores"
```

---

## Note: a deliberate split from the spec's literal wording

The design spec describes the orchestration as one file, `scripts/judge-pilot.ts` (its
Architecture §3), but also requires `application/test/judge-pilot.test.ts` to drive the
orchestration end-to-end against fakes (its Testing strategy section) — and Application tests
cannot import from `scripts/`, since `scripts/` sits outside the layer stack as a composition
root and nothing in `application/` may depend on it. Tasks 4 and 5 below satisfy both
requirements by following the exact split this codebase already uses for
`application/src/judge-bundle.ts` / `scripts/judge.ts`: the testable orchestration logic lives
in `application/src/judge-pilot.ts`, and `scripts/judge-pilot.ts` is the thin composition root
that names concrete adapters and calls it. This is not a scope change — every piece of behavior
the spec describes is still built — only which file owns which part of it.

## Task 4: `application/src/judge-pilot.ts` — the orchestration function

**Files:**
- Create: `application/src/judge-pilot.ts`
- Test: `application/test/judge-pilot.test.ts`

**Interfaces:**
- Consumes: `runPipeline` from `./pipeline.js`; `judgeBundle`, `JudgeBundleRefused` from `./judge-bundle.js`; `compareGraded`, `isGradedSuite`, type `GradedCaseOutcome` from `../../core/src/eval/compare-graded.js`; type `Calibration` from `../../core/src/eval/judge-policy.js`; types `ProviderTransport, RevisionStore, ContentStore, EvidenceStore, JudgeTransport, Comparison` from `../../contracts/index.js`.
- Produces: `JudgePilotBrief { case_id: string; brief: string }`, `JudgePilotDeps`, `JudgePilotResult { comparison: Comparison; survived_n: number; nominal_n: number; dropped: Array<{ case_id: string; reason: string }> }`, `runJudgePilot(deps: JudgePilotDeps, briefs: readonly JudgePilotBrief[]): Promise<JudgePilotResult>` — Task 5's `scripts/judge-pilot.ts` calls this directly.

- [ ] **Step 1: Write the failing tests**

Create `application/test/judge-pilot.test.ts`. This mirrors `application/test/judge-bundle-real-run.test.ts`'s pattern (real `runPipeline`, real local storage, scripted fakes, never a network) but drives the whole pilot rather than one run:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJudgePilot, type JudgePilotBrief } from "../src/judge-pilot.js";
import { LocalRevisionStore } from "../../adapters/storage-local/src/index.js";
import { LocalContentStore } from "../../adapters/content-local/src/index.js";
import { LocalEvidenceStore } from "../../adapters/evidence-local/src/index.js";
import type {
  GenerationRequest, GenerationResult, ProviderFailure, ProviderTransport,
  JudgeTransport, JudgeRequest, JudgeVerdict,
} from "../../contracts/index.js";

/** Produces a distinctive, per-provider compiled prompt so candidate and baseline can differ. */
class ScriptedProvider implements ProviderTransport {
  constructor(private readonly compiledPrompt: string, readonly provider_id = "scripted") {}
  async generate(req: GenerationRequest): Promise<GenerationResult> {
    const text = req.messages[0].content;
    const content = text.includes("STEP 2 — SCAFFOLDING") || text.includes("GUARDRAILING")
      ? this.compiledPrompt
      : "ok";
    return {
      request_id: req.request_id, content,
      provider_id: this.provider_id, model_id: this.provider_id, finish_reason: "end_turn",
    };
  }
  async healthCheck() {
    return { ok: true, checked_at: "1970-01-01T00:00:00.000Z", latency_ms: 0,
             degradation_state: "NONE" as const, failing_dependency: null };
  }
}

/** Fails every call, to exercise the demo-mode drop path. */
class DeadProvider implements ProviderTransport {
  readonly provider_id = "dead";
  async generate(req: GenerationRequest): Promise<ProviderFailure> {
    return {
      request_id: req.request_id, category: "UNAVAILABLE", retriable: false,
      reason_code: "no_api_key", safe_message: "No key.", retry_after_ms: null,
      attempt: 1, provider_id: this.provider_id,
    };
  }
  async healthCheck() {
    return { ok: false, checked_at: "1970-01-01T00:00:00.000Z", latency_ms: 0,
             degradation_state: "UNAVAILABLE" as const, failing_dependency: "provider" };
  }
}

/** Scores by looking for a marker planted in the compiled prompt — never a network. */
class MarkerJudge implements JudgeTransport {
  readonly judge_id = "marker-judge";
  readonly judge_family = "reviewer";
  async grade(req: JudgeRequest): Promise<JudgeVerdict> {
    const high = req.candidate.includes("HIGH_FIDELITY_MARKER");
    const dims = high
      ? { domain_captured: 3, constraints_honored: 3, completeness: 3, no_overreach: 3 }
      : { domain_captured: 1, constraints_honored: 1, completeness: 1, no_overreach: 1 };
    const rubric_breakdown = Object.fromEntries(
      Object.entries(dims).map(([k, v]) => [k, { score: v, reason: "scripted" }]),
    );
    return {
      verdict: Object.values(dims).reduce((a, b) => a + b, 0), rationale: null,
      judge_id: this.judge_id, judge_family: this.judge_family,
      rubric_id: req.rubric_id, rubric_hash: req.rubric_hash,
      runs: req.runs, disagreement_rate: 0, position_randomized: req.position_randomized,
      rubric_breakdown,
    };
  }
}

const CALIBRATION = {
  metric: "cohens-kappa" as const, value: 0.82, threshold: 0.6,
  measured_at: "2026-09-04T00:01:00.000Z", reference: "mutation-derived-v1", max_age_days: 30,
};

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

function makeDeps(candidateProvider: ProviderTransport, baselineProvider: ProviderTransport) {
  const root = mkdtempSync(join(tmpdir(), "judge-pilot-"));
  temps.push(root);
  let tick = 0;
  return {
    candidateProvider, baselineProvider,
    revisions: new LocalRevisionStore(join(root, "runs")),
    content: new LocalContentStore(join(root, "content")),
    evidence: new LocalEvidenceStore(join(root, "evidence")),
    transport: new MarkerJudge(),
    calibration: CALIBRATION,
    now: () => new Date(1_760_000_000_000 + tick++ * 10),
    coreBuildHash: "test",
  };
}

const briefs = (n: number): JudgePilotBrief[] =>
  Array.from({ length: n }, (_, i) => ({
    case_id: `brief-${i}`,
    brief: `A support assistant for team ${i}. It answers questions about invoices.`,
  }));

describe("runJudgePilot", () => {
  it("pairs candidate and baseline scores and reports an improved verdict", async () => {
    const deps = makeDeps(
      new ScriptedProvider("# SYSTEM PROMPT\n\nHIGH_FIDELITY_MARKER present."),
      new ScriptedProvider("# SYSTEM PROMPT\n\nno marker here."),
    );
    const result = await runJudgePilot(deps, briefs(25));

    expect(result.nominal_n).toBe(25);
    expect(result.survived_n).toBe(25);
    expect(result.dropped).toHaveLength(0);
    expect(result.comparison.verdict).toBe("improved");
    expect(result.comparison.delta).toBeCloseTo(8, 10); // 12 - 4, every case
  }, 30_000);

  it("drops a brief whose baseline run degrades, rather than imputing or crashing", async () => {
    const deps = makeDeps(
      new ScriptedProvider("# SYSTEM PROMPT\n\nHIGH_FIDELITY_MARKER present."),
      new DeadProvider(),
    );
    const result = await runJudgePilot(deps, briefs(25));

    expect(result.nominal_n).toBe(25);
    expect(result.survived_n).toBe(0);
    expect(result.dropped).toHaveLength(25);
    expect(result.dropped[0].reason).toMatch(/demo-mode-run/);
    expect(result.comparison.verdict).toBe("refused"); // 0 survived < MIN_BOOTSTRAP_N
  }, 30_000);

  it("survives more briefs than LocalRevisionStore's eight-bundle cap by judging each run immediately", async () => {
    // The whole reason run-then-judge must happen per brief rather than in two batch phases:
    // LocalRevisionStore evicts down to 8 complete bundles, and this pilot's real run judges
    // 100. With 12 briefs through one store here, a batch-all-runs-then-batch-all-judge
    // ordering would have evicted the first four bundles before they were ever judged. This
    // asserts the actual behaviour survives that cap, not merely that the code compiles.
    const deps = makeDeps(
      new ScriptedProvider("# SYSTEM PROMPT\n\nHIGH_FIDELITY_MARKER present."),
      new ScriptedProvider("# SYSTEM PROMPT\n\nno marker here."),
    );
    const result = await runJudgePilot(deps, briefs(12));

    expect(result.survived_n).toBe(12);
    expect(result.dropped).toHaveLength(0);
  }, 30_000);

  it("refuses via compareGraded, not a thrown error, when nothing survives", async () => {
    const deps = makeDeps(new DeadProvider(), new DeadProvider());
    const result = await runJudgePilot(deps, briefs(5));
    expect(result.comparison.verdict).toBe("refused");
    expect(result.survived_n).toBe(0);
  }, 30_000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run application/test/judge-pilot.test.ts`
Expected: FAIL — `application/src/judge-pilot.ts` does not exist yet.

- [ ] **Step 3: Implement `judge-pilot.ts`**

Create `application/src/judge-pilot.ts`:

```ts
/**
 * Orchestrates one judge-scored provider comparison pilot: for each brief, runs a real
 * pipeline through two models, judges each compiled prompt with the existing GuardedJudge
 * (via judgeBundle, unchanged), pairs the resulting scores by brief, and compares them with
 * compareGraded. Owns the one live effect this needs beyond what judgeBundle already owns:
 * looping over briefs and models and writing the resulting Comparison as evidence.
 *
 * ── Why run-then-judge per brief, not run-everything then judge-everything ──────────────
 *
 * `LocalRevisionStore` keeps only eight complete run bundles per store and evicts the rest —
 * see CLAUDE.md, "Local storage retains run bundles, not entries." A real pilot writes 200
 * run bundles (100 briefs x 2 models). Running all 200 first and judging afterward would
 * evict most of them, silently, before they were ever read — the eviction is invisible from
 * the caller's side, so the failure would look like missing content refs, not like the actual
 * cause. Judging a run immediately after it completes, before moving to the next brief, means
 * at most one or two un-judged bundles exist in a store at any moment — always far under the
 * cap regardless of its exact eviction policy. See judge-pilot.test.ts's cap-survival test.
 *
 * ── Why candidate and baseline share one store, distinguished by run_id ─────────────────
 *
 * Content is already shared by hash across runs and never evicted by count, so there is
 * nothing to gain by splitting it. Revisions are namespaced by run_id
 * (`${case_id}-candidate` / `${case_id}-baseline`), which is enough to keep the two models'
 * revisions from ever landing in the same bundle — the actual hazard a shared store would
 * otherwise create — while still needing only one directory to wire.
 */
import { randomUUID } from "node:crypto";
import { runPipeline } from "./pipeline.js";
import { judgeBundle, JudgeBundleRefused } from "./judge-bundle.js";
import { compareGraded, isGradedSuite, type GradedCaseOutcome } from "../../core/src/eval/compare-graded.js";
import type { Calibration } from "../../core/src/eval/judge-policy.js";
import type {
  ProviderTransport, RevisionStore, ContentStore, EvidenceStore, JudgeTransport, Comparison,
} from "../../contracts/index.js";

export interface JudgePilotBrief {
  case_id: string;
  brief: string;
}

export interface JudgePilotDeps {
  candidateProvider: ProviderTransport;
  baselineProvider: ProviderTransport;
  revisions: RevisionStore;
  content: ContentStore;
  evidence: EvidenceStore;
  transport: JudgeTransport;
  calibration: Calibration;
  now: () => Date;
  coreBuildHash: string;
}

export interface JudgePilotResult {
  comparison: Comparison;
  survived_n: number;
  nominal_n: number;
  dropped: Array<{ case_id: string; reason: string }>;
}

async function gradeOneSide(
  deps: JudgePilotDeps,
  provider: ProviderTransport,
  run_id: string,
  brief: string,
  nowIso: string,
): Promise<number> {
  await runPipeline(
    {
      command_id: `${run_id}-cmd`, run_id, stage_id: "deconstruct",
      input: { brief }, context: { depth: "TINY", stakes: "LOW" },
    },
    {
      provider, store: deps.revisions, content: deps.content,
      sink: { emit: () => {} }, now: deps.now, coreBuildHash: deps.coreBuildHash,
    },
  );
  const judgement = await judgeBundle(
    {
      revisions: deps.revisions, content: deps.content,
      evidence: deps.evidence, transport: deps.transport, calibration: deps.calibration,
    },
    run_id, nowIso,
  );
  if (typeof judgement.verdict.verdict !== "number") {
    throw new JudgeBundleRefused(
      "non-numeric-verdict",
      `Run "${run_id}" was judged with a non-numeric verdict (${typeof judgement.verdict.verdict}); ` +
      `the brief-fidelity rubric always produces a number — this indicates a different rubric ran.`,
    );
  }
  return judgement.verdict.verdict;
}

export async function runJudgePilot(
  deps: JudgePilotDeps,
  briefs: readonly JudgePilotBrief[],
): Promise<JudgePilotResult> {
  const candidateScores: GradedCaseOutcome[] = [];
  const baselineScores: GradedCaseOutcome[] = [];
  const dropped: Array<{ case_id: string; reason: string }> = [];

  for (const { case_id, brief } of briefs) {
    const nowIso = deps.now().toISOString();
    let candidateScore: number;
    let baselineScore: number;

    try {
      candidateScore = await gradeOneSide(
        deps, deps.candidateProvider, `${case_id}-candidate`, brief, nowIso,
      );
    } catch (err) {
      const reason = err instanceof JudgeBundleRefused ? err.code : (err as Error).message;
      dropped.push({ case_id, reason: `candidate: ${reason}` });
      continue;
    }

    try {
      baselineScore = await gradeOneSide(
        deps, deps.baselineProvider, `${case_id}-baseline`, brief, nowIso,
      );
    } catch (err) {
      const reason = err instanceof JudgeBundleRefused ? err.code : (err as Error).message;
      dropped.push({ case_id, reason: `baseline: ${reason}` });
      continue;
    }

    candidateScores.push({ case_id, score: candidateScore });
    baselineScores.push({ case_id, score: baselineScore });
  }

  const suite = {
    resolution: {
      detectable_delta: Number((1 / Math.max(briefs.length, 1)).toPrecision(3)),
      confidence: 0.95,
      sized_for: briefs.length,
    },
    significance_protocol: "bootstrap-ci" as const,
  };
  if (!isGradedSuite(suite)) {
    // Unreachable given the literal above — asserted rather than assumed, the same posture
    // this module takes toward every other internally-constructed value.
    throw new Error("judge-pilot: internal suite descriptor is not graded-shaped — this is a bug.");
  }

  const comparison = compareGraded({
    comparison_id: randomUUID(),
    candidate_run_id: "judge-pilot-candidate",
    baseline_id: "judge-pilot-baseline",
    candidate: candidateScores,
    baseline: baselineScores,
    suite,
    comparisons_in_family: 1,
    alpha: 0.05,
  });

  const now = deps.now();
  await deps.evidence.put({
    kind: "comparison", id: comparison.comparison_id,
    created_at: now.toISOString(), body: comparison,
  });

  return {
    comparison, survived_n: candidateScores.length, nominal_n: briefs.length, dropped,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run application/test/judge-pilot.test.ts`
Expected: PASS, all 4 tests. The third test (cap-survival with 12 briefs) is the one worth reading carefully if it fails — it is asserting an ordering property, not just a return value.

- [ ] **Step 4a: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Boundary check**

Run: `npm run lint:boundaries`
Expected: PASS — `application/src/judge-pilot.ts` imports only `core/`, `contracts/`, and `node:crypto` (which Application, unlike Core, is allowed to touch), never an adapter.

- [ ] **Step 6: Full application suite**

Run: `npx vitest run application/test`
Expected: PASS — nothing in `judge-bundle.ts` or `pipeline.ts` was modified, so their existing tests are unaffected.

- [ ] **Step 7: Commit**

```bash
git add application/src/judge-pilot.ts application/test/judge-pilot.test.ts
git commit -m "application: judge-pilot orchestration — pair two models' judged scores per brief"
```

---

## Task 5: `scripts/judge-pilot.ts` — the CLI composition root

**Files:**
- Create: `scripts/judge-pilot.ts`
- Modify: `package.json` (add `"judge:pilot"` script)

**Interfaces:**
- Consumes: `runJudgePilot`, `JudgePilotDeps`, `JudgePilotBrief` from `../application/src/judge-pilot.js`; `buildBriefCorpus` from `../core/src/eval/brief-generator.js`; `validateCalibrationArtifact` from `../core/src/eval/judge-calibration.js`; concrete adapters `LocalRevisionStore`, `LocalContentStore`, `LocalEvidenceStore`, `OllamaProvider`, `HostedJudgeTransport`.
- Produces: an executable script (`npm run judge:pilot`) and nothing else — no other task imports from `scripts/`.

- [ ] **Step 1: Confirm the adapter constructors this script needs**

No test for this step — it is a read-only check before writing code that names concrete adapters. Run:

```bash
grep -n "constructor(opts: OllamaOptions" -A 8 adapters/provider-ollama/src/index.ts
```

Expected output: confirms `new OllamaProvider({ model: "..." })` is the correct construction (matches `composition-root.ts`'s own `chooseProvider`, which does exactly this).

- [ ] **Step 2: Write `scripts/judge-pilot.ts`**

```ts
/**
 * npm run judge:pilot
 *
 * Sub-project 4: runs the 100 brief-pilot briefs (seed 1, count 100 — identical to
 * eval/brief-pilot.json's own generator call, see scripts/build-brief-pilot.ts) through two
 * local models at TINY depth, judges each compiled prompt with the real hosted judge, and
 * compares the two score sequences with a paired bootstrap. Composition root — the one file
 * here permitted to name concrete adapters; application/src/judge-pilot.ts sees only ports.
 *
 * Dedicated storage under `.nexusprompt-judge-pilot/`, NOT the CLI's own `.nexusprompt/`:
 * LocalRevisionStore keeps only 8 run bundles per store and this pilot writes 200 (100 briefs
 * x 2 models), so sharing the operator's own directory would both evict their unrelated runs
 * and risk this pilot's own bundles being evicted by unrelated CLI use running concurrently.
 * See application/src/judge-pilot.ts's header for why writing 200 bundles into an 8-slot
 * store is safe regardless: each is judged immediately, before the next brief starts.
 *
 * Spends real money against api.anthropic.com (up to 100 x 2 x 3 = 600 calls, one HostedJudgeTransport
 * grading per side per brief) and requires phi4-mini:latest and lfm2.5-thinking:latest already
 * pulled in a local Ollama daemon. Refuses up front, before any of that, if the prerequisites
 * are not met.
 */
import { readFileSync } from "node:fs";
import { LocalRevisionStore } from "../adapters/storage-local/src/index.js";
import { LocalContentStore } from "../adapters/content-local/src/index.js";
import { LocalEvidenceStore } from "../adapters/evidence-local/src/index.js";
import { OllamaProvider } from "../adapters/provider-ollama/src/index.js";
import { HostedJudgeTransport } from "../adapters/provider-hosted-judge/src/index.js";
import { validateCalibrationArtifact } from "../core/src/eval/judge-calibration.js";
import { buildBriefCorpus } from "../core/src/eval/brief-generator.js";
import { runJudgePilot, type JudgePilotBrief } from "../application/src/judge-pilot.js";

const CANDIDATE_MODEL = "lfm2.5-thinking:latest";
const BASELINE_MODEL = "phi4-mini:latest";
const SEED = 1;
const COUNT = 100;

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "judge-pilot: ANTHROPIC_API_KEY is not set in this process's environment.\n\n" +
      "  This pilot judges up to 200 compiled prompts against api.anthropic.com and spends money.",
    );
    process.exit(2);
  }

  let calibration: Record<string, unknown>;
  try {
    calibration = JSON.parse(readFileSync("eval/judge-calibration.json", "utf8"));
  } catch {
    console.error(
      "judge-pilot: eval/judge-calibration.json does not exist. Run\n" +
      "  ANTHROPIC_API_KEY=... npx tsx scripts/build-judge-calibration.ts\n" +
      "first (see ADR-0016) — the judge refuses to grade anything without a measured calibration.",
    );
    process.exit(2);
  }

  const problems = validateCalibrationArtifact(calibration);
  if (problems.length > 0) {
    console.error(
      "judge-pilot: eval/judge-calibration.json is not a valid calibration artifact, so it is " +
      "not evidence about anything. Refusing to run.\n" +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\n\n  Re-measure with `npm run build:judge-calibration` rather than editing it by hand.",
    );
    process.exit(2);
  }

  const briefs: JudgePilotBrief[] = buildBriefCorpus({ seed: SEED, count: COUNT }).map((c) => ({
    case_id: c.case_id,
    brief: c.input.brief,
  }));

  const deps = {
    candidateProvider: new OllamaProvider({ model: CANDIDATE_MODEL }),
    baselineProvider: new OllamaProvider({ model: BASELINE_MODEL }),
    revisions: new LocalRevisionStore(".nexusprompt-judge-pilot/runs"),
    content: new LocalContentStore(".nexusprompt-judge-pilot/content"),
    evidence: new LocalEvidenceStore(".nexusprompt-judge-pilot/evidence"),
    transport: new HostedJudgeTransport(),
    calibration: {
      metric: "cohens-kappa" as const,
      // Safe only because validateCalibrationArtifact ran above and checked every field's type.
      value: calibration.cohens_kappa as number,
      threshold: calibration.threshold as number,
      measured_at: `${calibration.measured_on as string}T00:00:00.000Z`,
      reference: calibration.reference as string,
      max_age_days: calibration.max_age_days as number,
    },
    now: () => new Date(),
    coreBuildHash: "judge-pilot",
  };

  const result = await runJudgePilot(deps, briefs);

  console.log(
    `judge-pilot: ${result.survived_n}/${result.nominal_n} briefs survived pairing.\n` +
    `  verdict: ${result.comparison.verdict}\n` +
    `  delta: ${result.comparison.delta ?? "n/a"}\n` +
    `  confidence_interval: ${JSON.stringify(result.comparison.protocol.confidence_interval ?? null)}\n` +
    `  comparison_id: ${result.comparison.comparison_id}` +
    (result.comparison.refusal_reason ? `\n  refusal_reason: ${result.comparison.refusal_reason}` : ""),
  );
  if (result.dropped.length > 0) {
    console.log(`  dropped ${result.dropped.length} brief(s):`);
    for (const d of result.dropped) console.log(`    ${d.case_id}: ${d.reason}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`judge-pilot: failed — ${(err as Error).message}`);
  process.exit(1);
});
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. This script is not covered by an automated test (it names concrete adapters and would reach a real network and a real Ollama daemon) — its correctness rests on `application/test/judge-pilot.test.ts` (Task 4) proving the orchestration logic it calls, and on this typecheck proving the wiring compiles.

- [ ] **Step 4: Add the npm script**

In `package.json`, add (next to the existing `"judge": "tsx scripts/judge.ts"` entry, following the same naming convention as `"build:judge-calibration"`):

```json
    "judge:pilot": "tsx scripts/judge-pilot.ts",
```

Do **not** add `judge:pilot` to the `verify` script's chain — it spends real money and requires a live Ollama daemon and API key, the same reason `build:judge-calibration` is excluded from `verify`.

- [ ] **Step 5: Verify it is excluded from `verify`**

Run:

```bash
grep -n "\"verify\":" package.json
```

Expected: the printed `verify` line's `&&`-chained command list does not contain `judge:pilot` anywhere in it (visually confirm — the line is long, so read it fully rather than assuming).

- [ ] **Step 6: Commit**

```bash
git add scripts/judge-pilot.ts package.json
git commit -m "scripts: judge-pilot CLI composition root; npm run judge:pilot"
```

---

## Task 6: Findings-doc template and the live-run runbook

**Files:**
- Create: `docs/superpowers/plans/judge-pilot-findings-TEMPLATE.md`

**Interfaces:**
- Consumes: nothing — this task writes documentation only, no source code.
- Produces: a template file a human copies to a real, dated findings doc after running the two live steps.

No code in this task, so no test-driven steps — the "test" is a completeness read-through against the checklist below.

- [ ] **Step 1: Write the template**

Create `docs/superpowers/plans/judge-pilot-findings-TEMPLATE.md`:

```markdown
# Judge-scored provider comparison pilot — findings

> Copy this file to `docs/superpowers/plans/YYYY-MM-DD-judge-pilot-findings.md` (today's date)
> after running the pilot for real, fill in every `<TODO>`, and delete this header line and
> this blockquote. Do not commit this template itself with any `<TODO>` filled in — the
> template stays a template, and the findings doc is the copy that carries real numbers.

**Status:** <TODO: "Complete, real run" or "Blocked: <reason>">
**Sub-project:** 4 (judge-scored comparison pilot), an offshoot of 2 and 3
**Spec:** `docs/superpowers/specs/2026-09-04-judge-scored-comparison-pilot-design.md`
**Run date:** <TODO: date the live pilot actually ran>

## What ran

- Calibration: `<TODO: cohens_kappa value>` (threshold 0.6) — <TODO: pass/fail>, measured `<TODO: date>`
- Pilot: `<TODO: survived_n>` / 100 briefs survived pairing (`<TODO: N>` dropped — see the
  script's own `dropped` output for why, per brief)
- Comparison id: `<TODO: comparison_id>`, evidence record at `.nexusprompt-judge-pilot/evidence/`

## The measurement

- **Δ (mean paired score difference, 0-12 scale):** `<TODO>`
- **Bootstrap CI (95%):** `<TODO: [lo, hi]>`
- **Verdict:** `<TODO: improved / regressed / inconclusive / refused>`
- **Implied full-anchor size**, via `requiredPairedSizeContinuous(Δ, sd, {alpha: 0.05, power: 0.8})`
  where `sd` is the sample standard deviation of the survived paired differences: `<TODO>`
- **Constant-case fraction** (briefs where both models scored identically): `<TODO>` / `<TODO: survived_n>`

## Pays or does not pay

<TODO: state the verdict plainly, using the same two criteria sub-project 2's own findings doc
used — is the implied size materially below what sub-project 2 needed (341 cases at the
original discordance rate, or 137,356 at the measured brief-pilot Δ), and is the constant-case
fraction meaningfully lower than the binary pilot's 72%?>

## Direct comparison to sub-project 2

| | sub-project 2 (binary detectors) | sub-project 4 (judge, 0-12) |
|---|---|---|
| Δ | 0.4 pp | `<TODO>` |
| constant-case fraction | 72% | `<TODO>` |
| implied size | 137,356 | `<TODO>` |
| verdict | does not pay | `<TODO>` |

## What this does not establish

<TODO: copy the design spec's "What this does NOT establish" section verbatim — it does not
change based on the measurement's outcome.>
```

- [ ] **Step 2: Write the live-run runbook**

Add this section to the same file, below what Step 1 wrote (still inside the template — the runbook is instructions, not a `<TODO>` to fill in, so it is copied into the real findings doc unchanged as a record of how the numbers above were produced):

```markdown
## How this was run

1. **Calibration** (skip if `eval/judge-calibration.json` already exists and
   `npm run check:judge` passes):

   ```bash
   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/build-judge-calibration.ts
   ```

   Confirm it printed a kappa >= 0.6 before continuing. If it did not, this pilot is blocked —
   `admitJudge` refuses every grading below threshold, so the pilot script's own guard would
   also refuse before spending anything on the pilot itself.

2. **Confirm the local models are pulled:**

   ```bash
   ollama list | grep -E "phi4-mini:latest|lfm2.5-thinking:latest"
   ```

   Pull whichever is missing (`ollama pull <name>`) before continuing.

3. **Run the pilot:**

   ```bash
   ANTHROPIC_API_KEY=sk-ant-... npm run judge:pilot
   ```

   This is the expensive, irreversible step — up to 600 calls to `claude-opus-5` and 200 local
   pipeline runs. It prints the verdict, delta, confidence interval, comparison id, and every
   dropped brief with its reason directly to stdout when it finishes.

4. **Copy this template** to `docs/superpowers/plans/<today>-judge-pilot-findings.md`, fill in
   every `<TODO>` from the script's printed output (and `sd`, computed by hand or with a short
   throwaway script over the survived paired differences — this repository has no committed
   tool for it, since it is a one-time number for one findings doc, not a reusable check).

5. **Commit the findings doc** (not this template — this template stays as it is, for the next
   time this pilot needs re-running with different models or a different judge).
```

- [ ] **Step 3: Read-through check**

No automated test. Read the completed file against this checklist:
- Every section from the design spec's stated findings-doc contents (Δ, CI, survived n, implied size, constant-case fraction, pays/does-not-pay verdict, comparison to sub-project 2) has a corresponding `<TODO>` line.
- The runbook's four commands are copy-pasteable as written (no placeholder host names, no invented flags).
- Nothing in this file sets `ANTHROPIC_API_KEY` or invokes either live script itself — it only tells a human how to.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/judge-pilot-findings-TEMPLATE.md
git commit -m "docs: judge-pilot findings template and live-run runbook"
```

---

## After this plan lands

`npm run verify` should be green with no new failures (nothing in this plan wires either live script into it). At that point, the two live steps in Task 6's runbook are ready to run by hand, each requiring its own separate go-ahead before it spends anything — this plan builds the instrument; running it for real is a deliberate follow-up action, not an automatic consequence of merging.
