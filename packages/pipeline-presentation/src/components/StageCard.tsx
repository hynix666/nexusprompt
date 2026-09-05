import React from "react";
import type { StageDisplay } from "../types/index.js";
import { theme } from "../styles/theme.js";
import { GateResultDisplay } from "./GateResultDisplay.js";

export interface StageCardProps {
  stage: StageDisplay;
  isCurrent?: boolean;
}

const STATUS_COLORS: Record<StageDisplay["status"], string> = {
  pending: theme.colors.neutral[400],
  running: theme.colors.primary[500],
  complete: theme.colors.success[500],
  failed: theme.colors.error[500],
  demo: theme.colors.warning[500],
};

const STATUS_LABELS: Record<StageDisplay["status"], string> = {
  pending: "Pending",
  running: "Running…",
  complete: "Complete",
  failed: "Failed",
  demo: "Demo",
};

export const StageCard: React.FC<StageCardProps> = ({ stage, isCurrent }) => {
  const dotColor = STATUS_COLORS[stage.status];
  const borderColor = isCurrent ? theme.colors.primary[500] : theme.colors.neutral[200];

  return (
    <div
      style={{
        border: `1px solid ${borderColor}`,
        borderLeft: `3px solid ${dotColor}`,
        borderRadius: theme.borderRadius.md,
        padding: theme.spacing[4],
        marginBottom: theme.spacing[3],
        backgroundColor: theme.colors.white,
        boxShadow: isCurrent ? theme.shadows.md : theme.shadows.sm,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: stage.gate_results.length > 0 ? theme.spacing[3] : 0,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: theme.typography.fontSize.base,
            fontWeight: theme.typography.fontWeight.semibold,
            fontFamily: theme.typography.fontFamily.mono,
          }}
        >
          {stage.label || stage.stage_id}
        </h3>
        <div style={{ display: "flex", alignItems: "center", gap: theme.spacing[2] }}>
          {stage.duration_ms !== undefined && (
            <span
              style={{
                fontSize: theme.typography.fontSize.xs,
                color: theme.colors.neutral[500],
              }}
            >
              {stage.duration_ms}ms
            </span>
          )}
          <span
            style={{
              fontSize: theme.typography.fontSize.xs,
              fontWeight: theme.typography.fontWeight.medium,
              color: dotColor,
            }}
          >
            {STATUS_LABELS[stage.status]}
          </span>
        </div>
      </div>

      {stage.gate_results.map((result, i) => (
        <GateResultDisplay key={i} result={result} />
      ))}
    </div>
  );
};

export default StageCard;
