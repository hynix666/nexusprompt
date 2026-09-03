/**
 * The pipeline: eleven stages, one registry, one context.
 *
 * Pure. This module decides WHAT should happen in what order and how each stage's output
 * folds into the run's state. It performs nothing — the Application walks this plan and
 * owns every effect, exactly as ADR-0005 requires.
 *
 * **Why a registry rather than a switch.** The gate registry exists because seventeen
 * surveyed prototypes hardcoded their gate lists and not one grew past its author's
 * original set. A pipeline written as a chain of eleven `if (stage === ...)` branches has
 * the same ceiling, and it is worse here: the eleven stages do not share an input type, so
 * a switch would spread eleven ad-hoc argument mappings across a runner nobody wants to
 * read. The mapping lives beside each stage instead, in one table.
 *
 * **Three kinds, because the stages genuinely differ.** Six generate and need
 * `decide → invoke → reduce`. Two are deterministic and have no `decide` at all: forcing
 * them into the split would produce a request nothing should execute. Three carry a skip
 * rule, so "did not run" is a first-class outcome rather than an absent one.
 */


import reliabilityBudget from "../../../contracts/reliability-budget.json" with { type: "json" };
import type {
  GenerationRequest, GenerationResult, ProviderFailure, StageId, GateResult,
} from "../../../contracts/index.js";

import * as deconstruct from "./deconstruct.js";
import * as calibrate from "./calibrate.js";
import * as compile from "./compile.js";
import * as harden from "./harden.js";
import * as critique from "./critique.js";
import * as refine from "./refine.js";
import * as lint from "./lint.js";
import * as critic from "./critic.js";
import * as preview from "./preview.js";
import * as cost from "./cost-estimate.js";
import * as tone from "./tone-check.js";
import type { GateOptions } from "../gates/registry.js";
import { isPlaceholderArtifact } from "./stage-kit.js";

/**
 * The ceiling on gate-feedback rounds, read from the contract rather than restated.
 *
 * `check:depth` fails the build when `11 stages + rounds x 2` breaches the declared error
 * budget, and `reliability-budget.json` says so in its own words: "check:depth enforces the
 * worst case, so raising this cap fails the build unless the floor or the target moves."
 *
 * That was true of the FILE and false of the RUNTIME. Nothing consulted this number at run
 * time: `decideGateFeedback` took `ctx.topology.max_iterations` as the cap, and the CLI's
 * `--reflexive N` accepts any N. Measured before the clamp — `--reflexive 10` produced **10
 * rounds and 31 stage executions**, where 0.995^31 = 85.6%, below the 90% end-to-end target
 * the same file declares and four stages past the headroom `check:depth` itself prints.
 *
 * Imported, not copied, so the build-time guarantee and the run-time one cannot drift. The
 * catalog registry already imports JSON this way; a static import is data, not an effect, so
 * Core stays pure.
 */
export const MAX_FEEDBACK_ROUNDS: number = reliabilityBudget.max_feedback_rounds;

/**
 * Everything one run accumulates.
 *
 * Named for what produced it rather than what consumes it, matching the frozen component's
 * own context object — `spec` from deconstruct, `calibration` from calibrate, `prompt`
 * rewritten by compile/harden/refine, and so on.
 */
export interface PipelineContext {
  brief: string;
  stakes?: string;
  depth?: string;
  testMessage?: string;
  gateOptions?: GateOptions;

  /**
   * The pipeline shape, from `Configuration.topology`.
   *
   * `reflexive` is what turns gate verdicts from a terminal report into a control signal.
   * The default is sequential — omitting this runs exactly the pipeline that ran before
   * gate feedback existed, byte for byte.
   */
  topology?: { kind: "sequential" | "parallel-merge" | "hierarchical" | "reflexive"; max_iterations?: number | null };
  /** Gate-feedback rounds already spent. Part of the context because Core decides on it. */
  feedbackRounds?: number;

  spec?: string;
  calibration?: string;
  prompt?: string;
  critique?: string;
  lint?: string;
  lintStatus?: lint.LintStatus | null;
  gate_results?: GateResult[];
  critic?: string;
  criticVerdict?: critic.CriticVerdict | "SKIPPED";
  preview?: string;
  cost?: string;
  tone?: string;
  voice?: tone.VoiceLevel;
}

/** What a stage contributes back to the run. */
export type ContextPatch = Partial<PipelineContext>;

