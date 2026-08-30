/**
 * The `compile` stage — pure.
 *
 * This is the shape ADR-0005 requires, and the reason the file has two exported
 * functions instead of one `run()`:
 *
 *   decide(input)            -> a GenerationRequest describing what should happen
 *   [the Application performs the effect and classifies the outcome]
 *   reduce(input, outcome)   -> the next state
 *
 * Neither function invokes anything. Neither takes a callback. `reduce` receives
 * an outcome that has *already* been classified into a success or a typed
 * failure, so a provider being unreachable reaches Core as a value, not an event.
 *
 * That is what makes demo mode testable without a provider: the same classified
 * failure always produces the same placeholder, and the test asserts it directly.
 *
 * Template ported VERBATIM from sources/pipeline/SystemPromptBuilderPipeline.tsx
 * (DEFAULT_STAGES, s3 "Compile"), and `npm run check:stages` now compares it byte-for-byte.
 *
 * It was NOT verbatim before. The vertical slice ran this stage with no pipeline around it,
 * so `{calibration}` and `{blueprint}` had no producers and a self-contained template was
 * used instead — while the comment here claimed the frozen s3 had been ported. Defensible
 * at the time, unrecorded, and caught by check:stages on its first run. Now that
 * `deconstruct` and `calibrate` exist, the real template fits and the deviation is gone.
 */

import type {
  GenerationRequest,
  GenerationResult,
  ProviderFailure,
  GateResult,
} from "../../../contracts/index.js";
import { runGates } from "../gates/registry.js";
import { fillTemplate, buildRequest, failurePlaceholder, DEMO_MARKER, refuseForgedMarker } from "./stage-kit.js";

export const STAGE_ID = "compile" as const;

export { DEMO_MARKER };

const TEMPLATE = `STEP 2 — SCAFFOLDING. Compile the system prompt using the blueprint below. Every bracketed placeholder MUST be replaced with content specific to the target domain — an unfilled [Description] in your output is a failed compile, not a draft.

SPEC:
{previous}

CALIBRATION (obey its compilation consequences):
{calibration}

OUTPUT BLUEPRINT — follow this structure exactly, filling every bracket:
{blueprint}

Requirements:
- Section 3 Step 4 (Self-Check) must contain concrete, checkable conditions derived from the spec's Named Edge Cases — at least one check per edge case.
- Section 2 must include behavior for missing required intake (ask a targeted question vs. proceed with flagged assumption) — never "fabricate defaults silently".
- Section 5 must include a worked example if the output schema is non-trivial.

Output ONLY the compiled system prompt in the blueprint structure.`;

export interface CompileInput {
  brief: string;
  /** The spec from `deconstruct`. Falls back to the brief. */
  previous?: string;
  /** The profile from `calibrate`. Absent substitutes the source's documented default. */
  calibration?: string;
}

/** What Core decided should happen. The Application executes it; Core does not. */
export interface DemoAction {
  type: "demo";
  reason_code: string;
}

export interface ReducedState {
  output: { text: string };
  gate_results: GateResult[];
  demo_mode: boolean;
}

/**
 * Decide what this stage needs. Returns a request to be executed elsewhere.
 *
 * `request_id` is derived from the input by hashing rather than generated
 * randomly — Core has no randomness, and a deterministic id means the same
 * input produces the same request, which the determinism tests rely on.
 */
export function decide(input: CompileInput, run_id: string): GenerationRequest {
  const prompt = fillTemplate(TEMPLATE, {
    previous: input.previous,
    brief: input.brief,
    calibration: input.calibration,
  });
  return buildRequest(run_id, STAGE_ID, prompt);
}

/**
 * Fold an already-classified outcome into the next state.
 *
 * The failure branch is deterministic by construction: same category in, same
 * placeholder out. Nothing here inspects a network, a clock, or an exception.
 *
 * **`runGates` here is a vertical-slice artifact, and `lint` (s7) is where gating belongs.**
 * The frozen component gates in s7 only; this stage gated inline because during Phase 1 it
 * was the sole stage and there was nowhere else to put it. `lint` now exists and runs the
 * full sixteen-gate registry.
 *
 * It is deliberately NOT removed yet. No multi-stage pipeline is assembled — the
 * orchestrator runs one stage per call — so deleting this would leave nothing gating
 * anything, and the eval suite's fourteen cases read `gate_results` from exactly here.
 * The reconciliation belongs with the pipeline assembly that Phase 3's exit gate
 * describes, and is recorded rather than carried silently.
 */
export function reduce(
  input: CompileInput,
  outcome: GenerationResult | ProviderFailure,
): ReducedState {
  // A forged marker is a provider failure, decided before the branch so every stage
  // inherits it through the placeholder path it already has.
  const settled = refuseForgedMarker(outcome);
  const isFailure = "category" in settled;

  const text = isFailure
    ? failurePlaceholder(STAGE_ID, input.previous ?? input.brief, settled as ProviderFailure)
    : (settled as GenerationResult).content;

  return {
    output: { text },
    gate_results: runGates(text),
    demo_mode: isFailure,
  };
}
