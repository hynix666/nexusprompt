#!/usr/bin/env tsx
import { writeFileSync, readFileSync } from "node:fs";
import { runtimeKeyUndeclared } from "../core/src/gates/placeholder-audit.js";
import { extractRuntimeManifest } from "../core/src/gates/lint-primitives.js";

const OUT = ".freebuff/fence-explanation-data.js";
const SAMPLE = [
  "```md",
  "sample",
  "```md",
  "## Runtime Variables",
  "- [[A]] = the thing",
  "```",
  "",
  "Use [[A]] now.",
].join("\n");

function classifyLines(text: string, strict: boolean) {
  let open: string | null = null;
  return text.split("\n").map((line, index) => {
    const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    let state = open ? "in" : "live";
    let note: [string, string] | null = null;
    if (match) {
      const run = match[1]!;
      const rest = match[2]!;
      if (!open) {
        open = run;
        state = "open";
      } else if (run[0] === open[0] && run.length >= open.length && (!strict || rest.trim() === "")) {
        open = null;
        state = "close";
      } else {
        state = "in";
      }
    }
    if (index === 2) {
      note = strict
        ? ["marked-good", "← content, not a close"]
        : ["marked-bad", "← wrongly closes"];
    }
    return { t: line, state, note };
  });
}

function build(strict: boolean) {
  const readerText = strict ? SAMPLE : SAMPLE.replace(/```md\n[\s\S]*?\n```\n?/, "");
  const gate = runtimeKeyUndeclared(readerText);
  const used = [...new Set([...readerText.matchAll(/\[\[([A-Za-z0-9_:-]+)\]\]/g)].map((m) => m[1]))];
  return {
    lines: classifyLines(SAMPLE, strict),
    declared: [...extractRuntimeManifest(readerText)],
    used,
    verdict: gate.verdict,
    gate_message: gate.message,
  };
}

const generated = {
  schema_version: 1,
  source: ["core/src/gates/placeholder-audit.ts", "core/src/gates/lint-primitives.ts"],
  sample: SAMPLE,
  readers: {
    old: build(false),
    new: build(true),
  },
};

const check = process.argv.includes("--check");
const output = `window.FENCE_EXPLANATION_CONTRACT = ${JSON.stringify(generated, null, 2)};\n`;
if (check) {
  const current = readFileSync(OUT, "utf8").replace(/\r\n/g, "\n");
  if (current !== output) {
    console.error(`check:fence-explanation — ${OUT} differs from the generated gate contract.`);
    process.exit(1);
  }
  console.log(`check:fence-explanation — OK. Generated from the runtime-key gate.`);
} else {
  writeFileSync(OUT, output, "utf8");
  console.log(`docs:fence-explanation — wrote ${OUT}.`);
}
