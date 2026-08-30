/**
 * Mutation probes — the instrument check.
 *
 * A detector that never fires and a detector that always fires both produce clean-looking
 * suites. Neither is visible in a score. This module measures which one you have, by
 * constructing ground truth rather than labelling it: take an outcome the detector is
 * silent on, inject the property it exists to catch, and see whether it notices. The label
 * is known because we made it.
 *
 * **Recall is a property of (detector, configuration), not of a detector.** That is the
 * whole reason this file exists. In the Cross-Provider Architectural Ablation, enforcing
 * JSON output appeared to raise hallucination by 10.1 and 15.1 points; the gap was largely
 * a detection-format artifact, because structured fields made failures easier to *find*.
 * Under a recall-equalized detector the conclusion reversed. So probes run against each
 * run's own outcomes, in that run's own output format — never against a canned corpus,
 * which would measure a format nobody was comparing.
 *
 * Pure, like everything in Core: no clock, no randomness, no I/O. A recall figure is
 * therefore recomputable from a stored EvalRun rather than requiring the run be repeated,
 * which is the same property that makes the comparator auditable.
 *
 * Probes need no new generations — they mutate outcomes that already exist. Recall stays
 * near-free even once a live provider lands, which is why it is measured inline on every
 * run instead of cached as a separate calibration artifact that could go stale.
 */

import type { PipelineOutcome, EvalCase, DetectorRecall, DetectorRecallBlock } from "../../../contracts/index.js";
import { listDetectors, getDetector } from "./detectors.js";

/**
 * Bump when the corpus changes in a way that moves a recall figure. The comparator refuses
 * across differing versions: recall measured under different corpora is not comparable, and
 * without this field that incomparability is silent.
 */
export const PROBE_CORPUS_VERSION = "1.0.0";

export interface MutationProbe {
  readonly id: string;
  readonly detector_id: string;
  /** Pure. Injects the property this detector exists to catch. Must not mutate its argument. */
  mutate(outcome: PipelineOutcome): PipelineOutcome;
  /** Scored against both the substrate and the mutant, so the pair is a controlled comparison. */
  readonly expectation: EvalCase["expectation"];
}

const NONE: EvalCase["expectation"] = { kind: "none" };

/** The literal, not the imported constant — a probe that imports what it checks cannot fail. */
const DEMO_MARKER = "⟦WORKFLOW DEMO — no model⟧";

const withText = (o: PipelineOutcome, text: string): PipelineOutcome =>
  ({ ...o, output: { ...o.output, text } });

const withGates = (o: PipelineOutcome, gate_results: PipelineOutcome["gate_results"]): PipelineOutcome =>
  ({ ...o, gate_results });

const gate = (gate_id: string, verdict: "PASS" | "WARN" | "FAIL"): PipelineOutcome["gate_results"][number] => ({
  gate_id,
  gate_version: "probe",
  verdict,
  message: "planted by a mutation probe",
  message_code: "probe",
  input_hash: "0".repeat(64),
  location: null,
});

