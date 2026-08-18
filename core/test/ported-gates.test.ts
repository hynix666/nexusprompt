import { describe, it, expect } from "vitest";
import { placeholderAudit, runtimeKeyUndeclared } from "../src/gates/placeholder-audit.js";
import { sourceLedgerMissing, orphanClaims } from "../src/gates/source-ledger.js";
import {
  guardrailGap, tokenSpam, recursionMachineryPresent, ragShieldGap,
  duplicateInstruction, delimiterEntropy,
} from "../src/gates/guardrail-gap.js";
import { tokenBudget, qutmCeiling, contextLimit } from "../src/gates/budget.js";
import { estimateTokens, halfUp2 } from "../src/gates/lint-primitives.js";
import { listGates } from "../src/gates/registry.js";

/**
 * The thirteen gates ported in Phase 2, each with a must-fire and a must-not-fire case.
 *
 * The differential oracle already compares every one of these against the frozen Python
 * linter over 8,100 verdicts, which is a stronger check than anything here. These tests
 * exist for what the oracle cannot express: they name WHY each rule has the shape it does,
 * so a later edit that looks harmless has something to argue with. Several pin a defect
 * that actually shipped.
 */

const GUARDRAILS = "anti-override scope fact-grounding";

describe("PLACEHOLDER_AUDIT", () => {
  it("fires on an unfilled slot and not on a rendered one", () => {
    expect(placeholderAudit("Answer as <<ROLE>>.").verdict).toBe("FAIL");
    expect(placeholderAudit("Answer as a support agent.").verdict).toBe("PASS");
  });

  it("does not fire on a slot shown inside a fence", () => {
    // Documentation describing the syntax is not an unrendered template.
    expect(placeholderAudit("Slots look like:\n```\n<<ROLE>>\n```\n").verdict).toBe("PASS");
    expect(placeholderAudit("Slots look like:\n```\n<<ROLE>>\n```\n", { includeFences: true }).verdict).toBe("FAIL");
  });
});

describe("RUNTIME_KEY_UNDECLARED", () => {
  it("fires on an undeclared key and not on a declared one", () => {
    expect(runtimeKeyUndeclared("Use [[API_HOST]].").verdict).toBe("FAIL");
    expect(runtimeKeyUndeclared("# Runtime Variables\n[[API_HOST]]\n\nUse [[API_HOST]].").verdict).toBe("PASS");
  });

  it("reads the manifest from raw text but usage from audit text", () => {
    // Asymmetric on purpose: a manifest inside a fence still declares, but a key merely
    // illustrated inside a fence is not a use. Reading both from one text loses one or
    // invents the other.
    const fencedManifest = "# Runtime Variables\n```\n[[K]]\n```\n\nUse [[K]].";
    expect(runtimeKeyUndeclared(fencedManifest).verdict).toBe("PASS");
    expect(runtimeKeyUndeclared("Example only:\n```\n[[K]]\n```\n").verdict).toBe("PASS");
  });
});

describe("the citation pair — ported together because they failed together", () => {
  const LEDGER = "# Source ledger\n\n| [S1] | a source |\n| [S2] | another |\n";

  it("SOURCE_LEDGER_MISSING fires when citations exist and nothing declares them", () => {
    expect(sourceLedgerMissing("As shown [S1].").verdict).toBe("FAIL");
    expect(orphanClaims("As shown [S1].").verdict).toBe("PASS"); // mutually exclusive
  });

  it("ORPHAN_CLAIMS fires when a ledger exists but misses an id", () => {
    expect(orphanClaims(`As shown [S3].\n\n${LEDGER}`).verdict).toBe("FAIL");
    expect(sourceLedgerMissing(`As shown [S3].\n\n${LEDGER}`).verdict).toBe("PASS");
  });

  it("neither fires when every citation resolves", () => {
    expect(sourceLedgerMissing(`As shown [S1].\n\n${LEDGER}`).verdict).toBe("PASS");
    expect(orphanClaims(`As shown [S1].\n\n${LEDGER}`).verdict).toBe("PASS");
  });

  it("a citation inside an empty ledger section does NOT declare itself", () => {
    /**
     * The defect that motivated ADR-0007. A ledger heading with no table rows, followed
     * by prose citations, let the citation count as its own declaration — which silenced
     * BOTH gates and the artifact passed. Both v5 copies shared it, so the parity harness
     * was blind; only the differential oracle found it.
     *
     * Only table rows declare. This is the test that keeps that true.
     */
    const selfDeclaring = "# Source ledger\n\nSee [S1] and [S2] for details.\n";
    expect(sourceLedgerMissing(selfDeclaring).verdict).toBe("FAIL");
  });

  it("reads every id in a multi-id citation, not just the first", () => {
    // `[S1,S2]` under the old regex left S2 uncited — the other shared defect.
    expect(orphanClaims(`As shown [S1,S9].\n\n${LEDGER}`).verdict).toBe("FAIL");
    expect(orphanClaims(`As shown [S1, S2].\n\n${LEDGER}`).verdict).toBe("PASS");
  });

  it("does not treat a page reference as a source id", () => {
    // `[S1, p. 42]` must not leak 42 as a cited source.
    expect(orphanClaims(`As shown [S1, p. 42].\n\n${LEDGER}`).verdict).toBe("PASS");
  });
});

