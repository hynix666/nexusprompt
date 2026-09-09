# Providers and Adapter Integrations Audit

**Area:** Provider and adapter implementations, routing, retries/timeouts, fallback behavior, capability negotiation, response normalization, malformed responses, local inference, and external integration boundaries.  
**Audit date:** 2026-09-08  
**Method:** Source/configuration/test review; focused mocked execution probes; no existing source files were modified.

## Scope and overall assessment

The repository has a generally sound adapter boundary: provider errors are typed, timeout cancellation is used, upstream text is intentionally excluded from persisted failure messages, and the Ollama adapter has unusually strong loopback and malformed-envelope handling. The focused adapter and application tests pass. However, several provider-facing contract fields are currently **declarative only**. Most importantly, neither the configured model fallback policy nor the separately defined routing policy is executed in production. The hosted adapter also drops caller-supplied generation controls, and two adapters can report invalid or incomplete responses as successful output. These failures undermine availability, configuration reproducibility, and the correctness of persisted provenance.

## Confirmed defects

| ID | Severity | Confidence | Finding |
|---|---|---:|---|
| PA-01 | High | High | `allow_fallback` and all preferred models after index zero are ignored; no provider failover occurs. |
| PA-02 | High | High | The routing-policy implementation is not connected to any production dispatch path. |
| PA-03 | High | High | Hosted-provider dispatch discards requested generation limits/effort/idempotency and substitutes hard-coded, provider-inconsistent controls. |
| PA-04 | High | High | `LocalProxyProvider` accepts malformed 2xx bodies—including empty output and contract-invalid scalar fields—as successful `GenerationResult`s. |
| PA-05 | High | High | Hosted Anthropic responses terminated for `max_tokens` are persisted as successful, incomplete stage output. |
| PA-06 | Medium | High | Judge results assert `position_randomized: true` although no candidate-order randomization is performed. |

### PA-01 — Requested model fallback is never executed

