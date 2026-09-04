import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * tsx by absolute path, run through this process's own node — not `npx tsx`. See
 * shells/cli/test/pipeline-command.test.ts: `npx` on Windows resolves to `npx.cmd`, which
 * execFileSync cannot exec without `shell: true`, so a plain `execFileSync("npx", …)` here
 * fails with ENOENT before the script under test ever runs, surfacing as a generic exit 1
 * regardless of what check-judge.ts actually returns.
 */
const TSX = join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const CHECK_JUDGE = join(process.cwd(), "scripts/check-judge.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-judge-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], cwd: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [TSX, CHECK_JUDGE, ...args], {
      cwd, encoding: "utf8",
    });
    return { code: 0, stdout };
  } catch (err: any) {
    return { code: err.status ?? 1, stdout: (err.stdout ?? "").toString() };
  }
}

const score = (s: number, r = "x") => ({ score: s, reason: r });
const CLEAN = {
  domain_captured: score(3), constraints_honored: score(3), completeness: score(3), no_overreach: score(3),
};
// Isolates cleanly: domain_captured drops by 2, everything else holds.
const MUTATED_DOMAIN = {
  domain_captured: score(1), constraints_honored: score(3), completeness: score(3), no_overreach: score(3),
};
const MUTATED_CONSTRAINTS = {
  domain_captured: score(3), constraints_honored: score(1), completeness: score(3), no_overreach: score(3),
};

function calibrationArtifact(overrides: Record<string, unknown> = {}) {
  return {
    measured_on: "2026-09-03", reference: "mutation-derived-v1",
    fixtures_total: 1, mutations_kept: 1, mutations_total: 4,
    labelled_dimension_instances: 8, cohens_kappa: 1, threshold: 0.6, max_age_days: 30,
    kept_mutations: ["f1/domain_captured"],
    raw_scores: [
      { fixture: "f1", clean: CLEAN, mutations: { domain_captured: MUTATED_DOMAIN } },
    ],
    ...overrides,
  };
}

