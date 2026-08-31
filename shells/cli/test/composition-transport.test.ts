import { describe, it, expect } from "vitest";
import { composePipeline, composeOrchestrator } from "../src/composition-root.js";

/**
 * Which adapter the CLI names, asserted where the naming happens.
 *
 * The composition root is the one file in this Shell allowed to name a concrete adapter, and
 * "a composition root that names the wrong adapter" is the first wiring bug the pipeline
 * command's own suite lists. Until `--model` existed there was nothing to get wrong: it
 * named `LocalProxyProvider` unconditionally.
 *
 * Worth being exact about what that default is, because a comment here said the wrong thing
 * before this test was written. `LocalProxyProvider` is a real client for api.anthropic.com
 * that reads `ANTHROPIC_API_KEY` from the environment — so the default is not "reaches
 * nothing". With a key it reaches a hosted model and spends money; without one it degrades.
 * `--model` adds the transport that costs nothing, not the first transport.
 *
 * Asserted on `provider_id`, which is the same field `provenance.provider` records, so this
 * checks the value that ends up in a stored revision rather than a constructor name.
 */
const sink = { emit: () => {} };

describe("the CLI composition root picks a transport", () => {
  it("defaults to the hosted proxy when no model is named", () => {
    expect(composePipeline({ sink }).provider.provider_id).toBe("local-proxy");
  });

  it("names Ollama when a model is given", () => {
    expect(composePipeline({ sink, localModel: "llama3.1:8b" }).provider.provider_id)
      .toBe("ollama-local");
  });

  it("makes the same choice for a single-stage run", () => {
    // Two callers, one decision. The orchestrator taking a different branch would mean
    // `nexusprompt run --stage` and `nexusprompt pipeline` disagreeing about what a run is.
    const hosted = composeOrchestrator({ sink }) as unknown as { provider: { provider_id: string } };
    const local = composeOrchestrator({ sink, localModel: "llama3.1:8b" }) as unknown as {
      provider: { provider_id: string };
    };
    expect(hosted.provider.provider_id).toBe("local-proxy");
    expect(local.provider.provider_id).toBe("ollama-local");
  });

  it("constructs nothing that reaches the network at composition time", () => {
    // Composition is wiring. If naming an adapter dispatched anything, `--dry-run`-shaped
    // reasoning would be worthless and this suite could not run offline in CI.
    expect(() => composePipeline({ sink, localModel: "a-model-this-machine-does-not-have" }))
      .not.toThrow();
  });
});

/**
 * The per-generation timeout, and why the CLI needed to expose it at all.
 *
 * The adapter defaults to 120s and its own comment predicts the limit: "a 27B model on CPU
 * will exceed it, which is a real configuration rather than a fault." What that costs is not
 * a slow run but an EMPTY one. Measured on 31 August 2026: `phi4-reasoning:plus` at LOW
 * stakes timed out on its first generating stage, `compile` went DEMO, `preview` skipped
 * behind the placeholder guard, and the persisted bundle held four revisions and ZERO
 * fingerprints. A model too slow for the default is invisible to `check:fingerprint`, which
 * is the opposite of what a watch is for.
 */
describe("the local adapter's timeout is reachable from the CLI", () => {
  const sink = { emit: () => {} };
  const timeoutOf = (p: unknown) => (p as { timeoutMs?: number }).timeoutMs;

  it("passes the operator's ceiling through to the adapter", () => {
    const p = composePipeline({ sink, localModel: "qwen3.8:27b", localTimeoutMs: 900_000 }).provider;
    expect(timeoutOf(p)).toBe(900_000);
  });

  it("leaves the adapter's own default in place when none is given", () => {
    // Omitted rather than passed as undefined, so the number lives in exactly one place.
    const p = composePipeline({ sink, localModel: "qwen3.8:27b" }).provider;
    expect(timeoutOf(p)).toBe(120_000);
  });

  it("does not reach the hosted proxy, which is why the flag refuses without --model", () => {
    // The proxy has its own timeout and this option does not touch it. Accepting the flag
    // there would silently do nothing, which is the failure mode `--provider` had.
    const p = composePipeline({ sink, localTimeoutMs: 900_000 }).provider;
    expect(p.provider_id).toBe("local-proxy");
    expect(timeoutOf(p)).not.toBe(900_000);
  });
});
