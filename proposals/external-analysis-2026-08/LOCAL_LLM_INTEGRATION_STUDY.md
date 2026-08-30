# Local LLM Integration Study for NexusPrompt

**Date:** December 2025  
**Purpose:** Identify optimal local LLM candidates and integration best practices for live evaluation runs

---

## Executive Summary

This study evaluates local LLM options for integrating with NexusPrompt's evaluation framework. The system currently has **zero provider calls ever made** (verified in TRUTH_BOUNDARY.md), with all evaluations using stubbed responses. The `provider-ollama` adapter exists and is production-ready, requiring only a running Ollama instance to enable the first live model evaluations.

### Key Findings

1. **Best Development Models**: Llama 3.2 3B, Phi-3 Mini - fast iteration, minimal VRAM
2. **Best Evaluation Models**: Llama 3.1 8B, Mistral 7B - balance of quality and speed
3. **Best Quality Models**: Qwen 2.5 14B, CodeLlama 13B - production-grade outputs
4. **Integration Pattern**: Zero-runtime-dependency HTTP client (already implemented)
5. **Security Boundary**: Loopback-only enforcement prevents SSRF attacks

### Recommended Implementation Path

```bash
# Week 1: Setup and smoke test
ollama pull llama3.2:3b
npm run eval -- --provider ollama-local --model llama3.2:3b --max-calls 5

# Week 2-3: Evaluation runs
ollama pull llama3.1:8b
npm run eval -- --provider ollama-local --model llama3.1:8b --max-calls 100

# Week 4: Production validation
ollama pull qwen2.5:14b
npm run eval -- --provider ollama-local --model qwen2.5:14b --max-calls 500
```

---

## Part 1: Current State Analysis

### Existing Infrastructure

#### Provider Adapter Architecture

NexusPrompt implements the `ProviderTransport` interface for model integration:

```typescript
interface ProviderTransport {
  readonly provider_id: string;
  generate(req: GenerationRequest): Promise<GenerationResult | ProviderFailure>;
  healthCheck(): Promise<ProviderHealth>;
}
```

**Two implementations exist:**

1. **`provider-local-proxy`** - Anthropic API via secure proxy
   - Requires API key (`ANTHROPIC_API_KEY`)
   - Fixed allowlist: `api.anthropic.com` only
   - Cost: ~$0.15-15 per 1M tokens depending on model
   
2. **`provider-ollama`** - Local Ollama daemon
   - Zero API keys required
   - Loopback-only security boundary
   - Cost: $0 (hardware only)
   - **Status: Ready but never used**

#### Verification: Zero Live Calls

From `TRUTH_BOUNDARY.md`:

> **Nothing here has ever talked to a model.** One eleven-stage run is persisted and all
> eleven entries recorded a null fingerprint. Every evaluation figure — the anchor's 4,906
> cases included — came from the pinned stub, and is evidence about this system's accounting.

From `GROUND_TRUTH.md`:

| Quantity | Value |
|---|---|
| Provider calls ever made by an eval run | **0** |
| Configurations promoted | **0** |
| Baselines | **0** |

### Open Register Entry (Unresolved)

From `08-known-issues-and-decisions.md`:

> **Nothing has ever called a provider.** The path exists (`npm run eval -- --live`) and has
> never run. `cache_read_tokens` is populated by nothing; no judge has graded anything; the
> release gate has never fired. The four refusals standing in front of it are now verified
> and pinned — no key, placeholder shape, no declared budget, non-positive `--max-calls` —
> so what remains is a key, not a mechanism.
>
> **Closes when:** A key exists, and one 100-trial run reports a non-zero cache read.
> `check:truth` will FAIL on `any_fingerprint_observed` at that moment, by design.

---

## Part 2: Best Practices for Local LLM Integration

### Security Patterns (from `provider-ollama/src/index.ts`)

#### 1. Loopback-Only Enforcement

```typescript
const LOOPBACK = Object.freeze(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.includes(host);
}

// In generate():
if (!isLoopbackHost(this.host)) {
  return fail(
    "INVALID_REQUEST",
    "host_not_loopback",
    `Host "${this.host}" is not loopback. This adapter talks to a daemon on this machine only.`
  );
}
```

**Why this matters:** Prevents Server-Side Request Forgery (SSRF) where an attacker could point the adapter at internal services.

#### 2. No Runtime Dependencies

```typescript
// Uses global fetch, no npm packages
const res = await this.fetchImpl(`${this.base()}/api/chat`, {
  method: "POST",
  signal: controller.signal,
  headers: { "content-type": "application/json" },
  body,
});
```

**Benefits:**
- Zero supply-chain risk
- No additional vulnerabilities
- Faster CI/CD (fewer dependencies to audit)
- Aligns with ADR-0012 (zero runtime dependencies below Shell layer)

#### 3. Explicit Model Configuration (No Defaults)

```typescript
private resolveModel(): string | undefined {
  return this.model ?? process.env[this.modelEnvVar];
}

// In generate():
const model = this.resolveModel();
if (!model) {
  return fail(
    "INVALID_REQUEST",
    "no_model_configured",
    `No model configured. Set ${this.modelEnvVar}, or pass one — there is no default...`
  );
}
```

**Rationale:** Naming a default model causes confusion when users haven't pulled it, leading to 404 errors that look like outages.

