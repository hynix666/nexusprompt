# Audit 05 — Tests, Evaluation, and Verification

**Scope.** This review examined Vitest project discovery, test suites, evaluation fixtures and runners, verification scripts, CI wiring, fixture/schema validation, and coverage enforcement. Existing source files were not modified. Scratch fixtures used to verify negative behavior were written only under `/home/ubuntu/jobs/job_WjWbJVei_a4`.

## Executive assessment

The repository has an unusually broad and currently green offline verification chain: `npm run verify` completed successfully, including **73 test files and 2,077 tests**. It also contains substantial negative-path and anti-vacuity tests around detectors, sizing, cache accounting, and runner transport selection. However, two evaluation-runner defects allow a command to return a clean evaluation result that does not represent its declared suite or selected transport. These defects are particularly important because the repository explicitly treats evaluation output as evidence and documents false-green prevention as a core goal.

| ID | Classification | Severity | Finding |
|---|---|---:|---|
| T-E-01 | Confirmed defect | High | Both evaluation CLIs accept malformed/empty or internally inconsistent suites and can exit 0 with an empty or undeclared test population. |
| T-E-02 | Confirmed defect | High | `--compare` discards the selected live/local transport and filtered case set, then reports a pinned 14-case comparison after a real transport run. |
| T-E-03 | Confirmed documentation/verification mismatch | Low | README says verification includes 929 tests, but the suite now has 2,077 tests; the count guard does not pin the test-total claim. |
| T-E-04 | Coverage risk / improvement | Low | No code-coverage collection or threshold is configured, while the implementation plan leaves the 80% error-path coverage target unchecked. |

## Detailed findings

### T-E-01 — Evaluation runners can report success for invalid, empty, or undeclared suites

**Classification:** Confirmed defect  
**Severity:** High  
**Confidence:** High

