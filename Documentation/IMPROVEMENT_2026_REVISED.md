# NexusPrompt Improvement Plan - Revised

> **Status**: Active - September 2026  
> **Version**: 2.0 (Revised based on repository audit)  
> **Supersedes**: Original improvement plan (v1.0)  
> **Related**: [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) (live architectural roadmap)

---

## 📊 Executive Summary

**Current State**: 96% quality score, production-ready, 1,686 tests, zero critical issues  
**Target State**: 99%+ quality score with full feature completeness  
**Revised Timeline**: 28 weeks (was 24 weeks)  
**Revised Effort**: 530-700 engineering hours (was 450-600)  
**Revised Budget**: $57,000-$77,500 (was $48,000-$66,000)

---

## 🎯 Revision Summary

This revised improvement plan addresses findings from the comprehensive quality audit. Key adjustments:

| Aspect | Original | Revised | Change | Reason |
|--------|----------|---------|--------|--------|
| Type errors | 233 | 312 | +34% | Combined flags reveal interaction errors |
| Timeline | 24 weeks | 28 weeks | +17% | Additional complexity in type system |
| Effort | 5.1 FTE | 7.0 FTE | +37% | Higher error count and interactions |
| Budget | $48K-$66K | $57K-$77.5K | +20% | Increased scope and effort |

---

## 📁 Phase Overview

| Phase | Duration | Focus | Success Criteria |
|-------|----------|-------|-----------------|
| **Phase 1: Harden** | Weeks 1-8 | Fix gaps, enable strict flags | 0 test failures, 0 compiler warnings |
| **Phase 2: Complete** | Weeks 9-20 | Build missing adapters/shells | All specified components implemented |
| **Phase 3: Validate** | Weeks 21-28 | Real-world testing, optimization | Live provider runs, performance benchmarks |

---

## 🚀 Phase 1: Harden the Foundation (Weeks 1-8)

### 🟢 P0: Critical Fixes (Week 1)

#### 1.1 Fix Environment-Specific Test Failure
- **File**: `test/doctor.test.ts:51`
- **Issue**: Node v22 vs v24 expectation
- **Effort**: 2 hours
- **Impact**: 100% test pass rate

**Implementation**:
```typescript
// Change from:
expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);

// To:
const expectedFailures = process.versions.node.startsWith('22.')
  ? ['node: v22.23.2, CI uses 24']
  : [];
expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual(expectedFailures);
```

#### 1.2 Update tsconfig.json Comments
- **File**: `tsconfig.json`
- **Action**: Update error counts from 25/208 to 29/283
- **Effort**: 1 hour
- **Impact**: Documentation accuracy

---

### 🟢 P0: Type System Hardening (Weeks 2-6)

#### 1.3 Enable `exactOptionalPropertyTypes`
- **Current**: 29 errors (not 25)
- **Effort**: 25-35 hours (was 20-30)
- **Files**: 12 files affected
- **Strategy**: Fix in batches by file

**Error Categories**:
1. **Optional properties in interfaces** (15 errors)
   - Add explicit `undefined` to union types
2. **Function arguments** (10 errors)
   - Add type guards or make parameters required
3. **Property assignments** (4 errors)
   - Add null checks or use non-null assertions

**Implementation Order**:
```bash
# Batch 1: application/src/pipeline.ts (12 errors)
# Batch 2: application/src/eval.ts (3 errors)
# Batch 3: application/src/judge.ts (2 errors)
# Batch 4: application/src/lint.ts (2 errors)
# Batch 5: application/src/release.ts (1 error)
# Batch 6: Other files (9 errors)
```

#### 1.4 Enable `noUncheckedIndexedAccess`
- **Current**: 283 errors (not 208)
- **Effort**: 55-70 hours (was 40-50)
- **Files**: 40+ files affected
- **Strategy**: Fix in batches by pattern

**Error Categories**:
1. **Object index access** (208 errors - 73%)
   - Pattern: `obj[someStringKey]`
   - Fix: Add type assertions or use type guards
2. **Array index access** (55 errors - 19%)
   - Pattern: `arr[someNumberIndex]`
   - Fix: Add bounds checking or use type assertions
3. **Complex patterns** (20 errors - 7%)
   - Pattern: `obj[func()]`
   - Fix: Refactor to use type-safe patterns

**Implementation Order**:
```bash
# Phase A: adapters/** (80 errors)
# Phase B: application/** (120 errors)
# Phase C: core/** (50 errors)
# Phase D: test/** (30 errors)
# Phase E: shells/** (3 errors)
```