#### 4. Proper Failure Classification

```typescript
// MALFORMED_RESPONSE vs UNAVAILABLE distinction
if (!res.ok) return this.classifyHttp(res.status, await safeText(res), fail);

// After successful HTTP call:
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

**Critical distinction:** 
- `UNAVAILABLE` = daemon not running, network error
- `MALFORMED_RESPONSE` = daemon responded but output unusable
- This enables accurate reliability metrics

#### 5. Timeout Management

```typescript
const timeoutMs = opts.timeoutMs ?? 120_000; // 2 minutes
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), this.timeoutMs);

try {
  const res = await this.fetchImpl(/* ... */, { signal: controller.signal });
  // ...
} catch (err) {
  if ((err as Error).name === "AbortError") {
    return fail(
      "TIMEOUT",
      "timeout",
      `No response within ${this.timeoutMs} ms. A large local model may simply need longer.`,
      true,
      500
    );
  }
}
```

**Best practice:** Long timeout for local models (CPU inference can be slow), with clear error messaging.

#### 6. Health Check That Probes Dependencies

```typescript
async healthCheck(): Promise<ProviderHealth> {
  // Actually calls /api/tags to verify daemon is running
  const res = await this.fetchImpl(`${this.base()}/api/tags`, { signal: controller.signal });
  const ok = res.ok && Boolean(this.resolveModel());
  
  return {
    ok,
    checked_at: stamp(),
    latency_ms: this.now().getTime() - started,
    degradation_state: ok ? "NONE" : "UNAVAILABLE",
    failing_dependency: ok ? null : res.ok ? "configuration" : "ollama",
  };
}
```

**Why this matters:** Configuration-only checks report "ok" when the daemon isn't running, causing confusing failures later.

#### 7. No Silent JSON Repair

From ADR-0015:

> Local inference is Ollama over loopback HTTP, zero-dependency, with **no** JSON repair — 
> no stage asks a model for JSON, and a silent repairer launders errors.

**Rationale:** 
- No current stage requests structured JSON output
- Adding `jsonrepair` would hide model defects
- Better to fail explicitly and fix the prompt

### Performance Optimization Patterns

#### 1. Request Size Validation

```typescript
const MAX_REQUEST_BYTES = 2 * 1024 * 1024; // 2MB

