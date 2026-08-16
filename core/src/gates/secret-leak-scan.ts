// Ported from sources/v5/prompt_lint.py (manifest: v5/prompt_lint) — "Gate 8".
// Behavioral parity asserted against sources/v5/fixtures.json.
//
// Verdict is WARN, not FAIL. The source is explicit that a hit means "look here",
// not proof of a leak. GATES_REFERENCE.md documented this as FAIL; that was wrong
// and is corrected. Raising it to FAIL would change lint outcomes for every caller.

import { createHash } from "node:crypto";
import { stripDocumentationSpans } from "../strip-documentation-spans.js";

export interface GateResult {
  gate_id: string;
  gate_version: string;
  verdict: "PASS" | "FAIL" | "WARN";
  message: string;
  message_code: string;
  input_hash: string;
  location: { start: number; end: number } | null;
}

export const GATE_ID = "SECRET_LEAK_SCAN";
export const GATE_VERSION = "1.1.0";

/**
 * Every quantifier below is BOUNDED at both ends, and that is load-bearing rather
 * than stylistic. The source records why: an open-ended `+` or `{n,}` against a long
 * non-matching run makes the scan quadratic — each start position consumes the whole
 * run, then backtracks one character at a time — and a 500 KB prompt took minutes.
 * Real keys and addresses fit inside these caps comfortably.
 *
 * A property test asserts a fixed time budget on large adversarial input. If someone
 * "simplifies" a bound away, that test is what catches it.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{20,128}/, "anthropic_api_key"],
  [/sk-[A-Za-z0-9]{20,128}/, "generic_sk_key"],
  [/AKIA[0-9A-Z]{16}/, "aws_access_key_id"],
  [/ghp_[A-Za-z0-9]{30,128}/, "github_token"],
  [/xox[baprs]-[A-Za-z0-9-]{10,128}/, "slack_token"],
  // PII heuristics — same WARN posture; a hit means "look here", not proof.
  [/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/, "pii_email"],
  [/\+[0-9][0-9 ().-]{8,20}[0-9]/, "pii_phone_intl"],
];

/** Deterministic fingerprint of the gate's input. No clock, no randomness. */
function inputHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface SecretLeakScanOptions {
  /** Lint fenced/backticked content too, rather than treating it as documentation. */
  includeFences?: boolean;
}

/**
 * Scans the compiled prompt's own text for credential and PII shapes.
 *
 * Distinct from GUARDRAIL_GAP's "sanitiz" check, which verifies the prompt *instructs*
 * its target to redact PII. This scans the compiler's own output for a leaked secret.
 *
 * Pure: no I/O, no clock, no randomness.
 */
export function secretLeakScan(
  text: string,
  options: SecretLeakScanOptions = {},
): GateResult {
  const auditText = options.includeFences ? text : stripDocumentationSpans(text);

  const leaked = [
    ...new Set(
      SECRET_PATTERNS.filter(([pattern]) => pattern.test(auditText)).map(
        ([, label]) => label,
      ),
    ),
  ].sort();

  const hash = inputHash(text);

  if (leaked.length === 0) {
    return {
      gate_id: GATE_ID,
      gate_version: GATE_VERSION,
      verdict: "PASS",
      message: "No credential or PII patterns found in the compiled prompt.",
      message_code: "SECRET_LEAK_SCAN.clean",
      input_hash: hash,
      location: null,
    };
  }

  return {
    gate_id: GATE_ID,
    gate_version: GATE_VERSION,
    verdict: "WARN",
    message: `Possible secret or PII in the compiled prompt: ${leaked.join(", ")}. Heuristic — verify before treating as a leak.`,
    message_code: "SECRET_LEAK_SCAN.match",
    input_hash: hash,
    location: null,
  };
}

/** Labels only, for parity testing against the source's `details` list. */
export function secretLeakLabels(
  text: string,
  options: SecretLeakScanOptions = {},
): string[] {
  const auditText = options.includeFences ? text : stripDocumentationSpans(text);
  return [
    ...new Set(
      SECRET_PATTERNS.filter(([p]) => p.test(auditText)).map(([, l]) => l),
    ),
  ].sort();
}
