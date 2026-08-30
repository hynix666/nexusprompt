import { describe, it, expect } from "vitest";
import { redactingSink, sharesBody, WINDOW, REDACTED } from "../src/redaction.js";
import type { ObservabilityEvent } from "../../contracts/index.js";

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
