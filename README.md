# NexusPrompt

A prompt engineering environment built around one idea: **LLM system failures are silent by
default, so the job of the architecture is to manufacture an error signal where the model
emits none.**

Most prompt tooling helps you write a prompt. This helps you find out whether a change to one
made anything better — and refuses to answer when it cannot tell.

```
brief ──► authoring ──► Configuration ──► evaluation ──► EvalRun ──► release ──► Baseline
                ▲                                                        │
                └──────────────── fingerprint watch ─────────────────────┘
```

---

## Quick start

Node 24+ and npm. **Use npm, not pnpm** — the workspace is defined with npm workspaces.

```bash
npm install && npm run verify
```

That is the whole check: import boundaries, types, frozen-source hashes, documentation
counts, suite sizing, the generated capability matrix, the evaluation suites, the test suite,
and the differential oracle. It runs offline in under twenty seconds.

Lint a prompt against the ported gates:

```bash
npm run cli -- lint path/to/prompt.md
```

Run the full authoring pipeline over a brief:

```bash
npm run cli -- pipeline path/to/brief.md --stakes HIGH
```

Ask what the system has actually retained:

```bash
npm run cli -- evidence
```

Without a provider key that last command reports an empty plane and says so. That is the
design working, not a failure — see **Demo mode** below.

---

## What is in the tree

| Path | Purpose |
|---|---|
| `contracts/` | 15 versioned JSON Schemas — the sole cross-boundary interface |
| `core/` | Pure logic: gates, stages, catalog, evaluation, statistics, routing, release. No I/O, no clock, no randomness |
| `application/` | Owns every effect — provider, judge, store, sink, cache, budget, retry |
| `adapters/` | Swappable implementations: provider, storage, evidence |
| `shells/cli/` | The one built Shell. Calls the Application protocol only |
| `scripts/` | The checks. Each one fails the build rather than printing a warning |
| `eval/` | Evaluation suites, with their declared resolution and significance protocol |
| `sources/` | 420 frozen, hash-pinned files from prior versions. Read from these; never write into them |
| `Documentation/` | Architecture, ADRs, and the implementation plan |

The dependency direction is enforced, not documented: `npm run lint:boundaries` fails the
build if Core imports the filesystem, an adapter, or the Application.

---

## The idea that shapes everything

**Core never performs an effect, and never receives one.** A stage *decides* and returns a
`GenerationRequest`; the Application executes it and classifies the outcome; Core *reduces*
that classified outcome into the next state. Decide → invoke → reduce.

If a proposed Core function needs a callback to finish its job, it belongs in the Application
layer. This is what makes an `EvalRun` recomputable from stored artifacts without re-invoking
anything, and it is why the scorer can never call a model.

**Demo mode is a structural honesty guarantee.** When no provider answers, the Application
classifies the failure and Core deterministically maps it to a `⟦WORKFLOW DEMO — no model⟧`
placeholder. Output is never fabricated when a model was unreachable, and the
`CLAIM_DISCIPLINE` gate enforces that demo output never presents itself as live.

---

## What the checks actually check

| Command | What it does |
|---|---|
| `npm run verify` | Everything below, in dependency order |
| `npm run lint:boundaries` | Core imports no effectful builtin, no adapter, no Application |
| `npm run verify:sources` | Re-hashes 420 frozen files against their manifest |
| `npm run check:counts` | Re-derives every pinned number in the docs from the tree |
| `npm run check:sizing` | What each suite can actually resolve, and refuses an anchor that cannot certify |
| `npm run check:matrix` | Fails when the committed capability matrix is not what the repo produces |
| `npm run check:fingerprint` | Fails the build when a provider swaps the model underneath you |
| `npm run differential` | The ported gates against the frozen Python linter, verdict for verdict |
| `npm run check:corpus` | Re-hashes the local research corpus. Not part of `verify` — see below |
| `npm test` | The suite, offline, in seconds |

