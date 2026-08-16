# ADR-0004: Dual Shell Strategy (Pipeline UI + Toolkit UI + CLI)

## Status
Accepted — **amended by [ADR-0006](./0006-shell-composition-and-shared-ui.md)**, which replaces Shell-to-Shell delegation with a shared presentation package and removes `CI-bot` from the Shell inventory. Where the two disagree on how `toolkit-ui` reuses the pipeline experience, ADR-0006 governs.

## Context
The final package and filesZ disagreed on product shape: a single linear 9-stage pipeline vs. a multi-module toolkit (Learn/Templates/Catalog/Vault/Pipeline). Prior merge planning considered forcing a choice — either re-architecting the toolkit's UX into the pipeline shell (Option A) or dropping the pipeline's richer feature set into the toolkit's Pipeline module (Option B) — as a single top-level decision.

## Decision
Do not force the choice. Because Shells depend only on Contracts (ADR-0002) and never on each other, both UIs ship as independent Shells: `pipeline-ui` (the final package's 9-stage flow, with its exports/revision-audit/invalidation logic intact) and `toolkit-ui` (filesZ's module shell, whose Pipeline module reuses the shared pipeline presentation package rather than re-implementing the flow — see ADR-0006; the original wording here delegated to the `pipeline-ui` component directly, which violated the very rule this decision rests on). A third Shell, `cli`, exists specifically to prove the contract boundary is real — a prompt linted via `cli` must produce identical `GateResult`s to the same prompt linted in either web Shell.

## Consequences
- No user-facing feature investment from either source UI is discarded.
- The `toolkit-ui`'s Pipeline module reuses the shared pipeline presentation package rather than forking pipeline logic a third time — avoiding the exact "three implementations of the same thing" failure this whole merge effort exists to fix, without making one deployable Shell a hidden dependency of another (ADR-0006).
- Slightly more Shell surface area to maintain (three Shells vs. one), accepted because the cost is presentation-layer only — none of it touches Core, Adapters, or Contracts.
- The cross-shell parity test (`cli` vs. web Shells producing identical `GateResult`s for identical input) becomes a standing regression check that the layer boundary hasn't eroded — see `DEVELOPMENT_AND_TESTING.md`.

## Alternatives considered
- **Option A (toolkit UX into pipeline shell)**: rejected as higher-risk — requires re-architecting unfamiliar UX (Learn/Templates/Vault) into a shell that wasn't designed for it.
- **Option B (pipeline UX into toolkit's Pipeline module) as the *only* shell**: not rejected outright, but superseded — once Contracts made both Shells cheap to maintain independently, forcing a single shell was unnecessary risk with no corresponding benefit.
- **A unified from-scratch UI**: rejected — highest cost, discards validated UX work from both source artifacts for no clear gain.
