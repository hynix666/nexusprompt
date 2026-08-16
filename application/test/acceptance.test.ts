import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { Orchestrator } from "../src/orchestrator.js";
import { LocalRevisionStore } from "../../adapters/storage-local/src/index.js";
import { DEMO_MARKER } from "../../core/src/stages/compile.js";
import type {
  GenerationRequest,
  GenerationResult,
  ObservabilityEvent,
  PipelineCommand,
  ProviderFailure,
  ProviderHealth,
  ProviderTransport,
} from "../../contracts/index.js";

/* ── fakes: no network, no clock, no sleeping ────────────────────────────── */

class DeadProvider implements ProviderTransport {
  readonly provider_id = "local-proxy";
  calls = 0;
  constructor(private readonly retriable = true) {}
  async generate(req: GenerationRequest): Promise<ProviderFailure> {
    this.calls++;
    return {
      request_id: req.request_id,
      category: "UNAVAILABLE",
      retriable: this.retriable,
      reason_code: "connection_failed",
      safe_message: "Could not reach the provider.",
      retry_after_ms: 0,
      attempt: 1,
      provider_id: this.provider_id,
    };
  }
  async healthCheck(): Promise<ProviderHealth> {
    return {
      ok: false,
      checked_at: "2026-08-16T00:00:00.000Z",
      latency_ms: 0,
      degradation_state: "UNAVAILABLE",
      failing_dependency: "network",
    };
  }
}

class LiveProvider implements ProviderTransport {
  readonly provider_id = "local-proxy";
  constructor(private readonly content: string) {}
  async generate(req: GenerationRequest): Promise<GenerationResult> {
    return {
      request_id: req.request_id,
      content: this.content,
      provider_id: this.provider_id,
      model_id: "claude-opus-5",
      finish_reason: "end_turn",
    };
  }
  async healthCheck(): Promise<ProviderHealth> {
    return {
      ok: true,
      checked_at: "2026-08-16T00:00:00.000Z",
      latency_ms: 1,
      degradation_state: "NONE",
      failing_dependency: null,
    };
  }
}

let clock = 0;
const now = () => new Date(1_760_000_000_000 + clock++ * 10);
const noSleep = async () => {};

async function harness(provider: ProviderTransport) {
  const root = await mkdtemp(join(tmpdir(), "pnx-"));
  const events: ObservabilityEvent[] = [];
  const store = new LocalRevisionStore(root);
  const orchestrator = new Orchestrator({
    provider,
    store,
    sink: { emit: (e) => events.push(e) },
    now,
    sleep: noSleep,
    coreBuildHash: "test",
  });
  const command: PipelineCommand = {
    command_id: "cmd-1",
    run_id: "run-1",
    stage_id: "compile",
    input: { brief: "A support bot that answers billing questions." },
  };
  return { orchestrator, command, store, events, root };
}

/* ── the acceptance test ─────────────────────────────────────────────────── */

describe("acceptance: provider unreachable", () => {
  it("produces labelled demo output instead of fabricating a prompt", async () => {
    const { orchestrator, command, events, root } = await harness(new DeadProvider());
    const outcome = await orchestrator.run(command);

    expect(outcome.demo_mode).toBe(true);
    expect(outcome.output.text).toContain(DEMO_MARKER);
    expect(outcome.output.text).toContain("No compiled prompt was produced");
    expect(events.some((e) => e.event_type === "DEGRADE")).toBe(true);

    await rm(root, { recursive: true, force: true });
  });

  it("CLAIM_DISCIPLINE passes on the demo output — it does not present itself as live", async () => {
    const { orchestrator, command, root } = await harness(new DeadProvider());
    const outcome = await orchestrator.run(command);

    const claim = outcome.gate_results.find((r) => r.gate_id === "CLAIM_DISCIPLINE");
    expect(claim?.verdict).toBe("PASS");

    await rm(root, { recursive: true, force: true });
  });

  it("does not attribute the input's overclaims to the placeholder", async () => {
    // Found by running the CLI: the placeholder echoes its input, so a brief
    // containing "100% accurate" made CLAIM_DISCIPLINE warn about the demo
    // output. The echo is fenced now — quoted input is data, not an assertion
    // the placeholder is making.
    const { orchestrator, command, root } = await harness(new DeadProvider());
    const outcome = await orchestrator.run({
      ...command,
      input: { brief: "This bot is 100% accurate and we guarantee every answer." },
    });

    expect(outcome.output.text).toContain("100% accurate"); // the echo is present
    const claim = outcome.gate_results.find((r) => r.gate_id === "CLAIM_DISCIPLINE");
    expect(claim?.verdict).toBe("PASS"); // but it is not read as the placeholder's claim

    await rm(root, { recursive: true, force: true });
  });

  it("persists the revision as DEMO, not FAILED — the run completed", async () => {
    const { orchestrator, command, store, root } = await harness(new DeadProvider());
    await orchestrator.run(command);

    const bundle = await store.getRun("run-1");
    expect(bundle).toHaveLength(1);
    expect(bundle[0].status).toBe("DEMO");
    expect(bundle[0].provider_used).toBeNull();
    expect(bundle[0].freshness).toBe("FRESH");

    await rm(root, { recursive: true, force: true });
  });

  it("retries a retriable failure and stops at the cap", async () => {
    const provider = new DeadProvider(true);
    const { orchestrator, command, root } = await harness(provider);
    await orchestrator.run(command);
    expect(provider.calls).toBe(3); // maxAttempts default
    await rm(root, { recursive: true, force: true });
  });

  it("does not retry a non-retriable failure", async () => {
    const provider = new DeadProvider(false);
    const { orchestrator, command, root } = await harness(provider);
    await orchestrator.run(command);
    expect(provider.calls).toBe(1);
    await rm(root, { recursive: true, force: true });
  });
});