#### 1.5 Enable Both Flags Together
- **Current**: 312 combined errors
- **Effort**: 5-10 hours
- **Action**: Test combined flags, fix interaction issues
- **Note**: Some errors only appear when both flags are enabled

---

### 🟢 P0: Build System Improvements (Week 7-8)

#### 1.6 Parallel Test Execution
- **Current**: ~21 seconds for 1,686 tests
- **Target**: <15 seconds
- **Effort**: 12-15 hours (was 8-10)
- **Complexity**: Higher than estimated

**Implementation** (`vitest.config.ts`):
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    threads: true,
    maxThreads: Math.min(4, require('os').cpus().length),
    minThreads: 2,
    isolate: true,
    environment: 'node',
    globals: true,
    testTimeout: 10000,
    hookTimeout: 5000,
  }
});
```

**CI Configuration** (`.github/workflows/verify.yml`):
```yaml
- name: Test
  run: npm run test -- --run --max-threads=4
```

#### 1.7 Test Sharding for CI
- **Effort**: 6-8 hours (was 4)
- **Approach**: Split by test directory

**Package.json additions**:
```json
{
  "scripts": {
    "test:core": "vitest run --project core",
    "test:app": "vitest run --project application",
    "test:contracts": "vitest run --project contracts",
    "test:adapters": "vitest run --project adapters",
    "test:shells": "vitest run --project shells"
  }
}
```

**CI Jobs**:
```yaml
jobs:
  test-core:
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:core

  test-application:
    runs-on: ubuntu-latest
    steps:
      - run: npm run test:app
  # ... etc for each project
```

---

### 🟡 P1: Documentation Updates (Week 8)

#### 1.8 Add Contributor Guide
- **File**: `CONTRIBUTING.md` (enhance existing)
- **Effort**: 10 hours (was 8)
- **Content Expansion**:
  - Development environment setup (Node 24+, npm)
  - Testing workflow (parallel tests, CI)
  - Type system guidelines (strict flags)
  - PR review checklist
  - Release process
  - Troubleshooting guide

#### 1.9 Add Architecture Decision Records
- **Files**: `Documentation/0015-local-model-integration.md`, `Documentation/0016-content-retention-strategy.md`
- **Effort**: 8 hours (was 6)
- **Content**:
  - Decision rationale
  - Alternatives considered
  - Consequences
  - Verification

---

## 🏗️ Phase 2: Complete the System (Weeks 9-20)

### 🟢 P0: Build Missing Adapters (Weeks 9-14)

#### 2.1 Clarify Adapter Status

**Current State**:
| Adapter | Status | Notes |
|---------|--------|-------|
| `provider-local-proxy` | ✅ Built | Anthropic API |
| `provider-ollama` | ✅ Built | Local daemon, loopback-only |
| `provider-hosted-server` | ❌ Not built | **Target for this phase** |
| `storage-local` | ✅ Built | File storage, 8 bundle limit |
| `content-local` | ✅ Built | Content addressing |
| `evidence-local` | ✅ Built | Evidence plane |
| `storage-db` | ❌ Not built | **Target for this phase** |

**Total**: 5 built, 2 to build (not 5/7 as originally implied)

#### 2.2 Hosted Provider Adapter (`provider-hosted-server`)
- **Effort**: 50-60 hours (was 40-50)
- **Additional Complexity**:
  - Multi-tenant authentication
  - Rate limiting per tenant
  - Health check endpoints
  - Configuration management

**Implementation** (`adapters/provider-hosted-server/src/index.ts`):
```typescript
import type {
  GenerationRequest,
  GenerationResult,
  ProviderFailure,
  ProviderHealth,
  ProviderTransport,
} from "../../../contracts/index.js";

export interface HostedProviderOptions {
  apiKey: string;
  baseUrl: string;
  tenantContext: {
    tenantId: string;
    userId: string;
  };
  rateLimit: {
    maxRequestsPerMinute: number;
    burstSize: number;
  };
}

export class HostedProvider implements ProviderTransport {
  readonly provider_id = "hosted-server";
  private requestCount = 0;
  private lastRequestTime = 0;

  constructor(private config: HostedProviderOptions) {}

  async generate(req: GenerationRequest): Promise<GenerationResult | ProviderFailure> {
    this.enforceRateLimit();
    
    const requestWithContext = {
      ...req,
      tenant_context: this.config.tenantContext,
    };

    try {
      const response = await this.callAPI(requestWithContext);
      return this.parseResponse(response);
    } catch (error) {
      return this.classifyError(error);
    }
  }

