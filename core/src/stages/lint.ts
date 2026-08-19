/**
 * The `lint` stage — pure. Frozen s7, "Lint", role `lint`.
 *
 * **This stage has no `decide`, and that is the design, not an omission.**
 *
 * ADR-0005 splits a stage into `decide → invoke → reduce` because Core must not perform
 * the effect a stage needs. A stage that needs no effect needs no split: forcing one here
 * would produce a `decide()` returning a `GenerationRequest` that nothing should ever
 * execute, and an Application obliged to notice it must not execute it. The frozen
 * component says the same thing in its own terms — s7's template is empty, commented
 * "deterministic — Annex D gates run in-browser, no API call, not editable".
 *
 * So the shape is `run(input) -> state`. A pure function, no request, no outcome to reduce.
 *
 * **It runs the real gate set, not the browser's.** The frozen component carries a reduced
 * JS reimplementation of the linter with a handful of gates inline; this calls the ported
 * registry — sixteen gates, each verified against the frozen Python linter across 2,720
 * differential verdicts. Porting the browser's subset would have been faithful to the wrong
 * artifact, and Phase 2 exists precisely so this stage can use the verified set.
 *
 * The status rule and report format ARE ported from the frozen component.
 */

import { runGates, type GateOptions } from "../gates/registry.js";
import { estimateTokens } from "../gates/lint-primitives.js";
import type { GateResult } from "../../../contracts/index.js";

export const STAGE_ID = "lint" as const;

/**
 * Empty, and asserted to be empty.
 *
 * Not dead code: `check:stages` compares this against the frozen s7 template, which is also
 * empty. Omitting it would make the checker skip this stage silently; declaring it turns
 * "this stage sends nothing" into a claim the build verifies, so a future drop that gives
 * s7 a real template fails rather than being quietly ignored.
 */
export const TEMPLATE = ``;

/** `GATE_FAIL` on any FAIL, `DEGRADED` on any other finding, `PASS` only when silent. */
export type LintStatus = "PASS" | "DEGRADED" | "GATE_FAIL";

export interface LintInput {
  /** The compiled prompt. Absent means the build stages have not run. */
  prompt?: string;
  options?: GateOptions;
}

export interface LintState {
  status: LintStatus | null;
  report: string;
  gate_results: GateResult[];
  token_estimate: number;
}

/** The source's exact wording when there is nothing to lint. */
export const NO_PROMPT = "⚠ No compiled prompt to lint yet — run the build stages first.";

/**
 * Derive the run status from the gate verdicts.
 *
 * Order matters: a FAIL outranks a WARN, and any finding at all outranks silence. `PASS`
 * means every gate ran and none of them said anything — it is not a default for "nothing
 * was checked", which is why an empty gate set does not reach here.
 */
export function statusOf(results: readonly GateResult[]): LintStatus {
  if (results.some((r) => r.verdict === "FAIL")) return "GATE_FAIL";
  if (results.some((r) => r.verdict !== "PASS")) return "DEGRADED";
  return "PASS";
}

/** Ported from `formatLint`: a status line, then one line per finding. */
export function formatReport(
  status: LintStatus,
  est: number,
  results: readonly GateResult[],
  flags: string,
): string {
  const findings = results.filter((r) => r.verdict !== "PASS");
  const head = `[${status}] token_estimate=${est}${flags ? `  ·  ${flags}` : ""}`;
  const body = findings.length
    ? findings.map((f) => `  ${f.verdict.padEnd(4)} ${f.gate_id}: ${f.message}`).join("\n")
    : "  all gates green — zero findings";
  return `${head}\n${body}`;
}

/** The armed-check annotations the source prints beside the status. */
function flagsFor(options: GateOptions): string {
  return [
    options.recursiveTarget && "[recursive-target: RECURSION_MACHINERY_PRESENT armed]",
    options.safetyTier && "[safety-tier: GUARDRAIL_GAP → FAIL]",
    options.ragTarget && "[rag-target: RAG_SHIELD_GAP armed]",
    options.adversarial && "[adversarial: ADVERSARIAL_RESILIENCE armed]",
  ].filter(Boolean).join(" ");
}

/**
 * Run the gates over the compiled prompt.
 *
 * No prompt is not a passing lint. `status` is null rather than `PASS`, because a stage
 * that had nothing to check has not checked anything — reporting PASS there would let an
 * unbuilt pipeline read as a clean one, which is the same failure demo mode exists to
 * prevent one layer up.
 */
export function run(input: LintInput): LintState {
  if (!input.prompt) {
    return { status: null, report: NO_PROMPT, gate_results: [], token_estimate: 0 };
  }
  const options = input.options ?? {};
  const gate_results = runGates(input.prompt, options);
  const status = statusOf(gate_results);
  const token_estimate = estimateTokens(input.prompt);
  return {
    status,
    report: formatReport(status, token_estimate, gate_results, flagsFor(options)),
    gate_results,
    token_estimate,
  };
}
