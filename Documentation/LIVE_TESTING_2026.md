# Live Provider Testing Guide

> **Status**: Active - September 2026  
> **Version**: 1.0.0  
> **Purpose**: Comprehensive guide for testing with live providers  
> **Phase**: Phase 3 (Weeks 21-24)  
> **Related**: [IMPROVEMENT_2026_REVISED.md](./IMPROVEMENT_2026_REVISED.md)

---

## 📊 Overview

This guide provides a comprehensive approach to testing NexusPrompt with **live providers** (Anthropic, OpenAI, Ollama, etc.). Live testing validates that the system works correctly with real language models, captures model fingerprints, and verifies budget enforcement.

**Key Objectives:**
1. Run evaluation suites against live providers
2. Capture and verify model fingerprints
3. Test budget enforcement and retry logic
4. Validate cache read/write mechanisms
5. Verify failure classification

---

## 🎯 Requirements

### Prerequisites

1. **API Keys**: Valid API keys for the providers you want to test
2. **Budget**: Sufficient budget for API calls (recommended: $50-100 for full evaluation)
3. **Environment**: Node.js 24+, npm, git
4. **Repository**: NexusPrompt cloned and dependencies installed
5. **Configuration**: Provider adapters configured

### Supported Providers

| Provider | Adapter | Status | Notes |
|----------|---------|--------|-------|
| Anthropic | `provider-local-proxy` | ✅ Supported | Uses Anthropic API |
| Ollama | `provider-ollama` | ✅ Supported | Local daemon, loopback-only |
| OpenAI | `provider-hosted-server` | 🟡 Planned | Requires implementation |
| Other | Custom adapter | ❌ Not yet | Can be added |

---

## 🏗️ Architecture

### Testing Components

```
┌─────────────────────────────────────────────────────────────┐
│                      Live Testing System                        │
├─────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    │
│  │   Test        │    │   Provider    │    │   Budget      │    │
│  │   Runner      │───▶│   Adapter     │───▶│   Tracker    │    │
│  └──────────────┘    └──────────────┘    └──────────────┘    │
│           ▲                  ▲                  ▲              │
│           │                  │                  │              │
│  ┌────────┴────────┐  ┌─────┴─────┐    ┌─────┴─────┐        │
│  │   Evaluation    │  │  API        │    │  Rate       │        │
│  │   Suites        │  │  Client     │    │  Limiter     │        │
│  └─────────────────┘  └─────────────┘    └─────────────┘        │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    Results & Logging                        │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

```
1. Load evaluation suite (JSON files)
2. Configure provider adapter with API key
3. Set budget limits
4. Run evaluation with retry logic
5. Collect results
6. Capture model fingerprints
7. Generate reports
8. Verify cache behavior
```

---

## 📐 Test Environment Setup

### Step 1: Clone and Configure

```bash
# Clone the repository
git clone https://github.com/hynix666/nexusprompt.git
cd nexusprompt

# Install dependencies
npm install

# Verify installation
npm run verify
```

### Step 2: Configure API Keys

Create a `.env` file in the root directory:

```bash
# Anthropic API key (for provider-local-proxy)
export ANTHROPIC_API_KEY='your-anthropic-api-key'

# Ollama configuration (optional)
export OLLAMA_BASE_URL='http://localhost:11434'
export OLLAMA_MODEL='llama3:70b'

# Budget limits
export MAX_PROVIDER_CALLS=1400
export TRIALS=100

# Other settings
export LOG_LEVEL='info'
export ENABLE_TRACING='false'
```

**Security Note**: Never commit API keys to version control. Use `.gitignore` to exclude `.env` files.

### Step 3: Configure Provider Adapters

#### Anthropic (provider-local-proxy)

The `provider-local-proxy` adapter is configured in `adapters/provider-local-proxy/src/index.ts`:

```typescript
// Default configuration
const DEFAULT_CONFIG = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseUrl: 'https://api.anthropic.com',
  // ...
};
```

#### Ollama (provider-ollama)

The `provider-ollama` adapter is configured in `adapters/provider-ollama/src/index.ts`:

```typescript
// Default configuration
const DEFAULT_CONFIG = {
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  model: process.env.OLLAMA_MODEL || 'llama3:70b',
  // ...
};
```

### Step 4: Verify Configuration

```bash
# Check that environment variables are set
echo "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-NOT SET}"
echo "OLLAMA_BASE_URL: ${OLLAMA_BASE_URL:-NOT SET}"
echo "OLLAMA_MODEL: ${OLLAMA_MODEL:-NOT SET}"

