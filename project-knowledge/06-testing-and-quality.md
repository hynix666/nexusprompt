# Testing and quality

**693 tests, 0 failing.** Runs offline in seconds.

```bash
npm test                      # all projects
npm run test:core             # core only
npm run test:app              # application only
npx vitest run --project contracts
```

## Vitest projects

| Project | Location | Covers |
|---|---|---|
| `core` | `core/test/` | gates, stages, eval, sizing, anchor, routing, catalog — **all pure** |
| `application` | `application/test/` | orchestration, pipeline, eval, judge, release, execution |
| `adapters` | `adapters/*/test/` | provider transport |
| `shells` | `shells/cli/test/` | CLI commands, exit codes |
| `contracts` | `test/` | contract conformance, evidence conformance, checker tests |

`core/test/purity.setup.ts` traps `fetch`, `Math.random`, `Date.now` and `new Date()` for the
`core` project. It **cannot** trap the filesystem — see `01-architecture.md`.

## The four quality mechanisms, and what each one alone cannot see

### 1. Unit tests — must-fire *and* must-not-fire

Every rule gets both halves. The second is where false positives die: a check that fires on
everything gets ignored, which is worse than not having it.

### 2. The differential oracle — `npm run differential`

The ported TypeScript gates against `sources/v5/prompt_lint.py`, verdict for verdict.

```
fixtures   40 cases
generated  120 cases (seed 1)
boundary   10 conjunction cases
compared   2720 gate verdicts
✓ the two implementations agree on every shared gate.
```

**Why it exists (ADR-0007):** parity between two implementations of one design is
*structurally blind to a defect they share*. The frozen fixture corpus documents three shipped
bugs that survived a passing parity suite for exactly that reason — a default substituted for
a caller-supplied `0`, a citation that declared itself inside an empty ledger (silencing
*both* citation gates), and a multi-citation regex that dropped every id after the first.

Divergences are declared in `scripts/divergence-allowlist.json` with a reason and an ADR. It
ships with **zero entries and that is correct** — both ported gates are faithful. Entries pin
*both* verdicts and carry their demonstration inline; a stale entry fails.

### 3. Mutation probes — the discipline that found the most

Break the code deliberately, confirm a test fails, restore. **Measure by exit code only.**

Cumulative across phases: **α 10/10 · β 11/11 · γ 13/13 · δ 14/14 · ε 31/31 · routing 17/17 ·
anchor 15/15.**

Probe instrument rules, each learned the hard way:

- Run checkers under `process.execPath`, not `npm.cmd` — the latter does not resolve through
  `execFileSync` on Windows (every probe returned −1 *including the control*).
- Back up on **full path**, not basename — two files are named `pipeline.ts`.
- A no-op control at **both ends**.
- Compare the post-restore state against a **baseline captured before any mutation**, not
  against zero. Asserting a green tree conflates *"the probe damaged something"* with
  *"something was already failing"*.

### 4. Checker self-tests — `test/checkers.test.ts`

Each checker script has must-fire cases against synthetic fixture repos, not just the
must-not-fire case of running on the real tree. A checker whose verdict depends on which
branch you last switched from is worse than no checker (`check-plan` once shipped with a regex
anchored on `plan-status\n` and exited 2 the moment a checkout re-materialised the file with
CRLF).

## The recurring failure: fixtures too uniform to discriminate

**Five probe survivors across the project shared one root cause.**

| Occurrence | The fixture could not discriminate because |
|---|---|
| δ | every row in a cluster shared a pass value — a broken accumulator gave the right answer by accident |
| ε | every discordant unit pointed one way, so the exact p *was* the design floor |
| ε | every schema was covered, so a hard-coded `validated: true` matched a derived one |
| anchor ×2 | the case did not retain its base text, so "exactly one gate newly fired" could not be re-checked |

**Rule:** before writing a fixture, name the mutation it must fail on, then check the fixture
actually contains that case — mixed directions, a member the guard should reject beside ones
it accepts, counts that differ so counting the wrong thing gives a different answer.

When a probe survives, **grow the fixture rather than loosening the assertion.** Twice the
honest answer was to change the *code*: a guard nothing could reach was dead, and deleting it
beat writing a test to reach it.

## Tests that could not fail

Found repeatedly by probing. Concrete examples, all fixed:

- a fixture whose "WARN" gate had verdict `PASS`
- a mutation that changed only a critique heading, where `isClean` compares the whole string
- a projection reporting `demo_mode: false` on a degraded run, making every degradation
  detector pass **vacuously** (they are conditional on that flag)
- `run-eval --suite eval/pipeline-smoke.json` reporting **5/5 and 5 provider calls** for five
  cases that each describe an eleven-stage run

That last one is the sharpest: a green result *measuring something other than its own name*,
living in the evaluation runner. Both runners now refuse each other's suites via one shared
`isPipelineCase`.

## Detector recall — measuring the instrument

`measureRecall()` plants mutations from `PROBE_CORPUS` into a run's own outcomes and reports
what each detector caught.

```
demo-labelled-when-degraded    100.0%  28/28 probe(s) on 14 substrate(s)
no-gate-warnings                 n/a   (no substrate — the detector fired on every outcome)
```

Three states, deliberately distinct:

| State | Meaning |
|---|---|
| a number | measured |
| `n/a` | **unmeasurable** — no substrate; the detector fires on everything |
| `0` | **measured and dead** — probes ran and caught nothing. Fails the build |

> *"recall 1.0 means these detectors caught everything we thought to plant. It is not a claim
> they catch everything."*

`eval` exits **3** when a detector has no probe or is dead — a detector never shown to fire is
dead code behind a passing suite.

## Property tests

`fast-check` is available and used for gates. **Nothing enforces the requirement** — the
documentation once claimed CI did. Both ported gates have property tests; treat it as a review
convention until something checks it.

## Known flaky / fragile areas

| Area | Note |
|---|---|
| `check:corpus` | depends on a 2 GB gitignored asset; deliberately outside `verify` |
| `check:fingerprint` | reports **"not armed"** rather than OK until a run reaches a provider |
| `storage-local` | read-modify-write per append, 11× per run — two concurrent runs already race. `evidence-local` deliberately does not repeat this |
| CRLF | `check-plan` reads with `\r\n` → `\n` normalisation after a real failure; new checkers should too |
| Anchor tests | build corpora of 60–400 cases; the full 4,906 build takes ~1 s but tests stay small on purpose |

## Coverage posture

No coverage percentage is tracked, and that is deliberate. The question this project asks is
not *"how much code is executed"* but *"would this suite fail if the code were wrong"* — which
is what the mutation probes measure and what a coverage number cannot.
