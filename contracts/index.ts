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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /**
     * Tokens served from the provider's prompt cache.
     *
     * The only way to tell a working cache from a silently invalidated one: if this is
     * zero across repeated identical prefixes, something in the prefix is varying — a
     * timestamp, a request id, an unsorted key. Estimating it would hide exactly the
     * failure it exists to expose.
     */
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  timings_ms?: { total?: number };
}

/**
 * Why a request did not yield usable output.
 *
 * The first eight all mean the same structural thing: **no response arrived**. A timeout, a
 * refused credential, a filtered request and a cancelled call differ in cause and in whether
 * retrying helps, but in every one of them the model produced nothing.
 *
 * `MALFORMED_RESPONSE` is the odd one, and it is the reason this union is documented rather
 * than merely listed. It means a response DID arrive and could not be used. Answering badly
 * is not the same as not answering, and collapsing the two would make the demo placeholder —
 * whose text is literally "No output was produced" — into a false statement. See ADR-0014.
 *
 * Adapters classify; the Application branches; Core maps the classified category to a
 * placeholder. Nothing downstream re-derives the distinction from a message.
 */
/**
 * The values, as an array the type is derived FROM rather than a union restated beside one.
 *
 * A union cannot be enumerated at runtime, so every exhaustive test over categories had to
 * hand-write the list — and `core/test/demo-mode.test.ts` did, in a sweep whose header claims
 * it covers "every generating stage against every failure category". That list had eight
 * entries when the ninth landed, so the sweep would have gone on reporting exhaustive
 * coverage of a set it no longer covered. A hand-picked list is a sparse matcher.
 *
 * `MALFORMED_RESPONSE` last, matching the schema's enum order; a conformance test asserts the
 * two agree, so TypeScript and JSON Schema cannot drift apart silently.
 */
export const FAILURE_CATEGORIES = [
  "TIMEOUT",
  "RATE_LIMIT",
  "AUTH",
  "UNAVAILABLE",
  "INVALID_REQUEST",
  "CONTENT_FILTER",
  "INTERNAL",
  "CANCELLED",
  /** A response arrived and could not be used. The only value here that means the model answered. */
  "MALFORMED_RESPONSE",
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/**
 * Did the provider actually answer?
 *
 * One predicate, so no call site has to remember which categories mean "nothing came back".
 * Adding a category forces a decision here rather than defaulting into the demo path, which
 * is where the wrong answer is invisible: a new category that silently reads as "no response"
 * would produce a placeholder saying nothing was produced about a run that produced something.
 */
export const providerAnswered = (category: FailureCategory): boolean =>
  category === "MALFORMED_RESPONSE";

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
  "provider-failure": "1.1.0",
  "pipeline-outcome": "1.0.0",
  "revision-entry": "2.0.0",
  "observability-event": "1.3.0",
  "eval-run": "2.0.0",
  comparison: "2.2.0",
  configuration: "1.3.0",
  "judge-verdict": "1.1.0",
} as const;

export interface ExecutionProvenance {
  core_build_hash: string;
  contract_versions: Record<string, string>;
  provider_model_fingerprint: string | null;
  config_fingerprint: string | null;
}

/* ── Revision / storage protocol ──────────────────────────────────────────── */

/** Where a record is retained, and therefore what the retention bound means for it. */
export type RetentionScope = "LOCAL_BUNDLE" | "DB" | "EXPORT";

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
  /**
   * Pointer to the retained stage-input content (grammar in the schema). Null means
   * "not retained here" — the honest state, never a silent drop. Resolving a ref is an
   * Application effect; Core receives refs as data and never reads through one.
   */
  input_ref: string | null;
  /** Pointer to the retained stage-output content — the replayable artifact. */
  output_ref: string | null;
  gate_results: GateResult[];
  /** Which gate-feedback round produced this. Absent or 0 is the first pass. */
  feedback_round?: number;
  freshness: Freshness;
  status: RevisionStatus;
  provider_used: string | null;
  execution_provenance: ExecutionProvenance;
  retention_scope: RetentionScope;
}

/* ── Content plane (artifact-reference lineage) ──────────────────────────── */

/**
 * What kind of retained content a ref names. The kind travels inside the ref string
 * (grammar in the revision-entry 1.4.0 schema descriptions) so a ref stays a plain
 * string that validates with one pattern and survives JSON round-trips without shape
 * negotiation.
 */
export type ContentKind = "stage-input" | "stage-output" | "generation-response";