interface StageCommon {
  readonly id: StageId;
  /** True when this stage does not run for this context at all. */
  shouldSkip?(ctx: PipelineContext): boolean;
  /** What the context gets when the stage is skipped. Absent means "nothing". */
  reduceSkipped?(ctx: PipelineContext): ContextPatch;
}

/**
 * A discriminated union, not one shape with optional members.
 *
 * With a single interface, `decide` and `reduce` were optional and the runner reached them
 * through `stage.decide!(...)` — so a registry entry declaring `kind: "generating"` without
 * a `decide` was a runtime TypeError waiting for a twelfth stage. The union makes that
 * entry fail to compile instead, and both non-null assertions disappear from the runner.
 */
export type PipelineStage =
  | (StageCommon & {
      readonly kind: "generating";
      decide(ctx: PipelineContext, run_id: string): GenerationRequest;
      reduce(ctx: PipelineContext, outcome: GenerationResult | ProviderFailure): ContextPatch;
    })
  | (StageCommon & {
      readonly kind: "deterministic";
      /** No request, no outcome — a pure function of the context. */
      run(ctx: PipelineContext): ContextPatch;
    });

/**
 * The eleven, in frozen order. `check:stages` requires this to match the component's own
 * stage array, so the list cannot drift from the artifact it was ported from.
 */
