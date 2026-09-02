# Shell Development Guide

> **Status**: Active - September 2026  
> **Version**: 1.0.0  
> **Purpose**: Comprehensive guide for developing NexusPrompt shells  
> **Phase**: Phase 2 (Weeks 15-18)  
> **Related**: [IMPROVEMENT_2026_REVISED.md](./IMPROVEMENT_2026_REVISED.md)

---

## 📊 Overview

This guide provides a comprehensive approach to developing **shells** for NexusPrompt. Shells are the **user-facing interfaces** that provide different ways to interact with the NexusPrompt system.

**Key Principles:**
1. **Separation of Concerns**: Shells handle presentation, not business logic
2. **Shared Presentation**: Common UI components and patterns in `shells/shared/`
3. **Contract-First**: Shells consume contracts, don't depend on implementation
4. **Consistency**: All shells should provide similar functionality
5. **Accessibility**: Shells should be accessible and usable

---

## 🏗️ Architecture

### Shell Layers

```
┌─────────────────────────────────────────────────────────────┐
│                         User Interface                           │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │   CLI Shell   │  │   API Shell   │  │  UI Shells    │         │
│  │               │  │               │  │               │         │
│  │  shells/cli/  │  │  shells/api/  │  │  shells/      │         │
│  └──────────────┘  └──────────────┘  │    pipeline-ui/│         │
│                                          │    toolkit-ui/│         │
│                                          └──────────────┘         │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ uses
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Shared Presentation                         │
├─────────────────────────────────────────────────────────────┤
│  shells/shared/                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  Components   │  │    Hooks      │  │   Utilities    │         │
│  │               │  │               │  │               │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │ uses
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         Application                             │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                      Orchestrator                          │  │
│  └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Shell Types

| Type | Location | Purpose | Technology |
|------|----------|---------|------------|
| CLI | `shells/cli/` | Command-line interface | Node.js, Commander/oclif |
| API | `shells/api/` | REST API | Fastify |
| Pipeline UI | `shells/pipeline-ui/` | Web interface for pipelines | React, TypeScript, Vite |
| Toolkit UI | `shells/toolkit-ui/` | Web interface for toolkit | React, TypeScript, Vite |

### Current State

| Shell | Status | Notes |
|-------|--------|-------|
| CLI | ✅ Built | Command-line interface |
| API | ✅ Built | REST API (Fastify-based) |
| Pipeline UI | ❌ Not built | Target for Phase 2 |
| Toolkit UI | ❌ Not built | Target for Phase 2 |

---

## 📐 Shared Presentation Package

### Purpose

The `shells/shared/` package contains:
- Common UI components
- Shared hooks and utilities
- Design system (colors, typography, spacing)
- Type definitions
- Build configuration

### Directory Structure

```
shells/shared/
├── src/
│   ├── components/
│   │   ├── GateResultDisplay.tsx      # Display gate results
│   │   ├── PipelineVisualization.tsx  # Visualize pipeline
│   │   ├── StageCard.tsx              # Display stage information
│   │   ├── Button.tsx                  # Common button styles
│   │   ├── Input.tsx                   # Common input styles
│   │   ├── Modal.tsx                   # Modal dialog
│   │   ├── Card.tsx                    # Card container
│   │   └── index.ts                    # Component exports
│   ├── hooks/
│   │   ├── usePipeline.ts              # Pipeline state management
│   │   ├── useGates.ts                 # Gate state management
│   │   ├── useLocalStorage.ts         # Local storage hook
│   │   ├── useDebounce.ts              # Debounce hook
│   │   └── index.ts                    # Hook exports
│   ├── utils/
│   │   ├── formatting.ts               # Formatting utilities
│   │   ├── validation.ts               # Validation utilities
│   │   ├── api.ts                      # API client utilities
│   │   └── index.ts                    # Utility exports
│   ├── styles/
│   │   ├── theme.ts                    # Design tokens
│   │   ├── globals.css                 # Global styles
│   │   └── index.ts                    # Style exports
│   └── types/
│       ├── index.ts                    # Shared type definitions
│       └── api.ts                      # API types
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

### Design System

