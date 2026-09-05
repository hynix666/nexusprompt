# Contributing

## Before writing code

If your change touches a contract in `contracts/`, open the schema change first, get it reviewed, and land it as its own PR with a version bump and changelog entry (see `CONTRACTS.md`). Code that implements a not-yet-merged contract change will be rejected — this project is contract-first by rule, not by aspiration (ADR-0002).

## Where does my change belong?

Ask, in order:
1. **Does it talk to something outside the process (network, filesystem, clock, randomness)?** → the transport or persistence itself belongs in `adapters/`.
2. **Does it decide *when* to perform an effect — retry, time out, fall back, persist, emit an event?** → `application/`. This is orchestration, not Core, even when the decision looks like business logic.
3. **Is it presentation?** → `shells/`, or `packages/` if two Shells need it ([ADR-0006](./0006-shell-composition-and-shared-ui.md)).
4. **Is it a pure transform on prompt/gate/catalog data, or a deterministic decision about what *should* happen next?** → `core/`.
5. **Is it about a decision, a diagram, or an architectural boundary?** → an ADR in `docs/adr/`, not a code comment.

Note the split between 2 and 4: Core decides *that* a model call is needed and returns a `GenerationRequest`; the Application decides *how* to make it and what to do when it fails. If your Core function needs a callback to finish its job, it is on the wrong side of that line — see [ADR-0005](./0005-application-orchestration-boundary.md).

If you're unsure, default to Core and let review push it out a layer — it's much easier to move a pure function than to purify an impure one later.

## Adding a gate, technique, or provider

Scaffold with `npm run scaffold:gate` (gates) or `npm run scaffold:technique` (techniques) — `scripts/new-gate.ts` and `scripts/new-technique.py` exist and are wired to those commands (PR [#116](https://github.com/hynix666/nexusprompt/pull/116), closing an item earlier drafts of this document said was missing). Review still goes against the checklist in `GATES_REFERENCE.md` (gates) or `CATALOG.md` (techniques): what is non-negotiable below is not automated by scaffolding alone.

What is non-negotiable regardless: a gate ships with at least one property test, and a technique record ships with a `primary_source`.

## PR checklist

- [ ] No new `core/*` → `adapters/*`, `core/*` → `shells/*`, `core/*` → `application/*`, `shells/*` → `core/*`, or Shell-to-Shell import (CI-enforced, but check locally first: `pnpm run lint:boundaries`)
- [ ] No new Core function accepts a callable that performs I/O — including an injected `generate()`
- [ ] Any contract change has a version bump and changelog entry
- [ ] New gates ship with a property test; new technique records ship with a `primary_source`
- [ ] New adapters pass the shared contract test suite for their interface
- [ ] `CAPABILITY_MATRIX.md` regenerates cleanly (`pnpm run docs:matrix`) with no orphaned contracts or unlisted adapter capabilities
- [ ] If touching a provider adapter: `PRIVACY_AND_SECURITY.md`'s threat model table still holds, or is updated in the same PR

## ADRs

Write one when you make a decision that constrains future work at a layer boundary — not for routine implementation choices. Template and numbering convention: `docs/adr/0001-five-layer-architecture.md` is the reference example.

## Code review priorities, in order

1. Does this respect the layer boundary? (structural correctness)
2. Is the contract it depends on stable / correctly versioned?
3. Is it tested per the standard for its layer (`DEVELOPMENT_AND_TESTING.md`)?
4. Everything else (style, naming, etc.)
