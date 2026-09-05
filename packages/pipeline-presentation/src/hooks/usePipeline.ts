import { useState, useCallback } from "react";
import type { PipelineDisplay, StageDisplay } from "../types/index.js";
import type { StageId } from "../../../../contracts/index.js";

export interface UsePipelineOptions {
  onComplete?: (pipeline: PipelineDisplay) => void;
  onError?: (error: Error) => void;
}

export interface UsePipelineResult {
  pipeline: PipelineDisplay;
  start: (runId: string, stageIds: StageId[]) => void;
  advanceStage: (stageId: StageId, update: Partial<StageDisplay>) => void;
  complete: (runId: string) => void;
  fail: (error: string) => void;
  reset: () => void;
}

function emptyPipeline(): PipelineDisplay {
  return { run_id: "", stages: [], is_running: false, is_complete: false };
}

export function usePipeline(opts: UsePipelineOptions = {}): UsePipelineResult {
  const [pipeline, setPipeline] = useState<PipelineDisplay>(emptyPipeline);

  const start = useCallback((runId: string, stageIds: StageId[]) => {
    const stages: StageDisplay[] = stageIds.map((id) => ({
      stage_id: id,
      label: id.replace(/_/g, " "),
      status: "pending" as const,
      gate_results: [],
    }));
    setPipeline({ run_id: runId, stages, is_running: true, is_complete: false });
  }, []);

  const advanceStage = useCallback((stageId: StageId, update: Partial<StageDisplay>) => {
    setPipeline((prev) => ({
      ...prev,
      stages: prev.stages.map((s) =>
        s.stage_id === stageId ? { ...s, ...update } : s,
      ),
    }));
  }, []);

  const complete = useCallback(
    (runId: string) => {
      setPipeline((prev) => {
        const next = { ...prev, run_id: runId, is_running: false, is_complete: true };
        opts.onComplete?.(next);
        return next;
      });
    },
    [opts],
  );

  const fail = useCallback(
    (error: string) => {
      setPipeline((prev) => {
        const next = { ...prev, is_running: false, is_complete: true, error };
        opts.onError?.(new Error(error));
        return next;
      });
    },
    [opts],
  );

  const reset = useCallback(() => {
    setPipeline(emptyPipeline());
  }, []);

  return { pipeline, start, advanceStage, complete, fail, reset };
}

export default usePipeline;