**Evidence.** `GenerationRequest.model_policy` explicitly carries both an ordered model list and `allow_fallback` in [`contracts/index.ts:52`](../contracts/index.ts#L52). The common stage request builder always asks for fallback (`preferred_models: ["claude-opus-5"], allow_fallback: true`) at [`core/src/stages/stage-kit.ts:311-324`](../core/src/stages/stage-kit.ts#L311-L324). Yet `HostedServerProvider.generate()` selects only `preferred_models[0]` at [`adapters/provider-hosted-server/src/index.ts:398-404`](../adapters/provider-hosted-server/src/index.ts#L398-L404), and no production source consumes `allow_fallback`. The local-proxy adapter instead uses its constructor model at [`adapters/provider-local-proxy/src/index.ts:59-64`](../adapters/provider-local-proxy/src/index.ts#L59-L64), while Ollama resolves only its option/environment model at [`adapters/provider-ollama/src/index.ts:119-137`](../adapters/provider-ollama/src/index.ts#L119-L137).

A focused probe supplied `preferred_models: ["gpt-4.1-mini", "claude-sonnet-4-5"]`, `allow_fallback: true`, configured credentials for both, and returned HTTP 503 for OpenAI. The outcome was a retriable `UNAVAILABLE` after exactly one call to `https://api.openai.com/v1/responses`; no Anthropic call was attempted.

**Impact.** A caller explicitly authorizing a fallback will still degrade on a temporary first-provider failure, even where a configured alternate could answer. The first-only implementation also makes the policy’s ordered fallback semantics misleading, makes availability plans ineffective, and makes budget/provenance unable to distinguish a failed primary from a successfully used fallback.

**Recommendation.** Make model selection an Application-level policy (rather than adapter-local implicit behavior): on an eligible classified failure, advance deterministically through `preferred_models` only if `allow_fallback` is true; preserve the idempotency key, enforce the aggregate call budget, record every attempted provider/model and final selection, and define exactly which categories may fail over. Add contract tests for first-model success, primary transient failure with fallback success, non-retriable primary failure, disabled fallback, exhausted candidates, and cross-provider model allowlisting.

### PA-02 — Routing policy exists only as pure code and configuration metadata

**Evidence.** The repository defines a complete `RoutingPolicy` and progression functions in [`core/src/routing/policy.ts:35-218`](../core/src/routing/policy.ts#L35-L218), and `Configuration.router_policy_ref` declares that it is the policy “this configuration uses” in [`contracts/configuration.schema.json:180-185`](../contracts/configuration.schema.json#L180-L185). However, repository search found no production import or call of `decideRoute`/`reduceRouteOutcome` outside `core/src/routing/policy.ts`; the only production import from the module is `admitCostJustification` in release promotion. `router_policy_ref` appears in schemas, config construction, and tests, but not in a dispatcher. Actual provider dispatch invokes a single injected provider in [`application/src/invoke.ts:69-90`](../application/src/invoke.ts#L69-L90), and pipeline stages call that shared retry routine in [`application/src/pipeline.ts:447-489`](../application/src/pipeline.ts#L447-L489).

**Impact.** A cascade/fixed routing policy can validate and be hashed into a configuration, but it cannot affect a live request. No runtime can generate the promised tier, escalation, or distribution data. This is a correctness issue for any routing-based cost/quality experiment: the configuration claims a router that the executed system does not use.

**Recommendation.** Either mark routing as pending/unsupported and reject non-null `router_policy_ref` at execution admission, or wire a `RoutingProvider`/Application dispatcher that resolves the referenced policy, validates it, calls `decideRoute`, maps classified provider/gate outcomes into `reduceRouteOutcome`, and persists final tier/escalation/cost distribution. Include routing’s worst-case escalations in `plannedCalls` and emit per-tier attempt events. Do not leave a non-null field accepted as execution metadata only.

### PA-03 — Hosted adapter ignores requested generation controls and idempotency

**Evidence.** The contract exposes `generation_options.max_tokens`, `generation_options.effort`, and `idempotency_key` at [`contracts/index.ts:52-54`](../contracts/index.ts#L52-L54). In contrast, `HostedServerProvider` converts the request to a gateway call with a fixed `temperature: 0.2` and passes none of those controls at [`adapters/provider-hosted-server/src/index.ts:403-415`](../adapters/provider-hosted-server/src/index.ts#L403-L415). The provider-specific calls hard-code `max_tokens: 4096` for Anthropic at [`adapters/provider-hosted-server/src/index.ts:318-324`](../adapters/provider-hosted-server/src/index.ts#L318-L324) and Gemini at [`adapters/provider-hosted-server/src/index.ts:326-332`](../adapters/provider-hosted-server/src/index.ts#L326-L332); OpenAI and compatible requests contain no output ceiling at [`adapters/provider-hosted-server/src/index.ts:301-316`](../adapters/provider-hosted-server/src/index.ts#L301-L316). No idempotency header/body field is built.

A focused OpenAI probe sent `max_tokens: 123`, `effort: "high"`, and `idempotency_key: "probe-idempotency"`. The upstream body was only `{model, input, temperature: 0.2}`; none of the three request controls reached the upstream call.

**Impact.** Hosted execution can exceed or undershoot the configured output/cost constraints and cannot reproduce the declared request behavior. On retries, missing upstream idempotency can also duplicate non-idempotent billable work if a request completed upstream but the response was lost. The same `GenerationRequest` thus has materially different semantics depending on adapter.

**Recommendation.** Define a provider capability descriptor (supported parameters, normalized effort mapping, max-output support, idempotency transport, and unsupported-control behavior). Translate the common request fields per provider; reject or record unsupported controls rather than silently dropping them. Pass an upstream idempotency header where supported and document the retry safety otherwise. Add request-body/header assertions for every hosted provider and a test that a requested ceiling is either honored or explicitly refused.

### PA-04 — Local Anthropic adapter treats malformed successful responses as valid output

**Evidence.** On a 2xx response, `LocalProxyProvider` casts `await res.json()` to the expected shape without runtime validation, then constructs a success unconditionally at [`adapters/provider-local-proxy/src/index.ts:129-154`](../adapters/provider-local-proxy/src/index.ts#L129-L154). It joins `data.content ?? []`, meaning a missing `content` becomes `""` rather than a failure at [`adapters/provider-local-proxy/src/index.ts:146`](../adapters/provider-local-proxy/src/index.ts#L146), and `model`, `stop_reason`, and usage values are accepted without type checks at [`adapters/provider-local-proxy/src/index.ts:148-152`](../adapters/provider-local-proxy/src/index.ts#L148-L152). The adapter’s existing tests cover valid success and only special terminal values; they contain no malformed-2xx response cases ([`adapters/provider-local-proxy/test/adapter.test.ts:98-130`](../adapters/provider-local-proxy/test/adapter.test.ts#L98-L130)).

Focused probes confirmed both outcomes: (1) `{ "model": "claude-opus-5" }` returned a successful result with `content: ""`; (2) an otherwise successful body with numeric `model: 7`, numeric `stop_reason: 9`, and string `usage.input_tokens: "two"` returned those contract-invalid values in a `GenerationResult`. A JSON parsing exception is also caught by the broad catch at [`adapters/provider-local-proxy/src/index.ts:155-159`](../adapters/provider-local-proxy/src/index.ts#L155-L159) and mislabeled `UNAVAILABLE`, even though a 2xx response arrived.

**Impact.** Blank or structurally invalid model output can be persisted as a successful revision and pass into later stages. Invalid runtime values violate the provider contract and can corrupt provenance, token accounting, schema validation, or consumers expecting strings/numbers. Misclassifying invalid JSON as a connectivity outage causes the demo path to falsely say no response was produced.

**Recommendation.** Parse 2xx bodies in a nested `try` block and validate the complete required envelope at runtime: JSON object, non-empty concatenated text, string model/finish reason if present, and finite numeric usage fields. Return `MALFORMED_RESPONSE` for invalid JSON, absent/empty text, or wrong field types; preserve the distinction that the provider answered. Add these cases to the local-proxy adapter suite, patterned after Ollama’s existing malformed-response tests.

### PA-05 — Hosted Anthropic truncation is returned as successful stage output

**Evidence.** LocalProxy specifically refuses `stop_reason === "max_tokens"` at [`adapters/provider-local-proxy/src/index.ts:136-142`](../adapters/provider-local-proxy/src/index.ts#L136-L142), and has a direct test for that behavior at [`adapters/provider-local-proxy/test/adapter.test.ts:98-107`](../adapters/provider-local-proxy/test/adapter.test.ts#L98-L107). The hosted Anthropic branch extracts text then returns `stop_reason` verbatim as a normal finish reason at [`adapters/provider-hosted-server/src/index.ts:318-324`](../adapters/provider-hosted-server/src/index.ts#L318-L324); `HostedServerProvider.generate()` consequently wraps it as success at [`adapters/provider-hosted-server/src/index.ts:416-426`](../adapters/provider-hosted-server/src/index.ts#L416-L426). There is no hosted truncation test (the sole Anthropic test uses `end_turn` at [`adapters/provider-hosted-server/test/adapter.test.ts:130-147`](../adapters/provider-hosted-server/test/adapter.test.ts#L130-L147)).

A focused mocked response with text `partial answer` and `stop_reason: "max_tokens"` yielded a successful `GenerationResult` with `finish_reason: "max_tokens"`, not a classified failure.

**Impact.** The pipeline can treat partial provider output as a clean stage artifact, persist it as `SUCCEEDED`, and feed the incomplete material into subsequent transformations. This contradicts the same project’s explicit local-proxy truncation policy and is particularly dangerous when the output is a system prompt/specification rather than a conversational partial answer.

**Recommendation.** Normalize provider terminal states before returning `GenerationResult`. Classify all known incomplete/length/max-output statuses across Anthropic, OpenAI Responses/Chat, compatible OpenAI, and Gemini consistently—either as `INVALID_REQUEST`/a dedicated incomplete-output category with safe remediation, or as a retriable failure where safely resampling is intended. Make requested output limits part of PA-03’s capability mapping, and add a parameterized cross-provider terminal-reason test suite.

### PA-06 — Judge verdict records position randomization that never occurs

**Evidence.** `JudgeRequest.position_randomized` is documented as “Candidate order, randomized by the caller” at [`contracts/index.ts:395-401`](../contracts/index.ts#L395-L401). Nevertheless, `GuardedJudge.grade()` hard-codes `position_randomized: true` in every call at [`application/src/judge.ts:127-136`](../application/src/judge.ts#L127-L136). The candidate is deterministically constructed with the original brief first and compiled prompt second at [`core/src/eval/brief-fidelity.ts:58-68`](../core/src/eval/brief-fidelity.ts#L58-L68), then sent verbatim as the sole Anthropic user message at [`adapters/provider-hosted-judge/src/index.ts:148-167`](../adapters/provider-hosted-judge/src/index.ts#L148-L167). No code permutes candidate position, and the hosted judge merely copies the supplied boolean into its verdict at [`adapters/provider-hosted-judge/src/index.ts:123-133`](../adapters/provider-hosted-judge/src/index.ts#L123-L133).

**Impact.** Stored judgement evidence makes a false methodological claim. A reader can interpret `position_randomized: true` as position-bias mitigation when all production evaluations use one fixed order. This compromises comparability and any later bias-panel/evidence interpretation.

**Recommendation.** For a single-candidate fidelity rubric, change the contract field to `false` or `null`/`not_applicable` and make the schema reflect that semantics. If the intended protocol is comparative judging, implement deterministic randomized ordering (seed and order recorded), map the score back to the original candidate, and test that both orders occur and that the verdict’s field is derived from the actual operation—not supplied as an assertion.

## Risks and maintainability improvements

### PA-R01 — Retry boundary assumes every provider honors the typed-failure contract

**Classification:** Reliability risk / improvement idea. **Severity:** Medium. **Confidence:** High.

`invokeWithRetry()` directly awaits `opts.provider.generate(request)` without a catch at [`application/src/invoke.ts:69-89`](../application/src/invoke.ts#L69-L89). The pipeline catches a thrown transport exception only outside the shared retry loop and marks the stage failed without retrying at [`application/src/pipeline.ts:454-475`](../application/src/pipeline.ts#L454-L475); the single-stage `Orchestrator` path does not catch it around the shared call at [`application/src/orchestrator.ts:128-131`](../application/src/orchestrator.ts#L128-L131). Current first-party adapters generally translate their own expected fetch failures, so this is not demonstrated as an active first-party failure. It remains a fragile external integration boundary: a future adapter, decorator, JSON/body reader, or an injected provider that throws bypasses classified retry/degradation semantics, and API callers receive a generic 500.

**Recommendation.** Make `invokeWithRetry()` the total boundary: catch unexpected throws, sanitize them, convert to a typed retriable/non-retriable `ProviderFailure` according to a documented policy, emit the failed attempt, and retain the original exception only in an internal diagnostic channel. Add a test provider that throws on the first call and succeeds on the second, plus a terminal-throw test asserting a labelled degraded outcome rather than an uncaught request failure.

### PA-R02 — Provider capabilities are implicit and duplicated across adapters

**Classification:** Maintainability/reliability improvement. **Severity:** Medium. **Confidence:** High.

The shared request exposes generic policies and controls ([`contracts/index.ts:33-55`](../contracts/index.ts#L33-L55)), while adapters silently impose incompatible behavior: local proxy fixes an Anthropic model in its constructor ([`adapters/provider-local-proxy/src/index.ts:59-64`](../adapters/provider-local-proxy/src/index.ts#L59-L64)), Ollama maps only `max_tokens` to `num_predict` ([`adapters/provider-ollama/src/index.ts:180-190`](../adapters/provider-ollama/src/index.ts#L180-L190)), and hosted provider inference relies on model-name prefixes ([`adapters/provider-hosted-server/src/index.ts:341-345`](../adapters/provider-hosted-server/src/index.ts#L341-L345)). The current contract has no capability declaration to tell callers whether a provider supports a selected model, system turns, effort/reasoning controls, output ceilings, idempotency, streaming, or fallback.

**Recommendation.** Introduce a compact, runtime-queryable provider capability model and a validation/admission step before dispatch. Keep model/provider mapping and control translation in one registry shared by hosted routing and health checks. Report negotiated/effective parameters in provenance. This reduces silent semantic differences and makes new provider integrations testable against a common conformance matrix.

## Validation performed

| Check | Result |
|---|---|
| `npm test -- --run adapters/provider-local-proxy/test/adapter.test.ts adapters/provider-ollama/test/adapter.test.ts adapters/provider-hosted-server/test/adapter.test.ts adapters/provider-hosted-judge/test/adapter.test.ts application/test/provider-admission.test.ts application/test/judge.test.ts application/test/judge-bundle.test.ts core/test/routing.test.ts` | Passed: 8 files, 162 tests. |
| `npm run typecheck` | Passed (`tsc --noEmit`). |
| Focused mocked TypeScript probe in `/home/ubuntu/jobs/job_WjWbJVei_a3/provider-probe-fixed.ts` | Confirmed no hosted fallback attempt, discarded hosted controls, hosted Anthropic truncation accepted, and local-proxy malformed 2xx accepted. |
| Repository search for `allow_fallback`, routing function imports/calls, and `router_policy_ref` use | Confirmed unconsumed fallback flag and absent production routing execution path. |

## Positive controls observed

The audit also confirmed several safeguards that should be preserved: all tested provider adapters avoid including upstream error bodies in `safe_message`; `OllamaProvider` restricts requests to literal loopback hosts and classifies non-JSON/missing/empty 2xx responses as `MALFORMED_RESPONSE` ([`adapters/provider-ollama/src/index.ts:157-243`](../adapters/provider-ollama/src/index.ts#L157-L243)); and retries are centralized in the Application layer for typed retriable failures ([`application/src/invoke.ts:59-92`](../application/src/invoke.ts#L59-L92)).
