import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PIPELINE, DEPTH_PLAN, DEPTH_OF, planFor, planForContext, resolveDepth, planDepth,
  decideGateFeedback, MAX_FEEDBACK_ROUNDS, type PipelineContext,
} from "../src/stages/pipeline.js";
import { DEMO_MARKER } from "../src/stages/stage-kit.js";
import { isClean } from "../src/stages/critique.js";
import type { GateResult } from "../../contracts/index.js";
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

  it("no stage's skip rule disagrees with the depth the plan was built from", () => {
    /**
     * The general form of a specific defect: `tone_check` read `ctx.depth` while the plan
     * was built from the depth RESOLVED from stakes, so `{ stakes: "SAFETY-CRITICAL" }`
     * planned eleven stages and skipped the eleventh on every run — recording "[SKIPPED]
     * Tone Check runs at STANDARD depth and above" about a COMPREHENSIVE run.
     *
     * Asserted over every stakes level rather than the one that broke, because the next
     * depth-sensitive stage would reintroduce it silently.
     */
    const REAL_PROMPT = "# SYSTEM PROMPT\n\n## 1. IDENTITY\n- Core Identity: a compiled prompt.";
    for (const stakes of Object.keys(DEPTH_OF)) {
      const ctx = { brief: "b", prompt: REAL_PROMPT, stakes } as PipelineContext;
      for (const stage of planForContext(ctx)) {
        expect(
          stage.shouldSkip?.(ctx) ?? false,
          `${stage.id} is in the plan at stakes ${stakes} (depth ${planDepth(ctx)}) but skips itself`,
        ).toBe(false);
      }
    }
  });

  it("planDepth reports the depth the plan is actually built from", () => {
    expect(planDepth({ stakes: "SAFETY-CRITICAL" })).toBe("COMPREHENSIVE");
    expect(planDepth({ depth: "TINY", stakes: "HIGH" })).toBe("TINY");
    // A typo resolves to the same STANDARD `planFor` falls back to, so the two agree.
    expect(planDepth({ depth: "NONSENSE" })).toBe("STANDARD");
    expect(planDepth({})).toBe("STANDARD");
    // Reached from an operator flag, so a Record's inherited keys must not index it.
    expect(planDepth({ depth: "constructor" })).toBe("STANDARD");
    expect(planFor(planDepth({ depth: "constructor" })).map((s) => s.id)).toEqual([...STAGE_IDS]);
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

/* ── gate feedback: the decision, not the loop ─────────────────────────────── */

/**
 * `decideGateFeedback` is where ADR-0008's action item 4 actually lives. The loop in the
 * Application only follows it, so every reason NOT to retry is tested here, under the
 * purity harness — a decision that reached a clock or a random number would fail rather
 * than pass unnoticed.
 */

const gate = (gate_id: string, verdict: "PASS" | "WARN" | "FAIL"): GateResult => ({
  gate_id, verdict, message: `${gate_id} said something`, gate_version: "1.0.0",
  message_code: `${gate_id}.test`, input_hash: "0".repeat(64), location: null,
});

const failing = (over: Partial<PipelineContext> = {}): PipelineContext => ({
  brief: "b",
  prompt: "# SYSTEM PROMPT\n\nreal compiled output",
  lintStatus: "GATE_FAIL",
  // TOKEN_SPAM is a WARN, not a PASS, deliberately. With a PASS here the "only FAILs are
  // fed back" test could not fail: a mutation widening the filter to `!== "PASS"` would
  // still have excluded it, and the probe caught exactly that — the fixture was unable to
  // detect what the assertion claimed to check.
  gate_results: [gate("GUARDRAIL_GAP", "FAIL"), gate("TOKEN_SPAM", "WARN")],
  topology: { kind: "reflexive", max_iterations: 2 },
  ...over,
});

const FULL = planFor("COMPREHENSIVE");

describe("decideGateFeedback", () => {
  it("routes a gate FAIL back to refine, carrying the failures as a critique", () => {
    const d = decideGateFeedback(failing(), FULL);
    expect(d.retry).toBe(true);
    expect(d.resumeAt).toBe("refine");
    expect(d.patch?.feedbackRounds).toBe(1);
    expect(d.patch?.critique).toContain("GUARDRAIL_GAP");
  });

  it("feeds back only FAILs, never WARNs", () => {
    // A WARN is a finding, not a defect worth a provider call. `statusOf` draws the same
    // line one layer down: GATE_FAIL is a FAIL, DEGRADED is anything else.
    const d = decideGateFeedback(failing(), FULL);
    expect(d.patch?.critique).not.toContain("TOKEN_SPAM");
  });

  it("produces a critique refine will not mistake for a pass", () => {
    // If the formatted feedback ever equalled the pass sentinel, refine would skip it and
    // the loop would spin at full cost producing nothing. This is the load-bearing
    // interaction between two stages that were written years apart in source terms.
    const d = decideGateFeedback(failing(), FULL);
    expect(isClean(d.patch!.critique!)).toBe(false);
  });

  it.each([
    ["the topology is not reflexive", { topology: undefined }, "not reflexive"],
    ["reflexive with no cap declared", { topology: { kind: "reflexive" as const } }, "no max_iterations"],
    ["the cap is already spent", { feedbackRounds: 2 }, "cap reached"],
    ["the gates did not FAIL", { lintStatus: "DEGRADED" as const }, "not GATE_FAIL"],
    ["lint has not run", { lintStatus: null }, "not GATE_FAIL"],
    ["the prompt is a demo placeholder", { prompt: `${DEMO_MARKER}\nplaceholder` }, "demo placeholder"],
    ["GATE_FAIL with no FAIL verdicts", { gate_results: [gate("X", "WARN")] }, "no FAIL verdicts"],
  ])("declines when %s, and says why", (_name, over, reason) => {
    const d = decideGateFeedback(failing(over), FULL);
    expect(d.retry).toBe(false);
    expect(d.reason).toContain(reason);
  });

  it("declines when the depth plan omits refine or lint", () => {
    // TINY runs six of eleven. A loop that jumped to a stage the plan excluded would
    // silently deepen a run the caller asked to keep shallow.
    const tiny = planFor("TINY");
    expect(tiny.some((s) => s.id === "refine")).toBe(false);
    const d = decideGateFeedback(failing(), tiny);
    expect(d.retry).toBe(false);
    expect(d.reason).toContain("omits refine or lint");
  });

  it("counts rounds up to the cap and then stops", () => {
    const rounds: number[] = [];
    let ctx = failing();
    for (let i = 0; i < 5; i++) {
      const d = decideGateFeedback(ctx, FULL);
      if (!d.retry) break;
      rounds.push(d.patch!.feedbackRounds!);
      ctx = { ...ctx, ...d.patch };
    }
    expect(rounds).toEqual([1, 2]);
  });
});

/**
 * Sweep twelve — the declared feedback cap is enforced at RUN time, not only at build time.
 *
 * `contracts/reliability-budget.json` caps rounds at 3 and says so in its own words:
 * "check:depth enforces the worst case, so raising this cap fails the build unless the floor
 * or the target moves." That was true of the FILE and false of the RUNTIME. `decideGateFeedback`
 * took `ctx.topology.max_iterations` as the cap and nothing consulted the budget, so
 * `--reflexive 10` was simply granted.
 *
 * Measured against the real runner before the clamp: **10 rounds and 31 stage executions**,
 * where the declared 99.5% per-stage floor yields 0.995^31 = 85.6% against a 90% end-to-end
 * target — and four stages past the headroom `check:depth` itself prints.
 */
describe("gate feedback is bounded by the declared reliability budget", () => {
  it("the cap comes from the contract, not from a copy of it", () => {
    const budget = JSON.parse(
      readFileSync(join(process.cwd(), "contracts/reliability-budget.json"), "utf8"),
    );
    expect(MAX_FEEDBACK_ROUNDS).toBe(budget.max_feedback_rounds);
    expect(MAX_FEEDBACK_ROUNDS).toBeGreaterThan(0);
  });

  it("refuses a round past the declared cap however many were requested", () => {
    // Spent exactly the cap: the next round must be refused even though the caller asked for
    // far more. This is the assertion that was false before the clamp.
    const d = decideGateFeedback(
      failing({ topology: { kind: "reflexive", max_iterations: 10 }, feedbackRounds: MAX_FEEDBACK_ROUNDS }),
      FULL,
    );
    expect(d.retry).toBe(false);
    expect(d.reason).toContain("clamped");
    expect(d.reason).toContain(String(MAX_FEEDBACK_ROUNDS));
  });

  it("still grants rounds below the cap — the must-not-refuse half", () => {
    // Without this, a clamp that refused everything would satisfy the case above while making
    // the reflexive topology useless.
    const d = decideGateFeedback(
      failing({ topology: { kind: "reflexive", max_iterations: 10 }, feedbackRounds: 0 }),
      FULL,
    );
    expect(d.retry).toBe(true);
    expect(d.resumeAt).toBe("refine");
  });

  it("a request BELOW the cap is honoured as asked, not raised to it", () => {
    // The clamp is a ceiling, never a floor. Asking for 1 must still stop at 1.
    const d = decideGateFeedback(
      failing({ topology: { kind: "reflexive", max_iterations: 1 }, feedbackRounds: 1 }),
      FULL,
    );
    expect(d.retry).toBe(false);
    expect(d.reason).toContain("feedback cap reached (1 of 1)");
    expect(d.reason).not.toContain("clamped");
  });
});
