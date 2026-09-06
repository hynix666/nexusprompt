/**
 * The divergence-allowlist matching logic, extracted from `differential.ts` so it can be
 * unit-tested in isolation.
 *
 * `differential.ts` is a top-level script with no `main()` guard -- importing it for its
 * logic would execute the whole oracle (argument parsing, shelling out to Python, exit
 * calls) as a side effect of the import. This module has none of that: it is pure, has no
 * I/O, and is safe to import from a test.
 *
 * `optionsSatisfied` and `covers` are the two functions a repository audit found were "only
 * exercised end-to-end" -- reachable only by running the full 2,848-verdict comparison
 * against the real frozen Python linter, so a planted defect in the matching logic itself
 * had to survive that whole run undetected before anyone would see it. They are also the
 * logic ADR-0011's `only_when_options` narrowing exists to keep honest: a blanket
 * `also_matches: ".*"` on QUTM_CEILING would also excuse the `qutm-ceiling-crossing`
 * boundary case, and that is exactly the shape a unit test can catch quickly that an
 * end-to-end run only catches by accident of which cases the generator happens to produce.
 */

import type { Verdict } from "../contracts/index.js";
import type { CaseOptions } from "../core/src/eval/generator.js";

/**
 * A deliberate difference from the source (ADR-0007 action item 2).
 *
 * Both verdicts are pinned, not just the fact of a difference: an entry saying only "these
 * may differ" would keep covering the case if the port later drifted to a third verdict.
 */
export interface AllowedDivergence {
  gate: string;
  demonstration: { text: string; options?: CaseOptions };
  source_verdict: Verdict;
  port_verdict: Verdict;
  also_matches?: string;
  /**
   * NARROWS the entry to cases whose options satisfy every constraint. QUTM_CEILING's
   * baseline floor (ADR-0011) is the case that forced this -- it diverges on any text whose
   * baseline is below the floor, so the only text regex that covers it is `.*`, which would
   * also excuse the `qutm-ceiling-crossing` boundary case.
   */
  only_when_options?: Record<string, Record<string, number>>;
  reason?: string;
  adr?: string;
}

export interface Disagreement {
  source: string;
  gate: string;
  python: Verdict;
  typescript: Verdict;
  text: string;
  options: CaseOptions;
}

export const OPERATORS: Record<string, (a: number, b: number) => boolean> = {
  lt: (a, b) => a < b, lte: (a, b) => a <= b,
  gt: (a, b) => a > b, gte: (a, b) => a >= b,
  eq: (a, b) => a === b,
};

/**
 * True when every declared constraint holds. A constraint on an option the case does not
 * carry is NOT satisfied -- an absent option means the case is outside what the entry
 * described, so it must stay a live disagreement rather than be excused by omission.
 */
export function optionsSatisfied(e: AllowedDivergence, options: CaseOptions): boolean {
  if (!e.only_when_options) return true;
  for (const [name, constraint] of Object.entries(e.only_when_options)) {
    const actual = (options as Record<string, unknown>)[name];
    if (typeof actual !== "number") return false;
    for (const [op, bound] of Object.entries(constraint)) {
      if (!OPERATORS[op]?.(actual, bound)) return false;
    }
  }
  return true;
}

/** Does allowlist entry `e` excuse disagreement `d`? */
export const covers = (e: AllowedDivergence, d: Disagreement): boolean =>
  d.gate === e.gate &&
  d.python === e.source_verdict &&
  d.typescript === e.port_verdict &&
  // Narrowing, applied to every match including the demonstration's own text.
  optionsSatisfied(e, d.options) &&
  (d.text === e.demonstration?.text || (!!e.also_matches && new RegExp(e.also_matches).test(d.text)));

/**
 * Structural problems with an allowlist, independent of any comparison run. These are the
 * checks that run "before any comparison, so a malformed entry cannot excuse anything" --
 * extracted as a pure function of `(allowlist, sharedGates)` so a malformed-entry shape can
 * be planted and checked without needing the Python linter or a real comparison at all.
 */
export function structuralProblems(allowlist: AllowedDivergence[], sharedGates: Set<string>): string[] {
  const problems: string[] = [];
  for (const [i, e] of allowlist.entries()) {
    const at = `entry ${i} (${e.gate ?? "no gate"})`;
    if (!e.gate) problems.push(`${at}: no gate named`);
    else if (!sharedGates.has(e.gate)) {
      problems.push(`${at}: ${e.gate} is not in the shared gate set — excusing a gate that is never compared`);
    }
    if (!e.reason?.trim()) problems.push(`${at}: no reason. A difference without a stated reason is a defect.`);
    if (!e.adr?.trim()) problems.push(`${at}: no ADR. Deliberate divergence is a decision and needs one.`);
    if (!e.demonstration?.text) problems.push(`${at}: no demonstration input`);
    if (e.source_verdict === e.port_verdict) {
      problems.push(`${at}: source_verdict equals port_verdict — that is agreement, not a divergence`);
    }
    if (e.also_matches) {
      try { new RegExp(e.also_matches); }
      catch { problems.push(`${at}: also_matches is not a valid regex`); }
    }
    for (const [name, constraint] of Object.entries(e.only_when_options ?? {})) {
      for (const op of Object.keys(constraint)) {
        if (!OPERATORS[op]) {
          problems.push(
            `${at}: only_when_options.${name} uses unknown operator "${op}". ` +
            `Known: ${Object.keys(OPERATORS).join(", ")}. An unrecognised operator must not read as satisfied.`,
          );
        }
      }
    }
    // An entry whose own demonstration falls outside its option constraints could never
    // prove itself, so it would fail the staleness rule below with a confusing message.
    // Say the real thing here instead.
    if (e.only_when_options && !optionsSatisfied(e, e.demonstration?.options ?? {})) {
      problems.push(
        `${at}: its demonstration's options do not satisfy its own only_when_options. ` +
        `The entry describes a case it cannot itself produce.`,
      );
    }
  }
  return problems;
}