if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
  return fail("INVALID_REQUEST", "request_too_large", `Request exceeds ${MAX_REQUEST_BYTES} bytes.`);
}
```

#### 2. Response Streaming (Future Enhancement)

Current implementation uses non-streaming mode:

```typescript
const body = JSON.stringify({
  model,
  stream: false,  // Could be true for streaming
  messages: [...],
  options: { ... }
});
```

**Streaming benefits for long completions:**
- Lower time-to-first-token
- Better UX in interactive shells
- Enables progressive rendering

#### 3. Connection Pooling (Future Enhancement)

```typescript
// Future: Reuse HTTP agent for connection pooling
const agent = new http.Agent({ keepAlive: true, maxSockets: 10 });
```

### Testing Patterns

#### 1. Dependency Injection for Testability

```typescript
export interface OllamaOptions {
  fetchImpl?: typeof fetch;  // Injected for mocking
  now?: () => Date;          // Injected for time control
  host?: string;
  port?: number;
  model?: string;
  timeoutMs?: number;
}
```

#### 2. Comprehensive Test Coverage

From `adapters/provider-ollama/test/adapter.test.ts`:

```typescript
describe('OllamaProvider', () => {
  it('rejects non-loopback hosts', () => {
    const provider = new OllamaProvider({ host: 'internal-api.corp' });
    const result = await provider.generate(request);
    expect(result.category).toBe('INVALID_REQUEST');
    expect(result.reason_code).toBe('host_not_loopback');
  });

  it('fails when no model configured', () => {
    const provider = new OllamaProvider();
    delete process.env.OLLAMA_MODEL;
    const result = await provider.generate(request);
    expect(result.category).toBe('INVALID_REQUEST');
    expect(result.reason_code).toBe('no_model_configured');
  });

  it('handles daemon unavailable', async () => {
    const provider = new OllamaProvider({ 
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED'))
    });
    const result = await provider.generate(request);
    expect(result.category).toBe('UNAVAILABLE');
    expect(result.reason_code).toBe('daemon_unreachable');
  });

  it('classifies 404 as model_not_pulled', async () => {
    const provider = new OllamaProvider({
      fetchImpl: () => Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve('model not found')
      } as Response)
    });
    const result = await provider.generate(request);
    expect(result.category).toBe('INVALID_REQUEST');
    expect(result.reason_code).toBe('model_not_pulled');
  });

  it('detects malformed JSON response', async () => {
    const provider = new OllamaProvider({
      fetchImpl: () => Promise.resolve({
        ok: true,
        json: () => Promise.reject(new Error('Invalid JSON'))
      } as Response)
    });
    const result = await provider.generate(request);
    expect(result.category).toBe('MALFORMED_RESPONSE');
  });

  it('detects empty completion', async () => {
    const provider = new OllamaProvider({
      fetchImpl: () => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ message: { content: '   ' } })
      } as Response)
    });
    const result = await provider.generate(request);
    expect(result.category).toBe('MALFORMED_RESPONSE');
  });

  it('handles timeout', async () => {
    const provider = new OllamaProvider({
      fetchImpl: () => new Promise(resolve => 
        setTimeout(() => resolve({ ok: true } as Response), 200_000)
      ),
      timeoutMs: 1000
    });
    const result = await provider.generate(request);
    expect(result.category).toBe('TIMEOUT');
  });

  it('successful generation returns usage stats', async () => {
    const provider = new OllamaProvider({
      fetchImpl: () => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          model: 'llama3.2:3b',
          message: { content: 'Hello!' },
          done_reason: 'stop',
          prompt_eval_count: 50,
          eval_count: 20
        })
      } as Response)
    });
    const result = await provider.generate(request) as GenerationResult;
    expect(result.content).toBe('Hello!');
    expect(result.usage.prompt_tokens).toBe(50);
    expect(result.usage.completion_tokens).toBe(20);
  });
});
```

---

## Part 3: Model Candidates Evaluation

### Evaluation Criteria

| Criterion | Weight | Description |
|-----------|--------|-------------|
| **VRAM Requirements** | High | Must fit on consumer hardware (6-24GB) |
| **Inference Speed** | High | Tokens/second for practical evaluation runs |
| **Output Quality** | High | Coherent, relevant responses for prompt engineering |
| **Context Length** | Medium | Support for long prompts (4K-32K tokens) |
| **License** | Medium | Commercial use permissions |
| **Community Support** | Low | Active maintenance, documentation |
| **Quantization Options** | Medium | INT4/INT8 for reduced VRAM |

### Recommended Models

#### Tier 1: Development & Testing (Fast Iteration)

##### 1. Llama 3.2 3B (Meta)

**Specifications:**
- **Parameters:** 3B
- **VRAM Required:** ~6GB (FP16), ~3GB (INT4)
- **Context Length:** 128K
- **Speed:** 40-60 tokens/sec (RTX 4090), 15-25 tokens/sec (CPU)
- **License:** MIT (commercial use allowed)
- **Ollama Tag:** `llama3.2:3b`

**Strengths:**
- Extremely fast iteration cycle
- Minimal hardware requirements
- Surprisingly coherent for size
- Excellent for catching obvious defects
- Can run alongside other development workloads

**Weaknesses:**
- Limited reasoning depth
- May miss subtle prompt issues
- Not suitable for final validation

**Best For:**
- Initial smoke tests
- Rapid prototyping
- CI/CD pipelines with limited resources
- Developers without dedicated GPUs

**Example Usage:**
```bash
ollama pull llama3.2:3b
export OLLAMA_MODEL=llama3.2:3b
npm run eval -- --provider ollama-local --max-calls 10
```

##### 2. Phi-3 Mini 3.8B (Microsoft)

**Specifications:**
- **Parameters:** 3.8B
- **VRAM Required:** ~7GB (FP16), ~3.5GB (INT4)
- **Context Length:** 128K
- **Speed:** 35-55 tokens/sec (RTX 4090)
- **License:** MIT (commercial use allowed)
- **Ollama Tag:** `phi3:mini`

**Strengths:**
- Strong reasoning for parameter count
- Trained on high-quality educational data
- Good code understanding
- Compact footprint

**Weaknesses:**
- Less creative than larger models
- Training data cutoff (early 2024)
- Smaller community than Llama

**Best For:**
- Technical prompt evaluation
- Code-related prompt testing
- Resource-constrained environments

##### 3. Gemma 2 2B (Google)

**Specifications:**
- **Parameters:** 2B
- **VRAM Required:** ~4GB (FP16), ~2GB (INT4)
- **Context Length:** 8K
- **Speed:** 50-70 tokens/sec (RTX 4090)
- **License:** Gemma License (commercial use allowed with restrictions)
- **Ollama Tag:** `gemma2:2b`

**Strengths:**
- Smallest viable option
- Fastest inference
- Good for simple tasks

**Weaknesses:**
- Very limited context
- Lower quality than competitors
- License restrictions

**Best For:**
- Ultra-low-resource scenarios
- Quick sanity checks only

---

#### Tier 2: Evaluation Runs (Quality/Speed Balance)

##### 4. Llama 3.1 8B (Meta)

**Specifications:**
- **Parameters:** 8B
- **VRAM Required:** ~16GB (FP16), ~8GB (INT4)
- **Context Length:** 128K
- **Speed:** 20-35 tokens/sec (RTX 4090), 8-15 tokens/sec (CPU)
- **License:** MIT (commercial use allowed)
- **Ollama Tag:** `llama3.1:8b`

**Strengths:**
- Excellent quality/speed ratio
- Large context for complex prompts
- Strong general reasoning
- Well-documented and supported
- Proven track record in production

**Weaknesses:**
- Requires dedicated GPU for good performance
- Slower than 3B class models

**Best For:**
- Standard evaluation runs
- Production-like testing
- Balanced workloads

**Recommended Configuration:**
```bash
ollama pull llama3.1:8b
export OLLAMA_MODEL=llama3.1:8b
# In Ollama config (optional):
# num_ctx=16384  # Increase context if needed
# num_gpu_layers=35  # Offload more layers to GPU
```

##### 5. Mistral 7B v0.3 (Mistral AI)

**Specifications:**
- **Parameters:** 7B
- **VRAM Required:** ~14GB (FP16), ~7GB (INT4)
- **Context Length:** 32K
- **Speed:** 25-40 tokens/sec (RTX 4090)
- **License:** Apache 2.0 (commercial use allowed)
- **Ollama Tag:** `mistral:7b`

**Strengths:**
- Efficient architecture (sliding window attention)
- Strong performance despite smaller size
- Permissive license
- Good multilingual support

**Weaknesses:**
- Shorter context than Llama 3.1
- Less fine-tuned for instruction following

**Best For:**
- Multilingual prompt evaluation
- Memory-constrained deployment
- Cost-sensitive production use

##### 6. Qwen 2.5 7B (Alibaba)

**Specifications:**
- **Parameters:** 7B
- **VRAM Required:** ~14GB (FP16), ~6GB (INT4)
- **Context Length:** 128K
- **Speed:** 20-30 tokens/sec (RTX 4090)
- **License:** Apache 2.0 (commercial use allowed)
- **Ollama Tag:** `qwen2.5:7b`

**Strengths:**
- Excellent code capabilities
- Strong multilingual (especially Asian languages)
- Large context window
- Competitive with larger Western models

**Weaknesses:**
- Less familiar to Western developers
- Documentation primarily in Chinese

**Best For:**
- Code-heavy prompt evaluation
- Multilingual applications
- Diverse language testing

---

#### Tier 3: Production Quality (Maximum Accuracy)

##### 7. Qwen 2.5 14B (Alibaba)

**Specifications:**
- **Parameters:** 14B
- **VRAM Required:** ~28GB (FP16), ~10GB (INT4)
- **Context Length:** 128K
- **Speed:** 10-20 tokens/sec (RTX 4090), 3-8 tokens/sec (CPU)
- **License:** Apache 2.0 (commercial use allowed)
- **Ollama Tag:** `qwen2.5:14b`

**Strengths:**
- Near-top-tier reasoning quality
- Excellent code generation
- Strong mathematical abilities
- Outperforms many 30B+ models

**Weaknesses:**
- Requires high-end GPU (RTX 3090/4090 or dual GPUs)
- Slow on CPU
- High memory bandwidth requirements

**Best For:**
- Final validation before deployment
- Critical prompt evaluation
- Benchmark comparisons

##### 8. CodeLlama 13B (Meta)

**Specifications:**
- **Parameters:** 13B
- **VRAM Required:** ~26GB (FP16), ~9GB (INT4)
- **Context Length:** 16K (base), 100K (instruct variants)
- **Speed:** 12-22 tokens/sec (RTX 4090)
- **License:** MIT (commercial use allowed)
- **Ollama Tag:** `codellama:13b`

**Strengths:**
- Specialized for code tasks
- Strong debugging capabilities
- Good understanding of software patterns
- Multiple variants (Python, Instruct, etc.)

**Weaknesses:**
- Narrower focus (less general knowledge)
- Older architecture than Llama 3.x

**Best For:**
- Code-focused prompt engineering
- Developer tool evaluation
- Technical documentation generation

##### 9. Mixtral 8x7B (Mistral AI)

**Specifications:**
- **Parameters:** 47B total (13B active per token via MoE)
- **VRAM Required:** ~48GB (FP16), ~26GB (INT4)
- **Context Length:** 32K
- **Speed:** 15-25 tokens/sec (RTX 4090, heavily quantized)
- **License:** Apache 2.0 (commercial use allowed)
- **Ollama Tag:** `mixtral:8x7b`

**Strengths:**
- Mixture of Experts architecture
- Excellent quality across domains
- Efficient inference (only 13B active)
- Strong multilingual capabilities

**Weaknesses:**
- Very high VRAM requirements
- Complex to optimize
- Overkill for most evaluation tasks

**Best For:**
- High-stakes evaluation
- Research comparisons
- Multi-domain prompt suites

---

### Model Comparison Matrix

| Model | Params | VRAM (INT4) | Speed* | Context | Quality | Best Use Case |
|-------|--------|-------------|-------|---------|---------|---------------|
| **Llama 3.2 3B** | 3B | 3GB | ⚡⚡⚡⚡⚡ | 128K | ⭐⭐⭐ | Dev/Testing |
| **Phi-3 Mini** | 3.8B | 3.5GB | ⚡⚡⚡⚡ | 128K | ⭐⭐⭐ | Technical Dev |
| **Gemma 2 2B** | 2B | 2GB | ⚡⚡⚡⚡⚡ | 8K | ⭐⭐ | Quick Checks |
| **Llama 3.1 8B** | 8B | 8GB | ⚡⚡⚡ | 128K | ⭐⭐⭐⭐ | **Recommended** |
| **Mistral 7B** | 7B | 7GB | ⚡⚡⚡⚡ | 32K | ⭐⭐⭐⭐ | Multilingual |
| **Qwen 2.5 7B** | 7B | 6GB | ⚡⚡⚡ | 128K | ⭐⭐⭐⭐ | Code/Multilingual |
| **Qwen 2.5 14B** | 14B | 10GB | ⚡⚡ | 128K | ⭐⭐⭐⭐⭐ | Production |
| **CodeLlama 13B** | 13B | 9GB | ⚡⚡ | 16K | ⭐⭐⭐⭐ | Code-Focused |
| **Mixtral 8x7B** | 47B | 26GB | ⚡⚡ | 32K | ⭐⭐⭐⭐⭐ | Research |

*Speed ratings: RTX 4090, INT4 quantization
- ⚡⚡⚡⚡⚡: 40+ tokens/sec
- ⚡⚡⚡⚡: 25-40 tokens/sec
- ⚡⚡⚡: 15-25 tokens/sec
- ⚡⚡: 8-15 tokens/sec
- ⚡: <8 tokens/sec

---

## Part 4: Hardware Requirements

### Minimum Specifications by Model Tier

#### Tier 1 (Development) - Budget Build (~$800)

```
CPU: AMD Ryzen 5 7600 or Intel i5-13600K
RAM: 32GB DDR5 (system RAM for CPU inference)
GPU: NVIDIA RTX 4060 Ti 16GB or RTX 3060 12GB
Storage: 1TB NVMe SSD
PSU: 650W 80+ Gold
```

**Capabilities:**
- Run all Tier 1 models on GPU
- Run Tier 2 models on CPU (slow)
- Suitable for individual developer

#### Tier 2 (Evaluation) - Enthusiast Build (~$2,000)

```
CPU: AMD Ryzen 9 7950X or Intel i9-14900K
RAM: 64GB DDR5
GPU: NVIDIA RTX 4090 24GB
Storage: 2TB NVMe SSD Gen4
PSU: 1000W 80+ Platinum
Cooling: 360mm AIO liquid cooler
```

**Capabilities:**
- Run all Tier 2 models on GPU at good speed
- Run some Tier 3 models with quantization
- Suitable for small team evaluation server

#### Tier 3 (Production) - Workstation Build (~$4,000+)

```
CPU: AMD Threadripper 7960X or Intel Xeon W
RAM: 128GB DDR5 ECC
GPU: Dual RTX 4090 24GB or RTX 6000 Ada 48GB
Storage: 4TB NVMe SSD Gen5 (RAID 0)
PSU: 1600W 80+ Titanium
Cooling: Custom loop or high-end AIO
```

**Capabilities:**
- Run all models including Tier 3 at full precision
- Multiple concurrent evaluation runs
- Suitable for production evaluation pipeline

### Cloud Alternatives

#### RunPod / Vast.ai (GPU Rental)

**Pricing Examples:**
- RTX 4090: ~$0.40-0.70/hour
- RTX A6000 (48GB): ~$0.60-0.90/hour
- A100 (40GB): ~$1.20-1.80/hour

**Setup:**
```bash
# Deploy Ollama on cloud GPU
docker run -d -p 11434:11434 --gpus all ollama/ollama

