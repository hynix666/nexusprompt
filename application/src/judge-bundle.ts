/**
 * Orchestrates one brief-fidelity judging of one completed run: reads the bundle through the
 * existing storage ports, builds the candidate, calls the existing GuardedJudge, and records
 * the result as a new judgement evidence record. Owns the one live effect this needs beyond
 * what GuardedJudge already owns: reading the bundle and writing the evidence record.
 *
 * ## Which revision holds the compiled prompt
 *
 * The LAST revision in a run is never it. `summarize()` in ./pipeline.ts maps stage ids to
 * context fields, and only `compile`, `harden` and `refine` map to `ctx.prompt` — the compiled
 * system prompt. Every depth plan in core/src/stages/pipeline.ts ends with `cost_estimate`
 * (TINY, MINIMAL) or `tone_check` (STANDARD, COMPREHENSIVE), so reading the last revision's
 * output graded a cost table or a tone report against the brief and called the number a
 * brief-fidelity score. This walks BACKWARD to the last revision whose stage is one of the
 * three that produce `ctx.prompt`, and refuses when a run has none.
 *
 * Backward, not forward: under gate feedback a stage can execute more than once, the
 * superseded revision is marked STALE, and the replacement is appended after it. The last
 * matching revision in append order is therefore the surviving one.
 *
 * ## Where the brief lives
 *
 * Nowhere as a bare artifact. `RunManifest` and `RevisionEntry` carry no brief field, the
 * deterministic stages retain no content at all, and ./pipeline.ts retains a generating stage's
 * input as `JSON.stringify({ system, messages })` — the rendered provider request. The only
 * copy of a completed run's brief is therefore the one interpolated into the `deconstruct`
 * stage's template, inside that envelope. Reading the envelope verbatim as "the brief" fed the
 * judge ~2.3 KB of compiler system prompt and stage instructions the compiled prompt was never
 * meant to satisfy, which distorts `completeness` and `no_overreach` in particular.
 *
 * So: parse the envelope, take the rendered user turn, and invert `deconstruct.decide` with
 * Core's `extractBrief` — which derives its delimiters from the template itself rather than
 * transcribing them. Every step refuses rather than guesses; a fidelity score against a brief
 * the run never saw is worse than no score.
 *
 * ## What must never be graded
 *
 * The revision being graded must be SUCCEEDED, and NO revision in the run may be DEMO. The
 * second is not redundant: in a demo-mode run the generating stages go DEMO while the
 * deterministic ones (`lint`, `cost_estimate`) still report SUCCEEDED, so checking one
 * revision's status is defeated by whichever stage happened to run last. Measured over the
 * eight bundles retained in `.nexusprompt/runs`: every one contains a DEMO stage and ends on
 * `cost_estimate/SUCCEEDED`. A later stage cannot undo an earlier stage's degradation, and grading
 * placeholder output would produce a score dressed up as real — the same concern
 * CLAIM_DISCIPLINE enforces elsewhere.
 */
import { randomUUID } from "node:crypto";
import { GuardedJudge } from "./judge.js";
import { buildFidelityCandidate, BRIEF_FIDELITY_RUBRIC_TEMPLATE, BRIEF_FIDELITY_CONTRACT_CHANGED_AT } from "../../core/src/eval/brief-fidelity.js";
import { extractBrief } from "../../core/src/stages/deconstruct.js";
import type {
  RevisionStore, RevisionEntry, ContentStore, EvidenceStore, JudgeTransport, Judgement, StageId,
} from "../../contracts/index.js";
import type { Calibration } from "../../core/src/eval/judge-policy.js";

export class JudgeBundleRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "JudgeBundleRefused";
  }
}

export interface JudgeBundleDeps {
  revisions: RevisionStore;
  content: ContentStore;
  evidence: EvidenceStore;
  transport: JudgeTransport;
  calibration: Calibration;
}

/**
 * The stages whose retained output IS the compiled prompt.
 *
 * Exactly the three that `summarize()` maps to `ctx.prompt`. Kept as a set beside a comment
 * naming its source rather than derived from `summarize`, which is a private function over a
 * context object and has no inspectable mapping — but `judge-bundle.test.ts` asserts this set
 * against `PIPELINE`'s own stage ids so a twelfth prompt-producing stage cannot land unnoticed.
 */
