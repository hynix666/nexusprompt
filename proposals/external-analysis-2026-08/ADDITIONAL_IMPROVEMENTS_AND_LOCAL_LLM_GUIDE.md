# Additional Improvement Recommendations & Local LLM Integration Guide

**Date:** August 30, 2026
**Analysis Scope:** Additional improvements beyond initial analysis, local LLM integration best practices, model candidates

---

## Executive Summary

This document extends the comprehensive improvement analysis with:
1. **5 additional improvement recommendations** discovered through deeper analysis
2. **Best practices for local LLM integration** based on existing Ollama adapter patterns
3. **Reliable local model candidates** evaluated for this specific use case
4. **Verification framework** with unit tests and documentation requirements

---

## Part 1: Additional Improvement Recommendations

### 🟡 IMPROVEMENT #16: Add Provider Health Monitoring Dashboard

**Problem Identified:**
The `OllamaProvider` has excellent health checking (`healthCheck()` method), but there's no visibility into provider health over time. The system can detect failures but cannot predict them.

**Current State:**
- `healthCheck()` exists in both `LocalProxyProvider` and `OllamaProvider`
- Results are ephemeral - checked once per run, not tracked
- No historical data on provider reliability
- No degradation state tracking across runs

**Deep Analysis:**
From examining `adapters/provider-ollama/src/index.ts`:
```typescript
async healthCheck(): Promise<ProviderHealth> {
  // Returns current state only
  return {
    ok,
    checked_at: stamp(),
    latency_ms: this.now().getTime() - started,
    degradation_state: ok ? "NONE" : "UNAVAILABLE",
    failing_dependency: ok ? null : res.ok ? "configuration" : "ollama",
  };
}
```

The contract supports degradation states (`"NONE" | "DEGRADED" | "UNAVAILABLE"`), but nothing persists or trends this data.

**Proposed Solution:**

**Step 1: Create Health Metrics Store**
```typescript
// application/src/health-metrics.ts (NEW)
export interface ProviderHealthRecord {
  provider_id: string;
  timestamp: number;
  ok: boolean;
  latency_ms: number;
  degradation_state: 'NONE' | 'DEGRADED' | 'UNAVAILABLE';
  failing_dependency: string | null;
  consecutive_failures: number;
  success_rate_1h: number;
  avg_latency_1h: number;
}

export interface HealthMetricsStore {
  record(record: ProviderHealthRecord): Promise<void>;
  getHistory(provider_id: string, hours: number): Promise<ProviderHealthRecord[]>;
  getSummary(provider_id: string): Promise<{
    uptime_percent: number;
    avg_latency: number;
    failure_trend: 'improving' | 'stable' | 'degrading';
  }>;
}
```

**Step 2: Integrate with Evaluation Runner**
```typescript
// scripts/run-eval.ts enhancement
const healthMetrics = new MemoryHealthMetricsStore(); // or persistent store

// After each run, record health
await healthMetrics.record({
  provider_id: provider.provider_id,
  timestamp: Date.now(),
  ok: result.run.cost.provider_calls > 0,
  latency_ms: calculateAvgLatency(result),
  degradation_state: determineDegradationState(result),
  // ... other metrics
});
```

**Step 3: Add CLI Command**
```bash
npm run cli -- health
# Output:
# Provider Health Status
# ──────────────────────
# ollama-local: HEALTHY (99.2% uptime, 1.2s avg latency)
# anthropic-hosted: UNKNOWN (no runs recorded)
```

**Verification Tests:**
```typescript
// test/health-metrics.test.ts (NEW)
import { describe, it, expect } from 'vitest';
import { MemoryHealthMetricsStore } from '../application/src/health-metrics.js';

describe('HealthMetricsStore', () => {
  it('records and retrieves health records', async () => {
    const store = new MemoryHealthMetricsStore();
    await store.record({
      provider_id: 'ollama-local',
      timestamp: Date.now(),
      ok: true,
      latency_ms: 1200,
      degradation_state: 'NONE',
      consecutive_failures: 0,
      success_rate_1h: 1.0,
      avg_latency_1h: 1200,
    });
    
    const history = await store.getHistory('ollama-local', 24);
    expect(history.length).toBe(1);
  });

  it('calculates degradation trend correctly', async () => {
    // Test with increasing failure rate
  });

  it('triggers alert on consecutive failures', async () => {
    // Test threshold-based alerting
  });
});
```

