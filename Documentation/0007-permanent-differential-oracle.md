# ADR-0007: The Differential Oracle Is Permanent

## Status
Accepted — 16 August 2026. Constrains `core/gates/*` and the CI pipeline. Amends nothing; extends the test strategy in `DEVELOPMENT_AND_TESTING.md`.

**Deciders:** whoever owns Core and the build pipeline.

*(This follows the section convention of ADR-0001 through ADR-0006 rather than a generic ADR template, so it reads alongside them. The options tables and action items are additions.)*

## Context

`core/gates/*.ts` is a **port**. Every gate is translated from `sources/v5/prompt_lint.py`, which means the port inherits whatever that linter got wrong, faithfully and silently. No test written against the port can see such a defect, because the port is behaving exactly as its author intended — the author was simply mistaken in Python first.

The documented test strategy relied on cross-shell parity. Parity compares two implementations of one design and catches drift between them; it is **structurally blind to a defect they share**. The inherited fixture corpus does not merely allow this conclusion, it states it, in three separate regression notes:

> *"Both implementations shared the bug, so the parity harness stayed silent — parity detects divergence, never a shared error."*
> *"Found by tests/differential.mjs against the independent v6 implementation; parity was blind because both v5 copies shared the defect."*
> *"Both v5 copies shared it, so parity was blind."*

Three defects shipped and survived a passing parity suite: a default substituted for a caller-supplied `0`, a citation that declared itself inside an empty ledger section (silencing *both* citation gates), and a multi-citation regex that dropped every id after the first.

Fourteen of sixteen gates remain to port. Without a mechanism that can see a shared defect, that is fourteen more opportunities to reproduce a bug exactly and have the build report green.

Constraints in play: solo execution, no remote CI service yet, Python 3.14 already present, the source linter already frozen and hash-verified at `sources/v5/prompt_lint.py`.

## Decision

**Keep a second, independently-authored implementation of the gate rules permanently, and compare against it in CI.**

Concretely, for now: the frozen Python linter *is* the oracle. `scripts/differential.ts` runs both implementations over the 40 frozen fixtures plus seeded generated cases, and compares `(gate, verdict)` over the **intersection** of the two gate sets, so an unported gate is never reported as a disagreement.

The word doing the work is *permanently*. This is not a migration harness to be deleted when the port finishes. The moment there is only one implementation of these rules, the class of defect it catches becomes invisible again — and it becomes invisible at exactly the moment the codebase looks most finished.

## Options considered

### Option A — Permanent differential oracle *(chosen)*

| Dimension | Assessment |
|---|---|
| Complexity | Low — one script, ~260 lines, no service |
| Cost | Python stays a permanent build dependency of a TypeScript project |
| Scalability | Runs per gate; grows linearly with the gate set |
| Team familiarity | The pattern is inherited; `differential.mjs` already did this |

**Pros:** catches inherited defects, which nothing else here can. Cheapest while Core is small. Reuses an artifact already frozen and verified. Proven to fail on injected defects, including the real historical regex bug.
**Cons:** a polyglot toolchain forever. The oracle is not ground truth (see the trade-off below). No mechanism yet for intentional divergence.

### Option B — Oracle as migration scaffolding, deleted after the port completes

| Dimension | Assessment |
|---|---|
| Complexity | Same to build, less to maintain |
| Cost | Zero after deletion |
| Scalability | N/A |
| Team familiarity | Same |

**Pros:** removes the Python dependency once the port lands; the usual and expected shape for a migration harness.
**Cons:** rejected. The risk it addresses does not end when the port ends — a shared defect is *more* dangerous in mature code, because the port has by then been read, reviewed, and trusted. Deleting the oracle on completion removes the check precisely when confidence is highest and scrutiny lowest.

### Option C — Parity only (two ports of one design)

| Dimension | Assessment |
|---|---|
| Complexity | Lowest |
| Cost | None |
| Scalability | Good |
| Team familiarity | Highest |

