import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fillTemplate, buildRequest, BLUEPRINT, NO_CALIBRATION, DEMO_MARKER } from "../src/stages/stage-kit.js";
import * as deconstruct from "../src/stages/deconstruct.js";
import * as calibrate from "../src/stages/calibrate.js";
import * as compile from "../src/stages/compile.js";
import type { ProviderFailure, GenerationResult } from "../../contracts/index.js";

/**
 * The three stages ported so far, and the plumbing they share.
 *
 * Stages have no differential oracle — `check:stages` compares TEMPLATE text against the
 * frozen component, and these cover the behaviour around it: interpolation, the refusal on
 * an unfilled slot, and the demo path.
 */

const failure: ProviderFailure = {
  request_id: "r", category: "UNAVAILABLE", retriable: false,
  reason_code: "test", safe_message: "provider unreachable",
  retry_after_ms: null, attempt: 1, provider_id: "test",
};
const ok = (content: string): GenerationResult => ({
  request_id: "r", content, provider_id: "test", model_id: "m", finish_reason: "end_turn",
});

describe("fillTemplate", () => {
  it("fills the slots the pipeline owns", () => {
    expect(fillTemplate("a {brief} b", { brief: "X" })).toBe("a X b");
    expect(fillTemplate("{previous}", { brief: "B" })).toBe("B"); // previous falls back to brief
  });

  it("substitutes the source's documented default for a missing calibration", () => {
    // Not an empty string: "obey its compilation consequences:" followed by nothing is an
    // instruction to obey a blank.
    expect(fillTemplate("{calibration}", { brief: "b" })).toBe(NO_CALIBRATION);
  });

  it("refuses a template with an unfilled single-brace slot", () => {
    // A half-filled template is not a degraded prompt — it names a slot the model cannot
    // see, and the model will invent content for it.
    expect(() => fillTemplate("hello {nobody_fills_this}", { brief: "b" }))
      .toThrow(/unresolved placeholders: \{nobody_fills_this\}/);
  });

  it("leaves DOUBLED braces alone — the divergence from the frozen component", () => {
    /**
     * `{{VARIABLE_1}}` is the COMPILED PROMPT's placeholder syntax, described to the model.
     * `{calibration}` is a slot THIS pipeline fills. The frozen `fill()` conflates them:
     * its `/\{[a-zA-Z][^}]*\}/` matches `{VARIABLE_1}` inside `{{VARIABLE_1}}`, and since
     * BLUEPRINT is full of doubled braces, the source's own compile stage always throws.
     * Porting that faithfully would ship a stage that cannot render.
     */
    expect(fillTemplate("{{VARIABLE_1}} and {{VARIABLES}}", { brief: "b" }))
      .toBe("{{VARIABLE_1}} and {{VARIABLES}}");
    expect(() => fillTemplate("{blueprint}", { brief: "b" })).not.toThrow();
  });

  it("the frozen component's own guard would have thrown here", () => {
    // Pinned as a fact about the source, not an opinion about it. If a future drop fixes
    // this upstream, this test fails and the divergence note above should be revisited.
    const src = readFileSync("sources/pipeline/SystemPromptBuilderPipeline.tsx", "utf8");
    const frozenGuard = /\{[a-zA-Z][^}]*\}/;
    expect(src).toContain("Template contains unresolved placeholders.");
    expect(frozenGuard.test(BLUEPRINT)).toBe(true);
  });
});

describe("buildRequest", () => {
  it("derives request_id from the input, so the same input gives the same request", () => {
    const a = buildRequest("run", "compile", "prompt");
    const b = buildRequest("run", "compile", "prompt");
    expect(a.request_id).toBe(b.request_id);
    expect(buildRequest("run", "compile", "other").request_id).not.toBe(a.request_id);
    expect(a.idempotency_key).toBe(a.request_id);
  });
});

describe("deconstruct", () => {
  it("threads the brief and asks for the spec only", () => {
    const req = deconstruct.decide({ brief: "A billing bot." }, "run");
    expect(req.messages[0].content).toContain("A billing bot.");
    expect(req.messages[0].content).toContain("STEP 1 — ANALYSIS");
    expect(req.messages[0].content).toContain("This stage produces the spec only.");
  });

  it("keeps {{VARIABLES}} intact for the model to read", () => {
    expect(deconstruct.decide({ brief: "x" }, "run").messages[0].content).toContain("{{VARIABLES}}");
  });

  it("degrades to a labelled placeholder that fabricates no spec", () => {
    const state = deconstruct.reduce({ brief: "x" }, failure);
    expect(state.demo_mode).toBe(true);
    expect(state.spec).toContain(DEMO_MARKER);
    expect(state.spec).not.toContain("Core Objective");
  });
});

describe("calibrate", () => {
  it("threads the spec from deconstruct", () => {
    const req = calibrate.decide({ brief: "b", previous: "THE SPEC" }, "run");
    expect(req.messages[0].content).toContain("THE SPEC");
    expect(req.messages[0].content).toContain("TEMPERATURE CALIBRATION");
  });

  it("falls back to the brief when deconstruct did not run", () => {
    expect(calibrate.decide({ brief: "RAW BRIEF" }, "run").messages[0].content).toContain("RAW BRIEF");
  });

  it("degrades without inventing a profile", () => {
    const state = calibrate.reduce({ brief: "x" }, failure);
    expect(state.demo_mode).toBe(true);
    expect(state.calibration).toContain(DEMO_MARKER);
    expect(state.calibration).not.toMatch(/HIGH-TEMPERATURE|LOW-TEMPERATURE/);
  });
});

describe("compile, now ported verbatim", () => {
  it("carries the frozen blueprint and both upstream slots", () => {
    const req = compile.decide({ brief: "b", previous: "SPEC", calibration: "LOW" }, "run");
    const p = req.messages[0].content;
    expect(p).toContain("STEP 2 — SCAFFOLDING");
    expect(p).toContain("SPEC");
    expect(p).toContain("LOW");
    expect(p).toContain("## 5. REQUISITE OUTPUT SCHEMAS"); // the blueprint went in
    expect(p).toContain("{{VARIABLE_1}}");                 // and survived intact
  });

  it("uses the documented default when calibrate has not run", () => {
    expect(compile.decide({ brief: "b" }, "run").messages[0].content).toContain(NO_CALIBRATION);
  });

  it("still gates its output and labels a degraded run", () => {
    const degraded = compile.reduce({ brief: "x" }, failure);
    expect(degraded.demo_mode).toBe(true);
    expect(degraded.output.text).toContain(DEMO_MARKER);
    expect(degraded.gate_results.length).toBeGreaterThan(0);

    const live = compile.reduce({ brief: "x" }, ok("# SYSTEM PROMPT\n\nScope: billing."));
    expect(live.demo_mode).toBe(false);
    expect(live.output.text).not.toContain(DEMO_MARKER);
  });
});