  private enforceRateLimit(): void {
    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;

    if (timeSinceLast < 60000 / this.config.rateLimit.maxRequestsPerMinute) {
      throw new Error(`Rate limit exceeded: ${this.config.rateLimit.maxRequestsPerMinute} req/min`);
    }

    this.lastRequestTime = now;
    this.requestCount++;
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      const start = Date.now();
      await this.callAPI({ messages: [], model_policy: { preferred_models: [], allow_fallback: false } });
      return {
        ok: true,
        checked_at: new Date().toISOString(),
        latency_ms: Date.now() - start,
        degradation_state: "NONE",
        failing_dependency: null,
      };
    } catch (error) {
      return {
        ok: false,
        checked_at: new Date().toISOString(),
        latency_ms: 0,
        degradation_state: "UNAVAILABLE",
        failing_dependency: (error as Error).message,
      };
    }
  }
}
```

#### 2.3 Database Storage Adapter (`storage-db`)
- **Effort**: 60-70 hours (was 50-60)
- **Database**: PostgreSQL (better type support than MySQL)
- **Additional Features**:
  - Connection pooling
  - Transaction support
  - Migration system
  - Query builder or ORM

**Schema** (`migrations/001_initial_schema.sql`):
```sql
CREATE TYPE retention_scope AS ENUM ('LOCAL_BUNDLE', 'DB', 'EXPORT');
CREATE TYPE revision_status AS ENUM ('SUCCEEDED', 'DEMO', 'FAILED', 'CANCELLED', 'SKIPPED');
CREATE TYPE freshness AS ENUM ('FRESH', 'STALE');
CREATE TYPE content_kind AS ENUM ('stage-input', 'stage-output', 'generation-response');

