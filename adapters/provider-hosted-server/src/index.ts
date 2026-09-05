/**
 * provider-hosted-server — a ProviderTransport backed by server-side key custody.
 *
 * Ported from sources/hosted/server/hostedProviders.ts. Sources are frozen;
 * the gateway logic is embedded here rather than imported from that path.
 *
 * The source is a multi-provider gateway (openai, anthropic, gemini, compatible).
 * This adapter wraps it as a single ProviderTransport, inferring the provider from
 * the model name in model_policy.preferred_models[0].
 *
 * Key custody invariant: API keys live only in the server environment. Callers
 * supply model preferences; the adapter reads keys from env at call time. No key
 * value ever appears in a GenerationResult or ProviderFailure.
 */

import type {
  GenerationRequest,
  GenerationResult,
  ProviderFailure,
  ProviderHealth,
  ProviderTransport,
} from "../../../contracts/index.js";

// ── Embedded gateway types ─────────────────────────────────────────────────────

type HostedProviderId = "openai" | "anthropic" | "gemini" | "compatible";

type HostedProviderResult = {
  text: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  finishReason?: string;
};

type HostedProviderHealth = {
  id: HostedProviderId;
  label: string;
  model: string | null;
  status: "healthy" | "unavailable" | "unconfigured" | "unknown";
  checkedAt: number;
  detail: string;
};

class HostedProviderError extends Error {
  constructor(
    readonly kind: "configuration" | "rate_limit" | "network" | "timeout" | "http" | "parse",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HostedProviderError";
  }
}

type ServerEnvironment = Record<string, string | undefined>;
type FetchLike = typeof fetch;
type HostedRequest = {
  provider: HostedProviderId;
  model: string;
  system: string;
  user: string;
  temperature: number;
  userId: number;
};
type ProviderConfig = {
  label: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
  configured: boolean;
  reason?: string;
};

// ── Embedded gateway constants ─────────────────────────────────────────────────

const DEFAULT_MODELS: Record<HostedProviderId, string[]> = {
  openai: ["gpt-4.1-mini"],
  anthropic: ["claude-sonnet-4-5"],
  gemini: ["gemini-3.6-flash"],
  compatible: [],
};
const REQUEST_WINDOW_MS = 60_000;
const REQUESTS_PER_WINDOW = 12;
const MAX_SYSTEM_CHARS = 48_000;
const MAX_USER_CHARS = 48_000;
const HEALTH_CACHE_MS = 120_000;
const HEALTH_TIMEOUT_MS = 8_000;

// ── Embedded gateway helpers ───────────────────────────────────────────────────

function readModels(value: string | undefined, fallback: string[]) {
  const parsed = value?.split(",").map((m) => m.trim()).filter(Boolean) ?? [];
  return parsed.length ? Array.from(new Set(parsed)) : fallback;
}

function validCompatibleBaseUrl(value: string | undefined) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.search || url.hash) return "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function providerConfigs(env: ServerEnvironment): Record<HostedProviderId, ProviderConfig> {
  const compatibleBaseUrl = validCompatibleBaseUrl(env.COMPATIBLE_OPENAI_BASE_URL);
  const configs: Record<HostedProviderId, ProviderConfig> = {
    openai: { label: "OPENAI", apiKey: env.OPENAI_API_KEY?.trim() ?? "", baseUrl: "https://api.openai.com/v1", models: readModels(env.OPENAI_MODELS, DEFAULT_MODELS.openai), configured: false },
    anthropic: { label: "ANTHROPIC", apiKey: env.ANTHROPIC_API_KEY?.trim() ?? "", baseUrl: "https://api.anthropic.com/v1", models: readModels(env.ANTHROPIC_MODELS, DEFAULT_MODELS.anthropic), configured: false },
    gemini: { label: "GEMINI", apiKey: env.GEMINI_API_KEY?.trim() ?? "", baseUrl: "https://generativelanguage.googleapis.com/v1beta", models: readModels(env.GEMINI_MODELS, DEFAULT_MODELS.gemini), configured: false },
    compatible: { label: "COMPATIBLE", apiKey: env.COMPATIBLE_OPENAI_API_KEY?.trim() ?? "", baseUrl: compatibleBaseUrl, models: readModels(env.COMPATIBLE_OPENAI_MODELS, DEFAULT_MODELS.compatible), configured: false },
  };
  for (const [id, config] of Object.entries(configs) as Array<[HostedProviderId, ProviderConfig]>) {
    config.configured = Boolean(config.apiKey && config.baseUrl && config.models.length);
    if (!config.configured) {
      config.reason = id === "compatible" && !compatibleBaseUrl
        ? "A fixed compatible endpoint, key, and allowlisted model are required."
        : "This provider is not configured on the server.";
    }
  }
  return configs;
}

