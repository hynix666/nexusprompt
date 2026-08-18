// Ported from sources/v5/prompt_lint.py — "Gate 3".
//
// SOURCE_LEDGER_MISSING and ORPHAN_CLAIMS are ported together, deliberately.
//
// These two shipped a defect as a PAIR: a ledger heading with no entries, followed by
// prose citations, let a citation inside the ledger section declare itself — which
// silenced BOTH gates at once and the artifact passed. Porting them separately, each
// tested alone, would reproduce exactly the blind spot that let it through. The
// interaction is the thing worth testing, so the interaction lives in one file.
//
// The source's own branch structure makes them mutually exclusive, and both ports must
// agree on that:
//
//   no citations                       -> neither fires
//   citations, no ledger               -> SOURCE_LEDGER_MISSING
//   citations, ledger, orphans remain  -> ORPHAN_CLAIMS
//   citations, ledger, none orphaned   -> neither fires

import { stripDocumentationSpans } from "../strip-documentation-spans.js";
import {
  type GateOptions, sha256, result, extractCitedIds, extractSourceLedgerIds, byNumber,
} from "./lint-primitives.js";
import type { GateResult } from "../../../contracts/index.js";

export const LEDGER_GATE_ID = "SOURCE_LEDGER_MISSING";
export const ORPHAN_GATE_ID = "ORPHAN_CLAIMS";
export const GATE_VERSION = "1.0.0";

/** Shared analysis, computed identically for both gates so they cannot disagree. */
function analyse(text: string, options: GateOptions) {
  const auditText = options.includeFences ? text : stripDocumentationSpans(text);
  const cited = extractCitedIds(auditText);
  // The ledger is read from RAW text: a ledger table inside a fence still declares.
  const ledger = extractSourceLedgerIds(text);
  const orphans = [...cited].filter((c) => !ledger.has(c)).sort(byNumber);
  return { cited, ledger, orphans };
}

/** Citations exist and no ledger declares anything. Nothing can be checked against nothing. */
export function sourceLedgerMissing(text: string, options: GateOptions = {}): GateResult {
  const hash = sha256(text);
  const { cited, ledger, orphans } = analyse(text, options);

  if (cited.size > 0 && orphans.length > 0 && ledger.size === 0) {
    return result(LEDGER_GATE_ID, GATE_VERSION, "FAIL",
      `Citations present (${cited.size}) but no source ledger found.`,
      "SOURCE_LEDGER_MISSING.absent", hash);
  }
  return result(LEDGER_GATE_ID, GATE_VERSION, "PASS",
    cited.size === 0 ? "No citations to ledger." : "A source ledger is present.",
    "SOURCE_LEDGER_MISSING.clean", hash);
}

/** A ledger exists but does not declare everything the text cites. */
export function orphanClaims(text: string, options: GateOptions = {}): GateResult {
  const hash = sha256(text);
  const { cited, ledger, orphans } = analyse(text, options);

  // `ledger.size > 0` is what keeps this exclusive with SOURCE_LEDGER_MISSING. Dropping it
  // would make both fire on a citation with no ledger, double-reporting one defect.
  if (cited.size > 0 && orphans.length > 0 && ledger.size > 0) {
    return result(ORPHAN_GATE_ID, GATE_VERSION, "FAIL",
      `Cited but not in the ledger: ${orphans.map((o) => `S${o}`).join(", ")}.`,
      "ORPHAN_CLAIMS.orphaned", hash);
  }
  return result(ORPHAN_GATE_ID, GATE_VERSION, "PASS",
    "Every citation resolves to a ledger entry.", "ORPHAN_CLAIMS.clean", hash);
}
