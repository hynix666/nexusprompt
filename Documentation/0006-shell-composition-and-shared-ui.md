# ADR-0006: Shell Composition and Shared Presentation Packages (amends ADR-0004)

## Status
Accepted — amends ADR-0004, which remains in force except where this ADR supersedes it.

## Context

ADR-0004 shipped three Shells (`pipeline-ui`, `toolkit-ui`, `cli`) on the reasoning that "Shells depend only on Contracts and never on each other." In the same decision, `toolkit-ui`'s Pipeline module was specified as delegating to *the `pipeline-ui` component* rather than re-implementing pipeline logic — which is one Shell importing another Shell's internals, the exact dependency the rule forbids.

The intent was sound: avoid forking pipeline UX a third time. The mechanism was not, because it made an independently deployable, independently rollback-able Shell into an undeclared dependency of another Shell. A regression in `pipeline-ui` would propagate into `toolkit-ui` with no contract, no version pin, and no registration recording the coupling — undermining the per-Shell rollback story in `RELEASE_OPERATIONS.md`.

Separately, `ARCHITECTURE.md`'s original diagram listed a fourth Shell, `CI-bot`, which no ADR, capability matrix row, or user-facing document ever registered or defined (finding F-10).

## Decision

**1. UI reuse happens through shared presentation packages, never through Shell-to-Shell imports.**

The pipeline experience is extracted into a shared presentation package (`packages/pipeline-presentation`). Both `pipeline-ui` and `toolkit-ui`'s Pipeline module consume that package. Neither Shell imports the other; `pipeline-ui` becomes one thin host of the shared package rather than the owner of the component `toolkit-ui` borrows.

A shared presentation package:
- depends only on the Application protocol and contract-generated types — the same dependency budget a Shell has;
- contains no business logic, no adapter access, and no Core import;
- is versioned and pinned by its consumers like any other internal package.

**2. Shells call the Application protocol, not Core.**

Restated here because ADR-0004's phrasing ("Shells depend only on Contracts") described the dependency without naming what a Shell actually calls. Per ADR-0005, that is the Application protocol; Contracts define the shapes exchanged across it.

**3. `CI-bot` is not a Shell.**

It is removed from the architecture diagram and the Shell inventory. CI integration is served by the existing `cli` Shell invoked from a CI job — which is what the pre-commit-hook use case in `USER_GUIDE.md` already describes. If a distinct automated agent is wanted later, it must arrive as its own ADR with a contract registration, not as an unowned box in a diagram.

The supported Shell inventory is therefore exactly three: `pipeline-ui`, `toolkit-ui`, `cli`. `ARCHITECTURE.md`, `CAPABILITY_MATRIX.md`, `USER_GUIDE.md`, and ADR-0004 now agree.

## Consequences

- Per-Shell rollback becomes true as documented: reverting `pipeline-ui` cannot break `toolkit-ui`, because the shared behavior lives in a package both pin.
- The "no third pipeline implementation" goal of ADR-0004 is preserved — the shared package is still exactly one implementation.
- The cross-shell parity test (`cli` vs. web Shells producing identical `GateResult`s) keeps its meaning: it now tests that two independent Application consumers agree, rather than partially testing a Shell against a copy of itself.
- Cost: one more package boundary, and an extraction of pipeline UI code out of `pipeline-ui` before `toolkit-ui` can consume it. This is a one-time move, cheaper the earlier it happens.
- The import-boundary rule gains a clause: `shells/<a>/*` may not import `shells/<b>/*` for any `a ≠ b`. This is CI-enforced, not review-enforced.

## Alternatives considered

- **Declare `pipeline-ui` a library that `toolkit-ui` may import.** Rejected — it makes one Shell simultaneously a deployable and a dependency, so a rollback of the deployable is also a rollback of the dependency. That is the coupling this ADR exists to remove.
- **Let `toolkit-ui` re-implement the pipeline module.** Rejected outright: this is the "three implementations of the same thing" failure the entire merge effort exists to fix.
- **Drop `toolkit-ui`'s Pipeline module.** Rejected — it discards validated UX for no structural gain, since the shared-package route costs one extraction and preserves both.