/**
 * The retention half of the artifact-reference lineage design. Content is MATERIAL,
 * not events: the same bytes re-derived are the same material, so `put` is idempotent
 * by content address (unlike `EvidenceStore.put`, which refuses duplicate ids because
 * evidence records are events). Content is written once, addressed by its own hash,
 * and never edited — a corrected artifact is a new artifact.
 */
export interface ContentStore {
  readonly retention_scope: RetentionScope;
  /** Writes once under the content address; same bytes again is a no-op success. */
  put(ref: string, bytes: Uint8Array): Promise<void>;
  /** Resolves a ref to bytes, or null when gone. Null is "not here", not "never was". */
  get(ref: string): Promise<Uint8Array | null>;
  /** Existence without the read — the integrity gate's need, and the deletion sweep's. */
  has(ref: string): Promise<boolean>;
  /**
   * Reclaim every stored item NOT in `live`. Returns how many were removed.
   *
   * This is garbage collection, not deletion, and the distinction is what keeps the "written
   * once, never edited" invariant intact: an item named by a live ref is never touched, so no
   * reader can lose content out from under it. Passing the live set — rather than a ref to
   * remove — is what makes it sharing-safe BY CONSTRUCTION. Content is addressed by hash, so
   * one file can back many runs; a `delete(ref)` primitive would have no way to know whether
   * some other run still cites those bytes, and would either corrupt that run or leak.
   *
   * Added because bundle eviction reclaimed nothing. `storage-local` retains eight run bundles
   * and evicts the ninth, but content lives in its own directory: measured over twelve runs,
   * eight bundles survived and **20 of 60 content files were orphaned** — bounded in bundles,
   * unbounded in bytes, which is the number that fills a disk.
   *
   * An empty `live` set reclaims everything, and that is correct rather than a footgun: it is
   * what a caller that has just established there are no surviving runs is asking for.
   */
  sweep(live: ReadonlySet<string>): Promise<number>;
}

export interface RunBundleSummary {
  run_id: string;
  entries: number;
  first_timestamp: string;
  last_timestamp: string;
}

/**
 * A semantic run manifest: the whole run (revisions + the content refs it cites)
 * as ONE immutable, atomically published unit.
 *
 * Storage modes are exclusive per run id. A run is either a legacy append-only
 * `<run_id>.json` bundle or a `<run_id>.manifest.json` semantic manifest — never
 * both, and readers must never merge the two. Manifests carry metadata only:
 * content bodies stay in the ContentStore, addressed by `content_refs`.
 *
 * Published once, never mutated: there is no update path, by design. A corrected
 * run is a new run.
 */
export interface RunManifest {
  manifest_version: "1.0.0";
  run_id: string;
  created_at: string;
  committed_at: string;
  revisions: RevisionEntry[];
  content_refs: string[];
}

export interface RevisionStore {
  append(entry: RevisionEntry): Promise<void>;
  getRun(run_id: string): Promise<RevisionEntry[]>;
  listRecent(limit: number): Promise<RunBundleSummary[]>;
  /**
   * Mark a revision and everything computed from it STALE.
   *
   * Keyed on a REVISION, not a stage. A stage id cannot identify what to invalidate once a
   * reflexive run holds more than one revision per stage — the previous signature latched on
   * the first entry carrying that id and staled everything after it in append order, so a
   * re-executed stage re-armed the latch instead of being staled, and an entry became stale
   * because of where it sat rather than what it depended on.
   *
   * Inclusive: the named revision is stale too. It is being superseded, which is the reason
   * anyone is calling this.
   *
   * `freshness` and `status` stay independent. A staled revision keeps its SUCCEEDED status
   * and its gate results — the record of what happened is not the claim that it still holds.
   */
  markStale(run_id: string, from_revision_id: string): Promise<void>;
  /**
   * Publish a semantic run manifest atomically (optional capability).
   *
   * Implementations must: refuse a run that already has EITHER mode (immutability
   * and the one-mode-per-run rule), publish through a temporary file finalized with
   * an exclusive `link` — never `rename`, which silently replaces — and share the
   * per-root serialisation chain with `append` so publication, appends and eviction
   * never interleave. `append` on a run that already has a manifest must refuse with
   * `mixed-lineage`.
   */
  commitManifest?(manifest: RunManifest): Promise<void>;
}

/* ── Execution plane ──────────────────────────────────────────────────────── */

