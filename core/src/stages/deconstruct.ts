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
import { fillTemplate, buildRequest, failurePlaceholder, refuseForgedMarker } from "./stage-kit.js";

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

/**
 * The literal text surrounding `{brief}` in TEMPLATE, split from TEMPLATE itself.
 *
 * Derived, never transcribed. A hand-copied delimiter pair is a second copy of the template's
 * wording that nothing compares against the first, and the two would drift the first time the
 * template's prose changed — silently, because the failure is "the brief no longer extracts",
 * which looks like a missing artifact rather than a stale constant.
 */
const BRIEF_PARTS = TEMPLATE.split("{brief}");
const [BRIEF_PREFIX, BRIEF_SUFFIX] = BRIEF_PARTS;

/**
 * Exactly one `{brief}` slot, or the inversion below is not one.
 *
 * `fillTemplate`'s replace is GLOBAL, so a template naming the slot twice renders the brief
 * twice, and there is no longer a single span to slice back out — the length arithmetic would
 * return the first copy plus the template prose between the two, and call it the brief. Two
 * parts is the condition under which `extractBrief` is an inverse at all; anything else and it
 * must say it cannot invert rather than return the plausible-looking wrong answer.
 */
const BRIEF_SLOT_IS_INVERTIBLE = BRIEF_PARTS.length === 2;

/**
 * Recover the ORIGINAL BRIEF from a rendered `deconstruct` user turn.
 *
 * A run does not retain its brief as a bare artifact anywhere: `application/src/pipeline.ts`
 * retains each stage's input as the rendered provider request, so the only place the brief
 * survives in a completed bundle is interpolated into this stage's template. This is the
 * inverse of `decide`'s `fillTemplate(TEMPLATE, { brief })` and the only honest way to read a
 * finished run's brief back out.
 *
 * Null rather than a guess when the text is not a rendered deconstruct turn. Whatever a
 * loose parse returned would be graded as though it were the run's real input, and a fidelity
 * score against a brief the run never saw is worse than no score at all — the caller's job is
 * to refuse, not to substitute.
 *
 * Safe against a brief that contains the delimiters itself: the slice is taken by LENGTH from
 * each end, never by searching for the marker, so a brief quoting "Extract and output, as
 * labeled sections:" round-trips unharmed.
 */
export function extractBrief(renderedUserTurn: string): string | null {
  // The template stopped naming `{brief}` exactly once: there is no single slot to invert.
  if (!BRIEF_SLOT_IS_INVERTIBLE) return null;
  if (!renderedUserTurn.startsWith(BRIEF_PREFIX)) return null;
  if (!renderedUserTurn.endsWith(BRIEF_SUFFIX)) return null;
  const end = renderedUserTurn.length - BRIEF_SUFFIX.length;
  // Prefix and suffix overlapping means the text is shorter than the template's own fixed
  // parts, so it cannot be a rendering of it.
  if (end < BRIEF_PREFIX.length) return null;
  return renderedUserTurn.slice(BRIEF_PREFIX.length, end);
}

export function reduce(
  input: DeconstructInput,
  outcome: GenerationResult | ProviderFailure,
): DeconstructState {
  // A forged marker is a provider failure, decided before the branch so every stage
  // inherits it through the placeholder path it already has.
  const settled = refuseForgedMarker(outcome);
  const isFailure = "category" in settled;
  return {
    spec: isFailure
      ? failurePlaceholder(STAGE_ID, input.brief, settled as ProviderFailure)
      : (settled as GenerationResult).content,
    demo_mode: isFailure,
  };
}
