import assert from "node:assert/strict";
import { jsonSchemaMalformed } from "../core/src/gates/json-schema-malformed.js";

let passed = 0;
const check = (label: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
};

// 1. Pretty-printed JSON, colon inside a string value — must NOT fire (this is the actual B2 case)
check("pretty-printed JSON with colon inside a string value passes", () => {
  const block = "```json\n{\n  \"note\": \"pairs like a, b: c appear inside this string value\"\n}\n```";
  const r = jsonSchemaMalformed(block);
  assert.equal(r.verdict, "PASS");
});

// 2. Real trailing comma — must fire, message should name it
check("trailing comma fails and is named", () => {
  const block = "```json\n{\n  \"a\": 1,\n}\n```";
  const r = jsonSchemaMalformed(block);
  assert.equal(r.verdict, "FAIL");
  assert.match(r.details, /trailing comma/i);
});

// 3. Single-quoted keys — must fire
check("single-quoted keys fail", () => {
  const block = "```json\n{\n  'a': 1\n}\n```";
  const r = jsonSchemaMalformed(block);
  assert.equal(r.verdict, "FAIL");
  assert.match(r.details, /single quotes/i);
});

// 4. No fenced JSON block at all — must NOT fire
check("prose with no fenced JSON block passes", () => {
  const r = jsonSchemaMalformed("This is a system prompt with no JSON anywhere in it.");
  assert.equal(r.verdict, "PASS");
});

// 5. Genuinely broken JSON that matches none of the three named heuristics —
//    must still fail, falling back to the raw parser message
check("unnamed breakage still fails, falls back to parser message", () => {
  const block = "```json\n{\n  \"a\": ,\n}\n```"; // missing value after colon
  const r = jsonSchemaMalformed(block);
  assert.equal(r.verdict, "FAIL");
  assert.ok(r.details.length > 0);
});

// 6. Multiple blocks: one bad, one good — only the bad one is named
check("multiple blocks: only the malformed one is named, good one is silent", () => {
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
  const r = jsonSchemaMalformed(text);
  assert.equal(r.verdict, "FAIL");
  assert.match(r.details, /Block #2/);
  assert.doesNotMatch(r.details, /Block #1/);
});

console.log(`\n${passed}/${passed} checks passed`);