describe("acceptance: provider reachable", () => {
  it("returns model output, status SUCCEEDED, demo_mode false", async () => {
    const { orchestrator, command, store, root } = await harness(
      new LiveProvider("# SYSTEM PROMPT\n\nAnswer billing questions only."),
    );
    const outcome = await orchestrator.run(command);

    expect(outcome.demo_mode).toBe(false);
    expect(outcome.output.text).toContain("SYSTEM PROMPT");
    expect(outcome.output.text).not.toContain(DEMO_MARKER);

    const bundle = await store.getRun("run-1");
    expect(bundle[0].status).toBe("SUCCEEDED");
    expect(bundle[0].provider_used).toBe("local-proxy");
    expect(bundle[0].execution_provenance.provider_model_fingerprint).toBe("local-proxy:claude-opus-5");

    await rm(root, { recursive: true, force: true });
  });

  it("emits a causally linked event chain", async () => {
    const { orchestrator, command, events, root } = await harness(new LiveProvider("ok"));
    await orchestrator.run(command);

    const types = events.map((e) => e.event_type);
    expect(types).toContain("PIPELINE_COMMAND_RECEIVED");
    expect(types).toContain("STAGE_DECISION");
    expect(types).toContain("PROVIDER_CALL_SUCCEEDED");
    expect(types).toContain("REVISION_PERSISTED");

    // Everything after the first event points at it.
    const root_event = events[0];
    expect(root_event.parent_event_id).toBeNull();
    for (const e of events.slice(1)) expect(e.parent_event_id).toBe(root_event.event_id);

    await rm(root, { recursive: true, force: true });
  });

  it("carries no prompt body in any event", async () => {
    const secret = "BILLING_ONLY_MARKER_9f3c";
    const { orchestrator, command, events, root } = await harness(new LiveProvider(secret));
    await orchestrator.run({ ...command, input: { brief: secret } });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);

    await rm(root, { recursive: true, force: true });
  });
});

/* ── contract conformance ────────────────────────────────────────────────── */

describe("PipelineOutcome conforms to its schema", () => {
  const ajv = new Ajv({ strict: false });
  ajv.addSchema(JSON.parse(readFileSync("contracts/gate-result.schema.json", "utf8")));
  const validate = ajv.compile(JSON.parse(readFileSync("contracts/pipeline-outcome.schema.json", "utf8")));

  it("validates a demo outcome", async () => {
    const { orchestrator, command, root } = await harness(new DeadProvider());
    const outcome = await orchestrator.run(command);
    const ok = validate(outcome);
    if (!ok) console.error(validate.errors);
    expect(ok).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("rejects an outcome missing demo_mode — the schema can fail", async () => {
    const { orchestrator, command, root } = await harness(new LiveProvider("x"));
    const outcome = await orchestrator.run(command);
    const { demo_mode, ...withoutFlag } = outcome as Record<string, unknown> & { demo_mode: boolean };
    expect(validate(withoutFlag)).toBe(false);
    await rm(root, { recursive: true, force: true });
  });
});

/* ── run-bundle retention ────────────────────────────────────────────────── */

describe("storage-local retains whole run bundles", () => {
  it("an 11-stage run persists and reloads intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnx-b-"));
    const store = new LocalRevisionStore(root);
    const stages = ["deconstruct", "calibrate", "compile", "harden", "critique", "refine",
                    "lint", "critic", "preview", "cost_estimate", "tone_check"] as const;

    for (const [i, stage] of stages.entries()) {
      await store.append({
        revision_id: `rev-${i}`, run_id: "run-11", stage_id: stage,
        parent_revision_ids: [], timestamp: new Date(1_760_000_000_000 + i).toISOString(),
        stage_attempt: 1, input_hash: "a".repeat(64), output_hash: "b".repeat(64),
        gate_results: [], freshness: "FRESH", status: "SUCCEEDED", provider_used: "local-proxy",
        execution_provenance: { core_build_hash: "t", contract_versions: {}, provider_model_fingerprint: null, config_fingerprint: null },
        retention_scope: "LOCAL_BUNDLE",
      });
    }

    expect(await store.getRun("run-11")).toHaveLength(11);
    await rm(root, { recursive: true, force: true });
  });

  it("evicts whole bundles, never partial runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnx-e-"));
    const store = new LocalRevisionStore(root);

    for (let r = 0; r < 10; r++) {
      for (let s = 0; s < 3; s++) {
        await store.append({
          revision_id: `r${r}-${s}`, run_id: `run-${r}`, stage_id: "compile",
          parent_revision_ids: [], timestamp: new Date(1_760_000_000_000 + r * 1000 + s).toISOString(),
          stage_attempt: 1, input_hash: "a".repeat(64), output_hash: "b".repeat(64),
          gate_results: [], freshness: "FRESH", status: "SUCCEEDED", provider_used: null,
          execution_provenance: { core_build_hash: "t", contract_versions: {}, provider_model_fingerprint: null, config_fingerprint: null },
          retention_scope: "LOCAL_BUNDLE",
        });
      }
    }

    const recent = await store.listRecent(20);
    expect(recent).toHaveLength(8);              // the bound
    for (const b of recent) expect(b.entries).toBe(3); // whole, never truncated
    expect(await store.getRun("run-0")).toHaveLength(0); // oldest evicted entirely

    await rm(root, { recursive: true, force: true });
  });

  it("refuses a run id that is a path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnx-p-"));
    const store = new LocalRevisionStore(root);
    await expect(store.getRun("../../etc/passwd")).rejects.toThrow(/Refusing/);
    await rm(root, { recursive: true, force: true });
  });
});