```typescript
// shells/shared/src/styles/theme.ts

export const theme = {
  colors: {
    primary: {
      50: '#eff6ff',
      100: '#dbeafe',
      500: '#3b82f6',
      600: '#2563eb',
      700: '#1d4ed8',
    },
    success: {
      50: '#f0fdf4',
      500: '#22c55e',
      700: '#15803d',
    },
    warning: {
      50: '#fffbeb',
      500: '#f59e0b',
      700: '#b45309',
    },
    error: {
      50: '#fef2f2',
      500: '#ef4444',
      700: '#b91c1c',
    },
    neutral: {
      50: '#fafafa',
      100: '#f5f5f5',
      200: '#e5e5e5',
      300: '#d4d4d4',
      400: '#a3a3a3',
      500: '#737373',
      600: '#525252',
      700: '#404040',
      800: '#262626',
      900: '#171717',
    },
    white: '#ffffff',
    black: '#000000',
  },
  typography: {
    fontFamily: {
      sans: 'Inter, system-ui, -apple-system, sans-serif',
      mono: 'JetBrains Mono, Monaco, monospace',
    },
    fontSize: {
      xs: '0.75rem',
      sm: '0.875rem',
      base: '1rem',
      lg: '1.125rem',
      xl: '1.25rem',
      '2xl': '1.5rem',
      '3xl': '1.875rem',
    },
    fontWeight: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
    lineHeight: {
      tight: 1.25,
      normal: 1.5,
      relaxed: 1.75,
    },
  },
  spacing: {
    0: '0',
    1: '0.25rem',
    2: '0.5rem',
    3: '0.75rem',
    4: '1rem',
    6: '1.5rem',
    8: '2rem',
    12: '3rem',
    16: '4rem',
    24: '6rem',
  },
  borderRadius: {
    none: '0',
    sm: '0.125rem',
    md: '0.25rem',
    lg: '0.5rem',
    full: '9999px',
  },
  shadows: {
    sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
    md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  },
} as const;

export type Theme = typeof theme;
```

### Common Components

```tsx
// shells/shared/src/components/GateResultDisplay.tsx

import React from 'react';
import type { GateResult } from '@nexusprompt/contracts';
import { theme } from '../styles/theme';

export interface GateResultDisplayProps {
  result: GateResult;
  onRetry?: () => void;
}

export const GateResultDisplay: React.FC<GateResultDisplayProps> = ({
  result,
  onRetry,
}) => {
  const getStatusColor = (passed: boolean) => {
    return passed ? theme.colors.success[500] : theme.colors.error[500];
  };

  const getStatusIcon = (passed: boolean) => {
    return passed ? '✓' : '✗';
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.gateId}>{result.gate_id}</span>
        <span style={{ ...styles.status, color: getStatusColor(result.passed) }}>
          {getStatusIcon(result.passed)} {result.passed ? 'Passed' : 'Failed'}
        </span>
      </div>
      
      <div style={styles.details}>
        {result.issues && result.issues.length > 0 && (
          <div style={styles.issues}>
            <h4 style={styles.issuesTitle}>Issues:</h4>
            <ul style={styles.issuesList}>
              {result.issues.map((issue, index) => (
                <li key={index} style={styles.issueItem}>
                  <span style={styles.issueSeverity(issue.severity)}>
                    {issue.severity}:
                  </span>
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        
        {result.passed && result.metrics && (
          <div style={styles.metrics}>
            <h4 style={styles.metricsTitle}>Metrics:</h4>
            <pre style={styles.metricsContent}>{JSON.stringify(result.metrics, null, 2)}</pre>
          </div>
        )}
      </div>
      
      {!result.passed && onRetry && (
        <button style={styles.retryButton} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
};

const styles = {
  container: {
    border: `1px solid ${theme.colors.neutral[200]}`,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[4],
    marginBottom: theme.spacing[4],
    backgroundColor: theme.colors.neutral[50],
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing[3],
  },
  gateId: {
    fontWeight: theme.typography.fontWeight.semibold,
    fontSize: theme.typography.fontSize.lg,
    color: theme.colors.neutral[800],
  },
  status: {
    fontWeight: theme.typography.fontWeight.medium,
    fontSize: theme.typography.fontSize.base,
    padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.neutral[100],
  },
  details: {
    marginTop: theme.spacing[3],
  },
  issues: {
    marginBottom: theme.spacing[3],
  },
  issuesTitle: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.neutral[600],
    marginBottom: theme.spacing[2],
  },
  issuesList: {
    margin: 0,
    paddingLeft: theme.spacing[4],
  },
  issueItem: {
    marginBottom: theme.spacing[1],
    fontSize: theme.typography.fontSize.sm,
  },
  issueSeverity: (severity: string) => ({
    fontWeight: theme.typography.fontWeight.semibold,
    color:
      severity === 'error' ? theme.colors.error[600] :
      severity === 'warning' ? theme.colors.warning[600] :
      theme.colors.neutral[600],
    marginRight: theme.spacing[2],
  }),
  metrics: {
    marginTop: theme.spacing[2],
  },
  metricsTitle: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.neutral[600],
    marginBottom: theme.spacing[2],
  },
  metricsContent: {
    fontSize: theme.typography.fontSize.xs,
    backgroundColor: theme.colors.neutral[100],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
    overflowX: 'auto',
  },
  retryButton: {
    marginTop: theme.spacing[3],
    padding: `${theme.spacing[2]} ${theme.spacing[4]}`,
    backgroundColor: theme.colors.primary[600],
    color: theme.colors.white,
    border: 'none',
    borderRadius: theme.borderRadius.md,
    fontSize: theme.typography.fontSize.base,
    fontWeight: theme.typography.fontWeight.medium,
    cursor: 'pointer',
  },
};

export default GateResultDisplay;
```