export const PROMPT_PRODUCING_STAGES: ReadonlySet<StageId> = new Set<StageId>([
  "compile", "harden", "refine",
]);

/**
 * A comparable model family from a `provider_model_fingerprint`.
 *
 * `admitJudge` refuses self-grading by comparing the judge's `judge_family` against the
 * candidate's, and the two were never expressible in the same vocabulary: the pipeline records
 * `` `${provider_id}:${model_id}` `` (e.g. "local-proxy:claude-opus-5") while
 * HostedJudgeTransport reports the bare family "claude". Exact string comparison of those two
 * can never be equal, so the refusal the design calls "what makes self-preference detection
 * meaningful" could not fire even when the judge and the graded model were the same model.
 *
 * Derived, not enumerated: the family is the model id's leading alphabetic run, which turns
 * "claude-opus-5" into "claude", "gpt-4o" into "gpt" and "llama3.1:8b" into "llama". A table of
 * known vendors would be a sparse matcher that silently stops recognising the next model name,
 * and the direction it fails in is the dangerous one — a family it does not recognise is a
 * self-grading it does not refuse.
 *
 * Splitting on the FIRST colon: a model id may contain colons of its own
 * ("ollama-local:phi4-mini:latest"), the provider id may not.
 */
export function candidateFamilyFromFingerprint(fingerprint: unknown): string {
  if (typeof fingerprint !== "string" || fingerprint.trim() === "") return "unknown";
  const separator = fingerprint.indexOf(":");
  const modelId = separator === -1 ? fingerprint : fingerprint.slice(separator + 1);
  const family = modelId.trim().toLowerCase().match(/^[a-z]+/);
  return family ? family[0] : "unknown";
}

