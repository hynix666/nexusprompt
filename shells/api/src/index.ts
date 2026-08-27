/**
 * REST API Shell for NexusPrompt
 * 
 * This shell exposes the Application layer over HTTP/JSON using Fastify.
 * It follows the versioned API pattern: /api/v1
 * 
 * Architecture:
 * - REST JSON → JSON Schema validation → Application command/query → Core/Adapter
 * 
 * All request/response shapes come from contracts/, not invented independently.
 */

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type {
  PipelineCommand,
  RevisionEntry,
  GateResult,
} from "../../../contracts/index.js";
import { Orchestrator } from "../../../application/src/orchestrator.js";
import type { ProviderTransport, RevisionStore, EventSink } from "../../../contracts/index.js";

// ── Server-Sent Events stream for inference ───────────────────────────────

interface InferenceRequest {
  prompt: string;
  model?: string;
  options?: {
    max_tokens?: number;
    temperature?: number;
  };
}

interface InferenceEvent {
  event: "started" | "token" | "completed" | "error";
  data: unknown;
}

// ── In-memory stores for demo (replace with SQLite adapter) ───────────────

class MemoryRevisionStore implements RevisionStore {
  private revisions = new Map<string, RevisionEntry[]>();
  retention_scope = "LOCAL_BUNDLE" as const;

  async append(entry: RevisionEntry): Promise<void> {
    const run = this.revisions.get(entry.run_id) ?? [];
    run.push(entry);
    this.revisions.set(entry.run_id, run);
  }

  async getRun(run_id: string): Promise<RevisionEntry[]> {
    return this.revisions.get(run_id) ?? [];
  }

  async listRecent(limit: number): Promise<Array<{ run_id: string; entries: number; first_timestamp: string; last_timestamp: string }>> {
    const summaries = Array.from(this.revisions.entries()).map(([, entries]) => ({
      run_id: "",
      entries: entries.length,
      first_timestamp: entries[0]?.timestamp ?? "",
      last_timestamp: entries[entries.length - 1]?.timestamp ?? "",
    }));
    return summaries.slice(0, limit);
  }

  async markStale(_run_id: string, _from_revision_id: string): Promise<void> {
    // No-op for demo
  }
}

class MemoryEventSink implements EventSink {
  emit(event: import("../../../contracts/index.js").ObservabilityEvent): void {
    // Log to console for demo; real implementation would persist or stream
    console.log("[EVENT]", event.event_type, event.run_id);
  }
}

// ── Demo provider adapter ─────────────────────────────────────────────────

class DemoProvider implements ProviderTransport {
  readonly provider_id = "demo";

  async generate(req: import("../../../contracts/index.js").GenerationRequest) {
    // Simulate generation with deterministic output
    await new Promise(r => setTimeout(r, 100));
    return {
      request_id: req.request_id,
      content: `Generated response for: ${req.messages[0]?.content?.slice(0, 50)}...`,
      provider_id: this.provider_id,
      model_id: "demo-model-v1",
      finish_reason: "stop",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
      },
      timings_ms: { total: 100 },
    };
  }

  async healthCheck() {
    return {
      ok: true,
      checked_at: new Date().toISOString(),
      latency_ms: 10,
      degradation_state: "NONE" as const,
      failing_dependency: null,
    };
  }
}

// ── API Server Factory ────────────────────────────────────────────────────

export interface ApiServerOptions {
  port?: number;
  host?: string;
  orchestrator?: Orchestrator;
}

