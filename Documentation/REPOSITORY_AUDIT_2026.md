# Repository Audit Report — 2026-09-08

## Executive summary

This audit reviewed the repository structure, provider adapters, evaluation runners, tests, contracts, routing references, and operational scripts. The repository has a strong offline verification culture: the test suite is broad, includes many negative-path checks, and encodes important anti-vacuity principles. The principal risk is not a lack of engineering discipline; it is **contract-to-runtime drift**. Several configuration and evidence fields are accepted, hashed, or reported as if they control execution, while the live path either ignores them or substitutes a different behavior.

The highest-priority work is to prevent false evidence and incomplete outputs from being treated as successful execution. In particular, evaluation suite declarations must be validated before dispatch; comparison mode must compare the transport and population selected by the caller; provider fallback and routing must either be wired into production or rejected at admission; and every provider adapter must enforce the same runtime response and truncation semantics.

The specialist workflow completed two of seven planned area audits before the available agent budget was exhausted. Those completed audits were preserved and independently corroborated with repository searches and source inspection. The remaining areas were covered by direct static checks, existing repository documentation, and the verification run initiated during this audit. No source files were modified.

## Priority summary

| Priority | Finding | Classification | Main locations |
|---|---|---|---|
| P0 | Evaluation runners accept empty, undeclared, and inconsistent case populations and can exit successfully | Confirmed defect | `scripts/run-eval.ts`, `scripts/run-pipeline-eval.ts`, `contracts/eval-suite.schema.json` |
| P0 | `--compare` can run a selected local/live transport, then discard it and report a pinned comparison | Confirmed defect | `scripts/run-eval.ts` |
| P1 | Configured model fallback is declarative only; the hosted adapter uses only the first model | Confirmed defect | `contracts/index.ts`, `core/src/stages/stage-kit.ts`, `adapters/provider-hosted-server/src/index.ts` |
| P1 | Routing policy is defined and validated but is not connected to production dispatch | Confirmed defect | `core/src/routing/policy.ts`, `application/src/invoke.ts`, `application/src/pipeline.ts` |
| P1 | Hosted adapter drops generation controls and idempotency information | Confirmed defect | `contracts/index.ts`, `adapters/provider-hosted-server/src/index.ts` |
| P1 | Local proxy accepts malformed successful responses as valid generation results | Confirmed defect | `adapters/provider-local-proxy/src/index.ts` |
| P1 | Hosted Anthropic `max_tokens` termination is persisted as successful output | Confirmed defect | `adapters/provider-hosted-server/src/index.ts` |
| P1 | Judge evidence claims candidate-order randomization that production does not perform | Confirmed defect | `application/src/judge.ts`, `core/src/eval/brief-fidelity.ts`, `adapters/provider-hosted-judge/src/index.ts` |
| P2 | README test-count claim is stale and not covered by the count guard | Confirmed mismatch | `README.md`, `scripts/counted-claims.json` |
| P2 | Documented error-path coverage target is not measured or enforced | Coverage risk | `Documentation/IMPROVEMENT_PLAN.md`, `package.json`, `vitest.config.ts` |
| P2 | Retry behavior depends on every provider honoring the typed-failure contract | Reliability risk | `application/src/invoke.ts`, pipeline/orchestrator callers |

## Method and scope

The review used parallel specialist audits for provider integrations and tests/evaluations, followed by direct repository inspection. The repository contains 834 tracked files and 459 tracked source/configuration files in the principal code extensions. Inspection included `core/`, `application/`, `contracts/`, `adapters/`, `shells/`, `scripts/`, `eval/`, package configuration, and relevant documentation. Findings are labeled **confirmed defect**, **risk**, or **improvement** to distinguish observed behavior from recommendations.

## Detailed findings

### P0 — Evaluation suite population is not validated before execution

**Evidence.** `scripts/run-eval.ts` and `scripts/run-pipeline-eval.ts` parse JSON but do not validate the complete loaded suite against `contracts/eval-suite.schema.json`. The pipeline runner executes `data.cases` directly and returns success when all executed cases pass. The standard runner can derive the scored population from supplied cases instead of enforcing equality with the declared `suite.case_ids`.

Focused negative fixtures reproduced the following behaviors: an empty suite exits 0; a declared case can be absent without failure; an undeclared case can be executed; and the pipeline path can print a `NaN` score for a zero-case run.