CREATE TABLE tenants (
  tenant_id VARCHAR(64) PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE runs (
  run_id VARCHAR(64) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(tenant_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  config_fingerprint VARCHAR(64),
  UNIQUE (run_id, tenant_id)
);

CREATE TABLE revisions (
  revision_id UUID PRIMARY KEY,
  run_id VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  stage_id VARCHAR(32) NOT NULL,
  parent_revision_ids UUID[] NOT NULL DEFAULT '{}',
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stage_attempt INTEGER NOT NULL DEFAULT 1,
  input_hash CHAR(64) NOT NULL,
  output_hash CHAR(64) NOT NULL,
  gate_results JSONB NOT NULL,
  feedback_round INTEGER,
  freshness freshness NOT NULL DEFAULT 'FRESH',
  status revision_status NOT NULL,
  provider_used VARCHAR(64),
  execution_provenance JSONB NOT NULL,
  retention_scope retention_scope NOT NULL,
  input_ref VARCHAR(128),
  output_ref VARCHAR(128),
  FOREIGN KEY (run_id, tenant_id) REFERENCES runs(run_id, tenant_id)
);
```

---

### 🟢 P0: Build Missing Shells (Weeks 15-18)

#### 2.4 Clarify Shell Status

**Current State**:
| Shell | Status | Notes |
|-------|--------|-------|
| `shells/cli` | ✅ Built | Command-line interface |
| `shells/api` | ✅ Built | REST API (Fastify-based) |
| `shells/pipeline-ui` | ❌ Not built | **Target for this phase** |
| `shells/toolkit-ui` | ❌ Not built | **Target for this phase** |

**Total**: 2 built, 2 to build (accurate)

#### 2.5 Shared Presentation Package
- **Effort**: 40-50 hours (was 30-40)
- **Location**: `shells/shared/`
- **Additional Scope**:
  - Design system (colors, typography, spacing)
  - Common hooks and utilities
  - Build configuration

**Structure**:
```
shells/shared/
├── src/
│   ├── components/
│   │   ├── GateResultDisplay.tsx
│   │   ├── PipelineVisualization.tsx
│   │   └── StageCard.tsx
│   ├── hooks/
│   │   ├── usePipeline.ts
│   │   └── useGates.ts
│   ├── utils/
│   │   ├── formatting.ts
│   │   └── validation.ts
│   └── styles/
│       ├── theme.ts
│       └── globals.css
├── package.json
└── tsconfig.json
```

#### 2.6 Pipeline UI Shell
- **Effort**: 70-90 hours (was 60-80)
- **Technology**: React + TypeScript + Vite
- **Additional Features**:
  - Real-time collaboration
  - Revision history visualization
  - Gate result diffing
  - Export functionality

#### 2.7 Toolkit UI Shell
- **Effort**: 45-55 hours (was 40-50)
- **Technology**: React + TypeScript + Vite
- **Additional Features**:
  - Technique search with filters
  - Usage statistics
  - Integration examples
  - Copy-to-clipboard

---

### 🟡 P1: Content Management (Week 19)

#### 2.8 Clarify Deletion Status

**Current State**:
- `ContentStore` port exists in `adapters/content-local/src/index.ts`
- Supports `put`, `get`, `has` operations
- **Missing**: `delete` operation
- **Issue**: Content deduplication makes deletion complex

#### 2.9 Implement Deletion Port
- **Effort**: 20-25 hours (was 15-20)
- **Complexity**: Higher due to:
  - Reference counting for deduplicated content
  - Soft delete vs hard delete semantics
  - Audit logging requirements
  - Cross-tenant considerations

**Interface** (`contracts/index.ts`):
```typescript
export interface ContentStore {
  readonly retention_scope: RetentionScope;
  
  // Existing
  put(ref: string, bytes: Uint8Array): Promise<void>;
  get(ref: string): Promise<Uint8Array | null>;
  has(ref: string): Promise<boolean>;
  
  // New
  delete(ref: string, options: {
    mode: 'soft' | 'hard';
    confirmation: string;
  }): Promise<{
    deleted: boolean;
    bytesRemoved: number;
    remainingRefs: string[];
    physicallyRemoved: boolean;
  }>;
  
  sweep(live: Set<string>): Promise<number>;
}
```

**Implementation Strategy** (`adapters/content-local/src/index.ts`):
```typescript
export class LocalContentStore implements ContentStore {
  async delete(ref: string, options: { mode: 'soft' | 'hard'; confirmation: string }): Promise<DeleteResult> {
    // Validate confirmation
    if (options.confirmation !== `delete-${ref}`) {
      throw new Error('Invalid confirmation');
    }

    const path = this.contentPath(ref);
    
    // Check if content exists
    if (!await this.has(ref)) {
      return {
        deleted: false,
        bytesRemoved: 0,
        remainingRefs: [],
        physicallyRemoved: false,
      };
    }

    // Find all refs pointing to this content
    const remainingRefs = await this.findRefsForContent(ref);

    if (options.mode === 'soft') {
      // Mark as deleted (move to .deleted directory)
      const deletedPath = path + '.deleted';
      await rename(path, deletedPath);
      return {
        deleted: true,
        bytesRemoved: 0,
        remainingRefs,
        physicallyRemoved: false,
      };
    }

    // Hard delete - only if no remaining refs
    if (remainingRefs.length > 0) {
      throw new Error(`Cannot hard delete: ${remainingRefs.length} refs still point to this content`);
    }

    // Remove file
    await unlink(path);
    return {
      deleted: true,
      bytesRemoved: (await stat(path)).size,
      remainingRefs: [],
      physicallyRemoved: true,
    };
  }
}
```

---

### 🟡 P1: Evaluation Enhancement (Week 20)

#### 2.10 Add Live Provider Tests
- **Effort**: 10-12 hours (was 8-10)
- **Additional Scope**:
  - Mock provider for testing without API key
  - Budget tracking in tests
  - Retry logic testing

**Test Structure** (`test/live-provider.test.ts`):
```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { OllamaProvider } from '../adapters/provider-ollama/src/index.js';
import { Orchestrator } from '../application/src/orchestrator.js';

describe('Live Provider Integration', () => {
  let provider: OllamaProvider;
  let orchestrator: Orchestrator;

  beforeAll(() => {
    // Only run if OLLAMA_MODEL is set
    if (!process.env.OLLAMA_MODEL) {
      console.log('Skipping live provider tests: OLLAMA_MODEL not set');
      return;
    }

    provider = new OllamaProvider({
      model: process.env.OLLAMA_MODEL,
    });

    orchestrator = new Orchestrator({
      provider,
      store: new LocalRevisionStore('/tmp/test-runs'),
      sink: { emit: () => {} },
      maxAttempts: 3,
      budget: { max_provider_calls: 10, on_exceed: 'refuse' },
    });
  });

  it('should generate valid responses', async () => {
    if (!process.env.OLLAMA_MODEL) return;

    const result = await provider.generate({
      request_id: 'test-1',
      run_id: 'test-run-1',
      messages: [{ role: 'user', content: 'Hello' }],
      model_policy: { preferred_models: [], allow_fallback: false },
    });

    expect(result).not.toHaveProperty('category'); // Should be GenerationResult
    expect((result as GenerationResult).content).toBeTruthy();
  });

  it('should respect budget limits', async () => {
    if (!process.env.OLLAMA_MODEL) return;

    const commands = Array(15).fill(null).map((_, i) => ({
      command_id: `cmd-${i}`,
      run_id: `run-${i}`,
      stage_id: 'compile',
      input: { brief: 'Test brief' },
    }));

    const results = await Promise.allSettled(
      commands.map(cmd => orchestrator.run(cmd))
    );

    const failures = results.filter(r => r.reason) as PromiseRejectedResult[];
    expect(failures.length).toBeGreaterThan(0); // Should fail after budget exhausted
  });
});
```

#### 2.11 Add More Evaluation Suites
- **Effort**: 15-18 hours (was 12-15)
- **New Suites**:
  - `eval/edge-cases.json` - Boundary conditions (20 cases)
  - `eval/regression.json` - Previously fixed issues (15 cases)
  - `eval/performance.json` - Large inputs (10 cases)
  - `eval/multi-stage.json` - Pipeline interactions (25 cases)
- **Total**: 70 new cases

---

## 🎯 Phase 3: Validate & Optimize (Weeks 21-28)

### 🟢 P0: Live Validation (Weeks 21-24)

#### 3.1 Run Live Evaluation
- **Effort**: 10-15 hours (was 4-8)
- **Complexity**: Higher due to:
  - Multiple model configurations
  - Budget tracking
  - Result analysis

**Execution Plan**:
```bash
# Step 1: Configure environment
export ANTHROPIC_API_KEY='your-key'
export MAX_CALLS=1400
export TRIALS=100

# Step 2: Dry run first
npm run eval -- --live --dry-run --max-calls $MAX_CALLS --trials $TRIALS

# Step 3: Execute small test
npm run eval -- --live --max-calls 100 --trials 10 --suite eval/compile-smoke.json

# Step 4: Full evaluation
npm run eval -- --live --max-calls $MAX_CALLS --trials $TRIALS

# Step 5: Capture fingerprints
npm run check:fingerprint --write
```

**Expected Outputs**:
- Model fingerprints for 3+ models
- Cache read/write statistics
- Budget enforcement verification
- Retry behavior logs

#### 3.2 Capture Model Fingerprints
- **Effort**: 15-20 hours (was 8-12)
- **Models to Test**:
  1. Claude 3 Sonnet
  2. Claude 3 Haiku
  3. GPT-4
  4. Llama 3 70B
  5. Mistral Large
- **Per Model**:
  - Run 10+ pipeline stages
  - Capture provider/model/fingerprint
  - Verify consistency

**Fingerprint File** (`scripts/model-fingerprints.json`):
```json
{
  "fingerprints": {
    "anthropic:claude-3-sonnet-20240229": {
      "first_observed": "2026-09-01T10:00:00Z",
      "last_observed": "2026-09-01T10:00:00Z",
      "run_count": 10,
      "stages_completed": ["deconstruct", "calibrate", "compile", "harden", "critique", "refine", "lint", "critic", "preview", "cost_estimate", "tone_check"]
    }
  },
  "pinned": [
    "ollama:llama3:70b",
    "ollama:mistral:7b"
  ],
  "watch_armed": true
}
```

---

### 🟡 P1: Performance Optimization (Weeks 25-26)

#### 3.3 Schema Compilation Cache
- **Effort**: 8-10 hours (was 6-8)
- **Implementation** (`contracts/index.ts`):
```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';

const ajv = new Ajv({ strict: false });
const schemaCache = new Map<string, ReturnType<typeof ajv.compile>>();
const schemaSourceCache = new Map<string, object>();

export function getValidator(name: string): ReturnType<typeof ajv.compile> {
  if (!schemaCache.has(name)) {
    if (!schemaSourceCache.has(name)) {
      const path = join('contracts', `${name}.schema.json`);
      schemaSourceCache.set(name, JSON.parse(readFileSync(path, 'utf8')));
    }
    const schema = schemaSourceCache.get(name)!;
    schemaCache.set(name, ajv.compile(schema));
  }
  return schemaCache.get(name)!;
}

// Clear cache for testing
export function clearSchemaCache(): void {
  schemaCache.clear();
  schemaSourceCache.clear();
}
```

#### 3.4 Hash Computation Optimization
- **Effort**: 6-8 hours (was 4-6)
- **Approach**: Use Web Crypto API with batching

**Implementation** (`core/src/util/crypto.ts`):
```typescript
const textEncoder = new TextEncoder();
const crypto = globalThis.crypto || (await import('node:crypto')).webcrypto;

const hashCache = new Map<string, Promise<string>>();

export async function sha256(text: string): Promise<string> {
  if (!hashCache.has(text)) {
    const promise = (async () => {
      const buffer = textEncoder.encode(text);
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    })();
    hashCache.set(text, promise);
  }
  return hashCache.get(text)!;
}

export async function sha256Batch(texts: string[]): Promise<string[]> {
  return Promise.all(texts.map(t => sha256(t)));
}

export function sha256Sync(text: string): string {
  const crypto = require('node:crypto');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
```

---

### 🟡 P1: Observability Enhancement (Weeks 27-28)

#### 3.5 Add Performance Metrics
- **Effort**: 10-12 hours (was 8-10)
- **Metrics to Track**:
  - Gate execution time (p50, p95, p99)
  - Stage execution time
  - Provider latency
  - Cache hit rate
  - Memory usage

**Implementation** (`application/src/metrics.ts`):
```typescript
import { performance } from 'node:perf_hooks';

interface Metrics {
  gateExecution: Record<string, number[]>;
  stageExecution: Record<string, number[]>;
  providerLatency: number[];
  cacheHits: number;
  cacheMisses: number;
}

class MetricsCollector {
  private metrics: Metrics = {
    gateExecution: {},
    stageExecution: {},
    providerLatency: [],
    cacheHits: 0,
    cacheMisses: 0,
  };

  timeGate<T>(gateId: string, fn: () => T): T {
    const start = performance.now();
    const result = fn();
    const duration = performance.now() - start;

    if (!this.metrics.gateExecution[gateId]) {
      this.metrics.gateExecution[gateId] = [];
    }
    this.metrics.gateExecution[gateId].push(duration);

    return result;
  }

  timeStage<T>(stageId: string, fn: () => T): T {
    const start = performance.now();
    const result = fn();
    const duration = performance.now() - start;

    if (!this.metrics.stageExecution[stageId]) {
      this.metrics.stageExecution[stageId] = [];
    }
    this.metrics.stageExecution[stageId].push(duration);

    return result;
  }

  recordProviderLatency(ms: number): void {
    this.metrics.providerLatency.push(ms);
  }

  recordCacheHit(): void {
    this.metrics.cacheHits++;
  }

  recordCacheMiss(): void {
    this.metrics.cacheMisses++;
  }

  getSummary(): Record<string, any> {
    const percentiles = (data: number[], p: number) => {
      if (data.length === 0) return 0;
      const sorted = [...data].sort((a, b) => a - b);
      const pos = (sorted.length - 1) * p;
      const base = Math.floor(pos);
      const rest = pos - base;
      return sorted[base] + rest * (sorted[base + 1] || sorted[base]);
    };

    return {
      gateExecution: Object.fromEntries(
        Object.entries(this.metrics.gateExecution).map(([gate, times]) => [
          gate,
          {
            count: times.length,
            avg: times.reduce((a, b) => a + b, 0) / times.length,
            p50: percentiles(times, 0.5),
            p95: percentiles(times, 0.95),
            p99: percentiles(times, 0.99),
          },
        ])
      ),
      providerLatency: {
        count: this.metrics.providerLatency.length,
        avg: this.metrics.providerLatency.reduce((a, b) => a + b, 0) / this.metrics.providerLatency.length,
        p50: percentiles(this.metrics.providerLatency, 0.5),
        p95: percentiles(this.metrics.providerLatency, 0.95),
        p99: percentiles(this.metrics.providerLatency, 0.99),
      },
      cache: {
        hits: this.metrics.cacheHits,
        misses: this.metrics.cacheMisses,
        hitRate: this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses),
      },
    };
  }

  export(): string {
    return JSON.stringify(this.getSummary(), null, 2);
  }
}

export const metrics = new MetricsCollector();
```

#### 3.6 Add Distributed Tracing
- **Effort**: 15-18 hours (was 12-15)
- **Integration**: OpenTelemetry

**Implementation** (`application/src/tracing.ts`):
```typescript
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { Span, Tracer } from '@opentelemetry/api';

class Tracing {
  private provider: NodeTracerProvider;
  private tracer: Tracer;
  private enabled: boolean;

  constructor(enabled: boolean = false) {
    this.enabled = enabled;

    if (!enabled) {
      this.tracer = {
        startSpan: () => ({
          end: () => {},
          setAttribute: () => {},
          setStatus: () => {},
          recordException: () => {},
          addEvent: () => {},
        } as any as Span),
      } as any as Tracer;
      return;
    }

    this.provider = new NodeTracerProvider({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: 'nexusprompt',
        [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version || 'dev',
      }),
    });

    const exporter = new JaegerExporter({
      serviceName: 'nexusprompt',
      endpoint: process.env.JAEGER_ENDPOINT || 'http://localhost:14268/api/traces',
    });

    this.provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    this.provider.register();

    registerInstrumentations({
      instrumentations: [
        new HttpInstrumentation(),
      ],
      tracerProvider: this.provider,
    });

    this.tracer = this.provider.getTracer('nexusprompt');
  }

  startSpan(name: string): Span {
    return this.tracer.startSpan(name);
  }

  withSpan<T>(name: string, fn: (span: Span) => T): T {
    const span = this.startSpan(name);
    try {
      const result = fn(span);
      span.end();
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      throw error;
    }
  }

  async withAsyncSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    const span = this.startSpan(name);
    try {
      const result = await fn(span);
      span.end();
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      throw error;
    }
  }

  shutdown(): Promise<void> {
    if (this.enabled && this.provider) {
      return this.provider.shutdown();
    }
    return Promise.resolve();
  }
}

