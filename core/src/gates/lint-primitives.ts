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
 * at the first line of prose that declares nothing. A declaration line opens with its key,
 * under any list syntax; `1. Read [[PLAYER_TIER]] and branch.` is a use, not a declaration,
 * and ends the section rather than extending it.
 *
 * The exact shape of "heading" and "declaration line" is decided by the two constants below,
 * and both were WRONG in the first version of this fix — see their comments. Read those
 * before widening or narrowing either: one direction reintroduces the false clean, the other
 * reintroduces the unclearable FAIL.
 */
/**
 * What opens a manifest, in one place. The authority is spec/manifest-shapes.json.
 *
 * TWO RULES, because a `#` is an unambiguous structural marker and bare prose is not:
 *   with a `#`   the line is a heading, but the tail must be a QUALIFIER — end of line, or a
 *                bracket, colon, dash or closing hashes. Not a continuation of the phrase.
 *   without one  the line must be nothing but the phrase, plus an optional parenthetical
 *                and colon. This is the form the v5 BLUEPRINT emits.
 *
 * Each half exists because omitting it produced a real defect, in a real round:
 *
 *   requiring `#`         made the BLUEPRINT's own manifest invisible, so every correctly
 *                         declared key read as undeclared and no prompt could pass this gate
 *                         and DELIMITER_ENTROPY at once.
 *   making `#` optional
 *   with no tail rule     let `Runtime variables are injected by the host...` open a manifest
 *                         and the next line declare. A document with no manifest returned PASS.
 *   requiring the whole
 *   line be the phrase    broke `## Runtime Variables (host-supplied) — do not echo`, a
 *                         regression against both the previous port and the frozen oracle.
 *   allowing any tail
 *   after a `#`           let `## Runtime Variables You Must Never Log` declare the key it
 *                         forbids. The highest-traffic shape of the lot.
 *
 * The pattern across all four: changing a matcher moves BOTH failure directions, and the
 * author tests only the one they just fixed. When in doubt the accept-set loses — a rejected
 * manifest is a visible FAIL an author clears; an accepted non-manifest is a silent PASS.
 */
/**
 * Indented four or more spaces, a heading is an indented CODE BLOCK, not a heading.
 *
 * `^\s*` allowed any indentation, so a four-space-indented `## Runtime Variables` opened a
 * manifest and its entries declared -- a documentation sample written the indented way rather
 * than the fenced way whitelisted its keys for the whole document.
 *
 * Note this is `^ {0,3}` where FENCE_LINE_RE is `^[ 	]{0,3}`, and the asymmetry is
 * deliberate: both err safe, in opposite directions. A fence that fails to match does not
 * open, so its contents stay readable -- unsafe -- and the class is widened. A heading that
 * fails to match does not open a manifest, which is safe, so the class stays strict. A
 * tab-indented heading therefore declares nothing, which is the answer we want anyway.
 */
const ATX_MANIFEST_HEADING_RE = /^ {0,3}#{1,6}[ 	]+Runtime Variables\s*(?:$|[(\[:–—-]|#)/i;
const BARE_MANIFEST_HEADING_RE = /^ {0,3}Runtime Variables\s*(?:\([^)]*\))?\s*:?\s*$/i;
const isManifestHeading = (line: string): boolean =>
  ATX_MANIFEST_HEADING_RE.test(line) || BARE_MANIFEST_HEADING_RE.test(line);

/**
 * A declaration line opens with its key, whatever list syntax carries it.
 *
 * The bare-or-bulleted-only version rejected every manifest written as a Markdown table, an
 * ordered list, or with the key in backticks — each returning `declared: []` and therefore
 * FAIL on every correctly declared key. That is defect B1 again in a new costume, and it was
 * sharper than a style nit because `extractSourceLedgerIds`, ten lines below and cited by this
 * function's own comment as the model for it, accepts ONLY table rows. The two declaration
 * readers in one file accepted disjoint syntaxes, so formatting the manifest the way the
 * ledger is formatted produced an unclearable FAIL.
 *
 * The prefixes admitted here carry no semantics — a bullet, an ordered marker, a table cell,
 * and emphasis wrappers. What still ends the section is prose: `1. Read [[PLAYER_TIER]] and
 * branch.` does not open with its key, so a use cannot declare itself.
 */
