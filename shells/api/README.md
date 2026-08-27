# REST API Shell

A Fastify-based REST API server that exposes NexusPrompt's Application layer over HTTP/JSON.

## Architecture

This shell follows the versioned API pattern (`/api/v1`) and maintains strict architectural boundaries:

```
REST JSON → JSON Schema validation → Application command/query → Core/Adapter
```

All request/response shapes derive from `contracts/`, not invented independently.

## Endpoints

### Health & System

- `GET /api/v1/health` - Server health status
- `GET /api/v1/system` - System information and architecture
- `GET /api/v1/hardware` - Hardware detection status

### Compiler

- `POST /api/v1/compiler/compile` - Compile a prompt through the pipeline
- `POST /api/v1/compiler/lint` - Lint a prompt (run validation gates)
- `POST /api/v1/compiler/optimize` - Optimize a prompt (stub)
- `POST /api/v1/compiler/explain` - Explain a prompt (stub)

### Models

- `GET /api/v1/models` - List loaded models
- `GET /api/v1/models/catalog` - Model catalog (stub)
- `POST /api/v1/models/:id/download` - Download a model (stub)
- `POST /api/v1/models/:id/verify` - Verify model integrity (stub)
- `POST /api/v1/models/:id/install` - Install a model (stub)
- `POST /api/v1/models/:id/load` - Load a model (stub)
- `POST /api/v1/models/:id/unload` - Unload a model (stub)
- `DELETE /api/v1/models/:id` - Delete a model (stub)

### Inference (with SSE streaming)

- `POST /api/v1/inference/generate` - Start generation, returns `requestId`
- `GET /api/v1/inference/:requestId/events` - Server-Sent Events stream
- `POST /api/v1/inference/cancel` - Cancel a generation request

Example SSE event stream:

```text
event: started
data: {"requestId":"req_123","model":"qwen3-8b"}

event: token
data: {"text":"Hello"}

event: completed
data: {"tokens":37,"latencyMs":1842,"tokensPerSecond":20.1,"finishReason":"stop"}
```

### Projects & Prompts

- `GET /api/v1/projects` - List projects (stub)
- `POST /api/v1/projects` - Create project (stub)
- `GET /api/v1/projects/:id/prompts` - List prompts (stub)
- `POST /api/v1/projects/:id/prompts` - Create prompt (stub)

### Evaluations & Experiments

- `GET /api/v1/evaluations` - List evaluations (stub)
- `POST /api/v1/evaluations` - Create evaluation (stub)
- `GET /api/v1/experiments` - List experiments (stub)
- `POST /api/v1/experiments` - Create experiment (stub)

### Settings

- `GET /api/v1/settings` - Get current settings
- `PATCH /api/v1/settings` - Update settings (stub)

## Usage

### Start the server

```bash
npm run start --prefix shells/api
# or
npx tsx shells/api/src/index.ts --port=3000
```

### Test endpoints

```bash
# Health check
curl http://127.0.0.1:3000/api/v1/health

# Lint a prompt
curl -X POST http://127.0.0.1:3000/api/v1/compiler/lint \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Write a function that adds two numbers"}'

# Start inference generation
curl -X POST http://127.0.0.1:3000/api/v1/inference/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Hello world"}'

# Stream events (returns requestId from previous call)
curl http://127.0.0.1:3000/api/v1/inference/:requestId/events
```

## Desktop Deployment

For standalone desktop applications, bind to localhost only:

```typescript
const { fastify } = await createApiServer({ 
  host: "127.0.0.1", 
  port: 0 // ephemeral port
});
```

The desktop shell should:
1. Start the API process on startup
2. Create an authenticated session/token
3. Give the renderer only that API capability
4. Shut down the service with the application

## Implementation Notes

### Current State

- ✅ Health & system endpoints
- ✅ Compiler lint/compile (uses real Application layer)
- ✅ Inference with SSE streaming (demo mode)
- ✅ Models listing (demo data)
- ⚠️ Projects, Prompts, Evaluations, Experiments (stubs - require storage adapter)

### Adapters

Current implementation uses in-memory demo adapters:
- `MemoryRevisionStore` - Ephemeral revision storage
- `MemoryEventSink` - Console logging for events
- `DemoProvider` - Deterministic mock inference

Replace with production adapters:
- SQLite adapter for persistence
- Embedded llama.cpp for local inference
- Ollama/LM Studio adapters for external runtimes

### Contract Conformance

All responses should validate against the JSON Schemas in `contracts/`. Future work:
- Add Ajv validation middleware for all endpoints
- Return schema-validated responses
- Add contract conformance tests

## Security

- Default binding: `127.0.0.1` (localhost only)
- No authentication implemented yet
- For remote deployment: add JWT/OAuth middleware
- Never expose without authentication on LAN/internet
