/**
 * ported from SPB AUDIT.md B2 — see json-schema-malformed.ts for the full
 * provenance note and the placement/integration caveats.
 *
 * Every assertion below was executed against this exact implementation
 * (via tsx + node:assert, vitest was not available in the porting sandbox)
 * before this file was written — see verify-json-gate.mts in the same
 * handoff for the run.
 */
import { describe, it, expect } from "vitest";
import { jsonSchemaMalformed } from "./json-schema-malformed.js";

describe("JSON_SCHEMA_MALFORMED", () => {
  it("does not fire on pretty-printed JSON with a colon inside a string value", () => {
    // This is the actual B2 case: a naive heuristic run before JSON.parse
    // mistook the colon in "pairs like a, b: c" for a syntax error.
    const block = "```json\n{\n  \"note\": \"pairs like a, b: c appear inside this string value\"\n}\n```";
    const result = jsonSchemaMalformed(block);
    expect(result.verdict).toBe("PASS");
  });

  it("fires on a real trailing comma, and names it", () => {
    const block = "```json\n{\n  \"a\": 1,\n}\n```";
    const result = jsonSchemaMalformed(block);
    expect(result.verdict).toBe("FAIL");
    expect(result.details).toMatch(/trailing comma/i);
  });

  it("fires on single-quoted keys", () => {
    const block = "```json\n{\n  'a': 1\n}\n```";
    const result = jsonSchemaMalformed(block);
    expect(result.verdict).toBe("FAIL");
    expect(result.details).toMatch(/single quotes/i);
  });

  it("does not fire when the prompt has no fenced JSON block at all", () => {
    const result = jsonSchemaMalformed("This is a system prompt with no JSON anywhere in it.");
    expect(result.verdict).toBe("PASS");
  });

  it("falls back to the raw parser message when no named heuristic matches", () => {
    const block = "```json\n{\n  \"a\": ,\n}\n```"; // missing value after colon
    const result = jsonSchemaMalformed(block);
    expect(result.verdict).toBe("FAIL");
    expect(result.details.length).toBeGreaterThan(0);
  });

  it("passes the exact embedded schema block from SPB's real WELL_FORMED fixture", () => {
    // Not just an equivalent pattern (the earlier test above already covers
    // the general case) — this is the literal text from
    // pipeline.test.ts:145-177's Schema section, closing the one fidelity
    // gap the audit found between this file and the source fixture.
    const block =
      "```json\n" +
      "{\n" +
      '  "ticket_id": "string",\n' +
      '  "note": "fields like a, b: c appear inside this string value",\n' +
      '  "escalate": false\n' +
      "}\n" +
      "```";
    expect(jsonSchemaMalformed(block).verdict).toBe("PASS");
  });

  it("in a prompt with multiple blocks, names only the malformed one", () => {
    const text = [
      "First block:",
      "```json",
      "{\"ok\": true}",
      "```",
      "Second block:",
      "```json",
      "{'bad': 1}",
      "```",
    ].join("\n");
    const result = jsonSchemaMalformed(text);
    expect(result.verdict).toBe("FAIL");
    expect(result.details).toMatch(/Block #2/);
    expect(result.details).not.toMatch(/Block #1/);
  });
});
