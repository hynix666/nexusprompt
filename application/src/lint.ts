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
  const results = runGates(text, { includeFences: options.includeFences });
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
