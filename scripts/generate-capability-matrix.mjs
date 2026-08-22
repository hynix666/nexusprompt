/**
 * Generate `Documentation/CAPABILITY_MATRIX.md` from the repository.
 *
 * ## Why this file is generated rather than written
 *
 * `CAPABILITY_MATRIX.md` has carried a banner since it was created saying that nothing on the
 * page is evidence, because the generator did not exist and the rows were written by hand.
 * That banner was the honest thing to do and it does not scale: every one of the four source
 * artifacts this repository inherited had a document describing capabilities that drifted out
 * of sync with the code — v5's "10 of 89 techniques verifiable" being the one with a number
 * on it.
 *
 * The Part 8 threat model names this exactly: *a promotion generator becomes a rubber stamp
 * if the matrix it writes can be edited by hand.* So this ships with `--check`, the same way
 * `import:catalog` does, and `verify` runs the checking form. The committed file must be what
 * the repository currently produces, or the build fails.
 *
 * ## What is derived, and what is deliberately not claimed
 *
 * Everything here comes from reading the tree:
 *
 *  - **Contracts and versions** — `contracts/*.schema.json`, version parsed from `$id`.
 *  - **Validated** — whether `test/contract-conformance.test.ts` exercises that schema's
 *    validator. That is the same signal the coverage test enforces, so the matrix and the
 *    test cannot disagree about what is covered.
 *  - **Pending** — `contracts/pending-implementation.json`.
 *  - **Adapters** — directories under `adapters/` with a `package.json`.
 *  - **Evidence** — records actually present in the evidence plane.
 *
 * `Producers` and `Consumers` are NOT derived. Establishing which module emits a contract
 * needs either a registration record that nothing writes or a type-level analysis that would
 * be wrong the first time someone re-exported something. Rather than derive them badly, the
 * matrix omits the columns and says so. A generated table with two honest columns is worth
 * more than five where three are guesses — and it was exactly a producers/adapters conflation
 * that this document got wrong in its first draft.
 *
 *   node scripts/generate-capability-matrix.mjs           # write
 *   node scripts/generate-capability-matrix.mjs --check    # verify the committed file
 *
 * Exit 0 in sync · 1 the committed file differs · 2 inputs unreadable.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MATRIX = join("Documentation", "CAPABILITY_MATRIX.md");
const CONFORMANCE = join("test", "contract-conformance.test.ts");
const EVIDENCE_ROOT = join(".promptnexus", "evidence");

const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/**
 * Read the repository. `root` is a parameter so the generator can be exercised against a
 * fixture tree: with every schema on disk currently covered, a real-repo test cannot tell a
 * derived `validated` from a hard-coded `true`. That uniformity is what let a mutation of
 * exactly that kind survive a probe here.
 */
export function collect(root = ".") {
  const schemas = readdirSync(join(root, "contracts"))
    .filter((f) => f.endsWith(".schema.json"))
    .sort()
    .map((f) => {
      const name = f.replace(".schema.json", "");
      const body = readJson(join(root, "contracts", f));
      const version = String(body.$id ?? "").split("/").pop() ?? "?";
      return { name, version, title: body.title ?? name };
    });

  const conformance = read(join(root, CONFORMANCE));
  const pending = new Set(readJson(join(root, "contracts", "pending-implementation.json")).pending.map((p) => p.schema));

  const adapters = readdirSync(join(root, "adapters"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, "adapters", d.name, "package.json")))
    .map((d) => d.name)
    .sort();

  // Written as a literal rather than accumulated in a loop so the shape is a type callers
  // can rely on. A loop over a bare `{}` infers `{}`, and the test that reads
  // `evidence.promotion` then has nothing to check the name against — which is how a typo in
  // a key becomes a silent zero.
  const countIn = (kind) => {
    const dir = join(root, EVIDENCE_ROOT, kind);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0;
  };
  const evidence = {
    "eval-run": countIn("eval-run"),
    comparison: countIn("comparison"),
    baseline: countIn("baseline"),
    promotion: countIn("promotion"),
  };

  return {
    schemas: schemas.map((s) => ({
      ...s,
      // A schema is covered when the conformance suite actually compiles and uses its
      // validator. Reading the test rather than a list means the matrix cannot claim
      // coverage the suite does not provide.
      validated: conformance.includes(`validators["${s.name}"]`),
      pending: pending.has(s.name),
    })),
    adapters,
    evidence,
  };
}