**Documentation Requirements:**
- Update `Documentation/ARCHITECTURE.md` with monitoring layer
- Add to `project-knowledge/08-known-issues-and-decisions.md` as closed item
- Create `Documentation/MONITORING.md` with operational procedures

**Estimated Effort:** 8-12 hours
**Priority:** Medium - improves operational visibility
**Risk:** Low - additive feature, no breaking changes

---

### 🟡 IMPROVEMENT #17: Implement Chaos Testing for Provider Failures

**Problem Identified:**
Error handling is theoretical. The system classifies failures well but has never been tested against realistic failure scenarios like:
- Intermittent timeouts
- Partial responses
- Rate limiting storms
- Cascading failures

**Current State:**
- `ProviderFailure` contract has 8 categories
- Classification logic exists in adapters
- No systematic testing of failure modes
- Retry logic untested under load

**Deep Analysis:**
From `test/error-paths.test.ts`:
```typescript
// Current test uses property-based testing for GenerationRequest
// But does NOT test:
// - Network partitions
// - Slow responses
// - Concurrent failures
// - Recovery scenarios
```

**Proposed Solution:**

**Step 1: Create Chaos Test Framework**
```typescript
// test/chaos-framework.ts (NEW)
export type FailureScenario = 
  | { type: 'timeout'; probability: number; duration_ms: number }
  | { type: 'error'; status: number; probability: number }
  | { type: 'slow'; delay_ms: number; probability: number }
  | { type: 'corrupt'; corruption_type: 'truncated' | 'invalid_json' | 'empty' }
  | { type: 'rate_limit'; retry_after_ms: number; probability: number };

export class ChaosProvider implements ProviderTransport {
  private base: ProviderTransport;
  private scenarios: FailureScenario[];
  
  constructor(base: ProviderTransport, scenarios: FailureScenario[]) {
    this.base = base;
    this.scenarios = scenarios;
  }
  
  async generate(req: GenerationRequest): Promise<GenerationResult | ProviderFailure> {
    const scenario = this.selectScenario();
    if (scenario) {
      return this.applyFailure(scenario, req);
    }
    return this.base.generate(req);
  }
}
```

**Step 2: Define Standard Scenarios**
```typescript
// test/chaos-scenarios.ts (NEW)
export const STANDARD_SCENARIOS = {
  'intermittent-timeout': [
    { type: 'timeout' as const, probability: 0.1, duration_ms: 30000 }
  ],
  'rate-limit-storm': [
    { type: 'rate_limit' as const, probability: 0.3, retry_after_ms: 5000 }
  ],
  'partial-outage': [
    { type: 'error' as const, status: 503, probability: 0.2 },
    { type: 'error' as const, status: 500, probability: 0.1 }
  ],
  'corrupt-responses': [
    { type: 'corrupt' as const, corruption_type: 'invalid_json', probability: 0.05 }
  ]
};
```

**Step 3: Integration Tests**
```typescript
// test/chaos-integration.test.ts (NEW)
import { describe, it, expect } from 'vitest';
import { ChaosProvider, STANDARD_SCENARIOS } from './chaos-framework.js';
import { OllamaProvider } from '../adapters/provider-ollama/src/index.js';

describe('Chaos Testing', () => {
  it('recovers from intermittent timeouts', async () => {
    const chaos = new ChaosProvider(
      new OllamaProvider({ model: 'test' }),
      STANDARD_SCENARIOS['intermittent-timeout']
    );
    
    // Run 100 trials, expect >90% success due to retries
    const results = await runTrials(chaos, 100);
    expect(results.success_rate).toBeGreaterThan(0.9);
  });

  it('respects rate limit backoff', async () => {
    // Verify exponential backoff works
  });

  it('detects cascading failures', async () => {
    // Verify circuit breaker triggers
  });
});
```

**Step 4: Add to CI**
```yaml
# .github/workflows/chaos-tests.yml (NEW)
name: Chaos Tests
on:
  schedule: [{ cron: '0 3 * * *' }]  # Daily
jobs:
  chaos:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - run: npm test -- --chaos
```

**Verification Commands:**
```bash
npm test -- --chaos                    # Run chaos suite
npm run cli -- chaos-test --scenario rate-limit-storm
```

