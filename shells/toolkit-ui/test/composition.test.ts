import { describe, it, expect } from "vitest";
import { composeOrchestrator, composePipeline } from "../src/composition-root.js";

const sink = { emit: () => {} };

describe("toolkit-ui composition root", () => {
  it("provides a provider with the local-proxy transport by default", () => {
    const opts = composePipeline({ sink });
    expect(opts.provider.provider_id).toBe("local-proxy");
  });

  it("provides an orchestrator with the local-proxy transport", () => {
    const orch = composeOrchestrator({ sink });
    const asAny = orch as unknown as { provider: { provider_id: string } };
    expect(asAny.provider.provider_id).toBe("local-proxy");
  });

  it("does not reach the network at composition time", () => {
    expect(() => composePipeline({ sink })).not.toThrow();
    expect(() => composeOrchestrator({ sink })).not.toThrow();
  });

  it("picks the same transport as pipeline-ui for the same input", () => {
    const toolkit = composePipeline({ sink }).provider.provider_id;
    expect(toolkit).toBe("local-proxy");
  });
});
