// Ported from sources/v5/prompt_lint.py — "Gate 1".
//
// Two gate ids from one source gate, kept in one module because they share the
// placeholder vocabulary: `<<...>>` is never allowed to survive compilation, `[[...]]`
// is allowed only when declared. Splitting them would let the two notions of
// "placeholder" drift.

import { stripDocumentationSpans } from "../strip-documentation-spans.js";
import {
  type GateOptions, sha256, result, extractRuntimeManifest,
} from "./lint-primitives.js";
import type { GateResult } from "../../../contracts/index.js";

export const PLACEHOLDER_GATE_ID = "PLACEHOLDER_AUDIT";
export const RUNTIME_KEY_GATE_ID = "RUNTIME_KEY_UNDECLARED";
export const PLACEHOLDER_GATE_VERSION = "1.0.0";
/** 1.1.0 — ADR-0010 rewrote the manifest section. Behaviour changed; version moves. */
export const RUNTIME_KEY_GATE_VERSION = "1.1.0";

/** `<<...>>` with no nested angle brackets, so `<<a>> <<b>>` is two findings, not one. */
const UNFILLED_RE = /<<[^<>]+>>/g;
const RUNTIME_KEY_RE = /\[\[([A-Za-z0-9_:-]+)\]\]/g;

/** An unfilled `<<slot>>` reaching a compiled prompt is a template that never rendered. */
export function placeholderAudit(text: string, options: GateOptions = {}): GateResult {
  const auditText = options.includeFences ? text : stripDocumentationSpans(text);
  const hash = sha256(text);
  const unfilled = [...new Set([...auditText.matchAll(UNFILLED_RE)].map((m) => m[0]))].sort();

  if (unfilled.length === 0) {
    return result(PLACEHOLDER_GATE_ID, PLACEHOLDER_GATE_VERSION, "PASS",
      "No unfilled << >> placeholders.", "PLACEHOLDER_AUDIT.clean", hash);
  }
  return result(PLACEHOLDER_GATE_ID, PLACEHOLDER_GATE_VERSION, "FAIL",
    `Unfilled placeholder(s): ${unfilled.join(", ")}. The template did not render.`,
    "PLACEHOLDER_AUDIT.unfilled", hash);
}

/**
 * A `[[KEY]]` used in the body must be declared in a Runtime Variables manifest.
 *
 * The manifest is read from the RAW text while usage is read from the audit text. That
 * asymmetry is deliberate and inherited: a manifest inside a fence still declares, but a
 * key merely *illustrated* inside a fence does not count as used. Reading both from the
 * same text would either lose real declarations or invent uses.
 */
export function runtimeKeyUndeclared(text: string, options: GateOptions = {}): GateResult {
  const auditText = options.includeFences ? text : stripDocumentationSpans(text);
  const hash = sha256(text);
  const declared = extractRuntimeManifest(text);
  const used = new Set([...auditText.matchAll(RUNTIME_KEY_RE)].map((m) => m[1]));
  const undeclared = [...used].filter((k) => !declared.has(k)).sort();

  if (undeclared.length === 0) {
    return result(RUNTIME_KEY_GATE_ID, RUNTIME_KEY_GATE_VERSION, "PASS",
      "Every runtime key used is declared.", "RUNTIME_KEY_UNDECLARED.clean", hash);
  }
  return result(RUNTIME_KEY_GATE_ID, RUNTIME_KEY_GATE_VERSION, "FAIL",
    `Undeclared runtime key(s): ${undeclared.join(", ")}. Declare them under a Runtime Variables heading.`,
    "RUNTIME_KEY_UNDECLARED.undeclared", hash);
}
