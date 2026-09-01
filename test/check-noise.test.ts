import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNoise } from "../scripts/check-noise.js";

/**
 * The gate: a written model comparison may not claim a difference the instrument cannot see.
 *
 * Every case runs offline against a planted tree. The gate itself never runs a model — both
 * the floor and the prose it guards are committed files — which is what makes it honest in
 * CI, where it will report "not armed" forever.
 */

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

/** 12 cases at discordance 0.238 resolve about 39.5 pp. */
const FLOOR = {
  measured_on: "2026-09-01",
  suite: { id: "compile-smoke", version: "2.0.0", cases_scored: 12 },
  transport: "local",
  trials_per_model: 3,
  models: {},
  pairs: {},
  cases: {},
  discordance_rate: 0.238,
};

function plant(claims: unknown[], floor: unknown = FLOOR, doc = "The gap was 45 pp better here.") {
  const root = mkdtempSync(join(tmpdir(), "cn-"));
  temps.push(root);
  mkdirSync(join(root, "eval"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "Documentation"), { recursive: true });
  if (floor !== null) writeFileSync(join(root, "eval/noise-floor.json"), JSON.stringify(floor));
  writeFileSync(join(root, "scripts/noise-claims.json"), JSON.stringify({ claims }));
  writeFileSync(join(root, "Documentation/PROVIDERS.md"), doc);
  return root;
}

const bound = {
  kind: "bound", document: "Documentation/PROVIDERS.md",
  pattern: "([\\d.]+) pp better", reason: "r",
};
const forbidden = {
  kind: "forbidden", document: "Documentation/PROVIDERS.md",
  pattern: "outperforms", reason: "r",
};

describe("check-noise — not armed", () => {
  it("passes and says so when no measurement exists", () => {
    // CI's permanent state. A guard with zero coverage that prints OK is worse than no guard,
    // so it reports coverage honestly instead — the shape check:fingerprint established.
    const r = checkNoise(plant([bound], null));
    expect(r.ok).toBe(true);
    expect(r.armed).toBe(false);
  });

  it("still parses the claims when not armed, so a malformed pin fails early", () => {
    const r = checkNoise(plant([{ document: "d", pattern: "p", reason: "r" }], null));
    expect(r.fatalCode).toBe(2);
  });

  it("treats a malformed artifact as fatal, never as not armed", () => {
    // Absent and broken are different states and must not collapse.
    const root = plant([bound]);
    writeFileSync(join(root, "eval/noise-floor.json"), "{not json");
    expect(checkNoise(root).fatalCode).toBe(2);
  });
});

describe("check-noise — bound claims", () => {
  it("passes a claim larger than the floor can resolve", () => {
    const r = checkNoise(plant([bound], FLOOR, "The gap was 45 pp better here."));
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.armed).toBe(true);
  });

  it("fails a claim inside the noise, naming both numbers", () => {
    const r = checkNoise(plant([bound], FLOOR, "The gap was 6 pp better here."));
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.kind).toBe("below-floor");
    const detail = JSON.stringify(r.failures[0]);
    expect(detail).toContain("6");
    expect(detail).toContain("39.5");
  });

  it("fails a bound pattern that matches nothing — a pin cannot outlive its prose", () => {
    const r = checkNoise(plant([bound], FLOOR, "No numbers here at all."));
    expect(r.failures[0]!.kind).toBe("stale");
  });

  it("requires EVERY match to clear the floor, not just the first", () => {
    // One document can state the same comparison twice and be wrong about only the second.
    const r = checkNoise(plant([bound], FLOOR, "45 pp better, and also 3 pp better."));
    expect(r.ok).toBe(false);
  });

  it("reports an unreadable document rather than skipping it", () => {
    const r = checkNoise(plant([{ ...bound, document: "Documentation/GONE.md" }]));
    expect(r.failures[0]!.kind).toBe("unreadable");
  });
});

describe("check-noise — forbidden claims", () => {
  it("fails when the forbidden phrasing is present", () => {
    const r = checkNoise(plant([forbidden], FLOOR, "phi4-mini outperforms gpt-oss."));
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.kind).toBe("forbidden");
  });

  it("PASSES when it matches nothing — absence is success, not staleness", () => {
    // The half that inverts. A forbidden entry guards against prose that should never appear,
    // so no match is the satisfied state; treating it as stale would make the rule unusable.
    const r = checkNoise(plant([forbidden], FLOOR, "Nothing controversial here."));
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });
});

describe("check-noise — input validation", () => {
  it("is fatal on an entry with no kind, rather than guessing a direction", () => {
    // One rule cannot mean both "must match" and "must not match".
    const r = checkNoise(plant([{ document: "Documentation/PROVIDERS.md", pattern: "x", reason: "r" }]));
    expect(r.fatalCode).toBe(2);
  });

  it("is fatal on an unreadable claims file", () => {
    const root = plant([bound]);
    writeFileSync(join(root, "scripts/noise-claims.json"), "{oops");
    expect(checkNoise(root).fatalCode).toBe(2);
  });
});
