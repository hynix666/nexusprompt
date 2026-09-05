import React from "react";
import type { GateResult } from "../types/index.js";
import { theme } from "../styles/theme.js";

export interface GateResultDisplayProps {
  result: GateResult;
  onRetry?: () => void;
}

export const GateResultDisplay: React.FC<GateResultDisplayProps> = ({ result, onRetry }) => {
  const statusColor = result.passed ? theme.colors.success[700] : theme.colors.error[700];
  const statusBg = result.passed ? theme.colors.success[50] : theme.colors.error[50];

  return (
    <div
      style={{
        border: `1px solid ${theme.colors.neutral[200]}`,
        borderRadius: theme.borderRadius.md,
        padding: theme.spacing[3],
        marginBottom: theme.spacing[2],
        backgroundColor: theme.colors.neutral[50],
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: theme.spacing[2],
        }}
      >
        <span
          style={{
            fontWeight: theme.typography.fontWeight.semibold,
            fontSize: theme.typography.fontSize.sm,
            fontFamily: theme.typography.fontFamily.mono,
          }}
        >
          {result.gate_id}
        </span>
        <span
          style={{
            fontSize: theme.typography.fontSize.xs,
            fontWeight: theme.typography.fontWeight.medium,
            color: statusColor,
            backgroundColor: statusBg,
            padding: `2px ${theme.spacing[2]}`,
            borderRadius: theme.borderRadius.full,
          }}
        >
          {result.passed ? "PASS" : "FAIL"}
        </span>
      </div>

      {!result.passed && result.issues && result.issues.length > 0 && (
        <ul
          style={{
            margin: 0,
            paddingLeft: theme.spacing[4],
            fontSize: theme.typography.fontSize.xs,
            color: theme.colors.neutral[700],
          }}
        >
          {result.issues.map((issue, i) => (
            <li key={i}>
              <span
                style={{
                  fontWeight: theme.typography.fontWeight.semibold,
                  color:
                    issue.severity === "error"
                      ? theme.colors.error[700]
                      : theme.colors.warning[700],
                  marginRight: theme.spacing[1],
                }}
              >
                {issue.severity}:
              </span>
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      {!result.passed && onRetry && (
        <button
          onClick={onRetry}
          style={{
            marginTop: theme.spacing[2],
            padding: `${theme.spacing[1]} ${theme.spacing[3]}`,
            backgroundColor: theme.colors.primary[600],
            color: theme.colors.white,
            border: "none",
            borderRadius: theme.borderRadius.md,
            fontSize: theme.typography.fontSize.xs,
            fontWeight: theme.typography.fontWeight.medium,
            cursor: "pointer",
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
};

export default GateResultDisplay;
