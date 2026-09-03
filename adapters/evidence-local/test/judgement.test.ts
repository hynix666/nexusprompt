import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEvidenceStore } from "../src/index.js";
import type { Judgement } from "../../../contracts/index.js";

const makeJudgement = (id: string, run_id: string): Judgement => ({
  judgement_id: id,
  run_id,
  created_at: "2026-09-03T00:00:00.000Z",
  verdict: {
    verdict: 9, rationale: null,
    judge_id: "claude-opus-5", judge_family: "claude",
    rubric_id: "brief-fidelity-v1", rubric_hash: "abc",
    runs: 3, disagreement_rate: 0, position_randomized: true,
  },
});

describe("evidence-local accepts the judgement kind", () => {
  it("round-trips a judgement through put/get/list", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-judgement-"));
    try {
      const store = new LocalEvidenceStore(root);
      const j = makeJudgement("j-1", "run-1");
      await store.put({ kind: "judgement", id: j.judgement_id, created_at: j.created_at, body: j });

      const got = await store.get("judgement", "j-1");
      expect(got?.body).toEqual(j);

      const listed = await store.list("judgement");
      expect(listed).toHaveLength(1);
      expect(listed[0].id).toBe("j-1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets two judgements of the same run coexist as distinct records", async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-judgement-"));
    try {
      const store = new LocalEvidenceStore(root);
      const first = makeJudgement("j-1", "run-1");
      const second = makeJudgement("j-2", "run-1");
      await store.put({ kind: "judgement", id: first.judgement_id, created_at: first.created_at, body: first });
      await store.put({ kind: "judgement", id: second.judgement_id, created_at: second.created_at, body: second });

      const listed = await store.list("judgement");
      expect(listed).toHaveLength(2);
      expect(listed.map((r) => r.id).sort()).toEqual(["j-1", "j-2"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