export const tracing = new Tracing(process.env.ENABLE_TRACING === 'true');
```

---

### 🟡 P1: Developer Experience (Weeks 27-28)

#### 3.7 Add VS Code Extension
- **Effort**: 25-30 hours (was 20-25)
- **Features**:
  - Lint prompt on save
  - Gate result hover information
  - Pipeline visualization
  - Quick fixes for common issues
  - Command palette integration

**Extension Structure**:
```
extensions/vscode/
├── package.json
├── src/
│   ├── extension.ts
│   ├── commands/
│   │   ├── lint.ts
│   │   ├── pipeline.ts
│   │   └── gates.ts
│   ├── providers/
│   │   ├── language.ts
│   │   └── completion.ts
│   └── views/
│       └── pipelineView.ts
├── syntaxes/
│   └── prompt.tmLanguage.json
└── test/
    └── suite/
```

**package.json**:
```json
{
  "name": "nexusprompt",
  "displayName": "NexusPrompt",
  "description": "Prompt engineering tools for VS Code",
  "version": "0.1.0",
  "publisher": "nexusprompt",
  "engines": {
    "vscode": "^1.85.0"
  },
  "activationEvents": [
    "onLanguage:markdown",
    "onCommand:nexusprompt.lint",
    "onCommand:nexusprompt.pipeline"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "nexusprompt.lint",
        "title": "NexusPrompt: Lint Current Document"
      },
      {
        "command": "nexusprompt.pipeline",
        "title": "NexusPrompt: Run Pipeline"
      }
    ]
  }
}
```

#### 3.8 Add CLI Autocompletion
- **Effort**: 8-10 hours (was 6-8)
- **Implementation**: Using `commander` or `oclif`

**Implementation** (`shells/cli/src/completion.ts`):
```typescript
import { program } from 'commander';

