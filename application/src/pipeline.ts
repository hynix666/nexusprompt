/**
 * The pipeline runner — Application layer, owns every effect.
 *
 * Core supplies the plan (`core/src/stages/pipeline.ts`) and performs nothing. This walks
 * it: for each stage, ask Core what to do, do it, hand the classified outcome back to Core,
 * persist the revision. `decide → invoke → reduce`, eleven times, with Core appearing twice
 * per stage and invoking nothing either time.
 *
 * **A run is one bundle.** Every stage appends a `RevisionEntry` under the same `run_id`,
 * so the run reloads through `store.getRun(run_id)` as a unit. That is deliberate and
 * ADR-0004's reasoning: the local store retains eight complete RUNS, kept or evicted whole,
 * because an entry-based cap cannot hold a variable-length run — the source's cap of 8
 * entries could not hold a nine-stage run, and the pipeline is now eleven.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  planForContext, decideGateFeedback, MAX_FEEDBACK_ROUNDS, type PipelineContext } from "../../core/src/stages/pipeline.js";
import { isFailure, CONTRACT_VERSIONS } from "../../contracts/index.js";
import { admitRun, plannedPipelineCalls, type Budget } from "../../core/src/eval/budget.js";
import { refuseForgedMarker } from "../../core/src/stages/stage-kit.js";
import { invokeWithRetry } from "./invoke.js";
import { redactingSink } from "./redaction.js";
import type {
  EventSink, ExecutionProvenance, GenerationResult, PipelineCommand, ProviderFailure,
  ProviderTransport, RevisionEntry, RevisionStore, StageId, GateResult, ObservabilityEvent, EventType,
  ContentStore,
} from "../../contracts/index.js";

/**
 * Re-exported so a Shell can honour the cap without importing Core.
 *
 * `shells/cli` needs the number to refuse `--reflexive` above it, and the boundary rule
 * (ADR-0001, amended by 0005) forbids a Shell importing Core directly — `lint:boundaries`
 * refused the direct import, which is the guard doing its job. The Application layer is the
 * protocol a Shell may call, so the constant travels the same way every other decision does.
 */
export { MAX_FEEDBACK_ROUNDS } from "../../core/src/stages/pipeline.js";

/**
 * How many bundles to consult when recomputing the live content set.
 *
 * Must be at least what the store retains, or the sweep would reclaim content a surviving
 * bundle still cites. `storage-local` keeps 8; asking for more is harmless — `listRecent`
 * returns what exists — and asking for fewer is the one way this becomes destructive.
 */
const BUNDLE_SWEEP_LIMIT = 64;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export interface PipelineRunOptions {
  provider: ProviderTransport;
  store: RevisionStore;
  sink: EventSink;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts including the first, shared with the Orchestrator. */
  maxAttempts?: number;
  /**
   * What this run may spend. Absent means no budget was declared, which `admitRun` admits —
   * the same rule the evaluation path follows, so the two cannot disagree about what an
   * undeclared budget means.
   */
  budget?: Budget | null;
  /**
   * Where stage input and output bodies are retained, or absent to retain nothing.
   *
   * Absent is a real deployment (nothing was wired before this existed) and it produces
   * `input_ref: null` / `output_ref: null` — the honest "not retained here". What it must
   * never produce is a ref that resolves to nothing, which is why the ref is only written
   * after `put` has returned.
   */
  content?: ContentStore | null;
  coreBuildHash?: string;
  configFingerprint?: string | null;
}

/**
 * Retain one body and return the ref that names it, or null when nothing is retained.
 *
 * The ref is built FROM the bytes, so `put`'s "bytes must hash to their address" check can
 * never fail here — and the ref is returned only after the write lands. A revision therefore
 * either names content that was successfully stored or says null; there is no third state in
 * which a pointer exists and its content never did.
 */
