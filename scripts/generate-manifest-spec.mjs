#!/usr/bin/env node
/**
 * Render `spec/manifest-shapes.json` into `Documentation/MANIFEST_SHAPES.md`.
 *
 *   node scripts/generate-manifest-spec.mjs           write
 *   node scripts/generate-manifest-spec.mjs --check   fail if the committed file differs
 *
 * The same shape as `docs:matrix`: a generated document, and a check that fails when the
 * committed copy is not what the repository produces. A document anyone can hand-edit asserts
 * whatever its last editor believed — which is precisely how the manifest rule came to be
 * stated four ways at once.
 *
 * This renders; `core/test/manifest-spec.test.ts` executes. Between them the spec cannot be
 * true in the prose and false in the suite.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SPEC = "spec/manifest-shapes.json";
const OUT = "Documentation/MANIFEST_SHAPES.md";

/** Fenced so a case's own backticks and pipes cannot break the table it sits in. */
const asBlock = (text) => text.split("\n").map((l) => `    ${l}`).join("\n");

export function render(spec) {
  const groups = [...new Set(spec.cases.map((c) => c.group))];
  const limits = spec.cases.filter((c) => c.status === "known-limit");
  const unsafe = limits.filter((c) => c.wanted === "FAIL");

  const out = [];
  out.push(`# Manifest shapes — what \`${spec.gate}\` reads`);
  out.push("");
  out.push("**Generated from `spec/manifest-shapes.json`. Do not edit.**");
  out.push("`npm run docs:manifest-spec` writes it; `npm run check:manifest-spec` fails when the");
  out.push("committed copy is not what the spec produces; `core/test/manifest-spec.test.ts` runs");
  out.push(`every case below against the real gate. See ${spec.adr}.`);
  out.push("");
  out.push(
    `${spec.cases.length} cases · ${spec.cases.length - limits.length} specified · ` +
    `${limits.length} known limit(s), of which **${unsafe.length}** in the unsafe direction.`,
  );
  out.push("");
  out.push("A *known limit* records what the gate **actually does today**, not what it should —");
  out.push("so the row is honest and the suite stays green, while `wanted` records the");
  out.push("disagreement. A limit whose `wanted` verdict starts appearing is stale and fails.");
  out.push("");
  out.push("| Verdict | Meaning |");
  out.push("|---|---|");
  out.push("| `PASS` | every `[[KEY]]` used in the body is declared |");
  out.push("| `FAIL` | at least one is not |");
  out.push("");

  for (const group of groups) {
    out.push(`## ${group}`);
    out.push("");
    for (const c of spec.cases.filter((x) => x.group === group)) {
      const tag = c.status === "known-limit" ? ` — **known limit**, wants \`${c.wanted}\`` : "";
      // Options are part of the case. Rendering the document without them would show a
      // verdict the reader cannot reproduce from the text alone.
      const opts = c.options && Object.keys(c.options).length
        ? ` — options \`${JSON.stringify(c.options)}\``
        : "";
      out.push(`### \`${c.id}\` → \`${c.expect}\`${tag}${opts}`);
      out.push("");
      out.push(c.why);
      out.push("");
      out.push(asBlock(c.text));
      out.push("");
    }
  }
  return out.join("\n");
}

function main() {
  const spec = JSON.parse(readFileSync(SPEC, "utf8"));
  const rendered = render(spec);
  const check = process.argv.includes("--check");

  if (!check) {
    writeFileSync(OUT, rendered);
    console.log(`docs:manifest-spec — wrote ${OUT} (${spec.cases.length} cases).`);
    return 0;
  }

  let committed;
  try {
    committed = readFileSync(OUT, "utf8");
  } catch {
    console.error(`check:manifest-spec — ${OUT} is missing. Run \`npm run docs:manifest-spec\`.`);
    return 1;
  }
  // Normalise line endings only. Any other difference is a real one.
  if (committed.replace(/\r\n/g, "\n") === rendered.replace(/\r\n/g, "\n")) {
    console.log(`check:manifest-spec — OK. ${OUT} is what ${SPEC} produces (${spec.cases.length} cases).`);
    return 0;
  }
  console.error(
    `check:manifest-spec — ${OUT} differs from what ${SPEC} produces.\n\n` +
    "  This file is generated. If a shape changed, run `npm run docs:manifest-spec` and commit\n" +
    "  the result. If it was edited by hand, that is the failure this check exists for: the\n" +
    "  manifest rule was stated in four places once and drifted between all of them.",
  );
  return 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  process.exit(main());
}