### Common Hooks

```typescript
// shells/shared/src/hooks/usePipeline.ts

import { useState, useCallback, useEffect } from 'react';
import type { Pipeline, Stage, Command } from '@nexusprompt/contracts';
import { useApi } from './useApi';

export interface UsePipelineOptions {
  initialPipeline?: Pipeline;
  onChange?: (pipeline: Pipeline) => void;
  onError?: (error: Error) => void;
}

export interface UsePipelineResult {
  pipeline: Pipeline;
  stages: Stage[];
  currentStage: Stage | null;
  isRunning: boolean;
  isComplete: boolean;
  error: Error | null;
  run: (command: Command) => Promise<void>;
  reset: () => void;
  setPipeline: (pipeline: Pipeline) => void;
}

export function usePipeline(options: UsePipelineOptions = {}): UsePipelineResult {
  const { initialPipeline = { stages: [] }, onChange, onError } = options;
  
  const [pipeline, setPipeline] = useState<Pipeline>(initialPipeline);
  const [currentStageIndex, setCurrentStageIndex] = useState<number>(-1);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  
  const api = useApi();
  
  const run = useCallback(async (command: Command) => {
    setIsRunning(true);
    setError(null);
    setCurrentStageIndex(0);
    
    try {
      // This would call the actual pipeline execution
      // For now, just simulate
      for (let i = 0; i < pipeline.stages.length; i++) {
        setCurrentStageIndex(i);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      setIsRunning(false);
    } catch (err) {
      setError(err as Error);
      setIsRunning(false);
      onError?.(err as Error);
    }
  }, [pipeline, onError]);
  
  const reset = useCallback(() => {
    setPipeline(initialPipeline);
    setCurrentStageIndex(-1);
    setIsRunning(false);
    setError(null);
  }, [initialPipeline]);
  
  const handlePipelineChange = useCallback((newPipeline: Pipeline) => {
    setPipeline(newPipeline);
    onChange?.(newPipeline);
  }, [onChange]);
  
  useEffect(() => {
    onChange?.(pipeline);
  }, [pipeline, onChange]);
  
  const currentStage = currentStageIndex >= 0 
    ? pipeline.stages[currentStageIndex] 
    : null;
  
  const isComplete = currentStageIndex >= pipeline.stages.length - 1 && !isRunning;
  
  return {
    pipeline,
    stages: pipeline.stages,
    currentStage,
    isRunning,
    isComplete,
    error,
    run,
    reset,
    setPipeline: handlePipelineChange,
  };
}

export default usePipeline;
```

---

## 🔧 Shell Development Process

### Step 1: Understand the Requirements

Before starting development, understand:

1. **Target Users**: Who will use this shell?
2. **Use Cases**: What are the primary use cases?
3. **Existing Shells**: Review existing shells for patterns
4. **Contracts**: Understand the contracts the shell will consume
5. **Shared Presentation**: Review available shared components

### Step 2: Set Up the Project

#### Directory Structure

