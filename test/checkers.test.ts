import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkPlan } from "../scripts/check-plan.mjs";
import { checkBoundaries } from "../scripts/check-boundaries.mjs";
import { verifySources } from "../scripts/verify-sources.mjs";
import { checkCitations } from "../scripts/check-citations.mjs";
import { checkXsd, buildXml, validateAgainstXsd } from "../scripts/check-xsd.mjs";
import { checkDepthBudget } from "../scripts/check-depth-budget.mjs";

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
  catalogAdded: number;
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
  catalogAdded: 2,
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
  write(root, "scripts/catalog-additions.json", JSON.stringify({
    records: Array.from({ length: t.catalogAdded }, (_, i) => ({ id: `A${i}` })),
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
    catalog: { records_imported: 0, records_available: t.catalog, records_added: t.catalogAdded },
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
    ["wrong count of records added at import", (s) => { s.catalog.records_added = 99; }],
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

/* ── check-citations ──────────────────────────────────────────────────────── */

const goodRecord = (over: Record<string, unknown> = {}) => ({
  id: "chain-of-thought",
  primary_source: {
    authors: "Wei, Wang, Zhou",
    year: 2022,
    title: "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models",
    venue: "NeurIPS 2022",
    arxiv_id: "2201.11903",
    url: "https://arxiv.org/abs/2201.11903",
  },
  ...over,
});

function makeCatalogRepo(techniques: unknown[], defects?: unknown[]): string {
  const root = mkroot("pnx-cite-");
  write(root, "sources/catalog/data/prompt_technique_catalog.json", JSON.stringify({ techniques }));
  if (defects) write(root, "scripts/catalog-known-defects.json", JSON.stringify({ defects }));
  return root;
}

/** A record that contradicts itself: names arXiv as the venue, supplies no id. */
const arxivVenueNoId = {
  id: "orphan-preprint",
  primary_source: { authors: "A", year: 2025, title: "T", venue: "arXiv preprint" },
};

const PINNED_NOW = new Date("2026-08-17T00:00:00Z");

describe("check-citations", () => {
  it("passes on a catalog whose citations agree with themselves", () => {
    const r = checkCitations(makeCatalogRepo([goodRecord()]), PINNED_NOW);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("passes on the real 172-record catalog", () => {
    const r = checkCitations(process.cwd(), PINNED_NOW);
    expect(r.problems.map((p: { kind: string; technique: string }) => `${p.kind} ${p.technique}`)).toEqual([]);
    expect(r.records).toBe(172);
  });

  it("allows a record that cites a venue rather than a preprint", () => {
    // 13 real records do this — a book, an OpenAI report, a practitioner guide.
    // Treating a missing arXiv id as an error would fire on every one of them.
    const r = checkCitations(makeCatalogRepo([
      goodRecord({ primary_source: { authors: "Radford et al.", year: 2019, title: "Language Models are Unsupervised Multitask Learners", venue: "OpenAI (technical report)" } }),
    ]), PINNED_NOW);
    expect(r.ok).toBe(true);
    expect(r.withArxiv).toBe(0);
  });

  const badCitations: Array<[string, unknown, string]> = [
    ["a year that precedes its own preprint",
      goodRecord({ primary_source: { authors: "A", year: 2021, title: "T", arxiv_id: "2201.11903" } }),
      "year-precedes-preprint"],
    ["a malformed arXiv id",
      goodRecord({ primary_source: { authors: "A", year: 2022, title: "T", arxiv_id: "arXiv-2201" } }),
      "malformed-arxiv-id"],
    ["an impossible month in the arXiv id",
      goodRecord({ primary_source: { authors: "A", year: 2022, title: "T", arxiv_id: "2213.11903" } }),
      "malformed-arxiv-id"],
    ["a url pointing at a different paper",
      goodRecord({ primary_source: { authors: "A", year: 2022, title: "T", arxiv_id: "2201.11903", url: "https://arxiv.org/abs/9999.00000" } }),
      "url-does-not-match-id"],
    ["a record with no primary source at all",
      { id: "orphan" },
      "missing-primary-source"],
    ["a citation with no title",
      goodRecord({ primary_source: { authors: "A", year: 2022, arxiv_id: "2201.11903" } }),
      "missing-field"],
    ["an arXiv id dated in the future",
      goodRecord({ primary_source: { authors: "A", year: 2030, title: "T", arxiv_id: "3001.00001" } }),
      "future-arxiv-id"],
  ];

  it.each(badCitations)("rejects %s", (_label, record, kind) => {
    const r = checkCitations(makeCatalogRepo([record]), PINNED_NOW);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p: { kind: string }) => p.kind)).toContain(kind);
  });

  it("rejects one arXiv id reused for two different papers", () => {
    const r = checkCitations(makeCatalogRepo([
      goodRecord({ id: "a" }),
      goodRecord({ id: "b", primary_source: { authors: "X", year: 2022, title: "A Completely Different Paper", arxiv_id: "2201.11903" } }),
    ]), PINNED_NOW);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p: { kind: string }) => p.kind)).toContain("same-id-different-title");
  });

  it("allows the same paper cited twice under the same title", () => {
    const r = checkCitations(makeCatalogRepo([goodRecord({ id: "a" }), goodRecord({ id: "b" })]), PINNED_NOW);
    expect(r.ok).toBe(true);
  });

  it("refuses when the catalog is absent", () => {
    expect(checkCitations(mkroot("pnx-nocat-"), PINNED_NOW).fatalCode).toBe(2);
  });

  it("rejects a venue naming arXiv with no identifier supplied", () => {
    const r = checkCitations(makeCatalogRepo([arxivVenueNoId]), PINNED_NOW);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p: { kind: string }) => p.kind)).toContain("arxiv-venue-without-id");
  });
});

