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

That is the whole check: repository hygiene, import boundaries, types, frozen-source hashes,
documentation counts, suite sizing, the generated documents, the truth boundary, the artifact
hash, the evaluation suites, 929 tests, and the differential oracle. It runs offline in about
thirty seconds and it is the only command you need.

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

## What you can do with it today

Three things, all offline, none of which need a provider key:

- **Lint a prompt** against sixteen gates ported from a frozen Python linter and checked
  against it verdict-for-verdict on every build.
- **Compile a brief** through eleven pipeline stages, with the depth chosen by the stakes you
  declare, and read every intermediate revision.
- **Inspect the evidence** — what was retained, what was promoted, and what the system will
  not claim.

What it will not do is tell you a prompt is *better*. Nothing here has ever called a model,
and every evaluation figure in this repository was produced by a pinned stub. That is not a
gap waiting to be filled quietly; it is the boundary the whole design protects, and
[`Documentation/TRUTH_BOUNDARY.md`](./Documentation/TRUTH_BOUNDARY.md) states it in nine
machine-checked entries. Read that before quoting any number from anywhere else here.

---

## What is in the tree

| Path | Purpose |
|---|---|
| `contracts/` | 16 versioned JSON Schemas — the sole cross-boundary interface |
| `core/` | Pure logic: gates, stages, catalog, evaluation, statistics, routing, release. No I/O, no clock, no randomness |
| `application/` | Owns every effect — provider, judge, store, sink, cache, budget, retry |
| `adapters/` | Swappable implementations: provider, storage, evidence |
| `shells/cli/` | The CLI Shell — lint, pipeline, gates, evidence. Calls the Application protocol only |
| `shells/api/` | A REST Shell over the same protocol: seven endpoints, adopted 29 Aug (ADR-0012). The only part of the tree with runtime dependencies |
| `spec/` | Behaviour specified as data: 135 manifest shapes and 9 truth boundaries, each one simultaneously the test and the document |
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
| `npm run eval:pipeline` | Runs the eleven-stage pipeline against a pipeline suite |
| `npm run eval -- --live` | Runs a suite against the real provider. Needs `ANTHROPIC_API_KEY`; not part of `verify` |
| `npm run check:anchor` | Regenerates the anchor suite and fails if the committed file differs |
| `npm run eval:anchor` | Runs the anchor through the real comparator and prints the verdict |
| `npm run check:corpus` | Re-hashes the local research corpus. Not part of `verify` — see below |
| `npm test` | The suite, offline, in seconds |

**Every command in this file runs in `npm run verify` — with one named exception below — and
`verify` is what CI runs**, on every push and pull request. That is the mechanism that keeps
the rest of this document from going quietly false.

The exception is deliberate. `npm run check:corpus` re-hashes the 661-file research corpus
under `PDF/` — 2 GB of third-party papers, gitignored, whose canonical home is arXiv. A fresh
checkout has never had it, so folding that check into `verify` would make the headline command
fail for every adopter. `verify` checks the repository; `check:corpus` checks a local asset,
and says so by being its own command. It passes: 661 files re-hashed in about two seconds.

Every number quoted above is re-derived by `check:counts` from the repository, so a figure
in this README cannot drift from the tree without failing the build. There are
16 gates, 11 stages, 16 contracts, 195 catalog records,
599 corpus documents and 420 frozen source files — each of those is a
pin, not a claim.

---

## Known limitations

Named here rather than discovered later. Each carries what would close it.

**Nothing has ever called a real provider.** The path exists — `npm run eval -- --live`
swaps the pinned stubs for the real adapter, with caching on so the cache-read claim is
testable — but no key is set here, so it has never run. `cache_read_tokens` is on the
contract and populated by nothing, no judge has graded anything, and the release gate has
never fired. Every guard is still armed against stubs.

Set the key yourself; nothing in this repository asks for it, stores it, or prints it, and
`--live` refuses up front rather than degrading fourteen cases to tell you:

```bash
export ANTHROPIC_API_KEY='<your key>'   # bash/zsh; PowerShell: $env:ANTHROPIC_API_KEY = '...'
npm run eval -- --live --trials 100 --max-calls 1400
```

`--max-calls` is **required** for a live run, with no default. `admitRun` returns
"no budget declared" and admits everything when a configuration carries no budget, so
without the flag the first real run would have been the unbounded one. It refuses before
dispatch and reports "nothing was spent" — 14 cases x 100 trials is 1,400 calls, and the
plan is printed before the money moves, not after.

A live run sends the suite's briefs to `api.anthropic.com` and spends money. The host is
hard-coded against a frozen allowlist, so it goes there and nowhere else.
*Closes when:* one 100-trial live run reports a non-zero cache read.

**No suite measures a model.** The anchor resolves 2 percentage points, but over *gate
detection on generated text* — it certifies a `gate_set_ref` change, not a prompt's quality.
The smoke suites remain what they were: 14 and 5 cases, resolving ~53 and ~89 points, which
`check:sizing` prints on every run.
*Closes when:* a provider key exists and an anchor can be built over model outputs.

**Two stricter compiler flags are measured and not yet adopted.** `strict` is on, along with
`noUnusedLocals`, `noUnusedParameters` and `noImplicitOverride` — each cost zero or near-zero
and the first immediately found seven dead imports. Two more were measured and left off:
`exactOptionalPropertyTypes` (25 errors) and `noUncheckedIndexedAccess` (208 errors). Both are
real improvements. The counts are recorded in `tsconfig.json` so the decision is a number
rather than an intention.
*Closes when:* the errors are worked through, flag by flag.

**Two Shells are specified and unbuilt** (`pipeline-ui`, `toolkit-ui`), along with the hosted
provider adapter and the database storage adapter. That is stated as scope rather than as a
shortfall: `cli` and `api` both drive the full pipeline through the Application protocol, so
what is missing is presentation, not capability.
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

## Licence

MIT — see [LICENSE](./LICENSE). Every workspace package declares it.

**What that covers.** The code, the contracts, the checks, and the documentation in this
repository. It is not a relicensing of anything inherited: `sources/` holds frozen copies of
prior artifacts, and the research corpus under `PDF/` is third-party papers whose canonical
home is arXiv — which is gitignored and not distributed here precisely because it is not
this project's to give away.

## Contributing

Read `CLAUDE.md` first — it is the orientation document, and it records which parts of the
`Documentation/` tree describe the target state rather than the built one.

Two rules that are easy to violate by accident:

- **Contract-first.** A schema change lands with a version bump and a `contracts/CHANGELOG.md`
  entry *before* the code implementing it.
- **Never `git add -A` here.** Archives land in this directory unpredictably; stage explicit
  paths.