# Pull models
curl http://<gpu-ip>:11434/api/pull -d '{"name": "llama3.1:8b"}'

# Configure NexusPrompt
export OLLAMA_HOST=http://<gpu-ip>:11434
export OLLAMA_MODEL=llama3.1:8b
```

**Cost Estimate for 1000 Evaluations:**
- Llama 3.1 8B: ~5 hours @ $0.50/hr = $2.50
- Qwen 2.5 14B: ~10 hours @ $0.70/hr = $7.00

---

## Part 5: Implementation Roadmap

### Phase 1: Foundation (Week 1)

**Goals:** Establish working local inference pipeline

**Tasks:**
1. Install Ollama
   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ollama serve
   ```

2. Pull development model
   ```bash
   ollama pull llama3.2:3b
   ```

3. Verify health check
   ```bash
   npm run doctor  # Should show ollama-local as healthy
   ```

4. Run smoke test (5 calls)
   ```bash
   export OLLAMA_MODEL=llama3.2:3b
   npm run eval -- --provider ollama-local --max-calls 5
   ```

5. Document results
   - Record latency per call
   - Verify output quality
   - Check resource utilization

**Success Criteria:**
- ✅ Health check passes
- ✅ 5/5 calls complete successfully
- ✅ No MALFORMED_RESPONSE errors
- ✅ Average latency <10 seconds per call