```
shells/shell-name/
├── src/
│   ├── main.tsx                   # Entry point
│   ├── App.tsx                     # Main app component
│   ├── components/                # Shell-specific components
│   ├── hooks/                     # Shell-specific hooks
│   ├── utils/                      # Shell-specific utilities
│   ├── styles/                     # Shell-specific styles
│   └── types/                      # Shell-specific types
├── public/                         # Static assets
│   ├── index.html
│   └── favicon.ico
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

#### package.json Template

```json
{
  "name": "@nexusprompt/shell-name",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@nexusprompt/contracts": "workspace:*",
    "@nexusprompt/shared": "workspace:*",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@vitejs/plugin-react": "^4.2.0",
    "typescript": "^5.9.0",
    "vite": "^5.0.0",
    "vitest": "^3.2.0"
  }
}
```

#### vite.config.ts Template

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@nexusprompt/contracts': resolve(__dirname, '../../../contracts'),
      '@nexusprompt/shared': resolve(__dirname, '../shared/src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
```

### Step 3: Develop the Shell

#### Pipeline UI Shell

The Pipeline UI shell provides a web interface for creating, editing, and running pipelines.

```tsx
// shells/pipeline-ui/src/App.tsx

import React from 'react';
import { usePipeline } from '@nexusprompt/shared/hooks';
import { PipelineVisualization, GateResultDisplay } from '@nexusprompt/shared/components';
import { theme } from '@nexusprompt/shared/styles';

export const App: React.FC = () => {
  const { 
    pipeline, 
    stages, 
    currentStage, 
    isRunning, 
    isComplete, 
    error, 
    run, 
    reset, 
    setPipeline 
  } = usePipeline();

  const handleRun = async () => {
    await run({
      command_id: 'test-1',
      run_id: 'run-1',
      stage_id: 'compile',
      input: { brief: 'Test brief' },
    });
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>NexusPrompt Pipeline</h1>
        <div style={styles.actions}>
          <button 
            style={styles.button} 
            onClick={handleRun}
            disabled={isRunning}
          >
            {isRunning ? 'Running...' : 'Run Pipeline'}
          </button>
          <button 
            style={{ ...styles.button, ...styles.buttonSecondary }} 
            onClick={reset}
            disabled={isRunning}
          >
            Reset
          </button>
        </div>
      </header>

      {error && (
        <div style={styles.error}>
          <strong>Error:</strong> {error.message}
        </div>
      )}

      <main style={styles.main}>
        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Pipeline Visualization</h2>
          <PipelineVisualization 
            pipeline={pipeline} 
            currentStageId={currentStage?.stage_id} 
            isRunning={isRunning} 
            isComplete={isComplete}
          />
        </section>

        <section style={styles.section}>
          <h2 style={styles.sectionTitle}>Stages</h2>
          <div style={styles.stages}>
            {stages.map((stage, index) => (
              <div 
                key={stage.stage_id} 
                style={{
                  ...styles.stage,
                  ...(currentStage?.stage_id === stage.stage_id ? styles.stageCurrent : {}),
                }}
              >
                <h3 style={styles.stageTitle}>{stage.stage_id}</h3>
                <p style={styles.stageDescription}>{stage.description}</p>
                
                {stage.gate_results && stage.gate_results.length > 0 && (
                  <div style={styles.gateResults}>
                    {stage.gate_results.map((result, i) => (
                      <GateResultDisplay key={i} result={result} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
};

const styles = {
  container: {
    maxWidth: '1200px',
    margin: '0 auto',
    padding: theme.spacing[6],
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing[8],
    paddingBottom: theme.spacing[4],
    borderBottom: `1px solid ${theme.colors.neutral[200]}`,
  },
  title: {
    fontSize: theme.typography.fontSize['3xl'],
    fontWeight: theme.typography.fontWeight.bold,
    color: theme.colors.neutral[900],
    margin: 0,
  },
  actions: {
    display: 'flex',
    gap: theme.spacing[3],
  },
  button: {
    padding: `${theme.spacing[2]} ${theme.spacing[4]}`,
    backgroundColor: theme.colors.primary[600],
    color: theme.colors.white,
    border: 'none',
    borderRadius: theme.borderRadius.md,
    fontSize: theme.typography.fontSize.base,
    fontWeight: theme.typography.fontWeight.medium,
    cursor: 'pointer',
  },
  buttonSecondary: {
    backgroundColor: theme.colors.neutral[100],
    color: theme.colors.neutral[700],
  },
  error: {
    padding: theme.spacing[3],
    backgroundColor: theme.colors.error[50],
    color: theme.colors.error[700],
    borderRadius: theme.borderRadius.md,
    marginBottom: theme.spacing[4],
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing[8],
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing[4],
  },
  sectionTitle: {
    fontSize: theme.typography.fontSize['2xl'],
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.neutral[800],
  },
  stages: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing[4],
  },
  stage: {
    padding: theme.spacing[4],
    border: `1px solid ${theme.colors.neutral[200]}`,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.neutral[50],
  },
  stageCurrent: {
    borderColor: theme.colors.primary[500],
    backgroundColor: theme.colors.primary[50],
  },
  stageTitle: {
    fontSize: theme.typography.fontSize.lg,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.neutral[800],
    margin: 0,
  },
  stageDescription: {
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.neutral[600],
    margin: `${theme.spacing[1]} 0`,
  },
  gateResults: {
    marginTop: theme.spacing[3],
  },
};

export default App;
```

