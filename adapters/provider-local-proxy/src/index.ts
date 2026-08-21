/**
 * provider-local-proxy — a ProviderTransport with the security invariants
 * ported from sources/v5/promptnexus-v5/standalone/serve.py.
 *
 * ## What "ported" means here, precisely
 *
 * `serve.py` is an HTTP *server*; this is a client-side transport. Its
 * 27-assertion suite therefore splits: assertions about proxying behaviour port
 * directly, and assertions about serving static files or binding a socket have
 * no counterpart here. Those are marked N/A in `assertion-map.ts` with a reason
 * rather than quietly counted, because a security baseline that reports better
 * coverage than it has is worse than one that reports none.
 *
 * The invariants that do port:
 *   - fixed upstream host allowlist; no arbitrary URL passthrough
 *   - path-tail validation on provider-specific URL segments
 *   - request size checked before it is sent
 *   - the key is read from the environment, never accepted from a caller
 *   - failures are typed and their messages are safe to log
 */

import type {
  GenerationRequest,
  GenerationResult,
  ProviderFailure,
  ProviderHealth,
  ProviderTransport,
} from "../../../contracts/index.js";

/** Fixed. A caller cannot add to this, which is the point. */
const ALLOWED_HOSTS = Object.freeze(["api.anthropic.com"]);

const MAX_REQUEST_BYTES = 2 * 1024 * 1024; // serve.py: MAX_BODY

/** Rejects traversal and sibling-prefix escapes in a provider path segment. */
export function isSafePathTail(tail: string): boolean {
  if (tail === "" || tail.length > 128) return false;
  if (tail.includes("..") || tail.includes("/") || tail.includes("\\")) return false;
  if (tail.includes("%2e") || tail.includes("%2E") || tail.includes("%2f") || tail.includes("%2F")) return false;
  return /^[A-Za-z0-9._-]+$/.test(tail);
}

export interface LocalProxyOptions {
  /** Injected so tests never touch the network. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected so tests need no clock. */
  now?: () => Date;
  apiKeyEnvVar?: string;
  timeoutMs?: number;
  model?: string;
}

export class LocalProxyProvider implements ProviderTransport {
  readonly provider_id = "local-proxy";
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly apiKeyEnvVar: string;
  private readonly timeoutMs: number;
  private readonly model: string;

  constructor(opts: LocalProxyOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
    this.apiKeyEnvVar = opts.apiKeyEnvVar ?? "ANTHROPIC_API_KEY";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.model = opts.model ?? "claude-opus-5";
  }

  async generate(req: GenerationRequest): Promise<GenerationResult | ProviderFailure> {
    const fail = (
      category: ProviderFailure["category"],
      reason_code: string,
      safe_message: string,
      retriable = false,
      retry_after_ms: number | null = null,
    ): ProviderFailure => ({
      request_id: req.request_id,
      category,
      retriable,
      reason_code,
      safe_message,
      retry_after_ms,
      attempt: 1,
      provider_id: this.provider_id,
    });

    const apiKey = process.env[this.apiKeyEnvVar];
    if (!apiKey) {
      // serve.py: "401 names the env var, not the key".
      return fail("AUTH", "no_api_key", `${this.apiKeyEnvVar} is not set in this process's environment.`);
    }

    const body = JSON.stringify({
      model: this.model,
      max_tokens: req.generation_options?.max_tokens ?? 8000,
      output_config: { effort: req.generation_options?.effort ?? "medium" },
      // Top-level, not a turn — that is the API's shape and the source's. Omitted when the
      // request carries none, so a preview (whose system prompt is the compiled prompt
      // itself, supplied by the caller) does not get an empty string sent on its behalf.
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages,
    });

    // Size is checked before the request leaves, not after the server rejects it.
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      return fail("INVALID_REQUEST", "request_too_large", `Request exceeds ${MAX_REQUEST_BYTES} bytes.`);
    }

    const host = "api.anthropic.com";
    if (!ALLOWED_HOSTS.includes(host)) {
      return fail("INVALID_REQUEST", "host_not_allowed", `Host "${host}" is not in the allowlist.`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(`https://${host}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
      });

      if (!res.ok) return this.classifyHttp(res.status, await safeJson(res), fail);

      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        model?: string;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      // A truncated response is not a successful one.
      if (data.stop_reason === "max_tokens") {
        return fail("INVALID_REQUEST", "max_tokens_truncated", "Response hit the token ceiling and is incomplete.");
      }
      if (data.stop_reason === "refusal") {
        return fail("CONTENT_FILTER", "refusal", "The model declined this request.");
      }

      return {
        request_id: req.request_id,
        content: (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
        provider_id: this.provider_id,
        model_id: data.model ?? this.model,
        finish_reason: data.stop_reason ?? "end_turn",
        usage: {
          prompt_tokens: data.usage?.input_tokens,
          completion_tokens: data.usage?.output_tokens,
        },
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return fail("TIMEOUT", "timeout", `No response within ${this.timeoutMs} ms.`, true, 500);
      }
      return fail("UNAVAILABLE", "connection_failed", "Could not reach the provider.", true, 250);
    } finally {
      clearTimeout(timer);
    }
  }

  private classifyHttp(
    status: number,
    body: { error?: { message?: string } } | null,
    fail: (c: ProviderFailure["category"], r: string, m: string, retriable?: boolean, after?: number | null) => ProviderFailure,
  ): ProviderFailure {
    // The provider's own message is safe — it never echoes the key. Request
    // content is not included here.
    const msg = body?.error?.message ?? `Provider returned HTTP ${status}.`;
    if (status === 401 || status === 403) return fail("AUTH", `http_${status}`, msg);
    if (status === 429) return fail("RATE_LIMIT", "http_429", msg, true, 1000);
    if (status === 400) return fail("INVALID_REQUEST", "http_400", msg);
    if (status >= 500) return fail("UNAVAILABLE", `http_${status}`, msg, true, 500);
    return fail("INTERNAL", `http_${status}`, msg);
  }

  async healthCheck(): Promise<ProviderHealth> {
    const started = this.now().getTime();
    const configured = Boolean(process.env[this.apiKeyEnvVar]);
    return {
      // Booleans only — serve.py: "providers exposes booleans only".
      ok: configured,
      checked_at: this.now().toISOString(),
      latency_ms: this.now().getTime() - started,
      degradation_state: configured ? "NONE" : "UNAVAILABLE",
      failing_dependency: configured ? null : this.apiKeyEnvVar,
    };
  }
}

async function safeJson(res: Response): Promise<{ error?: { message?: string } } | null> {
  try {
    return (await res.json()) as { error?: { message?: string } };
  } catch {
    return null;
  }
}
