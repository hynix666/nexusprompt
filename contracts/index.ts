/**
 * Contract types for the vertical slice.
 *
 * These are hand-written bindings around the JSON Schemas in this directory. The
 * schemas are the source of truth, and `test/contract-conformance.test.ts` validates
 * a value the running system produced against every one of them — plus a deliberately
 * broken value that must be rejected, because a validator that cannot fail proves
 * nothing.
 *
 * That file also asserts that the set of `*.schema.json` files on disk equals the set
 * it covers, so a new schema cannot arrive without a conformance case.
 *
 * This comment used to claim all of that while three of the five schemas were loaded
 * by no test at all. The claim is now the thing the suite checks.
 */

/* ── Core values ──────────────────────────────────────────────────────────── */

export type Verdict = "PASS" | "FAIL" | "WARN";

export interface GateResult {
  gate_id: string;
  gate_version: string;
  verdict: Verdict;
  message: string;
  message_code: string;
  input_hash: string;
  location: { start: number; end: number } | null;
}

/* ── Provider protocol ────────────────────────────────────────────────────── */

export interface GenerationRequest {
  request_id: string;
  run_id: string;
  /**
   * The system prompt, separate from the turns.
   *
   * Added 2026-08-18 because it was missing and the omission was silent. The frozen
   * pipeline sends a shared compiler identity with EVERY non-preview stage call —
   * anti-override, out-of-scope refusal, fact-grounding, placeholder completeness — and
   * six ported stages were sending their stage instruction with none of it. Nothing
   * failed: the request was well-formed, the gates still ran, and the missing half of
   * the prompt was invisible because no contract had a place to put it.
   *
   * A separate field rather than a `system` role in `messages`, matching both the source's
   * `callProvider(..., system, ...)` signature and the provider APIs, where system is a
   * top-level parameter and not a turn.
   */
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  model_policy: { preferred_models: string[]; allow_fallback: boolean };
  generation_options?: { max_tokens?: number; effort?: string };
  idempotency_key?: string | null;
}

export interface GenerationResult {
  request_id: string;
  content: string;
  provider_id: string;
  model_id: string;
  finish_reason: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  timings_ms?: { total?: number };
}

export type FailureCategory =
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "AUTH"
  | "UNAVAILABLE"
  | "INVALID_REQUEST"
  | "CONTENT_FILTER"
  | "INTERNAL"
  | "CANCELLED";

export interface ProviderFailure {
  request_id: string;
  category: FailureCategory;
  retriable: boolean;
  reason_code: string;
  safe_message: string;
  retry_after_ms: number | null;
  attempt: number;
  provider_id: string;
}

export interface ProviderHealth {
  ok: boolean;
  checked_at: string;
  latency_ms: number;
  degradation_state: "NONE" | "DEGRADED" | "UNAVAILABLE";
  failing_dependency: string | null;
}

/** The port. Adapters implement this; nothing else in the system may call out. */
export interface ProviderTransport {
  readonly provider_id: string;
  generate(req: GenerationRequest): Promise<GenerationResult | ProviderFailure>;
  healthCheck(): Promise<ProviderHealth>;
}

/** Narrowing helper — the Application branches on this, Core never sees the union. */
export function isFailure(
  outcome: GenerationResult | ProviderFailure,
): outcome is ProviderFailure {
  return "category" in outcome;
}

/* ── Pipeline protocol ────────────────────────────────────────────────────── */

export const STAGE_IDS = [
  "deconstruct",
  "calibrate",
  "compile",
  "harden",
  "critique",
  "refine",
  "lint",
  "critic",
  "preview",
  "cost_estimate",
  "tone_check",
] as const;

export type StageId = (typeof STAGE_IDS)[number];

export interface PipelineCommand {
  command_id: string;
  run_id: string;
  stage_id: StageId;
  input: { brief: string; previous?: string };
  context?: Record<string, unknown>;
  config_fingerprint?: string | null;
}

export interface PipelineOutcome {
  command_id: string;
  run_id: string;
  stage_id: StageId;
  output: { text: string };
  gate_results: GateResult[];
  demo_mode: boolean;
  revision_id: string;
  execution_provenance: ExecutionProvenance;
}

/**
 * The contract versions a run was executed against.
 *
 * One table, exported from the contracts themselves. It was duplicated in
 * `application/src/orchestrator.ts` and `application/src/pipeline.ts`, so the
 * `observability-event` bump to 1.1.0 had to be made in both — precisely the drift class
 * `invoke.ts` was extracted to prevent, reappearing two files away. `schema_version` on an
 * emitted event reads from here too, rather than being a third hardcoded literal.
 */
export const CONTRACT_VERSIONS = {
  "gate-result": "1.3.0",
  "provider-failure": "1.0.0",
  "pipeline-outcome": "1.0.0",
  "revision-entry": "1.2.0",
  "observability-event": "1.1.0",
  "eval-run": "1.1.0",
  comparison: "2.0.0",
} as const;

