// Ported from sources/v5/prompt_lint.py — "Gate 7".
// Behavioral parity asserted against sources/v5/fixtures.json.
//
// Verdict is WARN. Documented as FAIL before the severities were read from the
// emission sites; the fixture corpus independently confirms WARN.

import { createHash } from "node:crypto";
import { stripDocumentationSpans } from "../strip-documentation-spans.js";
import type { GateResult } from "../../../contracts/index.js";

export const GATE_ID = "CLAIM_DISCIPLINE";
export const GATE_VERSION = "1.2.0";

/**
 * `\s*` rather than a literal space is load-bearing: the original regex required
 * one, so `100%accurate` passed clean. That is fixture `claim_discipline_no_space`,
 * which exists because the defect shipped.
 */
const OVERCLAIM_RE = /\bguarantee[sd]?\b|\b100%\s*(?:accurate|safe|deterministic)\b/g;

/**
 * A denial of a guarantee is not a guarantee — ADR-0020, and a deliberate divergence from the
 * source, which flags both alike.
 *
 * Measured rather than supposed: on the precision corpus this gate fired 19 times and every one
 * was a refusal ("no guarantees on absolute accuracy", "never state that a process is
 * guaranteed"), giving a 95% interval of 0.0%-17.6% for its firings being real defects. The
 * compile stage's own system prompt orders the model never to claim a guarantee, so the gate
 * was penalising models for obeying the prompt it was checking.
 *
 * The unit is the line, not the document: a disclaimer in one bullet must not launder a claim
 * made in another.
 */
const NEGATION_RE =
  /\b(no|not|never|non|without|avoid\w*|cannot|can't|don't|does not|doesn't|refrain\w*|prohibit\w*|restrict\w*|exclud\w*|instead of|rather than)\b/;

/**
 * The line around `index`. The line, not the sentence, after trying the sentence first.
 *
 * Splitting on full stops broke five of the nineteen corpus cases on punctuation rather than on
 * meaning: `e.g.` severed `"guaranteed refund"` from the `avoid certainty language` that
 * governed it, and a quoted phrase in a banned-phrase list lost the clause that banned it. A
 * compiled prompt is a Markdown list, so the bullet is the unit its author wrote in.
 *
 * The cost is stated rather than hidden: a single line that both asserts and denies a guarantee
 * is excused. No such line occurs in the 1,513 prompts measured, and across lines the gate still
 * fires — `claim-discipline.test.ts` pins that.
 */
function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

const isDenial = (lowered: string, index: number): boolean => NEGATION_RE.test(lineAround(lowered, index));

export interface ClaimDisciplineOptions {
  includeFences?: boolean;
}

/**
 * Flags unhedged claims of guarantee or total accuracy.
 *
 * This is the gate that keeps demo-mode output honest: a placeholder produced
 * without a live model must not assert what a model would have. Pure — no I/O,
 * clock, or randomness.
 */
export function claimDiscipline(
  text: string,
  options: ClaimDisciplineOptions = {},
): GateResult {
  const auditText = options.includeFences ? text : stripDocumentationSpans(text);
  const lowered = auditText.toLowerCase();
  const found = [
    ...new Set(
      [...lowered.matchAll(OVERCLAIM_RE)]
        .filter((m) => !isDenial(lowered, m.index!))
        .map((m) => m[0]),
    ),
  ].sort();
  const input_hash = createHash("sha256").update(text, "utf8").digest("hex");

  if (found.length === 0) {
    return {
      gate_id: GATE_ID,
      gate_version: GATE_VERSION,
      verdict: "PASS",
      message: "No unhedged guarantee or total-accuracy claims found.",
      message_code: "CLAIM_DISCIPLINE.clean",
      input_hash,
      location: null,
    };
  }

  return {
    gate_id: GATE_ID,
    gate_version: GATE_VERSION,
    verdict: "WARN",
    message: `Unhedged claim(s): ${found.join(", ")}. State what was verified instead of asserting a guarantee.`,
    message_code: "CLAIM_DISCIPLINE.overclaim",
    input_hash,
    location: null,
  };
}
