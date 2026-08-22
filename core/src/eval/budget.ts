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

export interface Admission {
  admit: boolean;
  /** Present whether or not admitted — "why it ran" is as auditable as "why it did not". */
  reason: string;
  /** For `truncate_suite`: how many calls may be made. Equals plannedCalls when admitted whole. */
  allowedCalls: number;
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
    return { admit: true, reason: "no budget declared", allowedCalls: calls };
  }

  const callCap = budget.max_provider_calls ?? null;
  const usdCap = budget.max_usd ?? null;
  const estimated = input.estimatedUsd ?? null;

  const overCalls = callCap !== null && calls > callCap;
  const overUsd = usdCap !== null && estimated !== null && estimated > usdCap;

  if (!overCalls && !overUsd) {
    return {
      admit: true,
      reason: `within budget (${calls} call(s)${callCap === null ? "" : ` of ${callCap}`})`,
      allowedCalls: calls,
    };
  }

  const detail = [
    overCalls ? `${calls} planned call(s) exceeds max_provider_calls ${callCap}` : null,
    overUsd ? `estimated $${estimated} exceeds max_usd ${usdCap}` : null,
  ].filter(Boolean).join("; ");

  if (budget.on_exceed === "truncate_suite") {
    return {
      admit: true,
      reason: `over budget, truncating: ${detail}`,
      allowedCalls: callCap ?? 0,
    };
  }
  return { admit: false, reason: `refused before dispatch: ${detail}`, allowedCalls: 0 };
}

/** Fold one provider response into the running cost. `rate` is USD per million tokens. */
export function accrue(
  cost: CostBlock,
  usage: Usage | undefined,
  rate?: { in: number; out: number } | null,
): CostBlock {
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
