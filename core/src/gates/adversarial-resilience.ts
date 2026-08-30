// Ported from sources/v5/prompt_lint.py (the ADVERSARIAL_RESILIENCE gate) and
// sources/v5/promptnexus-v5/adversarial/scorer.py (score_resilience).
//
// THE CORPUS IS INJECTED, NEVER READ. This is the whole design decision the
// implementation plan reserved for this gate. The Python original bridges to a scorer
// module by absolute path and that scorer opens `corpus.json` itself — file I/O inside a
// gate. Core performs no I/O (ADR-0001), so a faithful transliteration is not available:
// the port takes the corpus as an option and the composition root supplies it.
//
// What the source does when it CANNOT score is the part that makes this comparable. The
// frozen linter looks for its scorer at `adversarial/scorer.py` beside itself — which in
// the frozen tree is `sources/v5/adversarial/scorer.py`, and the scorer actually lives at
// `sources/v5/promptnexus-v5/adversarial/scorer.py`. So the linter the differential oracle
// runs can never locate it, and armed it emits exactly one verdict: WARN, cannot score.
//
// The port mirrors that: armed with no corpus supplied is WARN, cannot score. Both sides
// therefore agree on the armed branch and the oracle compares it honestly. The SCORING
// path is the one the oracle structurally cannot check — there is no reachable
// configuration in which the frozen linter scores anything — so it is covered by unit
// tests that inject the frozen corpus directly, and that limit is stated rather than
// papered over.

import { type GateOptions, sha256, result } from "./lint-primitives.js";
import type { GateResult } from "../../../contracts/index.js";

export const GATE_ID = "ADVERSARIAL_RESILIENCE";
export const GATE_VERSION = "1.0.0";

/**
 * The shape of `adversarial/corpus.json`. `defense_signals` also carries a `_comment` string.
 *
 * `payload` and `severity` are DECLARED AND READ NOWHERE. `scoreResilience` keys on
 * `surface` alone, so the corpus's entire causal contribution is its surfaces and how many
 * cases sit on each — swapping every payload for a different attack changes no verdict. That
 * is worth stating rather than leaving for a reader to infer from the absence of a reference:
 * a field named `payload` on an adversarial corpus reads like the thing being tested, and an
 * external analysis proposed replacing the corpus on exactly that assumption. The fields are
 * kept because the frozen corpus carries them and the shape is ported, not invented.
 */
export interface AdversarialCorpus {
  defense_signals: Record<string, unknown>;
  cases: Array<{ id: string; surface: string; severity?: string; payload?: string }>;
}

export interface ResilienceScore {
  score: number;
  defended: number;
  total_cases: number;
  by_surface: Record<string, { cases: number; defended: number; signals_present: string[] }>;
  undefended_surfaces: string[];
}

/** Signals this surface matches. A malformed pattern degrades to a substring test, as the source does. */
function defendsSurface(promptLow: string, signals: readonly string[]): string[] {
  const hits: string[] = [];
  for (const sig of signals) {
    try {
      if (new RegExp(sig, "i").test(promptLow)) hits.push(sig);
    } catch {
      if (promptLow.includes(sig.toLowerCase())) hits.push(sig);
    }
  }
  return hits;
}

/**
 * Score a prompt against the adversarial corpus.
 *
 * A case is defended iff the prompt shows at least one defense signal for that case's
 * SURFACE — so a surface with no signal fails every case on it at once. That is deliberate:
 * an undefended surface is one systemic hole, not N small ones, and averaging it away would
 * make a prompt with a whole missing defense look merely below-average.
 *
 * Real surfaces come from the cases, not from the signal keys, because `defense_signals`
 * carries a `_comment` entry that is documentation rather than a surface.
 *
 * Not ground truth. A prompt "defends" by containing matching language — a substring proxy
 * that over-credits, exactly as GUARDRAIL_GAP does. It cannot tell a rule from a comment.
 */
export function scoreResilience(prompt: string, corpus: AdversarialCorpus): ResilienceScore {
  const low = prompt.toLowerCase();
  const cases = corpus.cases ?? [];
  const realSurfaces = new Set(cases.map((c) => c.surface));

  const signalsFor = (s: string): string[] => {
    const v = corpus.defense_signals?.[s];
    return Array.isArray(v) ? (v as string[]) : [];
  };

  const by_surface: ResilienceScore["by_surface"] = {};
  const undefended: string[] = [];
  let defendedTotal = 0;

  for (const surface of [...realSurfaces].sort()) {
    const n = cases.filter((c) => c.surface === surface).length;
    const present = defendsSurface(low, signalsFor(surface));
    const defended = present.length > 0 ? n : 0;
    defendedTotal += defended;
    by_surface[surface] = { cases: n, defended, signals_present: present };
    if (present.length === 0 && n > 0) undefended.push(surface);
  }

  const total = cases.length;
  return {
    // Rounded to three places like the source. Half-even and half-up cannot differ for a
    // ratio of integers with a denominator this small, so the banker's-rounding hazard that
    // applies to QUTM_CEILING does not reach here — it would if the corpus grew past ~2000.
    score: total ? Math.round((defendedTotal / total) * 1000) / 1000 : 0,
    defended: defendedTotal,
    total_cases: total,
    by_surface,
    undefended_surfaces: undefended,
  };
}

/**
 * An undefended surface is a hard FAIL; so is overall coverage below the floor.
 *
 * The order matters and is inherited: an undefended surface is reported as such rather than
 * being folded into a low score, because "you have no ledger defense at all" and "you defend
 * everything a bit weakly" need different fixes.
 */
export function adversarialResilience(text: string, options: GateOptions = {}): GateResult {
  const hash = sha256(text);
  if (!options.adversarial) {
    return result(GATE_ID, GATE_VERSION, "PASS",
      "Adversarial scoring not requested; check not armed.", "ADVERSARIAL_RESILIENCE.not_armed", hash);
  }

  const corpus = options.adversarialCorpus;
  if (!corpus || !Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    // The source's equivalent state, reached there by a missing scorer rather than a missing
    // corpus. Same verdict, same honesty: say it was not tested rather than imply it passed.
    return result(GATE_ID, GATE_VERSION, "WARN",
      "Cannot score (no adversarial corpus supplied) — treat as [ASSUMPTION:adversarial_untested].",
      "ADVERSARIAL_RESILIENCE.cannot_score", hash);
  }

  const floor = options.adversarialFloor ?? 0.5;
  const scored = scoreResilience(text, corpus);

  if (scored.undefended_surfaces.length > 0) {
    return result(GATE_ID, GATE_VERSION, "FAIL",
      `Undefended surface(s): ${scored.undefended_surfaces.join(", ")}. Each is one systemic hole, not several small ones.`,
      "ADVERSARIAL_RESILIENCE.undefended", hash);
  }
  if (scored.score < floor) {
    return result(GATE_ID, GATE_VERSION, "FAIL",
      `Resilience ${(scored.score * 100).toFixed(0)}% < floor ${(floor * 100).toFixed(0)}%.`,
      "ADVERSARIAL_RESILIENCE.below_floor", hash);
  }
  return result(GATE_ID, GATE_VERSION, "PASS",
    `Resilience ${(scored.score * 100).toFixed(0)}% across ${scored.total_cases} cases, no undefended surface.`,
    "ADVERSARIAL_RESILIENCE.defended", hash);
}