describe("check:judge", () => {
  it("reports not armed and exits 0 when the calibration artifact is absent", () => {
    const { code, stdout } = run(["--calibration", join(dir, "missing.json")], dir);
    expect(code).toBe(0);
    expect(stdout).toContain("not armed");
  });

  it("exits 2 on a malformed calibration artifact", () => {
    writeFileSync(join(dir, "calibration.json"), "{not valid json");
    const { code } = run(["--calibration", join(dir, "calibration.json")], dir);
    expect(code).toBe(2);
  });

  it("passes when the recomputed kept-mutation set and kappa match the artifact's claims", () => {
    writeFileSync(join(dir, "calibration.json"), JSON.stringify(calibrationArtifact()));
    const { code, stdout } = run(["--calibration", join(dir, "calibration.json")], dir);
    expect(code).toBe(0);
    expect(stdout).toContain("OK");
  });

  it("fails when a claimed kept_mutation does not actually isolate — the mutation-proof case", () => {
    // domain_captured only drops by 1 here, which isolatesCleanly requires to be >= 2.
    const notIsolating = { ...MUTATED_DOMAIN, domain_captured: score(2) };
    writeFileSync(join(dir, "calibration.json"), JSON.stringify(calibrationArtifact({
      raw_scores: [{ fixture: "f1", clean: CLEAN, mutations: { domain_captured: notIsolating } }],
    })));
    const { code, stdout } = run(["--calibration", join(dir, "calibration.json")], dir);
    expect(code).toBe(1);
    expect(stdout + "").not.toContain("OK");
  });

  it("fails when the claimed kappa does not match what raw_scores recomputes to", () => {
    writeFileSync(join(dir, "calibration.json"), JSON.stringify(calibrationArtifact({ cohens_kappa: 0.99 })));
    // raw_scores here recompute to kappa=1 (perfect agreement on this single isolating case),
    // so a claimed 0.99 must be rejected as a mismatch, not silently accepted as "close enough".
    const { code } = run(["--calibration", join(dir, "calibration.json")], dir);
    expect(code).toBe(1);
  });

  it("fails when the recomputed kappa is below the declared threshold", () => {
    writeFileSync(join(dir, "calibration.json"), JSON.stringify(calibrationArtifact({ threshold: 1.5 })));
    const { code } = run(["--calibration", join(dir, "calibration.json")], dir);
    expect(code).toBe(1);
  });

  /**
   * Valid JSON, wrong shape — the class of artifact that failed OPEN through scripts/judge.ts's
   * three calibration guards before `validateCalibrationArtifact` existed. CI must refuse
   * exactly what the judge refuses, which is why both call the one shared validator.
   */
  it.each([
    ["a missing cohens_kappa", { cohens_kappa: undefined }],
    ["a string cohens_kappa", { cohens_kappa: "0.82" }],
    ["a missing threshold", { threshold: undefined }],
    ["a missing max_age_days", { max_age_days: undefined }],
    ["a missing reference", { reference: undefined }],
    ["a measured_on that is not a calendar date", { measured_on: "3 September 2026" }],
    ["a missing labelled_dimension_instances", { labelled_dimension_instances: undefined }],
  ])("exits 2 on %s", (_label, override) => {
    // JSON.stringify drops undefined values, which is how a field goes missing in practice.
    writeFileSync(join(dir, "calibration.json"), JSON.stringify(calibrationArtifact(override)));
    const { code } = run(["--calibration", join(dir, "calibration.json")], dir);
    expect(code).toBe(2);
  });

  it("exits 2 on a raw_scores breakdown holding a score outside the rubric's 0-3 scale", () => {
    // 95 — a percentage, the likeliest way for a judge to misread the scale. It satisfies every
    // comparison isolatesCleanly and the binarizer make while meaning nothing.
    writeFileSync(join(dir, "calibration.json"), JSON.stringify(calibrationArtifact({
      raw_scores: [{
        fixture: "f1", clean: { ...CLEAN, domain_captured: score(95) },
        mutations: { domain_captured: MUTATED_DOMAIN },
      }],
    })));
    const { code, stdout } = run(["--calibration", join(dir, "calibration.json")], dir);
    expect(code).toBe(2);
    expect(stdout).not.toContain("OK");
  });

  /**
   * The check that had to be re-keyed. `aggregatePairs` emits a fixture's clean rows whether or
   * not anything isolated, so `pairs.length === 0` is no longer reachable for a non-empty
   * artifact — and with nothing kept, every label is "not degraded", a constant rater that
   * cohensKappa reports as 1.0. Without this being keyed on the KEPT set, a measurement that
   * discriminated nothing would print a perfect score.
   */
  it("exits 2 when nothing isolates at all, rather than reporting a constant-rater kappa of 1", () => {
    const notIsolating = { ...MUTATED_DOMAIN, domain_captured: score(2) };
    writeFileSync(join(dir, "calibration.json"), JSON.stringify(calibrationArtifact({
      kept_mutations: [],
      labelled_dimension_instances: 4,
      raw_scores: [{ fixture: "f1", clean: CLEAN, mutations: { domain_captured: notIsolating } }],
    })));
    const { code, stdout } = run(["--calibration", join(dir, "calibration.json")], dir);
    expect(code).toBe(2);
    expect(stdout).not.toContain("OK");
  });

  /**
   * Important 6, as CI sees it: the artifact claims the count the OLD per-mutation aggregation
   * produced (2 mutations x 8), and the recomputation says 1 fixture x 4 clean + 2 kept x 4 = 12.
   */
  it("fails when labelled_dimension_instances carries the inflated per-mutation count", () => {
    const twoIsolating = {
      kept_mutations: ["f1/domain_captured", "f1/constraints_honored"],
      raw_scores: [{
        fixture: "f1", clean: CLEAN,
        mutations: { domain_captured: MUTATED_DOMAIN, constraints_honored: MUTATED_CONSTRAINTS },
      }],
    };
    writeFileSync(join(dir, "calibration.json"), JSON.stringify(calibrationArtifact({
      ...twoIsolating, labelled_dimension_instances: 16, cohens_kappa: 1,
    })));
    expect(run(["--calibration", join(dir, "calibration.json")], dir).code).toBe(1);

    // …and passes at the corrected count, so this is a test of the number and not of the shape.
    writeFileSync(join(dir, "calibration.json"), JSON.stringify(calibrationArtifact({
      ...twoIsolating, labelled_dimension_instances: 12, cohens_kappa: 1,
    })));
    const { code, stdout } = run(["--calibration", join(dir, "calibration.json")], dir);
    expect(code).toBe(0);
    expect(stdout).toContain("OK");
  });
});
