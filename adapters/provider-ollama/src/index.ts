/**
 * provider-ollama — a ProviderTransport for a model running on this machine.
 *
 * The first transport here that can actually answer. `provider-local-proxy` talks to
 * api.anthropic.com and needs a key and money; this talks to an Ollama daemon on loopback and
 * needs neither, which makes it the cheapest way to turn `TRUTH_BOUNDARY.md`'s opening entry —
 * *nothing here has ever talked to a model* — into something that has to be rewritten.
 *
 * It was rewritten on 31 August 2026. Runs against 5 local models are persisted with real
 * fingerprints and pinned, so `check:fingerprint` is armed. The entry that replaced it is
 * narrower and still true: *local models have answered; nothing this repository REPORTS came
 * from one* — every evaluation figure still comes from the pinned stub.
 *
 * ## Zero runtime dependencies, deliberately
 *
 * ADR-0012 scopes the property rather than dropping it: `contracts`, `core`, `application`,
 * **the adapters** and `shells/cli` ship nothing in `dependencies`. So no `ollama` client
 * package and no HTTP library — Node's global `fetch` is enough for a JSON POST, and the
 * client packages mostly wrap exactly that. Nothing that computes a verdict, a score or a
 * revision imports outside the standard library, and this stays on the right side of it.
 *
 * ## Loopback only, and that is a security boundary
 *
 * An "Ollama adapter" whose host is caller-supplied is a server-side request forgery
 * primitive wearing a helpful name: point it at an internal address and it will fetch
 * whatever answers. `provider-local-proxy` pins a one-host allowlist for the same reason.
 * Here the rule is stricter and simpler — the host must resolve to this machine by its
 * literal spelling, checked before any request leaves.
 *
 * ## What MALFORMED_RESPONSE is for
 *
 * This is the adapter that makes `provider-failure` 1.1.0 real. A local model answers, and the
 * answer can still be unusable: a body that is not JSON, an envelope with no content field, a
 * completion that is empty. In all three the call succeeded and the model ran, so the demo
 * placeholder — which says "No output was produced" — would be a false statement about the
 * run. See ADR-0014.
 *
 * ## What this adapter deliberately does NOT do
 *
 * It does not repair JSON. Both proposal documents make `jsonrepair` a mandatory pairing for
 * every non-Ollama path, and it would be the wrong thing here twice over. First, it would end
 * the zero-dependency property for the layer that computes revisions. Second, and more to the
 * point: **no stage in this pipeline asks a model for JSON.** Every one of the eleven consumes
 * prose — a spec, a calibration, a compiled prompt — and `grep JSON.parse core/src/stages/`
 * returns nothing. The JSON here is Ollama's transport envelope, which the daemon controls,
 * not model output. Repairing model output is a real problem for a structured-output stage
 * that does not exist yet, and building for it now would be building against an imagined
 * shape.
 */

import type {
  GenerationRequest,
  GenerationResult,
  ProviderFailure,
  ProviderHealth,
  ProviderTransport,
} from "../../../contracts/index.js";

/**
 * Hosts that are this machine, by literal spelling.
 *
 * Not a DNS lookup: resolving a name to decide whether it is local invites a rebinding race
 * where the check and the request disagree. A fixed spelling cannot be re-pointed between the
 * two, which is the property worth having.
 */
const LOOPBACK = Object.freeze(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Ollama's default. Configurable, but only within loopback. */
const DEFAULT_PORT = 11434;

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

/** Is this host one this adapter may talk to? Exported so the rule is testable on its own. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.includes(host);
}

export interface OllamaOptions {
  /** Injected so tests never touch the network. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected so tests need no clock. */
  now?: () => Date;
  host?: string;
  port?: number;
  /**
   * Which model to ask for. No default that names a real model on purpose: naming one this
   * machine has not pulled produces a 404 from the daemon that reads like an outage, and
   * naming one it has pulled bakes a local accident into a shared adapter.
   */
  model?: string;
  modelEnvVar?: string;
  /**
   * Local models are slow, and slow is not broken. 120s matches `provider-local-proxy`; a
   * 27B model on CPU will exceed it, which is a real configuration rather than a fault, so
   * the timeout says how long it waited rather than blaming the daemon.
   */
  timeoutMs?: number;
}

interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements ProviderTransport {
  readonly provider_id = "ollama-local";
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly host: string;
  private readonly port: number;
  private readonly model: string | undefined;
  private readonly modelEnvVar: string;
  private readonly timeoutMs: number;

  constructor(opts: OllamaOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? DEFAULT_PORT;
    this.model = opts.model;
    this.modelEnvVar = opts.modelEnvVar ?? "OLLAMA_MODEL";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** The base URL, after the loopback rule. Never built from caller-supplied path segments. */
  private base(): string {
    return `http://${this.host}:${this.port}`;
  }

  /** Explicit option wins, then the environment. Neither is a default model name. */
  private resolveModel(): string | undefined {
    return this.model ?? process.env[this.modelEnvVar];
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

    if (!isLoopbackHost(this.host)) {
      return fail(
        "INVALID_REQUEST",
        "host_not_loopback",
        `Host "${this.host}" is not loopback. This adapter talks to a daemon on this machine only.`,
      );
    }

    const model = this.resolveModel();
    if (!model) {
      return fail(
        "INVALID_REQUEST",
        "no_model_configured",
        `No model configured. Set ${this.modelEnvVar}, or pass one — there is no default, because a ` +
          `default names a model this machine may not have pulled.`,
      );
    }

    /**
     * Ollama's chat endpoint takes the same message shape the contract carries, so no
     * translation layer is needed beyond hoisting `system` into a turn — which is where
     * Ollama expects it, unlike the Anthropic API's top-level field.
     */
    const body = JSON.stringify({
      model,
      stream: false,
      messages: [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        ...req.messages,
      ],
      options: {
        ...(req.generation_options?.max_tokens ? { num_predict: req.generation_options.max_tokens } : {}),
      },
    });

    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      return fail("INVALID_REQUEST", "request_too_large", `Request exceeds ${MAX_REQUEST_BYTES} bytes.`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(`${this.base()}/api/chat`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body,
      });

      if (!res.ok) return this.classifyHttp(res.status, await safeText(res), fail);

      /**
       * From here on the call SUCCEEDED. Everything that can still go wrong is
       * `MALFORMED_RESPONSE`, because the model ran.
       */
      let data: OllamaChatResponse;
      try {
        data = (await res.json()) as OllamaChatResponse;
      } catch {
        return fail(
          "MALFORMED_RESPONSE",
          "body_not_json",
          "The daemon returned 200 with a body that is not JSON.",
          true,
        );
      }

      const content = data.message?.content;
      if (typeof content !== "string") {
        return fail(
          "MALFORMED_RESPONSE",
          "no_content_field",
          "The response envelope carried no message.content string.",
          true,
        );
      }
      if (content.trim() === "") {
        // A model that returns nothing has answered, and the answer is unusable. Passing an
        // empty string forward would let a stage record an artifact that is silently blank.
        return fail(
          "MALFORMED_RESPONSE",
          "empty_completion",
          "The model returned an empty completion.",
          true,
        );
      }

      return {
        request_id: req.request_id,
        content,
        provider_id: this.provider_id,
        model_id: data.model ?? model,
        finish_reason: data.done_reason ?? "stop",
        usage: {
          prompt_tokens: data.prompt_eval_count,
          completion_tokens: data.eval_count,
          // No `cache_read_tokens`: Ollama has no prompt cache to report, and a zero here
          // would be indistinguishable from a real cache that was silently invalidated.
        },
      };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        return fail(
          "TIMEOUT",
          "timeout",
          `No response within ${this.timeoutMs} ms. A large local model may simply need longer.`,
          true,
          500,
        );
      }
      return fail(
        "UNAVAILABLE",
        "daemon_unreachable",
        `Could not reach an Ollama daemon at ${this.base()}. Is it running?`,
        true,
        250,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * HTTP status to category.
   *
   * Note what is NOT here: no status maps to `MALFORMED_RESPONSE`. A non-2xx means the daemon
   * declined, so no model output exists — the distinction the category carries is about a
   * response that arrived, and an error page is not one.
   */
  private classifyHttp(
    status: number,
    detail: string,
    fail: (c: ProviderFailure["category"], r: string, m: string, retriable?: boolean, after?: number | null) => ProviderFailure,
  ): ProviderFailure {
    // 404 from Ollama means the model is not pulled — by far the most likely first-run
    // failure, and one an operator can act on immediately if told plainly.
    if (status === 404) {
      return fail(
        "INVALID_REQUEST",
        "model_not_pulled",
        `The daemon does not have that model. Pull it first: \`ollama pull <model>\`. ${detail}`.trim(),
      );
    }
    if (status === 400) return fail("INVALID_REQUEST", "http_400", detail || "The daemon rejected the request.");
    if (status === 429) return fail("RATE_LIMIT", "http_429", detail || "The daemon is busy.", true, 1000);
    if (status >= 500) return fail("UNAVAILABLE", `http_${status}`, detail || `Daemon returned HTTP ${status}.`, true, 500);
    return fail("INTERNAL", `http_${status}`, detail || `Daemon returned HTTP ${status}.`);
  }

  /**
   * Is a daemon there, and is a model named?
   *
   * Unlike `provider-local-proxy`, presence of a credential is not the question — there is no
   * credential. So this actually reaches out, to `/api/tags`, which lists what is pulled and
   * costs nothing. Reporting `ok` from configuration alone would say a run can proceed when
   * the daemon is not running, which is the common case and the one worth catching.
   */
  async healthCheck(): Promise<ProviderHealth> {
    const started = this.now().getTime();
    const stamp = () => this.now().toISOString();

    if (!isLoopbackHost(this.host)) {
      return {
        ok: false,
        checked_at: stamp(),
        latency_ms: 0,
        degradation_state: "UNAVAILABLE",
        failing_dependency: "configuration",
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await this.fetchImpl(`${this.base()}/api/tags`, { signal: controller.signal });
      const ok = res.ok && Boolean(this.resolveModel());
      return {
        ok,
        checked_at: stamp(),
        latency_ms: this.now().getTime() - started,
        degradation_state: ok ? "NONE" : "UNAVAILABLE",
        // `null`, not absent: the contract types this as `string | null`, and a missing key
        // and an explicit null are different shapes to anything reading the record back.
        failing_dependency: ok ? null : res.ok ? "configuration" : "ollama",
      };
    } catch {
      return {
        ok: false,
        checked_at: stamp(),
        latency_ms: this.now().getTime() - started,
        degradation_state: "UNAVAILABLE",
        failing_dependency: "ollama",
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The daemon's error text, read defensively. Never contains request content. */
async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return "";
  }
}
