import type { GateResult, RevisionEntry, StageId } from "../../../../contracts/index.js";

export type { GateResult, RevisionEntry, StageId };

export interface StageDisplay {
  stage_id: StageId;
  label: string;
  status: "pending" | "running" | "complete" | "failed" | "demo";
  gate_results: GateResult[];
  duration_ms?: number;
}

export interface PipelineDisplay {
  run_id: string;
  stages: StageDisplay[];
  is_running: boolean;
  is_complete: boolean;
  error?: string;
}
