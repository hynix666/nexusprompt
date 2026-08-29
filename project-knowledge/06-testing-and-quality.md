# Testing and quality

**1,155 tests across 30 files, 0 failing.** Runs offline in seconds.

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
| `shells` | `shells/*/test/` | CLI commands and exit codes; the API shell's routes and socket seam |
| `contracts` | `test/` | contract conformance, evidence conformance, checker tests, the gate contract |

`core/test/purity.setup.ts` traps `fetch`, `Math.random`, `Date.now` and `new Date()` for the
`core` project. It **cannot** trap the filesystem — see `01-architecture.md`.

## The seven quality mechanisms, and what each one alone cannot see

### 1. Unit tests — must-fire *and* must-not-fire

Every rule gets both halves. The second is where false positives die: a check that fires on
everything gets ignored, which is worse than not having it.

### 2. The differential oracle — `npm run differential`

The ported TypeScript gates against `sources/v5/prompt_lint.py`, verdict for verdict.

```
fixtures   40 cases
generated  120 cases (seed 1)
boundary   10 conjunction cases
allowlist  4 declared divergence(s)
compared   2784 gate verdicts
✓ the two implementations agree on every shared gate.
  17 verdict(s) differ deliberately, each declared in scripts/divergence-allowlist.json
```

**Why it exists (ADR-0007):** parity between two implementations of one design is
*structurally blind to a defect they share*. The frozen fixture corpus documents three shipped
bugs that survived a passing parity suite for exactly that reason — a default substituted for
a caller-supplied `0`, a citation that declared itself inside an empty ledger (silencing
*both* citation gates), and a multi-citation regex that dropped every id after the first.

Divergences are declared in `scripts/divergence-allowlist.json` with a reason and an ADR. It
sat at **zero entries for a week and that was correct**; it holds **three** now, all from the
SPB defect-parity audit. Entries pin *both* verdicts and carry their demonstration inline — the
harness runs each demonstration as a case, so an entry whose divergence disappears **fails**
rather than quietly continuing to excuse.

Two matchers, and reaching for the wrong one is expensive:

| | |
|---|---|
| `also_matches` | **broadens** by regex over the input, for a systematic difference across generated cases |
| `only_when_options` | **narrows** to cases whose options satisfy a constraint (`lt`/`lte`/`gt`/`gte`/`eq`) |

The second exists because a divergence can be **option-shaped rather than input-shaped**. The
QUTM baseline floor diverges on any text whose baseline is under the floor, so the only text
regex covering it is `.*` — which would also have excused `qutm-ceiling-crossing`, the one
boundary case in which half-up rounding is observable at all. **Declaring one deliberate
difference must not cost an unrelated regression detector.** An option a case does not carry
is *not* satisfied: absence must not excuse by omission.

### 3. Mutation probes — the discipline that found the most

Break the code deliberately, confirm a test fails, restore. **Measure by exit code only.**

Cumulative across phases: **α 10/10 · β 11/11 · γ 13/13 · δ 14/14 · ε 31/31 · routing 17/17 ·
anchor 15/15 · divergence 7/7 · staleness 9/9.**

The divergence pair is the most instructive here. One probe mutates rounding and asserts the
build still **fails**; the next removes `only_when_options`, applies the *same* mutation, and
asserts the build **passes**. Neither alone proves anything — together they prove the field is
load-bearing rather than decoration, which is the question worth asking of any new guard.

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

### 5. The truth boundary — `npm run check:truth`

The four above check that the system does what it says. This one checks what "does" is
being claimed for. Eight entries in `spec/truth-boundary.json` state a scope in two halves —
`establishes` and `does_not_establish` — with the numbers bounding it pinned; eight probes
re-derive those numbers from the tree and render `Documentation/TRUTH_BOUNDARY.md`.

What it catches that the other four cannot: a **true** number attached to an overreaching
claim. `check:counts` will confirm the anchor holds 4,906 cases while a reader concludes
something has been measured about a language model. Nothing had.

Both bijection directions are enforced, because a decorative entry is the failure mode:

| Shape | Why it fails |
|---|---|
| entry names a probe that does not exist | it asserts nothing |
| probe named by no entry | it derives into a void |
| `expect` is empty | renders as confident prose under a heading |
| probe derives a field the entry does not pin | the boundary moved and nothing objected |

The last is the direction an author never checks, and it is the same shape as the manifest
defect class: widening the instrument without widening the assertion leaves every existing
test green while the guarantee shrinks.

**Do not pin a value read from gitignored state.** A first draft counted run bundles under
`.promptnexus/`, which would have made the check pass or fail depending on which machine ran
it — a checker whose verdict depends on where you are is worse than none, and this repository
already paid that once with a CRLF-anchored regex in `check-plan`.

### 6. The artifact hash — `npm run check:hash`

