# Architecture

## The five-layer stack

Dependency order. **Effect ownership is the load-bearing idea.**

```
Shells (cli · pipeline-ui · toolkit-ui)  →  call the Application protocol ONLY
Application / Orchestration              →  owns ALL live effects
Contracts (versioned JSON Schemas)       →  the sole cross-boundary interface
Core (gates · stages · eval · release)   →  pure; no I/O, clock, or randomness
Adapters (provider · storage · evidence) →  impure, swappable per deployment
Composition Root                         →  wiring only, no logic
```

Enforced by `scripts/check-boundaries.mjs`, not by convention. One recorded exemption:
`shells/cli/src/composition-root.ts` may name concrete adapters — that is its whole job.

## The single most important invariant

**Core never performs an effect, and never *receives* one.** It does not take a `generate()`
callback.

```
decide  →  a stage returns a GenerationRequest describing what should happen
invoke  →  the Application executes it and classifies the outcome
reduce  →  Core folds the classified outcome into the next state
```

If a proposed Core function needs a callback to finish its job, it belongs in the Application
layer. This shape appears **three times** — the provider loop, the gate-feedback loop, and
model routing — and the fact that routing fit it without strain is what answered ADR-0008's
open question about whether routing needs its own layer. It does not.

**Consequence that pays for it:** an `EvalRun` is recomputable from stored artifacts without
re-invoking anything. That is why the scorer can never call a model, and it excludes the
dominant shape in surveyed external tooling (a harness whose scorer calls an LLM).

## The seven invariants

| | |
|---|---|
| **I1** | Core performs no effect |
| **I2** | Core never *receives* one — `decide → invoke → reduce` |
| **I3** | Output is never fabricated when no model answered |
| **I4** | Schema before code |
| **I5** | Ported gates match the frozen oracle, or declare a divergence with a reason and an ADR |
| **I6** | Frozen inputs are corrected at the boundary, never edited |
| **I7** | Observability carries keyed hashes only — no prompt bodies, ever |

## Four planes

```
┌── SHELLS ─────────────────────────────────────────────────────────────┐
│  cli (built) · pipeline-ui · toolkit-ui       Application protocol only│
└───────────────────────────────┬───────────────────────────────────────┘
┌───────────────────────────────┴───────────────────────────────────────┐
│  EFFECT PLANE — Application. Owns every effect, and nothing else does.│
│  provider · judge · store · sink · cache · budget · retry · fan-out   │
└──┬─────────────────┬─────────────────┬─────────────────┬──────────────┘
┌──┴─────────┐ ┌─────┴───────┐ ┌───────┴──────┐ ┌────────┴─────────┐
│ CONTRACT   │ │ DECISION    │ │ EVIDENCE     │ │ ADAPTERS         │
│ 15 schemas │ │ (pure)      │ │ EvalRun      │ │ provider ×2      │
│ versioned  │ │ gates 16    │ │ Baseline     │ │ storage ×2       │
│ the sole   │ │ stages 11   │ │ Promotion    │ │ judge ×1         │
│ boundary   │ │ statistics  │ │ Comparison   │ │ evidence ×1      │
│ interface  │ │ routing     │ │ immutable,   │ │ cache ×1         │
│            │ │ catalog 195 │ │ append-only  │ │ swappable        │
└────────────┘ └─────────────┘ └──────────────┘ └──────────────────┘
```

**The evidence plane is the newest.** Before it, `EvalRun`, `Baseline` and `Comparison` had
schemas and no home — runs were computed and discarded. A plane that computes evidence and
does not retain it cannot answer *"is this better than last month?"*, which is the only
question the system exists to answer.

## Five pipelines

| | Pipeline | State | Produces |
|---|---|---|---|
| **A** | Authoring | built, 11 stages, CLI-reachable | a candidate `Configuration` |
| **B** | Evaluation | built | an immutable `EvalRun` |
| **C** | Release | built, never fired | a `Promotion` and a `Baseline` |
| **D** | Monitoring | built, not armed | build failure on provider drift |
| **E** | Optimization | specified, **deliberately unscheduled** | candidate `Configuration`s |

```
        ┌──────────────── E · optimization (unscheduled) ────────────┐
        │  propose Configuration ──► B ──► objective = B's verdict ──┘
        ▼
brief ─► A ─► Configuration ─► B ─► EvalRun ─► C ─► Baseline ─► production
                  ▲                                     │
                  └────────── D · fingerprint watch ────┘
```

- **A is a loop, not a line.** A gate FAIL routes back to `refine` carrying its message,
  bounded by a cap that lives in the contract rather than a comment.
- **B is the only pipeline that may call a model under test.**
- **C is the only writer of baselines.**
- **E may write none of the above.** Its write surface excludes the gate registry, the
  differential oracle, and the anchor — a cycle in the grading order does not merely *risk*
  reward hacking, it constructs it.

## Data flow, one authoring run

```
brief
 └─► planForContext(stakes|depth)          Core, pure  → which stages run
     └─► for each stage:
          stage.decide(input) ──────────► GenerationRequest      Core, pure
              └─► Application invokes provider (adapter)
                  ├─ success → GenerationResult
                  └─ failure → typed ProviderFailure
                      └─► stage.reduce(classified)               Core, pure
                          ├─ ok    → next stage
                          └─ fail  → ⟦WORKFLOW DEMO — no model⟧ placeholder
     └─► lint stage runs 16 gates
          └─► decideGateFeedback() → route back to refine, capped
     └─► RevisionEntry per stage → storage adapter (one bundle per run)
     └─► ObservabilityEvent per step → sink (keyed hashes only)
```

## Demo mode — a structural honesty guarantee

Two parts, and both are required:

1. The **Application** classifies a provider failure into a typed `ProviderFailure`.
2. **Core** deterministically maps the classified failure to a `⟦WORKFLOW DEMO — no model⟧`
   placeholder.

Output is never fabricated when a provider was unreachable, and the `CLAIM_DISCIPLINE` gate
enforces that demo output never presents itself as live. This is why a misconfigured local
model was refused rather than wired: fluent garbage would defeat the one guarantee no gate
can check.

## Two purity guards, and what each actually covers

Conflating these is how the codebase once believed it was checking something it was not.

| Guard | Covers | Does **not** cover |
|---|---|---|
| `scripts/check-boundaries.mjs` | Static import analysis. `core/src/**` may not import `node:fs` or any effectful builtin, an adapter, or the Application. Reads every file, so it does not depend on test coverage | runtime behaviour |
| `core/test/purity.setup.ts` | Traps `fetch`, `Math.random`, `Date.now`, `new Date()` at runtime | **the filesystem** |

The runtime harness *cannot* block `fs`: Node snapshots a builtin's ESM exports when the
module is first evaluated, so patching `node:fs` afterwards changes an object nothing reads.
Only `require("fs")` is interceptable, and no Core module uses it. This was tried, measured,
and documented in the file's header — **do not "fix" it.**

## Deployment topology

Single-machine, no server. The CLI is the only entry point. CI runs `npm run verify` on
GitHub Actions (ubuntu-latest, Node 24, Python 3.12 for the differential oracle).

There is no database, no service, no container. `storage-local` and `evidence-local` write
JSON under `.nexusprompt/` in the working directory.
