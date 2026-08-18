/**
 * check:stages — the pipeline's stage list and templates, re-derived from the frozen source.
 *
 * Gates have an oracle: a second implementation that disagrees when a port is wrong.
 * **Stages have nothing.** A stage template is prose, so a port that quietly paraphrases
 * its source produces no test failure anywhere — the pipeline still runs, the output still
 * looks like a prompt, and the drift is invisible until someone compares by eye.
 *
 * That is not hypothetical. `core/src/stages/compile.ts` carries the comment "Prompt
 * template ported from sources/pipeline/SystemPromptBuilderPipeline.tsx (DEFAULT_STAGES,
 * s3 'Compile')" and its template is not that template — the frozen s3 opens "STEP 2 —
 * SCAFFOLDING" and threads {calibration} and {blueprint}; the port opens "STEP 3 —
 * COMPILATION" and threads neither. One stage was ported that way before anything checked.
 * Ten more are about to be.
 *
 * So this checker exists before the ports, not after:
 *
 *   1. The eleven stage ids in `contracts/index.ts` are re-derived from the frozen
 *      component's own stage array, in order. A hand-maintained list is how a nine-stage
 *      copy passes as current — and a nine-stage copy of this very file is sitting in the
 *      repository root right now, differing from the frozen one.
 *   2. DEPTH_PLAN is re-derived, and every stage it names must exist. Not every stage runs
 *      at every depth: TINY runs six of eleven.
 *   3. Every ported stage's template must match the frozen source, or be listed in
 *      `scripts/stage-template-deviations.json` with a reason — and an entry whose template
 *      now matches is stale and fails, so the exemption cannot outlive the deviation.
 *
 * Exit 0 consistent · 1 a claim is false · 2 a source cannot be read.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const FROZEN = "sources/pipeline/SystemPromptBuilderPipeline.tsx";
const CONTRACT = "contracts/index.ts";
const STAGE_DIR = "core/src/stages";
const DEVIATIONS = "scripts/stage-template-deviations.json";

const readText = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** Stage name to contract id: "Cost Estimate" -> "cost_estimate". */
const toStageId = (name) => name.trim().toLowerCase().replace(/\s+/g, "_");

/**
 * Pull `id`, `name`, `role` and the backtick template out of the frozen component.
 *
 * Templates are backtick literals containing `{slot}` placeholders and no nested
 * backticks, so a non-greedy scan to the next unescaped backtick is sufficient here. If a
 * template ever contains one, this returns a short template and the comparison fails
 * loudly rather than silently matching — the safe direction.
 */
