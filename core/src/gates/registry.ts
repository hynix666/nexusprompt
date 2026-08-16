/**
 * The gate registry.
 *
 * Every one of the seventeen prototypes in the AI APP collection hardcodes its
 * gate list, and not one of them grew past its author's original set. That is
 * the extensibility property (#7) failing in the most literal way available: the
 * list is the ceiling.
 *
 * Adding a gate here means writing its module and adding one line below. No
 * caller changes, no switch statement to extend, no shell that needs to learn a
 * new name. `runGates` returns whatever is registered.
 *
 * Pure. The registry holds functions, not effects — registration happens at
 * module load with no I/O.
 */

import type { GateResult } from "../../../contracts/index.js";
import { secretLeakScan, GATE_ID as SECRET_ID, GATE_VERSION as SECRET_V } from "./secret-leak-scan.js";
import { claimDiscipline, GATE_ID as CLAIM_ID, GATE_VERSION as CLAIM_V } from "./claim-discipline.js";

/** Options any gate may read. Gates ignore what they don't use. */
export interface GateOptions {
  includeFences?: boolean;
}

export interface Gate {
  readonly id: string;
  readonly version: string;
  run(text: string, options: GateOptions): GateResult;
}

/**
 * The registered set. Ordered for stable output — two runs over the same input
 * must produce results in the same order, or the determinism property (#10)
 * fails on something as trivial as iteration order.
 */
const GATES: readonly Gate[] = Object.freeze([
  { id: SECRET_ID, version: SECRET_V, run: (t, o) => secretLeakScan(t, o) },
  { id: CLAIM_ID, version: CLAIM_V, run: (t, o) => claimDiscipline(t, o) },
]);

/** Every registered gate, in stable order. */
export function listGates(): readonly Gate[] {
  return GATES;
}

/** Run the full registered set over one input. */
export function runGates(text: string, options: GateOptions = {}): GateResult[] {
  return GATES.map((g) => g.run(text, options));
}

/** Run one gate by id. Throws on an unknown id rather than silently returning nothing. */
export function runGate(id: string, text: string, options: GateOptions = {}): GateResult {
  const gate = GATES.find((g) => g.id === id);
  if (!gate) {
    throw new Error(
      `Unknown gate "${id}". Registered: ${GATES.map((g) => g.id).join(", ")}.`,
    );
  }
  return gate.run(text, options);
}

/**
 * The registered set is 2 of the source linter's 16. The remaining 14 are a port
 * task, not a design task — each is one module and one line here.
 */
export const SOURCE_GATE_COUNT = 16;
