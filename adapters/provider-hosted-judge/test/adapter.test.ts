import { describe, it, expect, afterEach } from "vitest";
import { HostedJudgeTransport, HostedJudgeFailure, modalScore } from "../src/index.js";
import type { JudgeRequest } from "../../../contracts/index.js";

const req: JudgeRequest = {
  request_id: "req-1",
  rubric_id: "brief-fidelity-v1",
  rubric_hash: "abc123",
  candidate: "ORIGINAL BRIEF...\nCOMPILED PROMPT...",
  position_randomized: true,
  runs: 1,
};

const savedKey = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

const rubricJson = (overrides: Record<string, { score: number; reason: string }> = {}) =>
  JSON.stringify({
    domain_captured: { score: 3, reason: "domain matched" },
    constraints_honored: { score: 3, reason: "all honored" },
    completeness: { score: 3, reason: "complete" },
    no_overreach: { score: 3, reason: "nothing extra" },
    ...overrides,
  });

const responseWith = (text: string) =>
  async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text }], model: "claude-opus-5", stop_reason: "end_turn" }),
      { status: 200 },
    );

describe("modalScore", () => {
  it("picks the most common value", () => {
    expect(modalScore([3, 3, 2])).toBe(3);
  });

  it("breaks ties toward the lower, more conservative score", () => {
    expect(modalScore([3, 2])).toBe(2);
    expect(modalScore([1, 1, 3, 3])).toBe(1);
  });

  it("handles a single run", () => {
    expect(modalScore([2])).toBe(2);
  });
});

describe("HostedJudgeTransport.grade", () => {
  it("refuses without an API key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const t = new HostedJudgeTransport({ fetchImpl: async () => { throw new Error("must not be called"); } });
    await expect(t.grade(req)).rejects.toThrow(HostedJudgeFailure);
  });

  it("parses a well-formed rubric response into a JudgeVerdict with rubric_breakdown", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const t = new HostedJudgeTransport({ fetchImpl: responseWith(rubricJson()) });
    const verdict = await t.grade(req);
    expect(verdict.rubric_breakdown?.domain_captured.score).toBe(3);
    expect(verdict.verdict).toBe(12); // 3+3+3+3
    expect(verdict.runs).toBe(1);
    expect(verdict.disagreement_rate).toBe(0);
    expect(verdict.judge_family).not.toBe("");
  });

  it("makes req.runs independent calls and aggregates by mode", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    let call = 0;
    const responses = [
      rubricJson({ domain_captured: { score: 3, reason: "a" } }),
      rubricJson({ domain_captured: { score: 3, reason: "a" } }),
      rubricJson({ domain_captured: { score: 1, reason: "b" } }),
    ];
    const t = new HostedJudgeTransport({
      fetchImpl: async () => {
        const text = responses[call++];
        return new Response(
          JSON.stringify({ content: [{ type: "text", text }], model: "claude-opus-5", stop_reason: "end_turn" }),
          { status: 200 },
        );
      },
    });
    const verdict = await t.grade({ ...req, runs: 3 });
    expect(call).toBe(3);
    expect(verdict.runs).toBe(3);
    expect(verdict.rubric_breakdown?.domain_captured.score).toBe(3); // 2 of 3 agree
    expect(verdict.disagreement_rate).toBeCloseTo(1 / 3);
  });

  it("throws HostedJudgeFailure on a non-2xx response", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const t = new HostedJudgeTransport({
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 }),
    });
    await expect(t.grade(req)).rejects.toThrow(HostedJudgeFailure);
  });

  it("throws HostedJudgeFailure when the response is not the expected JSON shape", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const t = new HostedJudgeTransport({ fetchImpl: responseWith("not json at all") });
    await expect(t.grade(req)).rejects.toThrow(HostedJudgeFailure);
  });

  it("throws HostedJudgeFailure when a dimension is missing from the response", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const incomplete = JSON.stringify({
      domain_captured: { score: 3, reason: "ok" },
      constraints_honored: { score: 3, reason: "ok" },
      completeness: { score: 3, reason: "ok" },
      // no_overreach missing
    });
    const t = new HostedJudgeTransport({ fetchImpl: responseWith(incomplete) });
    await expect(t.grade(req)).rejects.toThrow(HostedJudgeFailure);
  });

  /**
   * The RANGE, not only the type. `verdict` is the four scores summed out of 12,
   * `isolatesCleanly` compares differences against 2 and 1, and the calibration binarizes at
   * <= 1 — a judge answering on a percentage scale satisfies `typeof === "number"` and then
   * reaches every one of those as a confident classification.
   */
  it.each([95, 4, -1, 2.5])("throws HostedJudgeFailure on an out-of-scale score (%s)", async (bad) => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const t = new HostedJudgeTransport({
      fetchImpl: responseWith(rubricJson({ completeness: { score: bad, reason: "ok" } })),
    });
    await expect(t.grade(req)).rejects.toThrow(HostedJudgeFailure);
  });

  it("accepts every score the rubric's 0-3 scale actually allows", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    for (const ok of [0, 1, 2, 3]) {
      const t = new HostedJudgeTransport({
        fetchImpl: responseWith(rubricJson({ completeness: { score: ok, reason: "ok" } })),
      });
      const verdict = await t.grade(req);
      expect(verdict.rubric_breakdown?.completeness.score).toBe(ok);
    }
  });

  it("never logs or echoes the API key on failure", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-SECRETVALUE0123456789";
    const t = new HostedJudgeTransport({
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    });
    try {
      await t.grade(req);
      throw new Error("expected grade() to throw");
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("SECRETVALUE");
    }
  });
});