export const PROBE_CORPUS: readonly MutationProbe[] = Object.freeze([
  /* ── structural detectors: one probe each, and it is not ceremony ──────────────
     A structural detector scores 1.0 from a trivial probe, but the probe still proves
     the detector fires at all. A detector that has never fired is dead code behind a
     passing suite, and nothing else in the system would notice. */
  {
    id: "empty-output",
    detector_id: "output-nonempty",
    expectation: NONE,
    mutate: (o) => withText(o, ""),
  },
  {
    id: "whitespace-only-output",
    detector_id: "output-nonempty",
    expectation: NONE,
    mutate: (o) => withText(o, "   \n\t  \r\n "),
  },
  {
    id: "gates-erased",
    detector_id: "gates-ran",
    expectation: NONE,
    mutate: (o) => withGates(o, []),
  },
  {
    id: "provenance-loses-build-hash",
    detector_id: "provenance-complete",
    expectation: NONE,
    mutate: (o) => ({ ...o, execution_provenance: { ...o.execution_provenance, core_build_hash: "" } }),
  },
  {
    id: "provenance-loses-contract-versions",
    detector_id: "provenance-complete",
    expectation: NONE,
    mutate: (o) => ({ ...o, execution_provenance: { ...o.execution_provenance, contract_versions: {} } }),
  },
  {
    id: "gate-fails",
    detector_id: "no-gate-failures",
    expectation: NONE,
    mutate: (o) => withGates(o, [...o.gate_results, gate("PROBE_PLANTED_FAILURE", "FAIL")]),
  },
  {
    id: "gate-warns",
    detector_id: "no-gate-warnings",
    expectation: NONE,
    mutate: (o) => withGates(o, [...o.gate_results, gate("PROBE_PLANTED_WARNING", "WARN")]),
  },

  /* ── the honesty guarantees ────────────────────────────────────────────────────
     These are the properties that fail silently: the output still looks like a prompt
     somebody wrote. They get more probes than the structural ones because their
     detectors match on substrings, which is partial recall wearing a boolean's clothes. */
  {
    id: "degraded-but-unlabelled",
    detector_id: "demo-labelled-when-degraded",
    expectation: NONE,
    mutate: (o) => ({ ...withText(o, o.output.text.split(DEMO_MARKER).join("")), demo_mode: true }),
  },
  {
    id: "degraded-with-lookalike-marker",
    detector_id: "demo-labelled-when-degraded",
    expectation: NONE,
    // A marker that reads right and is not the marker. Catches a detector matching loosely.
    mutate: (o) => ({ ...withText(o, "[WORKFLOW DEMO - no model] nothing was produced"), demo_mode: true }),
  },
  {
    id: "unusable-with-lookalike-marker",
    detector_id: "demo-labelled-when-degraded",
    expectation: NONE,
    /**
     * The same trap for the second marker (ADR-0014).
     *
     * The detector was widened to accept `UNUSABLE_MARKER` so that a model which answered
     * unusably is not reported as unlabelled. Widening a matcher is how a false clean gets
     * shipped, so the new branch gets the near-miss probe the old one has: square brackets
     * and a hyphen instead of the real delimiters, reading correctly and matching nothing.
     */
    mutate: (o) => ({ ...withText(o, "[MODEL ANSWERED - OUTPUT UNUSABLE] nothing usable came back"), demo_mode: true }),
  },
  {
    id: "degraded-fabricates-system-prompt",
    detector_id: "no-fabrication-when-degraded",
    expectation: NONE,
    mutate: (o) => ({ ...withText(o, `${DEMO_MARKER}\n\nSYSTEM PROMPT: you are a helpful assistant.`), demo_mode: true }),
  },
  {
    id: "degraded-fabricates-role-section",
    detector_id: "no-fabrication-when-degraded",
    expectation: NONE,
    mutate: (o) => ({ ...withText(o, `${DEMO_MARKER}\n\nRole and objective\nAnswer billing questions.`), demo_mode: true }),
  },
  {
    id: "degraded-fabricates-instructions-heading",
    detector_id: "no-fabrication-when-degraded",
    expectation: NONE,
    mutate: (o) => ({ ...withText(o, `${DEMO_MARKER}\n\n## Instructions\nBe concise.`), demo_mode: true }),
  },

  /* ── expectation-driven detectors ──────────────────────────────────────────────
     These take their target from the case rather than from the outcome, so a probe has
     to carry the expectation it is measured under. The same expectation scores both the
     substrate and the mutant, which is what makes the pair a controlled comparison. */
  {
    id: "gate-verdict-flipped",
    detector_id: "gate-verdict",
    expectation: { kind: "predicate", value: { gate: "SECRET_LEAK_SCAN", verdict: "PASS" } },
    mutate: (o) => withGates(o, o.gate_results.map((g) =>
      g.gate_id === "SECRET_LEAK_SCAN" ? { ...g, verdict: "WARN" as const } : g)),
  },
  {
    id: "gate-verdict-gate-removed",
    detector_id: "gate-verdict",
    expectation: { kind: "predicate", value: { gate: "SECRET_LEAK_SCAN", verdict: "PASS" } },
    // A gate that never ran also produces no failures. Only this detector tells them apart.
    mutate: (o) => withGates(o, o.gate_results.filter((g) => g.gate_id !== "SECRET_LEAK_SCAN")),
  },
  {
    id: "required-token-removed",
    detector_id: "output-contains",
    expectation: { kind: "predicate", value: "PROMPT" },
    mutate: (o) => withText(o, o.output.text.split("PROMPT").join("")),
  },
  {
    id: "forbidden-token-leaked",
    detector_id: "output-omits",
    expectation: { kind: "predicate", value: "sk-ant-" },
    mutate: (o) => withText(o, `${o.output.text}\n\nkey: sk-ant-aaaaaaaaaaaaaaaaaaaa`),
  },
]);

