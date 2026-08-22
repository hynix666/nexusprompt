# Phase 0 — Ground truth

Established 22 August 2026, before any design. Every number below is a command, not a recollection.

## What runs

```
npm run verify   →   exit 0
```

| Step | Result |
|---|---|
| `lint:boundaries` · `typecheck` · `verify:sources` | pass; 420 frozen files re-hashed |
| `check:plan` | `gates 16/16 · stages 11/11 · schemas 13 · adapters 2 · shells 1 · catalog 195/172 · CI none` |
| `check:citations` · `check:catalog` · `check:xsd` · `check:depth` · `check:stages` | pass |
| `eval` · `eval:compare` · `eval:adversarial` | pass |
| `test` | **437 passed**, 15 files, projects core/application/adapters/shells/contracts |
| `differential` | 16 of 16 gates ported; 40 fixtures + 120 generated + 10 boundary = **2,720 gate verdicts**, full agreement |

Total wall time ≈ 10 s. The suite is real: it fails when mutated (probed repeatedly this month, measured by exit code).

## Size of the artifact

```
for d in contracts core application adapters shells scripts test; do ... wc -l ...; done
```

| Layer | Lines | Files |
|---|---|---|
| `contracts` | 472 | 1 |
| `core` | 5,492 | 36 |
| `application` | 1,957 | 8 |
| `adapters` | 487 | 3 |
| `shells` | 366 | 3 |
| `scripts` | 2,565 | 12 |
| `test` (contract plane) | 1,380 | 2 |
| **Total** | **12,719** | **65** |

Documentation: **51,075 words** across 31 files — four words of prose per line of code.

## Size of the corpus

```
find PDF -name "*.pdf" | wc -l                                        → 661
find PDF -name "*.pdf" -printf "%f\n" | sort -u | wc -l               → 613
find PDF -name "*.pdf" -exec md5sum {} \; | awk '{print $1}' | sort -u | wc -l  → 599
du -sh PDF                                                            → 2.0G
```

| Subdirectory | PDFs |
|---|---|
| `PDF/PROMPT` | 364 |
| `PDF/RAG` | 134 |
| `PDF/pipeline` | 89 |
| `PDF/Memory` | 25 |
| `PDF/PoC` | 12 |
| `PDF/` (root) | 37 |

**Independent-source count: 599.** 62 files are byte-identical duplicates of another file, verified by md5 — the same paper filed under two topic directories. Duplicates confirmed identical, not same-name-different-paper, so deduplication is safe and loses nothing.

**No document in the repository states 599.** Three state `673-paper corpus`; one states `~700 papers`. See [AUDIT](./AUDIT_production-environment.md) B-1.

`PDF/` has **no manifest and no hash pin**, while `sources/` (420 files) has both. The corpus that motivates every design decision in `Documentation/` is the less-verified of the two inputs.

## What is built versus designed

Read from source, not from the status tables.

| Subsystem | State | Evidence |
|---|---|---|
| Pipeline A — authoring | **built**, reachable | 11 stages in `core/src/stages/`, runner in `application/src/pipeline.ts`, `promptnexus pipeline` in the CLI |
| 16 gates | **built** | `core/src/gates/`, pinned by `scripts/ported-gates.json`, checked by the differential oracle |
| Catalog | **built** | 195 records behind `core/src/catalog/registry.ts` |
| Pipeline B — evaluation | **partial** | `core/src/eval/{detectors,compare,probes}.ts` (726 lines) + `application/src/eval.ts` (224). Detectors, exact-binomial McNemar, mutation-probe recall, anchor sizing all present |
| — judge | **absent** | `judge-verdict` schema landed; `contracts/pending-implementation.json` records no producer |
| — perturbation | **absent** | no registry, no `perturb()` |
| — real execution fan-out | **absent** | `eval/*.json` suites pin provider responses; no run has called a model |
| Pipeline C — release | **absent** | `baseline` schema landed, no producer; no promotion path |
| Loop D — monitoring | **absent** | `provider_model_fingerprint` exists on every `ExecutionProvenance` and is read by nothing |
| Registry — configurations/baselines/promotions | **absent** | — |
| `storage-db` | **absent** | inherited Drizzle schema has `users` + `prompt_assets`, no revisions table |
| `provider-hosted-server` | **absent** | — |
| Shells `pipeline-ui` / `toolkit-ui` | **absent** | — |
| CI | **absent** | no `.github/`, **no git remote** |

## Standing invariants (these constrain everything downstream)

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Core performs no effect — no fs, network, clock, randomness | `scripts/check-boundaries.mjs` (static, filesystem/network) **and** `core/test/purity.setup.ts` (runtime globals). Neither alone is sufficient; the runtime harness structurally cannot block `fs` |
| I2 | Core never receives an effect either — `decide → invoke → reduce` | ADR-0005; `PipelineStage` is a discriminated union whose `generating` arm returns a `GenerationRequest` and reduces a classified outcome |
| I3 | Output is never fabricated when no model answered | `⟦WORKFLOW DEMO — no model⟧`, `CLAIM_DISCIPLINE` gate, 6 stages guarding on `isDemoArtifact` |
| I4 | A schema change lands before the code implementing it | ADR-0002; `contracts/CHANGELOG.md`; `contracts/pending-implementation.json` with a stale-entry rule |
| I5 | Ported gates match the frozen Python linter, or declare a divergence | ADR-0007; `scripts/differential.ts`, allowlist with zero entries |
| I6 | Frozen inputs are never edited; corrections happen at the import boundary | `sources/MANIFEST.json`; `scripts/catalog-corrections.json` with `from`/`to`/reason, refusing to apply if `from` stops matching |
| I7 | Observability carries keyed hashes only, never prompt bodies | `OBSERVABILITY.md` — **partially wired**, see AUDIT C-4 |

**I2 and I3 narrow this specification measurably.** Together they exclude the most common shape in the external tooling surveyed: an evaluation harness where the scorer calls the model. Here the scorer is pure and the judge is an adapter, which is why an `EvalRun` can be recomputed from stored artifacts without re-invoking anything — and why the judge can never be the model under test by construction rather than by policy.

## The measured baseline

Any claim that this specification improves something is measured against this.

| Quantity | Value |
|---|---|
| Tests | 437 |
| Gate verdicts compared against the oracle | 2,720 |
| Gates ported | 16 / 16 |
| Stages | 11 / 11 |
| Contract schemas | 13, of which 2 have no producer |
| Eval suites | 3 (`compile-smoke` 14 cases, `compile-adversarial`, `adversarial-known-evasions` 8) |
| Provider calls ever made by an eval run | **0** |
| Configurations promoted | **0** |
| Baselines | **0** |
| Detectors with measured recall | all, against `PROBE_CORPUS_VERSION 1.0.0` |
| Independent research sources | 599 |
| Commits | 19, on one machine, **no remote** |