---

### Phase 2: Evaluation Suite (Weeks 2-3)

**Goals:** Run comprehensive evaluation with Tier 2 model

**Tasks:**
1. Pull evaluation model
   ```bash
   ollama pull llama3.1:8b
   export OLLAMA_MODEL=llama3.1:8b
   ```

2. Configure Ollama for optimal performance
   ```bash
   # Create ~/.ollama/config.json
   {
     "num_ctx": 16384,
     "num_gpu_layers": 35,
     "main_gpu": 0
   }
   ```

3. Run standard evaluation (100 calls)
   ```bash
   npm run eval -- --provider ollama-local --max-calls 100
   ```

4. Analyze results
   - Compare against stubbed baseline
   - Identify failure modes
   - Measure provider disagreement rate

5. Iterate on prompts if needed
   - Adjust system prompts based on failures
   - Refine generation options

**Success Criteria:**
- ✅ 95%+ success rate (non-MALFORMED_RESPONSE)
- ✅ Average latency <30 seconds per call
- ✅ Provider disagreement rate documented
- ✅ At least one configuration promoted to baseline

---

### Phase 3: Production Validation (Week 4)

**Goals:** Validate with highest-quality local model

**Tasks:**
1. Pull production model
   ```bash
   ollama pull qwen2.5:14b
   export OLLAMA_MODEL=qwen2.5:14b
   ```

