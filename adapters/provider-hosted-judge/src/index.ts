/**
 * provider-hosted-judge — the first real JudgeTransport.
 *
 * Mirrors adapters/provider-local-proxy's shape (loopback-free host allowlist, key read from
 * the environment only, typed failures with safe messages) but implements JudgeTransport
 * rather than ProviderTransport: grade() returns one aggregated JudgeVerdict, not a raw
 * generation. JudgeTransport.grade() has no failure union in its own type — unlike
 * ProviderTransport.generate(), which returns GenerationResult | ProviderFailure — so a real
 * transport signals failure by throwing, matching application/src/judge.ts's own
 * JudgeRefused pattern for the guard's refusals.
 *
 * req.runs (set by GuardedJudge.grade() before this is ever called, default 3) means this
 * adapter makes that many independent calls and aggregates per-dimension by mode, reporting
 * disagreement_rate as the fraction of runs whose FULL rubric didn't match the modal one.
 * JudgeVerdict requires runs+disagreement_rate precisely so a single-run verdict cannot pass
 * itself off as measured; this is the code that actually measures it.
 *
 * ## Why RUBRIC_DIMENSIONS is redeclared here, not imported from Core
 *
 * The plan this adapter was built from assumed `import { RUBRIC_DIMENSIONS, type
 * RubricDimension } from "../../../core/src/eval/brief-fidelity.js"`. That import is a real
 * boundary violation: `scripts/check-boundaries.mjs`'s "adapters" rule forbids anything under
 * `adapters/` from importing `core/`, `application/`, or `shells/` at all — "An adapter
 * implements a contract and knows nothing else about the system" — and no existing adapter
 * (provider-local-proxy, provider-ollama, storage-local, evidence-local, content-local)
 * imports from Core. That rule is long-standing (predates this task) and deliberately
 * enforced by `npm run lint:boundaries`, which runs first in `npm run verify`.
 *
 * Rather than weakening a repo-wide, well-tested invariant to fit one adapter, the four
 * dimension names are redeclared here as the adapter's own knowledge of the wire shape it
 * must parse — the same posture provider-local-proxy takes toward its own model name and host
 * allowlist. This does create one duplication to keep in sync with
 * core/src/eval/brief-fidelity.ts's RUBRIC_DIMENSIONS: if Core's rubric ever grows a fifth
 * dimension, this adapter's parser will keep validating only four, and this adapter's own
 * tests (not Core's) are what would need updating to catch that drift.
 */

import type { JudgeRequest, JudgeVerdict, JudgeTransport } from "../../../contracts/index.js";

/** Mirrors core/src/eval/brief-fidelity.ts's RUBRIC_DIMENSIONS — see the module header. */
const RUBRIC_DIMENSIONS = [
  "domain_captured",
  "constraints_honored",
  "completeness",
  "no_overreach",
] as const;

type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

const ALLOWED_HOSTS = Object.freeze(["api.anthropic.com"]);

export class HostedJudgeFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HostedJudgeFailure";
  }
}

