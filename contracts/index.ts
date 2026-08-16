/**
 * Contract types for the vertical slice.
 *
 * These are hand-written bindings around the JSON Schemas in this directory.
 * The schemas are the source of truth: the tests validate real values against
 * them, so a type that drifts from its schema is caught by a failing fixture
 * rather than by review.
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

export interface ExecutionProvenance {
  core_build_hash: string;
  contract_versions: Record<string, string>;
  provider_model_fingerprint: string | null;
  config_fingerprint: string | null;
}

/* ── Revision / storage protocol ──────────────────────────────────────────── */

export type RevisionStatus = "SUCCEEDED" | "DEMO" | "FAILED" | "CANCELLED";
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

/* ── Observability ────────────────────────────────────────────────────────── */

export type EventType =
  | "PIPELINE_COMMAND_RECEIVED"
  | "STAGE_DECISION"
  | "PROVIDER_CALL_STARTED"
  | "PROVIDER_CALL_SUCCEEDED"
  | "PROVIDER_CALL_FAILED"
  | "DEGRADE"
  | "REVISION_PERSISTED"
  | "HEALTH_CHECK";

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
