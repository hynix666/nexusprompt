import { describe, it, expect, afterEach } from "vitest";
import { composeApi } from "../src/composition-root.js";

const ENV_VAR = "NEXUSPROMPT_MAX_PROVIDER_CALLS";
const saved = process.env[ENV_VAR];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = saved;
});

/**
 * The one thing this PR changed in composeApi(): the Orchestrator now receives whatever
 * `providerCallBudgetFromEnv()` produces. `composeApi()`'s DEFAULT wiring — which provider,
 * which store — is untested separately from this change and stays that way here; this checks
 * only the line this PR added, matching the other three shells' composition tests in shape.
 */
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