const DECLARATION_LINE_RE =
  /^\s*(?:[-*+]\s*|\d+[.)]\s*)?[`*_]*\[\[[A-Za-z0-9_:-]+\]\]/;

const TABLE_ROW_RE = /^\s*\|/;

/**
 * The keys a line DECLARES — empty when it declares nothing.
 *
 * A table row used to declare every key it contained in any cell, so a warning row inside the
 * manifest's own table — `| Warning | never pass [[CUSTOMER_SSN]] to the model |` — declared
 * the key it exists to forbid, and the gate returned PASS on a body that echoed it. Deleting
 * that one row restored the FAIL. Structurally the same defect as a later table declaring for
 * the whole document, relocated one table earlier.
 *
 * A cell declares on the same rule as any other line: it must OPEN with the key. That keeps
 * the `Name | Placeholder | Meaning` layout working — the key is in cell two, but it is the
 * whole of cell two — while a prose cell mentioning a key declares nothing.
 */
function declarationKeys(line: string): string[] {
  const collect = (s: string) => [...s.matchAll(RUNTIME_KEY_G)].map((m) => m[1]);
  if (TABLE_ROW_RE.test(line)) {
    return line.split("|").flatMap((cell) => (DECLARATION_LINE_RE.test(cell) ? collect(cell) : []));
  }
  return DECLARATION_LINE_RE.test(line) ? collect(line) : [];
}

/**
 * CommonMark fence delimiters — both characters, and length-aware.
 *
 * The previous guard was `/^\s*```/` with a boolean toggle, which failed twice. A `~~~` fence
 * was invisible, so a tilde-wrapped documentation example declared for real. And because the
 * toggle ignored fence LENGTH, a ``` line nested inside a ```` block flipped the state back to
 * "outside", so a genuinely fenced heading was read as real — the exact hole the fence guard
 * was added to close.
 *
 * `strip-documentation-spans.ts` already implements the length rule and is NOT reused here on
 * purpose: it is a faithful port pinned by the differential oracle, and the frozen Python
 * linter handles only backticks. Teaching it `~~~` would diverge from the oracle on every gate
 * at once. This scan is already a declared divergence (ADR-0010), so it can be stricter alone.
 * The asymmetry is deliberate and stated rather than left for someone to trip over.
 */
/**
 * `^ {0,3}`, not `^\s*`: four spaces of indentation makes a delimiter into CONTENT.
 *
 * Stripping any indentation let an indented, equal-length closer end a documentation sample
 * early — so a heading placed after it was read as real document and its keys declared.
 * `declared={T}` on a document whose only manifest was inside a fenced example.
 *
 * CommonMark is explicit: an opening fence may be indented up to three spaces, and a closing
 * fence indented four or more is an indented code block, not a close. Three is the boundary.
 *
 * A TAB counts too. Strictly a tab is four columns, so `	```` is an indented code block
 * rather than a fence — but `^ {0,3}` matched neither, so the delimiter was invisible, the
 * fence never opened, and a heading inside the sample was read as real document. Either
 * reading suppresses the contents; only one of them suppresses them HERE. Safe direction.
 */
const FENCE_LINE_RE = /^[ 	]{0,3}(`{3,}|~{3,})(.*)$/;

const RUNTIME_KEY_G = /\[\[([A-Za-z0-9_:-]+)\]\]/g;

export function extractRuntimeManifest(text: string): Set<string> {
  const declared = new Set<string>();
  /**
   * A byte-order mark is a file artifact, not indentation.
   *
   * Bounding the heading indent to three spaces — CommonMark: four makes it an indented code
   * block — broke BOM-prefixed documents, which are ordinary on Windows. `﻿## Runtime
   * Variables` stopped matching, so every declared key read as undeclared. The previous `\s*`
   * had been absorbing the BOM by accident.
   *
   * Stripping it once, here, is the fix. Widening the indent class to include it would have
   * been the same fix in the wrong place, and would have let a BOM stand in for a space.
   */
  const lines = text.replace(/^﻿/, "").split("\n");

  /**
   * A heading inside a fence is an EXAMPLE, and must not declare.
   *
   * The asymmetry is deliberate and inherited: declarations are read from raw text so that a
   * manifest whose entries sit in a fence still declares. But that same raw read let a
   * documentation sample — "here is a manifest you might write" around a fenced
   * `# Runtime Variables` — grant real declarations for the whole document, so a prompt that
   * documents an example whitelisted those keys everywhere.
   *
   * The line between them is the HEADING: it must be outside a fence. Entries beneath it may
   * be inside one. That keeps the property the raw read exists for and closes the sample hole.
   */
  /** The open fence's delimiter, or null outside one. Closing needs the same char, >= length. */
  let openFence: string | null = null;
  /** The delimiter run and whatever follows it on the line. An opener may carry an info
   *  string; a closer may not, which is the whole reason `rest` is returned at all. */
  const fenceOf = (line: string): { run: string; rest: string } | null => {
    const m = FENCE_LINE_RE.exec(line);
    return m ? { run: m[1]!, rest: m[2]! } : null;
  };

  /**
   * A commented-out manifest is not a manifest.
   *
   * `<!-- ... -->` is how an author disables a block or shows an example without a fence, and
   * a heading inside one declared for real: a commented-out manifest whitelisted its keys for
   * the whole document. Same category as the fenced example, different syntax, and inherited
   * rather than introduced — found by the Phase D sweep, which ran sixteen other exotic shapes
   * (setext, blockquote, list item, CRLF, zero-width, non-breaking space) that were already
   * handled correctly.
   *
   * Only heading detection is suppressed. Declarations beneath a real heading are untouched,
   * exactly as with fences.
   */
  let inComment = false;

  for (let h = 0; h < lines.length; h++) {
    if (inComment) {
      if (lines[h].includes("-->")) inComment = false;
      continue;
    }
    const commentStart = lines[h].indexOf("<!--");
    if (commentStart !== -1 && !lines[h].slice(commentStart).includes("-->")) {
      inComment = true;
      continue;
    }

    const fence = fenceOf(lines[h]);
    if (fence) {
      // An OPENER may carry an info string -- ```md, ```{.md #id}, ```text. That is what the
      // string is for.
      if (openFence === null) openFence = fence.run;
      // A CLOSER may not. CommonMark allows only whitespace after the delimiter run, and the
      // difference is not pedantic: reading ```md as a closer flips fence parity for the rest
      // of the document, so a sample that should stay hidden becomes visible and a heading
      // inside it declares for real. Found by the sixth sweep, and it is the unsafe direction
      // -- a silent PASS on a key the reader never saw declared.
      //
      // Failing to close is safe here, which is the opposite of the opener asymmetry recorded
      // above: an unclosed fence hides MORE, and hidden content declares nothing.
      else if (
        fence.run[0] === openFence[0] &&
        fence.run.length >= openFence.length &&
        fence.rest.trim() === ""
      ) {
        openFence = null;
      }
      continue;
    }
    if (openFence !== null || !isManifestHeading(lines[h])) continue;

    /**
     * A keyless table row is scaffolding only while we are INSIDE that table.
     *
     * A table opens with a header and a `| --- |` separator, neither carrying a key, so
     * terminating on them ended the section one line before the first real entry and a
     * fifty-key table declared nothing. Skipping them unconditionally went too far the other
     * way: the scan walked out of a finished manifest, across a blank line, into an unrelated
     * table, and read `| [[CUSTOMER_SSN]] | never injected; not a runtime variable |` as
     * declaring it. Bounding the skip to "before the first declaration" fixed that case and
     * broke ordinary layouts instead — a manifest whose table follows a bullet lost every
     * table entry.
     *
     * Adjacency is the property that actually distinguishes them: scaffolding belongs to a
     * table we are already reading. Starts true so the heading may be followed directly by a
     * table, and is reset by every declaration to whether THAT declaration was a table row.
     *
     * A manifest that mixes a bullet and then a table therefore ends at the table — the two
     * are textually indistinguishable from a finished manifest followed by an unrelated
     * table, so the safe direction wins: a visible FAIL rather than a silent PASS.
     */
    let inTableRun = true;

    for (let i = h + 1; i < lines.length; i++) {
      const line = lines[i];
      // Blank lines and fence delimiters do not end a manifest — see above.
      if (line.trim() === "" || FENCE_LINE_RE.test(line)) continue;

      const isTableRow = TABLE_ROW_RE.test(line);
      const keys = declarationKeys(line);
      if (keys.length > 0) {
        for (const k of keys) declared.add(k);
        inTableRun = isTableRow;
        continue;
      }
      if (isTableRow && inTableRun) continue;
      break;
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
 * 7.5× against a 120-token one — over the ceiling at every tier below safety-critical,
 * whose 12× it clears. The gate was measuring the brief's brevity, not the prompt's bloat.
 * (The earlier wording here said "every tier including safety-critical's 12×", which
 * contradicted ADR-0011's own table three lines of prose away.)
 *
 * A named constant rather than an inline number, deliberately: a threshold spelled into
 * the comparison is a guard whose scope nothing can state, which is how a check ends up
 * narrower than its name.
 */
export const QUTM_MIN_BASELINE_TOKENS = 120;

export const PROVIDER_CONTEXT_LIMITS: Record<string, number> = {
  anthropic: 200_000, openai: 128_000, google: 1_048_576, ollama: 128_000,
};