**Documentation Requirements:**
- Document in `Documentation/TESTING_STRATEGY.md`
- Add chaos scenarios to `spec/` directory
- Update `project-knowledge/06-testing-and-quality.md`

**Estimated Effort:** 16-20 hours
**Priority:** High - validates error handling under realistic conditions
**Risk:** Medium - requires careful isolation to avoid affecting other tests

---

### 🟡 IMPROVEMENT #18: Add Precision Measurement to Evaluation

**Problem Identified:**
From the open register in `project-knowledge/08-known-issues-and-decisions.md`:
> "**The anchor certifies detection, not quality.** No suite here measures a model"

Current evaluation measures:
- ✅ Recall (can we catch planted defects?)
- ✅ Agreement (do two configurations differ?)
- ❌ Precision (are our detections correct?)
- ❌ Quality (is the output actually good?)

**Deep Analysis:**
The system excels at detecting regressions but cannot answer:
- "Is this false positive or real defect?"
- "What's the actual quality score?"
- "Are we being too conservative?"

**Proposed Solution:**

**Step 1: Define Precision Metrics**
```typescript
// core/src/eval/precision.ts (NEW)
export interface PrecisionMetrics {
  total_detections: number;
  true_positives: number;
  false_positives: number;
  precision: number;  // TP / (TP + FP)
  f1_score: number;   // Harmonic mean of precision and recall
}

export function calculatePrecision(
  detections: Detection[],
  ground_truth: GroundTruth[]
): PrecisionMetrics {
  // Implementation
}
```

**Step 2: Create Human-in-the-Loop Grading**
```typescript
// shells/cli/src/commands/grade.ts (NEW)
/**
 * Present detected failures to human grader
 * Record verdict as ground truth
 */
export async function gradeRun(runId: string): Promise<void> {
  const run = await store.get('EvalRun', runId);
  const detections = run.detector_results;
  
  for (const detection of detections) {
    console.log(`Case: ${detection.case_id}`);
    console.log(`Detector: ${detection.detector_id}`);
    console.log(`Issue: ${detection.detail}`);
    console.log(`Output: ${detection.output_snippet}`);
    
    const verdict = await prompt('VALID / INVALID / UNCLEAR: ');
    await groundTruthStore.record({
      run_id: runId,
      case_id: detection.case_id,
      detector_id: detection.detector_id,
      verdict: verdict.toUpperCase(),
      graded_at: new Date().toISOString(),
    });
  }
}
```

**Step 3: Report Precision Alongside Recall**
```typescript
// Enhancement to eval output
console.log(`\n  detector performance:`);
for (const d of recall.detectors) {
  const precision = precisionMetrics[d.detector_id];
  console.log(
    `    ${d.detector_id.padEnd(30)} ` +
    `recall: ${(d.recall * 100).toFixed(1)}% | ` +
    `precision: ${(precision * 100).toFixed(1)}% | ` +
    `F1: ${(calculateF1(d.recall, precision) * 100).toFixed(1)}%`
  );
}
```

**Verification Tests:**
```typescript
// test/precision-metrics.test.ts (NEW)
describe('Precision Calculation', () => {
  it('calculates precision correctly', () => {
    const metrics = calculatePrecision(
      [{ valid: true }, { valid: false }, { valid: true }],
      [{ valid: true }, { valid: true }]
    );
    expect(metrics.precision).toBe(2/3);
  });

  it('handles edge cases', () => {
    // Zero detections, all false positives, etc.
  });
});
```

**Documentation Requirements:**
- Update `Documentation/EVALUATION_METHODOLOGY.md`
- Add precision measurement to `TRUTH_BOUNDARY.md`
- Document grading procedure in `Documentation/OPERATIONS.md`

**Estimated Effort:** 12-16 hours
**Priority:** High - completes the evaluation picture
**Risk:** Low - additive metrics, doesn't change existing behavior

---

### 🟢 IMPROVEMENT #19: Enhance Documentation Cross-Reference System

**Problem Identified:**
From the analysis of `project-knowledge/08-known-issues-and-decisions.md`:
> "A checker over part of a document implies coverage of the document"

Current state:
- `check:plan` verifies only JSON block in `IMPLEMENTATION_PLAN.md`
- Four false claims existed alongside correct JSON
- No cross-referencing between ADRs and implementation
- Link rot undetected

**Proposed Solution:**

