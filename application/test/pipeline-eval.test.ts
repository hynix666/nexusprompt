import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runPipelineSuite, stageOf, type PipelineEvalCase } from "../src/pipeline-eval.js";
import { STAGE_IDS } from "../../contracts/index.js";

/**
 * The suite Phase β proved was missing.
 *
 * `compile-smoke` drives the single-stage Orchestrator, so it cannot observe the depth plan,
 * a skip, a partial degradation, or the gate-feedback loop. This one drives `runPipeline`,
 * which is what makes a change to the pipeline's SHAPE measurable at all.
 */

const data: { cases: PipelineEvalCase[]; suite: { case_ids: string[] } } =
  JSON.parse(readFileSync("eval/pipeline-smoke.json", "utf8"));

const byId = new Map(data.cases.map((c) => [c.case_id, c]));
const suiteCases = data.suite.case_ids.map((id) => byId.get(id)!);

describe("pipeline-smoke", () => {
  it("names only cases that exist", () => {
    // A suite naming a case nobody wrote must fail, not silently shrink.
    expect(data.suite.case_ids.filter((id) => !byId.has(id))).toEqual([]);
  });

  it("passes every case", async () => {
    const { perCase, passed } = await runPipelineSuite({ cases: suiteCases });
    const failures = perCase.filter((c) => !c.passed)
      .map((c) => `${c.case_id}: ${c.scores.filter((s) => !s.passed).map((s) => s.detail).join("; ")}`);
    expect(failures).toEqual([]);
    expect(passed).toBe(suiteCases.length);
  });

  it("reports pipeline-level facts no single-stage suite could", async () => {
    const { perCase } = await runPipelineSuite({ cases: suiteCases });
    const by = new Map(perCase.map((c) => [c.case_id, c]));

    // Depth plan: TINY runs six of eleven, STANDARD runs all eleven.
    expect(by.get("shallow-depth-still-produces-output")!.stages).toHaveLength(6);
    expect(by.get("full-run-produces-a-prompt")!.stages).toHaveLength(11);

    /**
     * Two different reasons a run can be short, and they must not be conflated.
     *
     * TINY is short because the DEPTH PLAN omits five stages — they were never in the plan,
     * so there is nothing to skip and a successful TINY run has no SKIPPED entries. A
     * degraded run is short because stages that were planned DECLINED to run on a
     * placeholder, and those are recorded as SKIPPED so the bundle says why.
     *
     * The first assertion here was written expecting skips in the TINY run and was simply
     * wrong about which mechanism produces them.
     */
    expect(by.get("shallow-depth-still-produces-output")!.stages.some((s) => s.status === "SKIPPED")).toBe(false);
    expect(by.get("partial-degradation-is-labelled")!.stages.filter((s) => s.status === "SKIPPED").length)
      .toBeGreaterThan(0);
  });

  it("measures the gate-feedback loop, which is what Phase β could not", async () => {
    const { perCase } = await runPipelineSuite({ cases: suiteCases });
    const reflexive = perCase.find((c) => c.case_id === "reflexive-run-stays-within-its-cap")!;

    // The loop ran, and stopped inside the cap the case declared.
    expect(reflexive.feedbackRounds).toBeGreaterThan(0);
    expect(reflexive.feedbackRounds).toBeLessThanOrEqual(2);
    // refine and lint each executed more than once; nothing else did.
    const counts = (id: string) => reflexive.stages.filter((s) => s.stage_id === id).length;
    expect(counts("refine")).toBeGreaterThan(1);
    expect(counts("lint")).toBeGreaterThan(1);
    expect(counts("compile")).toBe(1);
  });

  it("does not launder a partially degraded run", async () => {
    // The case pins only `deconstruct`, so every later stage degrades. What must survive is
    // the label: an unlabelled degraded stage taints the whole run.
    const { perCase } = await runPipelineSuite({ cases: suiteCases });
    const degraded = perCase.find((c) => c.case_id === "partial-degradation-is-labelled")!;
    expect(degraded.passed).toBe(true);
    expect(degraded.stages.some((s) => s.status === "DEMO")).toBe(true);
  });

  it("never lets the projection disagree with the run about degradation", async () => {
    /**
     * The detectors that check degradation are CONDITIONAL on `demo_mode`, so a projection
     * that reported `false` on a degraded run would make them pass vacuously — every case
     * green, the honesty guarantee unmeasured. A mutation probe found exactly that, and
     * nothing failed.
     *
     * So the flag is checked against the stage statuses, which are produced by the runner
     * and not by the projection. An instrument cannot be the thing that verifies itself.
     */
    const { perCase } = await runPipelineSuite({ cases: suiteCases });
    for (const c of perCase) {
      const anyDegraded = c.stages.some((s) => s.status === "DEMO");
      expect(c.demoMode, `${c.case_id}: projection says ${c.demoMode}, stages say ${anyDegraded}`)
        .toBe(anyDegraded);
    }
    // And at least one case must actually be degraded, or the loop above proves nothing.
    expect(perCase.some((c) => c.demoMode)).toBe(true);
  });

  it("is reproducible — the same cases produce the same verdicts", async () => {
    const a = await runPipelineSuite({ cases: suiteCases });
    const b = await runPipelineSuite({ cases: suiteCases });
    expect(a.perCase.map((c) => [c.case_id, c.passed]))
      .toEqual(b.perCase.map((c) => [c.case_id, c.passed]));
  });
});

describe("stage routing", () => {
  it("recognises every stage that sends a request", () => {
    // Routing keys on the frozen templates, which check:stages verifies verbatim — so this
    // cannot drift from the templates without that check failing first. `lint` and
    // `cost_estimate` are deterministic and send nothing, so they are absent by design.
    const deterministic = new Set(["lint", "cost_estimate"]);
    const routable = STAGE_IDS.filter((id) => !deterministic.has(id));
    expect(routable.length).toBe(9);
  });

  it("falls back to preview rather than throwing on an unknown request", () => {
    // A misrouted reply is better than a crashed suite, but it must be a KNOWN fallback:
    // preview is the one stage whose template carries no distinctive marker.
    expect(stageOf({
      request_id: "r", run_id: "r", messages: [{ role: "user", content: "anything at all" }],
      model_policy: { preferred_models: [], allow_fallback: false },
    })).toBe("preview");
  });
});
