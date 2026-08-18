// Ported from sources/v5/prompt_lint.py — "Gates 2, 4, 5, 5b, 7b, 9".
//
// The text-shape gates: each is a substring or structural check over the audit text with
// no arithmetic and no external state. They share this module because they share nothing
// else — grouping them keeps twelve near-identical files from existing.

import { stripDocumentationSpans } from "../strip-documentation-spans.js";
import {
  type GateOptions, sha256, result, clausePresent,
  REQUIRED_GUARDRAIL_CLAUSES, SAFETY_TIER_EXTRA_CLAUSES, RECURSION_MACHINERY_TOKENS,
  RAG_SHIELD_CLAUSES, TOKEN_SPAM_TAGS,
} from "./lint-primitives.js";
import type { GateResult } from "../../../contracts/index.js";

export const GATE_VERSION = "1.0.0";
export const GUARDRAIL_GATE_ID = "GUARDRAIL_GAP";
export const TOKEN_SPAM_GATE_ID = "TOKEN_SPAM";
export const RECURSION_GATE_ID = "RECURSION_MACHINERY_PRESENT";
export const RAG_SHIELD_GATE_ID = "RAG_SHIELD_GAP";
export const DUPLICATE_GATE_ID = "DUPLICATE_INSTRUCTION";
export const DELIMITER_GATE_ID = "DELIMITER_ENTROPY";

const audit = (text: string, o: GateOptions) =>
  o.includeFences ? text : stripDocumentationSpans(text);

/**
 * Required guardrail clauses must be present. Severity depends on the tier.
 *
 * WARN by default, FAIL when the caller asserts a safety tier — and the safety tier also
 * adds four more clauses. Note this is a *presence* proxy: it verifies the compiled prompt
 * mentions the clause, never that the clause is correctly applied. A gate that cannot see
 * semantics should not be read as if it can.
 */
export function guardrailGap(text: string, options: GateOptions = {}): GateResult {
  const hash = sha256(text);
  const low = audit(text, options).toLowerCase();
  const missing = [
    ...REQUIRED_GUARDRAIL_CLAUSES.filter((c) => !clausePresent(c, low)),
    ...(options.safetyTier ? SAFETY_TIER_EXTRA_CLAUSES.filter((c) => !clausePresent(c, low)) : []),
  ];

  if (missing.length === 0) {
    return result(GUARDRAIL_GATE_ID, GATE_VERSION, "PASS",
      "Every required guardrail clause is present.", "GUARDRAIL_GAP.clean", hash);
  }
  return result(GUARDRAIL_GATE_ID, GATE_VERSION, options.safetyTier ? "FAIL" : "WARN",
    `Missing guardrail clause(s): ${missing.join(", ")}.`, "GUARDRAIL_GAP.missing", hash);
}

/**
 * Bracket-token spam. Counted on the audit text, not raw.
 *
 * Counting raw would let a tag documented once in prose blanket-exempt genuine spam
 * elsewhere. The threshold is "more than 8", not "at least 8".
 */
export function tokenSpam(text: string, options: GateOptions = {}): GateResult {
  const hash = sha256(text);
  const auditText = audit(text, options);
  const dup = TOKEN_SPAM_TAGS.filter((t) => auditText.split(t).length - 1 > 8);

  if (dup.length === 0) {
    return result(TOKEN_SPAM_GATE_ID, GATE_VERSION, "PASS",
      "No bracket tag is over-repeated.", "TOKEN_SPAM.clean", hash);
  }
  return result(TOKEN_SPAM_GATE_ID, GATE_VERSION, "WARN",
    `Over-repeated tag(s): ${dup.join(", ")}.`, "TOKEN_SPAM.repeated", hash);
}

/**
 * Recursion machinery must be stripped from a recursive target, not renamed.
 *
 * Opt-in: a non-recursive target legitimately mentions these tokens, so firing by default
 * would be a false positive on every ordinary prompt.
 */
export function recursionMachineryPresent(text: string, options: GateOptions = {}): GateResult {
  const hash = sha256(text);
  if (!options.recursiveTarget) {
    return result(RECURSION_GATE_ID, GATE_VERSION, "PASS",
      "Not a recursive target; check not armed.", "RECURSION_MACHINERY_PRESENT.not_armed", hash);
  }
  const low = audit(text, options).toLowerCase();
  const present = RECURSION_MACHINERY_TOKENS.filter((t) => low.includes(t.toLowerCase()));

  if (present.length === 0) {
    return result(RECURSION_GATE_ID, GATE_VERSION, "PASS",
      "No recursion machinery left in a recursive target.", "RECURSION_MACHINERY_PRESENT.clean", hash);
  }
  return result(RECURSION_GATE_ID, GATE_VERSION, "FAIL",
    `Recursion machinery present: ${present.join(", ")}.`, "RECURSION_MACHINERY_PRESENT.present", hash);
}

