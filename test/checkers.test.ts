import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkPlan } from "../scripts/check-plan.mjs";
import { checkBoundaries } from "../scripts/check-boundaries.mjs";
import { verifySources } from "../scripts/verify-sources.mjs";
// Moved out of `scripts/run-eval.ts` when `--dry-run` gave the live preconditions a second
// caller. One predicate, two callers, no way for them to drift.
import { implausibleKeyReason } from "../core/src/eval/preflight.js";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
const __dirnameShim = dirname(fileURLToPath(import.meta.url));
import { checkCitations } from "../scripts/check-citations.mjs";
import { checkXsd, buildXml, validateAgainstXsd } from "../scripts/check-xsd.mjs";
import { checkDepthBudget } from "../scripts/check-depth-budget.mjs";
import { checkStages } from "../scripts/check-stages.mjs";
import { checkCorpus, buildManifest } from "../scripts/check-corpus.mjs";
import { checkCounts } from "../scripts/check-counts.mjs";
import { checkFingerprint, RUNS as FP_RUNS } from "../scripts/check-fingerprint.mjs";
import { checkRepoHygiene, NEVER_IGNORED } from "../scripts/check-repo-hygiene.mjs";
import { collect, render } from "../scripts/generate-capability-matrix.mjs";

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
  // A stage module is one that DECLARES a stage. check:plan counts the declaration, not
  // the file, so shared plumbing like stage-kit.ts is not miscounted as a stage.
  for (const s of t.stages) write(root, `core/src/stages/${s}.ts`, `export const STAGE_ID = "${s}";\n`);
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

/* ── check-stages ─────────────────────────────────────────────────────────── */

describe("check-stages", () => {
  /**
   * The only checker in `verify` without a test here. It was mutation-proved by hand when
   * written — a hand proof that nothing re-runs is a claim, not a check, which is the
   * distinction this whole suite exists on.
   *
   * The fixture is a miniature frozen component: two stages, a DEPTH_PLAN, a matching
   * STAGE_IDS and one ported stage module.
   */
  const frozenComponent = (stages: Array<[string, string, string]>, depthPlan: string) => `
const DEPTH_PLAN = {
${depthPlan}
};
const DEFAULT_STAGES = [
${stages.map(([s, name, tpl]) => `  {
    id: "${s}", name: "${name}", role: "x", on: true,
    template:
\`${tpl}\`,
  },`).join("\n")}
];
const COMPILER_SYSTEM = \`shared identity\`;
`;

  const makeStageRepo = (over: {
    component?: string;
    stageIds?: string[];
    portedTemplate?: string;
    deviations?: unknown[];
  } = {}) => {
    const root = mkdtempSync(join(tmpdir(), "stages-"));
    const stages: Array<[string, string, string]> = [["s1", "Deconstruct", "T-ONE"], ["s2", "Calibrate", "T-TWO"]];
    write(root, "sources/pipeline/SystemPromptBuilderPipeline.tsx",
      over.component ?? frozenComponent(stages, `  TINY:     ["s1"],\n  MINIMAL:  ["s1"],\n  STANDARD: ["s1", "s2"],`));
    const ids = over.stageIds ?? ["deconstruct", "calibrate"];
    write(root, "contracts/index.ts",
      `export const STAGE_IDS = [\n${ids.map((i) => `  "${i}",`).join("\n")}\n] as const;\n`);
    write(root, "core/src/stages/deconstruct.ts",
      `export const STAGE_ID = "deconstruct";\nconst TEMPLATE = \`${over.portedTemplate ?? "T-ONE"}\`;\n`);
    write(root, "core/src/stages/stage-kit.ts", "export const COMPILER_SYSTEM = `shared identity`;\n");
    write(root, "core/src/stages/pipeline.ts",
      `export const DEPTH_PLAN = {\n  TINY: ["deconstruct"],\n  MINIMAL: ["deconstruct"],\n};\n`);
    write(root, "scripts/stage-template-deviations.json",
      JSON.stringify({ deviations: over.deviations ?? [] }));
    return root;
  };

  const kinds = (r: { problems: Array<{ kind: string }> }) => r.problems.map((p) => p.kind);

  it("passes a tree whose STAGE_IDS, depth plan and templates all match", () => {
    const r = checkStages(makeStageRepo());
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    // The fatal path returns a narrower shape, so `stages` is only present on a real result
    // — narrowed rather than cast, since a cast here is exactly what this repo keeps finding
    // behind its worst defects.
    expect("stages" in r && r.stages).toBe(2);
  });

  it("catches STAGE_IDS drifting from the frozen stage list", () => {
    // The nine-stage trap: a hand-maintained list losing a stage the component defines.
    expect(kinds(checkStages(makeStageRepo({ stageIds: ["deconstruct"] })))).toContain("stage-list-drift");
    // Order matters too — the component defines a sequence, not a set.
    expect(kinds(checkStages(makeStageRepo({ stageIds: ["calibrate", "deconstruct"] })))).toContain("stage-list-drift");
  });

  it("catches a ported template that does not match its frozen source", () => {
    expect(kinds(checkStages(makeStageRepo({ portedTemplate: "SOMETHING ELSE" })))).toContain("template-drift");
  });

  it("requires a deviation to state a reason and pin the ported template", () => {
    const withDrift = { portedTemplate: "SOMETHING ELSE" };
    expect(kinds(checkStages(makeStageRepo({ ...withDrift, deviations: [{ stage: "deconstruct" }] }))))
      .toContain("deviation-without-reason");
    expect(kinds(checkStages(makeStageRepo({ ...withDrift, deviations: [{ stage: "deconstruct", reason: "because" }] }))))
      .toContain("deviation-without-pinned-template");
  });

  it("fails a deviation that is stale — the template now matches", () => {
    const r = checkStages(makeStageRepo({ deviations: [{ stage: "deconstruct", reason: "r", ported_sha256: "x" }] }));
    expect(kinds(r)).toContain("stale-deviation");
  });

  it("catches Core's DEPTH_PLAN drifting from the frozen one", () => {
    // Core writes stage ids where the component writes s1..s11; that translation is exactly
    // where a hand-maintained list drifts.
    const root = makeStageRepo();
    write(root, "core/src/stages/pipeline.ts",
      `export const DEPTH_PLAN = {\n  TINY: ["calibrate"],\n  MINIMAL: ["deconstruct"],\n};\n`);
    expect(kinds(checkStages(root))).toContain("core-depth-plan-drift");
  });

  it("catches a system prompt that does not appear in the frozen component", () => {
    const root = makeStageRepo();
    write(root, "core/src/stages/stage-kit.ts", "export const COMPILER_SYSTEM = `invented identity`;\n");
    expect(kinds(checkStages(root))).toContain("system-prompt-drift");
  });

  it("refuses rather than passing when the frozen component cannot be read", () => {
    const root = mkdtempSync(join(tmpdir(), "stages-empty-"));
    const r = checkStages(root);
    expect(r.ok).toBe(false);
    expect(r.fatalCode).toBe(2);
  });
});