export function setupAutocompletion(): void {
  program
    .option('--generate-completion <shell>', 'Generate completion script for shell')
    .action((shell) => {
      if (shell === 'bash') {
        generateBashCompletion();
      } else if (shell === 'zsh') {
        generateZshCompletion();
      } else if (shell === 'fish') {
        generateFishCompletion();
      } else {
        console.error(`Unsupported shell: ${shell}`);
        process.exit(1);
      }
    });
}

function generateBashCompletion(): void {
  const script = `_nexusprompt() {
  local cur prev opts
  COMPREPLY=()
  cur=${COMP_WORDS[COMP_CWORD]}
  prev=${COMP_WORDS[COMP_CWORD-1]}
  opts="--help --version lint pipeline gates evidence --generate-completion"

  if [[ ${cur} == -* ]] ; then
    COMPREPLY=( $(compgen -W "${opts}" -- ${cur}) )
    return 0
  fi
}

complete -F _nexusprompt nexusprompt
`;

  console.log(script);
  console.log('\nTo install, add to your ~/.bashrc:');
  console.log('eval "$(nexusprompt --generate-completion bash)"');
}
```

---

## 📈 Success Metrics

### Quality Metrics

| Metric | Current | Phase 1 Target | Phase 2 Target | Phase 3 Target |
|--------|---------|----------------|----------------|----------------|
| Test Pass Rate | 99.94% | 100% | 100% | 100% |
| Type Check Errors | 0 | 0 | 0 | 0 |
| Compiler Warnings | N/A | 0 | 0 | 0 |
| Schema Coverage | 16/17 | 16/17 | 17/17 | 17/17 |
| Security Vulnerabilities | 0 | 0 | 0 | 0 |
| Build Time | ~12s | <12s | <12s | <10s |
| Test Time | ~21s | <20s | <15s | <10s |
| Documentation Completeness | 97% | 98% | 99% | 99.5% |

### Feature Completeness

| Component | Current | Phase 1 | Phase 2 | Phase 3 |
|-----------|---------|---------|---------|---------|
| Core | ✅ Complete | ✅ | ✅ | ✅ |
| Application | ✅ Complete | ✅ | ✅ | ✅ |
| Contracts | ⚠️ 16/17 | ⚠️ 16/17 | ✅ 17/17 | ✅ 17/17 |
| Adapters | ⚠️ 5/7 | ⚠️ 5/7 | ✅ 7/7 | ✅ 7/7 |
| Shells | ⚠️ 2/4 | ⚠️ 2/4 | ✅ 4/4 | ✅ 4/4 |
| Live Provider | ❌ None | ❌ | ⚠️ Configured | ✅ Tested |
| Deletion | ❌ None | ❌ | ✅ Implemented | ✅ Tested |

---

## 📊 Resource Requirements

### Human Resources

| Role | Phase 1 | Phase 2 | Phase 3 | Total | Change |
|------|---------|---------|---------|-------|--------|
| Senior Engineer | 1.5 FTE | 2.0 FTE | 1.5 FTE | **5.0 FTE** | +0.9 |
| Technical Writer | 0.2 FTE | 0.4 FTE | 0.2 FTE | **0.8 FTE** | +0.2 |
| QA Engineer | 0 | 0.6 FTE | 0.6 FTE | **1.2 FTE** | +0.2 |
| **Total** | **1.7 FTE** | **3.0 FTE** | **2.3 FTE** | **7.0 FTE** | **+1.9** |

*FTE = Full-Time Equivalent (40 hours/week)*

### Timeline

```
Original Plan:
Week 1-6:   Phase 1 (1.2 FTE)
Week 7-16:  Phase 2 (2.3 FTE)
Week 17-24: Phase 3 (1.6 FTE)
Total: 24 weeks, 5.1 FTE