**Impact.** A malformed or accidentally edited evaluation fixture can produce a clean result with no meaningful coverage, execute cases outside the declared/signed population, and undermine the repository’s stated false-green protections.

**Fix.** Introduce one shared suite loader using Ajv and the existing schema. Require non-empty, unique IDs; exact set equality between `suite.case_ids` and `cases[].case_id`; valid per-case shapes; and deterministic execution in declared ID order. Treat malformed fixtures as exit code 2. Add subprocess-level regression tests for empty, missing, undeclared, duplicate, and zero-case inputs.

### P0 — Comparison mode can report a result unrelated to the selected transport

**Evidence.** The main runner constructs a selected local/live transport and performs an initial run, but the `--compare` path calls `compareRuns` with the original unfiltered data and without the selected provider, cache, transport options, or filtered runnable population. The comparison therefore falls back to the pinned harness and may report a different denominator from the run announced to the operator.

A reproduced local invocation with a nonexistent Ollama model showed an initial local run over 12 eligible cases followed by a successful pinned comparison over 14 cases.

**Impact.** Operators can pay for or wait on a live/local run and receive a successful comparison that does not use that transport or case population. This is an evidence-integrity defect, not merely a user-interface discrepancy.

**Fix.** Safest short-term option: reject `--compare` combined with `--local` or `--live` before constructing a real provider, and document comparison as an offline pinned-harness operation. If live/local comparison is required, pass the selected provider factory, cache policy, budget/trials, and filtered suite through both comparison arms, and record the exact population and transport in the result.

### P1 — Model fallback policy is accepted but not executed

**Evidence.** `GenerationRequest.model_policy` contains ordered `preferred_models` and `allow_fallback`. Stage construction requests fallback. `HostedServerProvider.generate()` selects only `preferred_models[0]`; repository search found no production consumer of `allow_fallback` that advances to another model. Local and Ollama adapters likewise resolve a single configured model.

**Impact.** A caller authorizing fallback still fails on a transient primary-provider error even when an alternate is configured. Configuration, availability expectations, and provenance become misleading.

**Fix.** Implement fallback at the application policy boundary. Advance only on explicitly eligible classified failures, preserve idempotency, enforce aggregate call budgets, record every attempted provider/model, and test success, transient fallback, non-retriable failure, disabled fallback, exhausted candidates, and allowlist behavior.

### P1 — Routing policy is not connected to live dispatch

**Evidence.** `core/src/routing/policy.ts` implements `decideRoute` and `reduceRouteOutcome`, and configuration schemas expose `router_policy_ref`. The production invocation path uses one injected provider, while repository search found no production dispatch path consuming the routing decisions.

**Impact.** A configuration can validate and hash a routing policy that cannot affect execution. Tier escalation, cost distribution, and routing evidence therefore do not describe actual runtime behavior.

**Fix.** Either reject non-null `router_policy_ref` at execution admission until supported, or add an application dispatcher that resolves the policy, maps provider/gate outcomes, accounts for worst-case escalations, and persists per-tier attempts and final route. Do not silently accept an inactive policy field.

### P1 — Hosted generation controls and idempotency are silently dropped

**Evidence.** The common contract exposes `generation_options.max_tokens`, `generation_options.effort`, and `idempotency_key`. The hosted adapter sends a fixed temperature, hard-codes some provider output limits, omits output limits for other providers, and does not construct an idempotency header/body field.

**Impact.** The same request has different cost, length, and reproducibility semantics by adapter. Retries can duplicate billable or non-idempotent upstream work when a response is lost after successful processing.

**Fix.** Define provider capability descriptors and translate common controls explicitly per provider. Reject or record unsupported controls instead of silently dropping them. Pass idempotency where supported and document retry safety where not. Add request-body and header assertions for every hosted provider.

### P1 — Local proxy malformed 2xx responses become successful results

**Evidence.** `adapters/provider-local-proxy/src/index.ts` casts parsed JSON to the expected shape and constructs a success result without validating the envelope. Missing content becomes an empty string; model, stop reason, and usage fields are not type-checked. JSON parsing failures are caught by a broad catch and classified as connectivity failure.

**Impact.** Blank or structurally invalid output can be persisted as a successful revision and reach later stages. Invalid accounting/provenance values can corrupt downstream consumers, while malformed responses are misrepresented as outages.