function extractOpenAIText(data: unknown) {
  const d = data as Record<string, unknown>;
  const outputText = typeof d?.output_text === "string" ? d.output_text : "";
  if (outputText.trim()) return outputText;
  const choices = d?.choices as Array<{ message?: { content?: string } }> | undefined;
  const message = choices?.[0]?.message?.content;
  if (typeof message === "string" && message.trim()) return message;
  const output = Array.isArray(d?.output) ? (d.output as unknown[]) : [];
  return output
    .flatMap((item) => (item as Record<string, unknown>)?.content as unknown[] ?? [])
    .filter((item) => (item as Record<string, unknown>)?.type === "output_text")
    .map((item) => (item as Record<string, unknown>).text)
    .filter(Boolean)
    .join("\n");
}

function extractAnthropicText(data: unknown) {
  const content = (data as Record<string, unknown>)?.content;
  return Array.isArray(content)
    ? content
        .filter((b) => (b as Record<string, unknown>)?.type === "text" && typeof (b as Record<string, unknown>).text === "string")
        .map((b) => (b as Record<string, unknown>).text as string)
        .join("\n")
    : "";
}

function extractGeminiText(data: unknown) {
  const steps = Array.isArray((data as Record<string, unknown>)?.steps)
    ? ((data as Record<string, unknown>).steps as unknown[])
    : [];
  return steps
    .filter((step) => (step as Record<string, unknown>)?.type === "model_output")
    .flatMap((step) => Array.isArray((step as Record<string, unknown>)?.content) ? (step as Record<string, unknown>).content as unknown[] : [])
    .map((part) => typeof (part as Record<string, unknown>)?.text === "string" ? (part as Record<string, unknown>).text as string : "")
    .filter(Boolean)
    .join("\n");
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

async function callWithTimeout(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const data = await responseJson(response);
    if (!response.ok) {
      const d = data as Record<string, unknown>;
      const err = d?.error as Record<string, unknown> | undefined;
      const message = (err?.message ?? err?.status ?? d?.message ?? `Provider request failed with HTTP ${response.status}.`) as string;
      const kind = response.status === 429 ? "rate_limit" : "http";
      throw new HostedProviderError(
        kind,
        kind === "rate_limit"
          ? "The hosted provider rate limit was reached. Please try again shortly."
          : `Hosted provider request failed: ${String(message).slice(0, 300)}`,
        response.status,
      );
    }
    return data;
  } catch (error) {
    if (error instanceof HostedProviderError) throw error;
    if ((error as DOMException)?.name === "AbortError") {
      throw new HostedProviderError("timeout", "The hosted provider did not respond before the 90-second timeout.");
    }
    throw new HostedProviderError("network", "The hosted provider could not be reached. Please try again shortly.");
  } finally {
    clearTimeout(timer);
  }
}

