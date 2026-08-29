/**
 * Cost as a correctness constraint, and the cache key that is sound to use.
 *
 * Pure. Every function here is a decision about work that has not happened yet, which is
 * why it belongs in Core: the Application spends the budget, this decides whether it may.
 *
 * ── Why budget is not a metric ───────────────────────────────────────────────
 *
 * The recorded failure is that cost-driven degradation — token truncation, fallback to a
 * weaker model, aggressive caching — degrades correctness *without triggering any alert*.
 * A budget observed after the fact is a number in a report; a budget enforced before
 * dispatch is the alert. `eval-run.cost.budget_exceeded` has been a required field since
 * the schema landed and has always been the literal `false`, because nothing could enforce
 * it. This is what makes it capable of being true.
 *
 * ── The cache key, and a correction to ADR-0008 ──────────────────────────────
 *
 * ADR-0008 specifies the cache key as `(config_hash, case_hash)` and says that key "is what
 * makes 100-trial protocols affordable". Both halves cannot hold at once.
 *
 * A repeated-trial protocol exists because decoding is stochastic — the corpus form is 100
 * trials per condition at temperature 0.7, and the point is to estimate the spread. Keyed on
 * `(config, case)` alone, trials 2..100 are cache hits of trial 1: one sample reported as a
 * hundred, with a measured variance of exactly zero and a confident interval around it. The
 * cache would not make the protocol affordable, it would make it not a protocol.
 *
 * So the key includes the trial index whenever the configuration is stochastic, and omits it
 * only when the configuration is deterministic — temperature 0, or a null temperature with a
 * seed — where every trial genuinely is the same call and a lookup is honest. Caching then
 * pays across *runs* rather than across trials, which is still most of the benefit: re-running
 * yesterday's suite against an unchanged configuration is free either way.
 *
 * This is the same shape as the detector-recall finding one layer up: an instrument whose
 * sensitivity depends on the configuration will invert the conclusion. Here the instrument is
 * the cache.
 */

/** What a Configuration declares it may spend. Absent means no budget was declared. */
export interface Budget {
  max_provider_calls?: number | null;
  max_usd?: number | null;
  /**
   * Both behaviours are defensible, so neither is a default. A silent choice between
   * "stop before starting" and "run what fits" is the failure mode.
   */
  on_exceed: "refuse" | "truncate_suite";
}

export interface Decoding {
  temperature: number | null;
  seed?: number | null;
}

export interface CostBlock {
  tokens_in: number;
  tokens_out: number;
  provider_calls: number;
  cache_hits: number;
  usd: number | null;
  budget_exceeded: boolean;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cache_read_tokens?: number;
}

export const emptyCost = (): CostBlock => ({
  tokens_in: 0, tokens_out: 0, provider_calls: 0, cache_hits: 0, usd: 0, budget_exceeded: false,
});

/**
 * True when repeating the same request must produce the same answer.
 *
 * Temperature 0 is deterministic. A null temperature is NOT: it records that the provider
 * deprecated the parameter, which newer frontier models have done, and a deprecated
 * parameter is not a promise of greedy decoding — it is the absence of a control. Only a
 * null temperature paired with an explicit seed is treated as reproducible, and even that
 * is a claim about the provider rather than a guarantee from it.
 */
export function isDeterministic(decoding: Decoding): boolean {
  if (decoding.temperature === 0) return true;
  if (decoding.temperature === null) return decoding.seed !== null && decoding.seed !== undefined;
  return false;
}

/**
 * The key a cached generation is stored under.
 *
 * `trial` is part of the key exactly when the configuration is stochastic. Callers do not
 * choose this — passing a trial index that gets ignored is how the two policies would drift
 * apart.
 */
export function cacheKey(
  configuration_id: string,
  case_id: string,
  trial: number,
  decoding: Decoding,
): string {
  return isDeterministic(decoding)
    ? `${configuration_id}:${case_id}`
    : `${configuration_id}:${case_id}:t${trial}`;
}

/**
 * How many provider calls a run needs in the worst case — nothing cached.
 *
 * Budget is checked against this rather than against an expectation of cache hits. A budget
 * that assumes the cache is warm authorises a spend it cannot bound on a cold one, and the
 * cold run is exactly the one after a configuration changes.
 */
export function plannedCalls(caseCount: number, trials: number, decoding: Decoding): number {
  const distinct = isDeterministic(decoding) ? 1 : Math.max(1, trials);
  return Math.max(0, caseCount) * distinct;
}

