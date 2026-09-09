# Minimum-Change Remediation Strategy — 2026-09-09

## Objective

Fix the audit findings with the smallest possible changes while preserving existing successful-path behavior and avoiding changes to core execution logic, routing algorithms, pipeline planning, or provider-selection behavior.

The recommended approach is to harden system boundaries:

- Validate inputs before they enter execution.
- Validate provider outputs before they enter the application.
- Correct misleading evidence at the reporting boundary.
- Reject unsupported combinations instead of implementing new behavior.
- Avoid modifications to `core/src` unless a contract requires a boundary-only change.

## Strategy by finding

| Finding | Minimum-change treatment | Core logic change? | Recommendation |
|---|---|---:|---|
| Invalid or empty evaluation suites | Add shared CLI input validation | No | Fix immediately |
| Incorrect `--compare` behavior | Reject unsupported flag combinations | No | Fix immediately |
| Malformed local provider output | Add adapter response validation | No | Fix immediately |
| Hosted truncation treated as success | Normalize at the hosted adapter boundary | No | Fix immediately |
| False judge randomization evidence | Record `false` instead of `true` | No | Fix immediately |
| Stale README test count | Correct or remove the hard-coded count | No | Fix immediately |
| Missing coverage gate | Add reporting only, without a threshold initially | No | Later phase |
| Model fallback not implemented | Reject or flag unsupported fallback requests | No, if done at admission | Contain, do not implement fallback yet |
| Routing policy not connected | Reject unsupported routing references | No, if done at admission | Contain, do not wire routing yet |
| Retry exceptions bypass retry policy | Normalize exceptions at the application boundary | Minimal application change | Optional second phase |

## Phase 1 — Evidence integrity

### 1. Shared evaluation-suite loader

Create a small utility under `scripts/`, such as `scripts/load-eval-suite.ts`, and use it from:

- `scripts/run-eval.ts`
- `scripts/run-pipeline-eval.ts`
- `scripts/run-adversarial.ts`

The loader should read the JSON file, validate it against `contracts/eval-suite.schema.json`, require at least one case, reject duplicate IDs, verify exact equality between `suite.case_ids` and `cases[].case_id`, and return cases in declared ID order. Malformed input should return exit code `2`.

Add CLI-level regressions for empty suites, duplicate IDs, missing declared cases, undeclared cases, duplicate case objects, and zero-case pipeline suites. Existing valid fixtures should produce unchanged results.

This is the highest-value first change because it prevents invalid input from reaching scoring, pipeline, provider, or core logic.

### 2. Reject unsupported compare combinations

Add early argument validation in `scripts/run-eval.ts` for:

```text
--local --compare
--live --compare
```

Reject both combinations before provider creation or network access. The message should explain that `--compare` currently supports only the pinned offline comparison harness.

Do not redesign live/local comparison in this minimum-change patch. Passing a live provider through comparison would require broader changes to provider factories, cache policy, filtering, budget accounting, provenance, and result manifests.

## Phase 2 — Provider boundaries

### 3. Harden the local proxy response parser

Modify only `adapters/provider-local-proxy/src/index.ts` for this behavior. On a successful HTTP response, validate that the parsed value is an object, content exists and contains non-empty text, model and stop reason are correctly typed when present, and usage values are finite numbers when present.

Use the existing `MALFORMED_RESPONSE` category authorized by ADR-0014. Parse and validate inside a nested response-validation boundary so malformed 2xx JSON is not mislabeled as a connection failure.

Add tests for malformed JSON, missing content, empty text, wrong model type, invalid usage values, and unchanged valid responses.

### 4. Normalize hosted truncation

Modify only `adapters/provider-hosted-server/src/index.ts` for known incomplete terminal states such as `stop_reason === "max_tokens"`. Convert these states into the existing typed incomplete/malformed response classification instead of returning normal success.

Add tests confirming Anthropic `end_turn` remains successful while `max_tokens` is classified as incomplete/failure.

## Phase 3 — Provenance and documentation

### 5. Correct judge randomization evidence

Change the application-level assignment in `application/src/judge.ts` from:

```ts
position_randomized: true
```

to:

```ts
position_randomized: false
```

Add a regression test proving that the verdict reflects the actual deterministic ordering. Do not implement randomization in this patch; real randomization would require a deterministic seed, recorded candidate order, score remapping, and new calibration tests.

### 6. Remove the stale exact test count

Replace the stale README claim of `929 tests` with `the Vitest test suite`, unless generated count enforcement is intentionally added later. Removing the volatile number is the lowest-risk documentation fix.

## Phase 4 — Contain unsupported features

### 7. Model fallback

Do not implement fallback inside an adapter. Fallback belongs in application orchestration because it requires retry classification, aggregate call-budget accounting, idempotency, model/provider provenance, and deterministic ordering.

Until that design is implemented, reject requests that combine multiple preferred models with `allow_fallback: true` at the application/provider admission boundary, or explicitly mark fallback as requested but not executed. Rejection is safer for externally supplied configuration.

### 8. Routing policy

Do not connect routing algorithms to the live pipeline in the minimum-change patch. At configuration admission, reject non-null `router_policy_ref` for execution paths that do not support it. This avoids silently accepting metadata that cannot affect runtime behavior. Leave `core/src/routing/policy.ts` unchanged.

## Optional second phase — Exception normalization

After confirming the failure contract, wrap provider invocation at `application/src/invoke.ts` so unexpected adapter exceptions become typed failures rather than bypassing shared retry behavior. This is lower priority than evaluation and provenance integrity.

## Recommended commit sequence

Keep each patch independently reviewable:

1. `fix: validate evaluation suite populations`
2. `fix: reject unsupported compare modes`
3. `fix: validate local provider responses`
4. `fix: classify hosted truncation consistently`
5. `fix: correct judge randomization provenance`
6. `docs: remove stale test count`
7. `guard: reject unsupported fallback and routing configuration`

Run after each commit:

```bash
npm test
npm run verify
```

## Final recommendation

Begin with the four boundary-only changes:

1. Shared evaluation-suite validation.
2. Early rejection of local/live compare modes.
3. Local and hosted adapter response validation.
4. `position_randomized: false`.

These changes should not alter normal successful-path results. They reject invalid inputs earlier, reject misleading command combinations, classify incomplete provider output correctly, and correct false provenance. Defer actual fallback and routing implementation until their application-level semantics are designed; rejecting or fencing off unsupported configuration is safer than pretending those features work.