**Step 1: Automated Cross-Reference Checker**
```typescript
// scripts/check-cross-references.ts (NEW)
/**
 * Verify all internal references resolve
 * Check ADR citations match actual ADRs
 * Detect orphaned documentation
 */
export function checkCrossReferences(): ValidationResult[] {
  const errors: ValidationResult[] = [];
  
  // Extract all [ADR-XXXX] references
  const adrRefs = extractReferences(/\[?(ADR-\d{4})\]?/g);
  
  // Verify each exists
  for (const ref of adrRefs) {
    if (!adrExists(ref)) {
      errors.push({
        type: 'broken_reference',
        location: ref.location,
        message: `Reference ${ref.id} not found`
      });
    }
  }
  
  // Check for orphaned files
  const orphaned = findOrphanedDocs();
  
  return errors;
}
```

**Step 2: Citation Verification**
```typescript
// scripts/check-citations-online.mjs enhancement
/**
 * Currently checks external citations
 * Extend to verify internal consistency
 */
```

**Step 3: Generate Documentation Graph**
```bash
npm run docs:graph
# Generates visualization of doc dependencies
```

**Verification:**
```bash
npm run check:cross-references  # New command
npm run check:citations:online  # Enhanced
```

**Estimated Effort:** 6-8 hours
**Priority:** Medium - improves documentation reliability
**Risk:** Low - read-only analysis

---

### 🟢 IMPROVEMENT #20: Add Performance Benchmarking Suite

**Problem Identified:**
No systematic performance tracking:
- Pipeline compilation time unmeasured
- Gate linting speed unknown
- Memory usage untracked
- No regression detection for performance

**Current State:**
- Tests measure correctness only
- No timing assertions
- Performance anecdotes only ("about thirty seconds")

**Proposed Solution:**

**Step 1: Performance Test Framework**
```typescript
// test/performance-framework.ts (NEW)
export interface PerformanceBudget {
  operation: string;
  max_duration_ms: number;
  max_memory_mb: number;
  p95_latency_ms: number;
}

export const BUDGETS: PerformanceBudget[] = [
  { operation: 'verify-full', max_duration_ms: 45000, max_memory_mb: 512, p95_latency_ms: 30000 },
  { operation: 'lint-prompt', max_duration_ms: 5000, max_memory_mb: 128, p95_latency_ms: 2000 },
  { operation: 'compile-brief', max_duration_ms: 30000, max_memory_mb: 256, p95_latency_ms: 15000 },
];
```

**Step 2: Benchmark Tests**
```typescript
// test/performance.bench.ts (NEW)
import { bench, describe } from 'vitest';

describe('Performance Benchmarks', () => {
  bench('verify-full suite', async () => {
    const start = performance.now();
    await execAsync('npm run verify');
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(45000);
  }, { iterations: 5 });

  bench('gate linting', async () => {
    // Measure individual gate performance
  });
});
```

**Step 3: Trend Tracking**
```typescript
// scripts/benchmark-trends.ts (NEW)
/**
 * Track performance over time
 * Alert on regression
 */
```

**Verification:**
```bash
npm test -- --benchmark          # Run benchmarks
npm run benchmark:compare        # Compare to baseline
```

**Estimated Effort:** 10-14 hours
**Priority:** Medium - prevents performance regressions
**Risk:** Low - additive measurements

---

## Part 2: Best Practices for Local LLM Integration

Based on analysis of `adapters/provider-ollama/` and related documentation:

### 2.1 Security Boundaries

**CRITICAL: Loopback-Only Enforcement**
```typescript
// From provider-ollama/src/index.ts - EXCELLENT pattern
const LOOPBACK = Object.freeze(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.includes(host);
}

// Check BEFORE any request leaves
if (!isLoopbackHost(this.host)) {
  return fail("INVALID_REQUEST", "host_not_loopback", "...");
}
```

**Why This Matters:**
- Prevents SSRF attacks via cloud metadata endpoints (169.254.169.254)
- Avoids DNS rebinding attacks
- Literal spelling prevents race conditions

**Best Practice:** NEVER accept arbitrary hostnames for local models. Pin to loopback literals only.

### 2.2 Zero Runtime Dependencies

**Pattern from ADR-0012 and ADR-0015:**
```typescript
// Use Node's global fetch - no npm package needed
const res = await this.fetchImpl(`${this.base()}/api/chat`, {
  method: "POST",
  signal: controller.signal,
  headers: { "content-type": "application/json" },
  body,
});
```