export const PIPELINE: readonly PipelineStage[] = Object.freeze([
  {
    id: "deconstruct", kind: "generating",
    decide: (c, r) => deconstruct.decide({ brief: c.brief }, r),
    reduce: (c, o) => ({ spec: deconstruct.reduce({ brief: c.brief }, o).spec }),
  },
  {
    id: "calibrate", kind: "generating",
    decide: (c, r) => calibrate.decide({ brief: c.brief, previous: c.spec }, r),
    reduce: (c, o) => ({ calibration: calibrate.reduce({ brief: c.brief, previous: c.spec }, o).calibration }),
  },
  {
    id: "compile", kind: "generating",
    decide: (c, r) => compile.decide({ brief: c.brief, previous: c.spec, calibration: c.calibration }, r),
    reduce: (c, o) => {
      const s = compile.reduce({ brief: c.brief, previous: c.spec, calibration: c.calibration }, o);
      // A new prompt invalidates any verdict about the old one. The frozen component clears
      // lint and critic on draft/transform/refine for exactly this reason: a stale PASS
      // beside a changed prompt is worse than no verdict, because it reads as current.
      return { prompt: s.output.text, lint: undefined, lintStatus: undefined, gate_results: undefined, critic: undefined, criticVerdict: undefined };
    },
  },
  {
    id: "harden", kind: "generating",
    // Cannot harden a placeholder. See `isPlaceholderArtifact` — a transforming stage handed a
    // degraded artifact must decline, or it launders the marker off it.
    shouldSkip: (c) => isPlaceholderArtifact(c.prompt),
    decide: (c, r) => harden.decide({ prompt: c.prompt ?? "" }, r),
    reduce: (c, o) => ({
      prompt: harden.reduce({ prompt: c.prompt ?? "" }, o).prompt,
      lint: undefined, lintStatus: undefined, gate_results: undefined, critic: undefined, criticVerdict: undefined,
    }),
    reduceSkipped: (c) => ({ prompt: c.prompt }),
  },
  {
    id: "critique", kind: "generating",
    // Found by running the CLI, not by review: with compile degraded this was the one
    // prompt-consuming stage still calling out, spending a request to review a placeholder
    // whose critique `refine` then skips anyway. You cannot critique a non-artifact any
    // more than you can harden one.
    shouldSkip: (c) => isPlaceholderArtifact(c.prompt),
    reduceSkipped: () => ({ critique: "[SKIPPED] No compiled prompt to review — the build degraded." }),
    decide: (c, r) => critique.decide({ prompt: c.prompt ?? "" }, r),
    reduce: (c, o) => ({ critique: critique.reduce({ prompt: c.prompt ?? "" }, o).critique }),
  },
  {
    id: "refine", kind: "generating",
    // Three reasons to skip. A clean critique means there is nothing to rewrite. A degraded
    // prompt means there is nothing real to rewrite INTO — refining a placeholder produces
    // a clean-looking artifact from output no model made, which is the laundering the demo
    // marker exists to prevent.
    //
    // A degraded CRITIQUE is the same hole reached through the other input, and it was open
    // until now. `critique` guards only the direction where a placeholder might read as
    // PASS_SENTINEL; nothing stopped the opposite. With compile and harden healthy and only
    // `critique` degraded, this stage spent a provider call asking a model to "resolve EVERY
    // item" in a placeholder that says no output was produced — and its answer became the
    // run's artifact, carrying no marker at all. `demo_mode` was true and the artifact said
    // nothing, which is precisely the split `isPlaceholderArtifact` exists to close: the
    // artifact is the half that gets read, copied and shipped.
    //
    // Skipping keeps the real, un-refined prompt, exactly as `harden`'s skip does. The
    // prompt is genuine model output and must not be marked; what is missing is the
    // refinement, and the SKIPPED revision is what says so.
    shouldSkip: (c) =>
      isPlaceholderArtifact(c.prompt) ||
      isPlaceholderArtifact(c.critique) ||
      refine.shouldSkip({ prompt: c.prompt ?? "", critique: c.critique ?? "" }),
    decide: (c, r) => refine.decide({ prompt: c.prompt ?? "", critique: c.critique ?? "" }, r),
    reduce: (c, o) => ({
      prompt: refine.reduce({ prompt: c.prompt ?? "", critique: c.critique ?? "" }, o).prompt,
      // The critique has been resolved; carrying it forward would re-apply it.
      critique: "", lint: undefined, lintStatus: undefined, gate_results: undefined, critic: undefined, criticVerdict: undefined,
    }),
    reduceSkipped: (c) => ({ prompt: c.prompt, critique: "" }),
  },
  {
    id: "lint", kind: "deterministic",
    run: (c) => {
      const s = lint.run({ prompt: c.prompt, options: c.gateOptions });
      return { lint: s.report, lintStatus: s.status, gate_results: s.gate_results };
    },
  },
  {
    id: "critic", kind: "generating",
    // A PASS about a placeholder is a clean verdict on a non-artifact — the same thing the
    // stale-verdict clearing above exists to prevent, arrived at from the other direction.
    shouldSkip: (c) => isPlaceholderArtifact(c.prompt) || critic.shouldSkip({ prompt: c.prompt ?? "", stakes: c.stakes }),
    decide: (c, r) => critic.decide({ prompt: c.prompt ?? "", lint: c.lint, stakes: c.stakes }, r),
    reduce: (c, o) => {
      const s = critic.reduce({ prompt: c.prompt ?? "", lint: c.lint, stakes: c.stakes }, o);
      return { critic: s.report, criticVerdict: s.verdict };
    },
    // Two skip causes, so two reasons. Reusing the stakes sentence for a degraded artifact
    // wrote a false one into the bundle — see `critic.DEGRADED_MESSAGE`. The predicate is the
    // same one `shouldSkip` used, so the reason cannot describe a different cause than fired.
    reduceSkipped: (c) => {
      const s = isPlaceholderArtifact(c.prompt) ? critic.reduceSkippedDegraded() : critic.reduceSkipped();
      return { critic: s.report, criticVerdict: s.verdict };
    },
  },
  {
    id: "preview", kind: "generating",
    // Previewing a placeholder sends it to a live model AS the system prompt and stores a
    // clean, shippable-looking reply as the run demonstration of a prompt never compiled.
    shouldSkip: (c) => isPlaceholderArtifact(c.prompt),
    reduceSkipped: () => ({ preview: "[SKIPPED] No compiled prompt to preview — the build degraded." }),
    decide: (c, r) => preview.decide({ prompt: c.prompt, testMessage: c.testMessage ?? "" }, r),
    reduce: (c, o) => ({ preview: preview.reduce({ prompt: c.prompt, testMessage: c.testMessage ?? "" }, o).reply }),
  },
  {
    id: "cost_estimate", kind: "deterministic",
    run: (c) => ({ cost: cost.run({ prompt: c.prompt }).report }),
  },
  {
    id: "tone_check", kind: "generating",
    // `planDepth`, not `c.depth`. The plan is built from the depth the run RESOLVED to, so a
    // predicate reading the raw request disagrees with the plan it is running inside — see
    // the note on `planDepth`.
    shouldSkip: (c) => isPlaceholderArtifact(c.prompt) || tone.shouldSkip({ prompt: c.prompt ?? "", depth: planDepth(c) }),
    decide: (c, r) => tone.decide({ prompt: c.prompt ?? "", calibration: c.calibration, depth: c.depth }, r),
    reduce: (c, o) => {
      const s = tone.reduce({ prompt: c.prompt ?? "", calibration: c.calibration, depth: c.depth }, o);
      return { tone: s.report, voice: s.voice };
    },
    // Same two causes, same rule — see the note on `critic` above.
    reduceSkipped: (c) => {
      const s = isPlaceholderArtifact(c.prompt) ? tone.reduceSkippedDegraded() : tone.reduceSkipped();
      return { tone: s.report, voice: s.voice };
    },
  },
]);