async function retain(
  content: ContentStore | null | undefined,
  kind: "stage-input" | "stage-output",
  body: string,
): Promise<string | null> {
  if (!content) return null;
  const bytes = new TextEncoder().encode(body);
  // Unkeyed, deliberately: content addressing must be verifiable by anyone holding the
  // artifact, unlike the keyed observability fingerprints. Stated in the schema description.
  const digest = createHash("sha256").update(bytes).digest("hex");
  const ref = `npx:${kind}:${digest}:local-bundle`;
  await content.put(ref, bytes);
  return ref;
}

/** What one stage did. `skipped` is a real outcome, distinct from succeeded and degraded. */
export interface StageRecord {
  stage_id: StageId;
  status: "SUCCEEDED" | "DEMO" | "SKIPPED" | "FAILED";
  revision_id: string | null;
  output_hash: string | null;
}

export interface PipelineRunResult {
  run_id: string;
  context: PipelineContext;
  stages: StageRecord[];
  /** From the `lint` stage — the pipeline's authoritative gate verdicts. */
  gate_results: GateResult[];
  /** True when ANY stage degraded. One unlabelled degraded stage taints the run. */
  demo_mode: boolean;
  /** True when any stage threw. Distinct from demo_mode: a throw is a defect, not an outage. */
  failed: boolean;
  revision_ids: string[];
  /**
   * Caps that were declared and could not be checked — empty when everything declared was
   * applied. Carried out rather than swallowed: "declared and unenforced" is a third state,
   * and a run that reports nothing about it is indistinguishable from one that was fully
   * within budget.
   */
  budget_unenforced: string[];
}

/**
 * Run the pipeline for one command.
 *
 * Stage failures do not abort the run. A provider outage at `harden` degrades that stage
 * into a labelled placeholder and the run continues — which is the whole point of demo
 * mode, and why `reduce` takes a classified outcome rather than throwing. A run that
 * stopped at the first failure would produce no artifact at all and no record of how far
 * it got.
 */