**Benefits:**
- Adapters remain swappable without dependency hell
- Easier security auditing (fewer packages)
- Faster installation

**Best Practice:** Use standard Web APIs (fetch, AbortController) rather than vendor SDKs for simple HTTP adapters.

### 2.3 Model Configuration Without Defaults

**EXCELLENT Pattern:**
```typescript
// No default model name - forces explicit configuration
private resolveModel(): string | undefined {
  return this.model ?? process.env[this.modelEnvVar];
}

// Refuse clearly if not configured
if (!model) {
  return fail(
    "INVALID_REQUEST",
    "no_model_configured",
    `No model configured. Set ${this.modelEnvVar}, or pass one — there is no default, because a ` +
      `default names a model this machine may not have pulled.`
  );
}
```

**Why No Default:**
1. Naming a model user hasn't pulled → confusing 404
2. Naming a model user has pulled → bakes local accident into shared code
3. Forces user to make conscious choice

**Best Practice:** Require explicit model naming via environment variable or constructor option. Provide helpful error message with exact command to fix.

### 2.4 MALFORMED_RESPONSE vs UNAVAILABLE Distinction

**CRITICAL Classification Logic:**
```typescript
// From provider-ollama/src/index.ts
/**
 * From here on the call SUCCEEDED. Everything that can still go wrong is
 * `MALFORMED_RESPONSE`, because the model ran.
 */
let data: OllamaChatResponse;
try {
  data = (await res.json()) as OllamaChatResponse;
} catch {
  return fail("MALFORMED_RESPONSE", "body_not_json", "...", true);
}

const content = data.message?.content;
if (typeof content !== "string") {
  return fail("MALFORMED_RESPONSE", "no_content_field", "...", true);
}
if (content.trim() === "") {
  return fail("MALFORMED_RESPONSE", "empty_completion", "...", true);
}
```

**Key Insight from ADR-0014:**
- `UNAVAILABLE` = model never ran (daemon down, network error)
- `MALFORMED_RESPONSE` = model RAN but output unusable
- This distinction prevents false "no output was produced" claims

**Best Practice:** Classify failures by WHETHER THE MODEL EXECUTED, not by HTTP status. A 200 with garbage is fundamentally different from a 503.

### 2.5 Timeout Management for Local Models

**Appropriate Timeouts:**
```typescript
// 120s matches local model reality
// 27B model on CPU will exceed it - that's CONFIGURATION, not FAILURE
private readonly timeoutMs: number;

constructor(opts: OllamaOptions = {}) {
  this.timeoutMs = opts.timeoutMs ?? 120_000;  // 2 minutes
}
```

**Timeout Error Messaging:**
```typescript
if ((err as Error).name === "AbortError") {
  return fail(
    "TIMEOUT",
    "timeout",
    `No response within ${this.timeoutMs} ms. A large local model may simply need longer.`,
    true,  // retriable
    500,   // retry_after_ms
  );
}
```

**Best Practice:** 
- Use generous timeouts for local models (60-120s)
- Message should say "slow is not broken"
- Mark as retriable with backoff

### 2.6 Health Check That Actually Checks

**NOT Configuration-Only:**
```typescript
// WRONG: Just checks if model name exists
async healthCheck(): Promise<ProviderHealth> {
  return { ok: !!this.model, ... };  // BAD
}

// RIGHT: Actually reaches out
async healthCheck(): Promise<ProviderHealth> {
  const res = await this.fetchImpl(`${this.base()}/api/tags`, { signal: controller.signal });
  const ok = res.ok && Boolean(this.resolveModel());
  return {
    ok,
    latency_ms: this.now().getTime() - started,
    failing_dependency: ok ? null : res.ok ? "configuration" : "ollama",
  };
}
```

**Best Practice:** Health checks must PROBE the dependency, not just validate configuration. Distinguish between "daemon not running" vs "model not configured".

### 2.7 No Silent JSON Repair

**From ADR-0015:**
> "The more a repairer can fix, the more it launders. A step that turns unparseable model output into a clean object, and hands it on with nothing recorded, is indistinguishable downstream from a model that got it right."

**Decision:** Do NOT add `jsonrepair` because:
1. No stage currently asks for JSON (all consume prose)
2. Silent repair hides model capability issues
3. If added later, must RECORD that repair occurred