#### Toolkit UI Shell

The Toolkit UI shell provides a web interface for browsing and using prompt engineering techniques.

```tsx
// shells/toolkit-ui/src/App.tsx

import React, { useState, useEffect } from 'react';
import { useApi } from '@nexusprompt/shared/hooks';
import { Card } from '@nexusprompt/shared/components';
import { theme } from '@nexusprompt/shared/styles';

export const App: React.FC = () => {
  const [techniques, setTechniques] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  
  const api = useApi();

  useEffect(() => {
    const fetchTechniques = async () => {
      try {
        setLoading(true);
        // This would call the actual API
        const response = await api.get('/techniques');
        setTechniques(response.data);
        setError(null);
      } catch (err) {
        setError(err as Error);
      } finally {
        setLoading(false);
      }
    };

    fetchTechniques();
  }, []);

  const filteredTechniques = techniques.filter(technique => {
    const matchesSearch = technique.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      technique.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesTags = selectedTags.length === 0 || 
      selectedTags.every(tag => technique.tags?.includes(tag));
    return matchesSearch && matchesTags;
  });

  const allTags = [...new Set(techniques.flatMap(t => t.tags || []))];

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>NexusPrompt Toolkit</h1>
      </header>

      {error && (
        <div style={styles.error}>
          <strong>Error:</strong> {error.message}
        </div>
      )}

      <div style={styles.filters}>
        <input
          type="text"
          placeholder="Search techniques..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={styles.searchInput}
        />

        <div style={styles.tags}>
          {allTags.map(tag => (
            <button
              key={tag}
              style={{
                ...styles.tag,
                ...(selectedTags.includes(tag) ? styles.tagActive : {}),
              }}
              onClick={() => {
                setSelectedTags(prev =>
                  prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
                );
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={styles.loading}>Loading...</div>
      ) : (
        <div style={styles.grid}>
          {filteredTechniques.map(technique => (
            <TechniqueCard 
              key={technique.id} 
              technique={technique} 
              onUse={() => alert(`Using: ${technique.name}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

interface TechniqueCardProps {
  technique: any;
  onUse: () => void;
}

const TechniqueCard: React.FC<TechniqueCardProps> = ({ technique, onUse }) => {
  return (
    <Card style={styles.card}>
      <h3 style={styles.cardTitle}>{technique.name}</h3>
      <p style={styles.cardDescription}>{technique.description}</p>
      <div style={styles.cardTags}>
        {(technique.tags || []).map((tag: string) => (
          <span key={tag} style={styles.cardTag}>{tag}</span>
        ))}
      </div>
      <div style={styles.cardActions}>
        <button style={styles.useButton} onClick={onUse}>
          Use
        </button>
        <button style={styles.copyButton} onClick={() => navigator.clipboard.writeText(technique.prompt)}>
          Copy
        </button>
      </div>
    </Card>
  );
};

