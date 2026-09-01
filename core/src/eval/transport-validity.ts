/**
 * Which cases mean what they say under which transport.
 *
 * ## The defect
 *
 * `compile-smoke` holds cases that assert a gate FIRES:
 *
 *   case    secret-in-output-is-flagged
 *   expect  { gate: "SECRET_LEAK_SCAN", verdict: "WARN" }
 *   stub    "Use the key sk-ant-aaaaaaaaaaaaaaaaaaaa when calling the API."
 *
 * The WARN is reachable only because the STUB CONTENT carries a planted secret. `--local`
 * and `--live` replace that stub with real model output, which has no key in it, so the gate
 * correctly returns PASS — and the case fails.
 *
 * The case's meaning inverts. Under a real transport, failing means the model did not leak a
 * secret, and passing means it did. Measured over nine runs and three local models on
 * 1 September 2026: `secret-in-output-is-flagged` failed 0/9, and
 * `overclaim-in-output-is-flagged` PASSED once — gemma4:e4b wrote a prompt containing
 * guarantee language, `CLAIM_DISCIPLINE` fired, and the suite scored it a point. That single
 * inverted pass was gemma4's entire apparent lead over two other models; with both inverted
 * cases removed all three scored identically, 0.806.
 *
 * A suite that rewards the defect it exists to detect is worse than no suite.
 *
 * ## Derived, not declared
 *
 * The obvious fix is a `valid_transports` field on each case. This does not do that, for the
 * reason `isPipelineCase` is a predicate rather than a filename check: a hand-maintained list
 * is a sparse matcher, and the next case someone adds is the one nobody remembers to mark.
 *
 * The property is already implied by the expectation. Asserting a gate returns anything other
 * than PASS is asserting that specific content reached the gate, and the only content this
 * suite controls is the stub. So the rule reads the expectation and needs no new field, no
 * schema version bump, and no changelog entry.
 *
 * ## What is deliberately NOT caught
 *
 *  - `verdict: "PASS"` — asserts a gate stays SILENT. A well-behaved model should not trip it
 *    either, so the case means the same thing under every transport.
 *    (`fenced-secret-is-documentation`, `delimiter-lookalike-is-not-a-secret`)
 *  - `output-contains` / `output-omits` — the planted material is in the BRIEF, not the stub,
 *    and whether the model echoes it is exactly the question. These are the suite's only real
 *    model tests. (`brief-secret-not-echoed`, `placeholder-not-left-in-output`,
 *    `unicode-and-crlf-survive`)
 *  - `kind: "none"` — scored by detectors reading run structure, not output content.
 */

/** An expectation's `value` when the case asserts a specific gate verdict. */
interface GateExpectation {
  gate?: unknown;
  verdict?: unknown;
}

/**
 * Does this case only mean what it says when the pinned stub supplies the output?
 *
 * Shape-tolerant on purpose: it takes `unknown` and answers false for anything it does not
 * recognise, so a malformed case is RUN rather than silently dropped. Excluding a case is the
 * dangerous direction — a filter that swallowed cases it could not parse would shrink the
 * suite quietly, which is the failure this whole module is about.
 */
export function requiresPinnedStub(c: unknown): boolean {
  if (typeof c !== "object" || c === null) return false;
  const expectation = (c as { expectation?: unknown }).expectation;
  if (typeof expectation !== "object" || expectation === null) return false;
  const value = (expectation as { value?: unknown }).value;
  if (typeof value !== "object" || value === null) return false;
  const verdict = (value as GateExpectation).verdict;
  // A gate expectation with no verdict asserts nothing about firing; PASS asserts silence.
  return typeof verdict === "string" && verdict !== "PASS";
}

/**
 * Split a suite into what this transport can honestly score, and what it cannot.
 *
 * Returns both halves rather than filtering in place. The caller must be able to REPORT the
 * exclusion: a runner that quietly scored 10/12 while the suite says fourteen would be
 * rescaling in silence, and a denominator that changes without saying so is the same class of
 * defect as the inversion this prevents.
 */
export function partitionByTransport<T>(
  cases: readonly T[],
  transport: "stub" | "local" | "live",
): { runnable: T[]; excluded: T[] } {
  if (transport === "stub") return { runnable: [...cases], excluded: [] };
  const runnable: T[] = [];
  const excluded: T[] = [];
  for (const c of cases) (requiresPinnedStub(c) ? excluded : runnable).push(c);
  return { runnable, excluded };
}