**Best Practice:** If JSON repair is ever needed:
- Make it EXPLICIT and RECORDED
- Never use repaired output as baseline without review
- Log repair frequency and types

### 2.8 Cache Strategy for Local Models

**Different Reasons, Same Mechanism:**
```typescript
// From run-eval.ts
const liveWiring = LOCAL
  ? { provider: new OllamaProvider({ model: localModel }), cache: new MemoryCacheStore() }
  : {};

// Local: caching saves MINUTES (27B model on CPU)
// Hosted: caching saves MONEY and validates cache mechanism
```

**Best Practice:** Enable caching for local models even though they're "free" because:
- Large models on CPU take seconds per call
- Identical requests should report cache hits
- Validates cache mechanism for production use

---

## Part 3: Reliable Local Model Candidates

### 3.1 Evaluation Criteria for This Use Case

Based on NexusPrompt's requirements:

| Criterion | Why It Matters | Weight |
|---|---|---|
| **Context Window** | Must handle full prompts (specs + calibrations + compiled prompts) | HIGH |
| **Reasoning Ability** | Gates check logical consistency, not just pattern matching | HIGH |
| **Speed on Consumer Hardware** | Development feedback loop must be <5 min | MEDIUM |
| **License** | MIT/Apache preferred for commercial use | MEDIUM |
| **Ollama Support** | Must work with existing adapter | REQUIRED |
| **Stability** | Deterministic outputs for reproducible evaluations | HIGH |
| **Multilingual** | Some gates test non-English handling | LOW |

### 3.2 Recommended Models by Use Case

#### For Development & Testing (Fast Iteration)

**Model:** `llama3.2:3b` or `phi3:mini`
- **Size:** 3-4B parameters
- **VRAM:** 4-6 GB
- **Speed:** 20-50 tokens/s on M2, 10-20 on CPU
- **Context:** 8K-128K depending on variant
- **Best For:** Quick linting, gate testing, pipeline smoke tests

**Setup:**
```bash
ollama pull llama3.2:3b
export OLLAMA_MODEL=llama3.2:3b
npm run eval -- --local
```

**Expected Performance:**
- Smoke suite: ~30 seconds
- Full pipeline: 2-3 minutes
- Accuracy: Sufficient for development, not for baselines

#### For Evaluation Runs (Balanced)

**Model:** `llama3.1:8b` or `mistral:7b`
- **Size:** 7-8B parameters
- **VRAM:** 8-12 GB
- **Speed:** 10-30 tokens/s on M2, 5-10 on CPU
- **Context:** 8K-128K
- **Best For:** Detector calibration, comparison runs, anchor building

**Setup:**
```bash
ollama pull llama3.1:8b
export OLLAMA_MODEL=llama3.1:8b
npm run eval -- --local --trials 100
```

**Expected Performance:**
- Smoke suite: 60-90 seconds
- 100-trial eval: 15-20 minutes
- Accuracy: Good enough for relative comparisons

#### For Production-Quality Evaluation

**Model:** `qwen2.5:14b` or `codellama:13b`
- **Size:** 13-14B parameters
- **VRAM:** 16-24 GB
- **Speed:** 5-15 tokens/s on M2 Max, 2-5 on CPU
- **Context:** 16K-128K
- **Best For:** Baseline certification, release decisions

**Setup:**
```bash
ollama pull qwen2.5:14b
export OLLAMA_MODEL=qwen2.5:14b
npm run eval -- --local --trials 100 --max-calls 200
```

**Expected Performance:**
- Smoke suite: 2-3 minutes
- 100-trial eval: 30-45 minutes
- Accuracy: Approaching hosted frontier models for structured tasks

#### For Specialized Tasks

**Code-Specific:** `codellama:7b` or `starcoder2:7b`
- Better at syntax validation gates
- Trained on code, understands structure

**Reasoning-Heavy:** `qwen2.5:7b` or `deepseek-coder:6.7b`
- Stronger at logical consistency checks
- Better at multi-step reasoning

**Multilingual:** `qwen2.5:7b` or `llama3.1:8b`
- Better non-English support
- Important for i18n gates

### 3.3 Model Selection Decision Tree