/** The most common value; ties break toward the lower (more conservative) score. */
export function modalScore(scores: number[]): number {
  const counts = new Map<number, number>();
  for (const s of scores) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best = scores[0];
  let bestCount = 0;
  for (const [value, count] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

type RubricBreakdown = Record<RubricDimension, { score: number; reason: string }>;

export interface HostedJudgeOptions {
  /** Injected so tests never touch the network. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  apiKeyEnvVar?: string;
  timeoutMs?: number;
  model?: string;
  judge_family?: string;
}

export class HostedJudgeTransport implements JudgeTransport {
  readonly judge_id: string;
  readonly judge_family: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiKeyEnvVar: string;
  private readonly timeoutMs: number;
  private readonly model: string;

  constructor(opts: HostedJudgeOptions = {}) {
    this.model = opts.model ?? "claude-opus-5";
    this.judge_id = this.model;
    this.judge_family = opts.judge_family ?? "claude";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.apiKeyEnvVar = opts.apiKeyEnvVar ?? "ANTHROPIC_API_KEY";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async grade(req: JudgeRequest): Promise<JudgeVerdict> {
    const runs = Math.max(1, req.runs);
    const breakdowns: RubricBreakdown[] = [];
    for (let i = 0; i < runs; i++) {
      breakdowns.push(await this.callOnce(req));
    }

    const rubric_breakdown = {} as RubricBreakdown;
    for (const dim of RUBRIC_DIMENSIONS) {
      const scores = breakdowns.map((b) => b[dim].score);
      const winner = modalScore(scores);
      const reason = breakdowns.find((b) => b[dim].score === winner)!;
      rubric_breakdown[dim] = { score: winner, reason: reason[dim].reason };
    }

    const disagreeing = breakdowns.filter((b) =>
      RUBRIC_DIMENSIONS.some((dim) => b[dim].score !== rubric_breakdown[dim].score),
    ).length;

    const overall = RUBRIC_DIMENSIONS.reduce((sum, dim) => sum + rubric_breakdown[dim].score, 0);

    return {
      verdict: overall,
      rationale: null,
      judge_id: this.judge_id,
      judge_family: this.judge_family,
      rubric_id: req.rubric_id,
      rubric_hash: req.rubric_hash,
      runs,
      disagreement_rate: disagreeing / runs,
      position_randomized: req.position_randomized,
      rubric_breakdown,
    };
  }

  private async callOnce(req: JudgeRequest): Promise<RubricBreakdown> {
    const apiKey = process.env[this.apiKeyEnvVar];
    if (!apiKey) {
      throw new HostedJudgeFailure("no_api_key", `${this.apiKeyEnvVar} is not set in this process's environment.`);
    }

    const host = "api.anthropic.com";
    if (!ALLOWED_HOSTS.includes(host)) {
      throw new HostedJudgeFailure("host_not_allowed", `Host "${host}" is not in the allowlist.`);
    }

    const body = JSON.stringify({
      model: this.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: req.candidate }],
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`https://${host}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new HostedJudgeFailure("timeout", `No response within ${this.timeoutMs} ms.`);
      }
      throw new HostedJudgeFailure("connection_failed", "Could not reach the provider.");
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // The provider's own error message is safe to surface — it never echoes the key.
      let detail = `HTTP ${res.status}`;
      try {
        const errBody = (await res.json()) as { error?: { message?: string } };
        if (errBody.error?.message) detail = errBody.error.message;
      } catch {
        /* body wasn't JSON; the status code alone is still informative */
      }
      throw new HostedJudgeFailure(`http_${res.status}`, `Judge call failed: ${detail}`);
    }

    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");

    return this.parseRubric(text);
  }

  private parseRubric(text: string): RubricBreakdown {
    let parsed: unknown;
    try {
      // The model was asked for a bare JSON object; a fenced response is tolerated by
      // extracting the first {...} block, but anything that still doesn't parse is a failure,
      // never a guess.
      const match = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : text);
    } catch {
      throw new HostedJudgeFailure("unparseable_response", "Judge response was not valid JSON.");
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new HostedJudgeFailure("malformed_response", "Judge response was not a JSON object.");
    }

    const obj = parsed as Record<string, unknown>;
    const out = {} as RubricBreakdown;
    for (const dim of RUBRIC_DIMENSIONS) {
      const entry = obj[dim];
      if (
        typeof entry !== "object" || entry === null ||
        typeof (entry as any).score !== "number" ||
        typeof (entry as any).reason !== "string"
      ) {
        throw new HostedJudgeFailure(
          "missing_dimension",
          `Judge response is missing a valid "${dim}" entry with numeric score and string reason.`,
        );
      }
      out[dim] = { score: (entry as any).score, reason: (entry as any).reason };
    }
    return out;
  }
}
