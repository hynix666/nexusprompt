import { describe, expect, it } from "vitest";
import { createApiServer } from "../src/index.js";
import type { ApiDependencies } from "../src/app.js";
import type { Orchestrator } from "../../../application/src/orchestrator.js";
import type { ProviderTransport } from "../../../contracts/index.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The entry point, over a real socket.
 *
 * `app.test.ts` covers the routes through `inject()`, which never binds a port. That is the
 * right shape for route assertions and it leaves exactly one thing unproven: that composing,
 * listening, and closing actually work. This file covers only that seam, so the two do not
 * overlap.
 *
 * The test this replaces asserted sixteen endpoints and response shapes belonging to the
 * monolithic shell a refactor deleted — `status: "ok"`, `version: "1.0.0"`, a `/models`
 * catalog. Rewriting it to match what `app.ts` returns would have been writing an expectation
 * from observed behaviour, which is the move that lets a wrong implementation define its own
 * contract. It was removed instead, and ADR-0012 records the surface that remains.
 */

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

const deps: ApiDependencies = {
  provider,
  orchestrator: {} as Orchestrator,
  coreBuildHash: "test",
};

describe("createApiServer", () => {
  it("binds a real socket, answers, and closes", async () => {
    // Port 0 asks the OS for a free one, so the suite cannot collide with a running server.
    const started = await createApiServer({ port: 0, host: "127.0.0.1", deps }).listen();
    try {
      expect(started.port).toBeGreaterThan(0);
      const res = await fetch(`http://${started.host}:${started.port}/api/v1/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, service: "nexusprompt-api" });
    } finally {
      await started.close();
    }
  });

  it("reports the port the OS actually assigned, not the one requested", async () => {
    // Without re-reading the bound address, a caller given port 0 gets 0 back and cannot
    // reach the server it just started.
    const server = createApiServer({ port: 0, host: "127.0.0.1", deps });
    expect(server.port).toBe(0);
    const started = await server.listen();
    try {
      expect(started.port).not.toBe(0);
    } finally {
      await started.close();
    }
  });

  it("does not bind a socket merely by being imported", () => {
    // This module was imported at the top of this file. If the entry-point guard were absent,
    // that import alone would have started a server on PORT — the defect `run-eval.ts` carried
    // until its flag parsing moved inside `main()`. Asserted against the source rather than by
    // observing a port, because a missing guard is a property of the file, not of this run.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../src/index.ts"), "utf8");
    expect(source).toContain("import.meta.url ===");
  });
});
