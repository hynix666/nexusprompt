# Adapter Development Guide

> **Status**: Active - September 2026  
> **Version**: 1.0.0  
> **Purpose**: Comprehensive guide for developing NexusPrompt adapters  
> **Phase**: Phase 2 (Weeks 9-14)  
> **Related**: [IMPROVEMENT_2026_REVISED.md](./IMPROVEMENT_2026_REVISED.md)

---

## 📊 Overview

This guide provides a comprehensive approach to developing adapters for NexusPrompt. Adapters are the **ports** that connect the core application to external systems (providers, storage, content, evidence).

**Key Principles:**
1. **Contract-First**: All adapters implement interfaces from `contracts/`
2. **Dependency Direction**: Adapters depend on contracts, not vice versa
3. **Pure Functions**: Adapters should be pure when possible
4. **Error Handling**: Adapters handle their own errors gracefully
5. **Configuration**: Adapters are configurable via constructor options

---

## 🏗️ Architecture

### Adapter Layers

```
┌─────────────────────────────────────────────────────────────┐
│                         Application                            │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                      Orchestrator                          │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ uses
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         Contracts                               │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  Provider     │  │   Storage     │  │   Content     │         │
│  │  Transport    │  │   Transport   │  │   Store       │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ implements
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         Adapters                               │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  provider-    │  │  storage-     │  │  content-     │         │
│  │  local-proxy │  │  local        │  │  local        │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  provider-    │  │  storage-     │  │  evidence-    │         │
│  │  ollama      │  │  db           │  │  local        │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│  ┌──────────────┐  ┌──────────────┐                              │
│  │  provider-    │  │  storage-     │                              │
│  │  hosted-     │  │  s3           │                              │
│  │  server      │  └──────────────┘                              │
│  └──────────────┘                                                  │
└─────────────────────────────────────────────────────────────┘
```

### Adapter Types

| Type | Interface | Purpose | Examples |
|------|-----------|---------|----------|
| Provider | `ProviderTransport` | Generate content using LLMs | local-proxy, ollama, hosted-server |
| Storage | `RevisionStore` | Store revisions and runs | local, db, s3 |
| Content | `ContentStore` | Store content (deduplicated) | local |
| Evidence | `EvidenceStore` | Store evidence for auditing | local |

---

## 📐 Contract Interfaces

### ProviderTransport

```typescript
// contracts/index.ts
export interface ProviderTransport {
  readonly provider_id: string;
  
  /**
   * Generate content using the provider
   * @param req - The generation request
   * @returns GenerationResult on success, ProviderFailure on error
   */
  generate(req: GenerationRequest): Promise<GenerationResult | ProviderFailure>;
  
  /**
   * Check the health of the provider
   * @returns Health status of the provider
   */
  healthCheck(): Promise<ProviderHealth>;
}

export interface GenerationRequest {
  request_id: string;
  run_id: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
  model_policy: {
    preferred_models: string[];
    allow_fallback: boolean;
  };
  // ... other fields
}

export interface GenerationResult {
  type: 'generation';
  request_id: string;
  content: string;
  model_id: string;
  finish_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  // ... other fields
}

export interface ProviderFailure {
  category: string;
  detail: string;
  provider_used: string;
  execution_provenance: {
    type: 'failure';
    provider: string;
    timestamp: string;
  };
}

export interface ProviderHealth {
  ok: boolean;
  checked_at: string;
  latency_ms: number;
  degradation_state: 'NONE' | 'DEGRADED' | 'UNAVAILABLE';
  failing_dependency: string | null;
}
```

### RevisionStore

