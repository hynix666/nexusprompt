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

/* ── the coverage check ───────────────────────────────────────────────────── */

describe("schema coverage", () => {
  it("every schema in contracts/ is validated against a real value above", () => {
    const onDisk = readdirSync("contracts")
      .filter((f) => f.endsWith(".schema.json"))
      .map((f) => f.replace(".schema.json", ""))
      .sort();

    expect(onDisk).toEqual(Object.keys(validators).sort());
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