/* ── check-xsd ────────────────────────────────────────────────────────────── */

describe("check-xsd", () => {
  /**
   * The frozen XSD had never been run. Reading it caught two controlled vocabularies
   * the JSON Schema had typed as free strings — which is exactly why the XSD is worth
   * running rather than assumed redundant with the JSON contract.
   */
  const TINY_XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" elementFormDefault="qualified">
  <xs:simpleType name="mood">
    <xs:restriction base="xs:string">
      <xs:enumeration value="calm"/>
      <xs:enumeration value="loud"/>
    </xs:restriction>
  </xs:simpleType>
  <xs:element name="root">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="first" type="xs:string"/>
        <xs:element name="second" type="mood"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

  it("accepts a conforming document", () => {
    const r = validateAgainstXsd(`<root><first>a</first><second>calm</second></root>`, TINY_XSD);
    expect(r.valid).toBe(true);
  });

  it("rejects a value outside a controlled vocabulary", () => {
    const r = validateAgainstXsd(`<root><first>a</first><second>whatever</second></root>`, TINY_XSD);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("rejects elements out of sequence", () => {
    const r = validateAgainstXsd(`<root><second>calm</second><first>a</first></root>`, TINY_XSD);
    expect(r.valid).toBe(false);
  });

  it("rejects a missing required element", () => {
    const r = validateAgainstXsd(`<root><first>a</first></root>`, TINY_XSD);
    expect(r.valid).toBe(false);
  });

  it("validates both the frozen and the imported catalog in the real repository", () => {
    const r = checkXsd(process.cwd());
    expect(r.fatal).toBeNull();
    // Narrowed by the assertion above: the fatal path returns no results at all.
    const results = r.results!;
    expect(results.frozen.errors).toEqual([]);
    expect(results.imported.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("generates XML deterministically", () => {
    // No clock is read: generated_at is carried from the frozen metadata, so the
    // output is byte-identical run to run, like the JSON import.
    expect(buildXml(process.cwd())).toBe(buildXml(process.cwd()));
  });

  it("emits elements in the XSD's sequence, not the JSON's key order", () => {
    const xml = buildXml(process.cwd());
    const first = xml.slice(xml.indexOf("<technique "), xml.indexOf("</technique>"));
    const order = [...first.matchAll(/^ {6}<([a-z_]+)[ >/]/gm)].map((m) => m[1]);
    expect(order.slice(0, 9)).toEqual([
      "id", "name", "category", "subcategory", "executive_summary",
      "description", "verification_status", "cost_profile", "status",
    ]);
  });

  it("marks a null as nil rather than emitting an empty element", () => {
    const xml = buildXml(process.cwd());
    expect(xml).toContain('<arxiv_id nil="true"/>');
    expect(xml).toContain('empty="true"');
  });
});

/* ── check-depth-budget ───────────────────────────────────────────────────── */

describe("check-depth-budget", () => {
  /**
   * Depth and per-stage reliability are one design choice expressed twice, since
   * end-to-end success is p^m. This checker exists so that adding a stage forces a
   * visible decision rather than a silent loss.
   */
  const makeBudgetRepo = (stages: number, target: number, floor: number) => {
    const root = mkroot("pnx-depth-");
    // Letter-only ids: STAGE_IDS is parsed with the same `"[a-z_]+"` pattern check:plan
    // uses, so a fixture with digits in the names would test the fixture, not the rule.
    const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta",
                   "theta", "iota", "kappa", "lambda", "mu", "nu", "xi"];
    const ids = names.slice(0, stages).map((n) => `  "${n}",`).join("\n");
    write(root, "contracts/index.ts", `export const STAGE_IDS = [\n${ids}\n] as const;\n`);
    write(root, "contracts/reliability-budget.json",
      JSON.stringify({ end_to_end_target: target, per_stage_floor: floor, status: "declared-not-measured" }));
    return root;
  };

  it("passes on the real repository", () => {
    const r = checkDepthBudget(process.cwd());
    expect(r.fatal).toBeNull();
    expect(r.ok).toBe(true);
  });

  it("accepts a budget the depth can actually hold", () => {
    // 0.995^11 ≈ 0.9464, comfortably above 0.90.
    const r = checkDepthBudget(makeBudgetRepo(11, 0.9, 0.995));
    expect(r.ok).toBe(true);
    expect(r.depth).toBe(11);
  });

  it("fails when the per-stage floor cannot reach the end-to-end target", () => {
    // 0.95^11 ≈ 0.5688 — the compounding result, stated as a build failure.
    const r = checkDepthBudget(makeBudgetRepo(11, 0.9, 0.95));
    expect(r.ok).toBe(false);
    expect(r.achievable).toBeLessThan(0.6);
  });

  it("fails when depth grows past the headroom the floor allows", () => {
    // The boundary is deliberately tight: 0.9905^11 ≈ 0.9005 clears a 0.90 target,
    // 0.9905^12 ≈ 0.8919 does not. Adding one stage is the whole failure.
    //
    // Worth recording that the first draft of this test used a 0.99 floor on the
    // assumption that eleven stages would clear 0.90. They do not — 0.99^11 ≈ 0.8953.
    // The checker was right and the test was wrong, which is the argument for having
    // the arithmetic in a build step rather than in someone's head.
    expect(checkDepthBudget(makeBudgetRepo(11, 0.9, 0.9905)).ok).toBe(true);
    expect(checkDepthBudget(makeBudgetRepo(12, 0.9, 0.9905)).ok).toBe(false);
  });

  it("reports the per-stage reliability the declared depth and target demand", () => {
    const r = checkDepthBudget(makeBudgetRepo(11, 0.9, 0.95));
    // 0.9^(1/11) ≈ 0.99046
    expect(r.required).toBeGreaterThan(0.99);
    expect(r.required).toBeLessThan(0.9905);
  });

  it("reports headroom in whole stages", () => {
    const r = checkDepthBudget(makeBudgetRepo(11, 0.9, 0.995));
    // floor 0.995 supports 21 stages at a 0.90 target, so 10 remain.
    expect(r.headroom).toBe(10);
  });

  it("refuses a target outside (0,1) rather than computing nonsense", () => {
    expect(checkDepthBudget(makeBudgetRepo(11, 1.5, 0.99)).fatalCode).toBe(2);
  });

  it("refuses when the budget file is absent", () => {
    const root = mkroot("pnx-nobudget-");
    write(root, "contracts/index.ts", `export const STAGE_IDS = ["a"] as const;\n`);
    expect(checkDepthBudget(root).fatalCode).toBe(2);
  });

  it("refuses when no stages are declared", () => {
    const root = mkroot("pnx-nostages-");
    write(root, "contracts/index.ts", "export const NOTHING = 1;\n");
    write(root, "contracts/reliability-budget.json",
      JSON.stringify({ end_to_end_target: 0.9, per_stage_floor: 0.99 }));
    expect(checkDepthBudget(root).fatalCode).toBe(2);
  });
});

/* ── the known-defects allowlist ──────────────────────────────────────────── */

describe("check-citations known-defects allowlist", () => {
  /**
   * `sources/` is hash-frozen, so a defect in the catalog data cannot be fixed in
   * place. The allowlist excuses it — on terms that stop it becoming a place problems
   * go to be forgotten. These are the terms.
   */
  const entry = (over: Record<string, unknown> = {}) => ({
    technique: "orphan-preprint",
    kind: "arxiv-venue-without-id",
    reason: "frozen data; corrected at import",
    fix_at: "phase-4-import",
    ...over,
  });

  it("excuses a recorded defect instead of failing forever", () => {
    const r = checkCitations(makeCatalogRepo([arxivVenueNoId], [entry()]), PINNED_NOW);
    expect(r.ok).toBe(true);
    expect(r.excused).toBe(1);
  });

  it("still fails on a defect that is NOT recorded", () => {
    const other = { ...arxivVenueNoId, id: "another-orphan" };
    const r = checkCitations(makeCatalogRepo([arxivVenueNoId, other], [entry()]), PINNED_NOW);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p: { technique: string }) => p.technique)).toContain("another-orphan");
  });

  it("rejects an entry that states no reason", () => {
    const r = checkCitations(makeCatalogRepo([arxivVenueNoId], [entry({ reason: "" })]), PINNED_NOW);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p: { kind: string }) => p.kind)).toContain("allowlist-entry-without-reason");
  });

  it("rejects an entry whose defect no longer occurs", () => {
    // The rule that keeps the allowlist honest: once the data is fixed, the excuse
    // must go too, or the next real defect of that kind is silently excused.
    const r = checkCitations(makeCatalogRepo([goodRecord()], [entry()]), PINNED_NOW);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p: { kind: string }) => p.kind)).toContain("stale-allowlist-entry");
  });

  it("the real allowlist has a reason and a fix point on every entry", () => {
    const real = JSON.parse(readFileSync("scripts/catalog-known-defects.json", "utf8"));
    expect(real.defects.length).toBeGreaterThan(0);
    for (const d of real.defects) {
      expect(d.reason?.length ?? 0).toBeGreaterThan(20);
      expect(d.fix_at).toBeTruthy();
      expect(d.found).toBeTruthy();
    }
  });
});