```typescript
// contracts/index.ts
export interface RevisionStore {
  readonly retention_scope: RetentionScope;
  
  /**
   * Store a revision
   * @param rev - The revision to store
   */
  put(rev: Revision): Promise<void>;
  
  /**
   * Get a revision by run_id and revision_id
   * @param run_id - The run ID
   * @param revision_id - The revision ID
   * @returns The revision or null if not found
   */
  get(run_id: string, revision_id: UUID): Promise<Revision | null>;
  
  /**
   * List revisions for a run
   * @param run_id - The run ID
   * @param options - List options
   * @returns Array of revisions
   */
  list(run_id: string, options?: { since?: Timestamp; limit?: number }): Promise<Revision[]>;
  
  /**
   * Get a run by ID
   * @param run_id - The run ID
   * @returns The run or null if not found
   */
  getRun(run_id: string): Promise<Run | null>;
  
  /**
   * Store a run
   * @param run - The run to store
   */
  putRun(run: Run): Promise<void>;
  
  /**
   * List runs
   * @param options - List options
   * @returns Array of runs
   */
  listRuns(options?: { tenant_id?: string; since?: Timestamp; limit?: number }): Promise<Run[]>;
  
  /**
   * Store content
   * @param ref - The reference
   * @param bytes - The content bytes
   */
  putContent(ref: string, bytes: Uint8Array): Promise<void>;
  
  /**
   * Get content by reference
   * @param ref - The reference
   * @returns The content or null if not found
   */
  getContent(ref: string): Promise<Uint8Array | null>;
  
  /**
   * Check if content exists
   * @param ref - The reference
   * @returns True if content exists
   */
  hasContent(ref: string): Promise<boolean>;
  
  /**
   * List content
   * @param options - List options
   * @returns Array of content metadata
   */
  listContent(options?: { since?: Timestamp; limit?: number }): Promise<{ ref: string; size: number; timestamp: Timestamp }[]>;
  
  /**
   * Remove content not in the live set
   * @param live - Set of live references
   * @returns Number of items removed
   */
  sweep(live: Set<string>): Promise<number>;
}

export type RetentionScope = 'LOCAL_BUNDLE' | 'DB' | 'EXPORT';
export type UUID = `${string}-${string}-${string}-${string}-${string}`;
export type Timestamp = string; // ISO 8601
```

### ContentStore

```typescript
// contracts/index.ts
export interface ContentStore {
  readonly retention_scope: RetentionScope;
  
  /**
   * Store content
   * @param ref - The reference
   * @param bytes - The content bytes
   */
  put(ref: string, bytes: Uint8Array): Promise<void>;
  
  /**
   * Get content by reference
   * @param ref - The reference
   * @returns The content or null if not found
   */
  get(ref: string): Promise<Uint8Array | null>;
  
  /**
   * Check if content exists
   * @param ref - The reference
   * @returns True if content exists
   */
  has(ref: string): Promise<boolean>;
}
```

### EvidenceStore

```typescript
// contracts/index.ts
export interface EvidenceStore {
  readonly retention_scope: RetentionScope;
  
  /**
   * Store evidence
   * @param evidence - The evidence to store
   */
  put(evidence: Evidence): Promise<void>;
  
  /**
   * Get evidence by ID
   * @param id - The evidence ID
   * @returns The evidence or null if not found
   */
  get(id: string): Promise<Evidence | null>;
  
  /**
   * List evidence for a run
   * @param run_id - The run ID
   * @returns Array of evidence
   */
  list(run_id: string): Promise<Evidence[]>;
}

export interface Evidence {
  id: string;
  run_id: string;
  revision_id: UUID;
  gate_id: string;
  kind: string;
  data: unknown;
  timestamp: Timestamp;
}
```

---

## 🔧 Adapter Development Process

### Step 1: Understand the Contract

Before starting development, thoroughly understand the contract interface:

1. Read the interface definition in `contracts/index.ts`
2. Review the JSON Schema for the interface (in `contracts/schemas/`)
3. Check for any ADRs related to the adapter type
4. Review existing implementations of the same interface

### Step 2: Set Up the Project

#### Directory Structure

```
adapters/
├── adapter-name/
│   ├── src/
│   │   └── index.ts          # Main implementation
│   ├── test/
│   │   └── index.test.ts     # Unit tests
│   ├── package.json
│   └── tsconfig.json
└── index.ts                  # Adapter exports (optional)
```

#### package.json Template

```json
{
  "name": "@nexusprompt/adapter-name",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/src/index.js",
  "types": "dist/src/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@nexusprompt/contracts": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

#### tsconfig.json Template

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["test/**/*", "dist/**/*"]
}
```

### Step 3: Implement the Adapter

#### Basic Adapter Template