export async function runPipeline(
  command: PipelineCommand & { context?: Partial<PipelineContext> },
  opts: PipelineRunOptions,
): Promise<PipelineRunResult> {
  const now = opts.now ?? (() => new Date());
  const coreBuildHash = opts.coreBuildHash ?? "dev";
  const run_id = command.run_id;

  let ctx: PipelineContext = {
    brief: command.input.brief,
    ...(command.context ?? {}),
  };

  /**
   * Every event this run emits passes the redaction check first.
   *
   * The claim that "the sink enforces redaction structurally, not as a convention for call
   * sites" described `observability/sink.ts`, which does not exist — so it WAS a convention,
   * and sweep fourteen found it broken on the error path. Wrapping here makes the check
   * unavoidable for every `emit` below, including ones added later by someone who never read
   * this comment, which is the only version of "structural" worth the word.
   *
   * The bodies are read through a callback because `ctx.prompt` is rewritten as stages run; a
   * snapshot would stop covering the artifact halfway through the run.
   */
  const sink = redactingSink(opts.sink, () => [ctx.brief, ctx.prompt, ctx.spec, ctx.critique]
    .filter((b): b is string => typeof b === "string"));

  /** Every ref this run wrote. Held in memory so a storage fault cannot empty it. */
  const retainedRefs = new Set<string>();

  const stages: StageRecord[] = [];
  const revision_ids: string[] = [];
  let anyDemo = false;
  let anyFailed = false;

  /**
   * Emit a fully-formed ObservabilityEvent.
   *
   * This was `opts.sink.emit({ ... } as never)`, and the cast hid three contract violations
   * at once: the field is `event_type` not `type`, five required fields were missing
   * (`layer`, `parent_event_id`, `schema_version` and the nullables), and `STAGE_SKIPPED`
   * was not in the enum at all. The conformance suite validates events, but only ones the
   * Orchestrator produced — so nothing ever looked at these. An escape hatch with no comment
   * justifying it turned out to be silencing exactly what it looked like it might be.
   */
  const emit = (
    event_type: EventType,
    detail: Partial<Omit<ObservabilityEvent, "event_id" | "event_type" | "run_id" | "timestamp" | "layer" | "schema_version">> = {},
  ) =>
    sink.emit({
      event_id: randomUUID(),
      event_type,
      run_id,
      parent_event_id: null,
      timestamp: now().toISOString(),
      layer: "application",
      component: "application/pipeline",
      duration_ms: null,
      attempt: null,
      input_hash: null,
      output_hash: null,
      provider_id: null,
      model_id: null,
      failure_code: null,
      verdict: null,
      schema_version: CONTRACT_VERSIONS["observability-event"],
      ...detail,
    });

  emit("PIPELINE_COMMAND_RECEIVED", { component: "application/pipeline" });

  /**
   * An index walk, not a for-of, because the plan is no longer necessarily walked once.
   *
   * A reflexive topology routes a gate FAIL back to `refine`, so the runner has to be able
   * to move backwards. Core decides whether and where (`decideGateFeedback`); this loop only
   * follows, which is the same division as `shouldSkip` and `planForContext`.
   *
   * `plan` is hoisted out of the loop deliberately. Recomputing it per iteration would let a
   * context patch silently change the plan mid-run, and the depth budget is computed against
   * one plan.
   */
  const plan = planForContext(ctx);

  /**
   * Admission, before the first provider call.
   *
   * This path had none. `admitRun` existed and `application/src/eval.ts` used it, but the
   * ELEVEN-STAGE path — the one `shells/cli/src/composition-root.ts` wires a real
   * `LocalProxyProvider` into — called it zero times. A budget could be declared on a
   * Configuration and the pipeline would spend past it without ever reading it, which made
   * `eval-run.cost.budget_exceeded` unfalsifiable on the only path that reaches a model
   * interactively.
   *
   * Sized from the plan actually selected and the feedback cap actually declared, not from a
   * nominal eleven — `planForContext` returns six stages at TINY. Core owns the arithmetic
   * (`plannedPipelineCalls`) so the runner cannot drift from the number the budget was
   * checked against.
   *
   * Throws rather than returning a short result, matching `runSuite`. A refused run that came
   * back as a `PipelineRunResult` with no stages is indistinguishable from a run that
   * degraded at stage one, and this module's own history is of bundles silently truncated at
   * however far they got.
   */
  const admission = admitRun({
    budget: opts.budget,
    plannedCalls: plannedPipelineCalls({
      plan,
      // Clamped the same way Core clamps it, so the reservation matches what can actually
      // happen. Reserving for a requested 10 when Core will grant 3 is not unsafe, but it is
      // a budget refusing runs it did not need to refuse.
      feedbackRounds: ctx.topology?.kind === "reflexive"
        ? Math.min(ctx.topology.max_iterations ?? 0, MAX_FEEDBACK_ROUNDS)
        : 0,
      maxAttempts: opts.maxAttempts ?? 3,
    }),
  });
  if (!admission.admit) {
    // No event: nothing was dispatched, so there is nothing to observe, and the existing
    // event types all mean something else. `DEGRADE` in particular is what a stage emits when
    // it threw — borrowing it here would put a refusal into the count of degradations, which
    // is the kind of overloading `STAGE_SKIPPED` was added to end. An event type for this is a
    // contract change and belongs in its own PR (ADR-0002).
    throw new Error(
      `Pipeline run "${run_id}" ${admission.reason}\n` +
        `  Raise the budget, lower --reflexive, or run a shallower depth. Nothing was spent.`,
    );
  }

  for (let i = 0; i < plan.length; i++) {
    const stage = plan[i];
    const inputHash = sha256(JSON.stringify({ id: stage.id, ctx: redactForHash(ctx) }));
    const feedbackRound = ctx.feedbackRounds ?? 0;

    /**
     * A skip is persisted, not merely evented.
     *
     * It used to push a `StageRecord` and emit `STAGE_SKIPPED` and store nothing — so a
     * reloaded bundle could not tell "deliberately skipped" from "never reached", which is
     * the exact distinction the `STAGE_SKIPPED` event type was added for. Events are not
     * persisted; revisions are. A run with a clean critique, LOW stakes, or any degradation
     * produced a short bundle with no record of why it was short.
     */
    if (stage.shouldSkip?.(ctx)) {
      ctx = { ...ctx, ...(stage.reduceSkipped?.(ctx) ?? {}) };
      const revision = buildRevision({
        run_id, stage_id: stage.id, inputHash,
        outputText: "", status: "SKIPPED", provider: null, gate_results: [],
        now, coreBuildHash, configFingerprint: opts.configFingerprint ?? null, feedbackRound,
        parents: revision_ids.slice(-1),
      });
      await opts.store.append(revision);
      revision_ids.push(revision.revision_id);
      stages.push({ stage_id: stage.id, status: "SKIPPED", revision_id: revision.revision_id, output_hash: null });
      emit("STAGE_SKIPPED", { component: `core/stages/${stage.id}`, input_hash: inputHash });
      continue;
    }

    /**
     * An unexpected throw is a FAILED stage, not an aborted run.
     *
     * Core stages are pure but not total — `fillTemplate` throws on a template naming an
     * unfillable slot, and a future stage may throw for its own reasons. Letting that
     * escape contradicted this module's own promise that "stage failures do not abort the
     * run": the caller got an unhandled rejection, no result, no event, and a bundle
     * silently truncated at however far it got. `RevisionStatus` already had a `FAILED`
     * member that nothing ever wrote; now something does.
     */
    const failStage = async (err: unknown): Promise<void> => {
      anyFailed = true;
      /**
       * The error's TYPE, never its message.
       *
       * `err.message` is whatever produced the error, and sweep fourteen showed what that
       * means: a provider adapter throwing a parse error that quoted its payload put the
       * prompt body into four `DEGRADE` events. A name is bounded and says as much as an
       * operator needs to route the failure; the message belongs in a log the operator owns,
       * not in the event spine that promises to carry hashes only.
       */
      const message = err instanceof Error ? err.name : "UnknownError";
      const revision = buildRevision({
        run_id, stage_id: stage.id, inputHash,
        outputText: "", status: "FAILED", provider: null, gate_results: [],
        now, coreBuildHash, configFingerprint: opts.configFingerprint ?? null, feedbackRound,
        parents: revision_ids.slice(-1),
      });
      await opts.store.append(revision);
      revision_ids.push(revision.revision_id);
      stages.push({ stage_id: stage.id, status: "FAILED", revision_id: revision.revision_id, output_hash: revision.output_hash });
      emit("DEGRADE", { component: `core/stages/${stage.id}`, failure_code: "stage_threw", verdict: message.slice(0, 200) });
    };

    // ── deterministic: no request, no provider, no outcome to classify ──────
    if (stage.kind === "deterministic") {
      try {
        ctx = { ...ctx, ...stage.run(ctx) };
      } catch (err) {
        await failStage(err);
        continue;
      }
      const revision = buildRevision({
        run_id, stage_id: stage.id, inputHash,
        outputText: summarize(stage.id, ctx), status: "SUCCEEDED", provider: null,
        gate_results: stage.id === "lint" ? (ctx.gate_results ?? []) : [],
        now, coreBuildHash, configFingerprint: opts.configFingerprint ?? null, feedbackRound,
        parents: revision_ids.slice(-1),
      });
      await opts.store.append(revision);
      revision_ids.push(revision.revision_id);
      stages.push({ stage_id: stage.id, status: "SUCCEEDED", revision_id: revision.revision_id, output_hash: revision.output_hash });
      emit("REVISION_PERSISTED", { component: `core/stages/${stage.id}`, output_hash: revision.output_hash });

      /**
       * Gate verdicts as a control signal — ADR-0008 action item 4.
       *
       * The verdicts are already computed, pure and typed; only acting on them was missing.
       * Core owns the whole decision, including the cap and every reason not to loop, so this
       * branch cannot quietly acquire a second policy. The revision above is persisted BEFORE
       * the jump, so a bundle records the failing lint that caused the retry rather than only
       * the passing one that ended it.
       */
      if (stage.id === "lint") {
        const feedback = decideGateFeedback(ctx, plan);
        emit("GATE_FEEDBACK", {
          component: "core/stages/lint",
          verdict: feedback.reason,
          input_hash: inputHash,
        });
        if (feedback.retry) {
          ctx = { ...ctx, ...(feedback.patch ?? {}) };
          const target = plan.findIndex((s) => s.id === feedback.resumeAt);
          // Core already refused to retry when the plan lacks the target, so this is
          // belt-and-braces — but a -1 here would restart the whole run, and a silent
          // infinite loop is the one failure this feature must not introduce.
          if (target >= 0) {
            /**
             * The retry supersedes the pass being rewound, so say so in the bundle.
             *
             * `markStale` had zero callers, which is why nobody noticed it cascaded by
             * array position. This is the call site the mechanism was built for: the loop
             * is about to re-execute `resumeAt`, so that stage's previous revision and
             * everything computed from it — including the lint verdict that triggered the
             * retry — describe a prompt this run is about to replace.
             *
             * STALE, not deleted. `status` stays SUCCEEDED and the gate results stay put:
             * the record of the failing lint that CAUSED the retry is the thing a reader
             * most needs, and marking it stale says it is history, not that it is gone.
             */
            const superseded = [...stages].reverse().find((s) => s.stage_id === feedback.resumeAt);
            if (superseded?.revision_id) {
              await opts.store.markStale(run_id, superseded.revision_id);
              // REVISION_SUPERSEDED, not REVISION_PERSISTED: nothing was written here, a
              // stored revision was mutated. Reusing the persist event made the stream
              // report one persist per stale-mark, and the count still reconciled against
              // the bundle only because the two SKIPPED revisions emit STAGE_SKIPPED
              // instead. Two errors cancelling is not the same as no error.
              emit("REVISION_SUPERSEDED", {
                component: `core/stages/${feedback.resumeAt}`,
                verdict: `superseded by feedback round ${(ctx.feedbackRounds ?? 0)}`,
              });
            }
            i = target - 1;
            continue;
          }
        }
      }
      continue;
    }

    // ── decide (Core, pure) → invoke (here) → reduce (Core, pure) ───────────
    let request;
    try {
      request = stage.decide(ctx, run_id);
    } catch (err) {
      await failStage(err);
      continue;
    }
    // The input hash identifies what this stage was ACTUALLY given: the system prompt plus
    // the rendered user turn, already content-hashed into request_id by buildRequest. The
    // previous hash covered only the run's inputs, so nine of eleven stages produced an
    // identical input_hash across runs whose outputs differed — a provenance record
    // contradicting itself, and useless for replay or caching.
    const stageInputHash = sha256(`${request.system ?? ""} ${request.messages[0]?.content ?? ""}`);
    emit("STAGE_DECISION", { component: `core/stages/${stage.id}`, input_hash: stageInputHash });

    // Shared with the Orchestrator. Calling `provider.generate` directly here meant an
    // eleven-stage run degraded on the first transient timeout while the single-stage path
    // recovered from the identical failure.
    // The invoke is guarded too. A ProviderTransport is *supposed* to return a typed
    // failure rather than throw — but an adapter bug or an unexpected exception would
    // otherwise escape here and abort the run, which is the same defect as an unguarded
    // Core throw and just as invisible until it happens.
    let invoked;
    try {
      invoked = await invokeWithRetry(request, {
        provider: opts.provider,
      maxAttempts: opts.maxAttempts ?? 3,
      now,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      onAttempt: (e) => {
        if (e.phase === "started") {
          emit("PROVIDER_CALL_STARTED", { component: opts.provider.provider_id, provider_id: opts.provider.provider_id, attempt: e.attempt });
        } else if (e.phase === "succeeded") {
          const r = e.outcome as GenerationResult;
          emit("PROVIDER_CALL_SUCCEEDED", { component: opts.provider.provider_id, provider_id: r.provider_id, model_id: r.model_id, attempt: e.attempt, duration_ms: e.duration_ms });
        } else {
          const f = e.outcome as ProviderFailure;
          emit("PROVIDER_CALL_FAILED", { component: opts.provider.provider_id, provider_id: f.provider_id, attempt: e.attempt, duration_ms: e.duration_ms, failure_code: f.reason_code });
        }
        },
      });
    } catch (err) {
      await failStage(err);
      continue;
    }
    const { outcome: raw, attempts } = invoked;
    /**
     * Settled BEFORE `degraded` is read, or the run and its artifact disagree.
     *
     * `refuseForgedMarker` reclassifies a completion carrying one of the pipeline's
     * placeholder markers as `MALFORMED_RESPONSE`, and each stage's `reduce` applies it — so
     * the artifact becomes the UNUSABLE placeholder either way. But `degraded` was computed
     * from the RAW outcome, which is still a success, so `anyDemo` stayed false: the run
     * would report `demo_mode: false` beside an artifact saying a model's answer could not be
     * used. Same defect as the one being closed, one layer up. Calling the same Core decision
     * here makes the two agree by construction rather than by both being remembered.
     */
    const outcome = refuseForgedMarker(raw);
    const degraded = isFailure(outcome);
    if (degraded) anyDemo = true;

    try {
      ctx = { ...ctx, ...stage.reduce(ctx, outcome) };
    } catch (err) {
      await failStage(err);
      continue;
    }

    /**
     * Retention, at the one point the Application already owns the effect.
     *
     * A retention failure does NOT abort the run and does NOT fabricate a ref: the refs stay
     * null — the honest "not retained here" — and the failure is evented so it is not silent.
     * Aborting would leave the truncated bundle this module's history is full of; a fabricated
     * ref would be worse still, since the `dangling-ref` gate would then refuse a promotion
     * over content that was never written rather than content that was lost.
     */
    let inputRef: string | null = null;
    let outputRef: string | null = null;
    const outputBody = summarize(stage.id, ctx);
    try {
      inputRef = await retain(opts.content, "stage-input",
        JSON.stringify({ system: request.system ?? null, messages: request.messages }));
      outputRef = await retain(opts.content, "stage-output", outputBody);
      if (inputRef) retainedRefs.add(inputRef);
      if (outputRef) retainedRefs.add(outputRef);
    } catch (err) {
      emit("DEGRADE", {
        component: `application/pipeline`,
        failure_code: "content_retention_failed",
        // Type, not message — see the note on `failStage`.
        verdict: err instanceof Error ? err.name : "UnknownError",
      });
    }

    const revision = buildRevision({
      run_id, stage_id: stage.id, inputHash: stageInputHash,
      outputText: outputBody,
      inputRef, outputRef,
      attempts,
      status: degraded ? "DEMO" : "SUCCEEDED",
      provider: degraded ? null : (outcome as GenerationResult).provider_id,
      fingerprint: degraded ? null : `${(outcome as GenerationResult).provider_id}:${(outcome as GenerationResult).model_id}`,
      gate_results: [],
      now, coreBuildHash, configFingerprint: opts.configFingerprint ?? null, feedbackRound,
        parents: revision_ids.slice(-1),
    });
    await opts.store.append(revision);
    revision_ids.push(revision.revision_id);
    if (degraded) {
      // The orchestrator emits this and the pipeline did not, so from events alone a
      // consumer could not tell an eleven-stage run degraded eleven times.
      const f = outcome as ProviderFailure;
      emit("DEGRADE", {
        component: `core/stages/${stage.id}`,
        provider_id: f.provider_id, failure_code: f.reason_code, attempt: f.attempt,
      });
    }
    stages.push({
      stage_id: stage.id,
      status: degraded ? "DEMO" : "SUCCEEDED",
      revision_id: revision.revision_id,
      output_hash: revision.output_hash,
    });
    emit("REVISION_PERSISTED", { component: `core/stages/${stage.id}`, output_hash: revision.output_hash });
  }

  /**
   * Reclaim content that eviction orphaned.
   *
   * `storage-local` retains eight run bundles and evicts the ninth whole, but content lives in
   * its own directory precisely so it is not on a bundle's lifetime — which meant, until sweep
   * thirteen, that evicting a bundle reclaimed nothing at all. Measured over twelve runs: eight
   * bundles survived and **20 of 60 content files were orphaned**. Bounded in bundles,
   * unbounded in bytes.
   *
   * The live set is recomputed from the surviving bundles rather than tracked, so it is
   * sharing-safe without a refcount: content backing two runs is named while either survives.
   *
   * Failure here does NOT fail the run. The artifact is written and persisted by this point;
   * refusing to return it because a disk reclaim went wrong would trade a real result for a
   * housekeeping error. It is evented instead, so an unbounded store cannot grow silently.
   */
  if (opts.content) {
    try {
      const live = new Set<string>();
      for (const summary of await opts.store.listRecent(BUNDLE_SWEEP_LIMIT)) {
        for (const e of await opts.store.getRun(summary.run_id)) {
          if (e.input_ref) live.add(e.input_ref);
          if (e.output_ref) live.add(e.output_ref);
        }
      }

      /**
       * Refuse to sweep unless the enumeration can be trusted.
       *
       * The live set is built from `listRecent`, which the port describes as a RECENT listing
       * with a limit — not an authoritative enumeration. `storage-local` happens to return
       * every retained bundle when asked for more than it keeps, but nothing in the contract
       * promises that, and an implementation that under-reports would make this delete content
       * a surviving revision still cites. That failure is silent, permanent, and worse than the
       * leak it replaces.
       *
       * The run that just finished is certainly live, so its own refs must appear. If they do
       * not, the enumeration is incomplete and the only safe move is to reclaim nothing. Caught
       * exactly this way: a test store whose `listRecent` returned `[]` sent the sweep after
       * every file on disk.
       */
      /**
       * Positive evidence, not the absence of contradiction.
       *
       * This read the run back from the store and required its refs to appear in the live set.
       * `[].every()` is TRUE, so a bundle that was empty, lost or unreadable reported the
       * enumeration as trustworthy and the sweep reclaimed everything — measured by sweep
       * fifteen: a bundle corrupted by concurrent appends left 0 surviving revisions, and all
       * 12 retained bodies were then permanently deleted. A guard that passes when it learns
       * nothing is not a guard.
       *
       * `retainedRefs` is what THIS run wrote, held in memory and never re-read, so it cannot
       * be emptied by a storage fault. If the run retained anything, every one of those refs
       * must come back from the enumeration before a single file is reclaimed.
       */
      const enumerationTrustworthy = retainedRefs.size === 0
        ? true
        : [...retainedRefs].every((r) => live.has(r));

      if (!enumerationTrustworthy) {
        emit("DEGRADE", {
          component: "application/pipeline",
          failure_code: "content_sweep_skipped",
          verdict: `the live set is missing refs this run retained, so the enumeration is incomplete; ${retainedRefs.size} retained ref(s). Nothing reclaimed.`,
        });
      } else {
        await opts.content.sweep(live);
      }
    } catch (err) {
      emit("DEGRADE", {
        component: "application/pipeline",
        failure_code: "content_sweep_failed",
        // Type, not message — see the note on `failStage`.
        verdict: err instanceof Error ? err.name : "UnknownError",
      });
    }
  }

  return {
    run_id,
    context: ctx,
    stages,
    // Gating is `lint`'s job in the frozen pipeline, and now here too. `compile` also runs
    // gates inline — a vertical-slice artifact kept because the single-stage path and the
    // eval suite read them from there — but the RUN's verdict comes from lint, which uses
    // the full sixteen-gate registry against the final prompt rather than an intermediate.
    gate_results: ctx.gate_results ?? [],
    demo_mode: anyDemo,
    failed: anyFailed,
    revision_ids,
    budget_unenforced: admission.unenforced,
  };
}

