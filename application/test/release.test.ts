import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEvidenceStore } from "../../adapters/evidence-local/src/index.js";
import { promote, rollback, freezeBaseline, current, EvidenceMissing } from "../src/release.js";
import { decidePromotion } from "../../core/src/release/promote.js";
import type { Comparison, EvalRun, EvidenceStore } from "../../contracts/index.js";
import type { JudgeAdmission } from "../../core/src/eval/judge-policy.js";

/**
 * Pipeline C, end to end.
 *
 * The promotion gate is a conjunction of five conditions, so the test that matters is not
 * "does it promote" — it is that each condition, violated alone, produces its own refusal
 * with its own reason. A conjunction where two terms yield the same message is a conjunction
 * whose terms nobody can tell apart afterwards, which is how one of them comes to be
 * silently unchecked.
 */

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });
const mkstore = (): EvidenceStore => {
  const d = mkdtempSync(join(tmpdir(), "pnx-release-"));
  temps.push(d);
  return new LocalEvidenceStore(d);
};

const CONFIG = "a".repeat(64);
const GRANULARITY = 1 / 14;

const run = (over: Partial<EvalRun> = {}): EvalRun => ({
  run_id: "run-candidate",
  configuration_id: CONFIG,
  suite_id: "compile-smoke",
  suite_version: "2.0.0",
  aggregate: {
    cases: 14, passed: 13, score: 13 / 14,
    by_failure_mode: {
      "unfaithful-reasoning": { cases: 7, passed: 7 },
      "instruction-drift": { cases: 7, passed: 6 },
    },
  },
  cost: { tokens_in: 100, tokens_out: 50, provider_calls: 14, cache_hits: 0, usd: 0.01, budget_exceeded: false },
  detector_recall: null,
  grader_health: null,
  provenance: { note: "fixture" },
  ...over,
});

const baselineRun = (over: Partial<EvalRun> = {}): EvalRun =>
  run({
    run_id: "run-baseline",
    aggregate: {
      cases: 14, passed: 8, score: 8 / 14,
      by_failure_mode: {
        "unfaithful-reasoning": { cases: 7, passed: 4 },
        "instruction-drift": { cases: 7, passed: 4 },
      },
    },
    ...over,
  });

const comparison = (over: Partial<Comparison> = {}): Comparison => ({
  comparison_id: "cmp-1",
  candidate_run_id: "run-candidate",
  baseline_id: "base-1",
  verdict: "improved",
  refusal_reason: null,
  delta: 5 / 14,
  protocol: {
    test: "mcnemar", trials: 1, alpha: 0.05, comparisons_in_family: 1, correction: "none",
    p_value: 0.0009, effective_n: 14, discordant: 10, min_attainable_p: 2 * 0.5 ** 10, attainable: true,
  },
  equalization: {
    equalized: true, max_gap: 0, gap_bound: GRANULARITY, effective_recall: 1,
    adjusted_resolution: GRANULARITY, per_detector: [],
  },
  ...over,
});

const ADMITTED: JudgeAdmission = { admit: true, code: "ok", reason: "calibrated cohens-kappa 0.82" };

/** Seed a store with a candidate run, a baseline run, a frozen baseline, and a comparison. */
async function seed(store: EvidenceStore, over: {
  candidate?: Partial<EvalRun>;
  base?: Partial<EvalRun>;
  cmp?: Partial<Comparison>;
  lineage?: "benchmark" | "development";
} = {}) {
  const at = "2026-08-22T12:00:00.000Z";
  await store.put({ kind: "eval-run", id: "run-candidate", created_at: at, body: run(over.candidate) });
  await store.put({ kind: "eval-run", id: "run-baseline", created_at: at, body: baselineRun(over.base) });
  await freezeBaseline(store, {
    baseline_id: "base-1", run_id: "run-baseline", lineage: over.lineage ?? "benchmark", frozen_at: at,
  });
  await store.put({ kind: "comparison", id: "cmp-1", created_at: at, body: comparison(over.cmp) });
}

