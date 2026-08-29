/**
 * JSON_SCHEMA_MALFORMED — ported from SPB `pipelineLogic.ts:1191–1206, 1338–1343`
 * (SystemPromptBuilderPipeline.tsx v6.2.8, AUDIT.md finding B2).
 *
 * PLACEMENT / INTEGRATION NOTES — read before merging:
 *  - Path assumed: core/src/gates/. Per 01-architecture.md the Core layer's gates
 *    live under core/src/gates/, but the exact file layout was not confirmed
 *    against source (this session had no repo access) — adjust if it differs.
 *  - `GateResult`'s `verdict: "PASS" | "WARN" | "FAIL"` is confirmed by
 *    04-business-logic.md ("Pure functions of (text, options) → GateResult with
 *    verdict PASS | WARN | FAIL"). The `gate` and `details` field names below are
 *    NOT independently confirmed — they're modeled on SPB's finding shape by
 *    analogy. Reconcile this interface against contracts/gate-result/ and delete
 *    the local type below in favor of the real generated binding.
 *  - No dependency on any other gate or on NexusPrompt internals beyond the
 *    GateResult shape — this function is self-contained and can be dropped in
 *    and registered without touching anything else.
 *
 * Behavior, preserved exactly from SPB:
 *  - JSON.parse is authoritative. A block that parses is NEVER flagged, no
 *    matter what it looks like (this is the actual B2 fix — SPB's regression was
 *    heuristics running BEFORE the parse and false-positiving on valid,
 *    pretty-printed JSON whose string values happen to contain a colon).
 *  - Heuristics run only in the catch branch, purely to make an opaque
 *    SyntaxError actionable. They are advisory annotations on a real parse
 *    failure, never a substitute for one.
 */

/** Placeholder pending the real contracts/gate-result binding — see notes above. */
export type GateVerdict = "PASS" | "WARN" | "FAIL";

/** Placeholder pending the real contracts/gate-result binding — see notes above. */
export interface GateResult {
  gate: string;
  verdict: GateVerdict;
  details: string;
}

const GATE_NAME = "JSON_SCHEMA_MALFORMED";

/** Longest fenced block this gate will attempt to parse. Mirrors SPB's bound of the same kind. */
const JSON_BLOCK_MAX_CHARS = 15_000;

/**
 * Explains why `rawBlock` failed JSON.parse, in terms a prompt author can act
 * on. Only ever called after a real parse failure — never used to decide
 * whether something is malformed, only to describe why it already is.
 */
function diagnoseJsonBlock(rawBlock: string, label: string): string[] {
  try {
    JSON.parse(rawBlock);
    return []; // valid JSON is never flagged, full stop — this line is the B2 fix
  } catch (parseError) {
    const notes: string[] = [];

    // Single-quoted string where a double-quoted one is required.
    if (/[{,:[]\s*'(?:[^'\\]|\\.){0,256}'\s*[:,}\]]/.test(rawBlock)) {
      notes.push(`${label}: uses single quotes`);
    }
    // An unquoted identifier immediately followed by a colon (but not `//` or `://`).
    if (/(?:[{,]\s*)[a-zA-Z0-9_$]{1,64}\s*:(?!\/)/.test(rawBlock)) {
      notes.push(`${label}: unquoted keys`);
    }
    // A comma immediately before a closing brace/bracket.
    if (/,\s*[}\]]/.test(rawBlock)) {
      notes.push(`${label}: illegal trailing commas`);
    }
    // None of the three named patterns matched — surface the raw parser message
    // rather than staying silent about why the block was flagged.
    if (notes.length === 0) {
      notes.push(`${label}: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
    }
    return notes;
  }
}

/**
 * Scans `text` for fenced ```json / ```jsonc blocks and reports any that fail
 * to parse. A prompt with no fenced JSON blocks at all always passes.
 */
export function jsonSchemaMalformed(text: string, _options?: unknown): GateResult {
  const jsonErrors: string[] = [];

  const fencePattern = new RegExp(
    "```(?:json|jsonc)?\\s*\\n([\\s\\S]{1," + JSON_BLOCK_MAX_CHARS + "}?)\\n```",
    "gi",
  );

  const matches = [...text.matchAll(fencePattern)];
  matches.forEach((match, i) => {
    const rawBlock = match[1].trim();
    jsonErrors.push(...diagnoseJsonBlock(rawBlock, `Block #${i + 1}`));
  });

  if (jsonErrors.length === 0) {
    return { gate: GATE_NAME, verdict: "PASS", details: "" };
  }
  return { gate: GATE_NAME, verdict: "FAIL", details: jsonErrors.join("; ") };
}
