import { describe, it, expect } from "vitest";
import { judgeBundle, JudgeBundleRefused, PROMPT_PRODUCING_STAGES, candidateFamilyFromFingerprint } from "../src/judge-bundle.js";
import { PIPELINE } from "../../core/src/stages/pipeline.js";
import { COMPILER_SYSTEM } from "../../core/src/stages/stage-kit.js";
import * as deconstruct from "../../core/src/stages/deconstruct.js";
import type { RevisionEntry, RevisionStore, ContentStore, EvidenceStore, EvidenceRecord, EvidenceSummary, RetentionScope, StageId } from "../../contracts/index.js";
import type { JudgeTransport, JudgeRequest, JudgeVerdict } from "../../contracts/index.js";

const encode = (s: string) => new TextEncoder().encode(s);

class FakeRevisionStore implements RevisionStore {
  constructor(private readonly revisions: RevisionEntry[]) {}
  async append(): Promise<void> { throw new Error("not used"); }
  async getRun(): Promise<RevisionEntry[]> { return this.revisions; }
  async listRecent(): Promise<any[]> { throw new Error("not used"); }
  async markStale(): Promise<void> { throw new Error("not used"); }
}

class FakeContentStore implements ContentStore {
  readonly retention_scope: RetentionScope = "LOCAL_BUNDLE";
  constructor(private readonly byRef: Record<string, string>) {}
  async put(): Promise<void> { throw new Error("not used"); }
  async get(ref: string): Promise<Uint8Array | null> {
    return ref in this.byRef ? encode(this.byRef[ref]) : null;
  }
  async has(ref: string): Promise<boolean> { return ref in this.byRef; }
  async sweep(): Promise<number> { throw new Error("not used"); }
}

class FakeEvidenceStore implements EvidenceStore {
  readonly retention_scope: RetentionScope = "LOCAL_BUNDLE";
  readonly written: EvidenceRecord[] = [];
  async put(record: EvidenceRecord): Promise<void> { this.written.push(record); }
  async get(): Promise<EvidenceRecord | null> { throw new Error("not used"); }
  async list(): Promise<EvidenceSummary[]> { throw new Error("not used"); }
}

class ScriptedTransport implements JudgeTransport {
  readonly judge_id = "scripted";
  readonly judge_family = "other-family";
  readonly seen: JudgeRequest[] = [];
  async grade(req: JudgeRequest): Promise<JudgeVerdict> {
    this.seen.push(req);
    return {
      verdict: 12, rationale: null,
      judge_id: this.judge_id, judge_family: this.judge_family,
      rubric_id: req.rubric_id, rubric_hash: req.rubric_hash,
      runs: req.runs, disagreement_rate: 0, position_randomized: req.position_randomized,
      rubric_breakdown: {
        domain_captured: { score: 3, reason: "ok" }, constraints_honored: { score: 3, reason: "ok" },
        completeness: { score: 3, reason: "ok" }, no_overreach: { score: 3, reason: "ok" },
      },
    };
  }
}

const CALIBRATION = {
  metric: "cohens-kappa" as const, value: 0.82, threshold: 0.6,
  // Must be AFTER BRIEF_FIDELITY_CONTRACT_CHANGED_AT (2026-09-03T00:00:00.000Z) or admitJudge's
  // stale-calibration check refuses every test below before it reaches anything worth testing.
  // Also before every test's `now` (00:02:00 / 00:03:00) so ageDays stays a sensible positive
  // number rather than a confusing negative one.
  measured_at: "2026-09-03T00:01:00.000Z", reference: "mutation-derived-v1", max_age_days: 30,
};

const BRIEF = "A support assistant for a SaaS billing team. Refuse anything outside billing.";
const COMPILED = "# SYSTEM PROMPT\n\n## 1. IDENTITY\nScope: billing only.";
const TONE_REPORT = "VOICE: CONSISTENT — the prompt's register holds across sections.";

/**
 * The bytes a REAL run retains for the deconstruct stage: the rendered provider request, not
 * the brief. See application/src/pipeline.ts's `retain` call. Built by calling the same
 * `decide` the pipeline calls, so this fixture cannot describe an envelope the pipeline does
 * not actually write.
 */
function deconstructEnvelope(brief: string): string {
  const request = deconstruct.decide({ brief }, "run-1");
  return JSON.stringify({ system: request.system ?? null, messages: request.messages });
}

const ref = (kind: "stage-input" | "stage-output", ch: string) =>
  `npx:${kind}:${ch.repeat(64)}:local-bundle`;

const REFS = {
  deconstructIn: ref("stage-input", "c"),
  refineOut: ref("stage-output", "d"),
  toneOut: ref("stage-output", "1"),
};