export interface ExecutionProvenance {
  core_build_hash: string;
  contract_versions: Record<string, string>;
  provider_model_fingerprint: string | null;
  config_fingerprint: string | null;
}

/* ── Revision / storage protocol ──────────────────────────────────────────── */

/** SKIPPED: deliberately not run. Without it a bundle cannot tell a skip from a truncated run. */
export type RevisionStatus = "SUCCEEDED" | "DEMO" | "FAILED" | "CANCELLED" | "SKIPPED";
export type Freshness = "FRESH" | "STALE";

export interface RevisionEntry {
  revision_id: string;
  run_id: string;
  stage_id: StageId;
  parent_revision_ids: string[];
  timestamp: string;
  stage_attempt: number;
  input_hash: string;
  output_hash: string;
  gate_results: GateResult[];
  freshness: Freshness;
  status: RevisionStatus;
  provider_used: string | null;
  execution_provenance: ExecutionProvenance;
  retention_scope: "LOCAL_BUNDLE" | "DB" | "EXPORT";
}

export interface RunBundleSummary {
  run_id: string;
  entries: number;
  first_timestamp: string;
  last_timestamp: string;
}

export interface RevisionStore {
  append(entry: RevisionEntry): Promise<void>;
  getRun(run_id: string): Promise<RevisionEntry[]>;
  listRecent(limit: number): Promise<RunBundleSummary[]>;
  markStale(run_id: string, from_stage_id: StageId): Promise<void>;
}

/* ── Technique catalog ────────────────────────────────────────────────────── */

/**
 * Shape derived from the 172 frozen records, not from prior documentation — which
 * described a different one. `arxiv_id` and `url` are nullable because thirteen
 * records cite a venue, a technical report, or a practitioner guide.
 */
export interface TechniqueSource {
  authors: string;
  year: number;
  title: string;
  venue: string;
  arxiv_id: string | null;
  url: string | null;
}

export type TechniqueCategory =
  | "reasoning-elicitation"
  | "self-verification-refinement"
  | "agentic-tool-use"
  | "automatic-prompt-optimization"
  | "retrieval-augmentation"
  | "structured-constrained-output"
  | "example-selection-formatting"
  | "template-pattern-scaffolding"
  | "prompt-injection-defense"
  | "domain-specific-application"
  | "prompt-inversion-analysis"
  | "prompt-compression-context-engineering";

/** How a claim about a technique could be checked. Deterministic gates gate; judged gates advise. */
export type VerificationStatus = "verifier-checkable" | "judge-checkable" | "unverifiable-by-text";

export type CostProfile =
  | "single-call"
  | "multi-call-fixed"
  | "multi-call-adaptive"
  | "agentic-loop"
  | "training-time";

export interface TechniqueRecord {
  id: string;
  name: string;
  category: TechniqueCategory;
  subcategory: string;
  executive_summary: string;
  description: string;
  verification_status: VerificationStatus;
  cost_profile: CostProfile;
  status: "corpus-present" | "verified-external" | "practitioner-guide";
  when_to_use: string[];
  when_not_to_use: string[];
  known_pitfalls: string[];
  related_techniques: string[];
  primary_source: TechniqueSource;
  secondary_sources: TechniqueSource[];
  usage_templates: Array<Record<string, unknown>>;
  tags: string[];
  aliases: string[];
  corpus_file: string | null;
  schema_version: string;
  source_audit: { description: string; pitfalls: string };
}

/* ── Observability ────────────────────────────────────────────────────────── */

export type EventType =
  | "PIPELINE_COMMAND_RECEIVED"
  | "STAGE_DECISION"
  | "PROVIDER_CALL_STARTED"
  | "PROVIDER_CALL_SUCCEEDED"
  | "PROVIDER_CALL_FAILED"
  | "DEGRADE"
  | "REVISION_PERSISTED"
  | "HEALTH_CHECK"
  /** A stage did not run, deliberately. Distinct from DEGRADE: nothing failed. */
  | "STAGE_SKIPPED";

export interface ObservabilityEvent {
  event_id: string;
  event_type: EventType;
  run_id: string;
  parent_event_id: string | null;
  timestamp: string;
  layer: "shell" | "application" | "core" | "adapter";
  component: string;
  duration_ms: number | null;
  attempt: number | null;
  input_hash: string | null;
  output_hash: string | null;
  provider_id: string | null;
  model_id: string | null;
  failure_code: string | null;
  verdict: string | null;
  schema_version: string;
}

/** The sink port. Non-blocking by contract; the Application owns the instance. */
export interface EventSink {
  emit(event: ObservabilityEvent): void;
}

/* ── Evaluation plane ─────────────────────────────────────────────────────── */

/**
 * The versioned artifact. A prompt alone is not a unit of version or comparison:
 * its effectiveness inverts across model generations, and pipeline shape inverts
 * across throughput. `configuration_id` is the content hash of everything else,
 * and doubles as the cache key — a key over less than the full configuration
 * returns confidently wrong results.
 */
