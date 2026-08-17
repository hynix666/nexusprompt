import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkPlan } from "../scripts/check-plan.mjs";
import { checkBoundaries } from "../scripts/check-boundaries.mjs";
import { verifySources } from "../scripts/verify-sources.mjs";

/**
 * Must-fire cases for the three checker scripts.
 *
 * Until now these had a must-not-fire case — `npm run verify` runs all three on the
 * real repository every time — and no must-fire case anywhere. Their planted defects
 * were probed by hand and the probes lived in a scratch directory.
 *
 * That gap cost something concrete. `check-plan.mjs` shipped with its regex anchored
 * on `plan-status\n`, worked on the branch it was written on, and exited 2 the moment
 * a `git checkout` re-materialised the file with CRLF. A checker whose verdict depends
 * on which branch you last switched from is worse than no checker. The CRLF pair below
 * is that bug, pinned.
 *
 * Each checker is exercised twice: against a fixture tree that should pass, and
 * against the same tree with one thing broken. Asserting only the failure would leave
 * a checker that fires on everything looking healthy.
 */

const temps: string[] = [];
const mkroot = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

const write = (root: string, rel: string, body: string) => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
};

/* ── check-plan ───────────────────────────────────────────────────────────── */

interface Truth {
  gates: string[];
  sourceGates: string[];
  stages: string[];
  stageTarget: string[];
  schemas: string[];
  adapters: string[];
  shells: string[];
  catalog: number;
  frozen: number;
  ci: boolean;
  commands: string[];
  planned: string[];
  eol: "\n" | "\r\n";
}

const DEFAULT: Truth = {
  gates: ["ALPHA_GATE", "BETA_GATE"],
  sourceGates: ["ALPHA_GATE", "BETA_GATE", "GAMMA_GATE"],
  stages: ["compile"],
  stageTarget: ["compile", "lint", "preview"],
  schemas: ["thing", "other"],
  adapters: ["provider-x"],
  shells: ["cli"],
  catalog: 5,
  frozen: 2,
  ci: false,
  commands: ["verify", "check:plan"],
  planned: ["adversarial"],
  eol: "\n",
};

/**
 * Build a miniature repository plus a plan that truthfully describes it. Tests then
 * break exactly one thing, so a failure names the claim rather than the fixture.
 */
function makePlanRepo(overrides: Partial<Truth> = {}): { root: string; truth: Truth } {
  const t = { ...DEFAULT, ...overrides };
  const root = mkroot("pnx-plan-");

  write(root, "package.json", JSON.stringify({
    scripts: Object.fromEntries(t.commands.map((c) => [c, "true"])),
  }));

  write(root, "scripts/ported-gates.json", JSON.stringify({ ported: t.gates }));
  write(root, "sources/v5/prompt_lint.py",
    t.sourceGates.map((g) => `findings.append({"gate": "${g}", "severity": "WARN"})`).join("\n"));
  write(root, "sources/MANIFEST.json", JSON.stringify({
    files: Array.from({ length: t.frozen }, (_, i) => ({ extracted_to: `sources/f${i}`, sha256: "x" })),
  }));
  write(root, "sources/catalog/data/prompt_technique_catalog.json", JSON.stringify({
    techniques: Array.from({ length: t.catalog }, (_, i) => ({ id: `T${i}` })),
  }));

  write(root, "contracts/index.ts",
    `export const STAGE_IDS = [\n${t.stageTarget.map((s) => `  "${s}",`).join("\n")}\n] as const;\n`);
  for (const s of t.schemas) write(root, `contracts/${s}.schema.json`, "{}");
  for (const s of t.stages) write(root, `core/src/stages/${s}.ts`, "export const x = 1;\n");
  for (const a of t.adapters) write(root, `adapters/${a}/package.json`, "{}");
  for (const s of t.shells) write(root, `shells/${s}/package.json`, "{}");
  if (t.ci) write(root, ".github/workflows/ci.yml", "on: push\n");

  const status = {
    gates: { ported: t.gates.length, source_total: t.sourceGates.length },
    stages: { built: t.stages.length, target: t.stageTarget.length },
    contracts: { schemas: t.schemas.length },
    adapters: [...t.adapters],
    shells: [...t.shells],
    catalog: { records_imported: 0, records_available: t.catalog },
    sources: { frozen_files: t.frozen },
    ci: { configured: t.ci },
    commands: [...t.commands],
    planned_commands: [...t.planned],
  };

  const plan = [
    "# Implementation Plan",
    "",
    "```json plan-status",
    JSON.stringify(status, null, 2),
    "```",
    "",
    "Run `npm run verify` to check everything.",
    "",
  ].join(t.eol);

  write(root, "Documentation/IMPLEMENTATION_PLAN.md", plan);
  return { root, truth: t };
}