/** The text a stage contributed, for hashing and for the revision record. */
function summarize(id: StageId, ctx: PipelineContext): string {
  const byStage: Partial<Record<StageId, string | undefined>> = {
    deconstruct: ctx.spec, calibrate: ctx.calibration,
    compile: ctx.prompt, harden: ctx.prompt, refine: ctx.prompt,
    critique: ctx.critique, lint: ctx.lint, critic: ctx.critic,
    preview: ctx.preview, cost_estimate: ctx.cost, tone_check: ctx.tone,
  };
  return byStage[id] ?? "";
}

/**
 * The run's inputs, plus the artifact the remaining consumers of this hash actually read.
 *
 * A stage's input hash should identify what it was given, and every stage is given the
 * whole context — so hashing it verbatim would make every input hash change whenever any
 * earlier stage's output changed, including stages that never read it. That argument is
 * why `prompt` was excluded, and it stopped being true once the generating stages moved to
 * `stageInputHash`: they hash the rendered request now and do not come here at all.
 *
 * What is left are the deterministic stages, the skip path and the failure path — and all
 * three read `prompt`. `lint` and `cost_estimate` consume nothing else of substance, and
 * every one of the five skip predicates tests it.
 *
 * Excluding it made `lint` claim an input it did not have. Measured on a reflexive run at
 * a cap of 2: three lint revisions over three genuinely different prompts recorded ONE
 * distinct `input_hash` and three distinct `output_hash` values, while `refine` in the same
 * run recorded three distinct input hashes. An input hash that cannot move while the output
 * does is the self-contradicting provenance the generating branch fixed for itself; this is
 * the same fix on the branch that has no request to hash.
 *
 * `gateOptions` rides along because it arms four gates, so two lint runs over the same
 * prompt with different options are different checks and must not share an input hash.
 */
