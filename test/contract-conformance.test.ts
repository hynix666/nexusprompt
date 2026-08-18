import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsImport from "ajv-formats";

/**
 * `ajv-formats` is CommonJS with a default export. Under `module: nodenext` the
 * default import types as the module namespace, while at runtime the interop hands
 * back the callable — so the types and the execution disagree and only the types are
 * wrong. One cast at one call site, rather than loosening the compiler for the repo.
 *
 * This surfaced only when `tsconfig.json` was widened to actually include `test/`.
 */
const addFormats = addFormatsImport as unknown as (ajv: Ajv) => Ajv;
import { Orchestrator } from "../application/src/orchestrator.js";
import { LocalRevisionStore } from "../adapters/storage-local/src/index.js";
import { LocalProxyProvider } from "../adapters/provider-local-proxy/src/index.js";
import { runGates } from "../core/src/gates/registry.js";
import { listTechniques } from "../core/src/catalog/registry.js";
import type {
  GenerationRequest,
  ObservabilityEvent,
  PipelineCommand,
  ProviderFailure,
  ProviderTransport,
  RevisionEntry,
} from "../contracts/index.js";

/**
 * Every contract schema, validated against a value the system actually produced.
 *
 * `contracts/index.ts` claimed: "The schemas are the source of truth: the tests
 * validate real values against them, so a type that drifts from its schema is caught
 * by a failing fixture rather than by review." Two of the five schemas were validated
 * anywhere. `provider-failure`, `revision-entry`, and `observability-event` were
 * loaded by no test at all, so three fifths of that sentence was decoration.
 *
 * Two things are asserted here, and the second is the one that keeps this file honest
 * as the contract set grows:
 *
 *   1. A real produced value validates against each schema, and a deliberately broken
 *      one does not — a validator that cannot reject proves nothing.
 *   2. The set of `*.schema.json` files on disk equals the set covered below. Adding a
 *      schema without a conformance case fails this suite instead of quietly restoring
 *      the situation this file exists to fix.
 *
 * Values come from the real orchestrator, the real store, and the real provider
 * adapter. A fake's output would only prove the fake matches the schema.
 */

// `format` is not a core JSON Schema assertion — ajv ignores it unless the formats
// plugin is registered, and it was printing "unknown format date-time ignored" for
// every timestamp in the contract set. Two schemas declared a constraint that
// validated nothing. Registering the plugin makes the declaration mean what it says.
const ajv = addFormats(new Ajv({ strict: false }));
const schemaPath = (name: string) => join("contracts", `${name}.schema.json`);
const load = (name: string) => JSON.parse(readFileSync(schemaPath(name), "utf8"));

// gate-result is referenced by pipeline-outcome, so it is registered rather than compiled twice.
ajv.addSchema(load("gate-result"));

const validators: Record<string, ValidateFunction> = {
  "gate-result": ajv.getSchema(load("gate-result").$id)! as ValidateFunction,
  "pipeline-outcome": ajv.compile(load("pipeline-outcome")),
  "provider-failure": ajv.compile(load("provider-failure")),
  "revision-entry": ajv.compile(load("revision-entry")),
  "observability-event": ajv.compile(load("observability-event")),
  "technique-record": ajv.compile(load("technique-record")),
};

const report = (v: ValidateFunction, value: unknown) => {
  const ok = v(value);
  if (!ok) console.error(v.errors);
  return ok;
};

/* ── produce real values once ─────────────────────────────────────────────── */

class DeadProvider implements ProviderTransport {
  readonly provider_id = "local-proxy";
  async generate(req: GenerationRequest): Promise<ProviderFailure> {
    return {
      request_id: req.request_id,
      category: "UNAVAILABLE",
      retriable: false,
      reason_code: "connection_failed",
      safe_message: "Could not reach the provider.",
      retry_after_ms: null,
      attempt: 1,
      provider_id: this.provider_id,
    };
  }
  async healthCheck() {
    return {
      ok: false,
      checked_at: "2026-08-16T00:00:00.000Z",
      latency_ms: 0,
      degradation_state: "UNAVAILABLE" as const,
      failing_dependency: "network",
    };
  }
}

