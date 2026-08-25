// Ported from sources/v5/prompt_lint.py — the helpers several gates share.
// See sources/MANIFEST.json for the frozen source hash.
//
// These live in one module because the gates that use them must agree exactly. When
// `extract_source_ledger_ids` and the citation regex drifted apart in the source, a
// citation inside an empty ledger section silenced BOTH citation gates and the artifact
// passed. Keeping the primitives together is what makes that interaction testable.

import { createHash } from "node:crypto";
import type { GateResult } from "../../../contracts/index.js";

/** Every option any gate may read. Gates ignore what they do not use. */
export interface GateOptions {
  includeFences?: boolean;
  safetyTier?: boolean;
  recursiveTarget?: boolean;
  ragTarget?: boolean;
  tokenBudget?: number;
  stakes?: string;
  naiveTokens?: number;
  provider?: string;
  adversarial?: boolean;
  /**
   * Injected, never read. Core performs no I/O, so the composition root supplies the
   * corpus. Armed without one, the gate reports that it could not score — which is also
   * the only thing the frozen linter can do, since it cannot locate its own scorer.
   */
  adversarialCorpus?: { defense_signals: Record<string, unknown>; cases: Array<{ id: string; surface: string }> };
  adversarialFloor?: number;
}

export const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** Build a GateResult without repeating the shape thirteen times. */
export function result(
  gate_id: string,
  gate_version: string,
  verdict: GateResult["verdict"],
  message: string,
  message_code: string,
  input_hash: string,
): GateResult {
  return { gate_id, gate_version, verdict, message, message_code, input_hash, location: null };
}

/**
 * Deterministic ~4 chars/token — `max(1, len // 4)`.
 *
 * The source records why there is no tokenizer import: an ambient `try: import tiktoken`
 * made TOKEN_BUDGET, QUTM_CEILING and CONTEXT_LIMIT depend on what happened to be
 * installed, so the differential oracle would report a disagreement caused by the
 * environment rather than the code. chars/4 is the contract all implementations share.
 * If exact tokenisation is ever wanted it arrives as an explicit option, never an import.
 */
export const estimateTokens = (text: string): number => Math.max(1, Math.floor(text.length / 4));

/**
 * Half-up rounding to two places, as `floor(x*100 + 0.5)/100`.
 *
 * NOT `Math.round`, and not Python's `round`. Python's is banker's rounding and diverges
 * from JS at .005 boundaries — est=1 / baseline=200 gives 0.0 one side and 0.01 the other.
 * The source uses this explicit form precisely so the two agree, and the port must too.
 * No amount of parity testing surfaces a divergence here, because each side is internally
 * consistent; only the oracle sees it.
 */
export const halfUp2 = (x: number): number => Math.floor(x * 100 + 0.5) / 100;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Left-anchored word-boundary clause match.
 *
 * `\bscope` rejects "telescope" and accepts "scope:" and "scoped". The right edge stays
 * free so a stem like "sanitiz" still matches its inflections. The unanchored `clause in
 * low` this replaced counted a clause as present inside any unrelated word — a false-clean
 * on a safety gate, which is the worst direction for one to fail in.
 */
export const clausePresent = (clause: string, low: string): boolean =>
  new RegExp(`\\b${escapeRegExp(clause)}`).test(low);

/**
 * Runtime Variables must be declared in a manifest section. Read from RAW text, not audit text.
 *
 * DIVERGES FROM THE SOURCE — declared in scripts/divergence-allowlist.json, ADR-0010.
 *
 * The source is `#+\s*Runtime Variables.*?(?=\n#|\Z)`, which carries two defects that
 * cancel into something worse than either alone:
 *
 *   1. `#+` requires a Markdown hash. The v5 framework's own BLUEPRINT emits the line as
 *      bare prose, so the manifest was invisible and EVERY correctly declared key read as
 *      undeclared — a gate no compliant prompt could pass.
 *   2. `(?=\n#|\Z)` terminates only on a heading or EOF. The layout that framework
 *      prescribes uses `BLOCK I`/`BLOCK III` markers, not headings, so in the intended
 *      shape the span runs to the end of the document and every `[[KEY]]` used ANYWHERE
 *      reads as declared. The gate returns PASS on undeclared keys.
 *
 * Together: writing the heading the way the source demands is what disables the gate.
 * Writing it the way the framework demands is what makes the gate fire on everything.
 * The false-clean is the one that matters — it is a security-adjacent check reporting
 * that it looked when it did not.
 *
 * The fix is the discipline `extractSourceLedgerIds` already carries, applied here for
 * the same reason. There, scanning a section for any `[Sn]` let a citation inside the
 * section declare ITSELF, silencing both citation gates at once. This is that defect
 * with different brackets: a section bounded only by EOF lets a USE declare itself.
 *
 * So a manifest is the heading plus the run of declaration lines beneath it, and it ends
 * at the first line of prose that declares nothing. A declaration line opens with its key
 * (optionally bulleted); `1. Read [[PLAYER_TIER]] and branch.` is a use, not a
 * declaration, and ends the section rather than extending it.
 */