/** Rewrite the plan-status JSON in place, the way a stale edit would. */
function editStatus(root: string, mutate: (s: any) => void, eol = "\n") {
  const path = join(root, "Documentation/IMPLEMENTATION_PLAN.md");
  const normalised = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const block = normalised.match(/```json plan-status\n([\s\S]*?)```/)!;
  const status = JSON.parse(block[1]);
  mutate(status);
  const rebuilt = normalised.replace(block[1], JSON.stringify(status, null, 2) + "\n");
  writeFileSync(path, eol === "\n" ? rebuilt : rebuilt.replace(/\n/g, "\r\n"));
}

describe("check-plan", () => {
  it("passes on a plan that tells the truth", () => {
    const { root } = makePlanRepo();
    const r = checkPlan(root);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("passes on the real repository", () => {
    const r = checkPlan(process.cwd());
    expect(r.failures.map((f) => f.label)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  // The regression that shipped. Both endings must give the same verdict.
  it.each([["LF", "\n"], ["CRLF", "\r\n"]] as const)(
    "reads a plan written with %s endings", (_name, eol) => {
      const { root } = makePlanRepo({ eol });
      expect(checkPlan(root).ok).toBe(true);
    },
  );

  it.each([["LF", "\n"], ["CRLF", "\r\n"]] as const)(
    "still catches a false claim with %s endings", (_name, eol) => {
      const { root } = makePlanRepo({ eol });
      editStatus(root, (s: any) => { s.gates.ported = 99; }, eol);
      expect(checkPlan(root).ok).toBe(false);
    },
  );

  const falseClaims: Array<[string, (s: any) => void]> = [
    ["overstated ported gates", (s) => { s.gates.ported = 9; }],
    ["wrong source gate total", (s) => { s.gates.source_total = 99; }],
    ["overstated stages built", (s) => { s.stages.built = 7; }],
    ["wrong stage target", (s) => { s.stages.target = 2; }],
    ["wrong schema count", (s) => { s.contracts.schemas = 1; }],
    ["an adapter that does not exist", (s) => { s.adapters.push("storage-db"); }],
    ["a shell that does not exist", (s) => { s.shells.push("pipeline-ui"); }],
    ["wrong catalog size", (s) => { s.catalog.records_available = 999; }],
    ["catalog claimed as imported", (s) => { s.catalog.records_imported = 5; }],
    ["wrong frozen file count", (s) => { s.sources.frozen_files = 41; }],
    ["CI claimed as configured", (s) => { s.ci.configured = true; }],
    ["a command that is not built", (s) => { s.commands.push("verify:gates"); }],
    ["a built command listed as planned", (s) => { s.planned_commands.push("verify"); }],
  ];

  it.each(falseClaims)("rejects %s", (_label, mutate) => {
    const { root } = makePlanRepo();
    editStatus(root, mutate);
    const r = checkPlan(root);
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  });

  it("rejects a command cited in prose but declared nowhere", () => {
    const { root } = makePlanRepo();
    const path = join(root, "Documentation/IMPLEMENTATION_PLAN.md");
    writeFileSync(path, readFileSync(path, "utf8") + "\nRun `npm run ghost:task` first.\n");
    expect(checkPlan(root).ok).toBe(false);
  });

  it("refuses (exit code 2) when the status block is missing", () => {
    const { root } = makePlanRepo();
    write(root, "Documentation/IMPLEMENTATION_PLAN.md", "# Implementation Plan\n\nNo block here.\n");
    const r = checkPlan(root);
    expect(r.fatalCode).toBe(2);
  });

  it("refuses when the status block is not valid JSON", () => {
    const { root } = makePlanRepo();
    write(root, "Documentation/IMPLEMENTATION_PLAN.md",
      "# Plan\n\n```json plan-status\n{ not json ]\n```\n");
    expect(checkPlan(root).fatalCode).toBe(2);
  });

  it("refuses when the plan itself is absent", () => {
    const root = mkroot("pnx-noplan-");
    expect(checkPlan(root).fatalCode).toBe(2);
  });
});

/* ── check-boundaries ─────────────────────────────────────────────────────── */

function makeLayerRepo(files: Record<string, string>): string {
  const root = mkroot("pnx-bounds-");
  write(root, "core/src/pure.ts", 'import { createHash } from "node:crypto";\nexport const h = createHash;\n');
  write(root, "contracts/index.ts", "export type X = string;\n");
  write(root, "application/src/app.ts", 'import type { X } from "../../contracts/index.js";\nexport type Y = X;\n');
  write(root, "adapters/store/src/index.ts", 'import { readFile } from "node:fs/promises";\nexport const r = readFile;\n');
  write(root, "shells/cli/src/index.ts", 'import type { Y } from "../../../application/src/app.js";\nexport type Z = Y;\n');
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  return root;
}

describe("check-boundaries", () => {
  it("passes on a tree that respects the dependency direction", () => {
    const r = checkBoundaries(makeLayerRepo({}));
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.filesChecked).toBeGreaterThan(0);
  });

  it("passes on the real repository", () => {
    const r = checkBoundaries(process.cwd());
    expect(r.violations.map((v) => `${v.file} → ${v.spec}`)).toEqual([]);
  });

  const violations: Array<[string, string, string]> = [
    ["Core importing the filesystem", "core/src/pure.ts", 'import { readFileSync } from "node:fs";\n'],
    ["Core importing child_process", "core/src/pure.ts", 'import { execSync } from "node:child_process";\n'],
    ["Core importing an adapter", "core/src/pure.ts", 'import { r } from "../../adapters/store/src/index.js";\n'],
    ["Core importing the Application", "core/src/pure.ts", 'import type { Y } from "../../application/src/app.js";\n'],
    ["the Application naming a concrete adapter", "application/src/app.ts", 'import { r } from "../../adapters/store/src/index.js";\n'],
    ["a Shell importing an adapter", "shells/cli/src/index.ts", 'import { r } from "../../../adapters/store/src/index.js";\n'],
    ["a Shell importing Core", "shells/cli/src/index.ts", 'import { h } from "../../../core/src/pure.js";\n'],
    ["a Shell importing another Shell", "shells/cli/src/index.ts", 'import type { Q } from "../../toolkit/src/index.js";\n'],
    ["an adapter importing Core", "adapters/store/src/index.ts", 'import { h } from "../../../core/src/pure.js";\n'],
    ["Contracts importing Core", "contracts/index.ts", 'import { h } from "../core/src/pure.js";\n'],
  ];

  it.each(violations)("rejects %s", (_label, file, line) => {
    const root = makeLayerRepo({});
    const abs = join(root, file);
    writeFileSync(abs, line + readFileSync(abs, "utf8"));
    const r = checkBoundaries(root);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v: { file: string }) => v.file === file)).toBe(true);
  });

  it("honours a recorded exemption for the composition root", () => {
    // The exemption is what lets the CLI name adapters. If it stopped applying, the
    // real repository check above would fail — this pins the mechanism directly.
    const r = checkBoundaries(process.cwd());
    expect(r.exemptions.map(([f]) => f)).toContain("shells/cli/src/composition-root.ts");
    for (const [, why] of r.exemptions) expect(why.length).toBeGreaterThan(20);
  });
});

/* ── verify-sources ───────────────────────────────────────────────────────── */

function makeFrozenRepo(): { root: string; file: string } {
  const root = mkroot("pnx-freeze-");
  const body = "frozen contents\n";
  write(root, "sources/a.py", body);
  write(root, "sources/b.py", "second\n");
  write(root, "sources/MANIFEST.json", JSON.stringify({
    archives: [],
    files: [
      { extracted_to: "sources/a.py", sha256: createHash("sha256").update(body).digest("hex") },
      { extracted_to: "sources/b.py", sha256: createHash("sha256").update("second\n").digest("hex") },
    ],
  }));
  return { root, file: join(root, "sources/a.py") };
}

describe("verify-sources", () => {
  it("passes when every hash matches", () => {
    const { root } = makeFrozenRepo();
    const r = verifySources(root);
    expect(r.problems).toEqual([]);
    expect(r.checked).toBe(2);
  });

  it("passes on the real repository", () => {
    const r = verifySources(process.cwd());
    expect(r.problems.map((p) => `${p.kind} ${p.file}`)).toEqual([]);
  });

  it("catches a single altered byte", () => {
    const { root, file } = makeFrozenRepo();
    writeFileSync(file, "frozen contents \n"); // one space
    const r = verifySources(root);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatchObject({ kind: "modified", file: "sources/a.py" });
  });

  it("catches a deleted file rather than skipping it", () => {
    const { root, file } = makeFrozenRepo();
    rmSync(file);
    const r = verifySources(root);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatchObject({ kind: "missing", file: "sources/a.py" });
  });

  it("reports a missing manifest instead of reporting success", () => {
    const root = mkroot("pnx-nomanifest-");
    const r = verifySources(root);
    expect(r.ok).toBe(false);
    expect(r.fatal).toMatch(/manifest not found/);
  });
});
