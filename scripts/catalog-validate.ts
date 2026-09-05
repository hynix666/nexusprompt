/**
 * catalog:validate — validate candidate technique records before import.
 *
 * Checks a JSON file containing a single TechniqueRecord, or a {records:[...]}
 * batch (the catalog-additions.json format), against:
 *
 *   1. The JSON schema  (contracts/technique-record.schema.json) via AJV.
 *   2. TODO-placeholder detection — any string field still beginning with "TODO"
 *      is an incomplete stub.
 *   3. Template variable coherence — every {{var}} in a template body must have
 *      a matching entry in the template's `variables` array.
 *   4. Template-id prefix — `template_id` must start with `<record.id>--`.
 *
 * These are what `import:catalog` does not check: (1) it does run the schema but
 * only at import time; (2-4) it does not check at all. `catalog:validate` is the
 * fast feedback loop for a record in progress; `import:catalog` is the batch gate.
 *
 *   npm run catalog:validate                     validate scripts/catalog-additions.json
 *   npm run catalog:validate -- path/to/f.json   validate a specific file
 *
 * Exit 0 — all records valid
 * Exit 1 — one or more records have errors
 * Exit 2 — could not read the file
 */

import { readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv } from "ajv";

const DEFAULT_FILE = "scripts/catalog-additions.json";
const SCHEMA_PATH = "contracts/technique-record.schema.json";

interface TechniqueRecord {
  id?: string;
  usage_templates?: Array<{
    template_id?: string;
    template?: string;
    variables?: Array<{ name?: string }>;
  }>;
  [key: string]: unknown;
}

/** Walk every string value in a JSON value tree; call cb(value, path). */
function walkStrings(value: unknown, path: string, cb: (v: string, p: string) => void): void {
  if (typeof value === "string") {
    cb(value, path);
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) walkStrings(value[i], `${path}[${i}]`, cb);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walkStrings(v, path ? `${path}.${k}` : k, cb);
  }
}

/** Extract all {{name}} references from a template string. */
function templateVarRefs(template: string): string[] {
  return [...template.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1].trim());
}

function validateRecord(record: TechniqueRecord, schema: object, ajv: Ajv): string[] {
  const errors: string[] = [];
  const id = record.id ?? "(unknown)";

  // 1. JSON schema.
  const validate = ajv.compile(schema);
  if (!validate(record)) {
    for (const e of validate.errors ?? []) {
      errors.push(`schema: ${e.instancePath || "(root)"} ${e.message}`);
    }
  }

  // 2. TODO-placeholder detection.
  walkStrings(record, "", (v, path) => {
    if (v.startsWith("TODO")) errors.push(`incomplete stub: ${path || "(root)"} still contains a TODO value`);
  });

  // 3 & 4. Template checks.
  for (let ti = 0; ti < (record.usage_templates ?? []).length; ti++) {
    const tpl = (record.usage_templates ?? [])[ti];
    const tpath = `usage_templates[${ti}]`;

    // 4. template_id prefix.
    if (tpl.template_id !== undefined && record.id !== undefined) {
      if (!tpl.template_id.startsWith(`${record.id}--`)) {
        errors.push(
          `template-id: ${tpath}.template_id "${tpl.template_id}" must begin with "${record.id}--"`,
        );
      }
    }

    // 3. Variable coherence.
    if (tpl.template !== undefined && !tpl.template.startsWith("TODO")) {
      const declared = new Set((tpl.variables ?? []).map((v) => v.name));
      for (const ref of templateVarRefs(tpl.template)) {
        if (!declared.has(ref)) {
          errors.push(
            `template-vars: ${tpath} references {{${ref}}} but "${ref}" is not in variables`,
          );
        }
      }
    }
  }

  return errors.map((e) => `${id}: ${e}`);
}

function main(): number {
  const arg = process.argv[2];
  const filePath = arg ?? DEFAULT_FILE;
  const root = process.cwd();
  const absFile = isAbsolute(filePath) ? filePath : join(root, filePath);
  const absSchema = join(root, SCHEMA_PATH);

  let raw: string;
  let schema: object;
  try {
    raw = readFileSync(absFile, "utf8");
    schema = JSON.parse(readFileSync(absSchema, "utf8")) as object;
  } catch (err) {
    console.error(
      `catalog:validate — could not read file: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }

  let parsed: unknown;
  try {
    // Strip a BOM: Windows editors and PowerShell's `Out-File -Encoding utf8` both add one,
    // and JSON.parse rejects it outright rather than treating it as whitespace.
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch (err) {
    console.error(
      `catalog:validate — ${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }

  // Accept either a single record or a {records: [...]} batch.
  let records: TechniqueRecord[];
  if (Array.isArray((parsed as { records?: unknown }).records)) {
    records = (parsed as { records: TechniqueRecord[] }).records;
  } else if (typeof parsed === "object" && parsed !== null && "id" in parsed) {
    records = [parsed as TechniqueRecord];
  } else {
    console.error(
      `catalog:validate — ${filePath} must be a TechniqueRecord or { records: [...] }`,
    );
    return 2;
  }

  const ajv = new Ajv({ strict: false, allErrors: true });
  const allErrors: string[] = [];
  for (const r of records) allErrors.push(...validateRecord(r, schema, ajv));

  if (allErrors.length === 0) {
    const n = records.length;
    console.log(
      `catalog:validate — OK. ${n} record${n === 1 ? "" : "s"} in ${filePath} pass all checks.`,
    );
    return 0;
  }

  console.error(`catalog:validate — ${allErrors.length} error(s) in ${filePath}:\n`);
  for (const e of allErrors) console.error(`  ${e}`);
  console.error(`\nFix the errors above, then run \`npm run import:catalog\`.`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