The evaluation contract prohibits an empty declared population: `case_ids` has `minItems: 1` in [`contracts/eval-suite.schema.json:33-39`](../contracts/eval-suite.schema.json#L33-L39). Neither CLI validates the loaded JSON against that contract. The standard runner only parses JSON at [`scripts/run-eval.ts:367-373`](../scripts/run-eval.ts#L367-L373), and the pipeline runner likewise only parses JSON at [`scripts/run-pipeline-eval.ts:44-51`](../scripts/run-pipeline-eval.ts#L44-L51). The latter performs only a per-case shape check at [`scripts/run-pipeline-eval.ts:53-67`](../scripts/run-pipeline-eval.ts#L53-L67), then executes every element of `data.cases` and returns success when `passed === perCase.length` at [`scripts/run-pipeline-eval.ts:67-110`](../scripts/run-pipeline-eval.ts#L67-L110). It never verifies that `suite.case_ids` and `cases` are nonempty, mutually consistent, or uniquely identify the executed population.

The standard runner has an analogous declaration bypass. After its transport filtering, it constructs a new suite whose case IDs are derived from the supplied case objects rather than from the suite declaration at [`scripts/run-eval.ts:599-605`](../scripts/run-eval.ts#L599-L605). Thus an unlisted case becomes the scored suite population instead of causing a mismatch error.

Focused negative executions confirmed the behavior:

| Command / fixture property | Observed result | Why this is unsafe |
|---|---|---|
| `npm run eval -- --suite empty-compile-suite.json`, with `case_ids: []` and `cases: []` | Exit **0**; printed `0/0 cases · score 0.000`. | A no-op suite is reported as successful despite violating the EvalSuite contract. |
| `npm run eval:pipeline -- --suite empty-pipeline-suite.json`, with `case_ids: []` and `cases: []` | Exit **0**; printed `0/0 cases · score NaN`. | This is both a false-green gate and invalid numerical reporting. |
| Pipeline fixture with `case_ids: ["missing"]`, `cases: []` | Exit **0**, `0/0`. | A declared missing case is ignored. |
| Pipeline fixture with `case_ids: []` but one valid `cases[]` item | Exit **0**, `1/1`. | The runner evaluates an undeclared case. |
| Standard fixture with `case_ids: []` but one valid `cases[]` item | Exit **0**, `1/1`. | The standard runner rewrites the declared population from inputs. |

The existing contract test only validates `compile-smoke` and `compile-adversarial` as committed examples ([`test/contract-conformance.test.ts:653-703`](../test/contract-conformance.test.ts#L653-L703)). It does not test `minItems`, one-to-one suite/case membership, duplicates, or either CLI’s response to invalid fixture files. The pipeline-runner tests cover cross-runner type recognition, but do not invoke the CLI with malformed or mismatched suite populations ([`application/test/pipeline-eval.test.ts:138-160`](../application/test/pipeline-eval.test.ts#L138-L160)).

**Impact.** A malformed, generated, or accidentally edited suite can pass with no coverage, can execute cases not declared by the signed/versioned suite metadata, and can produce a misleading score. This defeats the declared suite contract and creates a false-positive gate in the exact layer intended to prevent false greens.

**Recommendation.** Create one shared suite loader/validator used by `run-eval`, `run-pipeline-eval`, and `run-adversarial`. It should validate the suite with Ajv against `eval-suite`, validate each applicable case shape, reject empty arrays, reject duplicate IDs, and require exact set equality between `suite.case_ids` and `cases[].case_id` before dispatch. The pipeline runner should select and execute cases in `suite.case_ids` order, not raw `data.cases` order. Treat malformed suite data as exit 2. Add CLI-level regression tests for empty suites, a declared-but-missing case, an unlisted case, duplicate IDs, and the assertion that a zero-case pipeline run cannot print `NaN` or exit 0.

### T-E-02 — `--compare` runs the selected transport, then discards it and reports a pinned comparison

**Classification:** Confirmed defect  
**Severity:** High  
**Confidence:** High

The main runner correctly selects and runs the requested transport before comparison: it creates `liveWiring` at [`scripts/run-eval.ts:569-573`](../scripts/run-eval.ts#L569-L573) and spreads it into `runSuite` at [`scripts/run-eval.ts:601-605`](../scripts/run-eval.ts#L601-L605). It also filters transport-invalid cases and builds `runnableSuite` at [`scripts/run-eval.ts:416-432`](../scripts/run-eval.ts#L416-L432) and [`scripts/run-eval.ts:599`](../scripts/run-eval.ts#L599). Immediately after that run, `--compare` calls `compareRuns(data, configuration, base)` at [`scripts/run-eval.ts:638-646`](../scripts/run-eval.ts#L638-L646), passing the original unfiltered suite/case data rather than the filtered suite and no provider/cache/transport options.

Inside `compareRuns`, both baseline and candidate calls omit `provider`, `cache`, and transport options at [`scripts/run-eval.ts:702-713`](../scripts/run-eval.ts#L702-L713). `runSuite` therefore uses its default pinned provider ([`application/src/eval.ts:197-205`](../application/src/eval.ts#L197-L205)). The comparison consequently uses all original fixture cases and reports the deliberately declared pinned degraded variant, not the model/local transport selected by the caller.

This was reproduced without a usable Ollama model:

```text
OLLAMA_MODEL=audit-nonexistent-model npm run eval -- --local --compare
```

The command printed an initial **local provider** run over **12** eligible cases, including `36` provider calls, then returned exit **0** with a comparison showing a baseline of **14/14** and candidate **4/14**. That outcome can only come from the pinned fixture path, as the source confirms. The initial local run’s result is not used in the comparison. With `--live --compare`, the same logic would first dispatch paid live calls subject to budget and then silently base the comparison on free pinned stubs.

Existing comparison tests intentionally test the pinned harness directly (`runSuite` calls with no provider in [`application/test/eval-comparison.test.ts:40-49`](../application/test/eval-comparison.test.ts#L40-L49)). They correctly establish the fixture exit gate but do not test accepted CLI flag combinations such as `--local --compare` or `--live --compare`. The dry-run CLI tests similarly do not cover comparison execution ([`test/dry-run.test.ts:38-166`](../test/dry-run.test.ts#L38-L166)).

**Impact.** An operator can pay for or wait for a local/live run and receive a successful regression comparison unrelated to that transport, with a changed denominator (12 announced, 14 compared). This is a high-confidence evidence-integrity defect: it can be interpreted as a model comparison even though the actual comparison is only the predeclared pinned harness demonstration.

**Recommendation.** Choose and enforce one explicit contract. The simpler and safer option is to reject `--compare` combined with `--local` or `--live`, documenting it as a pinned offline harness self-test only; also short-circuit before constructing a real provider so no calls are made. If live/local comparison is intended, refactor `compareRuns` to accept and use the selected provider factory, cache policy, budget/trials, `runnableSuite`, and matching filtered case set for both arms; record both runs and compare those actual results. In either design, add subprocess tests proving that `--local --compare` never exits 0 solely from a pinned result and that the comparison denominator equals the preflight/runnable population.

### T-E-03 — README’s test-total guarantee is stale and not verified by the documented count guard

**Classification:** Confirmed documentation/verification mismatch  
**Severity:** Low  
**Confidence:** High

README says `npm run verify` includes “**929 tests**” at [`README.md:26-29`](../README.md#L26-L29), and later states that every number quoted above is re-derived by `check:counts` at [`README.md:140-144`](../README.md#L140-L144). Current focused and full verification runs instead reported **2,077 tests in 73 files**. The full `npm run verify` completed successfully with that total, so the stale number is not a failing build condition.

The reason is visible in the claim registry. README entries in [`scripts/counted-claims.json:151-196`](../scripts/counted-claims.json#L151-L196) pin schema, contract, gate, stage, catalog, corpus, and frozen-source counts, but contain no pattern/resolver for the `929 tests` statement. The current count checker therefore still passed during verification (`50 occurrence(s) of 45 pinned count(s) re-derived`).

**Impact.** This is not a behavioral failure, but it weakens confidence in the repository’s explicit claim that verification keeps all headline figures current. Readers may understate the actual test surface and infer that the number is machine maintained when it is not.

**Recommendation.** Either remove the volatile exact test total and say “the Vitest suite,” or make the claim measurable: run Vitest with a stable machine-readable reporter in `check:counts` (or emit a committed generated test-summary artifact) and pin that parsed total. Add a checker regression test for a stale README test-count sentence. Update the current README number only after selecting one of those enforcement approaches.

### T-E-04 — No measurable code-coverage gate exists for the documented error-path coverage target

**Classification:** Coverage risk / improvement  
**Severity:** Low  
**Confidence:** High

The implementation plan retains “Code coverage for error paths ≥ 80%” as unchecked work ([`Documentation/IMPROVEMENT_PLAN.md:184-188`](../Documentation/IMPROVEMENT_PLAN.md#L184-L188) and [`Documentation/IMPROVEMENT_PLAN.md:340-352`](../Documentation/IMPROVEMENT_PLAN.md#L340-L352)). The active test command is simply `vitest run` ([`package.json:14-26`](../package.json#L14-L26)), and Vitest configuration only defines projects and timeout settings ([`vitest.config.ts:1-33`](../vitest.config.ts#L1-L33)). There is no coverage command, coverage provider, reporter output, or threshold in the package scripts, configuration, or CI workflow. The green suite therefore demonstrates tests passing, not executable line/branch/function/error-path coverage.

This is a **risk rather than a claim of insufficient behavior testing**. The repository has many intentionally targeted tests, and total coverage alone is not a quality measure. However, without a baseline metric or threshold, coverage regressions in untested paths cannot be detected objectively, including error paths in evaluation CLIs that this audit found are not covered.

**Impact.** The documented 80% error-path target cannot be measured, and reviewers cannot distinguish purposeful coverage from accidental gaps at scale.

**Recommendation.** Add Vitest V8 coverage collection in CI, initially as an informational artifact with branch/function/line metrics per project. Instrument the evaluation runners and external-process error paths first, then establish intentionally scoped thresholds once the baseline is reviewed. Track exclusions with rationale rather than relying on a single aggregate percentage. Do not make a generic percentage a substitute for the specific negative-path tests recommended in T-E-01 and T-E-02.

## Checks performed

| Check | Result |
|---|---|
| `npm test` | Passed: **73 test files, 2,077 tests**. |
| `npm run verify` | Passed, including all configured checkers, smoke/comparison/adversarial/pipeline/anchor evaluations, the Vitest suite, and differential oracle. |
| `npm run eval` | Passed: compile smoke fixture passed 14/14. |
| `npm run eval -- --compare` | Passed: pinned regression harness reported the declared regression. |
| `npm run eval:pipeline` | Passed: pipeline smoke fixture passed 5/5. |
| `npm run eval:adversarial` | Passed as a ratchet: 4 caught and 7 documented evasions. |
| Custom empty/mismatched fixtures | Reproduced the false-success/undeclared-population behavior in T-E-01. |
| `OLLAMA_MODEL=audit-nonexistent-model npm run eval -- --local --compare` | Reproduced the discarded-local-run/pinned-comparison behavior in T-E-02 without intentionally making paid provider calls. |

## Positive observations

The audit found several strong verification practices worth preserving. The core suite has a purity harness that guards clock, randomness, network, and environment access ([`core/test/purity.setup.ts:1-56`](../core/test/purity.setup.ts#L1-L56)); pipeline tests explicitly test a prior wrong-runner false-green scenario ([`application/test/pipeline-eval.test.ts:129-160`](../application/test/pipeline-eval.test.ts#L129-L160)); and the comparison tests assert both directional regression detection and the minimum six-flip significance threshold ([`application/test/eval-comparison.test.ts:52-122`](../application/test/eval-comparison.test.ts#L52-L122)). The recommendations above extend those existing anti-vacuity principles to the remaining CLI ingestion and combined-flag paths.

## References

No external sources were used. All evidence derives from the repository files and local command outputs listed above.