let root: string;
let outcome: Awaited<ReturnType<Orchestrator["run"]>>;
let revision: RevisionEntry;
let events: ObservabilityEvent[];
let adapterFailure: ProviderFailure;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pnx-contract-"));
  events = [];
  let tick = 0;
  const store = new LocalRevisionStore(root);
  const orchestrator = new Orchestrator({
    provider: new DeadProvider(),
    store,
    sink: { emit: (e) => events.push(e) },
    now: () => new Date(1_760_000_000_000 + tick++ * 10),
    sleep: async () => {},
    coreBuildHash: "test",
  });

  const command: PipelineCommand = {
    command_id: "cmd-1",
    run_id: "run-contract",
    stage_id: "compile",
    input: { brief: "A support bot that answers billing questions." },
  };
  outcome = await orchestrator.run(command);
  revision = (await store.getRun("run-contract"))[0];

  // A genuine failure from the real adapter: no key configured, so it refuses
  // before reaching the network.
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const produced = await new LocalProxyProvider({
    fetchImpl: async () => {
      throw new Error("the adapter must not call out with no key configured");
    },
  }).generate({
    request_id: "req-contract",
    run_id: "run-contract",
    messages: [{ role: "user", content: "hello" }],
    model_policy: { preferred_models: ["claude-opus-5"], allow_fallback: false },
  });
  if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  if (!("category" in produced)) throw new Error("expected the adapter to fail without a key");
  adapterFailure = produced;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/* ── the five schemas ─────────────────────────────────────────────────────── */

describe("gate-result", () => {
  it("validates every gate's real output", () => {
    for (const r of runGates("We guarantee 100% accurate answers. sk-ant-" + "a".repeat(20))) {
      expect(report(validators["gate-result"], r)).toBe(true);
    }
  });

  it("rejects an unknown verdict", () => {
    const [first] = runGates("clean");
    expect(validators["gate-result"]({ ...first, verdict: "MAYBE" })).toBe(false);
  });
});

describe("pipeline-outcome", () => {
  it("validates a real outcome", () => {
    expect(report(validators["pipeline-outcome"], outcome)).toBe(true);
  });

  it("rejects an outcome missing demo_mode", () => {
    const { demo_mode, ...withoutFlag } = outcome as typeof outcome & { demo_mode: boolean };
    expect(validators["pipeline-outcome"](withoutFlag)).toBe(false);
  });
});

describe("provider-failure", () => {
  it("validates a failure the real adapter produced", () => {
    expect(report(validators["provider-failure"], adapterFailure)).toBe(true);
  });

  it("names the missing environment variable and leaks nothing else", () => {
    expect(adapterFailure.category).toBe("AUTH");
    expect(adapterFailure.safe_message).toContain("ANTHROPIC_API_KEY");
  });

  it("rejects an unknown category", () => {
    expect(validators["provider-failure"]({ ...adapterFailure, category: "WEIRD" })).toBe(false);
  });

  it("rejects an undeclared extra field — the contract is closed", () => {
    expect(validators["provider-failure"]({ ...adapterFailure, raw_response: "…" })).toBe(false);
  });
});

describe("revision-entry", () => {
  it("validates the entry the store persisted", () => {
    expect(report(validators["revision-entry"], revision)).toBe(true);
  });

  it("records a demo run as DEMO, and the schema admits it", () => {
    expect(revision.status).toBe("DEMO");
  });

  it("rejects a non-sha256 input_hash", () => {
    expect(validators["revision-entry"]({ ...revision, input_hash: "short" })).toBe(false);
  });

  it("rejects an unknown retention scope", () => {
    expect(validators["revision-entry"]({ ...revision, retention_scope: "FOREVER" })).toBe(false);
  });

  it("rejects a timestamp that is not a date-time", () => {
    // Proves the formats plugin is registered. Without it ajv ignores `format`
    // entirely, and "last Tuesday" would validate.
    expect(validators["revision-entry"]({ ...revision, timestamp: "last Tuesday" })).toBe(false);
  });
});

describe("observability-event", () => {
  it("validates every event the run emitted", () => {
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(report(validators["observability-event"], e)).toBe(true);
    }
  });

  it("rejects an unknown event type", () => {
    expect(validators["observability-event"]({ ...events[0], event_type: "SOMETHING_ELSE" })).toBe(false);
  });

  it("rejects an event carrying an undeclared field", () => {
    // The sink rejects rather than truncates, so a payload that grew a `prompt`
    // field must fail the contract rather than be quietly accepted.
    expect(validators["observability-event"]({ ...events[0], prompt: "the body" })).toBe(false);
  });
});