/* ── check-corpus ─────────────────────────────────────────────────────────── */

/**
 * A corpus fixture plus its manifest. Two of the four PDFs share content, so
 * `unique_documents` is 3 while `files` is 4 — the shape of the real corpus, where
 * 661 files dedupe to 599 and four documents got the arithmetic wrong.
 */
function makeCorpusRepo(): { root: string } {
  const root = mkroot("pnx-corpus-");
  write(root, "PDF/a.pdf", "alpha");
  write(root, "PDF/PROMPT/a.pdf", "alpha");   // byte-identical duplicate
  write(root, "PDF/PROMPT/b.pdf", "beta");
  write(root, "PDF/RAG/c.pdf", "gamma");
  write(root, "PDF/notes.txt", "not a pdf, must be ignored");
  write(root, "scripts/corpus-manifest.json", JSON.stringify(buildManifest(root), null, 2));
  return { root };
}

describe("check-corpus", () => {
  it("passes on a corpus that matches its manifest, counting duplicates as one document", () => {
    const { root } = makeCorpusRepo();
    const r = checkCorpus(root);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.manifest.files).toBe(4);
    expect(r.manifest.unique_documents).toBe(3);
    expect(r.manifest.duplicate_files).toBe(1);
  });

  it("agrees with the real repository about whether the corpus is there", () => {
    /**
     * Both branches assert; neither skips.
     *
     * `PDF/` is gitignored — 2 GB of third-party papers whose canonical home is arXiv — so a
     * fresh checkout has never had it and never will. A test that simply expected `ok` would
     * be red on every clone, and one that skipped when the corpus was absent would report
     * green for work it did not do, which is the pattern this file exists to prevent.
     *
     * So the assertion is on the checker being CORRECT rather than on the corpus being
     * present: with the corpus, the check must pass; without it, the check must fail and say
     * which files are missing. The second branch is a must-fire case against the real
     * manifest, which is stronger coverage than the original assertion had.
     */
    const present = existsSync(join(process.cwd(), "PDF"));
    const r = checkCorpus(process.cwd());

    if (present) {
      expect(r.ok, "corpus is present, so every pinned hash must still match").toBe(true);
    } else {
      expect(r.ok, "corpus is absent, so the check must not report success").toBe(false);
      expect(JSON.stringify(r)).toMatch(/missing/i);
    }
  });

  it("catches a file substituted for one of the same length", () => {
    // The case an inventory-only check could not see: "beta" and "BETA" are both four
    // bytes, so only re-hashing separates them. This is why the fast/deep split was
    // deleted rather than shipped — hashing 2 GB costs 1.4s, not the 11s first measured.
    const { root } = makeCorpusRepo();
    write(root, "PDF/PROMPT/b.pdf", "BETA");
    const r = checkCorpus(root);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.kind)).toEqual(["modified"]);
  });

  it.each([
    ["a deleted file", (root: string) => rmSync(join(root, "PDF/RAG/c.pdf")), "missing"],
    ["a resized file", (root: string) => write(root, "PDF/RAG/c.pdf", "gamma-plus"), "resized"],
    ["an unpinned addition", (root: string) => write(root, "PDF/new.pdf", "delta"), "unpinned"],
  ])("catches %s", (_name, mutate, kind) => {
    const { root } = makeCorpusRepo();
    mutate(root);
    const r = checkCorpus(root);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.kind)).toContain(kind);
  });

  it("refuses rather than passing when there is no manifest", () => {
    const root = mkroot("pnx-corpus-bare-");
    write(root, "PDF/a.pdf", "alpha");
    const r = checkCorpus(root);
    expect(r.ok).toBe(false);
    expect(r.fatalCode).toBe(2);
  });
});

/* ── check-counts ─────────────────────────────────────────────────────────── */

function makeCountsRepo(prose: string, pattern = "a catalog of ([\\d,]+) techniques"): string {
  const root = mkroot("pnx-counts-");
  write(root, "core/src/catalog/techniques.json",
    JSON.stringify(Array.from({ length: 195 }, (_, i) => ({
      id: `T${i}`,
      verification_status:
        i < 151 ? "verifier-checkable" : i < 161 ? "judge-checkable" : "unverifiable-by-text",
    }))));
  write(root, "Documentation/ADR.md", prose);
  write(root, "scripts/counted-claims.json", JSON.stringify({
    claims: [{ document: "Documentation/ADR.md", pattern, resolver: "catalog.records", reason: "fixture" }],
  }));
  return root;
}