/**
 * How many provider calls an eleven-stage pipeline run needs in the worst case.
 *
 * Derived from the plan actually selected rather than from a nominal eleven: `planForContext`
 * returns six stages at TINY and eleven at STANDARD, and a budget sized against the wrong one
 * is either useless or wrong in the expensive direction.
 *
 * The feedback term is derived too. A round resumes at `refine` and the runner walks forward
 * until `lint` routes it straight back, so a round re-executes exactly the slice
 * `[resumeAt..haltAt]` — MEASURED, not read: at caps of 0/1/2/3 rounds an eleven-stage run
 * performs 11/13/15/17 stage executions and 8/9/10/11 provider calls, which is one generating
 * execution per round. Counting the slice rather than hard-coding 1 means inserting a
 * generating stage between `refine` and `lint` changes the bound instead of silently
 * invalidating it.
 *
 * `maxAttempts` multiplies, because a retry is another provider call. This is an upper bound
 * and is meant to be loose: stages skip (a clean critique skips `refine`), so a real run costs
 * less. A budget must bound the worst case or it is not a bound.
 */
export function plannedPipelineCalls(input: {
  plan: readonly { id: string; kind: "generating" | "deterministic" }[];
  feedbackRounds?: number;
  maxAttempts?: number;
  resumeAt?: string;
  haltAt?: string;
}): number {
  const { plan } = input;
  const attempts = Math.max(1, Math.floor(input.maxAttempts ?? 1));
  const rounds = Math.max(0, Math.floor(input.feedbackRounds ?? 0));
  const generating = plan.filter((s) => s.kind === "generating").length;

  const from = plan.findIndex((s) => s.id === (input.resumeAt ?? "refine"));
  const to = plan.findIndex((s) => s.id === (input.haltAt ?? "lint"));
  // A plan omitting either end permits no rounds at all — the same condition
  // `decideGateFeedback` refuses on ("this depth plan omits refine or lint").
  const perRound = from === -1 || to === -1 || to < from
    ? 0
    : plan.slice(from, to + 1).filter((s) => s.kind === "generating").length;

  return (generating + rounds * perRound) * attempts;
}

export interface Admission {
  admit: boolean;
  /** Present whether or not admitted — "why it ran" is as auditable as "why it did not". */
  reason: string;
  /** For `truncate_suite`: how many calls may be made. Equals plannedCalls when admitted whole. */
  allowedCalls: number;
  /**
   * Caps that were DECLARED and could not be checked. Empty on every path that checked
   * everything it was given.
   *
   * `max_usd` is the one that populates it today, and it does so on every run: no caller
   * passes `estimatedUsd`, and `runSuite` is never given a token rate either, so `cost.usd`
   * is null as well. A dollar cap is therefore declared, stored in the hashed Configuration,
   * and enforced by nothing at either end. The old admission reported that as
   * "within budget", which is the failure this field exists to end — a caller can now say
   * which half of the budget was actually applied, instead of inferring it from silence.
   */
  unenforced: string[];
}

/**
 * Decide whether a run may start, before anything is spent.
 *
 * Refusing up front rather than stopping midway is deliberate: a partially executed suite is
 * not an `EvalRun`. Its aggregate would be computed over whichever cases happened to fit,
 * which is a score for a suite nobody defined, reported under the name of one that exists.
 */
