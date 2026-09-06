import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { lint, listPortedGates, worstVerdict } from "../../../application/src/lint.js";
import type { Orchestrator } from "../../../application/src/orchestrator.js";
import type { ProviderTransport } from "../../../contracts/index.js";
import {
  registerSecurity, securityFromEnv, type SecurityConfig, type SecurityHooks,
} from "./security.js";

export interface ApiDependencies {
  provider: ProviderTransport;
  orchestrator: Orchestrator;
  coreBuildHash: string;
}

interface LintBody {
  text?: string;
  prompt?: string;
  options?: {
    includeFences?: boolean;
    stakes?: string;
    naiveTokens?: number;
    provider?: string;
  };
}

interface CompileBody {
  brief?: string;
  stakes?: string;
  depth?: string;
  testMessage?: string;
}

const textFrom = (body: LintBody): string | undefined => body.text ?? body.prompt;

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function buildApi(
  deps: ApiDependencies,
  security: SecurityConfig = securityFromEnv(),
  hooks: SecurityHooks = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(sensible);

  /**
   * Before any route, so a route added later is covered without its author remembering.
   *
   * Registered here rather than in the composition root because it is a property of the
   * HTTP surface, not of which adapters are wired behind it — the composition root names
   * concrete adapters and holds no logic (ADR-0005), and a rate limit is logic.
   */
  registerSecurity(app, security, hooks);

  /**
   * No message this shell did not write reaches the caller.
   *
   * Fastify's default handler puts `error.message` straight into the response body, and an
   * unexpected throw out of the Orchestrator carries the brief — so an unhandled exception
   * published over HTTP exactly what the observability sink refuses to log. `statusCode` is
   * the discriminator: Fastify's own errors and `@fastify/sensible`'s replies carry one and
   * their messages are ours, an unexpected throw carries none and its message is not.
   *
   * Testing `statusCode < 500` instead would fold `reply.serviceUnavailable()` — a 503 this
   * shell raises deliberately — into a generic 500, losing both the honest status and a
   * message that was always safe to send.
   */
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (typeof error.statusCode === "number") {
      return reply.status(error.statusCode).send({ ok: false, error: error.message });
    }
    return reply.status(500).send({ ok: false, error: "internal_error" });
  });

  app.get("/api/v1/health", async () => ({ ok: true, service: "nexusprompt-api" }));

  app.get("/api/v1/system", async () => ({
    name: "NexusPrompt",
    api_version: "v1",
    core_build_hash: deps.coreBuildHash,
    capabilities: ["lint", "compile", "gates"],
  }));

  app.get("/api/v1/hardware", async () => ({
    platform: process.platform,
    arch: process.arch,
    cpu_count: availableParallelism(),
    memory_bytes: process.memoryUsage().rss,
  }));

  app.get("/api/v1/gates", async () => ({ gates: listPortedGates() }));

  app.post<{ Body: LintBody }>("/api/v1/compiler/lint", async (request, reply) => {
    const text = textFrom(request.body ?? {});
    if (text === undefined) return reply.badRequest("text or prompt must be provided");
    const report = lint(text, request.body.options);
    return {
      ok: true,
      verdict: worstVerdict(report.results),
      result: report,
    };
  });

  app.post<{ Body: CompileBody }>("/api/v1/compiler/compile", async (request, reply) => {
    const body = request.body ?? {};
    let brief: string;
    try {
      brief = requireString(body.brief, "brief");
    } catch (error) {
      return reply.badRequest((error as Error).message);
    }

    const runId = randomUUID().replace(/-/g, "").slice(0, 16);
    const outcome = await deps.orchestrator.run({
      command_id: randomUUID(),
      run_id: runId,
      stage_id: "compile",
      input: { brief },
      context: {
        stakes: body.stakes ?? "MEDIUM",
        depth: body.depth,
        testMessage: body.testMessage,
      },
    });
    return { ok: true, result: outcome };
  });

  app.get("/api/v1/provider/health", async (_request, reply) => {
    try {
      return { ok: true, result: await deps.provider.healthCheck() };
    } catch {
      return reply.serviceUnavailable("provider health check failed");
    }
  });

  return app;
}