describe("check-counts", () => {
  it("passes when the prose matches the repository", () => {
    const r = checkCounts(makeCountsRepo("It ships a catalog of 195 techniques today.\n"));
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("passes on the real repository", () => {
    const r = checkCounts(process.cwd());
    expect(r.failures.map((f) => f.detail ?? f.kind)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("catches the count that shipped wrong in four documents", () => {
    const r = checkCounts(makeCountsRepo("It ships a catalog of 180 techniques today.\n"));
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatchObject({ kind: "false", expected: 195, found: 180, line: 1 });
  });

  it("requires EVERY occurrence to agree, not just the first", () => {
    // "673-paper corpus" appeared three times. A checker that stopped at the first
    // match would have reported one defect and left two standing.
    const r = checkCounts(makeCountsRepo(
      "a catalog of 195 techniques\n\nand later, a catalog of 180 techniques\n"));
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ found: 180, line: 3 });
  });

  it("fails a pin whose sentence has been deleted, rather than passing quietly", () => {
    // The stale rule. Without it, rewording a sentence silently retires its check and
    // the pin file fills with guards over prose nobody has written for months.
    const r = checkCounts(makeCountsRepo("The catalog is large.\n"));
    expect(r.ok).toBe(false);
    expect(r.failures[0].kind).toBe("stale");
  });

  it("reads a captured trailing comma as a number", () => {
    // The pattern /`judge-checkable` ([\d,]+)/ captures "10," from "10, unverifiable".
    const root = makeCountsRepo("partition: 195, and more\n", "partition: ([\\d,]+)");
    expect(checkCounts(root).ok).toBe(true);
  });

  it("refuses a pin with no reason", () => {
    const root = makeCountsRepo("a catalog of 195 techniques\n");
    write(root, "scripts/counted-claims.json", JSON.stringify({
      claims: [{ document: "Documentation/ADR.md", pattern: "of ([0-9]+) tech", resolver: "catalog.records" }],
    }));
    expect(checkCounts(root).fatalCode).toBe(2);
  });

  it("refuses an unknown resolver rather than skipping the claim", () => {
    const root = makeCountsRepo("a catalog of 195 techniques\n");
    write(root, "scripts/counted-claims.json", JSON.stringify({
      claims: [{ document: "Documentation/ADR.md", pattern: "of ([0-9]+) tech", resolver: "catalog.invented", reason: "x" }],
    }));
    expect(checkCounts(root).fatalCode).toBe(2);
  });

  it("checks the routing partition as three independent numbers", () => {
    // 137/8/35 was wrong in all three. Checking only the sum would let a compensating
    // pair of errors through, and ADR-0008 routes judge calls on this partition.
    const root = makeCountsRepo("verifier 151, judge 10, unverifiable 34\n");
    const pins = (p: string, r: string) => ({ document: "Documentation/ADR.md", pattern: p, resolver: r, reason: "x" });
    write(root, "scripts/counted-claims.json", JSON.stringify({
      claims: [
        pins("verifier ([\\d,]+)", "catalog.verifier_checkable"),
        pins("judge ([\\d,]+)", "catalog.judge_checkable"),
        pins("unverifiable ([\\d,]+)", "catalog.unverifiable_by_text"),
      ],
    }));
    expect(checkCounts(root).ok).toBe(true);

    write(root, "Documentation/ADR.md", "verifier 152, judge 9, unverifiable 34\n");
    const bad = checkCounts(root);
    expect(bad.ok).toBe(false);
    expect(bad.failures).toHaveLength(2);
  });
});

/* ── check-fingerprint ────────────────────────────────────────────────────── */

const revision = (provider: string | null, fingerprint: string | null) => ({
  revision_id: "r", run_id: "run", stage_id: "compile", provider_used: provider,
  execution_provenance: {
    core_build_hash: "h", contract_versions: {},
    provider_model_fingerprint: fingerprint, config_fingerprint: null,
  },
});

function makeFingerprintRepo(bundle: unknown[], watch: unknown = {}): string {
  const root = mkroot("pnx-fp-");
  write(root, `${FP_RUNS}/run.json`, JSON.stringify(bundle));
  write(root, "scripts/model-fingerprints.json", JSON.stringify({ watch }));
  return root;
}

const WATCH = {
  "local-proxy": {
    fingerprints: ["local-proxy:claude-opus-5"],
    first_seen: "2026-08-22",
    baseline_suite: "compile-smoke",
  },
};

describe("check-fingerprint", () => {
  it("passes on the real repository, and its armed flag matches what it observed", () => {
    /**
     * `armed` was asserted false here, which made this a test about the DEVELOPER'S MACHINE
     * rather than about the checker. Run bundles are gitignored, so a clean checkout and CI
     * have none and the assertion held; the moment someone ran `pipeline --model <name>` it
     * failed locally while still passing in CI. A test that green on the machine with the
     * least evidence is the wrong way round.
     *
     * The invariant that actually belongs to the checker is the equivalence: armed exactly
     * when something was observed, and honest about coverage either way. That holds on both
     * kinds of machine, which is what makes it a test rather than a snapshot of one.
     */
    const r = checkFingerprint(process.cwd());
    expect(r.ok).toBe(true);
    expect(r.armed).toBe(r.observations.length > 0);
  });

  it("passes when the observed fingerprint is the pinned one", () => {
    const r = checkFingerprint(makeFingerprintRepo([revision("local-proxy", "local-proxy:claude-opus-5")], WATCH));
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.armed).toBe(true);
  });

  it("catches the model changing underneath a pinned provider", () => {
    const r = checkFingerprint(makeFingerprintRepo([revision("local-proxy", "local-proxy:claude-opus-6")], WATCH));
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatchObject({ kind: "drift", found: "local-proxy:claude-opus-6" });
  });

  it("catches a provider nobody pinned", () => {
    const r = checkFingerprint(makeFingerprintRepo([revision("hosted", "hosted:claude-opus-5")], WATCH));
    expect(r.ok).toBe(false);
    expect(r.failures[0].kind).toBe("unwatched");
  });

  it("counts a null fingerprint as unavailable, never as agreement", () => {
    // A degraded run reached no model, so it says nothing about which model is live.
    // Treating null as a match would let demo mode arm the watch with nothing.
    const r = checkFingerprint(makeFingerprintRepo([revision("local-proxy", null), revision(null, null)], WATCH));
    expect(r.ok).toBe(true);
    expect(r.armed).toBe(false);
    expect(r.unavailable).toBe(2);
  });

  it("deduplicates one fingerprint across an eleven-stage run", () => {
    const bundle = Array.from({ length: 11 }, () => revision("local-proxy", "local-proxy:claude-opus-5"));
    const r = checkFingerprint(makeFingerprintRepo(bundle, WATCH));
    expect(r.observations).toHaveLength(1);
    expect(r.entries).toBe(11);
  });

  it("ignores a half-written bundle rather than crashing on it", () => {
    const root = makeFingerprintRepo([revision("local-proxy", "local-proxy:claude-opus-5")], WATCH);
    write(root, `${FP_RUNS}/torn.json`, '[{"revision_id":');
    expect(checkFingerprint(root).ok).toBe(true);
  });
});

/* ── check-depth-budget: gate feedback deepens the pipeline ────────────────── */

describe("check-depth-budget prices gate-feedback rounds", () => {
  /**
   * A reflexive run is deeper than its plan. Each permitted round re-runs `refine` and then
   * `lint` — two executions — so checking the plan length alone would leave the guard
   * measuring a depth the system no longer has. That makes the cap DERIVED: raising
   * max_feedback_rounds fails the build unless the floor or the target moves.
   */
  const budgetRepo = (stages: number, target: number, floor: number, rounds?: number) => {
    const root = mkroot("pnx-depth-fb-");
    const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta",
                   "theta", "iota", "kappa", "lambda", "mu", "nu", "xi"];
    const ids = names.slice(0, stages).map((n) => `  "${n}",`).join("\n");
    write(root, "contracts/index.ts", `export const STAGE_IDS = [\n${ids}\n] as const;\n`);
    write(root, "contracts/reliability-budget.json", JSON.stringify({
      end_to_end_target: target, per_stage_floor: floor, status: "declared-not-measured",
      ...(rounds === undefined ? {} : { max_feedback_rounds: rounds }),
    }));
    return root;
  };

  it("counts two executions per round, not one", () => {
    const r = checkDepthBudget(budgetRepo(11, 0.9, 0.995, 3));
    expect(r.depth).toBe(11);
    expect(r.worstDepth).toBe(17);   // 11 + 3 × 2
    expect(r.ok).toBe(true);          // 0.995^17 ≈ 0.9184
  });

  it("fails when the rounds push the worst case past the target", () => {
    // 0.995^23 ≈ 0.8911, below 0.90. The plan is unchanged at 11 stages — only the loop
    // moved, which is exactly the drift this arithmetic exists to catch.
    const r = checkDepthBudget(budgetRepo(11, 0.9, 0.995, 6));
    expect(r.ok).toBe(false);
    expect(r.worstDepth).toBe(23);
  });

  it("treats an absent cap as zero rounds, never as unlimited", () => {
    const r = checkDepthBudget(budgetRepo(11, 0.9, 0.995));
    expect(r.rounds).toBe(0);
    expect(r.worstDepth).toBe(11);
  });

  it("refuses a nonsense cap rather than coercing it", () => {
    const root = budgetRepo(11, 0.9, 0.995);
    write(root, "contracts/reliability-budget.json", JSON.stringify({
      end_to_end_target: 0.9, per_stage_floor: 0.995, max_feedback_rounds: -1,
    }));
    expect(checkDepthBudget(root).fatalCode).toBe(2);
  });
});
/* ── docs:matrix ──────────────────────────────────────────────────────────── */

/**
 * A fixture repository with THREE schemas, only two of which the conformance suite covers.
 *
 * The real tree has every schema covered, which is why a probe that replaced the derived
 * `validated` flag with a hard-coded `true` survived: with nothing uncovered, "always
 * covered" is indistinguishable from "correctly covered". This is the fourth time in this
 * project a fixture has been found too uniform to discriminate, and the fix is the same each
 * time — make the fixture contain the case the guard exists to catch.
 */
function matrixRepo(): string {
  const root = mkroot("pnx-matrix-");
  const schema = (name: string, version: string) =>
    write(root, `contracts/${name}.schema.json`, JSON.stringify({
      $id: `https://promptnexus.dev/contracts/${name}/${version}`,
      title: name,
      type: "object",
    }));
  schema("covered-one", "1.0.0");
  schema("covered-two", "2.1.0");
  schema("orphan", "1.0.0");

  write(root, "contracts/pending-implementation.json", JSON.stringify({ pending: [] }));
  write(root, "test/contract-conformance.test.ts", [
    'expect(report(validators["covered-one"], v)).toBe(true);',
    'expect(report(validators["covered-two"], v)).toBe(true);',
  ].join("\n"));
  write(root, "adapters/storage-local/package.json", "{}");
  write(root, "adapters/evidence-local/package.json", "{}");
  return root;
}

describe("docs:matrix", () => {
  it("derives coverage from the conformance suite rather than asserting it", () => {
    const state = collect(matrixRepo());
    const byName = Object.fromEntries(state.schemas.map((s) => [s.name, s]));
    expect(byName["covered-one"].validated).toBe(true);
    expect(byName["covered-two"].validated).toBe(true);
    // The one the suite never mentions. A generator that hard-coded coverage would say true.
    expect(byName["orphan"].validated).toBe(false);
  });

  it("renders an uncovered schema loudly, not as a blank cell", () => {
    const md = render(collect(matrixRepo()));
    expect(md).toContain("**UNCOVERED**");
    expect(md).toContain("**2 of 3** schemas are validated");
  });

  it("reads each schema's version from its own $id", () => {
    const md = render(collect(matrixRepo()));
    expect(md).toContain("| `covered-two` | 2.1.0 |");
  });

  it("counts adapters from the tree", () => {
    const state = collect(matrixRepo());
    expect(state.adapters).toEqual(["evidence-local", "storage-local"]);
  });

  it("reports an empty evidence plane as zero, and says what zero means", () => {
    const md = render(collect(matrixRepo()));
    expect(md).toContain("| `promotion` | 0 |");
    expect(md).toContain("No promotion has ever been recorded");
  });

  it("counts evidence records that are actually on disk", () => {
    const root = matrixRepo();
    write(root, ".promptnexus/evidence/promotion/p1.json", "{}");
    write(root, ".promptnexus/evidence/eval-run/r1.json", "{}");
    write(root, ".promptnexus/evidence/eval-run/r2.json", "{}");
    const state = collect(root);
    expect(state.evidence.promotion).toBe(1);
    expect(state.evidence["eval-run"]).toBe(2);
    expect(render(state)).not.toContain("No promotion has ever been recorded");
  });

  it("marks the output as generated, so a hand-editor is warned before the build is", () => {
    expect(render(collect(matrixRepo()))).toContain("GENERATED FILE — do not edit by hand");
  });
});

/* ── eval --live key shape ───────────────────────────────────────────────── */

/**
 * The refusal that exists because the guard next to it was honest about being narrow.
 *
 * `ANTHROPIC_API_KEY` was tested for PRESENCE only, which is the right thing for a script
 * that must never route the value anywhere. But presence lets a placeholder through, and
 * then the failure is a 401 from api.anthropic.com partway into a run whose budget is
 * already committed — remote, late, and reported as an HTTP status rather than as the
 * mistake that caused it.
 *
 * Observed: `setx ANTHROPIC_API_KEY "<your key>"` run verbatim from a copy-pasted line.
 */
describe("implausibleKeyReason", () => {
  it("rejects a placeholder pasted verbatim", () => {
    expect(implausibleKeyReason("<your key>")).toBe("contains a bracket, quote or whitespace");
    expect(implausibleKeyReason("YOUR_KEY_HERE")).toBe("is 13 characters long");
    expect(implausibleKeyReason("'sk-ant-api03-realish-looking-value'"))
      .toBe("contains a bracket, quote or whitespace");
    expect(implausibleKeyReason("sk-ant-api03-with a space in it")).toBe("contains a bracket, quote or whitespace");
  });

  it("rejects a truncated paste", () => {
    expect(implausibleKeyReason("sk-ant-")).toBe("is 7 characters long");
    expect(implausibleKeyReason("")).toBe("is 0 characters long");
  });

  it("accepts anything that could actually be a key", () => {
    // The must-not-fire half, and the reason this asserts no vendor format. A check for
    // `sk-ant-` plus a length would fail closed the day either changes, turning a working
    // setup into a refusal for a reason the user cannot act on.
    expect(implausibleKeyReason(`sk-ant-api03-${"a".repeat(90)}`)).toBeNull();
    expect(implausibleKeyReason("a".repeat(20))).toBeNull();          // exactly at the floor
    expect(implausibleKeyReason("some-future-format-that-is-long-enough")).toBeNull();
  });

  it("importing run-eval does not exit its host, whatever the host's argv says", () => {
    /**
     * The module is imported by this file to reach `implausibleKeyReason`. It used to parse
     * --trials at MODULE SCOPE and call process.exit(2) on a bad value, so importing it with
     * the wrong argv killed the importer before any test ran. Verified at the time:
     * `await import(...)` never returned and the process died with exit 2.
     *
     * The entry-point guard alone did not fix it -- that stops main() from running, not the
     * constants above it. Flag parsing lives inside main() now and reports by throwing.
     *
     * Spawned rather than asserted in-process, because the failure mode IS process death:
     * an in-process check would take the suite down with it instead of reporting.
     */
    const script = [
      'process.argv = [process.argv[0], "vitest", "--trials", "not-a-number"];',
      'await import(' + JSON.stringify(pathToFileURL(join(__dirnameShim, "../scripts/run-eval.ts")).href) + ');',
      'console.log("SURVIVED");',
    ].join("\n");
    const file = join(mkdtempSync(join(tmpdir(), "pnx-imp-")), "imp.mjs");
    writeFileSync(file, script);
    const out = execFileSync(process.execPath, [join(__dirnameShim, "../node_modules/tsx/dist/cli.mjs"), file], {
      cwd: join(__dirnameShim, ".."), encoding: "utf8",
    });
    expect(out).toContain("SURVIVED");
  });

  it("never returns the key itself", () => {
    // The reason is printed to a terminal. A message that quoted the value would be the
    // one careless log line this script's whole key discipline exists to prevent.
    const secretish = "sk-ant-api03-DEADBEEF-not-a-real-key-but-long-enough-to-pass";
    for (const k of [secretish, "<your key>", "short"]) {
      expect(implausibleKeyReason(k) ?? "").not.toContain(k);
    }
  });
});

/**
 * Repository hygiene: the shape of the repository rather than its content.
 *
 * This checker exists because `.gitignore` was emptied three times by automated commits and
 * found three times by hand. The must-fire cases below are each one of those incidents,
 * reduced to a fixture — and the reason they are here at all is that a checker with only a
 * must-not-fire case is indistinguishable from a checker that never fires, which is precisely
 * how the previous three went unnoticed.
 *
 * `listTracked` and `sizeOf` are injected so a fixture needs neither a git repository nor a
 * four-megabyte file on disk. The last case runs the real thing against the real repository,
 * so the git path is exercised for real at least once.
 */
describe("check-repo-hygiene", () => {
  const GOOD_RULES = [
    "node_modules/", "dist/", "*.zip", ".nexusprompt/", ".promptnexus/", "PDF/",
    "Nexus-Prompt/", "Prompt-Nexus/", "promptnexus-v5/", "PromptNexus-6.2/",
    "System-Prompt-Builder-final-*/", "promptnexus5/", "synth/",
    "system-prompt-builder-diff-fix/", "systempromptbuilder/", "promptnexus-ci/",
    "promptnexus-v6-benchmark/", "LLM/", "final_bundle_*/", "shells/*/dist/",
    ".env", ".env.*", "*.log",
  ];

  const plant = (rules: string[] = GOOD_RULES, body = "# a comment\n\n") => {
    const root = mkroot("hygiene-");
    writeFileSync(join(root, ".gitignore"), body + rules.join("\n") + "\n");
    return root;
  };

  const clean = ["core/src/index.ts", "package.json"];
  const run = (root: string, tracked = clean, sizes: Record<string, number> = {}) =>
    checkRepoHygiene(root, {
      listTracked: () => tracked,
      sizeOf: (p: string) => sizes[p] ?? 100,
      // Fixture roots are temp directories, not repositories, and rule 7 asks git a question
      // only a repository can answer. Injected rather than swallowed inside the checker: a git
      // that cannot answer is a check that did not run, and that must fail loudly on the real
      // tree rather than report OK.
      listIgnored: () => [],
    });

  it("passes on a well-formed repository", () => {
    const r = run(plant());
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.ruleCount).toBe(GOOD_RULES.length);
  });

  it("fires when a pinned rule is dropped", () => {
    // Incident shape: a rule removed while the rest of the file survives.
    const r = run(plant(GOOD_RULES.filter((x) => x !== "PDF/")));
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/no longer carries `PDF\/`/);
  });

  it("fires when the file is truncated below the floor", () => {
    // Incident shape: 8ee5d0a, which left the file empty. The pinned set alone cannot see a
    // rule nobody thought to pin, which is why the floor is a separate check.
    const r = run(plant(["node_modules/", "PDF/", "LLM/", ".promptnexus/", ".nexusprompt/", "dist/", "*.zip"]));
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/below the floor of 20/);
  });

  it("treats a missing .gitignore as fatal, not as a failure", () => {
    const root = mkroot("hygiene-");
    const r = checkRepoHygiene(root, { listTracked: () => clean });
    expect(r.fatalCode).toBe(2);
    expect(r.fatal).toMatch(/missing entirely/);
  });

  it("fires when a vendor directory is tracked, and counts the damage", () => {
    // Incident shape: the same commit that emptied .gitignore tracked 3,677 of these.
    const tracked = [...clean, "node_modules/esbuild/bin/esbuild", "node_modules/typescript/lib/tsc.js"];
    const r = run(plant(), tracked);
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/2 tracked file\(s\) under a `node_modules` directory/);
  });

  it("fires on a vendor directory nested inside a workspace", () => {
    // The blind spot the first version shipped with. `startsWith("node_modules/")` matched
    // only the repository root, so a tracked shells/api/node_modules/... file passed while
    // the check printed "none vendored". This repo is npm workspaces; every workspace can
    // have its own node_modules, so root-only was wrong for exactly the layout it guards.
    const r = run(plant(), [...clean, "shells/api/node_modules/.vite/vitest/results.json"]);
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/tracked file\(s\) under a `node_modules` directory/);
  });

  it("does not fire on a path that merely contains the word", () => {
    // The other direction: widening a matcher is how a false positive gets shipped. A file
    // legitimately named for the concept must not be mistaken for one inside it.
    const r = run(plant(), [...clean, "docs/node_modules-policy.md", "scripts/check-node_modules.mjs"]);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fires on a vendor directory even when .gitignore is perfect", () => {
    // The two rules are deliberately redundant: an ignore rule does nothing for a path that
    // is ALREADY tracked, which is exactly the state 8ee5d0a left behind.
    const r = run(plant(), [...clean, "PDF/2301.00234.pdf"]);
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/tracked file\(s\) under a `PDF` directory/);
  });

  it("fires on an oversized tracked file under a name nobody pinned", () => {
    const r = run(plant(), [...clean, "assets/model.bin"], { "assets/model.bin": 9 * 1024 * 1024 });
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/`assets\/model\.bin` is 9\.0 MB/);
  });

  it("does not fire just below the size bound", () => {
    // Without this the size rule could be satisfied by firing on everything.
    const r = run(plant(), [...clean, "core/src/catalog/techniques.json"], {
      "core/src/catalog/techniques.json": 4 * 1024 * 1024,
    });
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fires on a tracked JSON file that does not parse", () => {
    // Incident shape: 2ba1b32 truncated package-lock.json and shells/api/package.json
    // mid-file. `npm ci` refused, CI could not install, and nothing local noticed because
    // `npm install` repairs quietly.
    const root = plant();
    writeFileSync(join(root, "broken.json"), ['{ "a": 1,', "  }", "},"].join("\n"));
    const r = run(root, [...clean, "broken.json"]);
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/`broken\.json` is not valid JSON/);
  });

  it("exempts files that are JSONC on purpose", () => {
    // tsconfig.json carries comments and is read by a parser that accepts them. Without the
    // exemption this rule would fire on every checkout, which is how a check gets ignored.
    const root = plant();
    writeFileSync(
      join(root, "tsconfig.json"),
      ["{", "  /* a comment */", '  "compilerOptions": {}', "}"].join("\n"),
    );
    const r = run(root, [...clean, "tsconfig.json"]);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fires when a source directory is ignored", () => {
    // Incident 587c814, "configure AO workspace ignores": /core/, /contracts/, /scripts/,
    // /test/, /spec/, /sources/, /Documentation/, /.github/ and more were added to the ignore
    // file. Tracked files stayed tracked so verify passed and nothing was deleted; what broke
    // was `git add` of any NEW file. check:hygiene reported OK, because every rule it had
    // asked what should be ignored and none asked what must not be.
    const r = checkRepoHygiene(__dirnameShim + "/..", {
      listTracked: () => ["core/src/index.ts"],
      isIgnored: () => true,
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/path\(s\) the project is MADE OF are ignored/);
  });

  it("does not fire when nothing required is ignored", () => {
    // The must-not-fire half: a rule that always reported would be satisfied by ignoring
    // everything, which is the state it exists to detect.
    const r = checkRepoHygiene(__dirnameShim + "/..", {
      listTracked: () => ["core/src/index.ts"],
      isIgnored: () => false,
    });
    expect(r.failures.filter((f) => /MADE OF/.test(f))).toEqual([]);
  });

  it("fires when a TRACKED file is ignored", () => {
    // Incident #38: `.gitignore` was replaced with boilerplate that added `build-hash.json` —
    // a tracked file the artifact-hash check reads. Rule 6 walked past it, because its
    // NEVER_IGNORED list is hand-picked and nobody had thought to name that file. Rule 7 asks
    // the index instead of a list, so it cannot be sparse.
    const r = checkRepoHygiene(__dirnameShim + "/..", {
      listTracked: () => ["build-hash.json", "core/src/index.ts"],
      isIgnored: () => false,
      listIgnored: () => ["build-hash.json"],
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/TRACKED file\(s\) are also ignored/);
  });

  /**
   * Rule 8: the state between rules 1–2 and rules 6–7.
   *
   * Rules 1 and 2 check that expensive things ARE ignored. Rules 6 and 7 check that nothing
   * the project is made of IS ignored. Neither covers a directory that is NEITHER — which is
   * the state every incident here actually began from, because that is what `git add -A`
   * sweeps in. It was measured at 2,022 MB across six entries when this rule was written.
   *
   * `listUntracked` is injected for the same reason `listTracked` is: a fixture needs neither
   * a git repository nor gigabytes on disk.
   */
  it("fires when something large sits neither tracked nor ignored", () => {
    const root = mkroot("pnx-untracked-");
    mkdirSync(join(root, "Articles"), { recursive: true });
    // 30 MB in one file, over the 25 MB ceiling.
    writeFileSync(join(root, "Articles", "paper.pdf"), Buffer.alloc(30 * 1024 * 1024));
    writeFileSync(join(root, ".gitignore"), readFileSync(join(__dirnameShim, "..", ".gitignore"), "utf8"));

    const r = checkRepoHygiene(root, {
      listTracked: () => ["core/src/index.ts"],
      // Rules 6 and 7 shell out to git; a fixture root is not a repository. Injected so this
      // case exercises rule 8 alone.
      isIgnored: () => false,
      listIgnored: () => [],
      listUntracked: () => ["Articles/"],
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/neither tracked nor ignored/);
    expect(r.failures.join("\n")).toMatch(/git add -A/);
  });

  it("fires on many small files even when the bytes are trivial", () => {
    // The hazard has two shapes. The 3,677-dependency-file incident was not about size —
    // a ceiling on bytes alone would have walked straight past it.
    const root = mkroot("pnx-untracked-many-");
    mkdirSync(join(root, "junk"), { recursive: true });
    for (let i = 0; i < 600; i++) writeFileSync(join(root, "junk", `f${i}.txt`), "x");
    writeFileSync(join(root, ".gitignore"), readFileSync(join(__dirnameShim, "..", ".gitignore"), "utf8"));

    const r = checkRepoHygiene(root, {
      listTracked: () => ["core/src/index.ts"],
      // Rules 6 and 7 shell out to git; a fixture root is not a repository. Injected so this
      // case exercises rule 8 alone.
      isIgnored: () => false,
      listIgnored: () => [],
      listUntracked: () => ["junk/"],
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toMatch(/neither tracked nor ignored/);
  });

  it("does not fire on a small amount of untracked scratch", () => {
    // The must-not-fire half. A rule that fired on any untracked file at all would be
    // deleted by whoever it first inconvenienced — an editor swapfile is not an incident.
    const root = mkroot("pnx-untracked-ok-");
    writeFileSync(join(root, "scratch.txt"), "a note to self");
    writeFileSync(join(root, ".gitignore"), readFileSync(join(__dirnameShim, "..", ".gitignore"), "utf8"));

    const r = checkRepoHygiene(root, {
      listTracked: () => ["core/src/index.ts"],
      // Rules 6 and 7 shell out to git; a fixture root is not a repository. Injected so this
      // case exercises rule 8 alone.
      isIgnored: () => false,
      listIgnored: () => [],
      listUntracked: () => ["scratch.txt"],
    });
    expect(r.failures.filter((f) => /neither tracked nor ignored/.test(f))).toEqual([]);
  });

  it("does not fire on this repository — the state Wave A left it in", () => {
    // Regression guard for the cleanup itself. If loose archives accumulate again, this is
    // the test that says so before anyone runs the wrong git command.
    const r = checkRepoHygiene(__dirnameShim + "/..");
    expect(r.failures.filter((f) => /neither tracked nor ignored/.test(f))).toEqual([]);
  });

  it("does not fire when no tracked file is ignored", () => {
    // The must-not-fire half. Without it, a rule 7 that always reported would satisfy the
    // case above while saying nothing — the shape eight of eleven sweeps here started with.
    const r = checkRepoHygiene(__dirnameShim + "/..", {
      listTracked: () => ["core/src/index.ts"],
      isIgnored: () => false,
      listIgnored: () => [],
    });
    expect(r.failures.filter((f) => /TRACKED file\(s\) are also ignored/.test(f))).toEqual([]);
  });

  it("rule 7 is derived from the index, not from the sentinel list", () => {
    // The distinction that motivated it: a path NOT in NEVER_IGNORED must still be caught.
    // If this passes only because the path happens to be a sentinel, the rule adds nothing.
    expect(NEVER_IGNORED).not.toContain("build-hash.json");
    const r = checkRepoHygiene(__dirnameShim + "/..", {
      listTracked: () => ["build-hash.json"],
      isIgnored: () => false, // rule 6 sees nothing
      listIgnored: () => ["build-hash.json"],
    });
    expect(r.failures.filter((f) => /MADE OF/.test(f))).toEqual([]); // rule 6 silent
    expect(r.failures.filter((f) => /TRACKED file/.test(f))).toHaveLength(1); // rule 7 speaks
  });

  it("the real repository has no tracked file that is ignored", () => {
    // This found nine: `promptnexus-v5/` was written for a loose archive extraction and matches
    // at ANY depth, so it also matched `sources/v5/promptnexus-v5/` — frozen, SHA-256-pinned
    // files, ignored. Tracked, so verify:sources passed and nothing looked wrong. The
    // extraction rules are anchored with a leading `/` now. If this fails, a rule has been
    // written unanchored again; anchor it rather than deleting this test.
    const root = __dirnameShim + "/..";
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\n").filter(Boolean);
    expect(tracked.length).toBeGreaterThan(100);
    let ignored: string[] = [];
    try {
      const out = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
        cwd: root, input: tracked.join("\n"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      });
      ignored = out.split("\n").filter(Boolean);
    } catch (err) {
      if ((err as { status?: number }).status !== 1) throw err; // 1 = nothing matched
    }
    expect(ignored).toEqual([]);
  });

  it("passes on the real repository, reading the real index", () => {
    // The one case that exercises `git ls-files`. If this fails, the repository itself is in
    // the state this checker was written for — read the failure, do not weaken the check.
    const r = checkRepoHygiene(__dirnameShim + "/..");
    expect(r.failures ?? []).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

/**
 * Every `--project` a script names is a project that exists.
 *
 * `npm run test:api` ran `vitest run --project api` and failed with "No projects matched the
 * filter" from the moment the duplicate `api` project was removed — the project went, the
 * script did not. It stayed broken because nothing looks at it: `verify` runs `npm test`,
 * which has no filter, so a filtered script can rot indefinitely while every check is green.
 *
 * That is the same shape as every other defect this suite guards: a claim with no checker.
 * The scripts table is a claim about what a contributor can run.
 */
describe("package.json --project filters", () => {
  const root = __dirnameShim + "/..";

  /**
   * Read from the config source rather than from a hand-kept list, so adding a project makes
   * this pass and removing one makes it fail. A regex over `name:` inside the projects array
   * is enough here and its weakness is worth stating: it would miss a name built at runtime.
   * None is, and the assertion below fails loudly if that ever stops being true.
   */
  const declaredProjects = (): string[] => {
    const cfg = readFileSync(join(root, "vitest.config.ts"), "utf8");
    return [...cfg.matchAll(/\bname:\s*"([^"]+)"/g)].map((m) => m[1]);
  };

  const filteredScripts = (): Array<[string, string]> => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return Object.entries(pkg.scripts as Record<string, string>)
      .flatMap(([name, body]) =>
        [...body.matchAll(/--project[= ]([\w.-]+)/g)].map((m) => [name, m[1]] as [string, string]));
  };

  it("the reader finds the projects that exist — otherwise the check below is vacuous", () => {
    // Without this, a regex that matched nothing would make every filter "valid".
    expect(declaredProjects().sort()).toEqual(["adapters", "application", "contracts", "core", "shells"]);
    expect(filteredScripts().length).toBeGreaterThan(0);
  });

  it("every --project names a project vitest.config.ts defines", () => {
    const projects = new Set(declaredProjects());
    const broken = filteredScripts().filter(([, project]) => !projects.has(project));
    expect(broken).toEqual([]);
  });

  it("catches a filter naming a project that does not exist", () => {
    // The planted defect, in the exact shape that shipped: `--project api` with no `api`.
    const projects = new Set(declaredProjects());
    expect(projects.has("api")).toBe(false);
    const planted: Array<[string, string]> = [["test:api", "api"], ["test:core", "core"]];
    expect(planted.filter(([, p]) => !projects.has(p))).toEqual([["test:api", "api"]]);
  });
});
