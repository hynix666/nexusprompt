import { describe, it, expect } from "vitest";
import { judgeBundle, JudgeBundleRefused } from "../src/judge-bundle.js";
import type { RevisionEntry, RevisionStore, ContentStore, EvidenceStore, EvidenceRecord, EvidenceSummary, RetentionScope } from "../../contracts/index.js";
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
  async grade(req: JudgeRequest): Promise<JudgeVerdict> {
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

function baseRevisions(overrides: Partial<RevisionEntry> = {}): RevisionEntry[] {
  return [
    {
      revision_id: "r1", run_id: "run-1", stage_id: "deconstruct",
      timestamp: "2026-09-03T00:00:00.000Z", stage_attempt: 1,
      input_hash: "a".repeat(64), output_hash: "b".repeat(64),
      input_ref: "npx:stage-input:" + "c".repeat(64) + ":local-bundle",
      output_ref: "npx:stage-output:" + "d".repeat(64) + ":local-bundle",
      gate_results: [], freshness: "FRESH", status: "SUCCEEDED", provider_used: "ollama",
      execution_provenance: {
        core_build_hash: "test", contract_versions: {},
        provider_model_fingerprint: "phi4-mini:latest", config_fingerprint: null,
      },
      retention_scope: "LOCAL_BUNDLE", parent_revision_ids: [],
    },
    {
      revision_id: "r2", run_id: "run-1", stage_id: "tone_check",
      timestamp: "2026-09-03T00:01:00.000Z", stage_attempt: 1,
      input_hash: "e".repeat(64), output_hash: "f".repeat(64),
      input_ref: null,
      output_ref: "npx:stage-output:" + "1".repeat(64) + ":local-bundle",
      gate_results: [], freshness: "FRESH", status: "SUCCEEDED", provider_used: "ollama",
      execution_provenance: {
        core_build_hash: "test", contract_versions: {},
        provider_model_fingerprint: "phi4-mini:latest", config_fingerprint: null,
      },
      retention_scope: "LOCAL_BUNDLE", parent_revision_ids: ["r1"],
      ...overrides,
    },
  ];
}

const CONTENT = {
  ["npx:stage-input:" + "c".repeat(64) + ":local-bundle"]: "Write a billing assistant.",
  ["npx:stage-output:" + "1".repeat(64) + ":local-bundle"]: "# SYSTEM PROMPT\nScope: billing.",
};

describe("judgeBundle", () => {
  it("reads the brief from the first revision and the compiled prompt from the last successful one, then writes a Judgement", async () => {
    const store = new FakeRevisionStore(baseRevisions());
    const content = new FakeContentStore(CONTENT);
    const evidence = new FakeEvidenceStore();
    const j = await judgeBundle(
      { revisions: store, content, evidence, transport: new ScriptedTransport(), calibration: CALIBRATION },
      "run-1",
      "2026-09-03T00:02:00.000Z",
    );
    expect(j.run_id).toBe("run-1");
    expect(j.verdict.rubric_breakdown?.domain_captured.score).toBe(3);
    expect(evidence.written).toHaveLength(1);
    expect(evidence.written[0].kind).toBe("judgement");
  });

  it("refuses when the final stage is DEMO", async () => {
    const store = new FakeRevisionStore(baseRevisions({ status: "DEMO" }));
    const content = new FakeContentStore(CONTENT);
    const evidence = new FakeEvidenceStore();
    await expect(
      judgeBundle(
        { revisions: store, content, evidence, transport: new ScriptedTransport(), calibration: CALIBRATION },
        "run-1", "2026-09-03T00:02:00.000Z",
      ),
    ).rejects.toThrow(JudgeBundleRefused);
    expect(evidence.written).toHaveLength(0);
  });

  it("refuses when the final stage is SKIPPED", async () => {
    const store = new FakeRevisionStore(baseRevisions({ status: "SKIPPED" }));
    const content = new FakeContentStore(CONTENT);
    const evidence = new FakeEvidenceStore();
    await expect(
      judgeBundle(
        { revisions: store, content, evidence, transport: new ScriptedTransport(), calibration: CALIBRATION },
        "run-1", "2026-09-03T00:02:00.000Z",
      ),
    ).rejects.toThrow(JudgeBundleRefused);
  });

  it("writes nothing when the transport throws", async () => {
    class FailingTransport implements JudgeTransport {
      readonly judge_id = "fails"; readonly judge_family = "other-family";
      async grade(): Promise<JudgeVerdict> { throw new Error("network error"); }
    }
    const store = new FakeRevisionStore(baseRevisions());
    const content = new FakeContentStore(CONTENT);
    const evidence = new FakeEvidenceStore();
    await expect(
      judgeBundle(
        { revisions: store, content, evidence, transport: new FailingTransport(), calibration: CALIBRATION },
        "run-1", "2026-09-03T00:02:00.000Z",
      ),
    ).rejects.toThrow();
    expect(evidence.written).toHaveLength(0);
  });

  it("allows judging the same run twice, producing two distinct judgement ids", async () => {
    const store = new FakeRevisionStore(baseRevisions());
    const content = new FakeContentStore(CONTENT);
    const evidence = new FakeEvidenceStore();
    const deps = { revisions: store, content, evidence, transport: new ScriptedTransport(), calibration: CALIBRATION };
    const first = await judgeBundle(deps, "run-1", "2026-09-03T00:02:00.000Z");
    const second = await judgeBundle(deps, "run-1", "2026-09-03T00:03:00.000Z");
    expect(first.judgement_id).not.toBe(second.judgement_id);
    expect(evidence.written).toHaveLength(2);
  });

  it("refuses when no revisions exist for the run", async () => {
    const store = new FakeRevisionStore([]);
    const content = new FakeContentStore(CONTENT);
    const evidence = new FakeEvidenceStore();
    await expect(
      judgeBundle(
        { revisions: store, content, evidence, transport: new ScriptedTransport(), calibration: CALIBRATION },
        "run-1", "2026-09-03T00:02:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "run-not-found" });
    expect(evidence.written).toHaveLength(0);
  });

  it("refuses when the first revision's input_ref is null", async () => {
    const revisions = baseRevisions();
    revisions[0] = { ...revisions[0], input_ref: null };
    const store = new FakeRevisionStore(revisions);
    const content = new FakeContentStore(CONTENT);
    const evidence = new FakeEvidenceStore();
    await expect(
      judgeBundle(
        { revisions: store, content, evidence, transport: new ScriptedTransport(), calibration: CALIBRATION },
        "run-1", "2026-09-03T00:02:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "missing-content-ref" });
    expect(evidence.written).toHaveLength(0);
  });

  it("refuses when a content ref does not resolve", async () => {
    const revisions = baseRevisions({
      output_ref: "npx:stage-output:" + "9".repeat(64) + ":local-bundle",
    });
    const store = new FakeRevisionStore(revisions);
    const content = new FakeContentStore(CONTENT); // does not contain the "9..." ref
    const evidence = new FakeEvidenceStore();
    await expect(
      judgeBundle(
        { revisions: store, content, evidence, transport: new ScriptedTransport(), calibration: CALIBRATION },
        "run-1", "2026-09-03T00:02:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "content-not-found" });
    expect(evidence.written).toHaveLength(0);
  });
});
