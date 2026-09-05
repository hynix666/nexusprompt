import React from "react";
import type { PipelineDisplay } from "../types/index.js";
import { theme } from "../styles/theme.js";
import { StageCard } from "./StageCard.js";

export interface PipelineVisualizationProps {
  pipeline: PipelineDisplay;
}

export const PipelineVisualization: React.FC<PipelineVisualizationProps> = ({ pipeline }) => {
  if (pipeline.stages.length === 0) {
    return (
      <div
        style={{
          textAlign: "center",
          color: theme.colors.neutral[500],
          padding: theme.spacing[8],
          fontSize: theme.typography.fontSize.sm,
        }}
      >
        No stages to display. Run a pipeline to see results.
      </div>
    );
  }

  const runningIdx = pipeline.stages.findIndex((s) => s.status === "running");

  return (
    <div style={{ position: "relative" }}>
      {pipeline.stages.map((stage, i) => (
        <StageCard key={stage.stage_id} stage={stage} isCurrent={i === runningIdx} />
      ))}

      {pipeline.error && (
        <div
          style={{
            marginTop: theme.spacing[4],
            padding: theme.spacing[3],
            backgroundColor: theme.colors.error[50],
            border: `1px solid ${theme.colors.error[500]}`,
            borderRadius: theme.borderRadius.md,
            color: theme.colors.error[700],
            fontSize: theme.typography.fontSize.sm,
          }}
        >
          <strong>Error:</strong> {pipeline.error}
        </div>
      )}
    </div>
  );
};

export default PipelineVisualization;
