/**
 * The lint operation on the Application protocol.
 *
 * The CLI used to `import { runGates } from core/gates/registry` directly, which
 * the documented dependency rule forbids — Shells call the Application protocol,
 * not Core. Nothing enforced that rule, so the only Shell in the repository
 * broke it. `scripts/check-boundaries.mjs` enforces it now, and this is the seam
 * that lets the Shell obey it.
 *
 * **This is a thin delegation today and the comment should say so rather than
 * dress it up.** `lint()` calls Core and returns what Core returned. It earns
 * its place for two reasons: it is the only import a Shell needs in order to
 * lint, and it is where the effectful parts of linting will land when they
 * arrive — loading a config file, resolving a gate allowlist, emitting an
 * observability event. None of those can live in Core, and adding them later
 * must not change every Shell's imports.
 *
 * Pure as written. It performs no effect, which is why the Shell can call it
 * without a composition root.
 */

import {
  runGates,
  listGates,
  SOURCE_GATE_COUNT,
} from "../../core/src/gates/registry.js";
import type { GateResult } from "../../contracts/index.js";

export interface LintOptions {
  /** Lint fenced and backticked spans too, instead of treating them as documentation. */
  includeFences?: boolean;
  /**
   * Stakes tier. Arms QUTM_CEILING and escalates GUARDRAIL_GAP from WARN to FAIL.
   *
   * This is the ONLY production entry point to the gates, and it passed neither this nor
   * `naiveTokens` — so three of the sixteen gates could not fire outside the eval harness and
   * the differential's own boundary cases. ADR-0011 argued about a floor on a gate no real
   * caller could arm. A guard reachable only by its tests is the defect this repo keeps finding.
   */
  stakes?: string;
  /** Naive-prompt baseline for QUTM_CEILING. Below QUTM_MIN_BASELINE_TOKENS the gate declines. */
  naiveTokens?: number;
  /** Provider id, for the CONTEXT_LIMIT advisory. */
  provider?: string;
}

export interface PortedGate {
  id: string;
  version: string;
}

export interface LintReport {
  results: GateResult[];
  /** How many gates ran. */
  ported_gate_count: number;
  /** How many the frozen source linter emits. The gap is the remaining port. */
  source_gate_count: number;
}

export function lint(text: string, options: LintOptions = {}): LintReport {
  /**
   * The tier vocabulary is normalised HERE, not in the gate.
   *
   * `QUTM_CEILINGS` is keyed lowercase because the frozen linter's argparse choices are, and
   * an unknown tier is a FAIL there rather than a quiet pass — faithful, and worth keeping.
   * But this system's own vocabulary is uppercase (`--stakes LOW|MEDIUM|HIGH|SAFETY-CRITICAL`),
   * so passing it straight through turned every production lint at a declared tier into
   * `QUTM_CEILING.unknown_tier` — a FAIL, on correct input, introduced by wiring the option up.
   *
   * The Application adapts its vocabulary to the port; Core stays exactly as faithful to the
   * oracle as it was. Lower-casing inside the gate would have been the same fix in the one
   * place it must not go.
   */
  const results = runGates(text, {
    includeFences: options.includeFences,
    stakes: options.stakes?.toLowerCase(),
    naiveTokens: options.naiveTokens,
    provider: options.provider,
    safetyTier: options.stakes ? ["HIGH", "SAFETY-CRITICAL"].includes(options.stakes.toUpperCase()) : undefined,
  });
  return {
    results,
    ported_gate_count: results.length,
    source_gate_count: SOURCE_GATE_COUNT,
  };
}

export function listPortedGates(): PortedGate[] {
  return listGates().map((g) => ({ id: g.id, version: g.version }));
}

/**
 * The worst verdict present, using the source linter's precedence.
 * Exit-code mapping lives in the Shell; the ordering lives here so two Shells
 * cannot disagree about which verdict wins.
 */
export function worstVerdict(results: GateResult[]): "PASS" | "WARN" | "FAIL" {
  if (results.some((r) => r.verdict === "FAIL")) return "FAIL";
  if (results.some((r) => r.verdict === "WARN")) return "WARN";
  return "PASS";
}
