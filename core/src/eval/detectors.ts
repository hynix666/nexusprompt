/**
 * Deterministic detectors.
 *
 * Pure functions of (outcome, expectation). No clock, no network, no judge — which
 * is the point: the offline half of an evaluation suite has to run in milliseconds
 * at zero budget, or it becomes a suite people skip. A judge is expensive, biased,
 * and itself needs evaluating, so anything a verifier can settle must never reach one.
 * The catalog already draws this line with `verification_status`; these are the
 * `verifier-checkable` side of it.
 *
 * Detectors are registered rather than hardcoded, for the reason the gate registry
 * exists: of the seventeen prototypes surveyed, none had a registry and none grew
 * past its author's original set. The list is the ceiling.
 */

import type { PipelineOutcome, EvalCase, Score } from "../../../contracts/index.js";

export interface Detector {
  readonly id: string;
  /** Deterministic: same outcome and expectation, same verdict, always. */
  run(outcome: PipelineOutcome, expectation: EvalCase["expectation"]): { passed: boolean; detail: string };
}

/** The literal, not the imported constant — a test that imports what it checks cannot fail. */
const DEMO_MARKER = "⟦WORKFLOW DEMO — no model⟧";

const DETECTORS: readonly Detector[] = Object.freeze([
  {
    id: "output-nonempty",
    run: (o) => ({
      passed: o.output.text.trim().length > 0,
      detail: `${o.output.text.trim().length} chars`,
    }),
  },
  {
    id: "no-gate-failures",
    run: (o) => {
      const failed = o.gate_results.filter((g) => g.verdict === "FAIL").map((g) => g.gate_id);
      return { passed: failed.length === 0, detail: failed.length ? `FAIL: ${failed.join(", ")}` : "no FAIL verdicts" };
    },
  },
  {
    id: "no-gate-warnings",
    run: (o) => {
      const warned = o.gate_results.filter((g) => g.verdict === "WARN").map((g) => g.gate_id);
      return { passed: warned.length === 0, detail: warned.length ? `WARN: ${warned.join(", ")}` : "no WARN verdicts" };
    },
  },
  {
    id: "gates-ran",
    run: (o) => ({
      passed: o.gate_results.length > 0,
      detail: `${o.gate_results.length} gate(s) ran`,
    }),
  },
  {
    /**
     * The honesty guarantee, checked rather than assumed: when no model answered, the
     * output must say so. This is the one property the whole demo-mode mechanism exists
     * to provide, and it is silent when it breaks — the output simply looks like a
     * prompt somebody wrote.
     */
    id: "demo-labelled-when-degraded",
    run: (o) => {
      if (!o.demo_mode) return { passed: true, detail: "not degraded" };
      const marked = o.output.text.includes(DEMO_MARKER);
      return { passed: marked, detail: marked ? "labelled" : "DEGRADED BUT UNLABELLED" };
    },
  },
  {
    /** Degraded output must not look like a compiled prompt. Fabrication here is silent. */
    id: "no-fabrication-when-degraded",
    run: (o) => {
      if (!o.demo_mode) return { passed: true, detail: "not degraded" };
      const lower = o.output.text.toLowerCase();
      const tells = ["system prompt:", "role and objective", "## instructions"];
      const found = tells.filter((t) => lower.includes(t));
      return { passed: found.length === 0, detail: found.length ? `fabricated: ${found.join(", ")}` : "no fabricated prompt" };
    },
  },
  {
    id: "output-contains",
    run: (o, e) => {
      const want = String(e.value ?? "");
      const passed = want.length > 0 && o.output.text.includes(want);
      return { passed, detail: passed ? `contains ${JSON.stringify(want)}` : `missing ${JSON.stringify(want)}` };
    },
  },
  {
    id: "output-omits",
    run: (o, e) => {
      const forbidden = String(e.value ?? "");
      const passed = forbidden.length > 0 && !o.output.text.includes(forbidden);
      return { passed, detail: passed ? `omits ${JSON.stringify(forbidden)}` : `LEAKED ${JSON.stringify(forbidden)}` };
    },
  },
  {
    /**
     * Assert a named gate reached a named verdict. This is the detector that makes a
     * gate suite meaningful: `no-gate-failures` only shows gates stayed quiet, which a
     * gate that never fires also achieves. Expectation value is `{gate, verdict}`.
     */
    id: "gate-verdict",
    run: (o, e) => {
      const want = e.value as { gate?: string; verdict?: string } | undefined;
      if (!want?.gate || !want?.verdict) {
        return { passed: false, detail: "expectation.value must be {gate, verdict}" };
      }
      const got = o.gate_results.find((g) => g.gate_id === want.gate);
      if (!got) return { passed: false, detail: `gate ${want.gate} did not run` };
      const passed = got.verdict === want.verdict;
      return { passed, detail: `${want.gate} → ${got.verdict}${passed ? "" : ` (wanted ${want.verdict})`}` };
    },
  },
  {
    /** Provenance completeness. A run missing its attribution tuple is not scorable. */
    id: "provenance-complete",
    run: (o) => {
      const p = o.execution_provenance;
      const missing: string[] = [];
      if (!p?.core_build_hash) missing.push("core_build_hash");
      if (!p?.contract_versions || Object.keys(p.contract_versions).length === 0) missing.push("contract_versions");
      if (p?.provider_model_fingerprint === undefined) missing.push("provider_model_fingerprint");
      return { passed: missing.length === 0, detail: missing.length ? `missing ${missing.join(", ")}` : "complete" };
    },
  },
]);

export function listDetectors(): readonly Detector[] {
  return DETECTORS;
}

export function getDetector(id: string): Detector | undefined {
  return DETECTORS.find((d) => d.id === id);
}

/**
 * Score one case. An unknown detector id is a failed score with a reason, never a
 * silent skip: a suite that references a detector nobody wrote would otherwise report
 * a perfect run.
 */
export function scoreCase(kase: EvalCase, outcome: PipelineOutcome): Score[] {
  return kase.detector_ids.map((id) => {
    const detector = getDetector(id);
    if (!detector) {
      return { case_id: kase.case_id, detector_id: id, passed: false, detail: `unknown detector "${id}"` };
    }
    const { passed, detail } = detector.run(outcome, kase.expectation);
    return { case_id: kase.case_id, detector_id: id, passed, detail };
  });
}

/** A case passes only if every one of its detectors passes. */
export function casePassed(scores: readonly Score[]): boolean {
  return scores.length > 0 && scores.every((s) => s.passed);
}
