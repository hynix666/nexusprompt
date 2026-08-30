# System Prompt Builder · Pipeline

A nine-stage workbench that compiles a plain-language brief into a production system
prompt, then verifies the result before letting you ship it.

```
brief → triage → deconstruct → calibrate → compile → harden → critique → refine → lint → critic → preview
```

Two verification paths, deliberately different in kind:

- **Lint (Annex D)** — 16 deterministic gates, pure string analysis, no model call.
  Reproducible, free, works offline. Anything a string check can decide is decided here.
- **Critic** — a separate temperature-0 model call, run only at HIGH stakes and above,
  for the reasoning checks string matching cannot make honestly.

A result is shippable only when both verifications are current *for the same prompt
revision*. Editing a stage template marks it and everything downstream stale, and the
verdict disappears until they are recomputed.

## Files

| Path | Purpose |
|---|---|
| `SystemPromptBuilderPipeline.tsx` | The component. Self-contained apart from the two `lib/` modules. |
| `lib/promptDiff.ts` | Word-aware revision diffing (LCS over line hashes, bounded). |
| `lib/mockProvider.ts` | Deterministic offline provider for the demo path. |
| `pipeline.test.ts` | 75 tests over the deterministic layer. |
| `component.test.tsx` | 17 mounted-component tests, including a full offline run. |
| `extract-logic.mjs` | Derives `pipelineLogic.ts` from the component for testing. |
| `AUDIT.md` | What was wrong, how it was proved, and what was deliberately left alone. |

`lib/promptDiff.ts` and `lib/mockProvider.ts` are imported by the component but were
missing from the source tree — without them the module does not resolve. If you already
have your own, keep yours and delete these; the exported signatures are documented at
the top of each file.

## Running

```bash
npm i react react-dom
npm i -D typescript @types/react vitest jsdom @testing-library/react @testing-library/dom

npx tsc --noEmit          # strict, zero errors expected
node extract-logic.mjs    # regenerate the testable slice
npx vitest run            # 92 tests
```

`extract-logic.mjs` must run before the tests, and again after any edit to the
component's logic layer. It fails loudly if its anchors move rather than silently
testing less.

The `@/` alias maps to the project root (see `tsconfig.json` and `vitest.config.mts`).

## Configuration

Everything tunable is a named constant near the top of the component:

| Constant | Default | Effect |
|---|---|---|
| `REQUEST_TIMEOUT_MS` | 90 s | Per-stage deadline. Local models are slow on a cold load. |
| `MAX_RETRIES` | 2 | Retries on network errors and 429/502/503/504 only. |
| `MAX_RETRY_AFTER_MS` | 10 s | Ceiling on an honoured `Retry-After`, so a hostile header cannot stall a run. |
| `BUILD_STAGE_MAX_TOKENS` | 2400 | Output cap for compile/harden/refine. |
| `CRITIC_MAX_TOKENS` / `CRITIC_TEMPERATURE` | 800 / 0 | Temperature 0 keeps the verdict reproducible. |
| `MAX_TELEMETRY_ENTRIES` | 100 | Ring buffer; bounds DOM growth and export size. |
| `MAX_REVISION_HISTORY` | 8 | Each entry carries full prompt text, so keep it small. |
| `QUTM_MIN_BASELINE_TOKENS` | 120 | Below this the cost ratio carries no signal. |
| `TOKEN_SPAM_SCAN_CHARS` | 20 000 | Window for the Gate 3 backreference scan. |

## Providers

`mock` (offline, deterministic), `anthropic`, `openai`, `gemini`, `ollama`, `lmstudio`.

API keys live in React state only and are **never persisted** — a test asserts this.
The model-list cache is keyed on a short hash of the key, never the key itself. Error
text from providers is redacted for key-shaped strings before display, since some
providers echo the submitted credential back in an error body.

`openai` and `gemini` are direct browser calls with your key: personal or local use
only, never a deployment where the key would be handed to end users. `ollama` and
`lmstudio` need CORS enabled on the local server (`OLLAMA_ORIGINS=*` for Ollama).

## Storage

One adapter for both saved prompts and revision history. It prefers the sandbox
`window.storage` API and falls back to `localStorage`, writing to whichever accepts
first. When neither does — quota exhausted, or storage blocked in the current context —
the write reports failure and the UI says so, rather than silently discarding data.

## Deployment notes

- **Runtime:** React 19, ES2022, a browser with `AbortController`, `fetch`,
  `TextEncoder` and `URL.createObjectURL`. No build-time codegen.
- **Bundle:** ~250 KB, roughly 74 KB of which is the 195-entry technique catalog held
  as a module constant. If bundle size matters more than the single-file property,
  split the catalog into its own module and lazy-load it; nothing else depends on
  its being inline.
- **Layout:** desktop-first, with two fixed-width side panels and `height: 100vh`.
  It does not reflow below roughly 1100 px.
- **Fonts** load from Google Fonts at runtime; self-host them for an offline or
  locked-down deployment.
- **Health check:** select the `mock` provider and press COMPILE. A correct build
  reaches **SHIP** with the Lint stage reporting *all gates green*, with no network
  request at all. `component.test.tsx` asserts exactly that.