async function resolveText(content: ContentStore, ref: string | null, what: string): Promise<string> {
  if (!ref) {
    throw new JudgeBundleRefused("missing-content-ref", `${what} has no retained content ref — cannot judge.`);
  }
  const bytes = await content.get(ref);
  if (!bytes) {
    throw new JudgeBundleRefused("content-not-found", `${what}'s content ref ${ref} does not resolve — evicted or never written.`);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The brief, recovered from the `deconstruct` stage's retained provider request.
 *
 * The FIRST deconstruct revision, deliberately: under gate feedback a run can re-execute
 * stages, and the brief is what the run was originally given, not what a later round rendered.
 * `deconstruct` is never a feedback resume target today, so first and last coincide — asking
 * for the first is what keeps that true if a resume point ever moves.
 */
async function resolveBrief(
  content: ContentStore,
  revisions: readonly RevisionEntry[],
  run_id: string,
): Promise<string> {
  const deconstruct = revisions.find((r) => r.stage_id === "deconstruct");
  if (!deconstruct) {
    throw new JudgeBundleRefused(
      "no-deconstruct-stage",
      `Run "${run_id}" has no "deconstruct" revision, which is the only stage whose retained ` +
      `input carries the original brief — there is nothing to grade fidelity AGAINST.`,
    );
  }

  const envelope = await resolveText(
    content, deconstruct.input_ref, `Run "${run_id}"'s deconstruct stage input`,
  );

  /**
   * The shape this depends on, stated because it is a coupling and not an accident:
   * `application/src/pipeline.ts` retains a generating stage's input as
   * `JSON.stringify({ system: request.system ?? null, messages: request.messages })`, and
   * `stage-kit.ts`'s `buildRequest` puts the rendered template in `messages[0].content` as the
   * single user turn. Both halves refuse rather than fall back, so a change to either produces
   * a named refusal instead of a brief that is quietly the wrong text.
   */
  let userTurn: unknown;
  try {
    const parsed = JSON.parse(envelope) as { messages?: Array<{ content?: unknown }> };
    userTurn = parsed?.messages?.[0]?.content;
  } catch {
    throw new JudgeBundleRefused(
      "unreadable-brief-envelope",
      `Run "${run_id}"'s deconstruct input is not the JSON provider-request envelope this ` +
      `pipeline retains — the brief cannot be recovered from it.`,
    );
  }
  if (typeof userTurn !== "string") {
    throw new JudgeBundleRefused(
      "unreadable-brief-envelope",
      `Run "${run_id}"'s deconstruct input envelope has no string messages[0].content — ` +
      `the brief cannot be recovered from it.`,
    );
  }

  const brief = extractBrief(userTurn);
  if (brief === null) {
    throw new JudgeBundleRefused(
      "brief-not-extractable",
      `Run "${run_id}"'s deconstruct request does not match the deconstruct template, so the ` +
      `brief interpolated into it cannot be recovered. Grading the raw request instead would ` +
      `score the compiled prompt against this pipeline's own stage instructions.`,
    );
  }
  return brief;
}

export async function judgeBundle(deps: JudgeBundleDeps, run_id: string, now: string): Promise<Judgement> {
  const revisions = await deps.revisions.getRun(run_id);
  if (revisions.length === 0) {
    throw new JudgeBundleRefused("run-not-found", `No revisions found for run "${run_id}".`);
  }

  /**
   * Checked before anything is resolved, because it is a fact about the RUN and not about the
   * stage being read. See the module header: a demo-mode run's deterministic stages report
   * SUCCEEDED, so a per-revision check alone passes 100% of the degraded bundles on disk.
   */
  const demoed = revisions.filter((r) => r.status === "DEMO");
  if (demoed.length > 0) {
    throw new JudgeBundleRefused(
      "demo-mode-run",
      `Run "${run_id}" has ${demoed.length} DEMO stage(s) (${demoed.map((r) => r.stage_id).join(", ")}) — ` +
      `no model produced this run's output, and a later stage reporting SUCCEEDED does not undo that. ` +
      `Grading it would score placeholder text as if it were real.`,
    );
  }

  const compiled = [...revisions].reverse().find((r) => PROMPT_PRODUCING_STAGES.has(r.stage_id));
  if (!compiled) {
    throw new JudgeBundleRefused(
      "no-compiled-prompt-stage",
      `Run "${run_id}" has no ${[...PROMPT_PRODUCING_STAGES].join("/")} revision, so it never ` +
      `produced a compiled prompt. Its last revision is "${revisions[revisions.length - 1].stage_id}", ` +
      `whose output is not the compiled prompt and must not be graded as one.`,
    );
  }

  /**
   * `!== "SUCCEEDED"`, not a list of the four bad statuses.
   *
   * `RevisionStatus` has exactly five members today and the denylist named the other four, so
   * this is behaviour-identical — but it fails CLOSED, and a sixth status added later would
   * have walked straight through the denylist into a grading.
   */
  if (compiled.status !== "SUCCEEDED") {
    throw new JudgeBundleRefused(
      "degraded-compiled-prompt",
      `Run "${run_id}"'s compiled prompt came from "${compiled.stage_id}", whose revision is ` +
      `${compiled.status}, not SUCCEEDED — judging it would score placeholder or absent output ` +
      `as if it were real.`,
    );
  }

  const brief = await resolveBrief(deps.content, revisions, run_id);
  const compiledPrompt = await resolveText(
    deps.content, compiled.output_ref, `Run "${run_id}"'s "${compiled.stage_id}" stage output`,
  );

  const candidate = buildFidelityCandidate(brief, compiledPrompt);
  const candidateFamily = candidateFamilyFromFingerprint(
    (compiled.execution_provenance as { provider_model_fingerprint?: unknown } | undefined)
      ?.provider_model_fingerprint,
  );

  const guarded = new GuardedJudge(deps.transport);
  const verdict = await guarded.grade(
    {
      candidate,
      rubric_id: "brief-fidelity-v1",
      rubric_template: BRIEF_FIDELITY_RUBRIC_TEMPLATE,
      candidate_family: candidateFamily,
      verification_status: "judge-checkable",
      calibration: deps.calibration,
    },
    BRIEF_FIDELITY_CONTRACT_CHANGED_AT,
    now,
  );

  const judgement: Judgement = {
    judgement_id: randomUUID(),
    run_id,
    created_at: now,
    verdict,
  };

  await deps.evidence.put({ kind: "judgement", id: judgement.judgement_id, created_at: now, body: judgement });
  return judgement;
}
