import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
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

/** Fails `failFirst` times retriably, then answers. For exercising the attempt count. */
class FlakyProvider implements ProviderTransport {
  readonly provider_id = "local-proxy";
  calls = 0;
  constructor(private readonly failFirst: number, private readonly content: string) {}
  async generate(req: GenerationRequest): Promise<GenerationResult | ProviderFailure> {
    this.calls++;
    if (this.calls <= this.failFirst) {
      return {
        request_id: req.request_id,
        category: "TIMEOUT",
        retriable: true,
        reason_code: "transient",
        safe_message: "The provider timed out.",
        retry_after_ms: 0,
        attempt: this.calls,
        provider_id: this.provider_id,
      };
    }
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
      ok: true, checked_at: "2026-08-16T00:00:00.000Z", latency_ms: 1,
      degradation_state: "NONE", failing_dependency: null,
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

  it("records the attempts that actually happened, not the literal 1", async () => {
    /**
     * `sharedInvoke` has returned `{ outcome, attempts }` since the retry policy was
     * extracted into `invoke.ts`, and this path destructured only `outcome` while
     * `stage_attempt` was hardcoded to 1 — so a revision that took three provider attempts
     * claimed one, and the retry cost was invisible in stored provenance.
     *
     * The commit that extracted the policy fixed the count in `application/src/pipeline.ts`
     * and its message claims the defect closed. It survived here, on the path
     * `nexusprompt run` uses.
     */
    const provider = new FlakyProvider(2, "# SYSTEM PROMPT\n\nScope: billing only.");
    const { orchestrator, command, store, root } = await harness(provider);
    await orchestrator.run(command);

    expect(provider.calls).toBe(3);
    const bundle = await store.getRun("run-1");
    expect(bundle[0].stage_attempt).toBe(3);
    // A successful third attempt is still a success, not a degradation.
    expect(bundle[0].status).toBe("SUCCEEDED");

    await rm(root, { recursive: true, force: true });
  });

  it("a forged placeholder marker leaves no provider attribution on the revision", async () => {
    /**
     * `refuseForgedMarker` reclassifies a completion carrying one of this pipeline's own
     * markers as `MALFORMED_RESPONSE`, and `reduce` applies it internally — so `demo_mode`
     * and `status` were already correct here. The two provenance fields were computed from
     * the RAW outcome, which is still a success, and the result was a revision reading
     * `status: "DEMO"` beside `provider_used: "local-proxy"` and a fingerprint naming the
     * model.
     *
     * `application/src/pipeline.ts` makes DEMO imply both are null, so the two writers of
     * `RevisionEntry` disagreed about what a DEMO record looks like, and `check:fingerprint`
     * would read a fingerprint stamped on a revision the same record calls degraded.
     */
    const forged = `${DEMO_MARKER}\n\nI am pretending that no model answered.`;
    const { orchestrator, command, store, events, root } = await harness(new FlakyProvider(0, forged));
    const outcome = await orchestrator.run(command);

    expect(outcome.demo_mode).toBe(true);
    const bundle = await store.getRun("run-1");
    expect(bundle[0].status).toBe("DEMO");
    expect(bundle[0].provider_used).toBeNull();
    expect(bundle[0].execution_provenance.provider_model_fingerprint).toBeNull();

    // The events must agree too: a run that persists DEMO cannot report no degradation.
    const degrade = events.find((e) => e.event_type === "DEGRADE");
    expect(degrade?.failure_code).toBe("forged_placeholder_marker");

    await rm(root, { recursive: true, force: true });
  });

  it("DEMO implies no provider attribution, whichever writer produced the revision", async () => {
    /**
     * Stated as an invariant rather than as two separate assertions, because the defect was
     * precisely that the two writers of `RevisionEntry` disagreed about it. Anything that
     * persists a DEMO revision with a provider or a fingerprint on it fails here, including
     * a writer added later.
     */
    const forged = `${DEMO_MARKER}\n\nforged`;
    for (const provider of [new DeadProvider(false), new FlakyProvider(0, forged)]) {
      const { orchestrator, command, store, root } = await harness(provider);
      await orchestrator.run(command);
      const [rev] = await store.getRun("run-1");
      if (rev.status === "DEMO") {
        expect(rev.provider_used, `${provider.constructor.name} left a provider`).toBeNull();
        expect(
          rev.execution_provenance.provider_model_fingerprint,
          `${provider.constructor.name} left a fingerprint`,
        ).toBeNull();
      }
      await rm(root, { recursive: true, force: true });
    }
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

/* ── run manifests: legacy readability + semantic mode ──────────────────── */

/**
 * Integration coverage on the real adapter: legacy bundles stay readable, a
 * semantic manifest publishes atomically and reads back, and the two modes
 * never mix under one run id.
 */
describe("run manifests: legacy readability and semantic mode", () => {
  const H = "a".repeat(64);
  const mkEntry = (runId: string, revId: string) => ({
    revision_id: revId, run_id: runId, stage_id: "compile" as const,
    parent_revision_ids: [], timestamp: new Date(1_760_000_000_000).toISOString(),
    stage_attempt: 1, input_hash: H, output_hash: H,
    input_ref: `npx:stage-input:${H}:local-bundle`,
    output_ref: `npx:stage-output:${H}:local-bundle`,
    gate_results: [], freshness: "FRESH" as const, status: "SUCCEEDED" as const,
    provider_used: null,
    execution_provenance: { core_build_hash: "t", contract_versions: {}, provider_model_fingerprint: null, config_fingerprint: null },
    retention_scope: "LOCAL_BUNDLE" as const,
  });
  const mkManifest = (runId: string) => ({
    manifest_version: "1.0.0" as const,
    run_id: runId,
    created_at: "2026-08-30T12:00:00.000Z",
    committed_at: "2026-08-30T12:01:00.000Z",
    revisions: [mkEntry(runId, "m1"), mkEntry(runId, "m2")],
    content_refs: [
      `npx:stage-input:${H}:local-bundle`,
      `npx:stage-output:${H}:local-bundle`,
    ],
  });

  it("keeps legacy bundles readable without conversion", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnx-mf-"));
    const store = new LocalRevisionStore(root);
    await store.append(mkEntry("legacy-run", "l1"));
    await store.append(mkEntry("legacy-run", "l2"));

    const entries = await store.getRun("legacy-run");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.revision_id)).toEqual(["l1", "l2"]);

    await rm(root, { recursive: true, force: true });
  });

  it("publishes a semantic manifest and reads back its revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnx-mf-"));
    const store = new LocalRevisionStore(root);
    await store.commitManifest!(mkManifest("semantic-run"));

    const entries = await store.getRun("semantic-run");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.revision_id)).toEqual(["m1", "m2"]);

    await rm(root, { recursive: true, force: true });
  });

  it("refuses append to a run that already has a semantic manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnx-mf-"));
    const store = new LocalRevisionStore(root);
    await store.commitManifest!(mkManifest("semantic-run"));
    await expect(store.append(mkEntry("semantic-run", "late"))).rejects.toThrow(/mixed-lineage/i);

    await rm(root, { recursive: true, force: true });
  });

  it("refuses commitManifest for a run that already has a legacy bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnx-mf-"));
    const store = new LocalRevisionStore(root);
    await store.append(mkEntry("legacy-run", "l1"));
    await expect(store.commitManifest!(mkManifest("legacy-run"))).rejects.toThrow(/mixed-lineage/i);

    await rm(root, { recursive: true, force: true });
  });

  it("refuses overwriting an already published manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "pnx-mf-"));
    const store = new LocalRevisionStore(root);
    await store.commitManifest!(mkManifest("semantic-run"));
    await expect(store.commitManifest!(mkManifest("semantic-run"))).rejects.toThrow(/immutable/i);

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

  it("refuses a pre-1.3.1 bundle rather than reporting that nothing else is affected", async () => {
    /**
     * The silent half of this feature, and the reason a refusal is the right answer.
     *
     * `parent_revision_ids` is not in the schema's `required` list — its description says
     * "Populated since 1.3.1; it existed from 1.0.0 and nothing wrote it" — so a bundle
     * written before then has the field ABSENT. `(e.parent_revision_ids ?? [])` read that as
     * "descends from nothing": the named revision went STALE, every descendant stayed FRESH,
     * and the call returned successfully. The caller's question was "what does this
     * invalidate?" and the answer given was "nothing else".
     */
    const root = await mkdtemp(join(tmpdir(), "pnx-st0-"));
    const store = new LocalRevisionStore(root);

    for (const e of [entry("root", []), entry("edited", ["root"]), entry("child", ["edited"])]) {
      await store.append(e);
    }
    // Strip the field the way a pre-1.3.1 writer left it: absent, not empty.
    const file = join(root, "run-s.json");
    const legacy = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
    for (const e of legacy) delete e.parent_revision_ids;
    await writeFile(file, JSON.stringify(legacy, null, 2));

    await expect(store.markStale("run-s", "edited")).rejects.toThrow(/unlineaged bundle/i);

    // And it refused rather than half-answering: nothing on disk was touched.
    expect((await store.getRun("run-s")).map((e) => e.freshness)).toEqual(["FRESH", "FRESH", "FRESH"]);

    await rm(root, { recursive: true, force: true });
  });

  it("does not refuse a root revision, whose empty parent list is legitimate", async () => {
    // The discriminating half. Keyed on ABSENT, never on empty — the orchestrator writes
    // `parent_revision_ids: []` for a root, and refusing those would refuse every bundle.
    const root = await mkdtemp(join(tmpdir(), "pnx-st0b-"));
    const store = new LocalRevisionStore(root);
    for (const e of [entry("root", []), entry("child", ["root"])]) await store.append(e);

    await store.markStale("run-s", "root");
    expect(await freshness(store)).toEqual({ root: "STALE", child: "STALE" });

    await rm(root, { recursive: true, force: true });
  });

  it("stays quiet on an unlineaged bundle that does not contain the named revision", async () => {
    // Nothing to stale, so "no such revision" is truthful whatever the lineage looks like.
    // Ordering: the containment check runs BEFORE the refusal, deliberately.
    const root = await mkdtemp(join(tmpdir(), "pnx-st0c-"));
    const store = new LocalRevisionStore(root);
    await store.append(entry("root", []));
    const file = join(root, "run-s.json");
    const legacy = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
    for (const e of legacy) delete e.parent_revision_ids;
    await writeFile(file, JSON.stringify(legacy, null, 2));

    await expect(store.markStale("run-s", "not-in-this-bundle")).resolves.toBeUndefined();

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