const styles = {
  container: {
    maxWidth: '1200px',
    margin: '0 auto',
    padding: theme.spacing[6],
  },
  header: {
    marginBottom: theme.spacing[8],
    paddingBottom: theme.spacing[4],
    borderBottom: `1px solid ${theme.colors.neutral[200]}`,
  },
  title: {
    fontSize: theme.typography.fontSize['3xl'],
    fontWeight: theme.typography.fontWeight.bold,
    color: theme.colors.neutral[900],
    margin: 0,
  },
  error: {
    padding: theme.spacing[3],
    backgroundColor: theme.colors.error[50],
    color: theme.colors.error[700],
    borderRadius: theme.borderRadius.md,
    marginBottom: theme.spacing[4],
  },
  filters: {
    marginBottom: theme.spacing[6],
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing[4],
  },
  searchInput: {
    padding: `${theme.spacing[2]} ${theme.spacing[3]}`,
    border: `1px solid ${theme.colors.neutral[300]}`,
    borderRadius: theme.borderRadius.md,
    fontSize: theme.typography.fontSize.base,
    minWidth: '300px',
  },
  tags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing[2],
  },
  tag: {
    padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
    backgroundColor: theme.colors.neutral[100],
    border: `1px solid ${theme.colors.neutral[300]}`,
    borderRadius: theme.borderRadius.full,
    fontSize: theme.typography.fontSize.sm,
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  tagActive: {
    backgroundColor: theme.colors.primary[600],
    color: theme.colors.white,
    borderColor: theme.colors.primary[600],
  },
  loading: {
    textAlign: 'center',
    padding: theme.spacing[8],
    color: theme.colors.neutral[500],
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: theme.spacing[4],
  },
  card: {
    padding: theme.spacing[4],
  },
  cardTitle: {
    fontSize: theme.typography.fontSize.lg,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.neutral[800],
    margin: 0,
  },
  cardDescription: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.neutral[600],
    margin: `${theme.spacing[2]} 0`,
  },
  cardTags: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing[1],
    margin: `${theme.spacing[3]} 0`,
  },
  cardTag: {
    padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
    backgroundColor: theme.colors.neutral[100],
    borderRadius: theme.borderRadius.sm,
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.neutral[600],
  },
  cardActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
  useButton: {
    padding: `${theme.spacing[1]} ${theme.spacing[3]}`,
    backgroundColor: theme.colors.primary[600],
    color: theme.colors.white,
    border: 'none',
    borderRadius: theme.borderRadius.md,
    fontSize: theme.typography.fontSize.sm,
    cursor: 'pointer',
  },
  copyButton: {
    padding: `${theme.spacing[1]} ${theme.spacing[3]}`,
    backgroundColor: theme.colors.neutral[100],
    color: theme.colors.neutral[700],
    border: 'none',
    borderRadius: theme.borderRadius.md,
    fontSize: theme.typography.fontSize.sm,
    cursor: 'pointer',
  },
};

export default App;
```

### Step 4: Add Shared Components

When developing shared components:

1. **Check for existing components** in `shells/shared/`
2. **Follow the design system** (colors, typography, spacing)
3. **Make components reusable** across different shells
4. **Add proper TypeScript types**
5. **Write tests** for all components
6. **Document props** with JSDoc

### Step 5: Write Tests

#### Test Template

```typescript
// shells/pipeline-ui/test/App.test.tsx

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import App from '../src/App';

