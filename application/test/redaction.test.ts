import { describe, it, expect } from "vitest";
import { redactingSink, sharesBody, WINDOW, REDACTED } from "../src/redaction.js";
import { redactionBodies } from "../src/pipeline.js";
import type { ObservabilityEvent } from "../../contracts/index.js";
import type { PipelineContext } from "../../core/src/stages/pipeline.js";

/**
 * Sweep fourteen — "No prompt bodies in logs, ever."
 *
 * `OBSERVABILITY.md` claimed this was "enforced in `observability/sink.ts` itself (a redaction
 * check runs before any event is written), not left as a convention for call sites to honor."
 * `observability/` does not exist, no sink module was ever tracked, and every sink in the
 * repository is an inline lambda — so it WAS a convention, and the convention was broken on the
 * error path: `failStage` copied `err.message` into `DEGRADE.verdict`, and a provider adapter
 * throwing a parse error that quotes its payload put the brief into four events.
 *
 * Two layers now. The call site forwards the error's TYPE rather than its message, and this
 * sink catches anything that still carries a body — because the first layer is exactly the
 * per-call-site discipline the claim disowns, and a layer nobody can bypass is what makes the
 * word "structural" true.
 */

const event = (over: Partial<ObservabilityEvent> = {}): ObservabilityEvent => ({
  event_id: "e", event_type: "DEGRADE", run_id: "r", parent_event_id: null,
  timestamp: "1970-01-01T00:00:00.000Z", layer: "application", component: "c",
  duration_ms: null, attempt: null, input_hash: null, output_hash: null,
  provider_id: null, model_id: null, failure_code: null, verdict: null,
  schema_version: "1.3.0", ...over,
} as ObservabilityEvent);

const BODY = "The assistant must answer billing questions for enterprise customers only.";

describe("sharesBody", () => {
  it("finds a body embedded in a longer string — the shape the leak took", () => {
    // The real leak was a body inside a sentence about a provider failure, not a bare body.
    expect(sharesBody(`provider adapter failed on payload: ${BODY}`, [BODY])).toBe(true);
  });

  it("finds a SLICE of a body, because a truncated body is still a body", () => {
    // `failStage` truncated to 200 characters. A threshold above that would have passed the
    // leak through while congratulating itself.
    expect(sharesBody(BODY.slice(0, 40), [BODY])).toBe(true);
  });

  it("survives whitespace reflow", () => {
    expect(sharesBody(BODY.replace(/ /g, "\n  "), [BODY])).toBe(true);
  });

  it("does NOT fire on ordinary text — the must-not-fire half", () => {
    // A check that fired on everything would be dropped by whoever it inconvenienced first.
    expect(sharesBody("stage_threw", [BODY])).toBe(false);
    expect(sharesBody("Error", [BODY])).toBe(false);
    expect(sharesBody("refused before dispatch: 27 planned call(s) exceeds max", [BODY])).toBe(false);
    expect(sharesBody("a".repeat(200), [BODY])).toBe(false);
  });

  it("cannot see a body shorter than the window, and that limit is stated not hidden", () => {
    // Lowering the threshold to catch these would make ordinary English collide. The guarantee
    // is bounded, and the document says so rather than implying total coverage.
    expect(BODY.slice(0, WINDOW - 1).length).toBeLessThan(WINDOW);
    expect(sharesBody(BODY.slice(0, WINDOW - 1), [BODY])).toBe(false);
  });

  it("is silent when there are no bodies to compare against", () => {
    expect(sharesBody(BODY, [])).toBe(false);
  });
});