```typescript
// adapters/adapter-name/src/index.ts

import type { ContractInterface } from "../../../contracts/index.js";

// Define adapter-specific options
export interface AdapterOptions {
  // Configuration options
  option1: string;
  option2: number;
  // ...
}

// Default options
export const DEFAULT_OPTIONS: AdapterOptions = {
  option1: 'default',
  option2: 42,
  // ...
};

// Main adapter class
export class AdapterName implements ContractInterface {
  readonly adapter_id = 'adapter-name';
  
  private options: AdapterOptions;

  constructor(options: Partial<AdapterOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    
    // Validate options
    this.validateOptions();
    
    // Initialize
    this.initialize();
  }

  private validateOptions(): void {
    // Validate required options
    if (!this.options.option1) {
      throw new Error('option1 is required');
    }
    
    // Validate option ranges
    if (this.options.option2 < 0 || this.options.option2 > 100) {
      throw new Error('option2 must be between 0 and 100');
    }
  }

  private initialize(): void {
    // Initialize any resources
    // Connect to external services
    // Set up event listeners
  }

  // Implement contract methods
  async method1(param1: string): Promise<ReturnType> {
    // Implementation
  }

  async method2(param1: string, param2: number): Promise<ReturnType> {
    // Implementation
  }

  // Additional adapter-specific methods
  async customMethod(): Promise<void> {
    // Adapter-specific functionality
  }

  // Cleanup
  async close(): Promise<void> {
    // Clean up resources
    // Disconnect from external services
  }
}

// Export default instance (optional)
export default AdapterName;
```

#### Provider Adapter Example

```typescript
// adapters/provider-example/src/index.ts

import type {
  GenerationRequest,
  GenerationResult,
  ProviderFailure,
  ProviderHealth,
  ProviderTransport,
} from "../../../contracts/index.js";

export interface ExampleProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeout: number;
  maxRetries: number;
}

export const DEFAULT_OPTIONS: ExampleProviderOptions = {
  apiKey: '',
  baseUrl: 'https://api.example.com',
  model: 'example-model',
  timeout: 30000,
  maxRetries: 3,
};

export class ExampleProvider implements ProviderTransport {
  readonly provider_id = 'example';
  
  private options: ExampleProviderOptions;
  private client: any; // HTTP client

  constructor(options: Partial<ExampleProviderOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.validateOptions();
    this.client = this.createClient();
  }

  private validateOptions(): void {
    if (!this.options.apiKey) {
      throw new Error('apiKey is required');
    }
  }

  private createClient(): any {
    // Create HTTP client with configuration
    return {
      post: async (url: string, data: any) => {
        // Implementation
      },
      get: async (url: string) => {
        // Implementation
      },
    };
  }

  async generate(req: GenerationRequest): Promise<GenerationResult | ProviderFailure> {
    try {
      // Convert request to provider-specific format
      const request = this.convertRequest(req);
      
      // Call provider API
      const response = await this.callAPI(request);
      
      // Convert response to GenerationResult
      return this.convertResponse(response, req);
    } catch (error) {
      // Convert error to ProviderFailure
      return this.convertError(error as Error, req);
    }
  }

  private convertRequest(req: GenerationRequest): any {
    return {
      model: this.options.model,
      messages: req.messages,
      // ... other fields
    };
  }

  private async callAPI(request: any): Promise<any> {
    // Implement API call with retry logic
    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        const response = await this.client.post(
          `${this.options.baseUrl}/generate`,
          request,
          { timeout: this.options.timeout }
        );
        return response;
      } catch (error) {
        lastError = error as Error;
        
        // Wait before retry
        if (attempt < this.options.maxRetries) {
          await this.sleep(1000 * attempt);
        }
      }
    }
    
    throw lastError || new Error('All retries failed');
  }

  private convertResponse(response: any, req: GenerationRequest): GenerationResult {
    return {
      type: 'generation',
      request_id: req.request_id,
      content: response.choices?.[0]?.text || response.content || '',
      model_id: response.model || this.options.model,
      finish_reason: response.finish_reason || 'stop',
      usage: {
        input_tokens: response.usage?.prompt_tokens || 0,
        output_tokens: response.usage?.completion_tokens || 0,
      },
      provider_metadata: {
        provider: this.provider_id,
        // ... other metadata
      },
    };
  }

  private convertError(error: Error, req: GenerationRequest): ProviderFailure {
    return {
      category: this.classifyError(error),
      detail: error.message,
      provider_used: this.provider_id,
      execution_provenance: {
        type: 'failure',
        provider: this.provider_id,
        timestamp: new Date().toISOString(),
        request_id: req.request_id,
      },
    };
  }

  private classifyError(error: Error): string {
    if (error.message.includes('rate limit')) {
      return 'RATE_LIMIT_EXCEEDED';
    }
    if (error.message.includes('not found') || error.message.includes('404')) {
      return 'MODEL_NOT_FOUND';
    }
    if (error.message.includes('timeout')) {
      return 'TIMEOUT';
    }
    return 'INTERNAL_ERROR';
  }

  async healthCheck(): Promise<ProviderHealth> {
    try {
      const start = Date.now();
      
      // Make a test API call
      await this.client.get(`${this.options.baseUrl}/health`);
      
      return {
        ok: true,
        checked_at: new Date().toISOString(),
        latency_ms: Date.now() - start,
        degradation_state: 'NONE',
        failing_dependency: null,
      };
    } catch (error) {
      return {
        ok: false,
        checked_at: new Date().toISOString(),
        latency_ms: 0,
        degradation_state: 'UNAVAILABLE',
        failing_dependency: error instanceof Error ? error.message : 'unknown',
      };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async close(): Promise<void> {
    // Clean up client
  }
}

export default ExampleProvider;
```