const CONTENT: Record<string, string> = {
  [REFS.deconstructIn]: deconstructEnvelope(BRIEF),
  [REFS.refineOut]: COMPILED,
  [REFS.toneOut]: TONE_REPORT,
};

function revision(over: Partial<RevisionEntry> & { stage_id: StageId; revision_id: string }): RevisionEntry {
  return {
    run_id: "run-1", timestamp: "2026-09-03T00:00:00.000Z", stage_attempt: 1,
    input_hash: "a".repeat(64), output_hash: "b".repeat(64),
    input_ref: null, output_ref: null,
    gate_results: [], freshness: "FRESH", status: "SUCCEEDED", provider_used: "local-proxy",
    execution_provenance: {
      core_build_hash: "test", contract_versions: {},
      provider_model_fingerprint: "ollama-local:phi4-mini:latest", config_fingerprint: null,
    },
    retention_scope: "LOCAL_BUNDLE", parent_revision_ids: [],
    ...over,
  };
}

/**
 * A run shaped like the ones the pipeline actually produces at STANDARD depth: the compiled
 * prompt is `refine`'s output and the LAST revision is `tone_check`, whose output is a tone
 * report. The previous fixture had only two revisions with the compiled prompt on the last one,
 * which is the shape that let the wrong-artifact defect pass nine reviews.
 */
function baseRevisions(overrides: {
  refine?: Partial<RevisionEntry>;
  tone?: Partial<RevisionEntry>;
} = {}): RevisionEntry[] {
  return [
    revision({ revision_id: "r1", stage_id: "deconstruct", input_ref: REFS.deconstructIn }),
    revision({ revision_id: "r2", stage_id: "compile", output_ref: REFS.refineOut, parent_revision_ids: ["r1"] }),
    revision({ revision_id: "r3", stage_id: "refine", output_ref: REFS.refineOut, parent_revision_ids: ["r2"], ...overrides.refine }),
    revision({ revision_id: "r4", stage_id: "lint", parent_revision_ids: ["r3"] }),
    revision({ revision_id: "r5", stage_id: "tone_check", output_ref: REFS.toneOut, parent_revision_ids: ["r4"], ...overrides.tone }),
  ];
}

const deps = (revisions: RevisionEntry[], extra: Partial<{
  content: ContentStore; evidence: FakeEvidenceStore; transport: JudgeTransport;
}> = {}) => ({
  revisions: new FakeRevisionStore(revisions),
  content: extra.content ?? new FakeContentStore(CONTENT),
  evidence: extra.evidence ?? new FakeEvidenceStore(),
  transport: extra.transport ?? new ScriptedTransport(),
  calibration: CALIBRATION,
});

describe("PROMPT_PRODUCING_STAGES", () => {
  it("names only stages the pipeline actually has", () => {
    const known = new Set(PIPELINE.map((s) => s.id));
    for (const id of PROMPT_PRODUCING_STAGES) expect(known.has(id), id).toBe(true);
  });

  it("excludes every stage that ends a depth plan", () => {
    // The defect this whole set exists for: cost_estimate ends TINY/MINIMAL and tone_check ends
    // STANDARD/COMPREHENSIVE, so "the last revision" is never the compiled prompt.
    expect(PROMPT_PRODUCING_STAGES.has("cost_estimate")).toBe(false);
    expect(PROMPT_PRODUCING_STAGES.has("tone_check")).toBe(false);
  });
});

describe("candidateFamilyFromFingerprint", () => {
  it("reduces a provider:model fingerprint to the family HostedJudgeTransport reports", () => {
    expect(candidateFamilyFromFingerprint("local-proxy:claude-opus-5")).toBe("claude");
    expect(candidateFamilyFromFingerprint("anthropic:claude-sonnet-5")).toBe("claude");
  });

  it("handles a model id that contains colons of its own", () => {
    expect(candidateFamilyFromFingerprint("ollama-local:phi4-mini:latest")).toBe("phi");
  });

  it("reports unknown rather than guessing when there is no fingerprint", () => {
    expect(candidateFamilyFromFingerprint(null)).toBe("unknown");
    expect(candidateFamilyFromFingerprint(undefined)).toBe("unknown");
    expect(candidateFamilyFromFingerprint("")).toBe("unknown");
    expect(candidateFamilyFromFingerprint("local-proxy:404")).toBe("unknown");
  });
});