describe('Pipeline UI App', () => {
  it('should render the app', () => {
    render(<App />);
    
    expect(screen.getByText('NexusPrompt Pipeline')).toBeInTheDocument();
    expect(screen.getByText('Run Pipeline')).toBeInTheDocument();
  });

  it('should show error message when there is an error', () => {
    // This would require mocking the usePipeline hook
    render(<App />);
    
    // Simulate error state
    // expect(screen.getByText(/Error:/)).toBeInTheDocument();
  });

  it('should disable run button when running', () => {
    render(<App />);
    
    const runButton = screen.getByText('Run Pipeline');
    
    // Initially enabled
    expect(runButton).not.toBeDisabled();
    
    // When running, should be disabled
    // This would require mocking the running state
  });
});
```

### Step 6: Add to Workspace

Update the root `package.json` to include the new shell:

```json
{
  "workspaces": [
    "packages/*",
    "adapters/*",
    "shells/*"
  ]
}
```

---

## 🎯 Best Practices

### Do's

1. **Use shared components** when available
2. **Follow the design system** for consistency
3. **Make components reusable** across shells
4. **Handle errors gracefully** with user-friendly messages
5. **Add loading states** for async operations
6. **Implement accessibility** (keyboard navigation, ARIA labels)
7. **Use TypeScript** for type safety
8. **Write tests** for all components and functionality
9. **Document components** with JSDoc
10. **Optimize performance** (memoization, lazy loading)

### Don'ts

1. **Don't duplicate components** - use shared package
2. **Don't hardcode styles** - use design tokens
3. **Don't ignore errors** - handle all error cases
4. **Don't block UI** - use async operations properly
5. **Don't use `any` type** - use proper types from contracts
6. **Don't make breaking changes** to shared components
7. **Don't store state unnecessarily** - use React state properly
8. **Don't forget mobile** - ensure responsive design

---

## 🧪 Testing Strategy

### Unit Tests

- Test individual components in isolation
- Test hooks separately
- Test utility functions
- Mock dependencies

### Integration Tests

- Test component interactions
- Test with real API (when possible)
- Test error handling
- Test loading states

### End-to-End Tests

- Test user flows
- Test with real data
- Test edge cases
- Test performance

### Test Coverage Targets

| Component | Coverage Target |
|-----------|-----------------|
| Shared Components | 90% |
| Shell Components | 85% |
| Hooks | 95% |
| Utilities | 95% |
| **Overall** | **90%** |

---

## 📊 Performance Considerations

### React Performance

- Use `React.memo` for pure components
- Use `useMemo` and `useCallback` for expensive operations
- Implement virtualization for long lists
- Use lazy loading for heavy components
- Avoid unnecessary re-renders

### Bundle Size

- Use code splitting
- Lazy load non-critical components
- Optimize images and assets
- Use production builds for deployment

### Rendering Performance

- Avoid inline functions in render
- Use keys for list items
- Minimize DOM operations
- Use CSS transforms for animations

---

## 🔒 Security Considerations

### Authentication

- Use secure authentication methods
- Validate tokens on the server
- Don't store tokens in localStorage (use httpOnly cookies)
- Implement proper session management

### Input Validation

- Validate all user inputs
- Sanitize HTML to prevent XSS
- Prevent injection attacks
- Validate file uploads

### Data Protection

- Use HTTPS for all communications
- Encrypt sensitive data
- Don't expose sensitive information in URLs
- Implement proper CORS policies

---

## 📝 Monitoring and Observability

### Error Tracking

- Track client-side errors
- Log error context
- Monitor error rates
- Alert on error spikes

### Performance Monitoring

- Track page load times
- Monitor component rendering times
- Track API call durations
- Monitor bundle sizes

### User Analytics

- Track user interactions (with consent)
- Monitor feature usage
- Analyze user flows
- Respect privacy preferences

---

## 🚀 Deployment

### Build Configuration

```json
{
  "scripts": {
    "build": "tsc && vite build",
    "build:dev": "vite build --mode development",
    "build:prod": "vite build --mode production"
  }
}
```

### Environment Variables

```bash
# API endpoint
export VITE_API_URL='https://api.nexusprompt.dev'

# App title
export VITE_APP_TITLE='NexusPrompt'

# Analytics
export VITE_ANALYTICS_ID='GA-XXXXXXXX'

# Feature flags
export VITE_ENABLE_EXPERIMENTAL='false'
```

### Docker

```dockerfile
FROM node:24-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Build
RUN npm run build

# Serve with Nginx
FROM nginx:alpine
COPY --from=0 /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pipeline-ui
spec:
  replicas: 2
  selector:
    matchLabels:
      app: pipeline-ui
  template:
    metadata:
      labels:
        app: pipeline-ui
    spec:
      containers:
      - name: ui
        image: nexusprompt/pipeline-ui:v1.0.0
        ports:
        - containerPort: 80
        resources:
          limits:
            memory: "128Mi"
            cpu: "250m"
        livenessProbe:
          httpGet:
            path: /
            port: 80
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /
            port: 80
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: pipeline-ui
spec:
  selector:
    app: pipeline-ui
  ports:
  - port: 80
    targetPort: 80
  type: ClusterIP
```

---

## 📝 Guide Metadata

| Field | Value |
|-------|-------|
| **Version** | 1.0.0 |
| **Last Updated** | September 2026 |
| **Owner** | UI Team |
| **Phase** | Phase 2 (Weeks 15-18) |
| **Status** | Active |
| **Repository** | hynix666/nexusprompt |
| **Related Documents** | [IMPROVEMENT_2026_REVISED.md](./IMPROVEMENT_2026_REVISED.md) |

---

## 🔗 References

- [React Documentation](https://react.dev/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/)
- [Vite Documentation](https://vitejs.dev/)
- [Vitest Documentation](https://vitest.dev/)
- [Testing Library](https://testing-library.com/docs/react-testing-library/intro/)
- [Accessibility Guidelines](https://www.w3.org/WAI/standards-guidelines/)
