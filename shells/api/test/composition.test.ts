import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { composeApi } from "../src/composition-root.js";
import { LocalRevisionStore } from "../../../adapters/storage-local/src/index.js";

const ENV_VAR = "NEXUSPROMPT_MAX_PROVIDER_CALLS";
const saved = process.env[ENV_VAR];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = saved;
});

/**
 * `composeApi()`'s default wiring, and the one thing an earlier PR (#161) added to it.
 *
 * The default wiring — which provider, which store — went untested until now: every
 * shell test passes explicit `deps`, so a typo swapping `LocalProxyProvider` for
 * something else, or pointing the store at the wrong directory, would have passed every
 * existing test in this shell. The other three shells (cli, pipeline-ui, toolkit-ui) each
 * have a composition test asserting exactly this; the API shell did not.
 */
describe("composeApi wires the real local-proxy transport and store by default", () => {
  it("provides a provider with the local-proxy transport", () => {
    const deps = composeApi();
    expect(deps.provider.provider_id).toBe("local-proxy");
  });

  it("gives the Orchestrator the same provider, not a second instance", () => {
    // Matches the pipeline-ui/toolkit-ui composition tests' own shape for the same check --
    // Orchestrator's provider is a private field, reached the same way theirs is.
    const deps = composeApi();
    const orch = deps.orchestrator as unknown as { provider: { provider_id: string } };
    expect(orch.provider.provider_id).toBe("local-proxy");
    expect(orch.provider).toBe(deps.provider);
  });

  it("backs the Orchestrator with a real LocalRevisionStore under .nexusprompt/runs", () => {
    const deps = composeApi();
    const orch = deps.orchestrator as unknown as { store: unknown };
    expect(orch.store).toBeInstanceOf(LocalRevisionStore);
    const store = orch.store as unknown as { root: string };
    expect(store.root).toBe(join(process.cwd(), ".nexusprompt", "runs"));
  });
});

describe("composeApi wires the environment's provider-call budget through", () => {
  it("passes no budget when the variable is unset, matching admitRun's own default", () => {
    delete process.env[ENV_VAR];
    const deps = composeApi();
    const orch = deps.orchestrator as unknown as { budget: unknown };
    expect(orch.budget).toBeNull();
  });

  it("passes the parsed Budget through when the variable is set", () => {
    process.env[ENV_VAR] = "2";
    const deps = composeApi();
    const orch = deps.orchestrator as unknown as { budget: unknown };
    expect(orch.budget).toEqual({ max_provider_calls: 2, max_usd: null, on_exceed: "refuse" });
  });

  it("does not reach the network at composition time", () => {
    // Matches the other three shells' composition tests: composing must never be the moment
    // something touches a provider.
    delete process.env[ENV_VAR];
    expect(() => composeApi()).not.toThrow();
  });
});
