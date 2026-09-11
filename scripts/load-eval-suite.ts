/**
 * One loader, three runners.
 *
 * `run-eval.ts`, `run-pipeline-eval.ts` and `run-adversarial.ts` each did a bare
 * `JSON.parse(readFileSync(...))` and trusted the result. The 2026 audit reproduced four
 * consequences: an empty suite exits 0, a declared case can be absent without failure, an
 * undeclared case can be executed, and a zero-case pipeline run prints a NaN score. A green
 * result measuring something other than what its name says is the defect this repository
 * exists to catch — the same shape as the pipeline suite that reported 5/5 through the
 * single-stage runner.
 *
 * `case_ids` is the declared population. Returning cases in its order rather than file order
 * makes execution deterministic without the caller thinking about it.
 */
import { readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsImport from "ajv-formats";
import type { EvalSuite } from "../contracts/index.js";

// ajv-formats is CommonJS with a default export; under `module: nodenext` the types and the
// runtime interop disagree and only the types are wrong. One cast at one call site.
const addFormats = addFormatsImport as unknown as (ajv: Ajv) => Ajv;

export class SuiteError extends Error {}

let validate: ValidateFunction | null = null;
const suiteValidator = (): ValidateFunction => {
  if (!validate) {
    const ajv = addFormats(new Ajv({ strict: false }));
    validate = ajv.compile(JSON.parse(readFileSync("contracts/eval-suite.schema.json", "utf8")));
  }
  return validate;
};

export function loadEvalSuite<C extends { case_id: string }>(
  path: string,
): { suite: EvalSuite; cases: C[] } {
  let raw: { suite?: unknown; cases?: unknown };
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new SuiteError(`cannot read ${path} — ${(err as Error).message}`);
  }

  const check = suiteValidator();
  if (!check(raw.suite)) {
    const first = check.errors?.[0];
    throw new SuiteError(
      `${path}: suite does not satisfy eval-suite.schema.json — ` +
        `${first?.instancePath || "/"} ${first?.message ?? "invalid"}`,
    );
  }
  const suite = raw.suite as EvalSuite;

  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new SuiteError(`${path}: holds no cases. A suite that scores nothing must not pass.`);
  }
  const cases = raw.cases as C[];

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.case_id)) duplicates.add(c.case_id);
    else seen.add(c.case_id);
  }
  if (duplicates.size > 0) {
    throw new SuiteError(`${path}: duplicate case id(s): ${[...duplicates].join(", ")}`);
  }

  const declared = new Set(suite.case_ids);
  const absent = suite.case_ids.filter((id) => !seen.has(id));
  const undeclared = [...seen].filter((id) => !declared.has(id));
  if (absent.length > 0 || undeclared.length > 0) {
    throw new SuiteError(
      `${path}: the scored population is not the declared one.` +
        (absent.length ? `\n  declared but absent: ${absent.join(", ")}` : "") +
        (undeclared.length ? `\n  present but undeclared: ${undeclared.join(", ")}` : ""),
    );
  }

  const byId = new Map(cases.map((c) => [c.case_id, c]));
  return { suite, cases: suite.case_ids.map((id) => byId.get(id)!) };
}
