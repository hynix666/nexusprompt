import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApiServer } from "../src/index.js";
import type { FastifyInstance } from "fastify";

describe("REST API Shell", () => {
  let server: Awaited<ReturnType<typeof createApiServer>>;
  let fastify: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    server = await createApiServer({ port: 0 });
    fastify = server.fastify;
    await fastify.listen({ port: server.port, host: server.host });
    baseUrl = `http://${server.host}:${(fastify.server.address() as any).port}`;
  });

  afterAll(async () => {
    await fastify.close();
  });

  describe("Health & System", () => {
    it("GET /api/v1/health returns ok status", async () => {
      const res = await fetch(`${baseUrl}/api/v1/health`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("ok");
      expect(data.version).toBe("1.0.0");
    });

    it("GET /api/v1/system returns architecture info", async () => {
      const res = await fetch(`${baseUrl}/api/v1/system`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe("NexusPrompt API");
      expect(data.layers).toEqual(["shell", "application", "contracts", "core", "adapters"]);
    });

    it("GET /api/v1/hardware returns hardware status", async () => {
      const res = await fetch(`${baseUrl}/api/v1/hardware`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.cpu).toBe("available");
      expect(data.memory).toBe("available");
    });
  });

  describe("Compiler", () => {
    it("POST /api/v1/compiler/lint validates a prompt", async () => {
      const res = await fetch(`${baseUrl}/api/v1/compiler/lint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Write a function that adds two numbers" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.result.verdict).toMatch(/^(PASS|FAIL)$/);
      expect(Array.isArray(data.result.gates)).toBe(true);
      expect(data.result.gates.length).toBeGreaterThan(0);
    });

    it("POST /api/v1/compiler/lint rejects empty prompt", async () => {
      const res = await fetch(`${baseUrl}/api/v1/compiler/lint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "" }),
      });
      expect(res.status).toBe(400);
    });

    it("POST /api/v1/compiler/compile runs pipeline", async () => {
      const res = await fetch(`${baseUrl}/api/v1/compiler/compile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Test compilation" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.result).toBeDefined();
    });
  });

  describe("Models", () => {
    it("GET /api/v1/models lists demo models", async () => {
      const res = await fetch(`${baseUrl}/api/v1/models`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.models)).toBe(true);
      expect(data.models.length).toBeGreaterThan(0);
    });

    it("GET /api/v1/models/catalog returns stub", async () => {
      const res = await fetch(`${baseUrl}/api/v1/models/catalog`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.catalog)).toBe(true);
    });
  });

  describe("Inference with SSE", () => {
    it("POST /api/v1/inference/generate returns requestId", async () => {
      const res = await fetch(`${baseUrl}/api/v1/inference/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Hello world test" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.requestId).toBeDefined();
      expect(typeof data.requestId).toBe("string");
    });

    it("GET /api/v1/inference/:id/events returns SSE stream", async () => {
      // First create a request
      const genRes = await fetch(`${baseUrl}/api/v1/inference/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "SSE test prompt" }),
      });
      const { requestId } = await genRes.json();

      // Wait for events to be generated
      await new Promise(r => setTimeout(r, 100));

      // Fetch events
      const eventsRes = await fetch(`${baseUrl}/api/v1/inference/${requestId}/events`);
      expect(eventsRes.status).toBe(200);
      const text = await eventsRes.text();
      expect(text).toContain("event: started");
      expect(text).toContain("event: token");
      expect(text).toContain("event: completed");
    });

    it("POST /api/v1/inference/cancel removes request", async () => {
      const genRes = await fetch(`${baseUrl}/api/v1/inference/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Cancel test" }),
      });
      const { requestId } = await genRes.json();

      const cancelRes = await fetch(`${baseUrl}/api/v1/inference/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      expect(cancelRes.status).toBe(200);
      const data = await cancelRes.json();
      expect(data.cancelled).toBe(true);
    });
  });

  describe("Settings", () => {
    it("GET /api/v1/settings returns config", async () => {
      const res = await fetch(`${baseUrl}/api/v1/settings`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.settings.demo_mode).toBe(true);
      expect(data.settings.max_retries).toBe(3);
    });
  });

  describe("Stubs (Not Implemented)", () => {
    it("POST /api/v1/projects returns 501", async () => {
      const res = await fetch(`${baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      });
      expect(res.status).toBe(501);
    });

    it("POST /api/v1/compiler/optimize returns 501", async () => {
      const res = await fetch(`${baseUrl}/api/v1/compiler/optimize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "test" }),
      });
      expect(res.status).toBe(501);
    });

    it("POST /api/v1/models/:id/download returns 501", async () => {
      const res = await fetch(`${baseUrl}/api/v1/models/test-model/download`, {
        method: "POST",
      });
      expect(res.status).toBe(501);
    });

    it("POST /api/v1/evaluations returns 501", async () => {
      const res = await fetch(`${baseUrl}/api/v1/evaluations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      });
      expect(res.status).toBe(501);
    });
  });
});