export function render(state) {
  const { schemas, adapters, evidence } = state;
  const covered = schemas.filter((s) => s.validated).length;
  const status = (s) =>
    s.validated ? "validated" : s.pending ? "pending — declared, no producer" : "**UNCOVERED**";

  const lines = [
    "# Capability Matrix",
    "",
    "<!-- GENERATED FILE — do not edit by hand.",
    "     Produced by `npm run docs:matrix`; `npm run docs:matrix -- --check` fails the build",
    "     when this file differs from what the repository currently produces. -->",
    "",
    "Generated from the repository by `scripts/generate-capability-matrix.mjs`. Every number",
    "below is read from the tree at generation time; none is asserted by hand. This file was",
    "hand-written until 22 August 2026 and carried a banner saying so, because the generator",
    "named in `IMPLEMENTATION_PLAN.md` did not exist.",
    "",
    "## Contracts",
    "",
    "`Validated` means `test/contract-conformance.test.ts` compiles that schema's validator and",
    "checks a value the running system produced against it — the same signal the coverage test",
    "enforces, so this table and that test cannot disagree.",
    "",
    "| Contract | Version | Status |",
    "|---|---|---|",
    ...schemas.map((s) => `| \`${s.name}\` | ${s.version} | ${status(s)} |`),
    "",
    `**${covered} of ${schemas.length}** schemas are validated against a value the system produced.`,
    "",
    "### Columns this table does not have",
    "",
    "`Producers` and `Consumers` were columns in the hand-written version and are absent here.",
    "Deriving them needs a `CapabilityRegistration` record that nothing writes, and guessing",
    "them from imports would be wrong the first time something was re-exported. The hand-written",
    "draft got exactly this wrong — it listed pure Core modules under \"Implementing Adapters\"",
    "— which is the argument for omitting a column rather than filling it approximately.",
    "",
    "## Adapters",
    "",
    "Ports have swappable implementations; this is what is present in the tree.",
    "",
    ...adapters.map((a) => `- \`adapters/${a}\``),
    "",
    "## Evidence plane",
    "",
    "What the system has actually retained. These are counts of records on disk, not claims",
    "about capability — a zero here means the capability exists and has never been exercised,",
    "which is a different statement from the capability being absent.",
    "",
    "| Record | Count |",
    "|---|---|",
    ...Object.entries(evidence).map(([k, v]) => `| \`${k}\` | ${v} |`),
    "",
    evidence.promotion === 0
      ? "**No promotion has ever been recorded.** The release gate exists, is tested against each" +
        "\nof its five conditions, and has never been run against a real evaluation — because no" +
        "\nrun here has ever called a model. The gate being armed is not the same as it having fired."
      : `**${evidence.promotion} promotion(s) recorded.**`,
    "",
    "## What this file cannot tell you",
    "",
    "That a contract is validated says a value matching it was produced and checked. It does not",
    "say the value was *correct*, that a model was involved, or that anything was measured against",
    "a provider. Those questions are answered by `EvalRun` records and by",
    "`npm run check:fingerprint`, which reports \"not armed\" until a run reaches a provider.",
    "",
  ];
  return lines.join("\n");
}

function main() {
  const check = process.argv.includes("--check");
  let state, produced;
  try {
    state = collect(".");
    produced = render(state);
  } catch (err) {
    console.error(`docs:matrix — cannot read inputs: ${err.message}`);
    process.exit(2);
  }

  if (!check) {
    writeFileSync(MATRIX, produced, "utf8");
    console.log(`docs:matrix — wrote ${MATRIX} (${state.schemas.length} contracts, ${state.adapters.length} adapters).`);
    return;
  }

  const committed = existsSync(MATRIX) ? read(MATRIX) : "";
  if (committed.trimEnd() === produced.trimEnd()) {
    console.log(`docs:matrix — OK. ${MATRIX} is what the repository produces.`);
    return;
  }
  console.error(
    `docs:matrix — ${MATRIX} differs from what the repository produces.\n\n` +
    `  This file is generated. If a capability changed, run \`npm run docs:matrix\` and commit\n` +
    `  the result. If it was edited by hand, that is the failure this check exists for: a\n` +
    `  matrix anyone can edit is a matrix that asserts whatever its last editor believed.\n`,
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("generate-capability-matrix.mjs")) {
  main();
}