/**
 * Which stages run at which depth, ported from the frozen `DEPTH_PLAN`.
 *
 * Not every stage runs every time: TINY runs six of eleven and MINIMAL seven, so an
 * eleven-stage run is the STANDARD/COMPREHENSIVE path rather than the only path. Written
 * with stage ids rather than the source's `s1..s11` so a reader does not have to hold the
 * numbering in their head; `check:stages` verifies the mapping against the source.
 */
export const DEPTH_PLAN: Record<string, readonly StageId[]> = Object.freeze({
  TINY: ["deconstruct", "calibrate", "compile", "lint", "preview", "cost_estimate"],
  MINIMAL: ["deconstruct", "calibrate", "compile", "harden", "lint", "preview", "cost_estimate"],
  STANDARD: PIPELINE.map((s) => s.id),
  COMPREHENSIVE: PIPELINE.map((s) => s.id),
});

/** Stakes → depth, ported from the frozen `DEPTH_OF`. */
export const DEPTH_OF: Record<string, string> = Object.freeze({
  LOW: "TINY", MEDIUM: "MINIMAL", HIGH: "STANDARD", "SAFETY-CRITICAL": "COMPREHENSIVE",
});

/**
 * The stages to run, in order, for a depth.
 *
 * An unknown depth returns the full plan rather than an empty one. Returning nothing would
 * make a typo look like a completed run — the same failure `lint` avoids by reporting null
 * instead of PASS when it had no prompt.
 */
export function planFor(depth: string | undefined): readonly PipelineStage[] {
  const ids = DEPTH_PLAN[depth ?? ""] ?? DEPTH_PLAN.STANDARD;
  const wanted = new Set(ids);
  return PIPELINE.filter((s) => wanted.has(s.id));
}

/**
 * The depth a run should use: explicit if given, otherwise derived from stakes.
 *
 * `DEPTH_OF` was ported and then never called, so `stakes: "LOW"` with no depth ran all
 * eleven stages instead of TINY's six — the frozen component derives one from the other and
 * this did not. Dead constants are worse than absent ones: this one looked like the binding
 * existed.
 */
export const resolveDepth = (ctx: Pick<PipelineContext, "depth" | "stakes">): string | undefined =>
  ctx.depth ?? DEPTH_OF[ctx.stakes ?? ""];

/**
 * The depth the run is ACTUALLY at — what `planFor` will build the plan from.
 *
 * `resolveDepth` answers a different question: what the caller asked for, which may be
 * undefined or a typo. `planFor` then quietly falls back to STANDARD. Any stage predicate
 * that reads `ctx.depth` instead of this is answering the depth question a third way, and
 * the three answers do not agree.
 *
 * They disagreed in production. `tone_check`'s skip rule read `ctx.depth`, so a run given
 * stakes and no depth — the CLI's default, since `shells/cli` passes `depth: flag("depth")`
 * — planned eleven stages and skipped the eleventh on every one of them. At
 * `stakes: "SAFETY-CRITICAL"` the plan resolved to COMPREHENSIVE and the bundle recorded
 * "[SKIPPED] Tone Check runs at STANDARD depth and above" about a COMPREHENSIVE run: a
 * false statement, in the record, on the highest-stakes path. The frozen component has no
 * such split — `const depth = DEPTH_OF[effStakes]` is its only notion of depth — so this
 * was port drift, and `check:stages` cannot see it because it compares templates and the
 * stage list, not skip predicates.
 *
 * `Object.hasOwn`, not `DEPTH_PLAN[d] ?? …`: the depth string reaches here from an operator
 * flag, and `"constructor"` indexes a Record straight into `Object`.
 */
export function planDepth(ctx: Pick<PipelineContext, "depth" | "stakes">): string {
  const asked = resolveDepth(ctx);
  return asked !== undefined && Object.hasOwn(DEPTH_PLAN, asked) ? asked : "STANDARD";
}

/** The stages to run for a whole context, resolving depth from stakes when it is unset. */
export const planForContext = (ctx: Pick<PipelineContext, "depth" | "stakes">): readonly PipelineStage[] =>
  planFor(planDepth(ctx));

/* ── Gate feedback: verdicts as a control signal ──────────────────────────── */

/**
 * What Core decides when `lint` has finished.
 *
 * `retry: false` always carries a `reason`, because "the loop did not run" has several
 * causes and a run that cannot say which one is not auditable. This mirrors `lint` itself
 * reporting a null status rather than PASS when it had nothing to check.
 */
