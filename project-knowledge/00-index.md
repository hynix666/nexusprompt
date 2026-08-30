# NexusPrompt — Portable Knowledge Base

A compact, self-contained record of this project, written so a new session (or a new person)
can rebuild, extend, or reason about it without reading the whole tree.

Generated 23 August 2026 at commit `f19dc83`; revised 25 August 2026 after the SPB
defect-parity audit, 28 August 2026 after the truth boundary landed, and 29 August 2026 — twice:
first after the repo-hygiene, API-shell and release-truth work, then again after budget
enforcement, the CLI argument parser, the content plane, and two more `.gitignore` incidents.

> **Nine of the structural counts below are pinned.** `npm run check:counts` re-derives them
> from the repository and fails the build when a number here disagrees with the tree — the
> same mechanism this project uses on its own documentation. It applies to counts of gates,
> stages, contracts, ADRs, Markdown files and declared divergences.
>
> It does **not** cover test counts, verdict counts or line counts, which would mean running
> the suite inside a checker that has to stay fast. Treat those as a snapshot and verify them
> before relying on one. The distinction is the point: a number that can be guarded cheaply
> should be, and a number that cannot should say so rather than borrow the credibility of the
> ones that are.

---

## TL;DR

**NexusPrompt is not a prompt authoring tool with tests attached. It is an evidence system**
whose output is a defensible claim about a *configuration*, and whose prompt compiler is one
instrumented subject among several.

The organising principle, from which nearly every design decision follows:

> **LLM system failures are silent by default, so the architecture's job is manufacturing an
> error signal where the model emits none.**

Every component was admitted on one test: *what silence does it break?* Two proposed
components were rejected by it.

---

## Quick facts

| | |
|---|---|
| Product name | **NexusPrompt** (contract `$id` hosts and `sources/` keep the older `promptnexus` — ADR-0009) |
| Language / runtime | TypeScript 5.9, Node 24, ESM, `module: NodeNext` |
| Package manager | **npm workspaces** — *not* pnpm (pnpm is not installed; older docs say otherwise) |
| Repo | `github.com/hynix666/nexusprompt` (private), branch `master`, CI green |
| Headline command | `npm install && npm run verify` — ~30 s, offline. 25 checks before the suite |
| Tests | 1,393 passing, 0 failing, across 36 files |
| Differential oracle | 2,784 gate verdicts vs the frozen Python linter; 17 differ **deliberately**, each with a reason and an ADR |
| Gates | 16 of 16 ported |
| Pipeline stages | 11 |
| Contracts | 17 JSON Schemas, all validated against produced values |
| Adapters | 4 built (provider-local-proxy, storage-local, evidence-local, content-local) |
| Shells | 2 built — `cli` and `api` (adopted 29 Aug, ADR-0012; typechecked and tested). 2 specified and unbuilt (`pipeline-ui`, `toolkit-ui`) |
| Source size | ~28,600 lines of TypeScript and ESM across `contracts/ core/ application/ adapters/ shells/ scripts/ test/ spec/` |
| Artifact hash | `fd1e1a80e9b7c95d…` over 78 runtime files, LF-normalised so a Windows and a Linux checkout agree |
| Truth boundary | 9 machine-checked entries stating what this repository establishes and what it does **not** |
| Commits | 131 — and note that a commit stating this number changes it, which is why it is not pinned |
| Licence | MIT |

### The three zeros (unchanged, and the point)

| | |
|---|---|
| Provider calls ever made by an eval run | **0** |
| Promotions | **0** |
| Baselines | **0** |

Every guard in this system is armed against stubs. `ANTHROPIC_API_KEY` is unset; the live
path exists (`npm run eval -- --live`) and has never run. The repository says so everywhere
the number appears rather than letting the wiring pass for a result.

The first zero is no longer only a sentence: `npm run check:truth` derives it, and one
eleven-stage run **is** persisted here with all eleven entries recording a null fingerprint.
A pipeline executed and no model answered — which is demo mode working, not a gap. The check
fails the build the moment a provider actually answers, because that is the moment every
sentence in this knowledge base saying *stubbed* or *never executed* stops being true.

---

## Table of contents