### Step 4: Write Tests

#### Test Template

```typescript
// adapters/adapter-name/test/index.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AdapterName } from '../src/index.js';

describe('AdapterName', () => {
  let adapter: AdapterName;

  beforeEach(() => {
    adapter = new AdapterName({ /* test options */ });
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe('constructor', () => {
    it('should create adapter with default options', () => {
      const adapter = new AdapterName();
      expect(adapter).toBeDefined();
    });

    it('should create adapter with custom options', () => {
      const adapter = new AdapterName({ option1: 'custom' });
      expect(adapter).toBeDefined();
    });

    it('should throw error for invalid options', () => {
      expect(() => new AdapterName({ option1: '' })).toThrow();
    });
  });

  describe('contract methods', () => {
    it('should implement method1', async () => {
      const result = await adapter.method1('test');
      expect(result).toBeDefined();
    });

    it('should handle errors in method1', async () => {
      await expect(adapter.method1('invalid')).rejects.toThrow();
    });
  });

  describe('healthCheck', () => {
    it('should return healthy status', async () => {
      const health = await adapter.healthCheck();
      expect(health.ok).toBe(true);
    });
  });
});
```

#### Provider Adapter Test Example

```typescript
// adapters/provider-example/test/index.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExampleProvider } from '../src/index.js';
import type { GenerationRequest, GenerationResult, ProviderFailure } from "../../../contracts/index.js";

describe('ExampleProvider', () => {
  let provider: ExampleProvider;

  beforeEach(() => {
    provider = new ExampleProvider({
      apiKey: 'test-api-key',
      baseUrl: 'https://api.example.com',
      timeout: 1000,
      maxRetries: 1,
    });
  });

  afterEach(async () => {
    await provider.close();
  });

  describe('constructor', () => {
    it('should create provider with options', () => {
      expect(provider.provider_id).toBe('example');
    });

    it('should throw error without apiKey', () => {
      expect(() => new ExampleProvider({ apiKey: '' })).toThrow('apiKey is required');
    });
  });

  describe('generate', () => {
    it('should return GenerationResult on success', async () => {
      // Mock the client
      const request: GenerationRequest = {
        request_id: 'test-1',
        run_id: 'test-run-1',
        messages: [{ role: 'user', content: 'Hello' }],
        model_policy: { preferred_models: [], allow_fallback: false },
      };

      // This would require mocking the HTTP client
      // For now, just test the error path
    });

    it('should return ProviderFailure on error', async () => {
      const request: GenerationRequest = {
        request_id: 'test-1',
        run_id: 'test-run-1',
        messages: [{ role: 'user', content: 'Hello' }],
        model_policy: { preferred_models: [], allow_fallback: false },
      };

      // Mock a failed API call
      // This would require more complex mocking
    });
  });

  describe('healthCheck', () => {
    it('should return healthy status', async () => {
      // Mock successful health check
      const health = await provider.healthCheck();
      expect(health).toHaveProperty('ok');
      expect(health).toHaveProperty('checked_at');
      expect(health).toHaveProperty('latency_ms');
    });

    it('should return unhealthy status on error', async () => {
      // Create provider with invalid base URL
      const provider = new ExampleProvider({
        apiKey: 'test-api-key',
        baseUrl: 'https://invalid.example.com',
        timeout: 100,
        maxRetries: 1,
      });

      const health = await provider.healthCheck();
      expect(health.ok).toBe(false);
    });
  });
});
```

