import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { GuardedJudge } from "../application/src/judge.js";
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
import { CONTRACT_VERSIONS } from "../contracts/index.js";
import { listTechniques } from "../core/src/catalog/registry.js";
import { runSuite, configurationId } from "../application/src/eval.js";
import { compare } from "../core/src/eval/compare.js";
import { LocalEvidenceStore } from "../adapters/evidence-local/src/index.js";
import { freezeBaseline, promote } from "../application/src/release.js";
import { validateRoutingPolicy } from "../core/src/routing/policy.js";
import type {
  EvalRun,
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
  "configuration": ajv.compile(load("configuration")),
  "eval-suite": ajv.compile(load("eval-suite")),
  "eval-case": ajv.compile(load("eval-case")),
  "eval-run": ajv.compile(load("eval-run")),
  "comparison": ajv.compile(load("comparison")),
  "judge-verdict": ajv.compile(load("judge-verdict")),
  "baseline": ajv.compile(load("baseline")),
  "promotion": ajv.compile(load("promotion")),
  "routing-policy": ajv.compile(load("routing-policy")),
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

/**
 * Every version stamped into provenance equals the schema on disk.
 *
 * `CONTRACT_VERSIONS` is written into `execution_provenance` on every revision, so it is a
 * claim about what a run was executed against. It said comparison 2.1.0 and configuration
 * 1.2.0 while the schemas were 2.2.0 and 1.3.0 — a stored record naming a version it was not
 * produced under. Nothing caught it because nothing read the field, which is the same shape as
 * gate_version staying at 1.0.0 through two behaviour changes and parent_revision_ids being []
 * since 1.0.0.
 *
 * Bumping a schema's `$id` without this table is now a build failure rather than a silent
 * provenance lie.
 */
describe("CONTRACT_VERSIONS is provenance, not decoration", () => {
  it("stamps the version each schema actually carries", () => {
    const drift = Object.entries(CONTRACT_VERSIONS).flatMap(([name, stamped]) => {
      const file = schemaPath(name);
      if (!existsSync(file)) return [];
      const real = String(JSON.parse(readFileSync(file, "utf8")).$id).split("/").pop();
      return real === stamped ? [] : [{ name, stamped, schema: real }];
    });
    expect(drift).toEqual([]);
  });
});

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

  it("validates every event the PIPELINE emitted", async () => {
    /**
     * This suite validated events — but only the Orchestrator's, so the pipeline runner's
     * were checked by nothing. It emitted them through a cast that hid a wrong field name,
     * five missing required fields, and an event type absent from the enum.
     *
     * The pipeline is driven here, against the same Ajv validator, so the gap closes at the
     * source rather than in a hand-copied field list in the application suite. That list is
     * a second drift surface against this schema; this is the schema itself.
     */
    const { runPipeline } = await import("../application/src/pipeline.js");
    const emitted: ObservabilityEvent[] = [];
    let t = 0;

    await runPipeline(
      {
        command_id: "cmd", run_id: "conformance-run", stage_id: "deconstruct",
        input: { brief: "A support bot." },
        context: { depth: "STANDARD", stakes: "LOW", testMessage: "hi" },
      },
      {
        // Always fails, so the degraded, skipped and retry paths all emit too — a run that
        // only succeeds exercises four of the nine event types.
        provider: {
          provider_id: "conformance",
          async generate(req) {
            return {
              request_id: req.request_id, category: "UNAVAILABLE" as const, retriable: false,
              reason_code: "conformance", safe_message: "no provider in this suite",
              retry_after_ms: null, attempt: 1, provider_id: "conformance",
            };
          },
          async healthCheck() {
            return { ok: false, checked_at: "1970-01-01T00:00:00.000Z", latency_ms: 0,
                     degradation_state: "UNAVAILABLE" as const, failing_dependency: null };
          },
        },
        store: { async append() {}, async getRun() { return []; }, async listRecent() { return []; }, async markStale() {} },
        sink: { emit: (e) => { emitted.push(e); } },
        now: () => new Date(1_760_000_000_000 + t++ * 10),
        sleep: async () => {},
        coreBuildHash: "conformance",
      },
    );

    expect(emitted.length).toBeGreaterThan(10);
    for (const e of emitted) {
      expect(report(validators["observability-event"], e), e.event_type).toBe(true);
    }
    // The types the pipeline adds beyond the orchestrator's, each actually reached.
    for (const type of ["STAGE_SKIPPED", "DEGRADE", "STAGE_DECISION", "REVISION_PERSISTED"]) {
      expect(emitted.some((e) => e.event_type === type), type).toBe(true);
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
    expect(records.length).toBe(195); // 172 frozen + 23 added at import
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

/* ── the evaluation plane ─────────────────────────────────────────────────── */

describe("evaluation plane, against values the suite actually produced", () => {
  const suiteData = JSON.parse(readFileSync("eval/compile-smoke.json", "utf8"));

  it("eval-suite validates the smoke suite as written", () => {
    expect(report(validators["eval-suite"], suiteData.suite)).toBe(true);
  });

  it("eval-suite rejects a kind outside smoke/anchor/adversarial", () => {
    expect(validators["eval-suite"]({ ...suiteData.suite, kind: "vibes" })).toBe(false);
  });

  it("eval-suite rejects a suite that declares no resolution", () => {
    // A suite that cannot say what difference it detects cannot evidence "no change".
    const { resolution, ...noResolution } = suiteData.suite;
    expect(validators["eval-suite"](noResolution)).toBe(false);
  });

  it("eval-case validates every case in the suite", () => {
    // `stub` and `variant_stubs` are harness fields: what a pinned provider returns for this
    // case under each configuration. They are deliberately outside the contract, because a
    // case is a case whether the provider behind it is pinned or live.
    for (const c of suiteData.cases) {
      const { stub, variant_stubs, ...contractFields } = c;
      expect(report(validators["eval-case"], contractFields), c.case_id).toBe(true);
    }
  });

  it("eval-suite validates the adversarial suite, exercising kind and derived_from", () => {
    // `adversarial` and `derived_from` were declared vocabulary that nothing produced.
    const adv = JSON.parse(readFileSync("eval/compile-adversarial.json", "utf8"));
    expect(report(validators["eval-suite"], adv.suite)).toBe(true);
    expect(adv.suite.kind).toBe("adversarial");
    expect(adv.suite.derived_from).toBe(suiteData.suite.suite_id);
  });

  it("eval-case validates perturbation, and every perturbation names a real parent case", () => {
    const adv = JSON.parse(readFileSync("eval/compile-adversarial.json", "utf8"));
    const parents = new Set(suiteData.suite.case_ids);
    let withPerturbation = 0;

    for (const c of adv.cases) {
      const { stub, variant_stubs, ...contractFields } = c;
      expect(report(validators["eval-case"], contractFields), c.case_id).toBe(true);
      if (c.perturbation) {
        withPerturbation++;
        // A perturbation of a case nobody wrote describes a derivation that never happened.
        expect(parents.has(c.perturbation.of_case_id), `${c.case_id} -> ${c.perturbation.of_case_id}`).toBe(true);
      }
    }
    expect(withPerturbation).toBe(adv.cases.length);
  });

  it("eval-case rejects a case naming no failure mode", () => {
    const { stub, variant_stubs, ...first } = suiteData.cases[0];
    const { failure_mode, ...noMode } = first;
    expect(validators["eval-case"](noMode)).toBe(false);
    expect(validators["eval-case"]({ ...first, failure_mode: "vibes" })).toBe(false);
  });

  it("configuration and eval-run validate against a real run", async () => {
    const base = {
      prompt_template_ref: "core/src/stages/compile.ts",
      model_id: "pinned",
      decoding: { temperature: null, seed: null },
      topology: { kind: "sequential" as const, stages: ["compile"], max_iterations: null },
      retrieval_config: null,
      tool_config: null,
      gate_set_ref: "scripts/ported-gates.json",
      router_policy_ref: null,
    };
    const configuration = { configuration_id: configurationId(base), ...base };
    expect(report(validators["configuration"], configuration)).toBe(true);

    const { run } = await runSuite({ suite: suiteData.suite, cases: suiteData.cases, configuration });
    expect(report(validators["eval-run"], run)).toBe(true);
    expect(run.aggregate.cases).toBe(suiteData.suite.case_ids.length);

    /**
     * provenance 2.0.0 — the negative half, against the run just produced.
     *
     * Until 2.0.0 this field was `{"type": "object"}` with a prose description and nothing
     * required, so `provenance: {}` validated and so did a run that never said which transport
     * answered. `runSuite` DEFAULTS to the pinned stub; `provenance.provider` is the only thing
     * separating a run that is evidence about a model from one that is evidence about this
     * system's accounting. A schema that could not tell them apart was not describing the
     * field that carries the distinction.
     *
     * Mutated from the real value rather than hand-built, so each case differs from a run that
     * validates in exactly one way — otherwise a rejection could be caused by anything.
     */
    expect(report(validators["eval-run"], { ...run, provenance: {} })).toBe(false);
    for (const key of ["core_build_hash", "configuration_id", "suite_version", "provider"]) {
      const without = { ...(run.provenance as Record<string, unknown>) };
      delete without[key];
      expect(validators["eval-run"]({ ...run, provenance: without }), `missing ${key}`).toBe(false);
      // Present-but-empty is the same failure wearing a value: `provenance-complete` already
      // treats an empty build hash as incomplete, and a probe exists to prove it fires.
      expect(
        validators["eval-run"]({ ...run, provenance: { ...(run.provenance as object), [key]: "" } }),
        `empty ${key}`,
      ).toBe(false);
    }
    // And a field nobody declared is refused rather than carried — the run is evidence, and an
    // unrecognised key in it is a claim no consumer can interpret.
    expect(validators["eval-run"]({
      ...run, provenance: { ...(run.provenance as object), smuggled: "x" },
    })).toBe(false);
    // The must-not-reject half: the real value still validates after all that mutating.
    expect(report(validators["eval-run"], run)).toBe(true);

    // grader_health absent means no judge ran — never that a judge was fine.
    expect(run.grader_health).toBeNull();
    // Deterministic detectors are untuned, so the held-out guarantee holds by construction.
    expect(run.scorer_provenance?.selected_using).toBeNull();
  });

  it("configuration rejects an id that is not a content hash", () => {
    expect(validators["configuration"]({
      configuration_id: "not-a-hash", prompt_template_ref: "x", model_id: "m",
      decoding: { temperature: null, seed: null },
      topology: { kind: "sequential", stages: ["compile"] },
    })).toBe(false);
  });

  const recall = (r: number) => ({
    probe_corpus_version: "1.0.0",
    detectors: [{ detector_id: "d", substrates: 4, probes_run: 4, probes_detected: Math.round(r * 4), recall: r }],
  });

  const equalization = {
    equalized: true, max_gap: 0, gap_bound: 0.01,
    effective_recall: 1, adjusted_resolution: 0.01,
    per_detector: [{ detector_id: "d", candidate_recall: 1, baseline_recall: 1, gap: 0 }],
  };

  it("comparison validates a real verdict and keeps inconclusive reachable", () => {
    const cmp = compare({
      comparison_id: "cmp-1",
      candidate_run_id: "a",
      baseline_id: "b",
      // Eight cases, disagreeing on one. Two would be refused outright: the exact test needs
      // six discordant units before any arrangement clears 0.05, so a two-case comparison is
      // unanswerable rather than inconclusive, and this case exists to keep INCONCLUSIVE
      // reachable in the schema.
      candidate: Array.from({ length: 8 }, (_, i) => ({ case_id: `c${i}`, passed: true })),
      baseline: Array.from({ length: 8 }, (_, i) => ({ case_id: `c${i}`, passed: i !== 1 })),
      suite: { resolution: { detectable_delta: 0.01, confidence: 0.95 }, significance_protocol: "exact-mcnemar" as const },
      comparisons_in_family: 1,
      alpha: 0.05,
      candidateRecall: recall(1),
      baselineRecall: recall(1),
      suiteDetectorIds: ["d"],
    });
    expect(report(validators["comparison"], cmp)).toBe(true);
    expect(cmp.verdict).toBe("inconclusive"); // one discordant pair is not evidence
  });

  it("comparison validates a refusal, which carries equalization with nulls", () => {
    // A refusal for missing recall cannot compute a gap, and must not invent one.
    const cmp = compare({
      comparison_id: "cmp-2", candidate_run_id: "a", baseline_id: "b",
      candidate: [{ case_id: "c0", passed: true }],
      baseline: [{ case_id: "c0", passed: false }],
      suite: { resolution: { detectable_delta: 0.01, confidence: 0.95 }, significance_protocol: "exact-mcnemar" as const },
      comparisons_in_family: 1, alpha: 0.05,
      candidateRecall: null, baselineRecall: null, suiteDetectorIds: ["d"],
    });
    expect(report(validators["comparison"], cmp)).toBe(true);
    expect(cmp.verdict).toBe("refused");
    expect(cmp.equalization.max_gap).toBeNull();
  });


  /**
   * judge-verdict, produced by the guarded judge rather than hand-written.
   *
   * `contracts/pending-implementation.json` carried this schema as "emitted by the judge
   * adapter, which does not exist" from the day it landed. The adapter exists now, so the
   * exemption is removed and the schema is held to the same standard as every other: a value
   * the running system produced, validated, plus a broken one that must be rejected.
   */
  it("judge-verdict validates a verdict the guarded judge produced", async () => {
    const inner = {
      judge_id: "conformance-judge",
      judge_family: "other-family",
      async grade(req: any) {
        return {
          verdict: "PASS", rationale: null,
          judge_id: "conformance-judge", judge_family: "other-family",
          rubric_id: req.rubric_id, rubric_hash: req.rubric_hash,
          runs: req.runs, disagreement_rate: 0.0, position_randomized: req.position_randomized,
        };
      },
    };
    const verdict = await new GuardedJudge(inner as any).grade({
      candidate: "# SYSTEM PROMPT\n\nScope: billing only.",
      rubric_id: "helpfulness-v2",
      rubric_template: "Grade the candidate. Return PASS or FAIL.",
      candidate_family: "family-under-test",
      verification_status: "judge-checkable",
      calibration: {
        metric: "cohens-kappa", value: 0.82, threshold: 0.6,
        measured_at: "2026-08-20T00:00:00.000Z", reference: "gold-set-v1",
        max_age_days: 30,
      },
    }, "2026-08-19T00:00:00.000Z", "2026-08-22T00:00:00.000Z");

    expect(report(validators["judge-verdict"], verdict)).toBe(true);
    expect(verdict.judge_family).not.toBe("family-under-test");
  });

  it("judge-verdict rejects an agreement with no measurement date", () => {
    // measured_at became required in 1.1.0: an agreement figure with no date cannot be
    // checked against the judge contract's last change, so the staleness rule was
    // unenforceable while it was optional.
    expect(validators["judge-verdict"]({
      verdict: "PASS", judge_id: "j", judge_family: "f", rubric_id: "r",
      runs: 3, disagreement_rate: 0, position_randomized: true,
      agreement: { metric: "cohens-kappa", value: 0.8, threshold: 0.6 },
    })).toBe(false);
  });

  it("judge-verdict rejects a verdict that does not say which family judged it", () => {
    expect(validators["judge-verdict"]({
      verdict: "PASS", judge_id: "j", rubric_id: "r",
      runs: 3, disagreement_rate: 0, position_randomized: true,
    })).toBe(false);
  });

  it("comparison rejects a verdict outside the four", () => {
    expect(validators["comparison"]({
      comparison_id: "c", candidate_run_id: "a", baseline_id: "b",
      verdict: "probably-better", delta: 0.1,
      protocol: { test: "mcnemar", trials: 1, alpha: 0.05, comparisons_in_family: 1 },
      equalization,
    })).toBe(false);
  });

  it("comparison requires the family size — multiplicity cannot be omitted", () => {
    expect(validators["comparison"]({
      comparison_id: "c", candidate_run_id: "a", baseline_id: "b",
      verdict: "improved", delta: 0.1,
      protocol: { test: "mcnemar", trials: 1, alpha: 0.05 },
      equalization,
    })).toBe(false);
  });

  it("comparison 2.0.0 rejects the 1.0.0 boolean outright", () => {
    // The breaking half of the bump, asserted. `detectors_equalized` was a claim nobody
    // checked; a comparison still carrying it is one nothing derived, and must not validate.
    const asserted = {
      comparison_id: "c", candidate_run_id: "a", baseline_id: "b",
      verdict: "improved", delta: 0.1,
      protocol: { test: "mcnemar", trials: 1, alpha: 0.05, comparisons_in_family: 1 },
      detectors_equalized: true,
    };
    expect(validators["comparison"](asserted)).toBe(false);
    expect(validators["comparison"]({ ...asserted, equalization })).toBe(false); // both is still wrong
  });

  it("comparison requires equalization — evidence is not optional", () => {
    expect(validators["comparison"]({
      comparison_id: "c", candidate_run_id: "a", baseline_id: "b",
      verdict: "improved", delta: 0.1,
      protocol: { test: "mcnemar", trials: 1, alpha: 0.05, comparisons_in_family: 1 },
    })).toBe(false);
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

/**
 * The release plane, against records the promotion path actually wrote.
 *
 * `baseline` was the last entry in `contracts/pending-implementation.json`, carried since the
 * schema landed as "written by the release pipeline when a run is promoted... but no promotion
 * path exists and none should until an anchor suite does." The path exists now. The exemption
 * is removed and both schemas are held to the same standard as every other here: a value the
 * running system produced, validated, plus a broken one that must be rejected.
 *
 * Landing `baseline` before its producer worked exactly as ADR-0002 intends — and it also
 * surfaced the defect that `superseded_by` could never be written, which is the kind of thing
 * only found by trying to write one.
 */
describe("release plane, against records the promotion path wrote", () => {
  const CONFIG_ID = "b".repeat(64);
  const AT = "2026-08-22T12:00:00.000Z";
  let releaseSeq = 0;

  const evalRun = (id: string, passed: number): EvalRun => ({
    run_id: id,
    configuration_id: CONFIG_ID,
    suite_id: "compile-smoke",
    suite_version: "2.0.0",
    aggregate: { cases: 14, passed, score: passed / 14 },
    cost: { tokens_in: 10, tokens_out: 5, provider_calls: 14, cache_hits: 0, usd: 0.01, budget_exceeded: false },
    provenance: { source: "contract conformance" },
  });

  const seeded = async () => {
    // Under the suite's own temp root, which afterAll already removes. A unique subdirectory
    // per call because the evidence plane refuses a second write under the same id, and two
    // of these cases deliberately promote the same promotion_id.
    const dir = join(root, `release-${releaseSeq++}`);
    const store = new LocalEvidenceStore(dir);
    await store.put({ kind: "eval-run", id: "run-c", created_at: AT, body: evalRun("run-c", 13) });
    await store.put({ kind: "eval-run", id: "run-b", created_at: AT, body: evalRun("run-b", 8) });
    await store.put({
      kind: "comparison", id: "cmp", created_at: AT,
      body: {
        comparison_id: "cmp", candidate_run_id: "run-c", baseline_id: "base", verdict: "improved",
        refusal_reason: null, delta: 5 / 14,
        protocol: {
          test: "mcnemar", trials: 1, alpha: 0.05, comparisons_in_family: 1, correction: "none",
          p_value: 0.0009, effective_n: 14, discordant: 10, min_attainable_p: 2 * 0.5 ** 10, attainable: true,
        },
        equalization: {
          equalized: true, max_gap: 0, gap_bound: 1 / 14, effective_recall: 1,
          adjusted_resolution: 1 / 14, per_detector: [],
        },
      },
    });
    return store;
  };

  it("baseline validates a record freezeBaseline wrote", async () => {
    const store = await seeded();
    const baseline = await freezeBaseline(store, {
      baseline_id: "base", run_id: "run-b", lineage: "benchmark", frozen_at: AT,
    });
    expect(report(validators["baseline"], baseline)).toBe(true);
    // The configuration id is copied off the run rather than supplied, so a baseline cannot
    // name a configuration that never produced it.
    expect(baseline.configuration_id).toBe(CONFIG_ID);
  });

  it("rejects a baseline carrying 1.0.0's superseded_by", () => {
    /**
     * The field 2.0.0 removed. It could never be written: setting it means editing an
     * existing record, and the evidence plane has no update — its own description promised
     * baselines are "append-only; superseding is recorded, never overwritten" while being
     * the one field that required overwriting.
     */
    const legacy = {
      baseline_id: "base", configuration_id: CONFIG_ID, run_id: "run-b",
      frozen_at: AT, lineage: "benchmark", superseded_by: "base-0",
    };
    expect(validators["baseline"](legacy)).toBe(false);
  });

  it("promotion validates a record the gate produced", async () => {
    const store = await seeded();
    await freezeBaseline(store, { baseline_id: "base", run_id: "run-b", lineage: "benchmark", frozen_at: AT });
    const { promotion } = await promote(store, {
      promotion_id: "promo", run_id: "run-c", baseline_id: "base", comparison_id: "cmp",
      promoted_at: AT, promoted_by: "contract-conformance", suiteGranularity: 1 / 14,
    });
    expect(promotion).not.toBeNull();
    expect(report(validators["promotion"], promotion)).toBe(true);
    // Every one of the five is on the record, with a reason, in the affirmative direction.
    for (const c of Object.values(promotion!.conditions)) {
      expect(c.held).toBe(true);
      expect(typeof c.detail).toBe("string");
    }
  });

  it("rejects a promotion whose conditions omit one of the five", async () => {
    const store = await seeded();
    await freezeBaseline(store, { baseline_id: "base", run_id: "run-b", lineage: "benchmark", frozen_at: AT });
    const { promotion } = await promote(store, {
      promotion_id: "promo", run_id: "run-c", baseline_id: "base", comparison_id: "cmp",
      promoted_at: AT, promoted_by: "contract-conformance", suiteGranularity: 1 / 14,
    });
    const partial = JSON.parse(JSON.stringify(promotion)) as Record<string, Record<string, unknown>>;
    delete partial.conditions.detector_equalization;
    // A conjunction missing a term is not a weaker promotion, it is an unreadable one.
    expect(validators["promotion"](partial)).toBe(false);
  });

  it("rejects a condition recorded without a reason", async () => {
    const store = await seeded();
    await freezeBaseline(store, { baseline_id: "base", run_id: "run-b", lineage: "benchmark", frozen_at: AT });
    const { promotion } = await promote(store, {
      promotion_id: "promo", run_id: "run-c", baseline_id: "base", comparison_id: "cmp",
      promoted_at: AT, promoted_by: "contract-conformance", suiteGranularity: 1 / 14,
    });
    const bare = JSON.parse(JSON.stringify(promotion)) as Record<string, Record<string, Record<string, unknown>>>;
    bare.conditions.within_budget = { held: true };
    expect(validators["promotion"](bare)).toBe(false);
  });
});

/**
 * routing-policy, against values `validateRoutingPolicy` accepts and rejects.
 *
 * Both sides are checked, because the schema and the Core validator can disagree in either
 * direction and only one of them runs at contract time. `configuration.router_policy_ref`
 * was a bare nullable string with no description from 1.0.0 and `null` in every instance —
 * a field that existed and meant nothing. 1.3.0 gives it a meaning; this gives it a shape.
 */
describe("routing-policy, checked against the Core validator in both directions", () => {
  const cheap = { model_id: "small-1", family: "vendor-a", usd_per_mtok_in: 0.25, usd_per_mtok_out: 1.25 };
  const big = { model_id: "large-1", family: "vendor-b", usd_per_mtok_in: 15, usd_per_mtok_out: 75 };

  it("validates a cascade the Core validator also accepts", () => {
    const policy = {
      policy_id: "cascade-v1", method: "cascade", tiers: [cheap, big],
      escalate_on: ["gate-fail"], max_escalations: 1,
    };
    expect(report(validators["routing-policy"], policy)).toBe(true);
    expect(() => validateRoutingPolicy(policy as never)).not.toThrow();
  });

  it("validates a fixed policy with one tier, which Core also accepts", () => {
    const policy = { policy_id: "fixed-v1", method: "fixed", tiers: [cheap] };
    expect(report(validators["routing-policy"], policy)).toBe(true);
    expect(() => validateRoutingPolicy(policy as never)).not.toThrow();
  });

  it("rejects a cascade with one tier, on BOTH sides", () => {
    // The case that would otherwise report itself as a cascade whose escalations never fired.
    const policy = {
      policy_id: "bad", method: "cascade", tiers: [cheap],
      escalate_on: ["gate-fail"], max_escalations: 1,
    };
    expect(validators["routing-policy"](policy)).toBe(false);
    expect(() => validateRoutingPolicy(policy as never)).toThrow();
  });

  it("rejects a cascade with no termination rule, on BOTH sides", () => {
    const policy = { policy_id: "bad", method: "cascade", tiers: [cheap, big], escalate_on: ["gate-fail"] };
    expect(validators["routing-policy"](policy)).toBe(false);
    expect(() => validateRoutingPolicy(policy as never)).toThrow(/max_escalations/);
  });

  it("rejects a fixed policy carrying escalation settings, on BOTH sides", () => {
    // A probe found the `method === "fixed"` guard in reduceRouteOutcome was unreachable.
    // The answer was to refuse the configuration that would have needed it, in both the
    // schema and the Core validator, rather than to test dead code.
    const policy = {
      policy_id: "confused", method: "fixed", tiers: [cheap, big],
      escalate_on: ["gate-fail"], max_escalations: 1,
    };
    expect(validators["routing-policy"](policy)).toBe(false);
    expect(() => validateRoutingPolicy(policy as never)).toThrow(/can never use/);
  });

  it("requires a family on every tier", () => {
    // Without it, escalating into the judge's own family would silently create the
    // self-preference cycle `admitJudge` exists to refuse.
    const { family: _drop, ...noFamily } = cheap;
    expect(validators["routing-policy"]({ policy_id: "p", method: "fixed", tiers: [noFamily] })).toBe(false);
  });
});
