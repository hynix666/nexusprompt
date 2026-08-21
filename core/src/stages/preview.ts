/**
 * The `preview` stage — pure. Frozen s9, "Preview", role `test`.
 *
 * **The only stage that does not send COMPILER_SYSTEM**, and the only one whose system
 * prompt is data rather than a constant: it runs the finished prompt AS the system message
 * with a test input as the user turn. That is the point — it exercises the artifact the
 * pipeline just built, under the conditions it will actually run in. Sending the compiler
 * identity here would be testing the compiler instead of its output.
 *
 * The frozen call site is `callProvider(..., [{role:"user", content:testMessage}], sys, 1400, signal)`
 * where `sys = c.prompt || "You are a helpful assistant."`. The template field is empty
 * because there is nothing to interpolate; `check:stages` compares it against that empty.
 */

import type { GenerationRequest, GenerationResult, ProviderFailure } from "../../../contracts/index.js";
import { buildRequest, demoPlaceholder, MAX_TOKENS } from "./stage-kit.js";

export const STAGE_ID = "preview" as const;

/** Empty, and asserted to be empty — the prompt under test IS the system message. */
export const TEMPLATE = ``;

/**
 * The source's fallback when no prompt has been compiled yet.
 *
 * Kept verbatim rather than refusing, because a preview with no prompt is still a
 * meaningful thing to run — it shows what the test input does against a bare assistant,
 * which is the baseline the compiled prompt is supposed to improve on.
 */
export const NO_PROMPT_SYSTEM = "You are a helpful assistant.";

export interface PreviewInput {
  /** The finished prompt, used as the system message. */
  prompt?: string;
  /** The user turn — a representative message to try the prompt against. */
  testMessage: string;
}

export interface PreviewState {
  reply: string;
  demo_mode: boolean;
  /** True when the preview ran against the bare fallback rather than a compiled prompt. */
  used_fallback: boolean;
}

export function decide(input: PreviewInput, run_id: string): GenerationRequest {
  return buildRequest(run_id, STAGE_ID, input.testMessage, {
    system: input.prompt || NO_PROMPT_SYSTEM,
    max_tokens: MAX_TOKENS.preview,
  });
}

export function reduce(
  input: PreviewInput,
  outcome: GenerationResult | ProviderFailure,
): PreviewState {
  const isFailure = "category" in outcome;
  return {
    reply: isFailure
      ? demoPlaceholder(STAGE_ID, input.testMessage, outcome as ProviderFailure)
      : (outcome as GenerationResult).content,
    demo_mode: isFailure,
    used_fallback: !input.prompt,
  };
}
