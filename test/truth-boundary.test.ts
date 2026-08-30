import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkTruthBoundary,
  render,
  PROBES,
  type TruthSpec,
  type TruthEntry,
} from "../scripts/check-truth-boundary.js";

/**
 * Must-fire cases for the truth boundary.
 *
 * The document this checker generates is the one artifact in the repository whose whole
 * value is that it cannot flatter. So the cases that matter are not "does it pass on
 * master" — `npm run verify` answers that every run — but the four ways an entry could
 * look like a boundary while asserting nothing:
 *
 *   1. it names a probe that does not exist
 *   2. it pins an empty `expect`
 *   3. a probe derives a field the entry does not pin  (the boundary moved, unnoticed)
 *   4. a probe exists that no entry names             (a derivation into a void)
 *
 * Every one of those renders as confident prose under a heading. Three of them would have
 * shipped green without these tests.
 *
 * The probe cases below use an injected probe set rather than the real ones, because the
 * real probes read most of the repository and a fixture tree deep enough for them would be
 * a copy of it. `providerReach` is the exception and gets a real fixture: it is the boundary
 * that matters most, and a guard for "no model has ever answered" that has never been shown
 * to notice one answering is not a guard.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const temps: string[] = [];
const mkroot = () => {
  const dir = mkdtempSync(join(tmpdir(), "truth-boundary-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const entry = (over: Partial<TruthEntry> = {}): TruthEntry => ({
  id: "fixture",
  title: "A fixture boundary",
  establishes: "nothing in particular",
  does_not_establish: "anything at all",
  probe: "fixtureProbe",
  expect: { n: 1 },
  evidence: ["nowhere"],
  crossed_when: "never",
  ...over,
});

const specOf = (...entries: TruthEntry[]): TruthSpec => ({ version: "0.0.0", entries });

/** One field, pinned at 1. Overridden per case to move the boundary under the entry. */
const probes = (value: Record<string, unknown> = { n: 1 }) => ({ fixtureProbe: () => value });

const details = (r: ReturnType<typeof checkTruthBoundary>) =>
  r.failures.map((f) => `${f.entry}: ${f.detail}`).join("\n");

describe("check-truth-boundary — structural rules", () => {
  it("passes when the declared boundary is what the probe derives", () => {
    const r = checkTruthBoundary(repoRoot, { spec: specOf(entry()), probes: probes() });
    expect(details(r)).toBe("");
    expect(r.ok).toBe(true);
    expect(r.derived.fixture).toEqual({ n: 1 });
  });

  it("fails an entry naming a probe that does not exist", () => {
    const r = checkTruthBoundary(repoRoot, {
      spec: specOf(entry({ probe: "notAProbe" })),
      probes: probes(),
    });
    expect(r.ok).toBe(false);
    expect(details(r)).toMatch(/does not exist. The entry asserts nothing/);
  });

  it("fails an entry that pins nothing", () => {
    const r = checkTruthBoundary(repoRoot, {
      spec: specOf(entry({ expect: {} })),
      probes: probes(),
    });
    expect(r.ok).toBe(false);
    expect(details(r)).toMatch(/empty `expect`/);
  });

  it("fails when a pinned value no longer matches, and says which way it moved", () => {
    const r = checkTruthBoundary(repoRoot, {
      spec: specOf(entry()),
      probes: probes({ n: 2 }),
    });
    expect(r.ok).toBe(false);
    expect(details(r)).toMatch(/`n` — declared 1, derived 2/);
    // The failure carries the entry's own crossed_when line: the number moving is the
    // moment to re-read the claim, and the message has to say what that claim was.
    expect(details(r)).toMatch(/never/);
  });

  it("fails when a probe stops deriving a pinned field", () => {
    const r = checkTruthBoundary(repoRoot, {
      spec: specOf(entry()),
      probes: probes({ somethingElse: 1 }),
    });
    expect(r.ok).toBe(false);
    expect(details(r)).toMatch(/pins `n`, which probe "fixtureProbe" no longer derives/);
  });

  it("fails when a probe derives a field the entry does not pin", () => {
    // The direction an author never checks. Widening a probe without widening the pin
    // silently shrinks the boundary while every existing assertion stays green.
    const r = checkTruthBoundary(repoRoot, {
      spec: specOf(entry()),
      probes: probes({ n: 1, newlyDerived: 7 }),
    });
    expect(r.ok).toBe(false);
    expect(details(r)).toMatch(/derives `newlyDerived`, which the entry does not pin/);
  });

  it("fails when a probe exists that no entry names", () => {
    const r = checkTruthBoundary(repoRoot, {
      spec: specOf(entry()),
      probes: { ...probes(), orphan: () => ({ x: 1 }) },
    });
    expect(r.ok).toBe(false);
    expect(details(r)).toMatch(/\(probe\) orphan: .*named by no entry/);
  });

  it("fails on duplicate entry ids", () => {
    const r = checkTruthBoundary(repoRoot, {
      spec: specOf(entry(), entry()),
      probes: probes(),
    });
    expect(r.ok).toBe(false);
    expect(details(r)).toMatch(/duplicate entry id/);
  });

  it("treats an empty spec as fatal rather than as a modest claim", () => {
    const r = checkTruthBoundary(repoRoot, { spec: specOf(), probes: probes() });
    expect(r.fatalCode).toBe(2);
    expect(r.fatal).toMatch(/no claim/);
  });

  it("compares arrays by order and objects by key", () => {
    // Arm ordering is meaning; key ordering in a JSON object is not.
    const arr = checkTruthBoundary(repoRoot, {
      spec: specOf(entry({ expect: { ids: ["a", "b"] } })),
      probes: { fixtureProbe: () => ({ ids: ["b", "a"] }) },
    });
    expect(arr.ok).toBe(false);

    const obj = checkTruthBoundary(repoRoot, {
      spec: specOf(entry({ expect: { sizes: { a: 1, b: 2 } } })),
      probes: { fixtureProbe: () => ({ sizes: { b: 2, a: 1 } }) },
    });
    expect(details(obj)).toBe("");
    expect(obj.ok).toBe(true);
  });
});

