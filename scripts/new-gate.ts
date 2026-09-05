#!/usr/bin/env tsx
/**
 * Scaffold a new gate implementation and its test stub.
 *
 * Usage: tsx scripts/new-gate.ts MY_GATE_ID
 *        npm run scaffold:gate -- MY_GATE_ID
 *
 * Creates:
 *   core/src/gates/<kebab>.ts   — gate implementation stub
 *   core/test/<kebab>.test.ts   — Vitest test stub
 *
 * After creation, follow the printed next steps.
 */

import { writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function toKebab(id: string): string {
  return id.toLowerCase().replace(/_/g, "-");
}

function toCamel(id: string): string {
  return id.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

const gateId = process.argv[2];
if (!gateId) {
  console.error("Usage: tsx scripts/new-gate.ts GATE_ID");
  console.error("  e.g. tsx scripts/new-gate.ts MY_GATE");
  process.exit(1);
}

if (!/^[A-Z][A-Z0-9_]*$/.test(gateId)) {
  console.error(`GATE_ID must be SCREAMING_SNAKE_CASE (e.g. MY_GATE), got: ${gateId}`);
  process.exit(1);
}

const kebab = toKebab(gateId);
const camel = toCamel(gateId);
// Registry import alias uses the same naming pattern as existing gates
const idAlias = `${gateId}_ID`;
const vAlias = `${gateId}_V`;

const gateFile = resolve(ROOT, `core/src/gates/${kebab}.ts`);
const testFile = resolve(ROOT, `core/test/${kebab}.test.ts`);

if (existsSync(gateFile)) {
  console.error(`Already exists: core/src/gates/${kebab}.ts`);
  process.exit(1);
}
if (existsSync(testFile)) {
  console.error(`Already exists: core/test/${kebab}.test.ts`);
  process.exit(1);
}

const gateSource = `import type { GateResult } from "../../../contracts/index.js";
import { result, sha256 } from "./lint-primitives.js";

export const GATE_ID = "${gateId}";
export const GATE_VERSION = "0.1.0";

export function ${camel}(text: string, options?: { includeFences?: boolean }): GateResult {
  void options;
  const hash = sha256(text);

  // TODO: implement gate logic.
  // Return result(GATE_ID, GATE_VERSION, hash, "PASS", []) for clean text.
  // Return result(GATE_ID, GATE_VERSION, hash, "WARN", [finding]) when issues are found.
  // Use "FAIL" only for structural violations that make a prompt unsafe to ship.

  return result(GATE_ID, GATE_VERSION, hash, "PASS", []);
}
`;

const testSource = `import { describe, it, expect } from "vitest";
import { ${camel}, GATE_ID } from "../src/gates/${kebab}.js";

describe("${gateId}", () => {
  it("returns PASS for an empty prompt", () => {
    const r = ${camel}("");
    expect(r.verdict).toBe("PASS");
    expect(r.gate_id).toBe(GATE_ID);
    expect(r.version).toBe("0.1.0");
  });

  // TODO: add fixture-parity tests once gate logic is implemented.
  // Pattern: read sources/v5/fixtures.json, find the cases that exercise this
  // gate by their "name" field, and assert that ${camel}(text, options).verdict
  // matches the expected verdict from c.expect.findings.
});
`;

writeFileSync(gateFile, gateSource, "utf8");
writeFileSync(testFile, testSource, "utf8");

console.log(`Created: core/src/gates/${kebab}.ts`);
console.log(`Created: core/test/${kebab}.test.ts`);
console.log();
console.log("Next steps:");
console.log(`  1. Implement gate logic in core/src/gates/${kebab}.ts`);
console.log(`  2. Register in core/src/gates/registry.ts:`);
console.log(`       import { ${camel}, GATE_ID as ${idAlias}, GATE_VERSION as ${vAlias} } from "./${kebab}.js";`);
console.log(`       Add to GATES: { id: ${idAlias}, version: ${vAlias}, run: (t, o) => ${camel}(t, o) }`);
console.log(`  3. If porting from the source linter, add an entry to scripts/ported-gates.json`);
console.log(`     and update SOURCE_GATE_COUNT in registry.ts if it changes`);
console.log(`  4. Add fixture-parity tests in core/test/${kebab}.test.ts`);
console.log(`  5. npm run verify`);
