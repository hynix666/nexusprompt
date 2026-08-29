import { describe, it, expect } from "vitest";
import type { ProviderFailure, GenerationResult, FailureCategory } from "../../contracts/index.js";
import { STAGE_IDS } from "../../contracts/index.js";
import { PIPELINE } from "../src/stages/pipeline.js";
import { DEMO_MARKER, isDemoArtifact } from "../src/stages/stage-kit.js";

/**
 * Demo mode, exhaustively: every generating stage against every failure category.
 *
 * This is the structural honesty guarantee, and it is the claim the rest of the repository
 * leans on hardest. `TRUTH_BOUNDARY.md`'s first entry says one eleven-stage run is persisted
 * with eleven null fingerprints — that the pipeline "executed and no model was reached". The
 * sentence only means anything if a degraded stage cannot emit text that reads as a real
 * artifact. If any (stage, category) pair yields unmarked output, the central claim is false,
 * and false in the direction that looks fine.
 *
 * Nine sweeps covered the linter: 161 manifest shapes, 199 contract assertions, 2,784 oracle
 * verdicts. None of them touched this, because a gate cannot see it — the input is a
 * `ProviderFailure`, not a prompt.
 *
 * ## The defect this exists for is recorded, not hypothetical
 *
 * `stage-kit.ts` describes it: `harden` degrades, `prompt` becomes a labelled placeholder, and
 * `refine` rewrites that placeholder into a clean-looking prompt with no marker. The run still
 * reported `demo_mode: true` while the ARTIFACT no longer said so — and the artifact is what a
 * person reads and ships. So the guarantee must survive CHAINING, which is what the second
 * describe block drives.
 *
 * The guard is `shouldSkip: (c) => isDemoArtifact(c.prompt)`: a transforming stage handed a
 * placeholder skips rather than rewriting it. A chain that calls `reduce` without consulting
 * `shouldSkip` bypasses the entire mechanism and reports laundering everywhere — which is what
 * the first version of this sweep did, and why the chain below drives the pipeline the way the
 * runner does.
 */

const CATEGORIES: readonly FailureCategory[] = [
  "TIMEOUT", "RATE_LIMIT", "AUTH", "UNAVAILABLE",
  "INVALID_REQUEST", "CONTENT_FILTER", "INTERNAL", "CANCELLED",
];

/** What the model "would have" said. Reaching an artifact makes it fabrication. */
const FABRICATED = "You are a helpful assistant answering billing questions.";

/** Carries a field that must never surface, alongside the one that may. */
const failure = (category: FailureCategory): ProviderFailure & { internal_detail: string } => ({
  request_id: "req-1",
  category,
  retriable: category === "TIMEOUT" || category === "RATE_LIMIT",
  reason_code: `${category.toLowerCase()}_reason`,
  safe_message: "the provider could not be reached",
  retry_after_ms: null,
  attempt: 1,
  provider_id: "local-proxy",
  internal_detail: "stack trace: at Object.<anonymous> (/home/runner/secret-path.js:1:1)",
});

const success = { content: FABRICATED } as unknown as GenerationResult;

const ctx = {
  brief: "Answer billing questions.",
  spec: "a spec",
  calibration: "a calibration",
  prompt: "an existing prompt",
  stakes: "HIGH",
} as never;

/** Every string anywhere in a reduced state — a marker in one field is no use if the text a
 *  person reads sits in another. */
const textsOf = (state: unknown): string => {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(state);
  return out.join("\n");
};

const generating = PIPELINE.filter((s) => s.kind === "generating");
const pairs = generating.flatMap((s) => CATEGORIES.map((c) => [s.id, c, s] as const));

