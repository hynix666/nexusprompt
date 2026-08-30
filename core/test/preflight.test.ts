import { describe, it, expect } from "vitest";
import { preflight, implausibleKeyReason } from "../src/eval/preflight.js";
import { admitRun, plannedCalls, type Budget, type Decoding } from "../src/eval/budget.js";

/**
 * The live-run preconditions, now that `--dry-run` gives them a second caller.
 *
 * The property under test is not "does each check fire" — those existed inline and were
 * covered. It is that ONE function answers for both callers, so a dry run cannot approve a
 * plan the live run then refuses. That failure mode is worse than having no dry run: it turns
 * a safety check into a source of confidence about something nobody checked.
 */

const STOCHASTIC: Decoding = { temperature: null, seed: null };
const DETERMINISTIC: Decoding = { temperature: 0, seed: null };
const GOOD_KEY = `sk-ant-api03-${"a".repeat(90)}`;
const budget = (max: number): Budget => ({
  max_provider_calls: max, max_usd: null, on_exceed: "refuse",
});

const base = {
  transport: "live" as import("../src/eval/preflight.js").Transport,
  key: GOOD_KEY as string | undefined,
  budget: budget(100) as Budget | null | undefined,
  trials: 1,
  caseCount: 14,
  decoding: STOCHASTIC,
};

describe("preflight — must fire", () => {
  it("refuses a live run with no key", () => {
    const v = preflight({ ...base, key: undefined });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("key_missing");
  });

  it("treats an empty key as missing, not as present-and-odd", () => {
    // `!process.env.ANTHROPIC_API_KEY` was the original test, so "" took the missing branch.
    // A strict `=== undefined` would have moved it to `key_implausible` and told the operator
    // their key was malformed when they had never set one.
    const v = preflight({ ...base, key: "" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("key_missing");
  });

  it("refuses a key whose shape says placeholder", () => {
    const v = preflight({ ...base, key: "<your key>" });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("key_implausible");
      expect(v.detail).toBe("contains a bracket, quote or whitespace");
    }
  });

  it("refuses a live run with no declared budget", () => {
    const v = preflight({ ...base, budget: null });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("budget_undeclared");
  });

  it("refuses a plan that does not fit its budget", () => {
    const v = preflight({ ...base, trials: 100, budget: budget(50) });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("budget_refused");
  });
});

describe("preflight — must NOT fire", () => {
  it("admits a well-formed live run", () => {
    expect(preflight(base).ok).toBe(true);
  });

  it("admits every offline run, whatever the key and budget look like", () => {
    // A stubbed run spends nothing, reads no key and has no budget to check. Refusing one for
    // a missing key would make `npm run eval` require a credential to run offline, which is
    // the opposite of what the stub is for.
    for (const key of [undefined, "", "<your key>", GOOD_KEY]) {
      const v = preflight({ ...base, transport: "stub", key, budget: null });
      expect(v.ok, `offline with key ${JSON.stringify(key)}`).toBe(true);
    }
  });

  it("admits a plan exactly at the cap", () => {
    // Off-by-one in the expensive direction: `>=` here would refuse a run the budget covers.
    const v = preflight({ ...base, trials: 1, budget: budget(14) });
    expect(v.ok).toBe(true);
    expect(v.plan.plannedCalls).toBe(14);
  });
});

describe("preflight — the plan it reports", () => {
  it("counts a stochastic run as cases x trials", () => {
    expect(preflight({ ...base, trials: 100, budget: budget(9999) }).plan.plannedCalls).toBe(1400);
  });

  /**
   * The number a hand-written message gets wrong.
   *
   * `run-eval.ts` used to suggest `--max-calls ${case_ids.length * TRIALS}` in its
   * no-budget refusal. That happens to be right for the current configuration, which is
   * stochastic — but pin `temperature: 0` and trials 2..n become cache hits of trial 1, so
   * the suggested budget is 100x the real one. In the sentence telling the operator what to
   * authorise.
   */
  it("collapses trials to one call per case when decoding is deterministic", () => {
    const v = preflight({ ...base, trials: 100, decoding: DETERMINISTIC, budget: budget(9999) });
    expect(v.plan.plannedCalls).toBe(14);
    expect(v.plan.distinctPerCase).toBe(1);
    expect(v.plan.deterministic).toBe(true);
  });

  it("reports the plan on refusals too, not only on approval", () => {
    // "You have not declared a budget" is far more useful beside the number that budget has
    // to cover. Hiding it sends the operator away to guess.
    const v = preflight({ ...base, trials: 7, budget: null });
    expect(v.ok).toBe(false);
    expect(v.plan.plannedCalls).toBe(98);
  });

  it("surfaces a declared cap that could not be checked", () => {
    // `max_usd` is enforced by nothing — no caller supplies a cost estimate. A dry run that
    // printed "within budget" for a dollar cap nobody examined would be the exact fail-open
    // `Admission.unenforced` exists to end.
    const v = preflight({
      ...base,
      budget: { max_provider_calls: 100, max_usd: 5, on_exceed: "refuse" },
    });
    expect(v.ok).toBe(true);
    expect(v.plan.admission.unenforced).toHaveLength(1);
    expect(v.plan.admission.unenforced[0]).toContain("max_usd");
  });
});

describe("preflight — ordering and agreement", () => {
  it("reports a missing key before a budget problem", () => {
    // Both are wrong here. Reporting the budget first would send someone to pick a number
    // when the thing they actually have to do is set a credential.
    const v = preflight({ ...base, key: undefined, budget: null });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("key_missing");
  });

  /**
   * The anti-divergence property, asserted rather than assumed.
   *
   * `runSuite` decides with `admitRun(plannedCalls(...))`. If preflight reached its budget
   * verdict any other way, a dry run could approve what the real run refuses. This asserts
   * they agree across a grid rather than trusting that they call the same functions today.
   */
  it("never approves a budget that admitRun would refuse", () => {
    for (const caseCount of [0, 1, 14, 4906]) {
      for (const trials of [1, 3, 100]) {
        for (const cap of [1, 14, 100, 1400, 9999]) {
          for (const decoding of [STOCHASTIC, DETERMINISTIC]) {
            const b = budget(cap);
            const v = preflight({ transport: "live", key: GOOD_KEY, budget: b, trials, caseCount, decoding });
            const truth = admitRun({
              budget: b,
              plannedCalls: plannedCalls(caseCount, trials, decoding),
            });
            expect(v.ok, `${caseCount}x${trials} cap ${cap}`).toBe(truth.admit);
          }
        }
      }
    }
  });
});

describe("implausibleKeyReason", () => {
  it("never returns the key itself", () => {
    // The reason is printed to a terminal. This is the one careless log line the whole key
    // discipline exists to prevent, so it is asserted where the function now lives.
    const secretish = `sk-ant-api03-DEADBEEF-not-real-but-long-enough-${"z".repeat(40)}`;
    for (const k of [secretish, "<your key>", "short"]) {
      expect(implausibleKeyReason(k) ?? "").not.toContain(k);
    }
  });
});
