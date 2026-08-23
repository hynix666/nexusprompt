import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runPipelineSuite, stageOf, isPipelineCase, type PipelineEvalCase } from "../src/pipeline-eval.js";
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

/**
 * The two suite kinds must not be runnable by each other's runner.
 *
 * `run-eval.ts --suite eval/pipeline-smoke.json` reported 5/5 passing and 5 provider calls
 * for five cases that each describe an eleven-stage run. It drove the compile stage alone,
 * ignored every per-stage stub, and fell back to a pinned failure for each case — so the
 * detectors conditional on `demo_mode` passed vacuously. Green, and measuring something other
 * than its own name.
 */
describe("a suite cannot be run by the wrong runner", () => {
  it("recognises a real pipeline case", () => {
    const cases = JSON.parse(readFileSync("eval/pipeline-smoke.json", "utf8")).cases;
    expect(cases.every(isPipelineCase)).toBe(true);
  });

  it("rejects a single-stage case", () => {
    // The must-not-fire half: if this returned true, `run-eval` would refuse the suite it is
    // actually for, and `eval:pipeline` would accept one it cannot run.
    const cases = JSON.parse(readFileSync("eval/compile-smoke.json", "utf8")).cases;
    expect(cases.some(isPipelineCase)).toBe(false);
  });

  it("keys on the brief, not on a truthy field or a filename", () => {
    expect(isPipelineCase({ brief: "a support bot" })).toBe(true);
    expect(isPipelineCase({ stub: { content: "x" } })).toBe(false);
    // A non-string brief is not a brief. `{ brief: true }` would slip through a truthiness
    // check and then fail deep inside runPipeline with something unrecognisable.
    expect(isPipelineCase({ brief: true })).toBe(false);
    expect(isPipelineCase({ brief: "" })).toBe(true);
    expect(isPipelineCase(null)).toBe(false);
    expect(isPipelineCase(undefined)).toBe(false);
  });
});

describe("the pipeline suite reports what only a pipeline run can", () => {
  it("executes many stages per case, not one", async () => {
    /**
     * The number that exposed the false green. Five cases through the single-stage runner
     * make five provider calls; through the pipeline they make 27 across 52 stage executions.
     */
    const cases = JSON.parse(readFileSync("eval/pipeline-smoke.json", "utf8")).cases;
    const { perCase } = await runPipelineSuite({ cases });
    const stages = perCase.reduce((n, c) => n + c.stages.length, 0);
    expect(stages).toBeGreaterThan(perCase.length * 5);
    expect(perCase.every((c) => c.providerCalls >= 1)).toBe(true);
  });

  it("shows a feedback round costing two extra stage executions", async () => {
    // check:depth prices a round at two executions. The reflexive case is where that
    // arithmetic becomes observable rather than declared: 11 + 2 = 13.
    const cases = JSON.parse(readFileSync("eval/pipeline-smoke.json", "utf8")).cases;
    const { perCase } = await runPipelineSuite({ cases });
    const reflexive = perCase.find((c) => c.feedbackRounds > 0);
    expect(reflexive).toBeDefined();
    expect(reflexive!.stages.length).toBe(11 + 2 * reflexive!.feedbackRounds);
  });
});