# Test provider health
node -e "
import('file://./adapters/provider-local-proxy/src/index.js').then(m => {
  const provider = m.default({ apiKey: process.env.ANTHROPIC_API_KEY });
  provider.healthCheck().then(h => console.log('Anthropic health:', h)).catch(e => console.error(e));
})
"
```

---

## 🚀 Running Live Tests

### Quick Start

```bash
# Dry run (no actual API calls)
npm run eval -- --live --dry-run

# Small test (10 trials, 100 max calls)
npm run eval -- --live --trials 10 --max-calls 100

# Full evaluation
npm run eval -- --live --trials 100 --max-calls 1400
```

### Command Line Options

```
Usage: npm run eval -- [options]

Options:
  --live              Run with live providers
  --dry-run          Simulate without API calls
  --trials <n>       Number of trials (default: 100)
  --max-calls <n>    Maximum provider calls (default: 1400)
  --suite <file>     Specific evaluation suite to run
  --provider <id>    Specific provider to use
  --model <name>     Specific model to use
  --write            Write results to disk
  --verbose          Enable verbose logging
  --help             Show this help

Examples:
  # Run with specific suite
  npm run eval -- --live --suite eval/compile-smoke.json

  # Run with specific provider
  npm run eval -- --live --provider provider-ollama

  # Run with specific model
  npm run eval -- --live --provider provider-local-proxy --model claude-3-sonnet-20240229
```

### Evaluation Suites

NexusPrompt includes several evaluation suites:

| Suite | File | Purpose | Cases |
|-------|------|---------|-------|
| Compile Smoke | `eval/compile-smoke.json` | Basic compilation | 10 |
| Full | `eval/full.json` | Complete evaluation | 100 |
| Edge Cases | `eval/edge-cases.json` | Boundary conditions | 20 |
| Regression | `eval/regression.json` | Previously fixed issues | 15 |
| Performance | `eval/performance.json` | Large inputs | 10 |
| Multi-Stage | `eval/multi-stage.json` | Pipeline interactions | 25 |

**Total**: 180 cases across all suites

### Running Specific Suites

```bash
# Compile smoke test
npm run eval -- --live --suite eval/compile-smoke.json --max-calls 50

# Full evaluation
npm run eval -- --live --suite eval/full.json --max-calls 1400

# All suites
npm run eval -- --live --trials 100 --max-calls 1400
```

---

## 📊 Budget Management

### Budget Tracking

NexusPrompt tracks budget usage in real-time:

```typescript
// application/src/orchestrator.ts
interface BudgetConfig {
  max_provider_calls: number;
  on_exceed: 'refuse' | 'warn' | 'throw';
}
```

### Budget Configuration

```bash
# Set budget via environment
export MAX_PROVIDER_CALLS=1400

# Or via command line
npm run eval -- --live --max-calls 1400
```

### Budget Monitoring

The orchestrator tracks:
- Total calls made
- Calls remaining
- Budget percentage used
- Cost estimates (when available)

**Example Output**:
```
Budget Status:
  Total calls: 1400
  Used calls: 285
  Remaining: 1115
  Percentage: 20.36%
  Estimated cost: $14.25