describe("check-truth-boundary — the real spec", () => {
  it("holds against this repository", () => {
    const r = checkTruthBoundary(repoRoot);
    expect(details(r)).toBe("");
    expect(r.ok).toBe(true);
  });

  it("declares every implemented probe, and implements every declared one", () => {
    const r = checkTruthBoundary(repoRoot);
    const named = r.spec!.entries.map((e) => e.probe).sort();
    expect(named).toEqual(Object.keys(PROBES).sort());
  });

  it("states both halves of every scope", () => {
    // A boundary with only the flattering half is the failure this document is aimed at,
    // and prose is the one part no probe can check. Length is a crude proxy; it is
    // enough to catch an entry whose `does_not_establish` is a placeholder.
    for (const e of checkTruthBoundary(repoRoot).spec!.entries) {
      expect(e.establishes.length, `${e.id} establishes`).toBeGreaterThan(80);
      expect(e.does_not_establish.length, `${e.id} does_not_establish`).toBeGreaterThan(80);
      expect(e.crossed_when.length, `${e.id} crossed_when`).toBeGreaterThan(40);
      expect(e.evidence.length, `${e.id} evidence`).toBeGreaterThan(0);
    }
  });

  it("renders every entry into the document, with its pins", () => {
    const spec = checkTruthBoundary(repoRoot).spec!;
    const doc = render(spec);
    for (const e of spec.entries) {
      expect(doc).toContain(e.title);
      expect(doc).toContain(e.does_not_establish);
      for (const key of Object.keys(e.expect)) expect(doc).toContain(key);
    }
  });
});

