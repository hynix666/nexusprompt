/**
 * Orchestrates one judge-scored provider comparison pilot: for each brief, runs a real
 * pipeline through two models, judges each compiled prompt with the existing GuardedJudge
 * (via judgeBundle, unchanged), pairs the resulting scores by brief, and compares them with
 * compareGraded. Owns the one live effect this needs beyond what judgeBundle already owns:
 * looping over briefs and models and writing the resulting Comparison as evidence.
 *
 * ── Why run-then-judge per brief, not run-everything then judge-everything ──────────────
 *
 * `LocalRevisionStore` keeps only eight complete run bundles per store and evicts the rest —
 * see CLAUDE.md, "Local storage retains run bundles, not entries." A real pilot writes 200
 * run bundles (100 briefs x 2 models). Running all 200 first and judging afterward would
 * evict most of them, silently, before they were ever read — the eviction is invisible from
 * the caller's side, so the failure would look like missing content refs, not like the actual
 * cause. Judging a run immediately after it completes, before moving to the next brief, means
 * at most one or two un-judged bundles exist in a store at any moment — always far under the
 * cap regardless of its exact eviction policy. See judge-pilot.test.ts's cap-survival test.
 *
 * ── Why candidate and baseline share one store, distinguished by run_id ─────────────────
 *
 * Content is already shared by hash across runs and never evicted by count, so there is
 * nothing to gain by splitting it. Revisions are namespaced by run_id
 * (`${case_id}-candidate` / `${case_id}-baseline`), which is enough to keep the two models'
 * revisions from ever landing in the same bundle — the actual hazard a shared store would
 * otherwise create — while still needing only one directory to wire.
 */
import { randomUUID } from "node:crypto";
import { runPipeline } from "./pipeline.js";
import { judgeBundle, JudgeBundleRefused } from "./judge-bundle.js";
import { compareGraded, isGradedSuite, type GradedCaseOutcome } from "../../core/src/eval/compare-graded.js";
import type { Calibration } from "../../core/src/eval/judge-policy.js";
import type {
  ProviderTransport, RevisionStore, ContentStore, EvidenceStore, JudgeTransport, Comparison,
} from "../../contracts/index.js";

export interface JudgePilotBrief {
  case_id: string;
  brief: string;
}

export interface JudgePilotDeps {
  candidateProvider: ProviderTransport;
  baselineProvider: ProviderTransport;
  revisions: RevisionStore;
  content: ContentStore;
  evidence: EvidenceStore;
  transport: JudgeTransport;
  calibration: Calibration;
  now: () => Date;
  coreBuildHash: string;
}

export interface JudgePilotResult {
  comparison: Comparison;
  survived_n: number;
  nominal_n: number;
  dropped: Array<{ case_id: string; reason: string }>;
}

async function gradeOneSide(
  deps: JudgePilotDeps,
  provider: ProviderTransport,
  run_id: string,
  brief: string,
  nowIso: string,
): Promise<number> {
  await runPipeline(
    {
      command_id: `${run_id}-cmd`, run_id, stage_id: "deconstruct",
      input: { brief }, context: { depth: "TINY", stakes: "LOW" },
    },
    {
      provider, store: deps.revisions, content: deps.content,
      sink: { emit: () => {} }, now: deps.now, coreBuildHash: deps.coreBuildHash,
    },
  );
  const judgement = await judgeBundle(
    {
      revisions: deps.revisions, content: deps.content,
      evidence: deps.evidence, transport: deps.transport, calibration: deps.calibration,
    },
    run_id, nowIso,
  );
  if (typeof judgement.verdict.verdict !== "number") {
    throw new JudgeBundleRefused(
      "non-numeric-verdict",
      `Run "${run_id}" was judged with a non-numeric verdict (${typeof judgement.verdict.verdict}); ` +
      `the brief-fidelity rubric always produces a number — this indicates a different rubric ran.`,
    );
  }
  return judgement.verdict.verdict;
}

export async function runJudgePilot(
  deps: JudgePilotDeps,
  briefs: readonly JudgePilotBrief[],
): Promise<JudgePilotResult> {
  const candidateScores: GradedCaseOutcome[] = [];
  const baselineScores: GradedCaseOutcome[] = [];
  const dropped: Array<{ case_id: string; reason: string }> = [];

  for (const { case_id, brief } of briefs) {
    const nowIso = deps.now().toISOString();
    let candidateScore: number;
    let baselineScore: number;

    try {
      candidateScore = await gradeOneSide(
        deps, deps.candidateProvider, `${case_id}-candidate`, brief, nowIso,
      );
    } catch (err) {
      const reason = err instanceof JudgeBundleRefused ? err.code : (err as Error).message;
      dropped.push({ case_id, reason: `candidate: ${reason}` });
      continue;
    }

    try {
      baselineScore = await gradeOneSide(
        deps, deps.baselineProvider, `${case_id}-baseline`, brief, nowIso,
      );
    } catch (err) {
      const reason = err instanceof JudgeBundleRefused ? err.code : (err as Error).message;
      dropped.push({ case_id, reason: `baseline: ${reason}` });
      continue;
    }

    candidateScores.push({ case_id, score: candidateScore });
    baselineScores.push({ case_id, score: baselineScore });
  }

  const suite = {
    resolution: {
      detectable_delta: Number((1 / Math.max(briefs.length, 1)).toPrecision(3)),
      confidence: 0.95,
      sized_for: briefs.length,
    },
    significance_protocol: "bootstrap-ci" as const,
  };
  if (!isGradedSuite(suite)) {
    // Unreachable given the literal above — asserted rather than assumed, the same posture
    // this module takes toward every other internally-constructed value.
    throw new Error("judge-pilot: internal suite descriptor is not graded-shaped — this is a bug.");
  }

  const comparison = compareGraded({
    comparison_id: randomUUID(),
    candidate_run_id: "judge-pilot-candidate",
    baseline_id: "judge-pilot-baseline",
    candidate: candidateScores,
    baseline: baselineScores,
    suite,
    comparisons_in_family: 1,
    alpha: 0.05,
  });

  const now = deps.now();
  await deps.evidence.put({
    kind: "comparison", id: comparison.comparison_id,
    created_at: now.toISOString(), body: comparison,
  });

  return {
    comparison, survived_n: candidateScores.length, nominal_n: briefs.length, dropped,
  };
}
