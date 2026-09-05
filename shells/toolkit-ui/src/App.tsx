import React, { useState } from "react";
import { PipelineVisualization, usePipeline, theme } from "@nexusprompt/pipeline-presentation";

type ActiveModule = "pipeline" | "gates" | "catalog";

export const App: React.FC = () => {
  const [activeModule, setActiveModule] = useState<ActiveModule>("pipeline");
  const { pipeline, reset } = usePipeline();

  const navItems: Array<{ id: ActiveModule; label: string }> = [
    { id: "pipeline", label: "Pipeline" },
    { id: "gates", label: "Gates" },
    { id: "catalog", label: "Catalog" },
  ];

  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        fontFamily: theme.typography.fontFamily.sans,
      }}
    >
      <nav
        style={{
          width: "240px",
          backgroundColor: theme.colors.neutral[900],
          padding: theme.spacing[4],
          display: "flex",
          flexDirection: "column",
          gap: theme.spacing[1],
        }}
      >
        <div
          style={{
            color: theme.colors.white,
            fontSize: theme.typography.fontSize.lg,
            fontWeight: theme.typography.fontWeight.bold,
            marginBottom: theme.spacing[6],
            padding: `${theme.spacing[2]} 0`,
          }}
        >
          NexusPrompt
        </div>

        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveModule(item.id)}
            style={{
              padding: `${theme.spacing[2]} ${theme.spacing[3]}`,
              backgroundColor:
                activeModule === item.id ? theme.colors.primary[600] : "transparent",
              color: activeModule === item.id ? theme.colors.white : theme.colors.neutral[400],
              border: "none",
              borderRadius: theme.borderRadius.md,
              textAlign: "left",
              fontSize: theme.typography.fontSize.sm,
              fontWeight: theme.typography.fontWeight.medium,
              cursor: "pointer",
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main style={{ flex: 1, padding: theme.spacing[6] }}>
        {activeModule === "pipeline" && (
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: theme.spacing[6],
              }}
            >
              <h1
                style={{
                  margin: 0,
                  fontSize: theme.typography.fontSize["2xl"],
                  fontWeight: theme.typography.fontWeight.bold,
                }}
              >
                Pipeline
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
                  fontSize: theme.typography.fontSize.sm,
                  cursor: pipeline.is_running ? "not-allowed" : "pointer",
                }}
              >
                Reset
              </button>
            </div>
            <PipelineVisualization pipeline={pipeline} />
          </div>
        )}

        {activeModule === "gates" && (
          <div>
            <h1
              style={{
                fontSize: theme.typography.fontSize["2xl"],
                fontWeight: theme.typography.fontWeight.bold,
                marginBottom: theme.spacing[6],
              }}
            >
              Gates
            </h1>
            <p style={{ color: theme.colors.neutral[500] }}>
              Gate inspection is available via the CLI: <code>nexusprompt gates</code>
            </p>
          </div>
        )}

        {activeModule === "catalog" && (
          <div>
            <h1
              style={{
                fontSize: theme.typography.fontSize["2xl"],
                fontWeight: theme.typography.fontWeight.bold,
                marginBottom: theme.spacing[6],
              }}
            >
              Technique Catalog
            </h1>
            <p style={{ color: theme.colors.neutral[500] }}>
              The 195-record technique catalog is available via the CLI.
            </p>
          </div>
        )}
      </main>
    </div>
  );
};

export default App;