describe("GUARDRAIL_GAP", () => {
  it("warns by default and fails on a safety tier", () => {
    expect(guardrailGap("nothing here").verdict).toBe("WARN");
    expect(guardrailGap("nothing here", { safetyTier: true }).verdict).toBe("FAIL");
    expect(guardrailGap(GUARDRAILS).verdict).toBe("PASS");
  });

  it("matches on a word boundary, so a clause cannot hide inside another word", () => {
    // The unanchored `clause in low` this replaced counted a clause as present inside any
    // unrelated word — a false-clean, which is the worst direction for a safety gate.
    expect(guardrailGap("anti-override telescope fact-grounding").verdict).toBe("WARN");
    const safety = `${GUARDRAILS} sanitize recursion conflict`;
    expect(guardrailGap(`${safety} The estimator is unbiased.`, { safetyTier: true }).verdict).toBe("FAIL");
    expect(guardrailGap(`${safety} We check for biases.`, { safetyTier: true }).verdict).toBe("PASS");
  });

  it("leaves the right edge free so a stem matches its inflections", () => {
    expect(guardrailGap(`${GUARDRAILS} sanitization recursion conflict bias`, { safetyTier: true }).verdict).toBe("PASS");
    expect(guardrailGap(`${GUARDRAILS} sanitizing recursion conflict biases`, { safetyTier: true }).verdict).toBe("PASS");
  });

  it("does NOT match the British spelling, despite the source comment claiming it does", () => {
    /**
     * The source lists the clause as `"sanitiz",  # input sanitization / sanitisation`.
     * The stem ends in `z`, so `\bsanitiz` cannot match `sanitisation` — the comment
     * claims coverage the code does not have, and a prompt written in British English
     * fails a safety-tier gate for a spelling reason.
     *
     * The port reproduces this faithfully and deliberately. It is a candidate for
     * scripts/divergence-allowlist.json, not something to quietly fix here: changing it
     * would put the port out of parity with the source, which is exactly the decision
     * ADR-0007's allowlist exists to record. Pinned so the behaviour is known rather
     * than discovered.
     */
    expect(guardrailGap(`${GUARDRAILS} sanitisation recursion conflict bias`, { safetyTier: true }).verdict).toBe("FAIL");
  });
});

describe("TOKEN_SPAM", () => {
  it("fires above eight, not at eight", () => {
    expect(tokenSpam("[ACK] ".repeat(8)).verdict).toBe("PASS");
    expect(tokenSpam("[ACK] ".repeat(9)).verdict).toBe("WARN");
  });
});

describe("the opt-in target gates", () => {
  it("RECURSION_MACHINERY_PRESENT is not armed unless the target is recursive", () => {
    expect(recursionMachineryPresent("[MEM_STATE] here").verdict).toBe("PASS");
    expect(recursionMachineryPresent("[MEM_STATE] here", { recursiveTarget: true }).verdict).toBe("FAIL");
  });

  it("RAG_SHIELD_GAP fires only when EVERY acknowledgment token is absent", () => {
    expect(ragShieldGap("no tokens here", { ragTarget: true }).verdict).toBe("FAIL");
    expect(ragShieldGap("we emit insufficient_retrieval", { ragTarget: true }).verdict).toBe("PASS");
    expect(ragShieldGap("no tokens here").verdict).toBe("PASS"); // not armed
  });
});