function extractFrozenStages(src) {
  const stages = [];
  const head = /id:\s*"(s\d+)",\s*name:\s*"([^"]+)",\s*role:\s*"([^"]+)"/g;
  for (const m of src.matchAll(head)) {
    const after = src.slice(m.index + m[0].length);
    const t = after.match(/template:\s*\n?\s*`([\s\S]*?)`/);
    stages.push({ s: m[1], name: m[2], role: m[3], template: t ? t[1] : "" });
  }
  return stages;
}

/** Trailing whitespace and final newlines are not meaning. Everything else is. */
const normalize = (s) => s.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").trim();

export function checkStages(root = process.cwd()) {
  const at = (p) => join(root, p);
  const fail = (code, message) => ({ ok: false, fatalCode: code, fatal: message, problems: [] });
  const problems = [];

  let frozen, contract;
  try {
    frozen = readText(at(FROZEN));
  } catch {
    return fail(2, `cannot read ${FROZEN}. The frozen pipeline component is the authority for the stage list.`);
  }
  try {
    contract = readText(at(CONTRACT));
  } catch {
    return fail(2, `cannot read ${CONTRACT}`);
  }

  const frozenStages = extractFrozenStages(frozen);
  if (frozenStages.length === 0) return fail(2, `no stage definitions found in ${FROZEN}`);

  const derived = frozenStages.map((s) => toStageId(s.name));
  const declared = (contract.match(/export const STAGE_IDS = \[([\s\S]*?)\] as const;/)?.[1] ?? "")
    .match(/"([a-z_]+)"/g)?.map((q) => q.slice(1, -1)) ?? [];

  if (declared.length === 0) return fail(2, `no STAGE_IDS found in ${CONTRACT}`);

  if (declared.join(",") !== derived.join(",")) {
    problems.push({
      kind: "stage-list-drift",
      detail: `STAGE_IDS does not match the frozen component.\n` +
              `    frozen  (${derived.length}): ${derived.join(", ")}\n` +
              `    declared(${declared.length}): ${declared.join(", ")}`,
    });
  }

  // DEPTH_PLAN — every stage it names must exist, and the deepest plan must reach them all.
  const dp = frozen.match(/const DEPTH_PLAN = \{([\s\S]*?)\};/)?.[1];
  const depths = {};
  if (!dp) {
    problems.push({ kind: "depth-plan-missing", detail: `no DEPTH_PLAN found in ${FROZEN}` });
  } else {
    for (const line of dp.split("\n")) {
      const m = line.match(/(\w[\w-]*)\s*:\s*\[([^\]]*)\]/);
      if (!m) continue;
      depths[m[1]] = (m[2].match(/"(s\d+)"/g) ?? []).map((q) => q.slice(1, -1));
    }
    const known = new Set(frozenStages.map((s) => s.s));
    for (const [depth, ids] of Object.entries(depths)) {
      const unknown = ids.filter((i) => !known.has(i));
      if (unknown.length) {
        problems.push({ kind: "depth-plan-unknown-stage", detail: `${depth} names ${unknown.join(", ")}, which no stage defines` });
      }
    }
    const deepest = Math.max(0, ...Object.values(depths).map((v) => v.length));
    if (deepest !== frozenStages.length) {
      problems.push({
        kind: "depth-plan-incomplete",
        detail: `the deepest plan runs ${deepest} stages but ${frozenStages.length} are defined — ` +
                `a stage no depth ever runs is dead weight, or the plan is stale`,
      });
    }
  }

  // Ported templates must match their frozen source, or be declared.
  let deviations = [];
  try {
    deviations = JSON.parse(readText(at(DEVIATIONS))).deviations ?? [];
  } catch {
    deviations = [];
  }
  const declaredFor = new Map(deviations.map((d) => [d.stage, d]));
  const matched = new Set();

  const byStageId = new Map(frozenStages.map((s) => [toStageId(s.name), s]));
  const ported = existsSync(at(STAGE_DIR))
    ? readdirSync(at(STAGE_DIR)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    : [];

  for (const file of ported) {
    const text = readText(at(join(STAGE_DIR, file)));
    const stageId = text.match(/export const STAGE_ID = "([a-z_]+)"/)?.[1];
    if (!stageId) continue;
    const source = byStageId.get(stageId);
    if (!source) {
      problems.push({ kind: "unknown-stage", detail: `${file} declares STAGE_ID "${stageId}", which the frozen component does not define` });
      continue;
    }
    const portedTemplate = text.match(/const TEMPLATE = `([\s\S]*?)`;/)?.[1];
    if (portedTemplate === undefined) continue; // deterministic stages have no template

    const same = normalize(portedTemplate) === normalize(source.template);
    const entry = declaredFor.get(stageId);
    if (same && entry) {
      matched.add(stageId);
      problems.push({
        kind: "stale-deviation",
        detail: `${DEVIATIONS} records a deviation for "${stageId}", but its template now matches the frozen source — delete the entry`,
      });
    } else if (same) {
      matched.add(stageId);
    } else if (!entry) {
      problems.push({
        kind: "template-drift",
        detail: `${file} template does not match frozen ${source.s} "${source.name}".\n` +
                `    frozen  starts: ${JSON.stringify(normalize(source.template).slice(0, 72))}\n` +
                `    ported  starts: ${JSON.stringify(normalize(portedTemplate).slice(0, 72))}\n` +
                `    Either port it faithfully, or record why not in ${DEVIATIONS}.`,
      });
    } else if (!entry.reason?.trim()) {
      problems.push({ kind: "deviation-without-reason", detail: `${DEVIATIONS} exempts "${stageId}" with no stated reason` });
    } else {
      /**
       * The deviation pins the ported template, not merely the fact of deviating.
       *
       * Without this an entry excuses the stage ENTIRELY: once "compile" is listed, any
       * template at all passes, and the port could drift arbitrarily far from both the
       * source and the thing that was actually reviewed. A probe caught exactly that —
       * the template was rewritten wholesale and the checker stayed green. Same lesson as
       * the divergence allowlist pinning both verdicts: an exemption that does not name
       * what it is excusing excuses everything.
       */
      const actual = createHash("sha256").update(normalize(portedTemplate), "utf8").digest("hex");
      if (!entry.ported_sha256) {
        problems.push({
          kind: "deviation-without-pinned-template",
          detail: `${DEVIATIONS} exempts "${stageId}" but pins no ported_sha256. Add "${actual}".`,
        });
      } else if (entry.ported_sha256 !== actual) {
        problems.push({
          kind: "deviation-template-changed",
          detail: `"${stageId}" template changed since its deviation was recorded.\n` +
                  `    pinned: ${entry.ported_sha256}\n    actual: ${actual}\n` +
                  `    The deviation covered a specific text. A different one is a new decision.`,
        });
      } else {
        matched.add(stageId);
      }
    }
  }

  for (const d of deviations) {
    if (!byStageId.has(d.stage)) {
      problems.push({ kind: "deviation-unknown-stage", detail: `${DEVIATIONS} names "${d.stage}", which the frozen component does not define` });
    } else if (!ported.some((f) => readText(at(join(STAGE_DIR, f))).includes(`STAGE_ID = "${d.stage}"`))) {
      problems.push({ kind: "deviation-unported-stage", detail: `${DEVIATIONS} exempts "${d.stage}", which is not ported yet — nothing to deviate from` });
    }
  }

  return {
    ok: problems.length === 0,
    fatalCode: null, fatal: null, problems,
    stages: frozenStages.length,
     portedCount: ported.length,
    depths,
    frozenHash: createHash("sha256").update(readFileSync(at(FROZEN))).digest("hex").slice(0, 12),
    deviations: deviations.length,
  };
}

function main() {
  const r = checkStages();
  if (r.fatal) {
    console.error(`check:stages: ${r.fatal}`);
    return r.fatalCode;
  }
  if (r.ok) {
    const plan = Object.entries(r.depths).map(([d, ids]) => `${d} ${ids.length}`).join(" · ");
    console.log(`check:stages — OK. ${r.stages} stages derived from the frozen component (${r.frozenHash}),`);
    console.log(`  STAGE_IDS matches in order; depth plans: ${plan};`);
    console.log(`  ${r.portedCount} stage module(s) ported, ${r.deviations} declared template deviation(s).`);
    return 0;
  }
  console.error(`check:stages — ${r.problems.length} problem(s):\n`);
  for (const p of r.problems) console.error(`  [${p.kind}] ${p.detail}`);
  console.error(`\nStages have no differential oracle. This check is the only thing standing`);
  console.error(`between a paraphrased template and a pipeline that silently is not its source.`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