const MANIFEST_HEADING_RE = /^\s*#*\s*Runtime Variables\b/i;
const DECLARATION_LINE_RE = /^\s*(?:[-*+]\s*)?\[\[[A-Za-z0-9_:-]+\]\]/;
const FENCE_LINE_RE = /^\s*```/;
const RUNTIME_KEY_G = /\[\[([A-Za-z0-9_:-]+)\]\]/g;

export function extractRuntimeManifest(text: string): Set<string> {
  const declared = new Set<string>();
  const lines = text.split("\n");

  // Every heading, not just the first: a document may carry more than one manifest, and
  // binding to the first match would let a passing prose mention shadow the real section.
  for (let h = 0; h < lines.length; h++) {
    if (!MANIFEST_HEADING_RE.test(lines[h])) continue;
    for (let i = h + 1; i < lines.length; i++) {
      const line = lines[i];
      // Blank lines and fence delimiters do not end a manifest. The fence case is load-
      // bearing: this function reads RAW text precisely so a manifest inside a fence still
      // declares, and treating ``` as prose would undo that on the first fenced manifest.
      if (line.trim() === "" || FENCE_LINE_RE.test(line)) continue;
      if (!DECLARATION_LINE_RE.test(line)) break;
      for (const k of line.matchAll(RUNTIME_KEY_G)) declared.add(k[1]);
    }
  }
  return declared;
}

/**
 * S-ids DECLARED in a source ledger. Only table rows count.
 *
 * Scanning the section for any `[Sn]` let a citation inside the ledger section declare
 * itself: a heading with no entries followed by prose citations silenced this gate and
 * ORPHAN_CLAIMS together, and the artifact passed. That defect was found by the
 * differential harness against an independent implementation — both v5 copies shared it,
 * so parity was blind. It is the reason ADR-0007 exists, and it must not be reintroduced.
 */
export function extractSourceLedgerIds(text: string): Set<string> {
  const ids = new Set<string>();
  const section = text.match(/#+\s*Source ledger[\s\S]*?(?=\n#|$)/i);
  const scope = section ? section[0] : "";
  for (const m of scope.matchAll(/^\s*\|\s*\[S(\d+)\]/gm)) ids.add(m[1]);
  if (ids.size === 0) {
    // Fallback: table rows anywhere, ledger section or not.
    for (const m of text.matchAll(/^\s*\|\s*\[S(\d+)\]/gm)) ids.add(m[1]);
  }
  return ids;
}

/**
 * A citation is a bracketed, comma-separated list of S-ids.
 *
 * The predecessor `\[S(\d+)(?:,[^\]]*)?\]` captured only the first id and swallowed the
 * rest, so `[S1,S2]` silently left S2 uncited — another defect both v5 copies shared.
 * This shape matches `[S1]`, `[S1,S2]`, `[S1, S2,S3]` and nothing else, so prose like
 * `[S1, p. 42]` does not leak a page number as a source id.
 */
export const CITATION_RE = /\[S\d+(?:\s*,\s*S?\d+)*\]/g;

/** Every numeric id cited anywhere in the text. */
export function extractCitedIds(auditText: string): Set<string> {
  const cited = new Set<string>();
  for (const m of auditText.matchAll(CITATION_RE)) {
    for (const d of m[0].matchAll(/\d+/g)) cited.add(d[0]);
  }
  return cited;
}

/** Numeric sort. `sorted()` on these strings is lexicographic — "10" before "2". */
export const byNumber = (a: string, b: string): number => Number(a) - Number(b);

export const REQUIRED_GUARDRAIL_CLAUSES = ["anti-override", "scope", "fact-grounding"] as const;
export const SAFETY_TIER_EXTRA_CLAUSES = ["sanitiz", "recursion", "conflict", "bias"] as const;
export const RECURSION_MACHINERY_TOKENS = [
  "[MEM_STATE]", "[ACTIVE_MEM_STATE]", "compilation depth",
  "{{COMPILATION_DEPTH}}", "{{STAKES_LEVEL}}", "meta-compiler",
] as const;
export const RAG_SHIELD_CLAUSES = ["insufficient_retrieval", "rejected_context"] as const;
export const TOKEN_SPAM_TAGS = ["[ACK]", "[EXEC]", "[CLI]", "[MEM_STATE]"] as const;

export const QUTM_CEILINGS: Record<string, number> = {
  "safety-critical": 12.0, high: 6.0, guarded: 4.0, medium: 2.5, low: 1.2,
};

/**
 * Below this baseline the cost ratio carries no signal, so QUTM_CEILING does not arm.
 *
 * DIVERGES FROM THE SOURCE — declared in scripts/divergence-allowlist.json, ADR-0011.
 *
 * A compiled system prompt is necessarily many times longer than the one-line brief it
 * came from, and the ratio divides one by the other. The source applies the ceiling at
 * any baseline, so a correct 900-token prompt scores 900× against a one-line brief and
 * 7.5× against a 120-token one — unpassable at every tier including safety-critical's
 * 12×. The gate was measuring the brief's brevity, not the prompt's bloat.
 *
 * A named constant rather than an inline number, deliberately: a threshold spelled into
 * the comparison is a guard whose scope nothing can state, which is how a check ends up
 * narrower than its name.
 */
export const QUTM_MIN_BASELINE_TOKENS = 120;

export const PROVIDER_CONTEXT_LIMITS: Record<string, number> = {
  anthropic: 200_000, openai: 128_000, google: 1_048_576, ollama: 128_000,
};
