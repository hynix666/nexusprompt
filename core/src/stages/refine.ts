/**
 * The `refine` stage — pure. Frozen s6, "Refine", role `refine`.
 *
 * Rewrites the prompt to resolve every item in the critique: gate failures (G1-G4) are
 * mandatory, benchmark items (B1-B4) are fixed unless a fix would violate a gate.
 *
 * The template instructs the MODEL to return the prompt unchanged when the critique is
 * exactly the pass sentinel. `shouldSkip` exposes the same test to the caller so the
 * decision can be made without a provider call at all — same rule, one definition, and the
 * sentinel is imported from `critique` rather than retyped.
 *
 * Template ported VERBATIM; `npm run check:stages` compares it against the frozen source.
 */

import type { GenerationRequest, GenerationResult, ProviderFailure } from "../../../contracts/index.js";
import { fillTemplate, buildRequest, failurePlaceholder, refuseForgedMarker } from "./stage-kit.js";
import { isClean } from "./critique.js";

export const STAGE_ID = "refine" as const;

const TEMPLATE = `STEP 4 — REFINEMENT. Rewrite the compiled system prompt so it resolves EVERY item in the critique. Gate failures (G1-G4) are mandatory fixes; benchmark items (B1-B4) should be fixed unless doing so would violate a gate. Preserve intent; change only what the critique demands plus obvious tightening.

If the critique is exactly "PASS — no gate or benchmark failures.", return the prompt unchanged.

CURRENT PROMPT:
{prompt}

CRITIQUE TO RESOLVE:
{critique}

Output ONLY the refined system prompt.`;

export interface RefineInput {
  prompt: string;
  critique: string;
}

export interface RefineState {
  prompt: string;
  demo_mode: boolean;
  /** True when refinement was skipped because the critique found nothing. */
  skipped: boolean;
}

/**
 * A clean critique means there is nothing to refine, so the call can be skipped entirely.
 *
 * Core decides; the Application acts on the decision. This is the same rule the template
 * states to the model, hoisted so a provider call is not spent asking a model to return its
 * input unchanged — and so the skip is a recorded, testable decision rather than an
 * outcome we hope the model reached.
 */
export const shouldSkip = (input: RefineInput): boolean => isClean(input.critique);

export function decide(input: RefineInput, run_id: string): GenerationRequest {
  return buildRequest(run_id, STAGE_ID,
    fillTemplate(TEMPLATE, { prompt: input.prompt, critique: input.critique }));
}

export function reduce(
  input: RefineInput,
  outcome: GenerationResult | ProviderFailure,
): RefineState {
  // A forged marker is a provider failure, decided before the branch so every stage
  // inherits it through the placeholder path it already has.
  const settled = refuseForgedMarker(outcome);
  const isFailure = "category" in settled;
  return {
    prompt: isFailure
      ? failurePlaceholder(STAGE_ID, input.prompt, settled as ProviderFailure)
      : (settled as GenerationResult).content,
    demo_mode: isFailure,
    skipped: false,
  };
}

/** The skip path, as a reduction with no outcome — nothing was invoked, so nothing degraded. */
export function reduceSkipped(input: RefineInput): RefineState {
  return { prompt: input.prompt, demo_mode: false, skipped: true };
}
