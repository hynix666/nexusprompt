import { describe, it, expect } from "vitest";
import {
  PIPELINE, DEPTH_PLAN, DEPTH_OF, planFor, planForContext, resolveDepth,
} from "../src/stages/pipeline.js";
import { STAGE_IDS } from "../../contracts/index.js";

/**
 * The pipeline PLAN, exercised inside the `core` project so the purity harness sees it.
 *
 * Every other test of this module lives in the `application` project, which has no purity
 * setup — so `core/src/stages/pipeline.ts` was covered by `check-boundaries.mjs` statically
 * (it reads every file under `core/src`) but never by the runtime traps on `Date.now`,
 * `Math.random` and `fetch`. The exit gate says "the purity harness stays green", and that
 * was true partly by not looking.
 *
 * These run under `core/test/purity.setup.ts`: any clock or randomness reached from a
 * `decide` or `reduce` here fails the test rather than passing unnoticed.
 */

describe("the plan is pure", () => {
  it("decide and reduce touch no clock and no randomness", () => {
    // The purity harness traps Date.now/new Date/Math.random/fetch for the duration of each
    // test. A stage reaching for any of them fails here.
    for (const stage of PIPELINE) {
      if (stage.kind !== "generating") continue;
      const req = stage.decide(
        { brief: "A support bot.", prompt: "# SYSTEM PROMPT\n\nScope: billing.", critique: "1. G1", testMessage: "hi" },
        "run-1",
      );
      expect(req.request_id).toMatch(/^[0-9a-f]{32}$/);
      const patch = stage.reduce(
        { brief: "A support bot.", prompt: "p", critique: "c" },
        { request_id: "r", content: "out", provider_id: "p", model_id: "m", finish_reason: "end_turn" },
      );
      expect(typeof patch).toBe("object");
    }
  });

  it("deterministic stages are pure functions of the context", () => {
    for (const stage of PIPELINE) {
      if (stage.kind !== "deterministic") continue;
      const ctx = { brief: "b", prompt: "# SYSTEM PROMPT\n\nScope: billing." };
      expect(stage.run(ctx)).toEqual(stage.run(ctx)); // same in, same out
    }
  });

  it("the same request is produced twice from the same input", () => {
    // Determinism is what lets a run be replayed and compared rather than merely re-executed.
    const ctx = { brief: "A support bot.", prompt: "p", critique: "c", testMessage: "hi" };
    const first = PIPELINE.filter((s) => s.kind === "generating").map((s) => s.decide(ctx, "r").request_id);
    const second = PIPELINE.filter((s) => s.kind === "generating").map((s) => s.decide(ctx, "r").request_id);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length); // and no two stages collide
  });
});

describe("depth resolution", () => {
  it("derives depth from stakes when depth is unset", () => {
    // DEPTH_OF was ported and never called, so stakes: LOW ran all eleven stages instead of
    // TINY's six. A dead constant is worse than an absent one — it looks like a binding.
    expect(resolveDepth({ stakes: "LOW" })).toBe("TINY");
    expect(resolveDepth({ stakes: "SAFETY-CRITICAL" })).toBe("COMPREHENSIVE");
    expect(planForContext({ stakes: "LOW" })).toHaveLength(6);
    expect(planForContext({ stakes: "HIGH" })).toHaveLength(11);
  });

  it("an explicit depth wins over the stakes mapping", () => {
    expect(resolveDepth({ depth: "STANDARD", stakes: "LOW" })).toBe("STANDARD");
    expect(planForContext({ depth: "STANDARD", stakes: "LOW" })).toHaveLength(11);
  });

  it("falls back to the full plan rather than an empty one", () => {
    // Returning nothing would make a typo look like a completed run.
    expect(planFor("NONSENSE").map((s) => s.id)).toEqual([...STAGE_IDS]);
    expect(planForContext({}).map((s) => s.id)).toEqual([...STAGE_IDS]);
  });

  it("every depth plan names only stages the registry defines", () => {
    const known = new Set(PIPELINE.map((s) => s.id));
    for (const [depth, ids] of Object.entries(DEPTH_PLAN)) {
      for (const id of ids) expect(known.has(id), `${depth} names ${id}`).toBe(true);
    }
    for (const [stakes, depth] of Object.entries(DEPTH_OF)) {
      expect(DEPTH_PLAN[depth], `${stakes} maps to ${depth}`).toBeDefined();
    }
  });

  it("the registry matches STAGE_IDS in order", () => {
    expect(PIPELINE.map((s) => s.id)).toEqual([...STAGE_IDS]);
  });
});
