import { describe, it, expect } from "vitest";
import { decide, reduce, DEMO_MARKER, STAGE_ID } from "../src/stages/compile.js";
import { listGates } from "../src/gates/registry.js";
import type { GenerationResult, ProviderFailure } from "../../contracts/index.js";

/**
 * This file exists as much for its *coverage* as its assertions.
 *
 * The purity harness only guards Core code that a Core test actually runs.
 * `compile.ts` was exercised solely by the application-layer acceptance tests,
 * which have no harness by design — so an injected `Math.random()` in this
 * module produced zero violations and a green build. A guard is only as wide as
 * what it runs.
 */

const failure: ProviderFailure = {
  request_id: "req-1",
  category: "UNAVAILABLE",
  retriable: true,
  reason_code: "connection_failed",
  safe_message: "Could not reach the provider.",
  retry_after_ms: 0,
  attempt: 3,
  provider_id: "local-proxy",
};

const success: GenerationResult = {
  request_id: "req-1",
  content: "# SYSTEM PROMPT\n\nAnswer billing questions only.",
  provider_id: "local-proxy",
  model_id: "claude-opus-5",
  finish_reason: "end_turn",
};

describe("decide — pure, deterministic", () => {
  it("returns a request; it does not perform one", () => {
    const req = decide({ brief: "a support bot" }, "run-1");
    expect(req.run_id).toBe("run-1");
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].content).toContain("STEP 3 — COMPILATION");
  });

  it("derives request_id from the input, not from randomness", () => {
    const a = decide({ brief: "same" }, "run-1");
    const b = decide({ brief: "same" }, "run-1");
    expect(a.request_id).toBe(b.request_id);
  });

  it("different input yields a different request_id", () => {
    const a = decide({ brief: "one" }, "run-1");
    const b = decide({ brief: "two" }, "run-1");
    expect(a.request_id).not.toBe(b.request_id);
  });

  it("prefers `previous` over `brief` when a prior stage produced output", () => {
    const req = decide({ brief: "original", previous: "upstream output" }, "run-1");
    expect(req.messages[0].content).toContain("upstream output");
    expect(req.messages[0].content).not.toContain("original");
  });
});

describe("reduce — classified outcome in, next state out", () => {
  it("a classified failure maps to a labelled placeholder", () => {
    const state = reduce({ brief: "x" }, failure);
    expect(state.demo_mode).toBe(true);
    expect(state.output.text).toContain(DEMO_MARKER);
    expect(state.output.text).toContain("UNAVAILABLE");
    expect(state.output.text).toContain("No compiled prompt was produced");
  });

  it("the mapping is deterministic — same failure, identical bytes", () => {
    expect(reduce({ brief: "x" }, failure)).toEqual(reduce({ brief: "x" }, failure));
  });

  it("a success passes model content through unchanged", () => {
    const state = reduce({ brief: "x" }, success);
    expect(state.demo_mode).toBe(false);
    expect(state.output.text).toBe(success.content);
    expect(state.output.text).not.toContain(DEMO_MARKER);
  });

  it("runs every registered gate over the output", () => {
    const state = reduce({ brief: "x" }, success);
    expect(state.gate_results.map((r) => r.gate_id)).toEqual(listGates().map((g) => g.id));
  });

  it("the placeholder makes no claim of its own", () => {
    const state = reduce({ brief: "This bot is 100% accurate and we guarantee it." }, failure);
    const claim = state.gate_results.find((r) => r.gate_id === "CLAIM_DISCIPLINE");
    expect(claim?.verdict).toBe("PASS");
  });

  it("never fabricates a compiled prompt on failure", () => {
    const state = reduce({ brief: "write me a system prompt" }, failure);
    expect(state.output.text).not.toContain("SYSTEM PROMPT:");
    expect(state.output.text.toLowerCase()).not.toContain("role and objective");
  });
});

describe("stage identity", () => {
  it("is the compile stage", () => {
    expect(STAGE_ID).toBe("compile");
  });
});