export interface FeedbackDecision {
  retry: boolean;
  reason: string;
  /** Where the Application should resume. Only meaningful when `retry`. */
  resumeAt?: StageId;
  patch?: ContextPatch;
}

/**
 * Render failing gates as a critique `refine` already knows how to consume.
 *
 * `refine`'s template asks the model to resolve every item in a numbered, ID-prefixed
 * critique, and treats gate items as mandatory. Gate verdicts are already exactly that
 * shape — an id and a message per finding — so feedback needs a formatter, not a new
 * contract between the two stages.
 *
 * Only FAILs are included. A WARN is a finding, not a defect the loop should spend a
 * provider call resolving, and `statusOf` already draws that line: GATE_FAIL is a FAIL,
 * DEGRADED is anything else.
 */
export function formatGateCritique(results: readonly GateResult[]): string {
  const failures = results.filter((r) => r.verdict === "FAIL");
  return [
    "GATE FAILURES from the linter. Each is mandatory — resolve every one.",
    "",
    ...failures.map((f, i) => `${i + 1}. G-${f.gate_id}: ${f.message}`),
  ].join("\n");
}

/**
 * Decide whether a gate FAIL should route back to `refine`.
 *
 * This is ADR-0008's action item 4, and it is the same `decide → invoke → reduce` split as
 * everywhere else: choosing to loop is a pure function of the context, so it lives here;
 * re-walking the plan is the Application's job.
 *
 * The gates are already pure, typed and deterministic — only the decision to act on them
 * was missing. Their messages are TEXT, not a scalar, which is what makes this the cheap
 * end of reflective optimization rather than a retry counter: the model is told what failed
 * and why, not merely that something did.
 *
 * Five reasons not to loop, each returned by name:
 *
 *  - the topology is not reflexive — the default, and the byte-for-byte previous behaviour;
 *  - the cap is spent, or was never declared. An unbounded verification loop is the
 *    recorded hazard, so an absent `max_iterations` means zero rounds, never infinite ones;
 *  - the gates did not FAIL. A WARN is not a defect worth a provider call;
 *  - the plan has no `refine` or no `lint` — TINY and MINIMAL depths omit them, and a loop
 *    that jumps to a stage the depth plan excluded would silently deepen a shallow run;
 *  - the prompt is a demo placeholder. Refining a placeholder produces a clean-looking
 *    artifact from output no model made, which is exactly the laundering the demo marker
 *    exists to prevent — the same guard the six generating stages already carry.
 */
export function decideGateFeedback(
  ctx: PipelineContext,
  plan: readonly PipelineStage[],
): FeedbackDecision {
  if (ctx.topology?.kind !== "reflexive") {
    return { retry: false, reason: "topology is not reflexive" };
  }

  const asked = ctx.topology.max_iterations ?? 0;
  const cap = Math.min(asked, MAX_FEEDBACK_ROUNDS);
  const spent = ctx.feedbackRounds ?? 0;
  if (spent >= cap) {
    return {
      retry: false,
      reason: cap === 0
        ? "no max_iterations declared, so no rounds are permitted"
        : asked > cap
          ? `feedback cap reached (${spent} of ${cap}; ${asked} was requested, clamped to the declared max_feedback_rounds)`
          : `feedback cap reached (${spent} of ${cap})`,
    };
  }

  if (ctx.lintStatus !== "GATE_FAIL") {
    return { retry: false, reason: `lint status is ${ctx.lintStatus ?? "null"}, not GATE_FAIL` };
  }

  const has = (id: StageId) => plan.some((s) => s.id === id);
  if (!has("refine") || !has("lint")) {
    return { retry: false, reason: "this depth plan omits refine or lint" };
  }

  if (isPlaceholderArtifact(ctx.prompt)) {
    return { retry: false, reason: "the prompt is a demo placeholder — nothing real to refine" };
  }

  const failures = (ctx.gate_results ?? []).filter((r) => r.verdict === "FAIL");
  if (failures.length === 0) {
    // GATE_FAIL with no FAIL in the results would mean lint and this disagree.
    return { retry: false, reason: "no FAIL verdicts to feed back" };
  }

  return {
    retry: true,
    reason: `${failures.length} gate failure(s), round ${spent + 1} of ${cap}`,
    resumeAt: "refine",
    patch: {
      critique: formatGateCritique(ctx.gate_results ?? []),
      feedbackRounds: spent + 1,
    },
  };
}