/**
 * A RAG target should name at least one RAG Shield acknowledgment token.
 *
 * Fires only when ALL tokens are absent — one present is treated as the shield language
 * being there. Plain substring, not word-boundary: these are underscored identifiers,
 * and `\b` before `insufficient_retrieval` would behave differently than the source.
 */
export function ragShieldGap(text: string, options: GateOptions = {}): GateResult {
  const hash = sha256(text);
  if (!options.ragTarget) {
    return result(RAG_SHIELD_GATE_ID, GATE_VERSION, "PASS",
      "Not a RAG target; check not armed.", "RAG_SHIELD_GAP.not_armed", hash);
  }
  const low = audit(text, options).toLowerCase();
  const missing = RAG_SHIELD_CLAUSES.filter((c) => !low.includes(c));

  if (missing.length < RAG_SHIELD_CLAUSES.length) {
    return result(RAG_SHIELD_GATE_ID, GATE_VERSION, "PASS",
      "A RAG Shield acknowledgment token is present.", "RAG_SHIELD_GAP.clean", hash);
  }
  return result(RAG_SHIELD_GATE_ID, GATE_VERSION, "FAIL",
    `No RAG Shield acknowledgment token found (expected one of: ${RAG_SHIELD_CLAUSES.join(", ")}).`,
    "RAG_SHIELD_GAP.absent", hash);
}

/**
 * A whitespace-normalised paragraph appearing twice verbatim is usually a double-paste.
 *
 * The 60-character floor exempts repeated bullets and dividers, which are ordinary
 * document structure. This targets substantive instruction blocks, where a duplicate
 * wastes tokens now and becomes a contradiction the moment only one copy is edited.
 */
export function duplicateInstruction(text: string, options: GateOptions = {}): GateResult {
  const hash = sha256(text);
  const counts = new Map<string, number>();
  for (const para of audit(text, options).split(/\n\s*\n/)) {
    const normalized = para.replace(/\s+/g, " ").trim();
    if (normalized.length < 60) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  const dup = [...counts.entries()].filter(([, n]) => n > 1);

  if (dup.length === 0) {
    return result(DUPLICATE_GATE_ID, GATE_VERSION, "PASS",
      "No instruction block is duplicated.", "DUPLICATE_INSTRUCTION.clean", hash);
  }
  const details = dup.map(([p, n]) => `${n}× — ${p.length <= 96 ? p : p.slice(0, 93) + "…"}`);
  return result(DUPLICATE_GATE_ID, GATE_VERSION, "WARN",
    `Duplicated instruction block(s): ${details.join(" | ")}.`, "DUPLICATE_INSTRUCTION.duplicated", hash);
}

/** `[INPUT_START_*]` delimiters must carry at least 32 hex chars — 128 bits. */
const DELIMITER_RE = /\[INPUT_(?:START|END)_([0-9a-fA-F]+)\]/g;

/**
 * Anti-override delimiters need real entropy. A 6-hex example is brute-forceable.
 *
 * Scanned on the audit text like every other gate. An earlier version fell back to raw
 * text whenever a "Data Isolation" heading appeared, on the theory that the nonce might
 * hide in a schema fence — but the delivered nonce is prose in the live body, never
 * fenced, so the fallback bought nothing and reopened the false-positive hole that fence
 * stripping exists to close: a compliant prompt illustrating the deprecated short form as
 * a counter-example would have scanned as a FAIL.
 */
export function delimiterEntropy(text: string, options: GateOptions = {}): GateResult {
  const hash = sha256(text);
  const weak = [...new Set(
    [...audit(text, options).matchAll(DELIMITER_RE)].map((m) => m[1]).filter((h) => h.length < 32),
  )].sort();

  if (weak.length === 0) {
    return result(DELIMITER_GATE_ID, GATE_VERSION, "PASS",
      "No under-entropy isolation delimiter.", "DELIMITER_ENTROPY.clean", hash);
  }
  return result(DELIMITER_GATE_ID, GATE_VERSION, "FAIL",
    `Weak delimiter(s): ${weak.map((w) => `${w} (${w.length} hex chars < 32 minimum)`).join(", ")}.`,
    "DELIMITER_ENTROPY.weak", hash);
}