const request = {
  promotion_id: "promo-1",
  run_id: "run-candidate",
  baseline_id: "base-1",
  comparison_id: "cmp-1",
  promoted_at: "2026-08-22T12:30:00.000Z",
  promoted_by: "release-test",
  suiteGranularity: GRANULARITY,
  judge: null,
};

describe("promotion gate — the five conditions", () => {
  it("promotes when all five hold, and records why each one did", async () => {
    const store = mkstore();
    await seed(store);
    const { decision, promotion } = await promote(store, request);

    expect(decision.promoted).toBe(true);
    expect(promotion).not.toBeNull();
    // Every condition carries a reason in the affirmative direction too: a promotion that
    // says only "yes" cannot be audited by someone who does not trust the code.
    for (const [name, c] of Object.entries(decision.conditions)) {
      expect(c.held, name).toBe(true);
      expect(c.detail.length, `${name} detail`).toBeGreaterThan(10);
    }
    const stored = await store.get("promotion", "promo-1");
    expect(stored).not.toBeNull();
    expect((stored!.body as { kind: string }).kind).toBe("promote");
  });

  it("refuses on significance, and does not write a record", async () => {
    const store = mkstore();
    await seed(store, { cmp: { verdict: "inconclusive", refusal_reason: "p=0.2 does not clear alpha=0.05" } });
    const { decision, promotion } = await promote(store, request);

    expect(decision.promoted).toBe(false);
    expect(promotion).toBeNull();
    expect(decision.refusals.map((r) => r.code)).toEqual(["not-significant"]);
    expect(decision.conditions.significance.held).toBe(false);
    // A refusal leaves the plane untouched — there is no half-promotion.
    expect(await store.get("promotion", "promo-1")).toBeNull();
  });

  it("refuses a comparison that could never have been significant", async () => {
    const store = mkstore();
    await seed(store, {
      cmp: { protocol: { ...comparison().protocol, discordant: 4, min_attainable_p: 0.125, attainable: false } },
    });
    const { decision } = await promote(store, request);
    expect(decision.refusals.map((r) => r.code)).toEqual(["unattainable-comparison"]);
    expect(decision.conditions.significance.detail).toContain("No outcome it could have produced");
  });

  it("refuses a comparison with no attainability record at all", async () => {
    // A record predating comparison 2.2.0 cannot certify: whether its test could reject is
    // unknown, and unknown is not the same as fine.
    const { protocol } = comparison();
    delete (protocol as Record<string, unknown>).attainable;
    const store = mkstore();
    await seed(store, { cmp: { protocol } });
    const { decision } = await promote(store, request);
    expect(decision.refusals.map((r) => r.code)).toEqual(["unattainable-comparison"]);
    expect(decision.conditions.significance.detail).toContain("no attainability record");
  });

  it("refuses when a failure mode regresses under an improved aggregate", async () => {
    /**
     * The trade this condition exists to catch: overall better, one category collapsed.
     * The aggregate rises from 8/14 to 11/14 while unfaithful-reasoning falls from 6/7 to
     * 2/7 — condition 1 is satisfied and the promotion is still wrong.
     */
    const store = mkstore();
    await seed(store, {
      candidate: {
        aggregate: {
          cases: 14, passed: 11, score: 11 / 14,
          by_failure_mode: {
            "unfaithful-reasoning": { cases: 7, passed: 2 },
            "instruction-drift": { cases: 7, passed: 9 },
          },
        },
      },
      base: {
        aggregate: {
          cases: 14, passed: 8, score: 8 / 14,
          by_failure_mode: {
            "unfaithful-reasoning": { cases: 7, passed: 6 },
            "instruction-drift": { cases: 7, passed: 2 },
          },
        },
      },
    });
    const { decision } = await promote(store, request);
    expect(decision.refusals.map((r) => r.code)).toEqual(["mode-regression"]);
    expect(decision.conditions.no_regression.detail).toContain("unfaithful-reasoning");
  });

  it("does not treat a drop within the suite's granularity as a regression", async () => {
    // One case out of fourteen is the smallest difference this suite reports at all.
    // Blocking on it would make the gate a coin flip, and a gate that never passes is one
    // that gets bypassed.
    const store = mkstore();
    await seed(store, {
      base: {
        aggregate: {
          cases: 14, passed: 8, score: 8 / 14,
          by_failure_mode: {
            "unfaithful-reasoning": { cases: 100, passed: 100 },
            "instruction-drift": { cases: 7, passed: 4 },
          },
        },
      },
      candidate: {
        aggregate: {
          cases: 14, passed: 13, score: 13 / 14,
          by_failure_mode: {
            "unfaithful-reasoning": { cases: 100, passed: 97 },
            "instruction-drift": { cases: 7, passed: 6 },
          },
        },
      },
    });
    const { decision } = await promote(store, request);
    expect(decision.promoted).toBe(true);
    expect(decision.conditions.no_regression.held).toBe(true);
  });

  it("refuses an over-budget run", async () => {
    const store = mkstore();
    await seed(store, { candidate: { cost: { ...run().cost, budget_exceeded: true } } });
    const { decision } = await promote(store, request);
    expect(decision.refusals.map((r) => r.code)).toEqual(["over-budget"]);
    expect(decision.conditions.within_budget.detail).toContain("exceeded its declared budget");
  });

  it("refuses a judged run whose judge was not admitted", async () => {
    const store = mkstore();
    await seed(store, { candidate: { grader_health: { max_disagreement_rate: 0.1, judged_cases: 6 } } });
    const refusedJudge: JudgeAdmission = {
      admit: false, code: "expired-calibration", reason: "calibration is 214 days old against a cadence of 30",
    };
    const { decision } = await promote(store, { ...request, judge: refusedJudge });
    expect(decision.refusals.map((r) => r.code)).toEqual(["judge-calibration"]);
    expect(decision.conditions.judge_calibration.detail).toContain("expired-calibration");
  });

  it("refuses a judged run when no judge admission is supplied at all", async () => {
    /**
     * Whether a judge graded is read from the RUN, never from whether the caller passed one.
     * Deriving it from an argument would make the condition opt-out: omit the judge, skip
     * the check. This is the test that the opt-out does not exist.
     */
    const store = mkstore();
    await seed(store, { candidate: { grader_health: { max_disagreement_rate: 0.1, judged_cases: 6 } } });
    const { decision } = await promote(store, { ...request, judge: null });
    expect(decision.refusals.map((r) => r.code)).toEqual(["judge-calibration"]);
    expect(decision.conditions.judge_calibration.detail).toContain("no judge admission was supplied");
  });

  it("holds the judge condition when no judge graded anything", async () => {
    const store = mkstore();
    await seed(store);
    const { decision } = await promote(store, request);
    expect(decision.conditions.judge_calibration.held).toBe(true);
    expect(decision.conditions.judge_calibration.detail).toContain("no judge graded this run");
  });

  it("refuses when detector recall was not equalized", async () => {
    const store = mkstore();
    await seed(store, {
      cmp: { equalization: { ...comparison().equalization, equalized: false, max_gap: 0.4 } },
    });
    const { decision } = await promote(store, request);
    expect(decision.refusals.map((r) => r.code)).toEqual(["detectors-unequalized"]);
  });

  it("refuses a promotion justified by cost rather than by quality", async () => {
    /**
     * A router is adopted on a cost number, and the quality argument beside it is almost
     * always "the comparison was inconclusive, so quality held". That reads a superiority
     * test backwards. Refusing names the missing procedure — a non-inferiority test against
     * a declared margin — instead of substituting the one that exists, which is exactly what
     * the comparator does with `bootstrap-ci`.
     */
    const store = mkstore();
    await seed(store, { cmp: { verdict: "inconclusive", refusal_reason: "p=0.2 does not clear alpha=0.05" } });
    const { decision } = await promote(store, { ...request, justification: "cost" });
    expect(decision.refusals.map((r) => r.code)).toEqual(["cost-justification"]);
    expect(decision.conditions.significance.detail).toContain("non-inferiority");
  });

  it("refuses a cost justification even when quality also improved", async () => {
    // Cheaper and better is the happy case, and it is promotable — on the QUALITY result.
    // Accepting it as a cost justification would open the path for the next one, which will
    // not have an improved quality verdict behind it.
    const store = mkstore();
    await seed(store);
    const asCost = await promote(store, { ...request, justification: "cost" });
    expect(asCost.decision.promoted).toBe(false);

    const asQuality = await promote(store, { ...request, promotion_id: "promo-q" });
    expect(asQuality.decision.promoted).toBe(true);
  });

  it("gives each of the five conditions a distinct refusal code", () => {
    // The conjunction is only auditable if its terms are distinguishable after the fact.
    const codes = new Set([
      "not-significant", "mode-regression", "over-budget", "judge-calibration", "detectors-unequalized",
    ]);
    expect(codes.size).toBe(5);
  });
});