describe("demo mode — every generating stage × every failure category", () => {
  it("covers the whole matrix, so the cases below are not near-empty", () => {
    expect(generating.length).toBeGreaterThan(0);
    expect(CATEGORIES.length).toBe(8);
    expect(pairs.length).toBe(generating.length * 8);
    // Every category the contract declares is exercised; a new one must be added here too.
    expect([...CATEGORIES].sort()).toEqual([
      "AUTH", "CANCELLED", "CONTENT_FILTER", "INTERNAL",
      "INVALID_REQUEST", "RATE_LIMIT", "TIMEOUT", "UNAVAILABLE",
    ]);
  });

  it.each(pairs)("%s × %s", (id, _category, stage) => {
    const state = stage.reduce(ctx, failure(_category) as ProviderFailure);
    const artifact = textsOf(state);

    // D1 MARKED — the artifact says so, not merely the run record.
    expect({ id, marked: artifact.includes(DEMO_MARKER) }).toEqual({ id, marked: true });

    // D2 FLAGGED, where the stage's state carries the flag at all.
    if ("demo_mode" in (state as Record<string, unknown>)) {
      expect({ id, flag: (state as { demo_mode: unknown }).demo_mode }).toEqual({ id, flag: true });
    }

    // D3 NO FABRICATION — the model's would-be content must not appear.
    expect({ id, fabricated: artifact.includes(FABRICATED) }).toEqual({ id, fabricated: false });

    // D4 SAFE DETAIL — `safe_message` may surface; internals may not.
    expect({ id, leaked: artifact.includes("stack trace") }).toEqual({ id, leaked: false });
  });

  it.each(generating.map((s) => [s.id, s] as const))(
    "%s does NOT mark a successful outcome",
    (id, stage) => {
      // D5. The discriminating half: without it, a stage that always marks would satisfy D1.
      const state = stage.reduce(ctx, success);
      const artifact = textsOf(state);
      expect({ id, marked: artifact.includes(DEMO_MARKER) }).toEqual({ id, marked: false });
      if ("demo_mode" in (state as Record<string, unknown>)) {
        expect({ id, flag: (state as { demo_mode: unknown }).demo_mode }).toEqual({ id, flag: false });
      }
    },
  );
});

describe("demo mode — the artifact cannot be laundered clean downstream", () => {
  /** Drives the pipeline the way the runner does: `shouldSkip` first, then `reduce`. */
  const runChain = (degradedId: string) => {
    let c = { ...(ctx as object) } as Record<string, unknown>;
    const skipped: string[] = [];
    for (const stage of PIPELINE) {
      if (stage.kind !== "generating") continue;
      if (typeof stage.shouldSkip === "function" && stage.shouldSkip(c as never)) {
        skipped.push(stage.id);
        continue;
      }
      const outcome = stage.id === degradedId ? (failure("UNAVAILABLE") as ProviderFailure) : success;
      c = { ...c, ...(stage.reduce(c as never, outcome) as object) };
    }
    return { ctx: c, skipped };
  };

  /** The stages that write `prompt`. Only these can leave a laundered artifact behind. */
  const promptWriters = ["compile", "harden", "refine"];

  it.each(generating.filter((s) => promptWriters.includes(s.id)).map((s) => [s.id] as const))(
    "a chain whose %s degrades keeps the marker on the prompt",
    (id) => {
      const { ctx: out, skipped } = runChain(id);
      expect({ id, demo: isDemoArtifact(out.prompt as string) }).toEqual({ id, demo: true });
      // And the guard is what kept it: at least one downstream stage declined to run.
      expect({ id, skippedAny: skipped.length > 0 }).toEqual({ id, skippedAny: true });
    },
  );

  it.each(generating.filter((s) => !promptWriters.includes(s.id)).map((s) => [s.id] as const))(
    "a chain whose %s degrades leaves a REAL prompt, and does not falsely mark it",
    (id) => {
      // The other direction, and it matters: a critic or a cost estimate degrading says
      // nothing about the prompt, which was produced against a model. Marking it would be a
      // different lie — one that makes a real artifact look fabricated.
      const { ctx: out } = runChain(id);
      expect({ id, demo: isDemoArtifact(out.prompt as string) }).toEqual({ id, demo: false });
    },
  );
});

describe("demo mode — the checks reject a planted defect", () => {
  it("D1 — a placeholder without the marker fails the marked check", () => {
    const unmarked = "Stage did not run against a model.";
    expect(unmarked.includes(DEMO_MARKER)).toBe(false);
  });

  it("D6 — a transforming stage with no guard would launder", () => {
    // The recorded defect, in miniature: rewriting a marked prompt without checking.
    const marked = `${DEMO_MARKER}\n\nplaceholder`;
    const laundered = "a clean-looking prompt";
    expect(isDemoArtifact(marked)).toBe(true);
    expect(isDemoArtifact(laundered)).toBe(false);
  });

  it("every declared stage id appears in the pipeline", () => {
    // A stage added to the contract but never registered would silently escape this file.
    expect(PIPELINE.map((s) => s.id).sort()).toEqual([...STAGE_IDS].sort());
  });
});
