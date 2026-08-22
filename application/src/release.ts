/**
 * Pipeline C — release, the effectful half.
 *
 * Core decides (`core/src/release/promote.ts`); this reads the evidence, performs the write,
 * and repoints the label. `decide → invoke → reduce` with the decision upstream, so the
 * question "would this have been promoted?" is answerable without a store.
 *
 * ── Why every input is fetched rather than passed ────────────────────────────
 *
 * `promote` takes ids and reads the artifacts, instead of taking the artifacts. A caller who
 * could hand in a `Comparison` object could hand in one that was never stored — and the whole
 * point of the evidence plane is that a promotion names records anyone can go and read. The
 * pointers in a `Promotion` are only worth something if the promotion was decided from what
 * those pointers actually resolve to.
 *
 * ── Immutability, and what it costs here ─────────────────────────────────────
 *
 * `EvidenceStore` has no `update`. That is why `Baseline.supersedes` points backwards from
 * the new record instead of forwards from the old one, and why "what is current?" is a query
 * — `current()` walks the promotion list — rather than a field someone maintains. A pointer
 * that has to be maintained is a pointer that drifts.
 */

import type {
  Baseline, Comparison, EvalRun, EvidenceStore, Promotion,
} from "../../contracts/index.js";
import { decidePromotion, rollbackOf } from "../../core/src/release/promote.js";
import type { PromotionDecision, PromotionRefusal } from "../../core/src/release/promote.js";
import type { JudgeAdmission } from "../../core/src/eval/judge-policy.js";

export class EvidenceMissing extends Error {
  constructor(readonly kind: string, readonly id: string) {
    super(`No ${kind} in the evidence plane with id "${id}". A promotion cannot name a record that is not there.`);
    this.name = "EvidenceMissing";
  }
}

async function load<T>(store: EvidenceStore, kind: Parameters<EvidenceStore["get"]>[0], id: string): Promise<T> {
  const rec = await store.get(kind, id);
  if (!rec) throw new EvidenceMissing(kind, id);
  return rec.body as T;
}

export interface FreezeBaselineInput {
  baseline_id: string;
  run_id: string;
  /**
   * `benchmark` may certify a promotion; `development` may not. Required, with no default:
   * a baseline that quietly defaults to the certifying lineage is how an optimizer ends up
   * able to promote its own candidate.
   */
  lineage: Baseline["lineage"];
  frozen_at: string;
  supersedes?: string | null;
}

/** Freeze a run as a reference. The run must already be in the evidence plane. */
export async function freezeBaseline(
  store: EvidenceStore,
  input: FreezeBaselineInput,
): Promise<Baseline> {
  const run = await load<EvalRun>(store, "eval-run", input.run_id);
  const baseline: Baseline = {
    baseline_id: input.baseline_id,
    configuration_id: run.configuration_id,
    run_id: run.run_id,
    frozen_at: input.frozen_at,
    lineage: input.lineage,
    supersedes: input.supersedes ?? null,
  };
  await store.put({
    kind: "baseline", id: baseline.baseline_id, created_at: input.frozen_at, body: baseline,
  });
  return baseline;
}

export interface PromoteInput {
  promotion_id: string;
  run_id: string;
  baseline_id: string;
  comparison_id: string;
  promoted_at: string;
  promoted_by: string;
  /** Score granularity of the suite the run used — the per-mode regression threshold. */
  suiteGranularity: number;
  /** Supplied when the run was judged. Whether it WAS is read from the run, not from this. */
  judge?: JudgeAdmission | null;
  /** What the promotion claims. Absent means quality; "cost" is refused, with the reason. */
  justification?: "quality" | "cost";
  supersedes?: string | null;
}

export interface PromoteResult {
  decision: PromotionDecision;
  /** Written only when the decision promoted. A refusal leaves no record in the store. */
  promotion: Promotion | null;
  refusals: PromotionRefusal[];
}

/**
 * Decide, and write the record only if it holds.
 *
 * A refusal writes nothing. That is deliberate and worth stating, because the opposite is
 * defensible too: recording refused attempts would make "how many times did we try?" a
 * question the plane could answer. It is not done here because a refusal is not evidence
 * about a configuration — it is evidence about an attempt — and mixing the two would put
 * records into the promotion list that a `current()` walk would have to learn to skip.
 * Refusals are returned to the caller, which is where the decision to log them belongs.
 */
export async function promote(store: EvidenceStore, input: PromoteInput): Promise<PromoteResult> {
  const [candidateRun, baseline, comparison] = await Promise.all([
    load<EvalRun>(store, "eval-run", input.run_id),
    load<Baseline>(store, "baseline", input.baseline_id),
    load<Comparison>(store, "comparison", input.comparison_id),
  ]);
  const baselineRun = await load<EvalRun>(store, "eval-run", baseline.run_id);

  const decision = decidePromotion({
    promotion_id: input.promotion_id,
    promoted_at: input.promoted_at,
    promoted_by: input.promoted_by,
    candidateRun,
    baselineRun,
    baseline,
    comparison,
    judge: input.judge ?? null,
    justification: input.justification,
    suiteGranularity: input.suiteGranularity,
    supersedes: input.supersedes ?? null,
  });

  if (!decision.promoted || !decision.promotion) {
    return { decision, promotion: null, refusals: decision.refusals };
  }

  await store.put({
    kind: "promotion",
    id: decision.promotion.promotion_id,
    created_at: input.promoted_at,
    body: decision.promotion,
  });
  return { decision, promotion: decision.promotion, refusals: [] };
}

/**
 * Undo a promotion by writing its reverse.
 *
 * No conditions are re-evaluated: restoring a configuration that was already shipped is
 * always allowed. Requiring evidence to go back would mean a bad promotion could not be
 * undone without first producing the evidence that would have prevented it — which is the
 * moment you least want a gate in the way.
 */
export async function rollback(
  store: EvidenceStore,
  input: { promotion_id: string; reverses: string; promoted_at: string; promoted_by: string },
): Promise<Promotion> {
  const original = await load<Promotion>(store, "promotion", input.reverses);
  const record = rollbackOf(original, {
    promotion_id: input.promotion_id,
    promoted_at: input.promoted_at,
    promoted_by: input.promoted_by,
  });
  await store.put({
    kind: "promotion", id: record.promotion_id, created_at: input.promoted_at, body: record,
  });
  return record;
}

/**
 * What is current, computed rather than stored.
 *
 * The newest promotion record wins, and a rollback is a record like any other — so undoing
 * a promotion makes the configuration it reverted current again without editing anything.
 * Returns null when nothing has ever been promoted, which is the honest answer here today.
 */
export async function current(store: EvidenceStore): Promise<Promotion | null> {
  const [newest] = await store.list("promotion", { limit: 1 });
  if (!newest) return null;
  return load<Promotion>(store, "promotion", newest.id);
}