export interface Configuration {
  configuration_id: string;
  prompt_template_ref: string;
  model_id: string;
  decoding: {
    temperature: number | null;
    top_p?: number | null;
    top_k?: number | null;
    seed: number | null;
    max_tokens?: number | null;
  };
  topology: {
    kind: "sequential" | "parallel-merge" | "hierarchical" | "reflexive";
    stages: string[];
    max_iterations?: number | null;
  };
  retrieval_config?: Record<string, unknown> | null;
  tool_config?: Record<string, unknown> | null;
  gate_set_ref?: string | null;
  router_policy_ref?: string | null;
}

/** The fifteen system-level failure modes. Every case names the one it exists to catch. */
export type FailureMode =
  | "hallucination" | "logical-inconsistency" | "planning-collapse" | "overconfidence"
  | "constraint-violation" | "ambiguous-input" | "prompt-injection" | "context-truncation"
  | "domain-mismatch" | "conflicting-instructions" | "tool-invocation-error"
  | "tool-runtime-failure" | "agent-communication-breakdown" | "business-rule-misalignment"
  | "cost-driven-degradation";

export interface EvalCase {
  case_id: string;
  input: { brief: string; previous?: string };
  expectation: { kind: "exact" | "contains" | "schema" | "predicate" | "reference" | "none"; value?: unknown };
  failure_mode: FailureMode;
  detector_ids: string[];
  perturbation?: { of_case_id: string; kind: string; seed: number } | null;
}

export interface EvalSuite {
  suite_id: string;
  version: string;
  /** smoke gates every change; anchor alone may certify a promotion; adversarial holds perturbations. */
  kind: "smoke" | "anchor" | "adversarial";
  case_ids: string[];
  /** What difference this suite can detect. A suite that declares none cannot evidence "no change". */
  resolution: { detectable_delta: number; confidence: number; sized_for?: number | null };
  derived_from?: string | null;
}

export interface Score {
  case_id: string;
  detector_id: string;
  passed: boolean;
  detail: string;
}

/** One detector's measured recall under one configuration. */
export interface DetectorRecall {
  detector_id: string;
  /** Outcomes where the detector was silent pre-mutation. Zero means it fires on everything. */
  substrates: number;
  probes_run: number;
  probes_detected: number;
  /** detected/run, or null when probes_run is 0. Null is not measurable; 0 is measured and dead. */
  recall: number | null;
}

export interface DetectorRecallBlock {
  probe_corpus_version: string;
  detectors: DetectorRecall[];
}

export interface EvalRun {
  run_id: string;
  configuration_id: string;
  suite_id: string;
  suite_version: string;
  aggregate: {
    cases: number;
    passed: number;
    score: number;
    by_failure_mode?: Record<string, { cases: number; passed: number }>;
  };
  cost: {
    tokens_in: number;
    tokens_out: number;
    provider_calls: number;
    cache_hits?: number;
    usd?: number | null;
    budget_exceeded: boolean;
  };
  latency_ms?: Record<string, number> | null;
  /**
   * Recall measured against mutation probes on this run's own outcomes. Null means it
   * was not measured — never that it was adequate, and never comparable.
   */
  detector_recall?: DetectorRecallBlock | null;
  grader_health?: { max_disagreement_rate: number; judged_cases: number } | null;
  scorer_provenance?: { scorer_ids: string[]; selected_using: string | null } | null;
  provenance: Record<string, unknown>;
}

export interface Baseline {
  baseline_id: string;
  configuration_id: string;
  run_id: string;
  frozen_at: string;
  lineage: "benchmark" | "development";
  superseded_by?: string | null;
}

export interface Comparison {
  comparison_id: string;
  candidate_run_id: string;
  baseline_id: string;
  verdict: "improved" | "regressed" | "inconclusive" | "refused";
  refusal_reason?: string | null;
  delta: number | null;
  protocol: {
    test: "mcnemar" | "paired-bootstrap" | "5x2cv-paired-t" | "none";
    trials: number;
    /** Alpha AFTER multiplicity correction. An optimizer generates comparisons by construction. */
    alpha: number;
    comparisons_in_family: number;
    correction?: "none" | "bonferroni" | "holm" | "benjamini-hochberg";
    p_value?: number | null;
    confidence_interval?: [number, number] | null;
  };
  /**
   * Derived from both runs' measured recall, never supplied. Replaced a boolean in 1.0.0
   * that nothing computed — the guard the comparator advertised was a field callers filled in.
   */
  equalization: {
    equalized: boolean;
    /** Null when recall was missing or unmeasurable — a refusal, not a value. */
    max_gap: number | null;
    /** = suite.resolution.detectable_delta. Derived, so it tightens as a suite grows. */
    gap_bound: number;
    /** Minimum across detectors over BOTH runs — the blunter instrument sets the resolution. */
    effective_recall: number | null;
    /** detectable_delta / effective_recall. Equals detectable_delta when recall is 1. */
    adjusted_resolution: number | null;
    per_detector: Array<{
      detector_id: string;
      candidate_recall: number | null;
      baseline_recall: number | null;
      gap: number | null;
    }>;
  };
}
