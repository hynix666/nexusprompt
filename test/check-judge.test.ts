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
});