describe("judgeBundle", () => {
  it("grades the compiled prompt from the last compile/harden/refine stage, not the last revision", async () => {
    const transport = new ScriptedTransport();
    const evidence = new FakeEvidenceStore();
    const j = await judgeBundle(deps(baseRevisions(), { transport, evidence }), "run-1", "2026-09-03T00:02:00.000Z");

    expect(j.run_id).toBe("run-1");
    expect(evidence.written).toHaveLength(1);
    expect(evidence.written[0].kind).toBe("judgement");

    const candidate = transport.seen[0].candidate;
    expect(candidate).toContain(COMPILED);
    // The tone report is what the LAST revision holds. It must not be what got graded.
    expect(candidate).not.toContain(TONE_REPORT);
  });

  it("grades the BRIEF, not the provider-request envelope the brief is retained inside", async () => {
    const transport = new ScriptedTransport();
    await judgeBundle(deps(baseRevisions(), { transport }), "run-1", "2026-09-03T00:02:00.000Z");
    const candidate = transport.seen[0].candidate;

    expect(candidate).toContain(BRIEF);
    // None of the envelope's own furniture may reach the judge: the compiler system prompt, the
    // stage instruction wrapped around the brief, or the JSON keys of the retained request.
    expect(candidate).not.toContain(COMPILER_SYSTEM);
    expect(candidate).not.toContain("STEP 1 — ANALYSIS");
    expect(candidate).not.toContain('"messages"');
  });

  it("refuses a run with no compile/harden/refine revision", async () => {
    const revisions = [
      revision({ revision_id: "r1", stage_id: "deconstruct", input_ref: REFS.deconstructIn }),
      revision({ revision_id: "r2", stage_id: "cost_estimate" }),
    ];
    const evidence = new FakeEvidenceStore();
    // The typed refusal, not merely an Error: every branch below asserts a `code`, and a `code`
    // on a plain Error would satisfy `toMatchObject` without the caller being able to catch it.
    const err = await judgeBundle(deps(revisions, { evidence }), "run-1", "2026-09-03T00:02:00.000Z")
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(JudgeBundleRefused);
    expect(err.code).toBe("no-compiled-prompt-stage");
    expect(evidence.written).toHaveLength(0);
  });

  it("refuses when the graded stage itself is not SUCCEEDED, even though a later stage is", async () => {
    // SKIPPED rather than DEMO so this exercises the per-revision guard and not the run-wide one.
    const evidence = new FakeEvidenceStore();
    await expect(judgeBundle(
      deps(baseRevisions({ refine: { status: "SKIPPED" } }), { evidence }),
      "run-1", "2026-09-03T00:02:00.000Z",
    )).rejects.toMatchObject({ code: "degraded-compiled-prompt" });
    expect(evidence.written).toHaveLength(0);
  });

  it("refuses a run containing ANY DEMO stage, even when every later revision SUCCEEDED", async () => {
    /**
     * The measured shape: all 8 bundles retained under .nexusprompt/runs (storage keeps 8 runs,
     * whole) contain a DEMO stage and end on `cost_estimate/SUCCEEDED`, because the
     * deterministic stages have no provider to lose and so cannot degrade. A guard that reads
     * one revision's status passes every one of them.
     */
    const revisions = baseRevisions();
    revisions[1] = { ...revisions[1], status: "DEMO" };
    expect(revisions[revisions.length - 1].status).toBe("SUCCEEDED");

    const evidence = new FakeEvidenceStore();
    await expect(judgeBundle(deps(revisions, { evidence }), "run-1", "2026-09-03T00:02:00.000Z"))
      .rejects.toMatchObject({ code: "demo-mode-run" });
    expect(evidence.written).toHaveLength(0);
  });

  it("refuses when the deconstruct input is not the envelope this pipeline retains", async () => {
    const content = new FakeContentStore({ ...CONTENT, [REFS.deconstructIn]: "just some bare text" });
    await expect(judgeBundle(deps(baseRevisions(), { content }), "run-1", "2026-09-03T00:02:00.000Z"))
      .rejects.toMatchObject({ code: "unreadable-brief-envelope" });
  });

  it("refuses when the deconstruct request does not match the deconstruct template", async () => {
    // Valid envelope, wrong user turn: the brief cannot be recovered, so grading the raw turn
    // would score the compiled prompt against text the run never took as its brief.
    const content = new FakeContentStore({
      ...CONTENT,
      [REFS.deconstructIn]: JSON.stringify({ system: null, messages: [{ role: "user", content: "not the template" }] }),
    });
    await expect(judgeBundle(deps(baseRevisions(), { content }), "run-1", "2026-09-03T00:02:00.000Z"))
      .rejects.toMatchObject({ code: "brief-not-extractable" });
  });

  it("refuses a run with no deconstruct revision at all", async () => {
    const revisions = baseRevisions().filter((r) => r.stage_id !== "deconstruct");
    await expect(judgeBundle(deps(revisions), "run-1", "2026-09-03T00:02:00.000Z"))
      .rejects.toMatchObject({ code: "no-deconstruct-stage" });
  });

  it("refuses self-grading when the pipeline's fingerprint and the judge resolve to one family", async () => {
    /**
     * Important 5: the fingerprint is `provider:model` and HostedJudgeTransport reports a bare
     * family, so exact comparison could never be equal and the self-preference refusal — the
     * design's stated reason this wiring exists — could not fire for any input at all.
     */
    class ClaudeJudge implements JudgeTransport {
      readonly judge_id = "claude-opus-5";
      readonly judge_family = "claude";
      async grade(): Promise<JudgeVerdict> { throw new Error("must never be called"); }
    }
    const revisions = baseRevisions();
    const claudeFingerprint = {
      core_build_hash: "test", contract_versions: {},
      provider_model_fingerprint: "local-proxy:claude-opus-5", config_fingerprint: null,
    };
    revisions[2] = { ...revisions[2], execution_provenance: claudeFingerprint };

    const evidence = new FakeEvidenceStore();
    await expect(judgeBundle(deps(revisions, { evidence, transport: new ClaudeJudge() }), "run-1", "2026-09-03T00:02:00.000Z"))
      .rejects.toThrow(/self-preference/);
    expect(evidence.written).toHaveLength(0);
  });

  it("writes nothing when the transport throws", async () => {
    class FailingTransport implements JudgeTransport {
      readonly judge_id = "fails"; readonly judge_family = "other-family";
      async grade(): Promise<JudgeVerdict> { throw new Error("network error"); }
    }
    const evidence = new FakeEvidenceStore();
    await expect(judgeBundle(deps(baseRevisions(), { evidence, transport: new FailingTransport() }), "run-1", "2026-09-03T00:02:00.000Z"))
      .rejects.toThrow();
    expect(evidence.written).toHaveLength(0);
  });

  it("allows judging the same run twice, producing two distinct judgement ids", async () => {
    const evidence = new FakeEvidenceStore();
    const d = deps(baseRevisions(), { evidence });
    const first = await judgeBundle(d, "run-1", "2026-09-03T00:02:00.000Z");
    const second = await judgeBundle(d, "run-1", "2026-09-03T00:03:00.000Z");
    expect(first.judgement_id).not.toBe(second.judgement_id);
    expect(evidence.written).toHaveLength(2);
  });

  it("refuses when no revisions exist for the run", async () => {
    const evidence = new FakeEvidenceStore();
    await expect(judgeBundle(deps([], { evidence }), "run-1", "2026-09-03T00:02:00.000Z"))
      .rejects.toMatchObject({ code: "run-not-found" });
    expect(evidence.written).toHaveLength(0);
  });

  it("refuses when the deconstruct revision's input_ref is null", async () => {
    const revisions = baseRevisions();
    revisions[0] = { ...revisions[0], input_ref: null };
    const evidence = new FakeEvidenceStore();
    await expect(judgeBundle(deps(revisions, { evidence }), "run-1", "2026-09-03T00:02:00.000Z"))
      .rejects.toMatchObject({ code: "missing-content-ref" });
    expect(evidence.written).toHaveLength(0);
  });

  it("refuses when a content ref does not resolve", async () => {
    const revisions = baseRevisions({ refine: { output_ref: ref("stage-output", "9") } });
    const evidence = new FakeEvidenceStore();
    await expect(judgeBundle(deps(revisions, { evidence }), "run-1", "2026-09-03T00:02:00.000Z"))
      .rejects.toMatchObject({ code: "content-not-found" });
    expect(evidence.written).toHaveLength(0);
  });

  it("takes the LAST compile/harden/refine revision, so a gate-feedback rerun supersedes its predecessor", async () => {
    const stale = ref("stage-output", "7");
    const revisions = [
      revision({ revision_id: "r1", stage_id: "deconstruct", input_ref: REFS.deconstructIn }),
      revision({ revision_id: "r2", stage_id: "compile", output_ref: stale, freshness: "STALE" }),
      revision({ revision_id: "r3", stage_id: "lint", freshness: "STALE" }),
      revision({ revision_id: "r4", stage_id: "compile", output_ref: REFS.refineOut, feedback_round: 1 }),
      revision({ revision_id: "r5", stage_id: "lint", feedback_round: 1 }),
    ];
    const transport = new ScriptedTransport();
    const content = new FakeContentStore({ ...CONTENT, [stale]: "STALE PROMPT — superseded" });
    await judgeBundle(deps(revisions, { transport, content }), "run-1", "2026-09-03T00:02:00.000Z");
    expect(transport.seen[0].candidate).toContain(COMPILED);
    expect(transport.seen[0].candidate).not.toContain("STALE PROMPT");
  });
});
