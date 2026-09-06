/**
 * The API shell's entry point: composition, then a listening server.
 *
 * This file was empty. The refactor that split the original monolithic shell into `app.ts`
 * (routes, pure of wiring) and `composition-root.ts` (wiring, pure of logic) landed both of
 * those and truncated this one to zero bytes, along with `package.json`, in commit `2ba1b32`.
 * `npm ci` could not resolve the workspace after that, so CI has been unable to install at
 * all — the shell's tests were not merely failing, they could never be collected.
 *
 * The split it completes is the one ADR-0005 requires of every Shell: routes call the
 * Application protocol and nothing else, the composition root names concrete adapters and
 * contains no logic, and this file joins them and owns the socket. Nothing here decides
 * anything — if it grows a branch, that branch belongs in `app.ts` or the Application layer.
 *
 *   npm start -w @nexusprompt/shell-api      # PORT and HOST from the environment
 */
import type { FastifyInstance } from "fastify";
import { buildApi, type ApiDependencies } from "./app.js";
import { composeApi } from "./composition-root.js";
import { securityFromEnv, type SecurityConfig } from "./security.js";

/**
 * What the operator is told at startup, given how the server is configured.
 *
 * Returned rather than printed so a test can assert the sentence without capturing stdout,
 * and so the one place that decides what is worth warning about is not also the place that
 * owns the console. Null means nothing needs saying.
 */
export function startupWarning(security: SecurityConfig, host: string): string | null {
  if (security.token !== null) return null;
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  return (
    `WARNING: NEXUSPROMPT_API_TOKEN is not set, so every route except /api/v1/health is ` +
    `open to anyone who can reach ${host}.` +
    (loopback ? "" : ` This server is bound to a NON-LOOPBACK address.`) +
    ` A caller can spend against your provider up to the rate ceiling ` +
    `(${security.providerLimit} provider-backed request(s) per ${security.windowMs}ms). ` +
    `Set NEXUSPROMPT_API_TOKEN to require a bearer token.`
  );
}

export interface ApiServerOptions {
  /** 0 asks the OS for a free port, which is what a test wants. */
  readonly port?: number;
  readonly host?: string;
  /**
   * Injected dependencies, for a caller that wants the routes without the real adapters.
   * Absent means compose the real ones — the same default-is-load-bearing shape the eval
   * runner uses, where the stub is the default and reaching a provider is the deliberate act.
   */
  readonly deps?: ApiDependencies;
  /** Absent means read it from the environment. Supplied by tests that pin a token or a limit. */
  readonly security?: SecurityConfig;
}

export interface ApiServer {
  readonly app: FastifyInstance;
  readonly port: number;
  readonly host: string;
  /** Resolves once the socket is bound; the port is re-read because 0 becomes a real one. */
  listen(): Promise<ApiServer>;
  close(): Promise<void>;
}

export function createApiServer(options: ApiServerOptions = {}): ApiServer {
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const requested = options.port ?? Number(process.env.PORT ?? 3000);
  const security = options.security ?? securityFromEnv();
  const app = buildApi(options.deps ?? composeApi(), security);

  const server: ApiServer = {
    app,
    port: requested,
    host,
    async listen() {
      await app.listen({ port: requested, host });
      const address = app.server.address();
      const bound = typeof address === "object" && address !== null ? address.port : requested;
      return { ...server, port: bound };
    },
    close: () => app.close(),
  };
  return server;
}

/**
 * Run directly, not when imported. Without the guard, importing this module to reach
 * `createApiServer` would bind a socket as a side effect of the import — the same defect
 * `scripts/run-eval.ts` carried until its flag parsing moved inside `main()`.
 */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) {
  const security = securityFromEnv();
  const started = await createApiServer({ security }).listen();
  console.log(`nexusprompt-api listening on http://${started.host}:${started.port}`);
  const warning = startupWarning(security, started.host);
  if (warning) console.warn(warning);
}