| File | Contents |
|---|---|
| [01-architecture.md](./01-architecture.md) | Five layers, four planes, five pipelines, `decide → invoke → reduce`, the two purity guards |
| [02-data-models.md](./02-data-models.md) | All 17 contracts with fields, versions, and the reasoning behind the sharp ones |
| [03-apis-and-interfaces.md](./03-apis-and-interfaces.md) | Ports, CLI surface, the one external API, exit codes |
| [04-business-logic.md](./04-business-logic.md) | Gates, stages, statistics, the release gate, routing, judge policy |
| [05-configuration-and-deployment.md](./05-configuration-and-deployment.md) | Env vars, tsconfig, CI, `verify` composition, the corpus |
| [06-testing-and-quality.md](./06-testing-and-quality.md) | Vitest projects, mutation probes, the differential oracle, fixture discipline |
| [07-dependencies.md](./07-dependencies.md) | Eight dev dependencies and why each one is there |
| [08-known-issues-and-decisions.md](./08-known-issues-and-decisions.md) | 13 ADRs, the truth boundary, the open register, and the recurring defect patterns |
| [09-commands-and-workflows.md](./09-commands-and-workflows.md) | Every npm script, what it checks, and the common workflows |
| [10-source-code-summary.md](./10-source-code-summary.md) | Key modules, reusable patterns, code idioms worth keeping |

---

## Directory map

Only what matters. `node_modules/`, `.git/`, `PDF/`, `LLM/` and the loose archives are
excluded — see `05-configuration-and-deployment.md` for what those are.

| Path | Purpose |
|---|---|
| `contracts/` | 17 versioned JSON Schemas + `index.ts` TypeScript bindings. The sole cross-boundary interface |
| `contracts/CHANGELOG.md` | Why every version moved. ADR-0002 requires an entry per bump |
| `core/src/gates/` | 16 pure gate implementations + registry |
| `core/src/stages/` | 11 pipeline stages + `pipeline.ts` (depth plan, gate feedback) |
| `core/src/eval/` | Comparator, sizing, anchor, perturbations, probes, budget, judge policy, generator |
| `core/src/release/promote.ts` | The five-condition release gate. Pure |
| `core/src/routing/policy.ts` | Model routing policy + the cost-justification refusal. Pure |
| `core/src/catalog/` | 195 technique records behind a pure registry |
| `application/src/` | Owns every effect: orchestrator, pipeline runner, eval, judge, cache, release |
| `adapters/provider-local-proxy/` | Anthropic API transport, host-allowlisted |
| `adapters/storage-local/` | Run-bundle persistence (8 bundles, evicted whole) |
| `adapters/evidence-local/` | Immutable evidence store (`wx` flag, no `update`) |
| `adapters/content-local/` | Content-addressed body store (`wx` flag, no `update`, no `delete`). Retains stage inputs and outputs so revisions can point rather than embed |
| `shells/cli/` | The CLI Shell + its composition root, which names every concrete adapter |
| `shells/api/` | The API Shell (ADR-0012). The only part of the tree with runtime dependencies |
| `scripts/` | 36 checkers and runners. Each fails the build rather than warning |
| `spec/` | Behavioural specs that ARE the tests and generate their own documentation. Two files: `manifest-shapes.json` (161 shapes one gate reads, across eleven sweeps; 13 recorded known limits) and `truth-boundary.json` (9 entries stating what this repository establishes and what it does not) |
| `scripts/divergence-allowlist.json` | 4 declared divergences from the frozen linter, each self-proving (ADR-0007) |
| `eval/` | 4 suites: compile-smoke, compile-adversarial, pipeline-smoke, gate-recall-anchor |
| `sources/` | **420 frozen, SHA-256-pinned files** from prior versions. Read only; never write |
| `Documentation/` | 41 Markdown files: 13 ADRs, implementation plan, architecture, references, the generated manifest spec, the generated truth boundary |
| `docs/superpowers/specs/` | The corpus-grounded spec that drove Phases α–ζ |
| `test/` | Cross-cutting: contract conformance, evidence conformance, checker tests |
| `.github/workflows/verify.yml` | CI. Runs `npm run verify` on every push and PR. Actions pinned to commit SHAs, not mutable tags |
| `vercel.json` | Switches Vercel off (`deploymentEnabled: false`). A stopgap, not a disconnect — see `05-configuration-and-deployment.md` |
| `proposals/` | Unintegrated drafts. Nothing here runs, is typechecked, or is hashed |

---

## How to use this knowledge base in a new project

See the section of the same name at the end of
[09-commands-and-workflows.md](./09-commands-and-workflows.md).