**Every command in this file runs in `npm run verify` — with one named exception below — and
`verify` is what CI runs.** That is the mechanism that keeps the rest of this document from
going quietly false.

The exception is deliberate. `npm run check:corpus` re-hashes the 661-file research
corpus under `PDF/` — 2 GB of third-party papers, gitignored, whose canonical home is arXiv.
A fresh checkout has never had it, so folding that check into `verify` would make the headline
command fail for every adopter. `verify` checks the repository; `check:corpus` checks a local
asset, and says so by being its own command.

Every number quoted above is re-derived by `check:counts` from the repository, so a figure
in this README cannot drift from the tree without failing the build. There are
16 gates, 11 stages, 15 contracts, 195 catalog records,
599 corpus documents and 420 frozen source files — each of those is a
pin, not a claim.

---

## Known limitations

Named here rather than discovered later. Each carries what would close it.

**Nothing has ever called a real provider.** No API key is configured, so no evaluation run
has reached a model. `cache_read_tokens` is on the contract and populated by nothing, no
judge has graded anything, and the release gate — built and tested against each of its five
conditions — has never fired. Every guard here is armed against stubs.
*Closes when:* a key exists and one 100-trial run reports a non-zero cache read.

**`npm run check:corpus` currently fails.** The 661-file research corpus moved outside this
directory. Every file and every hash is intact at the new location; the manifest pins a
relative root that no longer resolves. Left failing rather than repaired by loosening the
check — `verify` is unaffected, because the corpus was never part of the repository.
*Closes when:* the corpus returns, or a portable way to name its location that does not
weaken the hash pin.

**No suite here can resolve a difference below about 53 percentage points.** That is not a
number to edit — it is the size of the suites. `check:sizing` prints it on every run, and
the comparator refuses rather than reporting a p-value a design could never have produced.
*Closes when:* an anchor suite exists, sized by `requiredPairedSize` with alpha, power and
discordance all written down.

**There is no git remote.** All work exists on one machine. This blocks the release-truth
phase and makes the reviewed-commit requirement impossible to satisfy.
*Closes when:* a remote exists and the branch is pushed.

**No licence has been chosen.** Deliberately not picked on the author's behalf — the tree
contains inherited archives whose terms should inform the choice.
*Closes when:* the author selects one and a `LICENSE` file lands.

**Two stricter compiler flags are measured and not yet adopted.** `strict` is on, along with
`noUnusedLocals`, `noUnusedParameters` and `noImplicitOverride` — each cost zero or near-zero
and the first immediately found seven dead imports. Two more were measured and left off:
`exactOptionalPropertyTypes` (25 errors) and `noUncheckedIndexedAccess` (208 errors). Both are
real improvements. The counts are recorded in `tsconfig.json` so the decision is a number
rather than an intention.
*Closes when:* the errors are worked through, flag by flag.

**Two Shells are specified and unbuilt** (`pipeline-ui`, `toolkit-ui`), along with the hosted
provider adapter and the database storage adapter. The CLI is the only Shell.
*Closes when:* they are built; the shared presentation package they depend on is designed in
ADR-0006.

---

## Naming

The product is **NexusPrompt**. Two things deliberately keep the older `promptnexus` name:

- **Contract `$id` hosts** (`https://promptnexus.dev/contracts/...`). Renaming them is 15
  major version bumps for a rebrand, which is the change ADR-0002 exists to make expensive.
- **`sources/` and the archives**, which are frozen historical artifacts. Changing them would
  break `verify:sources`, which is the point of freezing them.

The split is deliberate and recorded in ADR-0009 so nobody later mistakes it for drift.

---

## Contributing

Read `CLAUDE.md` first — it is the orientation document, and it records which parts of the
`Documentation/` tree describe the target state rather than the built one.

Two rules that are easy to violate by accident:

- **Contract-first.** A schema change lands with a version bump and a `contracts/CHANGELOG.md`
  entry *before* the code implementing it.
- **Never `git add -A` here.** Archives land in this directory unpredictably; stage explicit
  paths.