```

### Cost Estimation

Approximate costs (as of September 2026):

| Provider | Model | Cost per 1K tokens (input) | Cost per 1K tokens (output) |
|----------|-------|-----------------------------|------------------------------|
| Anthropic | Claude 3 Haiku | $0.25 | $1.00 |
| Anthropic | Claude 3 Sonnet | $0.80 | $2.40 |
| Anthropic | Claude 3 Opus | $1.50 | $4.50 |
| OpenAI | GPT-4 | $0.30 | $0.60 |
| OpenAI | GPT-3.5 | $0.03 | $0.04 |

**Note**: Costs vary by provider and model. Check the latest pricing on the provider's website.

### Budget Alerts

Configure alerts for budget thresholds:

```bash
# Alert at 50%, 80%, and 95%
export BUDGET_ALERT_THRESHOLDS='0.5,0.8,0.95'

# Or via command line
npm run eval -- --live --budget-alerts 0.5,0.8,0.95
```

---

## 🔄 Retry Logic

### Retry Configuration

NexusPrompt implements exponential backoff with jitter:

```typescript
// Default retry configuration
const DEFAULT_RETRY = {
  maxAttempts: 3,
  baseDelay: 100, // ms
  maxDelay: 10000, // ms
  exponential: true,
  jitter: true,
};
```

### Retry Behavior

1. **First attempt**: Immediate
2. **Second attempt**: After 100-200ms (with jitter)
3. **Third attempt**: After 200-400ms (with jitter)
4. **Fourth attempt**: After 400-800ms (with jitter)
5. **Max attempts**: 3 (configurable)

### Retry Conditions

Retry on:
- Network errors
- Timeout errors
- Rate limit errors (with respect to Retry-After header)
- 5xx server errors

Don't retry on:
- 4xx client errors (except 429 rate limit)
- Validation errors
- Authentication errors

### Testing Retry Logic

```bash
# Simulate failures
npm run eval -- --live --simulate-failures 0.1 --max-attempts 5

# Test rate limit handling
npm run eval -- --live --simulate-rate-limit 5 --max-attempts 3
```

---

## 🏷️ Model Fingerprinting

### What are Model Fingerprints?

Model fingerprints are unique identifiers that capture:
- Provider name (e.g., `anthropic`)
- Model name (e.g., `claude-3-sonnet-20240229`)
- Model version/date
- First observed timestamp
- Last observed timestamp
- Number of runs completed
- Stages completed

### Fingerprint Format

```json
{
  "fingerprints": {
    "anthropic:claude-3-sonnet-20240229": {
      "first_observed": "2026-09-01T10:00:00Z",
      "last_observed": "2026-09-01T12:30:00Z",
      "run_count": 100,
      "stages_completed": [
        "deconstruct",
        "calibrate",
        "compile",
        "harden",
        "critique",
        "refine",
        "lint",
        "critic",
        "preview",
        "cost_estimate",
        "tone_check"
      ]
    }
  },
  "pinned": [
    "ollama:llama3:70b",
    "ollama:mistral:7b"
  ],
  "watch_armed": true
}
```

### Capturing Fingerprints

```bash
# Run evaluation and capture fingerprints
npm run eval -- --live --write --capture-fingerprints

# Just capture fingerprints without evaluation
npm run check:fingerprint --write

# View current fingerprints
npm run check:fingerprint
```

### Fingerprint Verification

After capturing fingerprints, verify:

1. **Consistency**: Same model should produce same fingerprint
2. **Completeness**: All expected stages completed
3. **Accuracy**: Fingerprint matches expected format
4. **Persistence**: Fingerprints saved to disk

```bash
# Verify fingerprints
npm run check:fingerprint --verify

# Compare with expected fingerprints
npm run check:fingerprint --compare scripts/expected-fingerprints.json
```

### Watch Mode

Enable watch mode to monitor for new models:

```bash
# Enable watch mode
export WATCH_ARMED=true

# Or via command line
npm run eval -- --live --watch
```

When watch mode is enabled, NexusPrompt will:
- Monitor for new models
- Alert when new fingerprints are captured
- Log model changes

---

## 💾 Cache Testing

### Cache Mechanisms

NexusPrompt implements several cache mechanisms:

1. **Schema Cache**: Caches compiled JSON schemas
2. **Content Cache**: Caches content by hash
3. **Provider Cache**: Caches provider capabilities
4. **Revision Cache**: Caches revision data

### Testing Cache Read

The **cache read mechanism** allows providers to read cached content instead of regenerating:

```typescript
// In provider adapters
if (request.cache_key) {
  const cached = await this.cache.get(request.cache_key);
  if (cached) {
    return cached;
  }
}
```

### Cache Test Commands

```bash
# Test cache read mechanism
npm run eval -- --live --test-cache-read