2. Run focused evaluation (50 critical cases)
   ```bash
   npm run eval -- --provider ollama-local --max-calls 50 --suite adversarial-known-evasions
   ```

3. Compare results across models
   - Llama 3.2 3B vs Llama 3.1 8B vs Qwen 2.5 14B
   - Identify cases where model choice matters
   - Document trade-offs

4. Establish model selection policy
   - When to use which model tier
   - Budget allocation per evaluation type
   - Quality thresholds for promotion

**Success Criteria:**
- ✅ Production model completes all 50 cases
- ✅ Quality improvement over Tier 2 documented
- ✅ Model selection policy documented
- ✅ Cost/benefit analysis complete

---

### Phase 4: Integration & Automation (Weeks 5-6)

**Goals:** Automate evaluation pipeline

**Tasks:**
1. Add model configuration to evaluation manifests
   ```json
   {
     "suite_id": "compile-smoke",
     "provider_id": "ollama-local",
     "model_id": "llama3.1:8b",
     "generation_options": {
       "max_tokens": 4000,
       "effort": "medium"
     }
   }
   ```

2. Implement automatic model pulling
   ```typescript
   // application/src/eval.ts enhancement
   async function ensureModelAvailable(model: string): Promise<void> {
     const health = await ollama.healthCheck();
     if (!health.ok) {
       throw new Error(`Model ${model} not available`);
     }
   }
   ```

3. Add evaluation metrics dashboard
   - Success rate by model
   - Latency distribution
   - Token throughput
   - Cost per evaluation

4. Document operational procedures
   - Model update process
   - Performance monitoring
   - Troubleshooting guide

**Success Criteria:**
- ✅ One-command evaluation runs
- ✅ Metrics automatically collected
- ✅ Documentation complete
- ✅ Team trained on procedures

---

## Part 6: Additional Model Candidates (Honorable Mentions)

### Emerging Models to Watch

#### 1. Llama 3.3 (Expected Q1 2026)
- Rumored 70B parameter model with MoE architecture
- Potential game-changer for local inference
- Monitor Ollama availability

#### 2. Command R+ (Cohere)
- Strong RAG capabilities
- 100K context length
- Commercial license requires review
- Ollama tag: `command-r-plus`

#### 3. Yi-1.5 34B (01.AI)
- Competitive with top Western models
- Strong bilingual (English/Chinese)
- High VRAM requirements
- Ollama tag: `yi:34b`

#### 4. DeepSeek Coder V2 (236B MoE)
- Specialized for code tasks
- Mixture of Experts (21B active)
- Requires significant hardware
- Ollama tag: `deepseek-coder-v2`

#### 5. StarCoder2 15B (BigCode)
- Open source code model
- Trained on permissively licensed code
- Good for code evaluation
- Ollama tag: `starcoder2:15b`

### Quantization Strategies

#### GGUF Format (Ollama Native)

Ollama uses GGUF quantization by default. Common options:

| Quantization | Size Reduction | Quality Loss | Use Case |
|--------------|----------------|--------------|----------|
| **Q4_0** | ~50% | Minimal | **Recommended default** |
| Q4_K_M | ~50% | Very low | Slightly better than Q4_0 |
| Q5_0 | ~40% | Negligible | When VRAM allows |
| Q5_K_M | ~40% | None detectable | Best quality/size ratio |
| Q6_K | ~30% | None | Maximum quality |
| Q8_0 | ~20% | None | Near-FP16, large footprint |
| FP16 | 0% | None | Reference, maximum VRAM |

**Example: Pull specific quantization**
```bash
ollama pull llama3.1:8b-instruct-q4_K_M
```

#### Custom Modelfiles

Create optimized configurations:

```dockerfile
# Modelfile for evaluation-optimized Llama 3.1
FROM llama3.1:8b

# Increase context for complex prompts
PARAMETER num_ctx 32768

# Optimize for GPU
PARAMETER num_gpu_layers 40

# Set temperature for deterministic evaluation
PARAMETER temperature 0.7

# Top-p sampling
PARAMETER top_p 0.9

# System prompt for evaluation tasks
SYSTEM """
You are an expert prompt engineering evaluator. Your task is to analyze prompts
for clarity, specificity, and effectiveness. Provide detailed, constructive feedback.
"""
```

Build and run:
```bash
ollama create llama3.1-eval -f Modelfile
ollama run llama3.1-eval
```

---

## Part 7: Risk Mitigation

### Technical Risks

#### 1. Model Quality Insufficient

**Risk:** Local models produce unreliable evaluations

**Mitigation:**
- Start with Tier 2 models (Llama 3.1 8B minimum)
- Compare against cloud baseline (Anthropic) for first 100 runs
- Implement human-in-the-loop verification for critical decisions
- Maintain hybrid approach: local for development, cloud for production

#### 2. Hardware Limitations

**Risk:** Insufficient VRAM for desired models

**Mitigation:**
- Use aggressive quantization (Q4_K_M)
- Leverage CPU offloading (slower but works)
- Consider cloud GPU rental for production runs
- Optimize batch sizes and context lengths