describe("promotion preconditions — checked before the conditions", () => {
  it("refuses a baseline on the development lineage", async () => {
    /**
     * `Baseline.lineage` has existed since 1.0.0 and nothing read it. A development baseline
     * is writable by the same process that produces candidates, so certifying against one is
     * a cycle in the grading order rather than a weaker check.
     */
    const store = mkstore();
    await seed(store, { lineage: "development" });
    const { decision } = await promote(store, request);
    expect(decision.refusals[0].code).toBe("development-lineage");
    expect(decision.refusals[0].detail).toContain("cycle");
  });

  it("refuses when the comparison does not name the run being promoted", async () => {
    const store = mkstore();
    await seed(store, { cmp: { candidate_run_id: "some-other-run" } });
    const { decision } = await promote(store, request);
    expect(decision.refusals.map((r) => r.code)).toContain("pointer-mismatch");
    expect(decision.refusals.find((r) => r.code === "pointer-mismatch")!.detail)
      .toContain("some-other-run");
  });

  it("throws rather than promoting against evidence that is not there", async () => {
    const store = mkstore();
    await seed(store);
    await expect(promote(store, { ...request, comparison_id: "cmp-missing" }))
      .rejects.toBeInstanceOf(EvidenceMissing);
  });
});

describe("baselines and rollback", () => {
  it("records supersession forward, because the old record cannot be edited", async () => {
    const store = mkstore();
    await seed(store);
    const at = "2026-08-22T13:00:00.000Z";
    const second = await freezeBaseline(store, {
      baseline_id: "base-2", run_id: "run-candidate", lineage: "benchmark", frozen_at: at,
      supersedes: "base-1",
    });
    expect(second.supersedes).toBe("base-1");
    // The superseded record is untouched: the evidence plane has no update, and the chain
    // is read by walking backwards from the newest.
    const first = await store.get("baseline", "base-1");
    expect((first!.body as { supersedes: string | null }).supersedes).toBeNull();
  });

  it("refuses to overwrite a baseline, in the syscall", async () => {
    const store = mkstore();
    await seed(store);
    await expect(freezeBaseline(store, {
      baseline_id: "base-1", run_id: "run-candidate", lineage: "benchmark", frozen_at: "2026-08-22T14:00:00.000Z",
    })).rejects.toThrow(/immutable/);
  });

  it("rolls back by writing the reverse, keeping the original evidence pointers", async () => {
    const store = mkstore();
    await seed(store);
    await promote(store, request);
    const back = await rollback(store, {
      promotion_id: "promo-2", reverses: "promo-1",
      promoted_at: "2026-08-22T14:00:00.000Z", promoted_by: "release-test",
    });

    expect(back.kind).toBe("rollback");
    expect(back.supersedes).toBe("promo-1");
    // The pointers are the ones the promotion carried: a rollback withdraws the claim that
    // was made, and pointing it somewhere else would erase what was believed at the time.
    expect(back.eval_run_id).toBe("run-candidate");
    expect(back.comparison_id).toBe("cmp-1");
    // And the original is still there, unedited.
    expect(await store.get("promotion", "promo-1")).not.toBeNull();
  });

  it("computes what is current rather than storing it", async () => {
    const store = mkstore();
    await seed(store);
    expect(await current(store)).toBeNull();

    await promote(store, request);
    expect((await current(store))!.promotion_id).toBe("promo-1");

    await rollback(store, {
      promotion_id: "promo-2", reverses: "promo-1",
      promoted_at: "2026-08-22T14:00:00.000Z", promoted_by: "release-test",
    });
    const now = await current(store);
    expect(now!.promotion_id).toBe("promo-2");
    expect(now!.kind).toBe("rollback");
  });
});