/**
 * A content-addressed cache for generations.
 *
 * Keys come from `core/src/eval/budget.ts`, which decides whether the trial index is part
 * of the key. That decision is not the adapter's: a cache that chose its own key policy
 * could make a stochastic protocol look deterministic, which is the failure the key rule
 * exists to prevent.
 */
export interface CacheStore {
  get(key: string): Promise<GenerationResult | null>;
  put(key: string, value: GenerationResult): Promise<void>;
}

/* ── Judge protocol ───────────────────────────────────────────────────────── */

export interface JudgeRequest {
  request_id: string;
  rubric_id: string;
  /** The rubric and judge-prompt template as sent, hashed. A silently edited rubric is otherwise indistinguishable from a model that changed its mind. */
  rubric_hash: string;
  /** The output being graded. Untrusted: it is the model's own text and may contain rubric-shaped instructions. */
  candidate: string;
  /** Candidate order, randomized by the caller. Position bias above 0.10 was measured in judges whose test-retest exceeded 0.95. */
  position_randomized: boolean;
  runs: number;
}

export interface JudgeVerdict {
  verdict: string | number | boolean;
  rationale: string | null;
  judge_id: string;
  judge_family: string;
  rubric_id: string;
  rubric_hash: string | null;
  runs: number;
  disagreement_rate: number;
  position_randomized: boolean;
  bias_panel?: {
    verbosity_delta?: number | null;
    format_delta?: number | null;
    self_preference_delta?: number | null;
    measured_at?: string | null;
  } | null;
  agreement?: {
    metric: "cohens-kappa" | "krippendorff-alpha" | "scotts-pi";
    value: number;
    threshold: number;
    measured_at: string;
    reference?: string;
    benchmark?: string;
  } | null;
}

/** The port. The judge is an effect, so it lives behind the Application like any provider. */
export interface JudgeTransport {
  readonly judge_id: string;
  readonly judge_family: string;
  grade(req: JudgeRequest): Promise<JudgeVerdict>;
}

/* ── Evidence plane ───────────────────────────────────────────────────────── */

/**
 * What the evidence plane holds.
 *
 * `EvalRun`, `Comparison` and `Baseline` had schemas and no home: runs were computed and
 * discarded. A plane that computes evidence and does not retain it cannot answer "is this
 * better than last month", which is the only question the system exists to answer.
 */
export type EvidenceKind = "eval-run" | "comparison" | "baseline" | "promotion";

export interface EvidenceRecord {
  kind: EvidenceKind;
  /** Unique within its kind. The store refuses a second write under the same pair. */
  id: string;
  created_at: string;
  /** The contract-validated body — an EvalRun, Comparison, Baseline or Promotion. */
  body: unknown;
}

export interface EvidenceSummary {
  kind: EvidenceKind;
  id: string;
  created_at: string;
}

export interface EvidenceFilter {
  /** ISO timestamp; records created strictly before it are excluded. */
  since?: string;
  limit?: number;
}

/**
 * Deliberately has no `update` and no `delete`.
 *
 * Immutability is expressed by the absence of a mutator rather than by a convention
 * someone has to honour. "A re-run is a new run; runs are never edited" is then a property
 * of the interface, and an adapter that wanted to violate it would have to add a method.
 *
 * This is the same reasoning that keeps `RevisionEntry` free of prompt bodies: a rule the
 * type system enforces cannot be forgotten under deadline, and comparison across time
 * requires that yesterday's number cannot be edited.
 */
export interface EvidenceStore {
  readonly retention_scope: RetentionScope;
  /** Rejects a duplicate `(kind, id)` rather than overwriting. */
  put(record: EvidenceRecord): Promise<void>;
  get(kind: EvidenceKind, id: string): Promise<EvidenceRecord | null>;
  list(kind: EvidenceKind, filter?: EvidenceFilter): Promise<EvidenceSummary[]>;
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
  | "STAGE_SKIPPED"
  /** A gate FAIL was routed back to an earlier stage as feedback, within the declared cap. */
  | "GATE_FEEDBACK"
  /** A revision was marked STALE. Nothing was written — see the changelog for why it is not REVISION_PERSISTED. */
  | "REVISION_SUPERSEDED";

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
  /**
   * What this configuration may spend, enforced BEFORE dispatch rather than reported after.
   * `on_exceed` has no default: both behaviours are defensible and the silent choice between
   * them is the failure mode. See `core/src/eval/budget.ts`.
   */
  budget?: {
    max_provider_calls?: number | null;
    max_usd?: number | null;
    on_exceed: "refuse" | "truncate_suite";
  } | null;
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
  /**
   * The independent unit this case belongs to.
   *
   * Written by the perturbation expander, never by a suite author: author-assigned
   * clustering would make every downstream confidence figure depend on how someone chose to
   * group cases, so two suites with identical cases could report different certainty.
   * Absent means the case is its own cluster, which is what an unperturbed case is.
   */
  cluster_id?: string;
}

