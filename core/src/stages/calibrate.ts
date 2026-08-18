/**
 * The `calibrate` stage — pure. Frozen s2, "Calibrate", role `calibrate`.
 *
 * Runs early despite being "STEP 4 protocol" in the framework, which the frozen template
 * says outright in its first line. Its output becomes `{calibration}` for `compile`, and
 * that dependency is why `compile` could not be ported faithfully until this stage existed.
 *
 * Template ported VERBATIM; `npm run check:stages` compares it against the frozen source.
 */

import type { GenerationRequest, GenerationResult, ProviderFailure } from "../../../contracts/index.js";
import { fillTemplate, buildRequest, demoPlaceholder } from "./stage-kit.js";

export const STAGE_ID = "calibrate" as const;

const TEMPLATE = `STEP 4 protocol, run early — TEMPERATURE CALIBRATION.

SPEC:
{previous}

Classify the target agent's workload and choose exactly ONE profile — do not apply both:
- **HIGH-TEMPERATURE** (creative, open-ended): compile with explicit stylistic guardrails + output schemas to bound drift.
- **LOW-TEMPERATURE** (deterministic, technical): compile with maximized sequence rules and verification checklists over prose.

Output:
1. **Chosen profile**: HIGH or LOW.
2. **Why**: 2-3 sentences tied to the spec's Core Objective and Output Formats.
3. **Compilation consequences**: 3-5 concrete instructions the Compile stage must follow because of this choice (e.g. "every protocol step gets a checkable exit condition", or "include a voice/style guardrail block with 2 positive + 2 negative style examples").`;

export interface CalibrateInput {
  /** The spec from `deconstruct`. Falls back to the brief when deconstruct did not run. */
  previous?: string;
  brief: string;
}

export interface CalibrateState {
  calibration: string;
  demo_mode: boolean;
}

export function decide(input: CalibrateInput, run_id: string): GenerationRequest {
  return buildRequest(run_id, STAGE_ID,
    fillTemplate(TEMPLATE, { previous: input.previous, brief: input.brief }));
}

export function reduce(
  input: CalibrateInput,
  outcome: GenerationResult | ProviderFailure,
): CalibrateState {
  const isFailure = "category" in outcome;
  return {
    calibration: isFailure
      ? demoPlaceholder(STAGE_ID, input.previous ?? input.brief, outcome as ProviderFailure)
      : (outcome as GenerationResult).content,
    demo_mode: isFailure,
  };
}
