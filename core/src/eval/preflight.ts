/**
 * Everything that must be true before a live run may start — decided in one place.
 *
 * `scripts/run-eval.ts` grew four refusals for the live path: no key, a key whose shape says
 * placeholder, no declared budget, and a budget the plan does not fit. All four are load-bearing
 * (`TRUTH_BOUNDARY.md`, entry `no-model-has-answered`, pins that each exits 2 having spent
 * nothing), and all four were inline in `main()`.
 *
 * That was fine while there was one caller. `--dry-run` makes a second, and a dry run that
 * approves a plan the real run then refuses is worse than no dry run at all — it converts a
 * safety check into a source of false confidence. So the decision moves here and both paths
 * call it. They cannot diverge, because there is nothing to keep in sync.
 *
 * ## This predicts; `admitRun` still enforces
 *
 * The budget verdict below is not a second opinion. It literally calls `plannedCalls` and
 * `admitRun` — the same two functions `runSuite` calls — so "would this be refused?" is
 * answered by the code that does the refusing. `runSuite` still calls `admitRun` itself:
 * a prediction made at the top of `main()` is not an enforcement point, and the enforcement
 * must sit where the spending starts.
 *
 * ## Why `plannedCalls` rather than cases x trials
 *
 * They are not the same number. `plannedCalls` collapses trials to one distinct call when the
 * configuration is deterministic, because trials 2..n of a temperature-0 run are the same
 * request. The evaluation configuration is stochastic today (`temperature: null, seed: null`),
 * so the two happen to agree — but a message that hand-multiplies `cases * trials` would
 * over-state the budget by a factor of `trials` the moment someone pins temperature to 0, and
 * would do it in the sentence telling the operator what to spend.
 *
 * ## No effects, and no environment
 *
 * The key arrives as an argument. Reading `process.env` here would put Core one refactor away
 * from an ambient dependency, and would make this untestable without mutating the host process.
 */

import {
  admitRun, plannedCalls, isDeterministic,
  type Admission, type Budget, type Decoding,
} from "./budget.js";

/**
 * Why this value cannot be a key — or null if nothing rules it out.
 *
 * Moved here from `scripts/run-eval.ts` so the dry run and the live run apply one predicate.
 *
 * It asserts NO vendor format. `sk-ant-` plus a length would fail closed the day either
 * changes, turning a working setup into a refusal the operator cannot act on, and this code
 * has no business knowing a vendor's key layout. It reports only shapes a key can never have:
 * angle brackets, quotes and whitespace mean "you pasted the wrong thing", and they mean it
 * permanently.
 *
 * Observed rather than hypothetical: `setx ANTHROPIC_API_KEY "<your key>"` was run verbatim
 * from a copy-pasted instruction, and a presence-only check waved through a ten-character
 * value whose first character is `<`.
 *
 * The returned reason never contains the value. It is printed to a terminal.
 */
export function implausibleKeyReason(key: string): string | null {
  if (/[<>"'\s]/.test(key)) return "contains a bracket, quote or whitespace";
  if (key.length < 20) return `is ${key.length} characters long`;
  return null;
}

/** Which precondition failed. The Shell owns the wording; this owns the decision. */
export type PreflightReason =
  | "key_missing"
  | "key_implausible"
  | "budget_undeclared"
  | "budget_refused";

/**
 * What the run would cost, whether or not it is allowed to proceed.
 *
 * Present on refusals too. "You have not declared a budget" is far more useful next to the
 * number that budget would have to cover, and a dry run whose refusal hid the figure would
 * send the operator back to guess it.
 */
export interface PreflightPlan {
  caseCount: number;
  trials: number;
  /** Calls per case: `trials` when the configuration is stochastic, 1 when it is not. */
  distinctPerCase: number;
  deterministic: boolean;
  plannedCalls: number;
  /** Null when no budget was declared. */
  maxCalls: number | null;
  /** `admitRun`'s verdict — including its `unenforced` list, which a dry run should surface. */
  admission: Admission;
}

export type PreflightVerdict =
  | { ok: true; plan: PreflightPlan }
  | { ok: false; reason: PreflightReason; detail: string; plan: PreflightPlan };

/**
 * Decide whether a live run may start.
 *
 * Order matters and matches the order the checks were written in: a missing key is reported
 * before a malformed one, and both before the budget, because an operator with no key set has
 * a different next action than one whose budget is too small. Reporting the budget problem
 * first would send them to fix the cheaper thing.
 *
 * A run that is not live is always admitted: the stub spends nothing, needs no key, and has no
 * budget to check. Saying "ok" there is not a waiver, it is the accurate answer.
 */
export function preflight(input: {
  live: boolean;
  key: string | undefined;
  budget: Budget | null | undefined;
  trials: number;
  caseCount: number;
  decoding: Decoding;
}): PreflightVerdict {
  const { live, key, budget, trials, caseCount, decoding } = input;

  const deterministic = isDeterministic(decoding);
  const planned = plannedCalls(caseCount, trials, decoding);
  const admission = admitRun({ budget, plannedCalls: planned });

  const plan: PreflightPlan = {
    caseCount,
    trials,
    distinctPerCase: deterministic ? 1 : Math.max(1, trials),
    deterministic,
    plannedCalls: planned,
    maxCalls: budget?.max_provider_calls ?? null,
    admission,
  };

  if (!live) return { ok: true, plan };

  if (key === undefined || key === "") {
    return { ok: false, reason: "key_missing", detail: "ANTHROPIC_API_KEY is not set", plan };
  }

  const implausible = implausibleKeyReason(key);
  if (implausible !== null) {
    return { ok: false, reason: "key_implausible", detail: implausible, plan };
  }

  /**
   * No budget is a refusal for a live run, not a default.
   *
   * `admitRun` admits everything when `budget` is null — deliberately, since a null budget is
   * how every offline path runs. That makes it the wrong place to require one, and it is why
   * the requirement lives here: without it the first real run would have been the unbounded
   * one, admitted by a guard that was working exactly as specified.
   *
   * There is no default on purpose. A generous default and a stingy one are both defensible,
   * so choosing either for the operator is the bug.
   */
  if (budget === null || budget === undefined) {
    return {
      ok: false,
      reason: "budget_undeclared",
      detail: `up to ${planned} provider call(s) with nothing able to stop them`,
      plan,
    };
  }

  if (!admission.admit) {
    return { ok: false, reason: "budget_refused", detail: admission.reason, plan };
  }

  return { ok: true, plan };
}