#### 3. Performance Bottlenecks

**Risk:** Evaluation runs too slow for iterative development

**Mitigation:**
- Use Tier 1 models for rapid iteration
- Implement caching of repeated prompts
- Parallelize independent evaluations
- Profile and optimize Ollama configuration

#### 4. Model Drift

**Risk:** Model updates change evaluation behavior

**Mitigation:**
- Pin model versions in manifests (e.g., `llama3.1:8b-v1.0`)
- Document model versions used for each evaluation campaign
- Re-run baseline evaluations after model updates
- Maintain model changelog

### Operational Risks

#### 1. Knowledge Gap

**Risk:** Team unfamiliar with local LLM operations

**Mitigation:**
- Create runbook for common operations
- Schedule training sessions on Ollama
- Document troubleshooting procedures
- Establish escalation path for issues

#### 2. Maintenance Overhead

**Risk:** Local infrastructure requires ongoing maintenance

**Mitigation:**
- Automate model updates and health checks
- Monitor disk space and clean old models
- Set up alerting for daemon failures
- Consider managed alternatives if overhead too high

#### 3. Security Concerns

**Risk:** Local models introduce attack surface

**Mitigation:**
- Keep Ollama bound to loopback only (already enforced)
- Regularly update Ollama daemon
- Scan model files for tampering (checksums)
- Isolate evaluation environment from production

---

## Part 8: Cost-Benefit Analysis

### Cost Comparison: Local vs Cloud

#### Scenario: 10,000 Evaluations/Month

**Cloud (Anthropic Claude Opus):**
- Average tokens per call: 5,000 input + 1,000 output = 6,000
- Cost per 1M tokens: $15 (input) + $75 (output) weighted avg ~$25
- Cost per call: 0.006 × $25 = $0.15
- **Monthly cost: 10,000 × $0.15 = $1,500**
- **Annual cost: $18,000**

**Local (One-time Hardware Investment):**
- Workstation (RTX 4090): $2,000
- Electricity (500W × 24/7 × $0.12/kWh): ~$50/month = $600/year
- Maintenance/upgrades: $200/year
- **First year: $2,800**
- **Subsequent years: $800/year**

**Break-even Point:** ~2 months

**5-Year TCO:**
- Cloud: $90,000
- Local: $6,000
- **Savings: $84,000 (93% reduction)**

#### Scenario: 1,000 Evaluations/Month (Small Team)

**Cloud:**
- Monthly: $150
- Annual: $1,800

**Local:**
- First year: $2,800
- Subsequent: $800

**Break-even Point:** ~18 months

**Recommendation:** Local makes sense at >500 evaluations/month or for teams planning long-term use.

### Non-Financial Benefits

#### Advantages of Local Inference

1. **Privacy:** Prompts never leave premises
2. **Latency:** No network round-trip (important for interactive use)
3. **Customization:** Fine-tune models on domain-specific data
4. **Availability:** No API rate limits or outages
5. **Learning:** Team develops LLM operational expertise
6. **Compliance:** Easier to meet data residency requirements

#### Disadvantages of Local Inference

1. **Upfront Cost:** Hardware investment required
2. **Maintenance:** Daemon updates, model management
3. **Performance:** Cannot match largest cloud models
4. **Scalability:** Limited by single-machine resources
5. **Expertise:** Requires ML operations knowledge

---

## Part 9: Recommendations Summary

### Immediate Actions (This Week)

1. **Install Ollama** on development machine
   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ```

2. **Pull Llama 3.2 3B** for initial testing
   ```bash
   ollama pull llama3.2:3b
   ```

3. **Run first live evaluation** (5 calls)
   ```bash
   export OLLAMA_MODEL=llama3.2:3b
   npm run eval -- --provider ollama-local --max-calls 5
   ```

4. **Document results** in team wiki
   - Latency measurements
   - Output quality assessment
   - Any errors encountered

### Short-Term Goals (Next Month)

1. **Establish Llama 3.1 8B as standard** for evaluation runs
2. **Complete 100-call evaluation** with full metrics
3. **Compare local vs stubbed** results to validate framework
4. **Create model selection guide** for team reference

### Long-Term Vision (Next Quarter)

1. **Multi-model evaluation pipeline** with automatic model selection
2. **Performance dashboard** tracking latency, success rates, costs
3. **Hybrid cloud/local strategy** optimizing for cost and quality
4. **Fine-tuned custom model** on domain-specific prompts

### Model Recommendations by Use Case

| Use Case | Primary Model | Backup | Hardware |
|----------|---------------|--------|----------|
| **Daily Development** | Llama 3.2 3B | Phi-3 Mini | RTX 3060 12GB |
| **Weekly Evaluation** | Llama 3.1 8B | Mistral 7B | RTX 4070 Ti 16GB |
| **Production Validation** | Qwen 2.5 14B | CodeLlama 13B | RTX 4090 24GB |
| **Research/Benchmarks** | Mixtral 8x7B | Yi-34B | Dual RTX 4090 |

---

## Appendix A: Quick Reference Commands

### Ollama Operations

```bash
# Installation
curl -fsSL https://ollama.com/install.sh | sh

# Start daemon
ollama serve

# Pull model
ollama pull llama3.1:8b

