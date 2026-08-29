import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv } from "ajv";
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
    // Stage-generic since eleven stages share one placeholder in stage-kit.ts.
    expect(outcome.output.text).toContain("No output was produced");
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
    expect(outcome.output.text).not.toContain("⟦WORKFLOW DEMO — no model⟧");

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
    const { demo_mode, ...withoutFlag } = outcome as unknown as Record<string, unknown> & { demo_mode: boolean };
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
        input_ref: null, output_ref: null,
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
          input_ref: null, output_ref: null,
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

/* ── the staleness cascade ───────────────────────────────────────────────── */

/**
 * `markStale` shipped with zero callers and zero tests, cascading by array position.
 *
 * These fixtures are built so that lineage and position DISAGREE. A bundle whose append
 * order matches its dependency order cannot tell the two implementations apart, which is
 * why nothing caught it: every bundle this repository had ever written was linear.
 */
describe("markStale cascades along lineage, not append order", () => {
  const entry = (id: string, parents: string[], stage = "compile") => ({
    revision_id: id, run_id: "run-s", stage_id: stage as never,
    parent_revision_ids: parents, timestamp: new Date(1_760_000_000_000).toISOString(),
    stage_attempt: 1, input_hash: "a".repeat(64), output_hash: "b".repeat(64),
    input_ref: null, output_ref: null,
    gate_results: [], freshness: "FRESH" as const, status: "SUCCEEDED" as const,
    provider_used: null,
    execution_provenance: { core_build_hash: "t", contract_versions: {}, provider_model_fingerprint: null, config_fingerprint: null },
    retention_scope: "LOCAL_BUNDLE" as const,
  });

  const freshness = async (store: LocalRevisionStore) =>
    Object.fromEntries((await store.getRun("run-s")).map((e) => [e.revision_id, e.freshness]));

  it("stales the named revision and its descendants, and leaves a sibling branch alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnx-st-"));
    const store = new LocalRevisionStore(root);

    // Two independent chains. `sib` sits AFTER `edited` in append order but descends from
    // nothing that was staled, so a position walk stales it and a lineage walk does not.
    // That disagreement is the entire point of the fixture.
    for (const e of [
      entry("root", []),
      entry("edited", ["root"]),
      entry("sib", []),                 // second root — later in the array, unrelated
      entry("child", ["edited"]),
      entry("sib-child", ["sib"]),
      entry("grandchild", ["child"]),
    ]) await store.append(e);

    await store.markStale("run-s", "edited");
    expect(await freshness(store)).toEqual({
      root: "FRESH",                    // an ancestor is not invalidated by its descendant
      edited: "STALE",                  // inclusive: it is the thing being superseded
      child: "STALE",
      grandchild: "STALE",              // transitively, through `child`
      sib: "FRESH",                     // must-not-fire — later in the array, no lineage
      "sib-child": "FRESH",
    });

    await rm(root, { recursive: true, force: true });
  });

  it("reaches a descendant appended BEFORE its parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnx-st2-"));
    const store = new LocalRevisionStore(root);

    /**
     * A bundle is not topologically ordered — a feedback jump appends a child of an
     * earlier revision after entries it does not descend from — so the cascade iterates
     * to a fixed point rather than once in array order.
     *
     * The chain is TWO levels deep on purpose. A one-level version of this fixture does
     * not discriminate: `far` is visited after `mid` has already been seeded, so a single
     * pass finds it and a probe deleting the fixed point survived. Only a descendant whose
     * parent is itself discovered DURING the pass needs the second one — here `far` sits
     * before `near`, and `near` is not stale until the pass reaches it.
     */
    for (const e of [
      entry("a", []),
      entry("far", ["near"]),          // grandchild, first in the file
      entry("near", ["seed"]),         // its parent, discovered mid-pass
      entry("seed", ["a"]),
    ]) await store.append(e);

    await store.markStale("run-s", "seed");
    expect(await freshness(store)).toEqual({
      a: "FRESH", seed: "STALE", near: "STALE", far: "STALE",
    });

    await rm(root, { recursive: true, force: true });
  });

  it("stales nothing for a revision this bundle does not contain", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnx-st3-"));
    const store = new LocalRevisionStore(root);

    /**
     * `orphan` names a parent the bundle lacks, which a partial write or a hand-edited
     * file can produce. Staling its descendants on the strength of an id nothing here can
     * account for would be inventing a lineage.
     *
     * The plain unknown-id case below does NOT discriminate on its own — with the guard
     * removed it cascades to nothing anyway, and a probe caught that the assertion was
     * proving less than it looked. The dangling parent is what makes the guard observable.
     */
    for (const e of [entry("a", []), entry("b", ["a"]), entry("orphan", ["ghost"])]) {
      await store.append(e);
    }

    await store.markStale("run-s", "ghost");
    expect(await freshness(store)).toEqual({ a: "FRESH", b: "FRESH", orphan: "FRESH" });

    await store.markStale("run-s", "no-such-revision");
    expect(await freshness(store)).toEqual({ a: "FRESH", b: "FRESH", orphan: "FRESH" });

    await rm(root, { recursive: true, force: true });
  });

  it("keeps status and gate results while changing freshness", async () => {
    // The two are independent by design: a revision is SUCCEEDED and STALE at once. A
    // cascade that downgraded status would destroy the record of what actually happened.
    const root = await mkdtemp(join(tmpdir(), "pnx-st4-"));
    const store = new LocalRevisionStore(root);
    await store.append({
      ...entry("a", []),
      gate_results: [{
        gate_id: "TOKEN_SPAM", gate_version: "1.0.0", verdict: "WARN",
        message: "kept", message_code: "TOKEN_SPAM.repeated", input_hash: "c".repeat(64), location: null,
      }],
    });

    await store.markStale("run-s", "a");
    const [reloaded] = await store.getRun("run-s");
    expect(reloaded.freshness).toBe("STALE");
    expect(reloaded.status).toBe("SUCCEEDED");
    expect(reloaded.gate_results).toHaveLength(1);

    await rm(root, { recursive: true, force: true });
  });
});