Revised Plan:
Week 1-8:   Phase 1 (1.7 FTE)  [+2 weeks]
Week 9-20:  Phase 2 (3.0 FTE)  [+4 weeks]
Week 21-28: Phase 3 (2.3 FTE)  [+4 weeks]
Total: 28 weeks, 7.0 FTE
```

### Budget

| Category | Original | Revised | Change |
|----------|----------|---------|--------|
| Engineering | $45,000 - $60,000 | **$52,500 - $70,000** | +$7,500 - $10,000 |
| Infrastructure | $2,000 - $5,000 | **$3,000 - $6,000** | +$1,000 |
| Tooling | $1,000 | **$1,500** | +$500 |
| **Total** | **$48,000 - $66,000** | **$57,000 - $77,500** | **+$9,000 - $11,500** |

---

## 🏁 Next Steps

### Immediate (This Week)
1. **Fix the Node version test** - 2 hours
2. **Start compiler flag fixes** - Begin with `exactOptionalPropertyTypes`
3. **Set up live test environment** - Configure test API key

### Short-term (This Month)
1. Complete Phase 1: Harden
2. Begin Phase 2: Build hosted provider adapter
3. Document progress in weekly syncs

### Long-term (This Quarter)
1. Complete all three phases
2. Achieve 99%+ quality score
3. Full feature completeness

---

## 📝 Document Information

| Field | Value |
|-------|-------|
| **Version** | 2.0 |
| **Last Updated** | September 2026 |
| **Author** | Vibe Code Quality Assurance |
| **Status** | Active |
| **Repository** | hynix666/nexusprompt |
| **Related Documents** | IMPROVEMENT_2026_AUDIT.md, IMPROVEMENT_2026_CHECKLISTS.md |