# Clear cache and test
npm run eval -- --live --clear-cache --test-cache-read

# Test cache with specific provider
npm run eval -- --live --provider provider-local-proxy --test-cache-read
```

### Cache Statistics

After running evaluations, check cache statistics:

```bash
# Show cache statistics
npm run check:cache --stats
```

**Example Output**:
```
Cache Statistics:
  Schema cache:
    Hits: 150
    Misses: 50
    Hit rate: 75%
  
  Content cache:
    Hits: 285
    Misses: 15
    Hit rate: 95%
    Bytes saved: 1.2 MB
  
  Provider cache:
    Hits: 100
    Misses: 1
    Hit rate: 99%
```

---

## ❌ Failure Classification

### Failure Types

NexusPrompt classifies failures into categories:

| Category | Description | Retryable |
|----------|-------------|-----------|
| `INVALID_REQUEST` | Invalid input data | ❌ No |
| `MODEL_NOT_FOUND` | Model doesn't exist | ❌ No |
| `RATE_LIMIT_EXCEEDED` | Rate limit hit | ✅ Yes |
| `TIMEOUT` | Request timeout | ✅ Yes |
| `INTERNAL_ERROR` | Provider internal error | ✅ Yes |
| `AUTHENTICATION_FAILED` | Authentication error | ❌ No |
| `BUDGET_EXCEEDED` | Budget limit reached | ❌ No |
| `NETWORK_ERROR` | Network connectivity issue | ✅ Yes |

### Testing Failure Classification

```bash
# Simulate different failure types
npm run eval -- --live --simulate-failure INVALID_REQUEST --count 5

# Test all failure types
npm run eval -- --live --test-all-failures

# Verify failure classification
npm run check:failures --verify
```

### Failure Statistics

After running evaluations, check failure statistics:

```bash
# Show failure statistics
npm run check:failures --stats
```

**Example Output**:
```
Failure Statistics:
  Total requests: 1400
  Successes: 1350
  Failures: 50
  
  By category:
    RATE_LIMIT_EXCEEDED: 15 (30%)
    TIMEOUT: 10 (20%)
    INTERNAL_ERROR: 8 (16%)
    MODEL_NOT_FOUND: 5 (10%)
    INVALID_REQUEST: 5 (10%)
    NETWORK_ERROR: 5 (10%)
    BUDGET_EXCEEDED: 2 (4%)
  
  Retryable: 38 (76%)
  Non-retryable: 12 (24%)
```

---

## 📊 Reporting

### Test Reports

NexusPrompt generates comprehensive test reports:

```bash
# Generate HTML report
npm run eval -- --live --write --format html

# Generate JSON report
npm run eval -- --live --write --format json

# Generate Markdown report
npm run eval -- --live --write --format md
```

### Report Contents

Reports include:

1. **Summary**: Total requests, successes, failures, duration
2. **Provider Statistics**: By provider and model
3. **Stage Statistics**: By pipeline stage
4. **Gate Statistics**: By gate
5. **Failure Analysis**: By category and cause
6. **Performance Metrics**: Latency, throughput
7. **Budget Usage**: Calls used, cost estimates
8. **Cache Statistics**: Hit rates, bytes saved
9. **Model Fingerprints**: Captured fingerprints

### Report Example

```markdown
# Live Evaluation Report

**Date**: 2026-09-01T12:00:00Z  
**Duration**: 2h 30m 15s  
**Trials**: 100  
**Max Calls**: 1400  

## Summary

| Metric | Value |
|--------|-------|
| Total Requests | 1400 |
| Successes | 1350 |
| Failures | 50 |
| Success Rate | 96.43% |
| Average Duration | 2.5s |

## Provider Statistics