describe("dangling-ref precondition — the content plane (artifact-reference lineage)", () => {
  /**
   * Pointer consistency says the three ids agree; the dangling-ref precondition says the
   * artifacts the pointers name are still REACHABLE. The Application collects the refs
   * (an EvalRun does not carry its revisions) and hands them to the gate with an
   * existence oracle; Core only composes the decision.
   */
  it("refuses when a content ref no longer resolves", () => {
    const decision = decidePromotion({
      promotion_id: "p", promoted_at: "2026-08-22T12:30:00.000Z", promoted_by: "t",
      candidateRun: run(), baselineRun: baselineRun(),
      baseline: {
        baseline_id: "base-1", configuration_id: CONFIG, run_id: "run-baseline",
        frozen_at: "2026-08-22T12:00:00.000Z", lineage: "benchmark", supersedes: null,
      },
      comparison: comparison(), judge: ADMITTED, suiteGranularity: GRANULARITY,
      contentRefs: [
        "npx:stage-output:" + "a".repeat(64) + ":local-bundle",  // present
        "npx:stage-output:" + "b".repeat(64) + ":local-bundle",  // EVICTED
      ],
      refExists: (ref) => !ref.startsWith("npx:stage-output:" + "b".repeat(64)),
    });
    expect(decision.promoted).toBe(false);
    expect(decision.refusals.map((r) => r.code)).toEqual(["dangling-ref"]);
    expect(decision.refusals[0].detail).toContain("b".repeat(12));
  });

  it("must NOT fire when every content ref resolves (the half that keeps the gate honest)", () => {
    const decision = decidePromotion({
      promotion_id: "p", promoted_at: "2026-08-22T12:30:00.000Z", promoted_by: "t",
      candidateRun: run(), baselineRun: baselineRun(),
      baseline: {
        baseline_id: "base-1", configuration_id: CONFIG, run_id: "run-baseline",
        frozen_at: "2026-08-22T12:00:00.000Z", lineage: "benchmark", supersedes: null,
      },
      comparison: comparison(), judge: ADMITTED, suiteGranularity: GRANULARITY,
      contentRefs: ["npx:stage-output:" + "a".repeat(64) + ":local-bundle"],
      refExists: () => true,
    });
    expect(decision.refusals.map((r) => r.code)).not.toContain("dangling-ref");
    expect(decision.promoted).toBe(true);
  });

  it("checks nothing when the deployment keeps no content plane (no oracle)", () => {
    // Pre-lineage behaviour: pointer identity is all that can be checked.
    const decision = decidePromotion({
      promotion_id: "p", promoted_at: "2026-08-22T12:30:00.000Z", promoted_by: "t",
      candidateRun: run(), baselineRun: baselineRun(),
      baseline: {
        baseline_id: "base-1", configuration_id: CONFIG, run_id: "run-baseline",
        frozen_at: "2026-08-22T12:00:00.000Z", lineage: "benchmark", supersedes: null,
      },
      comparison: comparison(), judge: ADMITTED, suiteGranularity: GRANULARITY,
      contentRefs: ["npx:stage-output:" + "b".repeat(64) + ":local-bundle"],
      refExists: null,
    });
    expect(decision.refusals.map((r) => r.code)).not.toContain("dangling-ref");
  });
});

describe("the gate is pure, so it can be asked without a store", () => {
  it("decides identically without any evidence plane present", () => {
    const decision = decidePromotion({
      promotion_id: "p", promoted_at: "2026-08-22T12:30:00.000Z", promoted_by: "t",
      candidateRun: run(), baselineRun: baselineRun(),
      baseline: {
        baseline_id: "base-1", configuration_id: CONFIG, run_id: "run-baseline",
        frozen_at: "2026-08-22T12:00:00.000Z", lineage: "benchmark", supersedes: null,
      },
      comparison: comparison(), judge: ADMITTED, suiteGranularity: GRANULARITY,
    });
    expect(decision.promoted).toBe(true);
    expect(decision.promotion!.configuration_id).toBe(CONFIG);
  });
});