async function probeModel(fetchImpl: FetchLike, provider: HostedProviderId, config: ProviderConfig, model: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const modelPath = encodeURIComponent(model);
  const url = `${config.baseUrl}/models/${modelPath}`;
  let headers: Record<string, string> = { authorization: `Bearer ${config.apiKey}` };
  if (provider === "anthropic") headers = { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" };
  if (provider === "gemini") headers = { "x-goog-api-key": config.apiKey };
  try {
    const response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
    if (!response.ok) {
      return {
        status: "unavailable" as const,
        detail: response.status === 401 || response.status === 403
          ? "Server credentials cannot access this model."
          : "The configured model is unavailable.",
      };
    }
    return { status: "healthy" as const, detail: "Model metadata verified." };
  } catch {
    return { status: "unavailable" as const, detail: "The provider could not be reached." };
  } finally {
    clearTimeout(timer);
  }
}

// ── Embedded gateway factory ───────────────────────────────────────────────────

function createHostedProviderGateway(env: ServerEnvironment, fetchImpl: FetchLike) {
  const callsByUser = new Map<number, number[]>();
  const healthCache = new Map<HostedProviderId, HostedProviderHealth>();

  const health = async (force = false): Promise<HostedProviderHealth[]> => {
    const configs = providerConfigs(env);
    const now = Date.now();
    return Promise.all((Object.keys(configs) as HostedProviderId[]).map(async (id) => {
      const config = configs[id];
      const cached = healthCache.get(id);
      if (!force && cached && now - cached.checkedAt < HEALTH_CACHE_MS) return cached;
      if (!config.configured) {
        const entry: HostedProviderHealth = { id, label: config.label, model: null, status: "unconfigured", checkedAt: now, detail: config.reason ?? "This provider is not configured on the server." };
        healthCache.set(id, entry);
        return entry;
      }
      const model = config.models[0];
      const result = await probeModel(fetchImpl, id, config, model);
      const next: HostedProviderHealth = { id, label: config.label, model, status: result.status, checkedAt: Date.now(), detail: result.detail };
      healthCache.set(id, next);
      return next;
    }));
  };

  const enforceRateLimit = (userId: number) => {
    const now = Date.now();
    const recent = (callsByUser.get(userId) ?? []).filter((at) => now - at < REQUEST_WINDOW_MS);
    if (recent.length >= REQUESTS_PER_WINDOW) {
      throw new HostedProviderError("rate_limit", "Hosted generation is temporarily limited for this workspace. Please wait a minute and try again.");
    }
    recent.push(now);
    callsByUser.set(userId, recent);
  };

  const generate = async (request: HostedRequest): Promise<HostedProviderResult> => {
    if (request.system.length > MAX_SYSTEM_CHARS || request.user.length > MAX_USER_CHARS) {
      throw new HostedProviderError("configuration", "The hosted generation input exceeds the allowed size.");
    }
    const config = providerConfigs(env)[request.provider];
    if (!config.configured) throw new HostedProviderError("configuration", config.reason ?? "This hosted provider is not configured on the server.");
    if (!config.models.includes(request.model)) throw new HostedProviderError("configuration", "This model is not approved for the selected hosted provider.");
    enforceRateLimit(request.userId);

    if (request.provider === "openai") {
      const data = await callWithTimeout(fetchImpl, `${config.baseUrl}/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model: request.model, input: [{ role: "system", content: request.system }, { role: "user", content: request.user }], temperature: request.temperature }) });
      const text = extractOpenAIText(data);
      if (!text.trim()) throw new HostedProviderError("parse", "OpenAI returned no usable text output.");
      const d = data as Record<string, unknown>;
      const usage = d?.usage as Record<string, number> | undefined;
      return { text, usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens } : undefined, finishReason: d?.status as string | undefined };
    }
    if (request.provider === "compatible") {
      const data = await callWithTimeout(fetchImpl, `${config.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model: request.model, temperature: request.temperature, messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }] }) });
      const text = extractOpenAIText(data);
      if (!text.trim()) throw new HostedProviderError("parse", "The compatible provider returned no usable text output.");
      const d = data as Record<string, unknown>;
      const usage = d?.usage as Record<string, number> | undefined;
      const choices = d?.choices as Array<{ finish_reason?: string }> | undefined;
      return { text, usage: usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : undefined, finishReason: choices?.[0]?.finish_reason };
    }
    if (request.provider === "anthropic") {
      const data = await callWithTimeout(fetchImpl, `${config.baseUrl}/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: request.model, system: request.system, messages: [{ role: "user", content: request.user }], max_tokens: 4096, temperature: request.temperature }) });
      const text = extractAnthropicText(data);
      if (!text.trim()) throw new HostedProviderError("parse", "Anthropic returned no usable text output.");
      const d = data as Record<string, unknown>;
      const usage = d?.usage as Record<string, number> | undefined;
      return { text, usage: usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) } : undefined, finishReason: d?.stop_reason as string | undefined };
    }
    // gemini
    const data = await callWithTimeout(fetchImpl, `${config.baseUrl}/interactions`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": config.apiKey }, body: JSON.stringify({ model: request.model, input: request.user, system_instruction: request.system, store: false, generation_config: { max_output_tokens: 4096 } }) });
    const text = extractGeminiText(data);
    if (!text.trim()) throw new HostedProviderError("parse", "Gemini returned no usable text output.");
    const d = data as Record<string, unknown>;
    const usage = d?.usage as Record<string, number> | undefined;
    return { text, usage: usage ? { inputTokens: usage.total_input_tokens, outputTokens: usage.total_output_tokens, totalTokens: usage.total_tokens } : undefined, finishReason: d?.status as string | undefined };
  };

  return { health, generate };
}

// ── Adapter utilities ──────────────────────────────────────────────────────────

function inferProvider(model: string, fallback: HostedProviderId): HostedProviderId {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  if (model.startsWith("gemini-")) return "gemini";
  return fallback;
}

function flattenMessages(messages: Array<{ role: "user" | "assistant"; content: string }>): string {
  if (messages.length === 1 && messages[0].role === "user") return messages[0].content;
  return messages.map((m) => (m.role === "user" ? "User" : "Assistant") + ": " + m.content).join("\n\n");
}

// ── HostedServerProvider ───────────────────────────────────────────────────────

export interface HostedServerOptions {
  env?: ServerEnvironment;
  fetchImpl?: typeof fetch;
  defaultProvider?: HostedProviderId;
  userId?: number;
  now?: () => Date;
}

export class HostedServerProvider implements ProviderTransport {
  readonly provider_id = "hosted-server";
  private readonly gateway: ReturnType<typeof createHostedProviderGateway>;
  private readonly defaultProvider: HostedProviderId;
  private readonly userId: number;
  private readonly now: () => Date;

  constructor(opts: HostedServerOptions = {}) {
    this.defaultProvider = opts.defaultProvider ?? "openai";
    this.userId = opts.userId ?? 0;
    this.now = opts.now ?? (() => new Date());
    this.gateway = createHostedProviderGateway(
      opts.env ?? (process.env as ServerEnvironment),
      opts.fetchImpl ?? globalThis.fetch,
    );
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

    const model = req.model_policy.preferred_models[0];
    if (!model) {
      return fail("INVALID_REQUEST", "no_model", "model_policy.preferred_models must contain at least one model.");
    }

    const provider = inferProvider(model, this.defaultProvider);
    const system = req.system ?? "";
    const user = flattenMessages(req.messages);

    try {
      const result = await this.gateway.generate({
        provider,
        model,
        system,
        user,
        temperature: 0.2,
        userId: this.userId,
      });
      return {
        request_id: req.request_id,
        content: result.text,
        provider_id: this.provider_id,
        model_id: model,
        finish_reason: result.finishReason ?? "stop",
        usage: {
          prompt_tokens: result.usage?.inputTokens,
          completion_tokens: result.usage?.outputTokens,
        },
      };
    } catch (err) {
      if (err instanceof HostedProviderError) return this.mapHostedError(err, fail);
      return fail("INTERNAL", "unexpected_error", "An unexpected error occurred in the hosted provider gateway.");
    }
  }

  private mapHostedError(
    err: HostedProviderError,
    fail: (c: ProviderFailure["category"], r: string, m: string, retriable?: boolean, after?: number | null) => ProviderFailure,
  ): ProviderFailure {
    switch (err.kind) {
      case "rate_limit": return fail("RATE_LIMIT", "rate_limit", err.message, true, 60_000);
      case "timeout": return fail("TIMEOUT", "timeout", err.message, true, 500);
      case "network": return fail("UNAVAILABLE", "network_error", err.message, true, 250);
      case "parse": return fail("MALFORMED_RESPONSE", "parse_error", err.message, false);
      case "configuration": return fail("INVALID_REQUEST", "configuration_error", err.message, false);
      case "http": {
        const s = err.status;
        if (s === 401 || s === 403) return fail("AUTH", `http_${s}`, err.message, false);
        if (s === 429) return fail("RATE_LIMIT", "http_429", err.message, true, 60_000);
        if (s === 400) return fail("INVALID_REQUEST", "http_400", err.message, false);
        if (s !== undefined && s >= 500) return fail("UNAVAILABLE", `http_${s}`, err.message, true, 500);
        return fail("INTERNAL", `http_${s ?? "unknown"}`, err.message, false);
      }
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const started = this.now().getTime();
    try {
      const results = await this.gateway.health();
      const target = results.find((h) => h.id === this.defaultProvider) ?? results[0];
      const elapsed = this.now().getTime() - started;
      if (!target || target.status === "unconfigured") {
        return {
          ok: false,
          checked_at: new Date(started).toISOString(),
          latency_ms: elapsed,
          degradation_state: "UNAVAILABLE",
          failing_dependency: `API key for ${this.defaultProvider}`,
        };
      }
      if (target.status === "unknown") {
        return {
          ok: false,
          checked_at: new Date(started).toISOString(),
          latency_ms: elapsed,
          degradation_state: "DEGRADED",
          failing_dependency: target.label,
        };
      }
      if (target.status === "healthy") {
        return {
          ok: true,
          checked_at: new Date(started).toISOString(),
          latency_ms: elapsed,
          degradation_state: "NONE",
          failing_dependency: null,
        };
      }
      // "unavailable"
      return {
        ok: false,
        checked_at: new Date(started).toISOString(),
        latency_ms: elapsed,
        degradation_state: "UNAVAILABLE",
        failing_dependency: target.label,
      };
    } catch {
      const elapsed = this.now().getTime() - started;
      return {
        ok: false,
        checked_at: new Date(started).toISOString(),
        latency_ms: elapsed,
        degradation_state: "UNAVAILABLE",
        failing_dependency: "hosted-provider-gateway",
      };
    }
  }
}