describe("technique-record", () => {
  // Ajv types a validator as a type guard (`data is T`), which narrows the record to
  // `never` in the failure branch. Nothing here wants the narrowing — only the boolean.
  const validateTechnique = validators["technique-record"] as unknown as (d: unknown) => boolean;

  it("validates every imported record, not a sample", () => {
    const records = listTechniques();
    expect(records.length).toBe(180); // 172 frozen + 8 added at import
    const failed = records.filter((r) => !validateTechnique(r)).map((r) => r.id);
    if (failed.length) console.error(validators["technique-record"].errors);
    expect(failed).toEqual([]);
  });

  it("rejects an unknown category", () => {
    const [first] = listTechniques();
    expect(validators["technique-record"]({ ...first, category: "vibes" })).toBe(false);
  });

  it("rejects a record with no primary_source", () => {
    const { primary_source, ...withoutSource } = listTechniques()[0];
    expect(validators["technique-record"](withoutSource)).toBe(false);
  });

  it("rejects a record carrying an undeclared field — the contract is closed", () => {
    // Found by probe: loosening `additionalProperties` to true changed no emitted
    // bytes, so `check:catalog` passed and no test objected. The closed-ness of the
    // contract had nothing asserting it.
    const [first] = listTechniques();
    expect(validateTechnique({ ...first, invented_field: "x" })).toBe(false);
  });

  it("rejects an undeclared field inside primary_source", () => {
    const [first] = listTechniques();
    expect(validateTechnique({
      ...first,
      primary_source: { ...first.primary_source, scraped_from: "somewhere" },
    })).toBe(false);
  });

  it("rejects a malformed arXiv id while still allowing null", () => {
    const [first] = listTechniques();
    const bad = { ...first, primary_source: { ...first.primary_source, arxiv_id: "not-an-id" } };
    expect(validators["technique-record"](bad)).toBe(false);

    const nulled = { ...first, primary_source: { ...first.primary_source, arxiv_id: null } };
    expect(validators["technique-record"](nulled)).toBe(true);
  });
});

/* ── the coverage check ───────────────────────────────────────────────────── */

describe("schema coverage", () => {
  /**
   * Contract-first (ADR-0002) says a schema lands before the code that emits it.
   * The coverage rule says every schema is validated against a value the system
   * produced. Both are right, and `contracts/pending-implementation.json` is the
   * seam: a schema listed there is exempt, and says why and what will produce it.
   */
  const pending = JSON.parse(readFileSync("contracts/pending-implementation.json", "utf8")).pending as Array<{
    schema: string; reason: string; produced_by: string; adr: string;
  }>;

  const onDisk = () =>
    readdirSync("contracts")
      .filter((f) => f.endsWith(".schema.json"))
      .map((f) => f.replace(".schema.json", ""))
      .sort();

  it("every schema is either validated against a real value or declared pending", () => {
    const covered = new Set([...Object.keys(validators), ...pending.map((p) => p.schema)]);
    const uncovered = onDisk().filter((s) => !covered.has(s));
    expect(uncovered).toEqual([]);
  });

  it("no schema is both validated and declared pending — a stale exemption fails", () => {
    // The exemption must not outlive the implementation it was waiting for; once a
    // producer exists, the entry has to go or it silently excuses the next schema.
    const stale = pending.map((p) => p.schema).filter((s) => s in validators);
    expect(stale).toEqual([]);
  });

  it("every pending entry states a reason, a producer, and an ADR", () => {
    for (const p of pending) {
      expect(p.reason?.length ?? 0, `${p.schema} reason`).toBeGreaterThan(20);
      expect(p.produced_by?.length ?? 0, `${p.schema} produced_by`).toBeGreaterThan(3);
      expect(p.adr, `${p.schema} adr`).toBeTruthy();
    }
  });

  it("every pending schema actually exists on disk", () => {
    const disk = new Set(onDisk());
    expect(pending.map((p) => p.schema).filter((s) => !disk.has(s))).toEqual([]);
  });

  it("the declared contracts compile — a schema that ajv rejects is not a contract", () => {
    for (const p of pending) {
      const schema = JSON.parse(readFileSync(`contracts/${p.schema}.schema.json`, "utf8"));
      expect(() => ajv.compile(schema), `${p.schema} failed to compile`).not.toThrow();
    }
  });

  it("ajv does not silently ignore an unknown keyword here", () => {
    // `strict: false` is set so that documentation keywords in the schemas do not
    // throw. That also means a typo'd keyword would be ignored rather than reported,
    // so the negative cases above are what prove each validator can reject — not the
    // presence of the constraint in the file.
    const v = ajv.compile({ type: "object", required: ["x"] });
    expect(v({})).toBe(false);
    expect(v({ x: 1 })).toBe(true);
  });
});
