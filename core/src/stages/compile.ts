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
 * Prompt template ported from sources/pipeline/SystemPromptBuilderPipeline.tsx
 * (DEFAULT_STAGES, s3 "Compile").
 */

import { createHash } from "node:crypto";
import type {
  GenerationRequest,
  GenerationResult,
  ProviderFailure,
  GateResult,
} from "../../../contracts/index.js";
import { runGates } from "../gates/registry.js";

export const STAGE_ID = "compile" as const;

/** The marker. Not a string literal scattered through the codebase — one definition. */
export const DEMO_MARKER = "⟦WORKFLOW DEMO — no model⟧";

const TEMPLATE = `STEP 3 — COMPILATION.

SPEC:
{previous}

Compile the specification above into a complete system prompt. Emit the prompt itself and nothing else: no preamble, no commentary on your choices, no trailing summary.

Include, in this order: role and objective; scope boundaries; the named edge cases and how to handle each; output format; and the runtime variables the prompt expects, each declared before use.`;

export interface CompileInput {
  brief: string;
  previous?: string;
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
  const prompt = TEMPLATE.replace("{previous}", input.previous ?? input.brief);
  const request_id = createHash("sha256")
    .update(`${run_id}:${STAGE_ID}:${prompt}`, "utf8")
    .digest("hex")
    .slice(0, 32);

  return {
    request_id,
    run_id,
    messages: [{ role: "user", content: prompt }],
    model_policy: { preferred_models: ["claude-opus-5"], allow_fallback: true },
    generation_options: { max_tokens: 8000, effort: "medium" },
    idempotency_key: request_id,
  };
}

/**
 * Fold an already-classified outcome into the next state.
 *
 * The failure branch is deterministic by construction: same category in, same
 * placeholder out. Nothing here inspects a network, a clock, or an exception.
 */
export function reduce(
  input: CompileInput,
  outcome: GenerationResult | ProviderFailure,
): ReducedState {
  const isFailure = "category" in outcome;

  const text = isFailure
    ? demoPlaceholder(input, outcome as ProviderFailure)
    : (outcome as GenerationResult).content;

  return {
    output: { text },
    gate_results: runGates(text),
    demo_mode: isFailure,
  };
}

/**
 * The honesty guarantee, as a pure function.
 *
 * It states what was attempted, why it did not happen, and what the reader is
 * looking at — and it deliberately contains no compiled prompt. Producing
 * plausible output here would be indistinguishable from the real thing, which is
 * the entire failure this mechanism exists to prevent.
 *
 * The text is also written to pass CLAIM_DISCIPLINE: no guarantee, no claim of
 * accuracy. The acceptance test asserts exactly that.
 */
function demoPlaceholder(input: CompileInput, failure: ProviderFailure): string {
  return [
    DEMO_MARKER,
    "",
    `Stage "${STAGE_ID}" did not run against a model.`,
    `Provider: ${failure.provider_id} · category: ${failure.category} · reason: ${failure.reason_code}`,
    `Detail: ${failure.safe_message}`,
    "",
    "No compiled prompt was produced. The text you are reading is a placeholder,",
    "not model output, and nothing below it was generated.",
    "",
    // The echo is fenced deliberately. Gates strip fenced spans before auditing,
    // which is exactly the distinction needed here: quoted input is data, not a
    // claim this placeholder is making. Without the fence, a brief containing
    // "100% accurate" makes CLAIM_DISCIPLINE warn about the *input's* overclaim
    // as though the demo output had asserted it — observed while running the CLI.
    "Input received:",
    "```",
    truncate(input.previous ?? input.brief, 160),
    "```",
  ].join("\n");
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}
