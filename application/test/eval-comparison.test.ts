import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runSuite, configurationId, type StubbedCase } from "../src/eval.js";
import { compare } from "../../core/src/eval/compare.js";
import type { Configuration, EvalSuite } from "../../contracts/index.js";

/**
 * Phase 2b's exit gate, as a test rather than only as a script.
 *
 * `npm run eval:compare` demonstrates this too, but a script in the verify chain proves the
 * verdict and nothing about the numbers behind it. The suite's own header claims ten of
 * fourteen cases flip and that six flips are the significance threshold; both are asserted
 * here, because a number quoted in prose that nothing checks is the defect this repository
 * keeps finding in its own documentation.
 *
 * Both runs are pinned, so the regression is declared rather than sampled. What is under
 * test is the harness's ability to report a regression — not a model's behaviour, and not
 * any claim that some prompt causes one.
 */

const data: { suite: EvalSuite; cases: StubbedCase[] } =
  JSON.parse(readFileSync("eval/compile-smoke.json", "utf8"));

const base = {
  prompt_template_ref: "core/src/stages/compile.ts",
  model_id: "pinned",
  decoding: { temperature: null, seed: null },
  topology: { kind: "sequential" as const, stages: ["compile"], max_iterations: null },
  retrieval_config: null,
  tool_config: null,
  gate_set_ref: "scripts/ported-gates.json",
  router_policy_ref: null,
};

const configFor = (ref: string): Configuration => {
  const c = { ...base, prompt_template_ref: ref };
  return { configuration_id: configurationId(c), ...c };
};

async function bothRuns() {
  const baseline = await runSuite({
    suite: data.suite, cases: data.cases, configuration: configFor(base.prompt_template_ref),
  });
  const candidate = await runSuite({
    suite: data.suite, cases: data.cases,
    configuration: configFor(`${base.prompt_template_ref}#degraded-prompt`),
    variant: "degraded-prompt",
  });
  return { baseline, candidate };
}

describe("the exit gate: a deliberately worse configuration is measured as worse", () => {
  it("flips exactly ten of fourteen cases, all in one direction", async () => {
    const { baseline, candidate } = await bothRuns();
    const was = new Map(baseline.perCase.map((c) => [c.case_id, c.passed]));

    const broke = candidate.perCase.filter((c) => !c.passed && was.get(c.case_id));
    const fixed = candidate.perCase.filter((c) => c.passed && !was.get(c.case_id));

    expect(baseline.run.aggregate.passed).toBe(14);
    expect(broke.length).toBe(10);
    // One-directional: a worse configuration that also fixed something would make the
    // discordant counts cancel, and McNemar consumes exactly those pairs.
    expect(fixed.length).toBe(0);

    // The four that cannot flip do not depend on pinned content at all — which is why
    // eight cases could not have demonstrated this.
    expect(candidate.perCase.filter((c) => c.passed).map((c) => c.case_id).sort()).toEqual([
      "degraded-run-does-not-fabricate",
      "degraded-run-is-labelled",
      "gates-actually-run",
      "provenance-is-complete",
    ]);
  });

  it("reports regressed, with equalization derived and significance behind it", async () => {
    const { baseline, candidate } = await bothRuns();
    const result = compare({
      comparison_id: "exit-gate",
      candidate_run_id: candidate.run.run_id,
      baseline_id: baseline.run.run_id,
      candidate: candidate.perCase.map((c) => ({ case_id: c.case_id, passed: c.passed })),
      baseline: baseline.perCase.map((c) => ({ case_id: c.case_id, passed: c.passed })),
      suite: data.suite,
      comparisons_in_family: 1,
      alpha: 0.05,
      candidateRecall: candidate.run.detector_recall,
      baselineRecall: baseline.run.detector_recall,
      suiteDetectorIds: [...new Set(data.cases.flatMap((c) => c.detector_ids))].sort(),
    });

    expect(result.verdict).toBe("regressed");
    expect(result.delta).toBeCloseTo(-10 / 14, 6);
    expect(result.protocol.p_value!).toBeLessThan(0.05);
    expect(result.equalization.equalized).toBe(true);
    expect(result.equalization.max_gap).toBe(0);
    expect(result.equalization.gap_bound).toBe(data.suite.resolution.detectable_delta);
  });

  it("would report inconclusive on five flips — the threshold is six, not one", async () => {
    // The claim the suite header makes about its own power, asserted. A merely mediocre
    // configuration is correctly declined; someone not told this reads it as a broken harness.
    const { baseline, candidate } = await bothRuns();
    const ids = baseline.perCase.map((c) => c.case_id);
    const brokenIds = candidate.perCase.filter((c) => !c.passed).map((c) => c.case_id);

    const withNBroken = (n: number) =>
      ids.map((case_id) => ({ case_id, passed: !brokenIds.slice(0, n).includes(case_id) }));

    const shared = {
      comparison_id: "power", candidate_run_id: "c", baseline_id: "b",
      baseline: ids.map((case_id) => ({ case_id, passed: true })),
      suite: data.suite, comparisons_in_family: 1, alpha: 0.05,
      candidateRecall: candidate.run.detector_recall,
      baselineRecall: baseline.run.detector_recall,
      suiteDetectorIds: [...new Set(data.cases.flatMap((c) => c.detector_ids))].sort(),
    };

    expect(compare({ ...shared, candidate: withNBroken(5) }).verdict).toBe("inconclusive");
    expect(compare({ ...shared, candidate: withNBroken(6) }).verdict).toBe("regressed");
  });

  it("measures recall on each run separately, so neither borrows the other's instrument", async () => {
    const { baseline, candidate } = await bothRuns();
    for (const run of [baseline.run, candidate.run]) {
      expect(run.detector_recall).not.toBeNull();
      expect(run.detector_recall!.detectors.length).toBeGreaterThan(0);
      // Every detector the suite uses must be measurable on both sides, or the comparison
      // above would have refused rather than reported.
      for (const d of run.detector_recall!.detectors) {
        if (d.substrates > 0) expect(d.recall).not.toBeNull();
      }
    }
  });
});