export function admitRun(input: {
  budget?: Budget | null;
  plannedCalls: number;
  estimatedUsd?: number | null;
}): Admission {
  const { budget, plannedCalls: calls } = input;
  if (!budget) {
    return { admit: true, reason: "no budget declared", allowedCalls: calls, unenforced: [] };
  }

  const callCap = budget.max_provider_calls ?? null;
  const usdCap = budget.max_usd ?? null;
  const estimated = input.estimatedUsd ?? null;

  const overCalls = callCap !== null && calls > callCap;
  const overUsd = usdCap !== null && estimated !== null && estimated > usdCap;

  /**
   * A declared dollar cap with nothing to compare it against is NOT "within budget".
   *
   * The admission still admits — refusing on an unknown would block every run against a
   * provider that reports no usage, and `core/test/eval.test.ts` has pinned that since the
   * function landed. What changes is that the caller is told. The old reason said
   * "within budget (1 call(s))" for a run whose only declared cap had not been examined,
   * and that sentence is the difference between a fail-open somebody chose and a fail-open
   * nobody knew about.
   */
  const unenforced = usdCap !== null && estimated === null
    ? [`max_usd ${usdCap} — no cost estimate was supplied, so the dollar cap was not checked`]
    : [];

  if (!overCalls && !overUsd) {
    const within = `within budget (${calls} call(s)${callCap === null ? "" : ` of ${callCap}`})`;
    return {
      admit: true,
      reason: unenforced.length === 0 ? within : `${within}; UNENFORCED: ${unenforced.join("; ")}`,
      allowedCalls: calls,
      unenforced,
    };
  }

  const detail = [
    overCalls ? `${calls} planned call(s) exceeds max_provider_calls ${callCap}` : null,
    overUsd ? `estimated $${estimated} exceeds max_usd ${usdCap}` : null,
  ].filter(Boolean).join("; ");

  /**
   * `truncate_suite` refuses, because truncation is not implemented.
   *
   * It used to return `admit: true` with a reduced `allowedCalls`, and `application/src/eval.ts`
   * referenced `allowedCalls` ZERO times — so declaring `on_exceed: "truncate_suite"` ran the
   * WHOLE suite with the cap ignored. A cap that is returned and disregarded is worse than one
   * that does not exist, because it reads as enforced: the field's own schema description says
   * a budget is "enforced BEFORE dispatch rather than observed after".
   *
   * Refusing is the conservative half of a choice this file's header says must never be made
   * silently, and it is reversible. Implementing truncation honestly is not a matter of
   * slicing the case list: the resulting aggregate would be a score over whichever cases fit,
   * published under the `suite_id` of a suite that means something else. It needs `EvalRun` to
   * record that it was truncated and over what — a contract change, landing before the code
   * per ADR-0002. Until then this says so rather than pretending.
   */
  if (budget.on_exceed === "truncate_suite") {
    return {
      admit: false,
      reason:
        `refused before dispatch: ${detail}. ` +
        `on_exceed is "truncate_suite", but truncation is not implemented — ${callCap ?? 0} call(s) ` +
        `would fit. Admitting here ran the whole suite with the cap ignored. Use "refuse", or ` +
        `run a smaller suite.`,
      allowedCalls: 0,
      unenforced,
    };
  }
  return { admit: false, reason: `refused before dispatch: ${detail}`, allowedCalls: 0, unenforced };
}

export interface TokenRate {
  /** USD per million input tokens. */
  in: number;
  /** USD per million output tokens. */
  out: number;
}

/**
 * A rate must be a finite, non-negative number in both directions.
 *
 * Unvalidated, a negative rate makes `usd` negative, and `exceeds` then compares a negative
 * number against a positive cap and reports false — the more the run spends, the further
 * under budget it looks. `NaN` is worse in the same direction: every comparison against it is
 * false, so `exceeds` returns false and `admitRun` sees an estimate that is not null and not
 * over. Both defeat the cap while leaving a dollar figure in the report.
 *
 * Throwing rather than clamping is deliberate. A rate arrives from a caller's price table, so
 * a bad one is a configuration error to fix, not a runtime condition to absorb — and clamping
 * to zero would report a real run as free. Core is pure, not total; `fillTemplate` already
 * throws on a template it cannot satisfy.
 */
export function assertValidRate(rate: TokenRate): TokenRate {
  for (const dir of ["in", "out"] as const) {
    const v = rate[dir];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(
        `token rate '${dir}' must be a finite, non-negative number (USD per million tokens); got ${String(v)}. ` +
        `An unchecked rate defeats max_usd silently: a negative rate makes spend look like credit, ` +
        `and NaN makes every budget comparison false.`,
      );
    }
  }
  return rate;
}

/** Fold one provider response into the running cost. `rate` is USD per million tokens. */
export function accrue(
  cost: CostBlock,
  usage: Usage | undefined,
  rate?: TokenRate | null,
): CostBlock {
  if (rate) assertValidRate(rate);
  const tokens_in = cost.tokens_in + (usage?.prompt_tokens ?? 0);
  const tokens_out = cost.tokens_out + (usage?.completion_tokens ?? 0);
  return {
    ...cost,
    tokens_in,
    tokens_out,
    provider_calls: cost.provider_calls + 1,
    // A run whose provider reported no usage must not report a dollar figure. Zero would
    // read as free; null reads as unmeasured, and those take different paths downstream.
    usd: rate ? (tokens_in / 1e6) * rate.in + (tokens_out / 1e6) * rate.out : null,
  };
}

/** Record a cache hit. Deliberately does not touch provider_calls — nothing was called. */
export const hit = (cost: CostBlock): CostBlock => ({ ...cost, cache_hits: cost.cache_hits + 1 });

/** Whether the spend so far has passed what was declared. */
export function exceeds(cost: CostBlock, budget?: Budget | null): boolean {
  if (!budget) return false;
  if (budget.max_provider_calls != null && cost.provider_calls > budget.max_provider_calls) return true;
  if (budget.max_usd != null && cost.usd != null && cost.usd > budget.max_usd) return true;
  return false;
}
