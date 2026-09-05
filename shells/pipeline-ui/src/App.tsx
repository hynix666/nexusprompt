import React from "react";
import { PipelineVisualization, usePipeline, theme } from "@nexusprompt/pipeline-presentation";

export const App: React.FC = () => {
  const { pipeline, reset } = usePipeline();

  return (
    <div
      style={{
        maxWidth: "1200px",
        margin: "0 auto",
        padding: theme.spacing[6],
        fontFamily: theme.typography.fontFamily.sans,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: theme.spacing[8],
          paddingBottom: theme.spacing[4],
          borderBottom: `1px solid ${theme.colors.neutral[200]}`,
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: theme.typography.fontSize["3xl"],
            fontWeight: theme.typography.fontWeight.bold,
            color: theme.colors.neutral[900],
          }}
        >
          NexusPrompt Pipeline
        </h1>
        <button
          onClick={reset}
          disabled={pipeline.is_running}
          style={{
            padding: `${theme.spacing[2]} ${theme.spacing[4]}`,
            backgroundColor: pipeline.is_running
              ? theme.colors.neutral[300]
              : theme.colors.primary[600],
            color: theme.colors.white,
            border: "none",
            borderRadius: theme.borderRadius.md,
            fontSize: theme.typography.fontSize.base,
            fontWeight: theme.typography.fontWeight.medium,
            cursor: pipeline.is_running ? "not-allowed" : "pointer",
          }}
        >
          Reset
        </button>
      </header>

      <main>
        <PipelineVisualization pipeline={pipeline} />
      </main>
    </div>
  );
};

export default App;
