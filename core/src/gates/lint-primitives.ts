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

/** Runtime Variables must be declared in a manifest section. Read from RAW text, not audit text. */
export function extractRuntimeManifest(text: string): Set<string> {
  const declared = new Set<string>();
  const m = text.match(/#+\s*Runtime Variables[\s\S]*?(?=\n#|$)/i);
  if (m) for (const k of m[0].matchAll(/\[\[([A-Za-z0-9_:-]+)\]\]/g)) declared.add(k[1]);
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

export const PROVIDER_CONTEXT_LIMITS: Record<string, number> = {
  anthropic: 200_000, openai: 128_000, google: 1_048_576, ollama: 128_000,
};
