import { describe, expect, it } from "vitest";
import { buildApi, type ApiDependencies } from "../src/app.js";
import type { Orchestrator } from "../../../application/src/orchestrator.js";
import type { ProviderTransport } from "../../../contracts/index.js";

const provider: ProviderTransport = {
  provider_id: "test",
  async generate() {
    throw new Error("not used");
  },
  async healthCheck() {
    return {
      ok: true,
      checked_at: "2026-08-27T00:00:00.000Z",
      latency_ms: 1,
      degradation_state: "NONE" as const,
      failing_dependency: null,
    };
  },
};

const deps = (run: Orchestrator): ApiDependencies => ({ provider, orchestrator: run, coreBuildHash: "test" });

describe("REST API v1", () => {
  it("reports health and exposes the ported gates", async () => {
    const app = buildApi(deps({} as Orchestrator));
    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    const gates = await app.inject({ method: "GET", url: "/api/v1/gates" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, service: "nexusprompt-api" });
    expect(gates.statusCode).toBe(200);
    expect(gates.json().gates.length).toBeGreaterThan(0);
    await app.close();
  });

  it("lints through the Application protocol", async () => {
    const app = buildApi(deps({} as Orchestrator));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compiler/lint",
      payload: { text: "Write a concise answer." },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, result: { ported_gate_count: 16 } });
    await app.close();
  });

  it("rejects malformed compile requests", async () => {
    const app = buildApi(deps({} as Orchestrator));
    const response = await app.inject({ method: "POST", url: "/api/v1/compiler/compile", payload: {} });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("does not leak internal error messages to the client", async () => {
    const secret = "prompt body that must not reach the caller";
    const throwing = { run: () => { throw new Error(secret); } } as unknown as Orchestrator;
    const app = buildApi(deps(throwing));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compiler/compile",
      payload: { brief: "anything" },
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body).toEqual({ ok: false, error: "internal_error" });
    expect(response.payload).not.toContain(secret);
    await app.close();
  });

  // The scrubbing above must not swallow a status this shell raises on purpose. A
  // `status < 500` test would have reported 500 "internal_error" here.
  it("keeps a deliberate 5xx status and its own message", async () => {
    const failing: ProviderTransport = {
      ...provider,
      async healthCheck() {
        throw new Error("upstream detail that must not reach the caller");
      },
    };
    const app = buildApi({ provider: failing, orchestrator: {} as Orchestrator, coreBuildHash: "test" });
    const response = await app.inject({ method: "GET", url: "/api/v1/provider/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "provider health check failed" });
    expect(response.payload).not.toContain("upstream detail");
    await app.close();
  });
});