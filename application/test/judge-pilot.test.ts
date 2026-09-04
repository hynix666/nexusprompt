import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJudgePilot, type JudgePilotBrief } from "../src/judge-pilot.js";
import { LocalRevisionStore } from "../../adapters/storage-local/src/index.js";
import { LocalContentStore } from "../../adapters/content-local/src/index.js";
import { LocalEvidenceStore } from "../../adapters/evidence-local/src/index.js";
import type {
  GenerationRequest, GenerationResult, ProviderFailure, ProviderTransport,
  JudgeTransport, JudgeRequest, JudgeVerdict,
} from "../../contracts/index.js";

/** Produces a distinctive, per-provider compiled prompt so candidate and baseline can differ. */
class ScriptedProvider implements ProviderTransport {
  constructor(private readonly compiledPrompt: string, readonly provider_id = "scripted") {}
  async generate(req: GenerationRequest): Promise<GenerationResult> {
    const text = req.messages[0].content;
    const content = text.includes("STEP 2 — SCAFFOLDING") || text.includes("GUARDRAILING")
      ? this.compiledPrompt
      : "ok";
    return {
      request_id: req.request_id, content,
      provider_id: this.provider_id, model_id: this.provider_id, finish_reason: "end_turn",
    };
  }
  async healthCheck() {
    return { ok: true, checked_at: "1970-01-01T00:00:00.000Z", latency_ms: 0,
             degradation_state: "NONE" as const, failing_dependency: null };
  }
}

/** Fails every call, to exercise the demo-mode drop path. */
class DeadProvider implements ProviderTransport {
  readonly provider_id = "dead";
  async generate(req: GenerationRequest): Promise<ProviderFailure> {
    return {
      request_id: req.request_id, category: "UNAVAILABLE", retriable: false,
      reason_code: "no_api_key", safe_message: "No key.", retry_after_ms: null,
      attempt: 1, provider_id: this.provider_id,
    };
  }
  async healthCheck() {
    return { ok: false, checked_at: "1970-01-01T00:00:00.000Z", latency_ms: 0,
             degradation_state: "UNAVAILABLE" as const, failing_dependency: "provider" };
  }
}

/** Scores by looking for a marker planted in the compiled prompt — never a network. */
class MarkerJudge implements JudgeTransport {
  readonly judge_id = "marker-judge";
  readonly judge_family = "reviewer";
  async grade(req: JudgeRequest): Promise<JudgeVerdict> {
    const high = req.candidate.includes("HIGH_FIDELITY_MARKER");
    const dims = high
      ? { domain_captured: 3, constraints_honored: 3, completeness: 3, no_overreach: 3 }
      : { domain_captured: 1, constraints_honored: 1, completeness: 1, no_overreach: 1 };
    const rubric_breakdown = Object.fromEntries(
      Object.entries(dims).map(([k, v]) => [k, { score: v, reason: "scripted" }]),
    );
    return {
      verdict: Object.values(dims).reduce((a, b) => a + b, 0), rationale: null,
      judge_id: this.judge_id, judge_family: this.judge_family,
      rubric_id: req.rubric_id, rubric_hash: req.rubric_hash,
      runs: req.runs, disagreement_rate: 0, position_randomized: req.position_randomized,
      rubric_breakdown,
    };
  }
}

const CALIBRATION = {
  metric: "cohens-kappa" as const, value: 0.82, threshold: 0.6,
  measured_at: "2026-09-04T00:01:00.000Z", reference: "mutation-derived-v1", max_age_days: 30,
};

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

function makeDeps(candidateProvider: ProviderTransport, baselineProvider: ProviderTransport) {
  const root = mkdtempSync(join(tmpdir(), "judge-pilot-"));
  temps.push(root);
  let tick = 0;
  return {
    candidateProvider, baselineProvider,
    revisions: new LocalRevisionStore(join(root, "runs")),
    content: new LocalContentStore(join(root, "content")),
    evidence: new LocalEvidenceStore(join(root, "evidence")),
    transport: new MarkerJudge(),
    calibration: CALIBRATION,
    now: () => new Date(1_760_000_000_000 + tick++ * 10),
    coreBuildHash: "test",
  };
}

const briefs = (n: number): JudgePilotBrief[] =>
  Array.from({ length: n }, (_, i) => ({
    case_id: `brief-${i}`,
    brief: `A support assistant for team ${i}. It answers questions about invoices.`,
  }));

describe("runJudgePilot", () => {
  it("pairs candidate and baseline scores and reports an improved verdict", async () => {
    const deps = makeDeps(
      new ScriptedProvider("# SYSTEM PROMPT\n\nHIGH_FIDELITY_MARKER present."),
      new ScriptedProvider("# SYSTEM PROMPT\n\nno marker here."),
    );
    const result = await runJudgePilot(deps, briefs(25));

    expect(result.nominal_n).toBe(25);
    expect(result.survived_n).toBe(25);
    expect(result.dropped).toHaveLength(0);
    expect(result.comparison.verdict).toBe("improved");
    expect(result.comparison.delta).toBeCloseTo(8, 10); // 12 - 4, every case
  }, 30_000);

  it("drops a brief whose baseline run degrades, rather than imputing or crashing", async () => {
    const deps = makeDeps(
      new ScriptedProvider("# SYSTEM PROMPT\n\nHIGH_FIDELITY_MARKER present."),
      new DeadProvider(),
    );
    const result = await runJudgePilot(deps, briefs(25));

    expect(result.nominal_n).toBe(25);
    expect(result.survived_n).toBe(0);
    expect(result.dropped).toHaveLength(25);
    expect(result.dropped[0].reason).toMatch(/demo-mode-run/);
    expect(result.comparison.verdict).toBe("refused"); // 0 survived < MIN_BOOTSTRAP_N
  }, 30_000);

  it("survives more briefs than LocalRevisionStore's eight-bundle cap by judging each run immediately", async () => {
    // The whole reason run-then-judge must happen per brief rather than in two batch phases:
    // LocalRevisionStore evicts down to 8 complete bundles, and this pilot's real run judges
    // 100. With 12 briefs through one store here, a batch-all-runs-then-batch-all-judge
    // ordering would have evicted the first four bundles before they were ever judged. This
    // asserts the actual behaviour survives that cap, not merely that the code compiles.
    const deps = makeDeps(
      new ScriptedProvider("# SYSTEM PROMPT\n\nHIGH_FIDELITY_MARKER present."),
      new ScriptedProvider("# SYSTEM PROMPT\n\nno marker here."),
    );
    const result = await runJudgePilot(deps, briefs(12));

    expect(result.survived_n).toBe(12);
    expect(result.dropped).toHaveLength(0);
  }, 30_000);

  it("refuses via compareGraded, not a thrown error, when nothing survives", async () => {
    const deps = makeDeps(new DeadProvider(), new DeadProvider());
    const result = await runJudgePilot(deps, briefs(5));
    expect(result.comparison.verdict).toBe("refused");
    expect(result.survived_n).toBe(0);
  }, 30_000);
});