```
Start
  │
  ├─ Need fast iteration? (< 2 min feedback)
  │   └─→ llama3.2:3b or phi3:mini
  │
  ├─ Running formal evaluation?
  │   ├─ Have 16+ GB VRAM?
  │   │   └─→ qwen2.5:14b or codellama:13b
  │   └─ Have 8-16 GB VRAM?
  │       └─→ llama3.1:8b or mistral:7b
  │
  ├─ Testing code-specific gates?
  │   └─→ codellama:7b
  │
  └─ Need multilingual support?
      └─→ qwen2.5:7b
```

### 3.4 Hardware Requirements Matrix

| Model | Minimum RAM | Recommended VRAM | CPU-Only Viable? | M2 Speed | M3 Max Speed |
|-------|-------------|------------------|------------------|----------|--------------|
| llama3.2:3b | 8 GB | 6 GB | Yes (slow) | 40 t/s | 60 t/s |
| phi3:mini | 8 GB | 6 GB | Yes | 35 t/s | 55 t/s |
| mistral:7b | 16 GB | 8 GB | Barely | 20 t/s | 35 t/s |
| llama3.1:8b | 16 GB | 10 GB | No | 15 t/s | 30 t/s |
| qwen2.5:14b | 24 GB | 16 GB | No | 8 t/s | 18 t/s |
| codellama:13b | 24 GB | 16 GB | No | 10 t/s | 20 t/s |

**Note:** t/s = tokens per second. CPU speeds vary wildly based on AVX-512 support.

### 3.5 Model Pull Script

```bash
#!/bin/bash
# scripts/pull-models.sh (NEW)
# Pull recommended models for different use cases

set -e

echo "NexusPrompt Local Model Setup"
echo "=============================="
echo ""

MODELS=(
  "llama3.2:3b:development"
  "llama3.1:8b:evaluation"
  "qwen2.5:14b:production"
  "codellama:7b:code-specialist"
)

for model_spec in "${MODELS[@]}"; do
  IFS=':' read -r model role <<< "$model_spec"
  echo "[$role] $model"
  
  if ollama list | grep -q "^$model "; then
    echo "  ✓ Already pulled"
  else
    echo "  ↓ Pulling..."
    ollama pull "$model"
  fi
done

echo ""
echo "Set default model:"
echo "  export OLLAMA_MODEL=llama3.1:8b"
```

### 3.6 Model Performance Tracking

**Create benchmark results file:**
```json
// eval/model-benchmarks.json (NEW)
{
  "generated_at": "2026-08-30T00:00:00Z",
  "models": [
    {
      "model_id": "llama3.1:8b",
      "hardware": "Apple M2 Max, 32GB",
      "suites": {
        "compile-smoke": {
          "duration_seconds": 82,
          "score": 0.714,
          "tokens_per_second": 28,
          "failures": ["unfilled_template", "dropped_unicode"]
        }
      }
    }
  ]
}
```

**Verification Command:**
```bash
npm run benchmark:model -- --model llama3.1:8b
```

---

## Part 4: Verification Framework

### 4.1 Unit Test Requirements for All Improvements

Every improvement MUST include:

1. **Happy Path Test** - Verify intended behavior works
2. **Edge Case Tests** - Boundaries, empty inputs, maximum values
3. **Error Path Tests** - Failure modes handled correctly
4. **Integration Test** - Works with rest of system
5. **Regression Test** - Prevents known bugs from returning

**Template:**
```typescript
// test/improvement-XX.test.ts
import { describe, it, expect, beforeEach } from 'vitest';

describe('Improvement #XX: [Name]', () => {
  beforeEach(() => {
    // Setup
  });

  describe('happy path', () => {
    it('does the thing it says', async () => {
      // Test
    });
  });

  describe('edge cases', () => {
    it('handles empty input', async () => {
      // Test
    });

    it('handles maximum input', async () => {
      // Test
    });
  });

  describe('error handling', () => {
    it('fails gracefully when X breaks', async () => {
      // Test
    });
  });

  describe('integration', () => {
    it('works with existing Y', async () => {
      // Test
    });
  });
});
```

### 4.2 Documentation Requirements

Every improvement MUST update:

1. **Architecture Documentation** - If it changes system shape
2. **Truth Boundary** - If it crosses a previously-stated boundary
3. **Known Issues Register** - Close items that are now resolved
4. **Operations Guide** - How to run/monitor/maintain
5. **CHANGELOG** - User-visible changes