**Fix.** Parse and validate 2xx responses in a nested response-validation boundary. Require an object, non-empty text, and correctly typed finite usage/model fields. Return a dedicated `MALFORMED_RESPONSE` classification and add malformed JSON, missing content, wrong-type fields, and empty-output tests.

### P1 — Hosted Anthropic truncation is treated as success

**Evidence.** The local proxy explicitly rejects `stop_reason === "max_tokens"`, but the hosted Anthropic branch returns that terminal state as a normal finish reason and wraps it as a successful `GenerationResult`.

**Impact.** Partial output may be persisted as a complete stage artifact and fed into later transformations. This contradicts the project’s own local adapter semantics.

**Fix.** Normalize incomplete terminal states across Anthropic, OpenAI, compatible OpenAI, and Gemini adapters. Use a shared classification and remediation policy, and add parameterized cross-provider tests for max-output and incomplete termination states.

### P1 — Judge evidence falsely reports position randomization

**Evidence.** `GuardedJudge.grade()` hard-codes `position_randomized: true`. Candidate construction is deterministic and production does not permute candidate order before judging.

**Impact.** Persisted verdict evidence claims a bias-control procedure that did not occur. This compromises evaluation interpretation and later statistical/evidence review.

**Fix.** Set the field to false/not-applicable for the current single-candidate protocol, or implement deterministic seeded randomization, record the seed/order, map scores back to the original candidate, and derive the field from the actual operation.

### P2 — Test-count documentation is stale

The README claims 929 tests while the current suite reports 2,077 tests in 73 files. The count checker does not pin or re-derive this specific README claim. Either remove the exact volatile count or make it generated and enforce it with a stable test reporter.

### P2 — Coverage target is documented but not measurable

The improvement plan names an 80% error-path coverage target, but package scripts and Vitest configuration contain no coverage provider, reporter, artifact, or threshold. Add V8 coverage as an informational CI artifact first, scope it to error paths and evaluation runners, then establish reviewed thresholds.

### P2 — Retry boundary assumes typed provider failures

`application/src/invoke.ts` awaits `provider.generate()` without a protective normalization boundary. First-party adapters generally translate expected fetch failures, but a third-party or future adapter that throws can bypass the shared retry semantics. Normalize unexpected provider throws into a typed failure at the invocation boundary and add tests for thrown transport, malformed provider, and cancellation errors.

## Positive observations to preserve

The repository has strong purity checks around clock, randomness, network, and environment access in core tests. It contains extensive negative-path tests for detectors, sizing, cache accounting, and runner selection. Provider failures are typed in most first-party adapters, upstream text is intentionally excluded from persisted failure messages, and the Ollama adapter demonstrates stronger malformed-envelope and loopback handling than the local proxy. These patterns should be extended rather than replaced.

## Recommended remediation sequence

1. **Evidence integrity:** implement shared suite validation and reject unsupported compare flag combinations; add CLI subprocess regressions.
2. **Provider correctness:** introduce shared response normalization, consistent truncation classification, and capability-aware request translation.
3. **Execution policy:** wire fallback and routing into application dispatch or reject inactive configuration fields at admission.
4. **Provenance correctness:** fix judge randomization evidence and persist attempted provider/model routes and unsupported-control decisions.
5. **Quality controls:** add targeted coverage reporting, update/remove stale test-count claims, and normalize unexpected provider exceptions.
6. **Operational hardening:** add CI checks that compare declared populations, selected transports, and persisted run manifests; require these fields to agree before promotion.

## Verification status

The completed specialist audit established that the focused adapter and application tests passed and reported 73 test files / 2,077 tests. A fresh `npm run verify` independently completed with **exit code 0**: all configured checks passed, 73 test files and 2,077 tests passed, and the differential oracle reported agreement across 2,848 shared gate verdicts with 21 declared divergences. One expected contract-conformance test emitted a diagnostic for a deliberately incomplete fixture, but the test passed and the verification command succeeded. The audit itself made no source-code changes.

## Audit artifacts

Specialist notes are retained under `.audit/04-providers-adapters.md` and `.audit/05-tests-evals.md`. They contain the detailed evidence, probes, and source references used to produce this report.

## Conclusion

The repository is mature in its intent and verification breadth, but several high-impact paths currently permit **declared behavior to diverge from executed behavior**. Fixing the P0/P1 items should be treated as a release-quality effort because they affect whether evaluation results, cost controls, provider provenance, and persisted outputs can be trusted—not only whether individual functions pass unit tests.
