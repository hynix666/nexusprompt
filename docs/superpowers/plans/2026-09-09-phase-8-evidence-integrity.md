# Phase 8 — Evidence Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop this repository making claims that are not true — green evaluation results that measured nothing, a comparison that ignores the transport you paid for, provider output that was truncated but persisted as success, provenance that reports a randomization production never performs, and install instructions that fail.

**Architecture:** Every change is at a boundary. Inputs are validated before they enter execution, provider output is validated before it enters the application, and misleading evidence is corrected at the point it is recorded. Nothing under `core/src/` changes; no algorithm, routing decision, or pipeline plan is touched. Unsupported combinations are refused rather than implemented.

**Tech Stack:** TypeScript (ESM, `module: nodenext`), `tsx` at runtime, Vitest projects (`core`, `application`, `adapters`, `shells`, `contracts`), Ajv + ajv-formats for schema validation, npm workspaces.

**Spec:** `Documentation/MINIMUM_CHANGE_REMEDIATION_STRATEGY_2026.md`, which remediates `Documentation/REPOSITORY_AUDIT_2026.md`. Both merged in PR #181. Read both before starting.

## Global Constraints

- **Never modify `core/src/**`.** The spec's boundary-only rule. If a task appears to need a Core change, stop and escalate — it means the task was mis-scoped.
- **Use `npm`, not `pnpm`.** Much of the documentation says pnpm; pnpm is not installed.
- **Every new `package.json` script must also be added to `Documentation/IMPLEMENTATION_PLAN.md`'s `commands` array**, or `npm run check:plan` fails.
- **A new tracked file under `contracts/`, `core/src/`, `application/src/`, `adapters/`, or `shells/` moves `artifact_files`.** Stage it, run `npm run build:hash`, and update `spec/truth-boundary.json`. `scripts/` and `docs/` do not count.
- **Run `npm test` and `npm run verify` after every commit.** The spec requires it. `verify` fail-fasts, so a green earlier stage does not mean later stages ran.
- **Do not add a `Co-Authored-By` trailer.**
- Successful-path behaviour must not change. Existing valid fixtures produce identical results in every task.

---

## Task Order and Why

Tasks 2–7 follow the spec's own "Recommended commit sequence". Task 1 is **not from the spec** — it comes from an investigation on 9 September 2026 that proved `npm start -w @nexusprompt/shell-api` and `npm run cli` both fail on `npm install --omit=dev` (no `tsx`, no build script anywhere, no `bin` in `shells/cli/package.json`), while `Documentation/USER_GUIDE.md:40` instructs users to run one of them. It is placed first because it is the cheapest untrue claim to retire and it is independent of every other task.

**Deliberately out of scope, for a follow-on plan:** the spec's items 7 and 8 (containing model fallback and routing-policy admission) and its optional exception-normalization phase. Those fence off unimplemented features rather than correcting false claims, which is a different theme and a different review.

---

### Task 1: The repository states that it cannot be installed