**Pros:** no extra language, no extra toolchain, already prescribed in the docs.
**Cons:** rejected on evidence, not preference. Three shipped defects passed a parity suite. Parity remains necessary — it catches port drift — but it cannot be the only mechanism.

### Option D — Write a third, independent implementation as the oracle

| Dimension | Assessment |
|---|---|
| Complexity | High |
| Cost | An entire second implementation, maintained |
| Scalability | Poor |
| Team familiarity | N/A |

**Pros:** a genuinely independent oracle with no shared ancestry — the strongest possible version of this idea.
**Cons:** rejected as disproportionate for solo execution. It is what the v5/v6 relationship gave for free, and if a v6-equivalent ever exists it should be preferred over the frozen linter.

## Trade-off analysis

**The oracle is not ground truth, and this is the subtlety that matters.** The frozen linter is the *source of* the known defects — the eleven regression fixtures exist because it shipped them. So a disagreement means *one of the two is wrong*, never *the port is wrong*. Reading a red build as "fix the port" would occasionally propagate a bug the port had correctly avoided.

This is why the harness prints the failing input and both verdicts rather than an expected/actual pair: the output is framed as a disagreement to investigate, not an assertion violated.

**Polyglot cost is real and accepted.** A TypeScript project that cannot build without Python is worse on portability (#4) than one that can. The exchange is correctness (#9) for portability, and it is only defensible because the check runs in CI rather than at install time: a contributor who does not run the oracle is inconvenienced, not blocked.

**Intentional divergence has no expression today.** If a gate port deliberately fixes a source defect, the oracle will disagree on every run, forever, and the only ways to get green are to un-fix the port or to delete the check. Neither is acceptable, and the harness currently offers nothing else. No gate has hit this yet — both ported gates are faithful — but it is a matter of time, and it is the most likely reason this ADR gets abandoned in practice.

## Consequences

**Easier**
- Porting the remaining fourteen gates. Each is checked against its source the moment it registers, and a faithfully-reproduced defect fails the build instead of passing parity.
- Trusting the two already-shipped gates, which were asserted to match the source and are now actually verified against it (880 verdicts, zero disagreements).

**Harder**
- The toolchain. Python is a permanent build dependency; the frozen linter can never be deleted from `sources/`.
- Deliberately improving on the source. It now requires a recorded, reviewed exception rather than a quiet edit.

**To revisit**
- The divergence-allowlist mechanism, before the first gate that intentionally differs — see action items.
- The oracle's identity. If an independent implementation ever exists, prefer it; the frozen linter is the cheapest available oracle, not the best conceivable one.
- Runtime. One process spawn per case per gate; at 16 gates and a large corpus this will need batching.

## Alternatives considered

Covered in the options table above. Worth restating one rejection: **parity is retained, not replaced.** The two answer different questions — parity asks whether our implementations agree with each other, the oracle asks whether we agree with something written independently. Dropping either leaves a real gap.

## Enforcement

- `npm run differential` — exit 0 agreement, 1 disagreement with the failing input printed, 2 refusal.
- A malformed `--n` **refuses** rather than comparing nothing. A run that compares zero cases and exits 0 reports agreement it never established.
- Comparison is scoped to the intersection of the two gate sets, so unported gates cannot produce a false red.
- The oracle's own frozen source is covered by `verify:sources`; changing `prompt_lint.py` changes the oracle and must be a deliberate, visible act.

## Action items

1. [ ] Add the oracle to the CI pipeline, positioned after Core tests and before adapter tests.
2. [ ] **Add a divergence allowlist** — a file of `{gate, case, reason, adr}` entries for deliberate differences from the source, where an entry without a stated reason fails. Needed before the first intentionally-improved gate port.
3. [ ] Batch the runner, or accept the runtime, once the ported gate set exceeds ~6.
4. [ ] Re-run the injection drill whenever the harness itself changes — a guard not observed failing is not known to work.
5. [ ] Record in `DEVELOPMENT_AND_TESTING.md` that the oracle is permanent, so it is not read as migration scaffolding by someone tidying up.
