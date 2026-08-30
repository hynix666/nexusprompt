/**
 * Derive `pipelineLogic.ts` from the shipped component so the test suite
 * exercises the real source rather than a transcribed copy.
 *
 * The slice runs from the end of the imports to the start of the presentational
 * components — everything before that point is pure, framework-free logic.
 * If either anchor moves, this fails loudly instead of silently testing less.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SOURCE = "SystemPromptBuilderPipeline.tsx";
const OUT = "pipelineLogic.ts";

const START_ANCHOR = "declare global {";
const END_ANCHOR = "/* ══════════════════════════ Presentational components ══════════════════════════ */";

const src = readFileSync(SOURCE, "utf8");

const start = src.indexOf(START_ANCHOR);
const end = src.indexOf(END_ANCHOR);
if (start < 0) throw new Error(`start anchor not found: ${START_ANCHOR}`);
if (end < 0) throw new Error(`end anchor not found: ${END_ANCHOR}`);
if (end <= start) throw new Error("anchors out of order");

const body = src.slice(start, end);

const EXPORTED = [
  "TECHNIQUE_INDEX", "COMPILE_CATEGORIES", "DEFENSE_CATEGORY", "DEFENSE_EXCLUDE_SUBCATS",
  "matchTechniques", "defenseBaseline", "formatTechniqueBlock",
  "triageRouting", "matchDomainPattern", "DOMAIN_PATTERNS",
  "lintPrompt", "formatLint", "estTokens", "stripDocSpans", "extractManifest",
  "STAKES", "DEPTH_OF", "DEPTH_PLAN", "STAGE_DEPS", "descendantsOf", "contextValueForStage",
  "DEFAULT_STAGES", "stageLabel", "emptyContext", "isPromptProducing",
  "unknownTemplateVars", "fillTemplate", "TEMPLATE_VARS",
  "shortPromptHash", "promptSummary", "slugifyBrief", "escapeHtml", "redactSecrets",
  "parseRetryAfter", "parseVerdict", "sanitizeRevisionEntries", "sanitizeVaultEntries",
  "keyFingerprint", "truncateLabel", "PROVIDERS", "PROVIDER_IDS", "APP_VERSION",
  "BLUEPRINT", "COMPILER_SYSTEM", "CRITIC_SYSTEM", "QUTM_MULTIPLIER", "MAX_REVISION_HISTORY",
];

const header = `/* GENERATED — do not edit. Produced by extract-logic.mjs from ${SOURCE}. */
/* eslint-disable */
import { mockProviderResponse } from "./lib/mockProvider";
void mockProviderResponse;

`;

const footer = `\nexport {\n${EXPORTED.map((n) => `  ${n},`).join("\n")}\n};\n`;

// The slice keeps the mockProvider import (callProvider depends on it) but drops
// the React and diff imports, which only the component layer uses.
writeFileSync(OUT, header + body + footer);

const lines = (header + body + footer).split("\n").length;
console.log(`extracted ${lines} lines -> ${OUT}`);
for (const name of EXPORTED) {
  if (!new RegExp(`\\b(?:const|function|class|interface|type|let)\\s+${name}\\b`).test(body)) {
    throw new Error(`export list names "${name}" but the slice does not define it`);
  }
}
console.log(`all ${EXPORTED.length} exported symbols verified present in the slice`);
