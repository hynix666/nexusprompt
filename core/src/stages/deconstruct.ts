/**
 * The `deconstruct` stage — pure. Frozen s1, "Deconstruct", role `spec`.
 *
 * First stage of the pipeline and the one that produces the spec every later stage threads
 * as `{previous}`. Template ported VERBATIM from the frozen component; `npm run check:stages`
 * compares it byte-for-byte and fails on drift, because stages have no differential oracle.
 *
 * `decide` returns a request; `reduce` folds an already-classified outcome. Neither invokes
 * anything, per ADR-0005.
 */

import type { GenerationRequest, GenerationResult, ProviderFailure } from "../../../contracts/index.js";
import { fillTemplate, buildRequest, demoPlaceholder } from "./stage-kit.js";

export const STAGE_ID = "deconstruct" as const;

const TEMPLATE = `STEP 1 — ANALYSIS (De-construction).

RAW_INTENT:
{brief}

Extract and output, as labeled sections:
- **Core Objective**: what the target agent fundamentally does.
- **Target Domain**: name it. If unstated in RAW_INTENT, infer it and mark the inference explicitly ("inferred:").
- **Named Edge Cases** — HARD GATE: list at least 4 failure modes SPECIFIC to this domain. Generic edge cases ("ambiguous input", "user is rude", "missing information") do not count and must not appear. If you cannot name domain-specific failure modes, say what information is missing instead of proceeding.
- **Output Formats**: what shape the agent's deliverables take (Markdown, JSON, code, tables), with any schema hints present in RAW_INTENT.
- **Intake Parameters**: the {{VARIABLES}} the compiled prompt will need, each with a one-line domain-specific description.

Do not begin scaffolding the prompt itself. This stage produces the spec only.`;

export interface DeconstructInput {
  brief: string;
}

/** What this stage produces: the spec, which becomes `{previous}` downstream. */
export interface DeconstructState {
  spec: string;
  demo_mode: boolean;
}

export function decide(input: DeconstructInput, run_id: string): GenerationRequest {
  // `{{VARIABLES}}` in the template survives interpolation untouched: fillTemplate only
  // matches single braces, and the doubled form is the prompt's own placeholder syntax
  // being *described* to the model, not a slot for us to fill.
  return buildRequest(run_id, STAGE_ID, fillTemplate(TEMPLATE, { brief: input.brief }));
}

export function reduce(
  input: DeconstructInput,
  outcome: GenerationResult | ProviderFailure,
): DeconstructState {
  const isFailure = "category" in outcome;
  return {
    spec: isFailure
      ? demoPlaceholder(STAGE_ID, input.brief, outcome as ProviderFailure)
      : (outcome as GenerationResult).content,
    demo_mode: isFailure,
  };
}