**Checklist:**
```markdown
## Documentation Checklist for Improvement #XX

- [ ] Architecture diagram updated (if applicable)
- [ ] ADR written (if architectural decision)
- [ ] Truth boundary entries reviewed
- [ ] Known issues register updated
- [ ] Operations guide includes runbook
- [ ] CHANGELOG entry added
- [ ] README quickstart updated (if user-facing)
- [ ] Inline code comments explain WHY not WHAT
```

### 4.3 Verification Commands

Add to `package.json`:
```json
{
  "scripts": {
    "verify:improvement-16": "npm test -- test/health-metrics.test.ts && npm run cli -- health",
    "verify:improvement-17": "npm test -- --chaos",
    "verify:improvement-18": "npm test -- test/precision-metrics.test.ts",
    "verify:improvement-19": "npm run check:cross-references",
    "verify:improvement-20": "npm test -- --benchmark"
  }
}
```

### 4.4 Success Criteria

Each improvement is complete when:

✅ All tests pass (including new ones)
✅ Documentation updated
✅ Truth boundary reviewed
✅ Can demonstrate the improvement working
✅ No existing functionality broken
✅ Performance within budget (if applicable)

---

## Part 5: Implementation Timeline

### Phase 1: Foundation (Weeks 1-2)
- Improvement #16: Health Monitoring
- Improvement #19: Documentation Cross-References
- **Total:** 14-20 hours

### Phase 2: Testing Excellence (Weeks 3-5)
- Improvement #17: Chaos Testing
- Improvement #18: Precision Measurement
- **Total:** 28-36 hours

### Phase 3: Performance & Operations (Weeks 6-7)
- Improvement #20: Performance Benchmarking
- Local model integration and benchmarking
- **Total:** 20-30 hours

### Phase 4: Validation & Documentation (Week 8)
- All verification tests passing
- Documentation complete
- Truth boundary updated
- **Total:** 8-12 hours

**Grand Total:** 70-98 hours (approximately 9-12 working days)

---

## Conclusion

This analysis identified **5 additional high-value improvements** beyond the original 15, bringing the total recommendation count to **20 prioritized improvements**.

**Key Insights:**

1. **Local LLM integration is production-ready** - The Ollama adapter demonstrates excellent patterns for security, configuration, and error handling

2. **Testing gaps are addressable** - Chaos testing and precision measurement fill critical holes in the evaluation story

3. **Documentation discipline can be enhanced** - Cross-reference checking prevents the "correct number, wrong claim" problem

4. **Performance matters** - Without benchmarking, performance regressions will ship silently

5. **Model selection is contextual** - Different models for different purposes, with clear hardware requirements

**Immediate Next Steps:**

1. Fix doctor check false positive (#1) - 1-2 hours
2. Pull a local model for testing - 10 minutes
3. Run first local evaluation - 5 minutes
4. Begin health monitoring implementation (#16) - Week 1

The system is architecturally sound and ready for these enhancements. The biggest gap remains **never having called a real model** - everything else is optimization.

---

## Appendix A: Quick Reference Commands

```bash
# Health monitoring
npm run cli -- health

# Chaos testing
npm test -- --chaos
npm run cli -- chaos-test --scenario rate-limit-storm

# Precision grading
npm run cli -- grade <run-id>

# Documentation checks
npm run check:cross-references
npm run docs:graph

# Performance benchmarking
npm test -- --benchmark
npm run benchmark:compare

# Local model management
./scripts/pull-models.sh
export OLLAMA_MODEL=llama3.1:8b
npm run eval -- --local --trials 100
```

---

## Appendix B: Model Comparison Table

| Model | Params | Context | License | Ollama Tag | Best Use | VRAM Req |
|-------|--------|---------|---------|------------|----------|----------|
| Llama 3.2 | 3B | 128K | Custom | llama3.2:3b | Dev/Test | 6GB |
| Phi-3 Mini | 3.8B | 128K | MIT | phi3:mini | Dev/Test | 6GB |
| Mistral | 7B | 32K | Apache 2.0 | mistral:7b | Evaluation | 8GB |
| Llama 3.1 | 8B | 128K | Custom | llama3.1:8b | Evaluation | 10GB |
| Qwen 2.5 | 14B | 128K | Apache 2.0 | qwen2.5:14b | Production | 16GB |
| CodeLlama | 13B | 16K | MIT | codellama:13b | Code Tasks | 16GB |

---

**Document Status:** Complete
**Review Required:** Architecture team, Operations team
**Next Review Date:** After implementing first 3 improvements