function redactForHash(ctx: PipelineContext) {
  const { brief, stakes, depth, testMessage, prompt, gateOptions } = ctx;
  return { brief, stakes, depth, testMessage, prompt, gateOptions };
}

function buildRevision(a: {
  run_id: string; stage_id: StageId; inputHash: string; outputText: string;
  status: RevisionEntry["status"]; provider: string | null; fingerprint?: string | null; attempts?: number;
  gate_results: GateResult[]; now: () => Date; coreBuildHash: string; configFingerprint: string | null;
  feedbackRound?: number; parents?: string[];
  inputRef?: string | null; outputRef?: string | null;
}): RevisionEntry {
  const provenance: ExecutionProvenance = {
    core_build_hash: a.coreBuildHash,
    contract_versions: CONTRACT_VERSIONS,
    provider_model_fingerprint: a.fingerprint ?? null,
    config_fingerprint: a.configFingerprint,
  };
  return {
    revision_id: randomUUID(),
    run_id: a.run_id,
    stage_id: a.stage_id,
    /**
     * Real lineage, populated since revision-entry 1.3.1. It existed from 1.0.0 and nothing
     * wrote it, so `markStale` had no graph to walk and fell back to append order.
     *
     * The parent is whatever ran immediately before, because that is what produced the
     * context this stage consumed. On a gate-feedback jump the loop moves BACKWARDS, so the
     * re-run of `refine` records the failing `lint` as its parent — which is accurate, and
     * is exactly the edge array position cannot represent.
     */
    parent_revision_ids: a.parents ?? [],
    timestamp: a.now().toISOString(),
    // Provider attempts within THIS execution. The real count — hardcoding 1 made a
    // revision claim one attempt and mean three. Re-executions are `feedback_round`.
    stage_attempt: a.attempts ?? 1,
    feedback_round: a.feedbackRound ?? 0,
    input_hash: a.inputHash,
    output_hash: sha256(a.outputText),
    /**
     * Retention pointers (revision-entry 1.4.0, [AUDIT B-4]). Populated only when a
     * ContentStore is wired into the runner — otherwise null, the honest "not retained
     * here". Never fabricated to satisfy the schema.
     */
    input_ref: a.inputRef ?? null,
    output_ref: a.outputRef ?? null,
    gate_results: a.gate_results,
    status: a.status,
    freshness: "FRESH",
    provider_used: a.provider,
    execution_provenance: provenance,
    retention_scope: "LOCAL_BUNDLE",
  };
}