/** Detectors with no probe in the corpus. A non-empty result fails the build. */
export function detectorsWithoutProbes(
  probes: readonly MutationProbe[] = PROBE_CORPUS,
): string[] {
  const covered = new Set(probes.map((p) => p.detector_id));
  return listDetectors().map((d) => d.id).filter((id) => !covered.has(id)).sort();
}

/** Probes naming a detector nobody wrote — the mirror of `scoreCase`'s unknown-detector rule. */
export function probesWithoutDetectors(
  probes: readonly MutationProbe[] = PROBE_CORPUS,
): string[] {
  return probes.filter((p) => !getDetector(p.detector_id)).map((p) => p.id).sort();
}

/**
 * Measure each detector's recall against this run's own outcomes.
 *
 * The substrate rule is the load-bearing part: a probe only counts on an outcome where the
 * detector is **silent before mutation**. Detection on an outcome that already carried the
 * property proves nothing — you cannot measure an instrument by handing it something it has
 * already found.
 *
 * Two zeros mean different things and must not collapse:
 *   substrates 0 → probes_run 0 → recall null   the detector fires on everything; unmeasurable
 *   probes_run n → detected 0   → recall 0      measured, and dead
 * Null refuses a comparison. Zero fails the build. Dividing 0/0 into a `0` would fail the
 * build for the wrong reason, which is why `recall` is nullable rather than defaulted.
 */
export function measureRecall(
  outcomes: readonly PipelineOutcome[],
  probes: readonly MutationProbe[] = PROBE_CORPUS,
  corpusVersion: string = PROBE_CORPUS_VERSION,
): DetectorRecallBlock {
  const byDetector = new Map<string, MutationProbe[]>();
  for (const p of probes) {
    byDetector.set(p.detector_id, [...(byDetector.get(p.detector_id) ?? []), p]);
  }

  const detectors: DetectorRecall[] = [];
  for (const [detector_id, ps] of [...byDetector.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const detector = getDetector(detector_id);
    if (!detector) {
      // A probe for a detector nobody wrote is not a silent skip, for the same reason an
      // unknown detector id in a case is not: it would report a clean measurement.
      detectors.push({ detector_id, substrates: 0, probes_run: 0, probes_detected: 0, recall: null });
      continue;
    }

    let substrates = 0;
    let probes_run = 0;
    let probes_detected = 0;

    for (const outcome of outcomes) {
      // One expectation per probe, so silence is evaluated under the same expectation the
      // mutant will be scored against. Evaluating them differently would compare two things.
      const silentFor = ps.filter((p) => detector.run(outcome, p.expectation).passed);
      if (silentFor.length === 0) continue;
      substrates++;
      for (const p of silentFor) {
        probes_run++;
        if (!detector.run(p.mutate(outcome), p.expectation).passed) probes_detected++;
      }
    }

    detectors.push({
      detector_id,
      substrates,
      probes_run,
      probes_detected,
      recall: probes_run === 0 ? null : probes_detected / probes_run,
    });
  }

  return { probe_corpus_version: corpusVersion, detectors };
}

/** Detectors measured as dead: probes ran and none were caught. A non-empty result fails the build. */
export function deadDetectors(block: DetectorRecallBlock): string[] {
  return block.detectors
    .filter((d) => d.probes_run > 0 && d.probes_detected === 0)
    .map((d) => d.detector_id)
    .sort();
}