describe("redactingSink", () => {
  it("replaces a field carrying a body, and passes the event on", () => {
    const seen: ObservabilityEvent[] = [];
    const sink = redactingSink({ emit: (e) => seen.push(e) }, () => [BODY]);

    sink.emit(event({ verdict: `provider adapter failed on payload: ${BODY}` }));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.verdict).toBe(REDACTED);
    expect(REDACTED).not.toContain(BODY.slice(0, WINDOW));
  });

  it("does not throw — a logging control must not cost the run its artifact", () => {
    // The first version threw. `failStage` emits from inside a catch, so a provider error whose
    // message quoted the brief turned a gracefully degrading run into an aborted one: the
    // artifact lost to a logging concern. Fail closed on the body, not on availability.
    const sink = redactingSink({ emit: () => {} }, () => [BODY]);
    expect(() => sink.emit(event({ verdict: BODY }))).not.toThrow();
  });

  it("leaves a clean event byte-identical", () => {
    const seen: ObservabilityEvent[] = [];
    const sink = redactingSink({ emit: (e) => seen.push(e) }, () => [BODY]);
    const clean = event({ verdict: "stage_threw", failure_code: "stage_threw" });
    sink.emit(clean);
    expect(seen[0]).toEqual(clean);
  });

  it("reads the bodies fresh on every emit", () => {
    // `ctx.prompt` is rewritten as stages run. A snapshot taken when the sink was built would
    // stop covering the artifact halfway through the run — precisely when there is most to leak.
    let current = "";
    const seen: ObservabilityEvent[] = [];
    const sink = redactingSink({ emit: (e) => seen.push(e) }, () => [current]);

    sink.emit(event({ verdict: BODY }));
    expect(seen[0]!.verdict).toBe(BODY); // not yet a body of this run

    current = BODY;
    sink.emit(event({ verdict: BODY }));
    expect(seen[1]!.verdict).toBe(REDACTED);
  });

  it("redacts every offending field, not just the first", () => {
    const seen: ObservabilityEvent[] = [];
    const sink = redactingSink({ emit: (e) => seen.push(e) }, () => [BODY]);
    sink.emit(event({ verdict: BODY, component: `core/${BODY}` }));
    expect(seen[0]!.verdict).toBe(REDACTED);
    expect(seen[0]!.component).toBe(REDACTED);
  });
});

describe("the body set the pipeline hands the sink", () => {
  /**
   * A fully-populated context, one DISTINCT body per field.
   *
   * Distinct matters more than it looks: a first attempt at this gave every field the same
   * filler sentence, so every body collided with every other and uncovered fields reported
   * as covered. The probe said 2 of 11 leaked; with genuinely distinct bodies it was 7.
   */
  const ctx: PipelineContext = {
    brief: "Draft an assistant for reconciling quarterly ledger discrepancies at Northwind.",
    spec: "Objective: reconcile invoice mismatches across three disconnected billing systems.",
    calibration: "Profile rationale: deterministic arithmetic over adversarial vendor statements.",
    prompt: "Identity: a reconciliation analyst bound to the Northwind chart of accounts.",
    critique: "G2 failure: the scope clause never names the Northwind boundary it claims.",
    lint: "[DEGRADED] token_estimate=214 WARN GUARDRAIL_GAP: missing scope contraction clause.",
    critic: "Finding one: the identity asserts audit authority the brief never delegated.",
    preview: "Certainly, here is how I would reconcile the November vendor statement lines.",
    cost: "PROMPT SIZE approx 214 tok; representative rates only, not fetched live, verify.",
    tone: "Register drift: section four swings into casual voice mid-clause without cause.",
    testMessage: "Why does vendor statement 4471 disagree with our ledger by eight hundred?",
    // Short scalars: never bodies, and the sink's own WINDOW filter drops them.
    stakes: "HIGH",
    depth: "STANDARD",
    lintStatus: "DEGRADED",
    criticVerdict: "PASS",
    voice: "CONSISTENT",
  };

  it("covers every body the context holds, enumerated from the context itself", () => {
    /**
     * Iterating `ctx`'s own keys rather than a list written here is the point. The call site
     * named four fields — `brief`, `prompt`, `spec`, `critique` — while the context held
     * eleven bodies, and a test that named the same four would have passed. Measured before
     * the fix: seven of eleven would have reached an event verbatim, `preview` among them,
     * which is a model's reply generated with the compiled prompt as its system message.
     *
     * A twelfth body field added later is covered by this assertion the day it is added.
     */
    const bodies = redactionBodies(ctx);
    for (const [field, value] of Object.entries(ctx)) {
      if (typeof value !== "string" || value.length < WINDOW) continue;
      expect(bodies, `${field} is not in the redaction body set`).toContain(value);
      // And the property that actually matters: a leak of it would be caught.
      expect(
        sharesBody(`provider adapter failed on payload: ${value}`, bodies),
        `a leak of ${field} would not be caught`,
      ).toBe(true);
    }
  });

  it("does not sweep in the short scalars — they could never be bodies", () => {
    // They are in the derived list, and the sink drops them by length. Asserting the second
    // half explicitly, because "harmless" is the kind of claim that stops being true quietly.
    const kept = redactionBodies(ctx).filter((b) => b.length >= WINDOW);
    for (const scalar of ["HIGH", "STANDARD", "PASS", "CONSISTENT"]) {
      expect(kept).not.toContain(scalar);
    }
    // A short scalar cannot cause a redaction on its own.
    expect(sharesBody("stakes were HIGH and depth STANDARD for this run", ["HIGH", "STANDARD"]))
      .toBe(false);
  });
});
