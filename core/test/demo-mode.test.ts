import { describe, it, expect } from "vitest";
import type { ProviderFailure, GenerationResult, FailureCategory } from "../../contracts/index.js";
import { STAGE_IDS, FAILURE_CATEGORIES } from "../../contracts/index.js";
import { PIPELINE } from "../src/stages/pipeline.js";
import { DEMO_MARKER, UNUSABLE_MARKER, isPlaceholderArtifact } from "../src/stages/stage-kit.js";

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
 * The guard is `shouldSkip: (c) => isPlaceholderArtifact(c.prompt)`: a transforming stage handed a
 * placeholder skips rather than rewriting it. A chain that calls `reduce` without consulting
 * `shouldSkip` bypasses the entire mechanism and reports laundering everywhere — which is what
 * the first version of this sweep did, and why the chain below drives the pipeline the way the
 * runner does.
 */

/**
 * Every category the contract declares, asked of the contract.
 *
 * This was a hand-written list of eight. When `MALFORMED_RESPONSE` landed it would have gone
 * on reporting exhaustive coverage of a set it no longer covered — in a sweep whose header
 * claims "every generating stage against every failure category". Deriving it is the whole
 * difference between that sentence being true and being a slogan.
 */
const CATEGORIES: readonly FailureCategory[] = FAILURE_CATEGORIES;

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
    /**
     * A floor and a shape, not a list.
     *
     * This used to assert `CATEGORIES.length === 8` beside a sorted literal of all eight,
     * under a comment reading "a new one must be added here too" — which is a hand-written
     * list guarding a hand-written list. `MALFORMED_RESPONSE` had to be added in three places
     * to land, and the third was this assertion.
     *
     * The set now comes from the contract, so what is worth checking here is that the matrix
     * is real and cannot silently shrink. That TypeScript and the schema agree on the set is
     * asserted where both are visible, in `test/contract-conformance.test.ts`.
     */
    expect(generating.length).toBeGreaterThan(0);
    expect(CATEGORIES.length).toBeGreaterThanOrEqual(9);
    expect(pairs.length).toBe(generating.length * CATEGORIES.length);
  });

  it.each(pairs)("%s × %s", (id, _category, stage) => {
    const state = stage.reduce(ctx, failure(_category) as ProviderFailure);
    const artifact = textsOf(state);

    /**
     * D1 MARKED — the artifact says so, not merely the run record.
     *
     * WHICH marker is part of the assertion, not incidental. `MALFORMED_RESPONSE` means a
     * model answered and the answer was unusable, so it gets `UNUSABLE_MARKER`; every other
     * category means nothing came back, and gets `DEMO_MARKER`. Asserting only "some marker
     * is present" would let the two swap without any test noticing, which is the entire
     * failure ADR-0014 exists to prevent.
     */
    const expected = _category === "MALFORMED_RESPONSE" ? UNUSABLE_MARKER : DEMO_MARKER;
    const wrong = _category === "MALFORMED_RESPONSE" ? DEMO_MARKER : UNUSABLE_MARKER;
    expect({ id, marked: artifact.includes(expected) }).toEqual({ id, marked: true });
    expect({ id, wrongMarker: artifact.includes(wrong) }).toEqual({ id, wrongMarker: false });

    /**
     * D1b — the demo placeholder's central sentence must not appear on a run that reached a
     * model. "No output was produced" is a factual claim, and it is false there.
     */
    if (_category === "MALFORMED_RESPONSE") {
      expect({ id, lies: artifact.includes("No output was produced") })
        .toEqual({ id, lies: false });
    }

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
      // Both markers, because a stage that always emitted the UNUSABLE one would otherwise
      // pass a check that only looks for the demo one.
      const state = stage.reduce(ctx, success);
      const artifact = textsOf(state);
      expect({ id, marked: isPlaceholderArtifact(artifact) }).toEqual({ id, marked: false });
      if ("demo_mode" in (state as Record<string, unknown>)) {
        expect({ id, flag: (state as { demo_mode: unknown }).demo_mode }).toEqual({ id, flag: false });
      }
    },
  );
});

describe("demo mode — the artifact cannot be laundered clean downstream", () => {
  /** Drives the pipeline the way the runner does: `shouldSkip` first, then `reduce`. */
  const runChain = (degradedId: string, category: FailureCategory) => {
    let c = { ...(ctx as object) } as Record<string, unknown>;
    const skipped: string[] = [];
    for (const stage of PIPELINE) {
      if (stage.kind !== "generating") continue;
      if (typeof stage.shouldSkip === "function" && stage.shouldSkip(c as never)) {
        skipped.push(stage.id);
        continue;
      }
      const outcome = stage.id === degradedId ? (failure(category) as ProviderFailure) : success;
      c = { ...c, ...(stage.reduce(c as never, outcome) as object) };
    }
    return { ctx: c, skipped };
  };

  /** The stages that write `prompt`. Only these can leave a laundered artifact behind. */
  const promptWriters = ["compile", "harden", "refine"];

  /**
   * Both markers, because the guard is a predicate over a LIST and a list can lose an entry.
   *
   * This suite hard-coded `failure("UNAVAILABLE")`, so it drove one branch of
   * `isPlaceholderArtifact` and never the other. Measured: narrowing the predicate back to
   * `text.includes(DEMO_MARKER)` — reopening the exact laundering hole ADR-0014 warns about,
   * on the path that now reaches a real model — left all 721 Core tests passing.
   *
   * A guard nothing exercises is indistinguishable from one that does not work.
   */
  const DEGRADATIONS: ReadonlyArray<readonly [FailureCategory, string]> = [
    ["UNAVAILABLE", "no model answered"],
    ["MALFORMED_RESPONSE", "a model answered unusably"],
  ];

  const writerCases = DEGRADATIONS.flatMap(([cat, label]) =>
    generating.filter((s) => promptWriters.includes(s.id)).map((s) => [s.id, cat, label] as const),
  );
  const nonWriterCases = DEGRADATIONS.flatMap(([cat, label]) =>
    generating.filter((s) => !promptWriters.includes(s.id)).map((s) => [s.id, cat, label] as const),
  );

  it.each(writerCases)(
    "a chain whose %s degrades (%s — %s) keeps the marker on the prompt",
    (id, category) => {
      const { ctx: out, skipped } = runChain(id, category);
      expect({ id, marked: isPlaceholderArtifact(out.prompt as string) }).toEqual({ id, marked: true });
      // And the guard is what kept it: at least one downstream stage declined to run.
      expect({ id, skippedAny: skipped.length > 0 }).toEqual({ id, skippedAny: true });
    },
  );

  it.each(nonWriterCases)(
    "a chain whose %s degrades (%s — %s) leaves a REAL prompt, and does not falsely mark it",
    (id, category) => {
      // The other direction, and it matters: a critic or a cost estimate degrading says
      // nothing about the prompt, which was produced against a model. Marking it would be a
      // different lie — one that makes a real artifact look fabricated.
      const { ctx: out } = runChain(id, category);
      expect({ id, marked: isPlaceholderArtifact(out.prompt as string) }).toEqual({ id, marked: false });
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
    expect(isPlaceholderArtifact(marked)).toBe(true);
    expect(isPlaceholderArtifact(laundered)).toBe(false);
  });

  it("every declared stage id appears in the pipeline", () => {
    // A stage added to the contract but never registered would silently escape this file.
    expect(PIPELINE.map((s) => s.id).sort()).toEqual([...STAGE_IDS].sort());
  });
});
