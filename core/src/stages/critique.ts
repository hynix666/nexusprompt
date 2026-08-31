/**
 * The `critique` stage — pure. Frozen s5, "Critique", role `critique`.
 *
 * Not to be confused with `critic` (s8), which is a separate stage with a separate id. This
 * one is the strict reviewer: four hard gates, four benchmarks, concrete failures only.
 *
 * Its contract with `refine` (s6) is a literal string. When nothing fails it must return
 * exactly `PASS — no gate or benchmark failures.`, because s6 keys on that text to decide
 * whether to return the prompt unchanged. Two stages coupled through an exact sentence is
 * fragile, so `PASS_SENTINEL` is exported and both sides use the constant.
 *
 * Template ported VERBATIM; `npm run check:stages` compares it against the frozen source.
 */

import type { GenerationRequest, GenerationResult, ProviderFailure } from "../../../contracts/index.js";
import { fillTemplate, buildRequest, failurePlaceholder, refuseForgedMarker } from "./stage-kit.js";

export const STAGE_ID = "critique" as const;

/**
 * The exact string s6 tests for. Defined here, next to the template that produces it, and
 * imported by refine rather than retyped — a second copy of this literal is a silent
 * pipeline break the moment one of them changes.
 */
export const PASS_SENTINEL = "PASS — no gate or benchmark failures.";

const TEMPLATE = `You are the strict reviewer of the unified compiler protocol. Evaluate this compiled system prompt against the hard gates and benchmarks below. List concrete failures only — no praise, no rewrite.

COMPILED PROMPT:
{prompt}

HARD GATES (any failure here is a failed compile):
- G1 **Placeholder Completeness**: zero unfilled brackets ([...], {{UNDEFINED}}) anywhere. Quote each offender.
- G2 **Domain-Bound Guardrails**: anti-override, scope-contraction, and fact-grounding are tied to THIS domain's boundaries, not restated generically. Quote any generic restatement.
- G3 **Named Edge Cases**: Section 3's self-check conditions trace to domain-specific failure modes — "review your work" style checks fail this gate.
- G4 **No False Guarantees**: no claims of guaranteed jailbreak-resistance, hallucination-freedom, or determinism.

EVALUATION BENCHMARKS:
- B1 **Token Efficiency**: flag verbose padding, restated content, filler.
- B2 **Attention Density**: key constraints should sit at section tops/bottoms — flag buried ones.
- B3 **Execution Determinism**: flag freeform paragraphs that should be structured lists.
- B4 **Schema Fidelity**: output follows the 5-section blueprint; Section 5 has a worked example if schema is non-trivial.

Return a numbered list. Prefix each item with its gate/benchmark ID. If everything passes, return exactly: "PASS — no gate or benchmark failures."`;

export interface CritiqueInput {
  /** The prompt under review — hardened if `harden` ran, compiled otherwise. */
  prompt: string;
}

export interface CritiqueState {
  critique: string;
  demo_mode: boolean;
}

export function decide(input: CritiqueInput, run_id: string): GenerationRequest {
  return buildRequest(run_id, STAGE_ID, fillTemplate(TEMPLATE, { prompt: input.prompt }));
}

export function reduce(
  input: CritiqueInput,
  outcome: GenerationResult | ProviderFailure,
): CritiqueState {
  // A forged marker is a provider failure, decided before the branch so every stage
  // inherits it through the placeholder path it already has.
  const settled = refuseForgedMarker(outcome);
  const isFailure = "category" in settled;
  return {
    // A degraded critique must never read as PASS_SENTINEL. If it did, refine would take
    // the "nothing failed, return unchanged" branch and the pipeline would report a prompt
    // as reviewed-and-clean that no reviewer ever saw. The placeholder cannot collide with
    // it — it opens with the demo marker — and a test asserts exactly that.
    critique: isFailure
      ? failurePlaceholder(STAGE_ID, input.prompt, settled as ProviderFailure)
      : (settled as GenerationResult).content,
    demo_mode: isFailure,
  };
}

/** Whether the reviewer found nothing. Exact match, per the contract s6 relies on. */
export const isClean = (critique: string): boolean => critique.trim() === PASS_SENTINEL;