describe("providerReach — the boundary that matters most", () => {
  /** The three files the probe reads. Nothing else in the tree touches it. */
  const plant = (bundle: unknown[] | null, watch: Record<string, unknown> = {}) => {
    const root = mkroot();
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/model-fingerprints.json"), JSON.stringify({ watch }));
    writeFileSync(join(root, ".gitignore"), "node_modules/\r\n.promptnexus/\r\nPDF/\r\n");
    if (bundle) {
      mkdirSync(join(root, ".promptnexus/runs"), { recursive: true });
      writeFileSync(join(root, ".promptnexus/runs/run.json"), JSON.stringify(bundle));
    }
    return root;
  };

  const degraded = (n: number) =>
    Array.from({ length: n }, () => ({
      provider_used: "local-proxy",
      execution_provenance: { provider_model_fingerprint: null },
    }));

  it("reports no observation on a clean checkout", () => {
    const r = PROBES.providerReach(plant(null));
    expect(r.any_fingerprint_observed).toBe(false);
    expect(r.fingerprints_pinned).toBe(0);
    expect(r.run_bundles_are_gitignored).toBe(true);
  });

  it("still reports no observation after a full degraded run", () => {
    // Eleven stages executed and no model answered. This is the state of the real tree,
    // and the distinction it turns on: a degraded run records UNAVAILABLE, which is not
    // evidence about which model is live and must never be counted as agreement.
    const r = PROBES.providerReach(plant(degraded(11)));
    expect(r.any_fingerprint_observed).toBe(false);
  });

  it("notices the first time a provider actually answers", () => {
    const bundle = [
      ...degraded(10),
      { provider_used: "local-proxy", execution_provenance: { provider_model_fingerprint: "abc123" } },
    ];
    const r = PROBES.providerReach(plant(bundle));
    expect(r.any_fingerprint_observed).toBe(true);
  });

  it("notices a fingerprint being pinned", () => {
    const r = PROBES.providerReach(plant(null, { "local-proxy abc123": { first_seen: "x" } }));
    expect(r.fingerprints_pinned).toBe(1);
  });

  /**
   * The guard standing between this repository and its first unbounded spend.
   *
   * This probe used to grep `run-eval.ts` for `/LIVE && MAX_CALLS === undefined/`, and these
   * tests planted a one-line file to move it. Both changed when the decision moved into
   * `core/src/eval/preflight.ts`: the grep reported the guarantee BROKEN while it was intact,
   * which is the failure mode of every source-shaped probe — it fails on a refactor, and a
   * probe that fails on a refactor is one somebody edits until it passes.
   *
   * It is behavioural now, which `--dry-run` is what made safe: `if (DRY_RUN) return 0;` sits
   * above the line constructing a provider, so the probe exercises the real decision path and
   * still cannot dispatch — including when the guard is missing, which was the objection.
   *
   * ## What each direction below proves, and what it does not
   *
   * The positive case runs the REAL repository, so it is evidence about this tree rather than
   * about a fixture. The negative cases are induced by breaking the probe's preconditions
   * rather than by removing the budget branch itself, because inducing that honestly would
   * mean mutating the working tree from inside a test. The behaviour they stand in for —
   * "a live run with no --max-calls exits 2 saying so" — is covered directly by
   * `test/dry-run.test.ts`, which spawns the real command for all four refusals.
   */
  it("reports the budget guard by running it, against this repository", () => {
    expect(PROBES.providerReach(process.cwd()).live_requires_declared_budget).toBe(true);
  }, 30_000);

  it("reports NOT VERIFIED when it cannot safely run the check", () => {
    const root = plant(null);
    mkdirSync(join(root, "scripts"), { recursive: true });

    // No `if (DRY_RUN) return 0;` — the probe refuses to spawn at all here, because a live
    // invocation without that early return is exactly the state in which spawning could
    // dispatch. Fail closed, and do it without touching the network to find out.
    writeFileSync(join(root, "scripts/run-eval.ts"), "// no dry-run early return\n");
    expect(PROBES.providerReach(root).live_requires_declared_budget).toBe(false);

    // Precondition satisfied but the command cannot produce the refusal — here because the
    // planted root has no runtime. Anything other than "exit 2, no budget declared" reads as
    // unverified rather than as fine.
    writeFileSync(join(root, "scripts/run-eval.ts"), "if (DRY_RUN) return 0;\n");
    expect(PROBES.providerReach(root).live_requires_declared_budget).toBe(false);

    rmSync(join(root, "scripts/run-eval.ts"));
    // Unreadable reads as NOT verified. A removed guard and an unreadable one make the same
    // claim — nothing was proven — and neither may pass as fine.
    expect(PROBES.providerReach(root).live_requires_declared_budget).toBe(false);
  }, 30_000);

  it("refuses a placeholder key and accepts a well-shaped one", () => {
    const r = PROBES.providerReach(plant(null));
    expect(r.placeholder_key_refused).toBe(true);
    expect(r.real_shaped_key_accepted).toBe(true);
  });
});