### Step 5: Add to Workspace

Update the root `package.json` to include the new adapter:

```json
{
  "workspaces": [
    "packages/*",
    "adapters/*"
  ]
}
```

### Step 6: Update Exports

If the adapter should be exported from the main package, update the exports:

```typescript
// adapters/index.ts

export { ExampleProvider } from './provider-example/src/index.js';
export type { ExampleProviderOptions } from './provider-example/src/index.js';
```

---

## 🎯 Best Practices

### Do's

1. **Implement the full contract**: All methods from the interface must be implemented
2. **Handle errors gracefully**: Return appropriate error types, don't throw
3. **Validate inputs**: Check all parameters for validity
4. **Use configuration**: Make adapters configurable via constructor options
5. **Add health checks**: Implement `healthCheck()` for monitoring
6. **Write comprehensive tests**: Test all methods and error paths
7. **Document the adapter**: Add README with usage examples
8. **Use async/await**: All contract methods are async
9. **Clean up resources**: Implement `close()` method for cleanup
10. **Follow naming conventions**: Use kebab-case for adapter names

### Don'ts

1. **Don't throw unhandled errors**: Always return appropriate error types
2. **Don't block the event loop**: Use async operations, not sync
3. **Don't store state unnecessarily**: Adapters should be stateless when possible
4. **Don't depend on other adapters**: Adapters should be independent
5. **Don't use `any` type**: Use proper types from contracts
6. **Don't ignore errors**: Handle all error cases
7. **Don't make breaking changes**: Maintain contract compatibility
8. **Don't log sensitive data**: Never log API keys, tokens, etc.

---

## 🧪 Testing Strategy

### Unit Tests

- Test each method individually
- Test error paths
- Test edge cases
- Test configuration validation

### Integration Tests

- Test with real dependencies (when possible)
- Test error handling
- Test performance
- Test resource cleanup

### Contract Tests

Verify that the adapter correctly implements the contract:

```typescript
// test/adapters/contract.test.ts

import { describe, it, expect } from 'vitest';
import { ExampleProvider } from '../../adapters/provider-example/src/index.js';
import type { ProviderTransport } from '../../contracts/index.js';

describe('ProviderTransport Contract', () => {
  it('should implement ProviderTransport', () => {
    const provider = new ExampleProvider({ apiKey: 'test' });
    
    // Check that all required methods exist
    expect(provider).toHaveProperty('provider_id');
    expect(provider).toHaveProperty('generate');
    expect(provider).toHaveProperty('healthCheck');
    
    // Check types
    expect(provider.provider_id).toBeTypeOf('string');
    expect(provider.generate).toBeTypeOf('function');
    expect(provider.healthCheck).toBeTypeOf('function');
  });

  it('should have correct provider_id', () => {
    const provider = new ExampleProvider({ apiKey: 'test' });
    expect(provider.provider_id).toBe('example');
  });

  it('should return correct types from generate', async () => {
    const provider = new ExampleProvider({ apiKey: 'test' });
    const request = {
      request_id: 'test-1',
      run_id: 'test-run-1',
      messages: [],
      model_policy: { preferred_models: [], allow_fallback: false },
    };
    
    const result = await provider.generate(request);
    
    // Result should be either GenerationResult or ProviderFailure
    expect(result).toHaveProperty('type') || expect(result).toHaveProperty('category');
  });

  it('should return correct type from healthCheck', async () => {
    const provider = new ExampleProvider({ apiKey: 'test' });
    const health = await provider.healthCheck();
    
    expect(health).toHaveProperty('ok');
    expect(health).toHaveProperty('checked_at');
    expect(health).toHaveProperty('latency_ms');
    expect(health).toHaveProperty('degradation_state');
    expect(health).toHaveProperty('failing_dependency');
  });
});
```