**Files:**
- Modify: `scripts/check-truth-boundary.ts` (add one probe beside `builtSurface`, which begins at line 310)
- Modify: `spec/truth-boundary.json` (add one entry to `entries`)
- Modify: `Documentation/USER_GUIDE.md:40`
- Regenerate: `Documentation/TRUTH_BOUNDARY.md` (generated — never hand-edit)
- Test: `test/truth-boundary.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a probe named `deliverySurface` returning `{ tsx_is_a_dev_dependency_only: boolean, build_script_in_root_or_shells: number, cli_declares_a_bin: boolean }`. No later task depends on it.

- [ ] **Step 1: Confirm the finding still holds before writing anything**

```bash
git worktree add --detach /tmp/prodcheck origin/master
cd /tmp/prodcheck && npm install --omit=dev --silent
npm run cli -- gates 2>&1 | tail -3
cd - && git worktree remove --force /tmp/prodcheck
```

Expected: `'tsx' is not recognized`. If this now succeeds, **stop** — the premise has changed and the entry would be false.

- [ ] **Step 2: Write the failing test**

In `test/truth-boundary.test.ts`:

```ts
it("states that nothing here can be installed and run", () => {
  const spec = JSON.parse(readFileSync("spec/truth-boundary.json", "utf8"));
  const entry = spec.entries.find((e: { id: string }) => e.id === "nothing-here-is-installable");
  expect(entry, "the delivery boundary must be stated, not left implied").toBeDefined();
  // The claim is about delivery, so it must pin the three facts that make it true.
  expect(Object.keys(entry.expect).sort()).toEqual([
    "build_script_in_root_or_shells",
    "cli_declares_a_bin",
    "tsx_is_a_dev_dependency_only",
  ]);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run --project contracts test/truth-boundary.test.ts -t "installed"`
Expected: FAIL — `the delivery boundary must be stated, not left implied`.

- [ ] **Step 4: Add the probe**

In `scripts/check-truth-boundary.ts`, beside `builtSurface`:

```ts
  /**
   * Whether anything here can be installed and run by someone who did not clone it.
   *
   * `three-reproducibility-claims` already says NOTHING IS COMPILED, but says it as a
   * reproducibility caveat. Nobody had written down what it means for delivery: `tsx` is a
   * devDependency, no workspace has a `build` script, and `shells/cli` declares no `bin`, so
   * `npm install --omit=dev` produces a tree in which neither Shell starts. Proven on
   * 9 September 2026 by doing it.
   */
  deliverySurface(root) {
    const rootPkg = JSON.parse(readText(root, "package.json"));
    const shellPkgPaths = dirNames(root, "shells")
      .map((d) => `shells/${d}/package.json`)
      .filter((p) => existsSync(join(root, p)));
    const withBuild = ["package.json", ...shellPkgPaths].filter((p) => {
      const j = JSON.parse(readText(root, p));
      return Boolean(j.scripts?.build);
    });
    const cliPkg = JSON.parse(readText(root, "shells/cli/package.json"));
    return {
      tsx_is_a_dev_dependency_only:
        Boolean(rootPkg.devDependencies?.tsx) && !rootPkg.dependencies?.tsx,
      build_script_in_root_or_shells: withBuild.length,
      cli_declares_a_bin: Boolean(cliPkg.bin),
    };
  },
```

If `existsSync` or `join` is not already imported in this file, add them to the existing `node:fs` / `node:path` import lines rather than adding new import statements.

- [ ] **Step 5: Add the entry**

In `spec/truth-boundary.json`, append to `entries`:

```json
{
  "id": "nothing-here-is-installable",
  "probe": "deliverySurface",
  "establishes": "That the engine runs from a checkout. `npm install && npm run verify` works in about ten seconds, and `npm run cli` drives a full pipeline run from source.",
  "does_not_establish": "That anyone can install this and run it. `tsx` is a devDependency, no workspace declares a `build` script, and `shells/cli` declares no `bin`, so `npm install --omit=dev` produces a tree where `npm run cli` and `npm start -w @nexusprompt/shell-api` both fail on a missing `tsx`. This was proven on 9 September 2026 by performing that install, not inferred from the manifests. `three-reproducibility-claims` already says NOTHING IS COMPILED, but says it about build reproducibility; this entry says what it means for delivery, which is a different claim and was stated nowhere. Until it is, `USER_GUIDE.md` describes commands that work only for people who already have the development tree — which is everyone who has ever run them, and is why it went unnoticed.",
  "expect": {
    "tsx_is_a_dev_dependency_only": true,
    "build_script_in_root_or_shells": 0,
    "cli_declares_a_bin": false
  },
  "crossed_when": "A build step lands, `tsx` moves to `dependencies`, or `shells/cli` gains a `bin`. Any of the three changes what this repository can hand to someone, and the entry should then be rewritten as a delivery claim rather than renumbered.",
  "evidence": ["package.json", "shells/cli/package.json", "Documentation/USER_GUIDE.md"]
}
```

- [ ] **Step 6: Correct the instruction that fails**

`Documentation/USER_GUIDE.md:40` currently reads `(\`npm start -w @nexusprompt/shell-api\`)`. Replace with:

```markdown
(`npm start -w @nexusprompt/shell-api`, from a development checkout — see
[the truth boundary](./TRUTH_BOUNDARY.md) on why a production install cannot run it).
```

- [ ] **Step 7: Regenerate and verify**

```bash
npm run docs:truth
npx vitest run --project contracts test/truth-boundary.test.ts -t "installed"
npm run check:truth
```

Expected: test PASSES, `check:truth` reports OK.

- [ ] **Step 8: Mutation-prove the probe**

Temporarily add `"tsx": "^4.0.0"` to root `dependencies`, then run `npm run check:truth`.
Expected: FAILS with `tsx_is_a_dev_dependency_only — declared true, derived false`.
Remove the line and confirm it passes again. **Verify by exit code, not by reading coloured output.**

- [ ] **Step 9: Commit**

```bash
git add scripts/check-truth-boundary.ts spec/truth-boundary.json Documentation/TRUTH_BOUNDARY.md Documentation/USER_GUIDE.md test/truth-boundary.test.ts
git commit -m "docs: state that nothing here can be installed, and stop telling users otherwise"
```

---

### Task 2: One shared evaluation-suite loader

Spec §1. This is the highest-value change: it stops invalid input reaching scoring, pipeline, provider, or Core.

**Files:**
- Create: `scripts/load-eval-suite.ts`
- Modify: `scripts/run-eval.ts:369` (replace the bare `JSON.parse`)
- Modify: `scripts/run-pipeline-eval.ts:47` (same)
- Modify: `scripts/run-adversarial.ts:35` (same; leave the `ledger` parse on line 36 alone)
- Test: `test/load-eval-suite.test.ts` (new)

**Interfaces:**
- Consumes: `contracts/eval-suite.schema.json` (`$id` `.../eval-suite/2.0.1`; `case_ids` is `{"type":"array","items":{"type":"string"},"minItems":1}`).
- Produces:
  - `class SuiteError extends Error`
  - `function loadEvalSuite<C extends { case_id: string }>(path: string): { suite: EvalSuite; cases: C[] }` — throws `SuiteError`; returns cases ordered by `suite.case_ids`.

- [ ] **Step 1: Write the failing tests**

Create `test/load-eval-suite.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvalSuite, SuiteError } from "../scripts/load-eval-suite.js";

const write = (body: unknown): string => {
  const p = join(mkdtempSync(join(tmpdir(), "suite-")), "s.json");
  writeFileSync(p, JSON.stringify(body), "utf8");
  return p;
};

const suite = (case_ids: string[]) => ({
  suite_id: "fixture", version: "1.0.0", kind: "compile", case_ids,
  resolution: { detectable_delta: 1 / Math.max(case_ids.length, 1) },
  significance_protocol: { test: "mcnemar", alpha: 0.05 },
});

const caseOf = (case_id: string) => ({ case_id, brief: "b", stub: { text: "t" } });

describe("loadEvalSuite", () => {
  it("returns cases in the order case_ids declares, not file order", () => {
    const p = write({ suite: suite(["a", "b"]), cases: [caseOf("b"), caseOf("a")] });
    expect(loadEvalSuite(p).cases.map((c) => c.case_id)).toEqual(["a", "b"]);
  });

  it("refuses a suite with no cases", () => {
    const p = write({ suite: suite([]), cases: [] });
    expect(() => loadEvalSuite(p)).toThrow(SuiteError);
  });

  it("refuses a declared case that is absent", () => {
    const p = write({ suite: suite(["a", "b"]), cases: [caseOf("a")] });
    expect(() => loadEvalSuite(p)).toThrow(/declared but absent: b/);
  });

  it("refuses a case that was never declared", () => {
    const p = write({ suite: suite(["a"]), cases: [caseOf("a"), caseOf("z")] });
    expect(() => loadEvalSuite(p)).toThrow(/present but undeclared: z/);
  });

  it("refuses duplicate case ids", () => {
    const p = write({ suite: suite(["a"]), cases: [caseOf("a"), caseOf("a")] });
    expect(() => loadEvalSuite(p)).toThrow(/duplicate/);
  });

  it("refuses a suite that does not satisfy eval-suite.schema.json", () => {
    const p = write({ suite: { suite_id: "x" }, cases: [caseOf("a")] });
    expect(() => loadEvalSuite(p)).toThrow(SuiteError);
  });

  it("loads every real suite in eval/ unchanged", () => {
    // The must-not-break half. A validator that rejects the corpus proves nothing.
    for (const f of ["eval/compile-smoke.json", "eval/pipeline-smoke.json"]) {
      expect(loadEvalSuite(f).cases.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run them and watch every one fail**

Run: `npx vitest run --project contracts test/load-eval-suite.test.ts`
Expected: all FAIL — `Cannot find module '../scripts/load-eval-suite.js'`.

- [ ] **Step 3: Write the loader**

Create `scripts/load-eval-suite.ts`:

```ts
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
  const duplicates = cases.filter((c) => !seen.add(c.case_id)).map((c) => c.case_id);
  if (duplicates.length > 0) {
    throw new SuiteError(`${path}: duplicate case id(s): ${[...new Set(duplicates)].join(", ")}`);
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
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project contracts test/load-eval-suite.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Wire the three runners**

In `scripts/run-eval.ts`, replace lines 368–372 (the `try { data = JSON.parse(...) } catch` block) with:

```ts
  let data: { suite: EvalSuite; cases: StubbedCase[] };
  try {
    data = loadEvalSuite<StubbedCase>(SUITE);
  } catch (err) {
    if (!(err instanceof SuiteError)) throw err;
    console.error(`eval: ${err.message}`);
    return 2;
  }
```

Add to the imports: `import { loadEvalSuite, SuiteError } from "./load-eval-suite.js";`

Apply the same replacement at `scripts/run-pipeline-eval.ts:47` (prefix messages with `eval:pipeline:`) and `scripts/run-adversarial.ts:35` (prefix `eval:adversarial:`). **Leave the `ledger` parse on `run-adversarial.ts:36` unchanged** — it is not a suite.

Leave `run-eval.ts`'s existing `isPipelineCase` refusal in place; it runs after loading and still does its own job.

- [ ] **Step 6: Add subprocess regressions**

In `test/eval-flags.test.ts`, reusing its existing `run(args, env)` helper:

```ts
it("exits 2 on a suite whose declared population is not what it holds", () => {
  const p = join(mkdtempSync(join(tmpdir(), "badsuite-")), "s.json");
  writeFileSync(p, JSON.stringify({
    suite: { suite_id: "x", version: "1.0.0", kind: "compile", case_ids: ["a", "b"],
             resolution: { detectable_delta: 0.5 },
             significance_protocol: { test: "mcnemar", alpha: 0.05 } },
    cases: [{ case_id: "a", brief: "b", stub: { text: "t" } }],
  }), "utf8");
  const r = run(["--suite", p]);
  expect(r.code).toBe(2);
  expect(r.out).toMatch(/declared but absent: b/);
});
```

- [ ] **Step 7: Confirm the real suites are untouched**

```bash
npm run eval && npm run eval:pipeline && npm run eval:adversarial
```

Expected: identical scores and identical `provider_calls` to before the change. If any number moved, the loader is reordering or dropping a case — **stop and diagnose**, do not adjust the expectation.

- [ ] **Step 8: Commit**

```bash
git add scripts/load-eval-suite.ts scripts/run-eval.ts scripts/run-pipeline-eval.ts scripts/run-adversarial.ts test/load-eval-suite.test.ts test/eval-flags.test.ts
git commit -m "fix: validate evaluation suite populations"
```

---

### Task 3: `--compare` refuses `--live` and `--local`

Spec §2. `scripts/run-eval.ts:646` calls `compareRuns(data, configuration, base)`, and `compareRuns` calls `runSuite({...})` with **no `provider` argument** — so it uses the default pinned stub whatever transport you selected, over the unfiltered case list. The function's own docstring already says "Both runs are pinned"; the defect is that the flag combination is accepted, not that comparison is pinned.

**Files:**
- Modify: `scripts/run-eval.ts` (inside `main()`, immediately after the `flagError` block that ends at line 361)
- Test: `test/eval-flags.test.ts`

**Interfaces:**
- Consumes: `LIVE` (line 63) and `LOCAL` (line 76), already module-level constants.
- Produces: nothing importable.

- [ ] **Step 1: Write the failing tests**

```ts
it("refuses --compare with --live, before any provider is constructed", () => {
  const r = run(["--compare", "--live"], { ANTHROPIC_API_KEY: undefined });
  expect(r.code).toBe(2);
  expect(r.out).toMatch(/--compare/);
  // If it reached provider construction it would complain about the missing key instead.
  expect(r.out).not.toMatch(/ANTHROPIC_API_KEY/);
});

it("refuses --compare with --local", () => {
  expect(run(["--compare", "--local"]).code).toBe(2);
});

it("still allows --compare on its own", () => {
  expect(run(["--compare"]).code).toBe(0);
});
```

- [ ] **Step 2: Run and watch the first two fail**

Run: `npx vitest run --project contracts test/eval-flags.test.ts -t "compare"`
Expected: the two refusal tests FAIL (exit 0, not 2); the third passes already.

- [ ] **Step 3: Add the refusal**

In `scripts/run-eval.ts`, immediately after the `try`/`catch` block that ends at line 361:

```ts
  /**
   * `--compare` runs both arms against the pinned stub. `compareRuns` passes no provider to
   * `runSuite`, so the default stub answers whatever `--live` or `--local` selected, and it
   * compares the unfiltered case list rather than the runnable one. Accepting the combination
   * means an operator can pay for a live run and be handed a comparison that never touched it.
   *
   * Refused rather than implemented: threading a live provider through both arms needs
   * provider factories, cache policy, budget accounting, filtering and provenance to agree,
   * which is a design, not a patch.
   */
  if (process.argv.includes("--compare") && (LIVE || LOCAL)) {
    console.error(
      `eval: --compare cannot be combined with ${LIVE ? "--live" : "--local"}.\n` +
      "  Comparison runs both arms against the pinned offline harness, so the transport you\n" +
      "  selected would be built, charged for, and then ignored. Run them separately:\n\n" +
      `    npm run eval -- ${LIVE ? "--live" : "--local"}   # measure the transport\n` +
      "    npm run eval -- --compare        # measure the harness\n",
    );
    return 2;
  }
```

- [ ] **Step 4: Run and watch all three pass**

Run: `npx vitest run --project contracts test/eval-flags.test.ts -t "compare"`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-eval.ts test/eval-flags.test.ts
git commit -m "fix: reject unsupported compare modes"
```

---

### Task 4: The local proxy validates a 2xx body

Spec §3.

**Files:**
- Modify: `adapters/provider-local-proxy/src/index.ts`
- Test: `adapters/provider-local-proxy/test/` (add to the existing adapter suite)

**Interfaces:**
- Consumes: the `MALFORMED_RESPONSE` failure category, authorized by ADR-0014 and already in `FAILURE_CATEGORIES`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Add cases asserting a `ProviderFailure` with `category: "MALFORMED_RESPONSE"` for each of: body is not an object; `content` missing; `content` text empty; `model` present but not a string; `usage.input_tokens` present but not finite. Plus one must-not-break case: a valid body still yields a `GenerationResult` with unchanged text.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --project adapters`
Expected: the malformed cases FAIL — they currently return success or a mislabelled connection failure.

- [ ] **Step 3: Implement**

Validate **inside a nested response-validation boundary**, so a malformed 2xx JSON body is not caught by the outer transport `catch` and mislabelled as a connection failure. Return the existing typed failure; do not invent a category.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run --project adapters`
Expected: all pass, including the unchanged-valid-response case.

- [ ] **Step 5: Commit**

```bash
git add adapters/provider-local-proxy
git commit -m "fix: validate local provider responses"
```

---

### Task 5: Hosted truncation stops being success

Spec §4.

**Files:**
- Modify: `adapters/provider-hosted-server/src/index.ts`
- Test: `adapters/provider-hosted-server/test/`

- [ ] **Step 1: Write the failing tests**

Two cases: a response with `stop_reason: "end_turn"` remains a successful `GenerationResult`; a response with `stop_reason: "max_tokens"` becomes a typed failure. The second is the regression — truncated output is currently persisted as a completed stage, and every downstream gate then lints a fragment as if it were the artifact.

- [ ] **Step 2: Run and watch the `max_tokens` case fail**

Run: `npx vitest run --project adapters`
Expected: `max_tokens` FAILS — it currently returns success.

- [ ] **Step 3: Implement**

Map known incomplete terminal states to the existing typed incomplete/malformed classification at the adapter boundary. Do not add a new category.

- [ ] **Step 4: Run and watch both pass**

Run: `npx vitest run --project adapters`

- [ ] **Step 5: Commit**

```bash
git add adapters/provider-hosted-server
git commit -m "fix: classify hosted truncation consistently"
```

---

### Task 6: The judge stops claiming a randomization it does not perform

Spec §5. `application/src/judge.ts:134` sets `position_randomized: true`. The comment directly above it, at lines 132–133, already argues the opposite: *"Randomization is the caller's responsibility to DO and the verdict's to record; a judge that reported it without doing it would be worse than one that reported false."* The comment is right and the code contradicts it.

**Files:**
- Modify: `application/src/judge.ts:134`
- Test: `test/contract-conformance.test.ts` (the judge block) or `application/test/judge.test.ts`, whichever already exercises `GuardedJudge`

- [ ] **Step 1: Write the failing test**

```ts
it("records that candidate order was not randomized, because it was not", () => {
  // core/src/eval/judge-policy.ts:207 pushes "position" into the chance-correction set when
  // this flag is true. Reporting true without doing it inflates the correction against a
  // bias that was never introduced.
  const verdict = await judge.grade(request);
  expect(verdict.position_randomized).toBe(false);
});
```

- [ ] **Step 2: Run and watch it fail**

Expected: FAIL — received `true`.

- [ ] **Step 3: Change one line**

`application/src/judge.ts:134`: `position_randomized: true,` → `position_randomized: false,`

Extend the existing comment with: *"Set false on 9 September 2026: nothing in this path shuffles candidate order, so the flag was reporting an intent. Implementing randomization needs a recorded seed, a recorded order, score remapping, and new calibration — a separate decision."*

- [ ] **Step 4: Run and watch it pass**

- [ ] **Step 5: Check the blast radius**

```bash
npm run check:judge && npm run eval:compare
```

Expected: both pass. If `check:judge` moves an agreement figure, that number was computed against a false premise — record the before/after in the commit message rather than adjusting the test.

- [ ] **Step 6: Commit**

```bash
git add application/src/judge.ts test/contract-conformance.test.ts
git commit -m "fix: correct judge randomization provenance"
```

---

### Task 7: Remove the stale test count from the README

Spec §6.

**Files:**
- Modify: `README.md:28`

- [ ] **Step 1: Make the edit**

`README.md:28` reads `hash, the evaluation suites, 929 tests, and the differential oracle.` Replace `929 tests` with `the Vitest test suite`.

The spec chooses removal over pinning deliberately: a count here would need a `counted-claims.json` entry and a resolver, and the number changes on every commit that adds a test. The absence of a number is the fix.

- [ ] **Step 2: Confirm no pin depended on it**

```bash
npm run check:counts
```

Expected: OK. If it now reports a *missing* pattern, a claim was registered against that number — reinstate a pinned count instead and add the resolver.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: remove stale test count"
```

---

## Final Verification

- [ ] `npm run verify` exits 0 — check the exit code, not the tail of the output; `verify` fail-fasts and a green-looking stage may be the last one that ran.
- [ ] `npm run eval`, `eval:pipeline`, `eval:adversarial`, `eval:compare` produce the same scores and `provider_calls` as before Task 2.
- [ ] `git diff origin/master --stat -- core/src` is **empty**. Any Core change means a task was mis-scoped.
- [ ] Every task's must-fire test has been shown to fail against the unmodified code.

## Self-Review

**Spec coverage:** §1 → Task 2. §2 → Task 3. §3 → Task 4. §4 → Task 5. §5 → Task 6. §6 → Task 7. Spec §7 (fallback), §8 (routing) and the optional exception-normalization phase are **deliberately deferred** to a follow-on plan and are named as such above. Task 1 is additional to the spec, with its provenance stated.

**Placeholders:** Tasks 4 and 5 describe their tests by behaviour rather than quoting code, because the adapter suites' fixture helpers were not read while writing this plan. The implementer should open the existing adapter test file first and follow its established fixture style. Every other task carries literal code.

**Type consistency:** `loadEvalSuite` and `SuiteError` are named identically in Task 2's definition, its tests, and all three call sites. `deliverySurface`'s three keys match between the probe, the `expect` block, and Task 1's test.
