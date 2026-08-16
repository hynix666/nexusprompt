// Ported from sources/v5/prompt_lint.py — "Gate 7".
// Behavioral parity asserted against sources/v5/fixtures.json.
//
// Verdict is WARN. Documented as FAIL before the severities were read from the
// emission sites; the fixture corpus independently confirms WARN.

import { createHash } from "node:crypto";
import { stripDocumentationSpans } from "../strip-documentation-spans.js";
import type { GateResult } from "../../../contracts/index.js";

export const GATE_ID = "CLAIM_DISCIPLINE";
export const GATE_VERSION = "1.1.0";

/**
 * `\s*` rather than a literal space is load-bearing: the original regex required
 * one, so `100%accurate` passed clean. That is fixture `claim_discipline_no_space`,
 * which exists because the defect shipped.
 */
const OVERCLAIM_RE = /\bguarantee[sd]?\b|\b100%\s*(?:accurate|safe|deterministic)\b/g;

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
  const found = [...new Set([...auditText.toLowerCase().matchAll(OVERCLAIM_RE)].map((m) => m[0]))].sort();
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