export async function createApiServer(opts: ApiServerOptions = {}) {
  const port = opts.port ?? 3000;
  const host = opts.host ?? "127.0.0.1";

  const fastify = Fastify({
    logger: { level: "info" },
  });

  // Initialize application layer components
  const store = new MemoryRevisionStore();
  const sink = new MemoryEventSink();
  const provider = new DemoProvider();
  
  const orchestrator = opts.orchestrator ?? new Orchestrator({
    provider,
    store,
    sink,
    maxAttempts: 3,
  });

  // ── Health & System endpoints ───────────────────────────────────────────

  fastify.get("/api/v1/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "1.0.0",
  }));

  fastify.get("/api/v1/system", async () => ({
    name: "NexusPrompt API",
    version: "1.0.0",
    architecture: "REST-first",
    layers: ["shell", "application", "contracts", "core", "adapters"],
  }));

  fastify.get("/api/v1/hardware", async () => ({
    cpu: "available",
    memory: "available",
    gpu: "not-detected",
  }));

  // ── Projects endpoints ──────────────────────────────────────────────────

  fastify.get("/api/v1/projects", async () => ({
    projects: [],
    message: "Projects endpoint stub - implement with storage adapter",
  }));

  fastify.post("/api/v1/projects", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented - storage adapter required" });
  });

  // ── Prompts endpoints ───────────────────────────────────────────────────

  fastify.get("/api/v1/projects/:id/prompts", async (_req, reply) => {
    reply.send({ prompts: [], message: "Prompts endpoint stub" });
  });

  fastify.post("/api/v1/projects/:id/prompts", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented" });
  });

  // ── Compiler endpoints ──────────────────────────────────────────────────

  fastify.post("/api/v1/compiler/compile", async (req, reply) => {
    const body = req.body as { prompt: string; options?: { stakes?: string } };
    const prompt = body.prompt;
    
    if (!prompt) {
      return reply.code(400).send({ error: "prompt is required" });
    }

    const command: PipelineCommand = {
      command_id: randomUUID(),
      run_id: randomUUID(),
      stage_id: "compile",
      input: { brief: prompt },
      config_fingerprint: null,
    };

    try {
      const outcome = await orchestrator.run(command);
      reply.send({
        ok: true,
        result: {
          verdict: outcome.gate_results.some((g: GateResult) => g.verdict === "FAIL") ? "FAIL" : "PASS",
          gates: outcome.gate_results,
          output: outcome.output,
        },
      });
    } catch (error) {
      reply.code(500).send({ error: String(error) });
    }
  });

  fastify.post("/api/v1/compiler/lint", async (req, reply) => {
    const body = req.body as { prompt: string; options?: { stakes?: string } };
    const prompt = body.prompt;
    
    if (!prompt) {
      return reply.code(400).send({ error: "prompt is required" });
    }

    const command: PipelineCommand = {
      command_id: randomUUID(),
      run_id: randomUUID(),
      stage_id: "lint",
      input: { brief: prompt },
      config_fingerprint: null,
    };

    try {
      const outcome = await orchestrator.run(command);
      reply.send({
        ok: true,
        result: {
          verdict: outcome.gate_results.some((g: GateResult) => g.verdict === "FAIL") ? "FAIL" : "PASS",
          gates: outcome.gate_results,
        },
      });
    } catch (error) {
      reply.code(500).send({ error: String(error) });
    }
  });

  fastify.post("/api/v1/compiler/optimize", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented - requires optimization logic" });
  });

  fastify.post("/api/v1/compiler/explain", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented" });
  });

  // ── Models endpoints ────────────────────────────────────────────────────

  fastify.get("/api/v1/models", async () => ({
    models: [
      { id: "demo-model-v1", name: "Demo Model", status: "loaded", provider: "demo" },
    ],
  }));

  fastify.get("/api/v1/models/catalog", async () => ({
    catalog: [],
    message: "Model catalog stub - implement with model manager",
  }));

  fastify.post("/api/v1/models/:id/download", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented - requires model manager" });
  });

  fastify.post("/api/v1/models/:id/verify", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented" });
  });

  fastify.post("/api/v1/models/:id/install", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented" });
  });

  fastify.post("/api/v1/models/:id/load", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented" });
  });

  fastify.post("/api/v1/models/:id/unload", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented" });
  });

  fastify.delete("/api/v1/models/:id", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented" });
  });

  // ── Inference endpoints with SSE ────────────────────────────────────────

  const inferenceRequests = new Map<string, InferenceEvent[]>();

  fastify.post("/api/v1/inference/generate", async (req, reply) => {
    const body = req.body as InferenceRequest;
    const requestId = randomUUID();

    if (!body.prompt) {
      return reply.code(400).send({ error: "prompt is required" });
    }

    // Store initial event
    inferenceRequests.set(requestId, [{
      event: "started",
      data: { requestId, model: body.model ?? "demo-model-v1" },
    }]);

    // Simulate streaming tokens in background
    setTimeout(() => {
      const events = inferenceRequests.get(requestId) ?? [];
      const words = body.prompt.split(" ");
      for (let i = 0; i < Math.min(words.length, 10); i++) {
        events.push({
          event: "token",
          data: { text: words[i] + " " },
        });
      }
      events.push({
        event: "completed",
        data: {
          tokens: 10,
          latencyMs: 500,
          tokensPerSecond: 20.0,
          finishReason: "stop",
        },
      });
      inferenceRequests.set(requestId, events);
    }, 50);

    reply.send({ requestId });
  });

  fastify.get("/api/v1/inference/:requestId/events", async (req, reply) => {
    const { requestId } = req.params as { requestId: string };
    const events = inferenceRequests.get(requestId);

    if (!events) {
      return reply.code(404).send({ error: "Request not found" });
    }

    reply.header("Content-Type", "text/event-stream");
    reply.header("Cache-Control", "no-cache");
    reply.header("Connection", "keep-alive");

    let sseBody = "";
    for (const e of events) {
      sseBody += `event: ${e.event}\n`;
      sseBody += `data: ${JSON.stringify(e.data)}\n\n`;
    }

    reply.send(sseBody);
  });

  fastify.post("/api/v1/inference/cancel", async (req, reply) => {
    const { requestId } = req.body as { requestId: string };
    if (!requestId) {
      return reply.code(400).send({ error: "requestId is required" });
    }
    inferenceRequests.delete(requestId);
    reply.send({ cancelled: true });
  });

  // ── Evaluations endpoints ───────────────────────────────────────────────

  fastify.get("/api/v1/evaluations", async () => ({
    evaluations: [],
    message: "Evaluations endpoint stub",
  }));

  fastify.post("/api/v1/evaluations", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented - requires evaluation plane" });
  });

  fastify.post("/api/v1/evaluations/:id/run", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented" });
  });

  fastify.get("/api/v1/evaluations/:id/results", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented" });
  });

  // ── Experiments endpoints ───────────────────────────────────────────────

  fastify.get("/api/v1/experiments", async () => ({
    experiments: [],
    message: "Experiments endpoint stub",
  }));

  fastify.post("/api/v1/experiments", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented" });
  });

  fastify.post("/api/v1/experiments/:id/run", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented" });
  });

  fastify.get("/api/v1/experiments/:id/comparison", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented" });
  });

  // ── Settings endpoints ──────────────────────────────────────────────────

  fastify.get("/api/v1/settings", async () => ({
    settings: {
      demo_mode: true,
      max_retries: 3,
      timeout_ms: 30000,
    },
  }));

  fastify.patch("/api/v1/settings", async (_req, reply) => {
    reply.code(501).send({ error: "Not implemented - requires configuration store" });
  });

  // ── Error handling ──────────────────────────────────────────────────────

  fastify.setErrorHandler((error, _req, reply) => {
    fastify.log.error(error);
    const err = error as Error;
    reply.code(500).send({ error: err.message });
  });

  return { fastify, port, host };
}

// ── CLI entry point ───────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const portArg = args.find(a => a.startsWith("--port="));
  const port = portArg ? parseInt(portArg.split("=")[1], 10) : 3000;

  const { fastify, port: finalPort, host } = await createApiServer({ port });

  try {
    await fastify.listen({ port: finalPort, host });
    console.log(`NexusPrompt API server running at http://${host}:${finalPort}/api/v1`);
    console.log("Press Ctrl+C to stop");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}