| Provider | Model | Requests | Successes | Failures | Success Rate |
|----------|-------|----------|-----------|----------|--------------|
| anthropic | claude-3-sonnet-20240229 | 800 | 780 | 20 | 97.5% |
| anthropic | claude-3-haiku-20240307 | 600 | 570 | 30 | 95.0% |

## Stage Statistics

| Stage | Requests | Successes | Failures | Avg Duration |
|-------|----------|-----------|----------|---------------|
| deconstruct | 200 | 195 | 5 | 1.2s |
| calibrate | 200 | 190 | 10 | 1.5s |
| compile | 200 | 198 | 2 | 2.0s |
| harden | 200 | 195 | 5 | 2.5s |
| critique | 200 | 185 | 15 | 3.0s |
| refine | 200 | 190 | 10 | 2.8s |
| lint | 200 | 197 | 3 | 1.0s |

## Failure Analysis

| Category | Count | % | Retryable |
|----------|-------|---|-----------|
| RATE_LIMIT_EXCEEDED | 15 | 30% | ✅ |
| TIMEOUT | 10 | 20% | ✅ |
| INTERNAL_ERROR | 8 | 16% | ✅ |
| MODEL_NOT_FOUND | 5 | 10% | ❌ |
| INVALID_REQUEST | 5 | 10% | ❌ |
| NETWORK_ERROR | 5 | 10% | ✅ |
| BUDGET_EXCEEDED | 2 | 4% | ❌ |

## Performance Metrics

| Metric | p50 | p95 | p99 | Average |
|--------|-----|-----|-----|---------|
| Request Duration | 1.2s | 3.5s | 8.2s | 2.5s |
| Provider Latency | 800ms | 2.1s | 5.5s | 1.2s |
| Throughput | 0.4 req/s | 0.3 req/s | 0.1 req/s | 0.35 req/s |

## Budget Usage

| Metric | Value |
|--------|-------|
| Max Calls | 1400 |
| Used Calls | 1400 |
| Percentage | 100% |
| Estimated Cost | $28.00 |

## Cache Statistics

| Cache | Hits | Misses | Hit Rate | Bytes Saved |
|-------|------|--------|----------|-------------|
| Schema | 150 | 50 | 75% | - |
| Content | 285 | 15 | 95% | 1.2 MB |
| Provider | 100 | 1 | 99% | - |

## Model Fingerprints

| Model | First Observed | Last Observed | Runs | Stages |
|-------|----------------|---------------|------|--------|
| anthropic:claude-3-sonnet-20240229 | 2026-09-01T10:00:00Z | 2026-09-01T12:30:00Z | 800 | 7 |
| anthropic:claude-3-haiku-20240307 | 2026-09-01T10:00:00Z | 2026-09-01T12:30:00Z | 600 | 7 |
```

---

## 🛠️ Troubleshooting

### Common Issues

#### Issue 1: API Key Not Recognized

**Symptoms**: Authentication errors, 401 responses

**Solutions**:
1. Verify API key is set in environment
2. Check API key format
3. Verify API key hasn't expired
4. Check for typos in environment variable names

```bash
# Verify API key
echo "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-NOT SET}"

# Test with explicit API key
ANTHROPIC_API_KEY=your-key npm run eval -- --live --trials 1
```

#### Issue 2: Rate Limit Exceeded

**Symptoms**: 429 responses, rate limit errors

**Solutions**:
1. Increase rate limit in provider configuration
2. Add retry logic with backoff
3. Reduce concurrency
4. Use multiple API keys (if supported)

```bash
# Reduce concurrency
npm run eval -- --live --concurrency 1

# Increase rate limit
npm run eval -- --live --rate-limit 100
```

#### Issue 3: Timeout Errors

**Symptoms**: Timeout errors, slow responses

**Solutions**:
1. Increase timeout in provider configuration
2. Check network connectivity
3. Verify provider status
4. Reduce request complexity

```bash
# Increase timeout
npm run eval -- --live --timeout 60000

