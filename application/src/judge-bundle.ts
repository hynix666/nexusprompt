/**
 * Orchestrates one brief-fidelity judging of one completed run: reads the bundle through the
 * existing storage ports, builds the candidate, calls the existing GuardedJudge, and records
 * the result as a new judgement evidence record. Owns the one live effect this needs beyond
 * what GuardedJudge already owns: reading the bundle and writing the evidence record.
 *
 * STAGE_IDS[0] ("deconstruct") is where a run's ORIGINAL brief lives, as that stage's
 * input_ref — every later stage's input is a transformation of prior output, not the brief
 * itself. "The final compiled prompt" is the LAST revision in the array whose status is
 * SUCCEEDED (never DEMO or SKIPPED) — grading placeholder or absent output would produce a
 * score dressed up as real, the same concern CLAIM_DISCIPLINE enforces elsewhere.
 */
import { randomUUID } from "node:crypto";
import { GuardedJudge } from "./judge.js";
import { buildFidelityCandidate, BRIEF_FIDELITY_RUBRIC_TEMPLATE, BRIEF_FIDELITY_CONTRACT_CHANGED_AT } from "../../core/src/eval/brief-fidelity.js";
import type {
  RevisionStore, ContentStore, EvidenceStore, JudgeTransport, Judgement,
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

export async function judgeBundle(deps: JudgeBundleDeps, run_id: string, now: string): Promise<Judgement> {
  const revisions = await deps.revisions.getRun(run_id);
  if (revisions.length === 0) {
    throw new JudgeBundleRefused("run-not-found", `No revisions found for run "${run_id}".`);
  }

  const first = revisions[0];
  const last = revisions[revisions.length - 1];

  if (last.status === "DEMO" || last.status === "SKIPPED" || last.status === "FAILED" || last.status === "CANCELLED") {
    throw new JudgeBundleRefused(
      "degraded-final-stage",
      `Run "${run_id}"'s final stage ("${last.stage_id}") is ${last.status}, not SUCCEEDED — ` +
      `judging it would score placeholder or absent output as if it were real.`,
    );
  }

  const brief = await resolveText(deps.content, first.input_ref, `Run "${run_id}"'s first stage input`);
  const compiledPrompt = await resolveText(deps.content, last.output_ref, `Run "${run_id}"'s final stage output`);

  const candidate = buildFidelityCandidate(brief, compiledPrompt);
  const candidateFamily = String(
    (last.execution_provenance as { provider_model_fingerprint?: unknown } | undefined)?.provider_model_fingerprint ?? "unknown",
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
