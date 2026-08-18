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
- Trusting the two already-shipped gates, which were asserted to match the source and are now actually verified against it:

  ```
  npm run differential -- --n 400 --seed 1
  → 440 cases, 880 gate verdicts, 0 disagreements, 21s
  ```

  The invocation is recorded because the figure is meaningless without it. This ADR previously said "880 verdicts" while the command it documented (`npm run differential`, defaulting to 120 generated cases) produces 320 — a real number that nobody could reproduce from the page it was written on.

**Harder**
- The toolchain. Python is a permanent build dependency; the frozen linter can never be deleted from `sources/`.
- Deliberately improving on the source. It now requires a recorded, reviewed exception rather than a quiet edit.

**To revisit**
- The divergence-allowlist mechanism, before the first gate that intentionally differs — see action items.
- The oracle's identity. If an independent implementation ever exists, prefer it; the frozen linter is the cheapest available oracle, not the best conceivable one.
- Runtime. One process spawn per case — *not* per case per gate, as this ADR originally said. Only a much larger corpus would need batching; see action item 3.

## Alternatives considered

Covered in the options table above. Worth restating one rejection: **parity is retained, not replaced.** The two answer different questions — parity asks whether our implementations agree with each other, the oracle asks whether we agree with something written independently. Dropping either leaves a real gap.

## Enforcement

- `npm run differential` — exit 0 agreement, 1 disagreement with the failing input printed, 2 refusal.
- `npm run verify` runs it last, after boundaries, typecheck, the source freeze, and the tests.
- A malformed `--n` **refuses** rather than comparing nothing. A run that compares zero cases and exits 0 reports agreement it never established.
- Comparison is scoped to the intersection of the two gate sets, so unported gates cannot produce a false red.
- **The ported set is pinned in `scripts/ported-gates.json`** and checked before any comparison runs. This closes a hole an audit found: the zero-case guard fired only at zero, so unregistering a gate halved the comparison and the oracle still exited 0 reporting agreement. A registry that no longer matches the manifest is a refusal, not a failure — the harness does not know what it is meant to compare.
- `source_gate_count` is re-derived from `prompt_lint.py` on every run and checked against both the manifest and `SOURCE_GATE_COUNT` in the registry. A constant in code is no safer than a number in a document unless something re-derives it, and this project's ledger exists because a gate count was wrong for months.
- The oracle's own frozen source is covered by `verify:sources`; changing `prompt_lint.py` changes the oracle and must be a deliberate, visible act.

## Action items

1. [x] ~~Add the oracle to the CI pipeline~~ — added to `npm run verify`, positioned last. There is no CI service to add it to; that remains open and is now stated plainly in `DEVELOPMENT_AND_TESTING.md` rather than implied to exist.
2. [x] **Add a divergence allowlist** — `scripts/divergence-allowlist.json`, enforced by `scripts/differential.ts`. **It ships with zero entries, which is the correct state:** both ported gates are faithful. The candidate this item named — `CLAIM_DISCIPLINE` flagging `guarantee-free` on a hyphen boundary — is *not* an instance, because the source shares that false positive and the port is right to keep it. An entry for it would be stale on arrival.

   Two additions to the `{gate, case, reason, adr}` sketch above, both forced by building it:

   - **The entry carries its demonstration inline** rather than naming a case. An allowlist needs a staleness rule or it becomes a place disagreements go to be forgotten, and neither obvious anchor works here: `fixtures.json` is frozen and hash-verified so a divergence case cannot be added to it, and a generated case id moves with `--n` and `--seed`, which would make liveness depend on how the harness was invoked. The entry therefore carries its own input, the harness runs it, and an entry whose demonstration no longer produces the declared disagreement fails.
   - **Both verdicts are pinned**, not merely the fact of a difference. Recording only "these may differ" would keep covering the case if the port later drifted to a third verdict; pinning both makes a change of shape a new decision.

   `also_matches` broadens one entry across a systematic divergence. That is not a convenience — the drill showed an exact-input entry correctly *refusing* to excuse a divergence that spanned many inputs and a second gate, which is the mechanism declining to fail open.

   **Drilled against a real deliberate divergence** (treating an unterminated fence as not-a-fence, which closes the most exploitable recorded `SECRET_LEAK_SCAN` evasion): 11 states, 11 correct — no entry fails; an exact-input entry does not excuse a systematic divergence; correct entries excuse it; missing reason, missing ADR, wrong declared shape, unported gate, and an entry permitting agreement all refuse; a stale entry left after the divergence is removed refuses; and the control is green at both ends.
3. [x] ~~Batch the runner once the ported gate set exceeds ~6.~~ **Withdrawn — the cost model was wrong.** `compare()` spawns Python once per *case* and then tallies every shared gate from that one run, so runtime is O(cases) and does not grow as gates are ported. Measured: 440 cases = 21 s at two gates, and sixteen gates will cost the same. What does scale is the corpus, so if `--n` grows past a few thousand this returns as a real concern; the gate count never made it one. Recorded rather than deleted, because "batch it before gate 6" was about to become received wisdom.
4. [x] Re-run the injection drill whenever the harness itself changes — done for this change. The gate-set pin was verified by unregistering a gate and confirming the oracle now refuses; the two implementations' agreement was re-confirmed at n=400.
5. [x] Record in `DEVELOPMENT_AND_TESTING.md` that the oracle is permanent, so it is not read as migration scaffolding by someone tidying up.

## Postscript: what the oracle has actually caught

Recorded because ADR-0007 argued for a permanent cost on the strength of an argument, and an argument is weaker than a measurement. A mutation probe run after this ADR was accepted broke six behaviours across Core and the adapters. Two were caught **only** by the oracle, with the entire test suite green:

| Mutation | `npm test` | `npm run differential` |
|---|---|---|
| `CLAIM_DISCIPLINE` regex reverted to requiring a literal space — the shipped `100%accurate` defect | pass | **fail** |
| `sk-ant` key-length bound widened by one character | pass | **fail** |

Both are exactly the class this ADR predicted: a change that the port's own tests have no reason to object to, because the port is behaving as its author intended. That is the argument, observed rather than asserted.