# Check provider health
npm run check:health --provider provider-local-proxy
```

#### Issue 4: Budget Exceeded

**Symptoms**: Budget exceeded errors, refused requests

**Solutions**:
1. Increase budget limit
2. Reduce number of trials
3. Use smaller evaluation suite
4. Clear cache to reduce redundant calls

```bash
# Increase budget
npm run eval -- --live --max-calls 2000

# Use smaller suite
npm run eval -- --live --suite eval/compile-smoke.json
```

#### Issue 5: Model Not Found

**Symptoms**: 404 errors, model not found messages

**Solutions**:
1. Verify model name
2. Check model availability in provider
3. Update provider configuration
4. Use different model

```bash
# List available models
npm run check:models --provider provider-local-proxy

# Use specific model
npm run eval -- --live --model claude-3-sonnet-20240229
```

### Debug Mode

Enable debug mode for detailed logging:

```bash
# Enable debug logging
LOG_LEVEL=debug npm run eval -- --live --trials 1

# Save debug logs to file
LOG_LEVEL=debug npm run eval -- --live --trials 1 2>&1 | tee debug.log
```

### Network Debugging

Use `curl` to test provider connectivity:

```bash
# Test Anthropic API
curl -H "Authorization: Bearer $ANTHROPIC_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Anthropic-Version: 2023-06-01" \
  -d '{"prompt": "\n\nHuman: Hello\n\nAssistant:", "max_tokens_to_sample": 10}' \
  https://api.anthropic.com/v1/completions

# Test Ollama API
curl -X POST http://localhost:11434/api/generate \
  -H "Content-Type: application/json" \
  -d '{"model": "llama3:70b", "prompt": "Hello", "stream": false}'
```

---

## 📝 Best Practices

### Do's

1. **Start small**: Begin with dry runs and small test suites
2. **Set budgets**: Always set budget limits to prevent cost overruns
3. **Monitor progress**: Watch logs and metrics during testing
4. **Test incrementally**: Add one provider at a time
5. **Verify fingerprints**: Check that fingerprints are captured correctly
6. **Test failure cases**: Verify error handling and retry logic
7. **Document results**: Save reports and logs for analysis
8. **Clean up**: Clear cache between tests when needed

### Don'ts

1. **Don't run without budget limits**: Can result in unexpected costs
2. **Don't test with production data**: Use test data only
3. **Don't ignore errors**: Investigate and fix all errors
4. **Don't run full evaluations frequently**: Costs add up quickly
5. **Don't commit API keys**: Keep them out of version control
6. **Don't share reports publicly**: May contain sensitive information

---

## 📊 Success Criteria

### Minimum Viable Testing

- [ ] At least one provider configured and working
- [ ] Dry run completes successfully
- [ ] Small test (10 trials) completes with >90% success rate
- [ ] Model fingerprints captured
- [ ] Budget tracking working
- [ ] Basic reports generated

### Comprehensive Testing

- [ ] All configured providers tested
- [ ] Full evaluation suite runs with >95% success rate
- [ ] All model fingerprints captured
- [ ] Budget enforcement verified
- [ ] Retry logic tested
- [ ] Cache read mechanism verified
- [ ] Failure classification accurate
- [ ] Comprehensive reports generated

---

## 📝 Guide Metadata

| Field | Value |
|-------|-------|
| **Version** | 1.0.0 |
| **Last Updated** | September 2026 |
| **Owner** | QA Team |
| **Phase** | Phase 3 (Weeks 21-24) |
| **Status** | Active |
| **Repository** | hynix666/nexusprompt |
| **Related Documents** | [IMPROVEMENT_2026_REVISED.md](./IMPROVEMENT_2026_REVISED.md) |

---

## 🔗 References

- [Anthropic API Documentation](https://docs.anthropic.com/)
- [Ollama Documentation](https://github.com/jmorganca/ollama)
- [OpenAI API Documentation](https://platform.openai.com/docs/)
- [NexusPrompt Evaluation Suites](../eval/)
- [Provider Adapter Development Guide](./ADAPTER_DEVELOPMENT_2026.md)
- [Budget Management Documentation](./IMPROVEMENT_2026_REVISED.md#budget)