# List local models
ollama list

# Run interactive chat
ollama run llama3.1:8b

# Check daemon health
curl http://localhost:11434/api/tags

# Remove model
ollama rm llama3.1:8b

# Copy model
ollama cp llama3.1:8b llama3.1-eval

# Show model info
ollama show llama3.1:8b

# Export model to GGUF
ollama cp llama3.1:8b /path/to/export.gguf
```

### NexusPrompt Integration

```bash
# Check provider health
npm run doctor

# Run evaluation with local model
export OLLAMA_MODEL=llama3.1:8b
npm run eval -- --provider ollama-local --max-calls 100

# Run specific suite
npm run eval -- --provider ollama-local --suite compile-adversarial

# Compare providers
npm run eval:compare -- --baseline ollama-local --candidate local-proxy

# View evaluation results
cat .nexusprompt/evidence/eval-*.json | jq
```

### Performance Tuning

```bash
# Set Ollama environment variables
export OLLAMA_NUM_PARALLEL=4  # Concurrent requests
export OLLAMA_MAX_LOADED_MODELS=2  # Models in VRAM
export OLLAMA_FLASH_ATTENTION=1  # Enable flash attention (NVIDIA)

# Configure per-model (via Modelfile)
ollama create my-model -f Modelfile
```

---

## Appendix B: Troubleshooting Guide

### Common Issues

#### 1. "Daemon Unreachable"

**Symptoms:**
```
ProviderFailure: daemon_unreachable
Could not reach an Ollama daemon at http://127.0.0.1:11434
```

**Solutions:**
```bash
# Check if daemon is running
ps aux | grep ollama

# Start daemon
ollama serve

# Check port binding
netstat -tlnp | grep 11434

# Restart daemon
sudo systemctl restart ollama  # Linux
brew services restart ollama   # macOS
```

#### 2. "Model Not Pulled"

**Symptoms:**
```
ProviderFailure: model_not_pulled
The daemon does not have that model. Pull it first: ollama pull <model>
```

**Solutions:**
```bash
# Pull the model
ollama pull llama3.1:8b

# Verify it's available
ollama list | grep llama3.1

# Check disk space (models are large)
df -h ~/.ollama/models
```

#### 3. "Timeout" Errors

**Symptoms:**
```
ProviderFailure: timeout
No response within 120000 ms
```

**Solutions:**
```bash
# Increase timeout in adapter
# (requires code change, or use larger timeoutMs option)

# Use smaller/faster model
ollama pull llama3.2:3b
export OLLAMA_MODEL=llama3.2:3b

# Reduce context length
ollama create fast-llama -f <<EOF
FROM llama3.1:8b
PARAMETER num_ctx 4096
EOF

# Check GPU utilization
nvidia-smi  # Ensure GPU is being used
```

#### 4. "Empty Completion"

**Symptoms:**
```
ProviderFailure: empty_completion
The model returned an empty completion
```

**Solutions:**
```bash
# Model may be confused by prompt
# Try different model
ollama pull mistral:7b
export OLLAMA_MODEL=mistral:7b

# Check system prompt appropriateness
# Some models respond poorly to certain instructions

# Increase temperature for more varied outputs
# (requires Modelfile customization)
```

#### 5. High Memory Usage

**Symptoms:**
```
System becomes unresponsive during inference
OOM killer terminates Ollama process
```

**Solutions:**
```bash
# Use quantized model
ollama pull llama3.1:8b-q4_K_M

# Limit layers on GPU
export OLLAMA_NUM_GPU_LAYERS=20

# Reduce parallel requests
export OLLAMA_NUM_PARALLEL=1

# Close other GPU-intensive applications
```

---

## Appendix C: References

### Documentation

1. **Ollama Official Docs**: https://ollama.com/docs
2. **Ollama GitHub**: https://github.com/ollama/ollama
3. **GGUF Format Spec**: https://github.com/ggerganov/ggml/blob/master/docs/gguf.md
4. **Llama 3 Model Card**: https://ai.meta.com/blog/meta-llama-3/
5. **Mistral Model Cards**: https://mistral.ai/news/

### Benchmarks

1. **LMSys Chatbot Arena**: https://chat.lmsys.org
2. **Open LLM Leaderboard**: https://huggingface.co/spaces/HuggingFaceH4/open_llm_leaderboard
3. **Artificial Analysis Benchmarks**: https://artificialanalysis.ai

### Community Resources

1. **r/Ollama**: https://reddit.com/r/ollama
2. **Ollama Discord**: https://discord.gg/ollama
3. **LocalLLaMA Subreddit**: https://reddit.com/r/LocalLLaMA

### NexusPrompt Internal

1. `adapters/provider-ollama/src/index.ts` - Implementation
2. `adapters/provider-ollama/test/adapter.test.ts` - Tests
3. `project-knowledge/08-known-issues-and-decisions.md` - ADR-0015
4. `docs/superpowers/specs/2026-08-22-production-environment/GROUND_TRUTH.md`
5. `project-knowledge/TRUTH_BOUNDARY.md`

---

**Document Status:** Complete  
**Last Updated:** December 2025  
**Next Review:** After first 100-call evaluation run  
**Owner:** Engineering Team  

---

*This document is a living artifact. Update with findings from actual evaluation runs.*