/**
 * Which test may be applied to this suite's outcomes.
 *
 * `exact-mcnemar` assumes independent paired binary outcomes. `clustered-paired` does not,
 * and is required once perturbations group cases. Declaring it per suite discharges
 * ADR-0008's open item: record the protocol before running comparisons anyone will cite.
 */
export type SignificanceProtocol = "exact-mcnemar" | "clustered-paired" | "bootstrap-ci";

export interface EvalSuite {
  suite_id: string;
  version: string;
  /** smoke gates every change; anchor alone may certify a promotion; adversarial holds perturbations. */
  kind: "smoke" | "anchor" | "adversarial";
  case_ids: string[];
  /** What difference this suite can detect. A suite that declares none cannot evidence "no change". */
  resolution: { detectable_delta: number; confidence: number; sized_for?: number | null };
  /**
   * Declared before any comparison runs, per ADR-0008's open item. The comparator refuses
   * when this does not match the data's structure rather than reporting a caveated number.
   */
  significance_protocol: SignificanceProtocol;
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
  /**
   * The baseline this one replaces, written forward on the NEW record. 1.0.0 had a backward
   * `superseded_by` that could never be set: the evidence plane has no `update`, so marking
   * an old record would have required overwriting it — the thing its own description
   * promised never happens.
   */
  supersedes?: string | null;
}

/** What a promotion asserted, and why each term of the conjunction held. */
export interface PromotionCondition {
  held: boolean;
  /** Required in both directions: "why it was allowed" is as auditable as "why it was not". */
  detail: string;
}

/**
 * A configuration made current, or a previous one restored.
 *
 * Promotion is a label repoint rather than a rebuild, so rollback is the same record
 * travelling the other way and carries the evidence pointers of the promotion it reverses.
 * Every field but the timestamps is a pointer, because the failure this contract exists to
 * prevent is a capability claim with no run behind it.
 */
export interface Promotion {
  promotion_id: string;
  kind: "promote" | "rollback";
  configuration_id: string;
  eval_run_id: string;
  baseline_id: string;
  comparison_id: string;
  supersedes?: string | null;
  promoted_at: string;
  promoted_by: string;
  conditions: {
    significance: PromotionCondition;
    no_regression: PromotionCondition;
    within_budget: PromotionCondition;
    judge_calibration: PromotionCondition;
    detector_equalization: PromotionCondition;
  };
}

export interface Comparison {
  comparison_id: string;
  candidate_run_id: string;
  baseline_id: string;
  verdict: "improved" | "regressed" | "inconclusive" | "refused";
  refusal_reason?: string | null;
  delta: number | null;
  protocol: {
    test: "mcnemar" | "clustered-paired" | "paired-bootstrap" | "5x2cv-paired-t" | "none";
    /**
     * Independent units behind the p-value, which is NOT the case count once perturbations
     * group cases. A comparison that reported 70 rows and 14 questions as the same number
     * would be anticonservative in a way nothing downstream could detect.
     */
    effective_n?: number;
    trials: number;
    /** Alpha AFTER multiplicity correction. An optimizer generates comparisons by construction. */
    alpha: number;
    comparisons_in_family: number;
    correction?: "none" | "bonferroni" | "holm" | "benjamini-hochberg";
    p_value?: number | null;
    confidence_interval?: [number, number] | null;
    /**
     * Units the two runs disagreed on. This is the exact sample size of a paired binary
     * test — concordant units contribute nothing — so 3,400 cases with 4 disagreements is
     * a test with n=4.
     */
    discordant?: number;
    /**
     * The smallest p any arrangement of those discordant units could have produced,
     * `2 * 0.5^d`. A design property, not observed power: nothing here is computed from
     * the p-value, so it carries information the p-value does not.
     */
    min_attainable_p?: number | null;
    /** Whether `min_attainable_p` clears alpha. False means the test could not have rejected. */
    attainable?: boolean | null;
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