75 runtime files (contracts, Core, Application, adapter and Shell sources, plus `package.json`
and the lockfile) digested to one hash. NOT tests, scripts, spec or Documentation: those decide
what is *checked*, not what runs, and a hash that churns on a moved comment is a hash people
stop reading.

**Content is normalised to LF before hashing, and that is the whole design.** `core.autocrlf`
is `true` here and `.gitattributes` pins only `sources/**`, so a Windows checkout and a Linux
checkout of one commit hold different bytes for every artifact file. Raw byte-hashing would
have been a platform check wearing a reproducibility check's name.

### 7. The gate contract — `test/gate-contract.test.ts`

Properties every gate must hold whatever the input, checked across all sixteen: determinism
(the second call is identical field for field), order independence (running the whole registry
first changes nothing), options immutability, totality (no throw on empty, lone CR, control
characters, 2,000-character bracket runs), verdict domain, hash stability in both directions,
and bounded time.

The first six sweeps hunted SHAPES for one gate. This is the axis they could not reach: a gate
that answers differently on the second call is broken with a perfectly good input, so no
fixture can find it.

**Its own first version did not work, and that is the point of the must-fire half.** The
options check stringified the object before and after and compared — which passes silently when
a gate writes a value equal to the one already there. Probed with a real gate setting
`options.includeFences = true` against options that already had it true: 199 tests passed. The
check now hands a FROZEN object, so ESM strict mode throws on any write rather than only on
one that changes something.

## Local green is not CI green

The sharpest lesson of the artifact-hash work, and it cost two red masters.

`npm run verify` on this machine is a **Windows, CRLF, already-installed** run. CI is
**Linux, LF, `npm ci` from the lockfile**. Three differences, and every one of them has now
produced a failure that was invisible locally:

| what broke | local | CI |
|---|---|---|
| corrupt `package-lock.json` | green — `npm install` repairs quietly, and a checkout never runs `npm ci` | `EUSAGE`, could not install at all |
| a test asserting the tree is CRLF | green | `expected 0 to be greater than 0` |
| a fence regex meeting `` | red only once a CRLF case existed | — |

The last one is the reverse case and worth keeping in view: CI would NOT have caught it,
because CI is LF. **Neither environment dominates.** A guard that matters has to be reasoned
about in both, and a mutation probe run only locally proves only the local half — the
sweep-six fence fix was probed, passed, and still disabled fences on every CRLF file.

One operational note that has bitten twice: **a push to a branch here does not reliably trigger
a CI run.** PR #30 was squash-merged from the commit before its fix because no run existed for
the fix. Check that the run you are reading belongs to the commit you are merging; the run id
is the tell, and `gh workflow run verify.yml --ref <branch>` dispatches one by hand.

## The recurring failure: fixtures too uniform to discriminate

**Eight probe survivors across the project shared one root cause.**

| Occurrence | The fixture could not discriminate because |
|---|---|
| δ | every row in a cluster shared a pass value — a broken accumulator gave the right answer by accident |
| ε | every discordant unit pointed one way, so the exact p *was* the design floor |
| ε | every schema was covered, so a hard-coded `validated: true` matched a derived one |
| anchor ×2 | the case did not retain its base text, so "exactly one gate newly fired" could not be re-checked |
| staleness | the out-of-order lineage chain was one level deep, so a single pass already found the descendant |
| staleness | the unknown-id case cascaded to nothing with the guard removed too |
| manifest | **every** fixture in the repo wrote `# Runtime Variables` followed by another `#` heading — the one layout in which two opposite defects cancel |

The last one is the sharpest instance in the project. Two defects in one regex failed in
opposite directions, so the gate was simultaneously unpassable in one layout and disabled in
another — and 2,720 oracle verdicts agreed, because no input in the corpus distinguished two
implementations that were wrong in the same place.

**Rule:** before writing a fixture, name the mutation it must fail on, then check the fixture
actually contains that case — mixed directions, a member the guard should reject beside ones
it accepts, counts that differ so counting the wrong thing gives a different answer.

When a probe survives, **grow the fixture rather than loosening the assertion.** Twice the
honest answer was to change the *code*: a guard nothing could reach was dead, and deleting it
beat writing a test to reach it.

A third answer showed up in the staleness probes: the guard was real but its **comment was
wrong**, claiming to prevent something it did not. What it actually protects is a dangling
parent reference — an entry naming a parent the bundle lacks. The fixture was grown to contain
that, and the comment was corrected to say the narrower true thing. A comment that overstates
a guard is the same defect as a guard that overstates itself; it just fails later, in the
reader.

**And a probe that survives is not automatically a finding.** Of four survivors in this round,
one was the *instrument*: swapping `break` for `continue` does not restore the old behaviour,
because a use line still is not a declaration line. That is the third time here that a probe,
not the code, was the thing that was wrong — which is why a control at both ends is not
optional.

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
