import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { runSuite, configurationId } from "../application/src/eval.js";
import { buildBriefPilotSuite } from "../scripts/build-brief-pilot.js";

/**
 * The brief-pilot suite, end to end.
 *
 * Two things to certify:
 *
 *   1. The committed file is what the generator produces. Same discipline as `check:anchor`:
 *      a generated corpus nobody can hand-edit without being caught.
 *
 *   2. Every case passes against its own stub. The generator enforces the construction
 *      invariant (stub must satisfy expectation, stub must trip no gate FAIL), so this test
 *      failing would mean the orchestrator and the generator disagree about what the
 *      detectors require — which is the exact confusion `partitionByTransport` was built to
 *      catch one level up, and what makes a test-only suite pointless.
 *
 * Neither test replaces Task 4 (the sweep). A 100/100 stub run proves the wiring. The
 * question "does a model compiled from brief-pilot.json outperform another" requires a
 * real provider and is what the measurement run answers.
 */

const SUITE_PATH = "eval/brief-pilot.json";
const COUNT = 100;

const configuration = (() => {
  const base = {
    prompt_template_ref: "core/src/stages/compile.ts",
    model_id: "pinned",
    decoding: { temperature: null, seed: null },
    topology: { kind: "sequential" as const, stages: ["compile"], max_iterations: null },
    retrieval_config: null,
    tool_config: null,
    gate_set_ref: "scripts/ported-gates.json",
    router_policy_ref: null,
  };
  return { configuration_id: configurationId(base), ...base };
})();

describe("brief-pilot suite", () => {
  it("eval/brief-pilot.json is what the generator produces", () => {
    const produced = JSON.stringify(buildBriefPilotSuite(), null, 2) + "\n";
    const committed = existsSync(SUITE_PATH)
      ? readFileSync(SUITE_PATH, "utf8").replace(/\r\n/g, "\n")
      : null;
    expect(committed?.trimEnd()).toBe(produced.trimEnd());
  });

  it("every case passes against its own stub", async () => {
    const suiteData = JSON.parse(readFileSync(SUITE_PATH, "utf8"));
    const { run, perCase } = await runSuite({
      suite: suiteData.suite,
      cases: suiteData.cases,
      configuration,
    });
    expect(perCase.filter((r) => !r.passed).map((r) => r.case_id)).toEqual([]);
    expect(run.aggregate.cases).toBe(COUNT);
  }, 60_000);
});