---

## 📊 Performance Considerations

### Caching

- Cache configuration
- Cache health check results (for 30-60 seconds)
- Cache provider capabilities
- Don't cache user data

### Connection Pooling

- Use connection pools for database adapters
- Configure pool size appropriately
- Handle pool errors gracefully

### Retry Logic

- Implement exponential backoff
- Add jitter to prevent thundering herd
- Respect retry-after headers
- Don't retry on client errors (4xx)

### Timeouts

- Set appropriate timeouts
- Use shorter timeouts for health checks
- Use longer timeouts for generation
- Implement timeout per attempt, not total

---

## 🔒 Security Considerations

### Authentication

- Never store credentials in code
- Use environment variables or secret management
- Validate credentials on construction
- Don't log credentials

### Input Validation

- Validate all inputs
- Sanitize user-provided data
- Prevent injection attacks
- Validate configuration

### Error Handling

- Don't expose sensitive information in errors
- Use generic error messages for client errors
- Log detailed errors internally
- Sanitize error messages before returning

### Data Protection

- Encrypt sensitive data at rest
- Use HTTPS for all external communications
- Validate SSL certificates
- Don't store unnecessary user data

---

## 📝 Monitoring and Observability

### Metrics

All adapters should expose metrics for:

- **Requests**: Total, success, failure
- **Latency**: Request duration, p50, p95, p99
- **Errors**: By type, by cause
- **Health**: Health check status, latency
- **Resources**: Connection count, memory usage

### Logging

All adapters should log:

- **INFO**: High-level operations, configuration
- **DEBUG**: Detailed operations, request/response
- **WARN**: Retries, rate limits, degradations
- **ERROR**: Failures, timeouts, unrecoverable errors

**Never log**:
- API keys
- User credentials
- Sensitive user data
- Full request/response bodies (unless in debug mode with explicit consent)

### Health Checks

Implement comprehensive health checks that verify:
- External service connectivity
- Configuration validity
- Resource availability
- Dependency health

---

## 🚀 Deployment

### Configuration

Adapters should be configurable via:

1. **Constructor options**: Primary configuration method
2. **Environment variables**: For sensitive data
3. **Configuration files**: For complex configurations

### Environment Variables

```bash
# Provider adapter
export PROVIDER_API_KEY='your-api-key'
export PROVIDER_BASE_URL='https://api.example.com'
export PROVIDER_MODEL='model-name'
export PROVIDER_TIMEOUT='30000'

# Storage adapter
export STORAGE_HOST='localhost'
export STORAGE_PORT='5432'
export STORAGE_DATABASE='nexusprompt'
export STORAGE_USER='postgres'
export STORAGE_PASSWORD='password'
```

### Docker

```dockerfile
FROM node:24-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy source code
COPY . .

# Run
CMD ["node", "dist/adapters/adapter-name/src/index.js"]
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: adapter-name
spec:
  replicas: 2
  selector:
    matchLabels:
      app: adapter-name
  template:
    metadata:
      labels:
        app: adapter-name
    spec:
      containers:
      - name: adapter
        image: nexusprompt/adapter-name:v1.0.0
        env:
        - name: PROVIDER_API_KEY
          valueFrom:
            secretKeyRef:
              name: provider-secrets
              key: api-key
        - name: PROVIDER_BASE_URL
          value: "https://api.example.com"
        resources:
          limits:
            memory: "256Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
```

---

## 📝 Guide Metadata

| Field | Value |
|-------|-------|
| **Version** | 1.0.0 |
| **Last Updated** | September 2026 |
| **Owner** | Adapter Team |
| **Phase** | Phase 2 (Weeks 9-14) |
| **Status** | Active |
| **Repository** | hynix666/nexusprompt |
| **Related Documents** | [IMPROVEMENT_2026_REVISED.md](./IMPROVEMENT_2026_REVISED.md) |

---

## 🔗 References

- [Contracts Package](../contracts/README.md)
- [Architecture Decision Records](../Documentation/0001-architecture-decisions.md)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/)
- [Node.js Documentation](https://nodejs.org/en/docs/)
- [Vitest Documentation](https://vitest.dev/)