describe("DUPLICATE_INSTRUCTION", () => {
  const block = "This is a substantive instruction block that comfortably exceeds the sixty character floor.";

  it("fires on a repeated substantive block", () => {
    expect(duplicateInstruction(`${block}\n\n${block}`).verdict).toBe("WARN");
  });

  it("exempts short repeated paragraphs — a bullet is document structure, not a defect", () => {
    expect(duplicateInstruction("- item\n\n- item").verdict).toBe("PASS");
  });

  it("normalises whitespace before comparing, so a reflowed copy still counts", () => {
    expect(duplicateInstruction(`${block}\n\n${block.replace(/ /g, "\n")}`).verdict).toBe("WARN");
  });
});

describe("DELIMITER_ENTROPY", () => {
  it("fires below 32 hex chars and passes at 32", () => {
    expect(delimiterEntropy("[INPUT_START_ab12cd]").verdict).toBe("FAIL");
    expect(delimiterEntropy(`[INPUT_START_${"a".repeat(32)}]`).verdict).toBe("PASS");
  });

  it("does not fire on a short form shown as a fenced counter-example", () => {
    // A compliant prompt illustrating the deprecated form must not scan as a failure.
    expect(delimiterEntropy("Never use:\n```\n[INPUT_START_ab12cd]\n```\n").verdict).toBe("PASS");
  });
});

describe("the arithmetic trio", () => {
  it("estimates tokens as chars/4 with a floor of 1, and no tokenizer", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("rounds half-up, not banker's — the divergence parity cannot see", () => {
    // Python's round(0.005, 2) is 0.0; Math.round-based forms and banker's rounding
    // disagree here. floor(x*100+0.5)/100 is the shape all implementations share.
    expect(halfUp2(0.005)).toBe(0.01);
    expect(halfUp2(0.014)).toBe(0.01);
    expect(halfUp2(2.675)).toBe(2.68);
  });

  it("TOKEN_BUDGET treats 0 as an explicit budget, not an absent one", () => {
    // The truthiness form silently skipped the check on a caller-supplied 0.
    expect(tokenBudget("anything at all").verdict).toBe("PASS"); // not armed
    expect(tokenBudget("anything at all", { tokenBudget: 0 }).verdict).toBe("FAIL");
    expect(tokenBudget("abcd", { tokenBudget: 1 }).verdict).toBe("PASS");
  });

  it("QUTM_CEILING treats naiveTokens 0 as an explicit baseline", () => {
    // The identical defect, fixed on TOKEN_BUDGET and left standing on its sibling.
    const long = "a".repeat(4000); // est 1000
    expect(qutmCeiling(long, { stakes: "low", naiveTokens: 0 }).verdict).toBe("FAIL");
    expect(qutmCeiling(long, { stakes: "low" }).verdict).toBe("FAIL"); // default 400 -> 2.5 > 1.2
    expect(qutmCeiling("abcd", { stakes: "low" }).verdict).toBe("PASS");
  });

  it("QUTM_CEILING refuses an unknown tier rather than passing quietly", () => {
    expect(qutmCeiling("x", { stakes: "extremely-high" }).verdict).toBe("FAIL");
    expect(qutmCeiling("x").verdict).toBe("PASS"); // not armed
  });

  it("CONTEXT_LIMIT warns rather than fails, and is not armed for an unknown provider", () => {
    const huge = "a".repeat(600_000); // est 150,000
    expect(contextLimit(huge, { provider: "openai" }).verdict).toBe("WARN");
    expect(contextLimit(huge, { provider: "anthropic" }).verdict).toBe("PASS");
    expect(contextLimit(huge, { provider: "nonesuch" }).verdict).toBe("PASS");
  });
});

describe("the registry", () => {
  it("registers fifteen gates, in stable order", () => {
    const ids = listGates().map((g) => g.id);
    expect(ids).toHaveLength(15);
    expect(ids).toEqual([...ids]); // order is the declaration order, not sorted
    expect(new Set(ids).size).toBe(15); // no duplicate registration
  });

  it("does not register ADVERSARIAL_RESILIENCE, which cannot be a pure Core gate", () => {
    // Its scorer reads an external corpus file. Core performs no I/O, so porting it needs
    // the corpus injected — a decision, not an omission. See ADR-0007 and the plan.
    expect(listGates().map((g) => g.id)).not.toContain("ADVERSARIAL_RESILIENCE");
  });
});
