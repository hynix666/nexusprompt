# Known issues, decisions, and lessons

## Architecture Decision Records

In `Documentation/`. **ADRs are amended, not rewritten** — the original text stays and the
Status line points forward. Where an ADR and `ARCHITECTURE.md` disagree about current shape,
**`ARCHITECTURE.md` is authoritative**.

| ADR | Decision |
|---|---|
| 0001 | Five-layer architecture; Core purity |
| 0002 | Contract-first: schema + version bump + CHANGELOG entry **before** implementing code |
| 0003 | Dual provider adapters |
| 0004 | Dual shell strategy |
| 0005 | Application/orchestration boundary — `decide → invoke → reduce` (amends 0001) |
| 0006 | Shell composition and shared UI (amends 0004) |
| 0007 | The differential oracle is **permanent**, not a migration step |
| 0008 | Evaluation-first environment; Configuration is the versioned artifact |
| 0009 | Product is NexusPrompt; contract lineage stays `promptnexus` |
| 0010 | The runtime manifest is a declaration list, not a span to end-of-file — authorises 2 divergence entries |
| 0011 | `QUTM_CEILING` does not arm below a named baseline floor — authorises 1, and added `only_when_options` |
| 0012 | `shells/api` adopted as the third Shell; zero-runtime-dependency scoped to below the Shell layer (amends 0004/0006) |
| 0013 | `audit-report` accepted with its producer **outside** this repository — the pending seam exists for exactly this ordering |
| 0014 | A malformed response is **not** demo mode — a model that answered badly still answered, so it gets its own category and its own placeholder |
| 0015 | Local inference is Ollama over loopback HTTP, zero-dependency, with **no** JSON repair — no stage asks a model for JSON, and a silent repairer launders |

## The truth boundary

`Documentation/TRUTH_BOUNDARY.md` is generated from `spec/truth-boundary.json` and re-derived
by `npm run check:truth`, inside `verify`. Eight entries, each stating a scope in two halves —
what an artifact establishes and what it does not — with the numbers that bound it pinned.

It is the answer to a failure the other checkers cannot see. `check:counts` confirms a number
is right; nothing confirmed what it was right *about*, and the documentation was written
target-state in the present tense, so a correct figure attached to an overreaching claim
carried a checker's authority. Writing it immediately turned up three false claims in
`Documentation/README.md` that had survived every existing check: that the capability-matrix
generator did not exist (it does, and runs in `verify`), that the matrix "asserts nothing",
and that the repository has no CI.

The entries most worth knowing before quoting anything:

- **Nothing here has ever talked to a model.** One eleven-stage run is persisted and all
  eleven entries recorded a null fingerprint. Every evaluation figure — the anchor's 4,906
  cases included — came from the pinned stub, and is evidence about this system's accounting.
- **The oracle proves agreement, not correctness.** Where the port and the frozen linter are
  both wrong it is silent, which is exactly the `CLAIM_DISCIPLINE` false positive's shape.
- **A green smoke suite is not a measurement.** `pipeline-smoke` is below the exact
  discordance floor outright; the other two clear six only in size, which is necessary and
  nowhere near sufficient.

Crossing a boundary is a failing build naming what moved — the point being that this is the
one moment anyone reliably re-reads the sentence attached to it.

## The recurring failure nobody had a checker for: `.gitignore`

**Six incidents now, and the count is the finding.** Emptied **three times** by automated commits — `7ede11a`, `83890f1` (repaired by `bf1fd4d`),
and `8ee5d0a`. The third truncated it to zero bytes and tracked **3,677 node_modules files in
the same commit**, which is how `.git` reached 2.3 GB. At the moment it was found, `PDF/`
(2.0 GB) and `LLM/` (815 MB) were ignored by nothing and tracked by nothing: one `git add -A`
from entering history permanently.

The structural cause is stated plainly because it generalises: **every checker in this
repository verified the repository's CONTENT, and none verified its SHAPE.** So the same
failure landed three times and was found three times by hand, each time by someone noticing
a `git status` that looked wrong.

`npm run check:hygiene` closes it, and runs first in `verify`. Four rules in two deliberately
redundant pairs — a pinned rule set and a floor on the rule count; a vendor-prefix ban and a
4 MB size bound. Each pair covers the other's blind spot: a named rule catches a known cost,
a bound catches an unknown one. An ignore rule also does nothing for a path that is *already*
tracked, which is precisely the state `8ee5d0a` left behind, so the index is checked
separately from the file.

The guard then shipped with the defect it was written to prevent. Its vendor rule used
`startsWith("node_modules/")`, which matches the repository root and nothing else — so a
tracked `shells/api/node_modules/.vite/…/results.json` walked straight past it while the
check printed **"none vendored"**. This is npm workspaces; every workspace can have its own
`node_modules`, so root-only was wrong for exactly the layout the rule guards. `.gitignore`
gets it right for free, because `node_modules/` matches at any level, which is the reason the
index needs a separate rule at all: an ignore pattern does nothing about a path already
tracked.

Found the way these always are — `npm ci` deleted the directory and git reported the deletion
of a file the check had just called clean. The matcher now tests any path segment, and is
probed in both directions: it fires on `a/b/c/node_modules/d` and stays silent on
`docs/node_modules-policy.md`, because widening a matcher is how a false positive ships.

### Incidents five and six — and the rule that had to be derived

**Fifth (29 August, `#38`).** A bot commit replaced the whole file with generic boilerplate,
pasted *inside its own markdown fences* — line 1 of the committed file was ` ``` `. It dropped
`PDF/`, `LLM/`, `.promptnexus/` and `.nexusprompt/`, and ADDED `build-hash.json`, a **tracked**
file `check:hash` reads.

Rule 1 caught the four removals. **Rule 6 walked past the addition**, because its
`NEVER_IGNORED` list is a hand-picked sentinel — one file per top-level tree — and nobody had
thought to name that one. The same sparse-matcher failure as the vendor rule above, one layer up.

Rule 7 asks the question rule 6 was approximating, derived instead of enumerated: **is any file
in the INDEX ignored?** It cannot be sparse. It immediately found a defect nobody had reported —
`promptnexus-v5/` was written for a loose archive extraction and matches at any depth, so it
also matched `sources/v5/promptnexus-v5/`: **nine frozen, SHA-256-pinned source files, ignored.**
Tracked, so `verify:sources` passed and nothing looked wrong. The extraction rules are anchored
with a leading `/` now, which is what they always meant.

**Sixth (29 August, `#45`).** `.gitignore` cut from 23 rules to 5 with **3,422 node_modules
files committed in the same change** — 1,113,326 insertions, the same signature as the third.
Every hygiene rule fired that should have: the pinned rules, the rule-count floor, the vendor
ban, the 4 MB bound (three 10.9 MB `esbuild` binaries), and the JSON-validity rule (a vendored
`tsconfig.json` that is JSONC).

That incident exposed a second, independent reason never to commit `node_modules`, and it is
**not** the size argument: checking the commit out and then clearing `node_modules` **deleted
107 workspace source files** — all of `contracts/`, parts of `core/`, `application/`, `shells/`
and `adapters/`. npm workspaces link each workspace into `node_modules`; on Windows those are
directory junctions, and a recursive delete traverses a junction into its *target*. Everything
was in the index and came back, but a clean `npm ci` on a fresh clone does the same thing, and
on a tree with uncommitted work it would not be recoverable. The usual argument is about the
repository's size; this one is about the working tree of anyone who checks it out.

Two things worth carrying forward:

- **The truth boundary caught this on its own.** Two of its eight entries failed —
  `run_bundles_are_gitignored` and `gitignored` both derived `false`. It was built to notice
  when a claim stops being true, and the first thing it noticed was not a claim about the
  product but about the repository.
- **`git rm -r --cached` stops the bleeding; it does not clean the wound.** The blobs are on
  `origin` and every clone carries them. Removing them means rewriting published history,
  which is the owner's decision, not a checker's.

## A checker over part of a document implies coverage of the document

`IMPLEMENTATION_PLAN.md` carries `check:plan`, which verifies its ```json plan-status``` block
and **nothing else**. On 29 August 2026 four claims in that document and the register below
were false at once: that `shells/api` was unwired, that the CI workflow had never run, that the
divergence allowlist held zero entries, and that five manifest limits remained. Every one sat
in prose, inches from a block that was correct the whole time.

That is the same shape the truth boundary exists for — a true number lending its authority to
an untrue sentence beside it — and it applies to the checker itself: partial coverage reads as
total coverage.

**What could be mechanised, and what could not.** Two of the four were numbers, and
`check:counts` is already a prose-claim checker — a regex per document, a resolver per number.
Both are pinned now, and R2's row was deliberately **rewritten to state a count** rather than
say "zero", so that a number existed for a checker to hold. That is the reusable trick: prose
becomes checkable when it commits to a figure.

The other two could not be, and saying so is the honest half. "`shells/api` is not wired" is a
claim about compilation; a rule reading "this file must not mention shells/api" is a phrase
ban, not a check, and goes stale the moment the wording moves. "The workflow has never run" is
a claim about GitHub, unverifiable from inside the repository — Phase 7 now states the CI
history as a **report and labels it as one**. Prose that admits it is unchecked beats a checker
that implies more coverage than it has.

## Open register — each with a closing condition

| Open | Closes when |
|---|---|
| **Nothing has ever called a provider.** The path exists (`npm run eval -- --live`) and has never run. `cache_read_tokens` is populated by nothing; no judge has graded anything; the release gate has never fired. The four refusals standing in front of it are now verified and pinned — no key, placeholder shape, no declared budget, non-positive `--max-calls` — so what remains is a key, not a mechanism | A key exists, and one 100-trial run reports a non-zero cache read. `check:truth` will FAIL on `any_fingerprint_observed` at that moment, by design |
| **The anchor certifies detection, not quality.** No suite here measures a model | A key, then an anchor built over model outputs rather than gate verdicts |
| **There is no deletion.** `PRIVACY_AND_SECURITY.md` named `delete(run_id, confirmation)` with a signature and a "typed-DELETE confirmation"; `RevisionStore` has `append`, `getRun`, `listRecent`, `markStale` and nothing has a delete. [AUDIT B-4]'s other half — #49 closed retention and replay, which made this sharper by creating content there is now something to fail to delete. Reclamation exists and is a different thing: it removes what nothing points at | A port method exists, an authoritative enumeration of stored runs exists (`listRecent` is a *recent* listing with a limit), and someone decides what erasure MEANS for content deduplicated by hash — two users submitting identical text share one file, so erasure for one is not a file removal |
| **Keyed fingerprints documented, bare `sha256` in code** | The event port holds a deployment-scoped key and `orchestrator.ts` uses it |
| **Does per-stage validation actually mitigate the depth cliff?** The strongest untested hypothesis here; the cited measurement is of *unvalidated* chains | A live run makes it measurable. If false, eleven stages is the wrong shape |
| **Is gate-message text sufficient reflective feedback?** The mechanism works and is capped; whether it *improves* anything is unmeasured | — |
| **`bootstrap-ci` is declared and refused.** Graded and free-form metrics need it | The first suite producing a non-binary metric |
| **599 is an upper bound**, not the independent-source count | Title/DOI-level dedup over extracted first pages |
| **`parent_revision_ids` records execution order, not true lineage.** `cost_estimate` names `preview` as its parent though it reads only `ctx.prompt`. The schema now says so rather than claiming lineage it does not have | Each stage declares which context keys it consumes, and parents are derived from the revisions that last wrote them |
| **`revision-entry` 1.3.1 was a patch, but `markStale` mis-answers a pre-1.3.1 bundle** — it stales the named revision and leaves descendants FRESH, because their `parent_revision_ids` are `[]`. No error, no validation failure | The store reads `execution_provenance.contract_versions` and refuses (or falls back to the positional cascade) for a bundle written before 1.3.1 — or the field's semantics are treated as a major bump |
| **The manifest reader is a heuristic, not a parser.** Eight sweeps, each finding new ambiguous Markdown shapes — the eighth turned to the USE side and found no false clean, which is the first time a sweep has come back empty in that direction. **13** known limits remain, enumerated in `spec/manifest-shapes.json` and re-derived by `check:truth`: sub-headings, emphasised and numbered headings, tilde dividers, blockquoted and checkbox declarations, setext and HTML headings, HTML tables, a commented key counted as a use, a comment opener inside a fence, and a double-backtick code span — all erring toward FAIL, a visible refusal an author clears. The last is inherited verbatim: the frozen linter uses the identical span regex, so there is no divergence to declare. **Exactly one errs the other way** and has across three sweeps: a manifest inside a fenced warning block returns PASS, and a silent PASS is the direction that ships defects | Either a real block-structure parse, or the accept-set is declared closed and everything outside it FAILs by design |
| **Two strict TS flags deferred** — `exactOptionalPropertyTypes` (25 errors), `noUncheckedIndexedAccess` (208) | Worked through, flag by flag |
| **Two Shells unbuilt** (`pipeline-ui`, `toolkit-ui`), plus hosted provider and `storage-db` adapters | Built; the shared presentation package is designed in ADR-0006 |
| **`storage-db` revision persistence is new work, not a port.** The inherited Drizzle schema (MySQL) has `users` and `promptAssets` and no revisions table | The revision schema is designed and lands as a reviewed migration |
| **Neither scaffolding generator exists** — `scripts/new-gate.ts`, `scripts/new-technique.py` | Built. Until then, do not tell contributors to use them |
| **The local ONNX model cannot be driven** — `genai_config.json` absent | The config lands, or parameters are recovered from graph tensor shapes with a known-answer test pinning one completion |

### Recently closed

**29 August 2026.** `.gitignore` emptied a third time and 3,677 node_modules files tracked
(closed by `check:hygiene`, which then turned out to miss a nested `node_modules` and was
widened) · `npm ci` impossible for a day, from a truncated `package-lock.json` and
`shells/api/package.json` · `shells/api` neither owned nor deleted (adopted, ADR-0012) · the
sweep-six fence fix silently disabling fences on every CRLF file · four false claims in the
plan and register · no artifact hash at all (Phase 7's third exit clause) · the Vercel
deployment that had never succeeded (root directory moved to the repo root; ADR-0012 records
why a server and not serverless).


no git remote (23 Aug) · no CI (23 Aug) · no licence (23 Aug) · corpus outside the repo
(23 Aug) · no suite resolves below ~53 pp (23 Aug, by the anchor) · the pipeline suite
reported 5/5 while never running the pipeline (23 Aug) · **`markStale` cascaded by array
position with zero callers** (25 Aug — walks `parent_revision_ids` to a fixed point, is
inclusive, and the gate-feedback rewind calls it) · **the divergence allowlist had never been
used** (25 Aug — three entries, and it turned out to need a second matcher).

## Closed by the SPB defect-parity audit — 25 August 2026

Cross-referencing a sibling lineage (the System Prompt Builder, v6.2.x) against this tree.
Every item was reproduced by **execution**, not by reading.

| Reported | Outcome |
|---|---|
| Gate 2 manifest scanner required a `#` heading | **Confirmed** — and the *other* half of the same regex was a false clean nobody had predicted. ADR-0010 |
| Gate 13 QUTM unsatisfiable for short briefs | **Confirmed.** ADR-0011 |
| Gate 15 taxed non-citing prompts | **Already correct** here — but no fixture covered it, so the whole branch was untested |
| Gate 3 backreference scan was slow | **Refuted.** `TOKEN_SPAM` is a literal `split()`; 1 ms on 200 KB of adversarial input |
| Gate 16 `JSON_SCHEMA_MALFORMED` missing | **Not a gap.** The frozen linter's sixteen ids are exactly the sixteen registered; SPB carries that gate where this tree carries `CONTEXT_LIMIT`. Two descendants differing, not a dropped port |

Two things the audit found that were in *neither* tree's report: the manifest false clean, and
`gate_version` being a module version wearing a gate's name — the fix for the first shipped
without bumping the second, and nothing noticed because nothing read the field.

## The recurring defect patterns

These are the *classes*, worth more than any individual fix.

### R9 — a guard's scope is quietly narrower than its name

Found **eleven times**. Examples:

- `check:plan` verifies 15 claims and passes, reading **exactly one file** — every count in
  every other document drifted unguarded. Fixed by `check:counts`, deliberately *not* named
  `check:claims`, because naming it broader would reproduce the very defect it closes.
- `Comparison.equalization` was a **boolean the caller asserted and nothing computed** — the
  comparator's strongest guard was a field callers filled in.
- `eval-case.failure_mode` was an unconstrained string while TypeScript enumerated 15, so two
  invented modes validated cleanly against the authoritative contract.
- `Baseline.lineage` existed from 1.0.0 and **nothing read it** until the release gate landed.
- `configuration.router_policy_ref` was a nullable string with **no description**, `null`
  everywhere, for three versions.
- `admitRun` returns *"no budget declared"* and admits everything when a configuration carries
  no budget — and the eval composition root declared none, so the first 100-trial live run
  would have been the unbounded one (1,400 calls, nothing able to stop them).
- **`extractRuntimeManifest` bounded the manifest at end-of-file**, so in the layout the v5
  framework prescribes the "manifest section" was the whole document and a *use* declared
  itself. The gate returned PASS on undeclared keys. Its sibling `extractSourceLedgerIds`
  already carried the fix for the identical defect with different brackets.
- **`gate_version` was per module, not per gate.** Gates sharing a file shared one constant,
  so the field could not express the true thing even in principle — bumping the gate that
  changed would have bumped up to five that did not.
- **`check:counts` does not read source comments.** Three comments claiming "2 of 16 gates
  ported" survived every guard, including the guard built to catch exactly this class.

### Documentation that contradicts its own machine-checked data

`IMPLEMENTATION_PLAN.md`'s **prose contradicted its own JSON block** — a false claim in the
one document `check:plan` reads, sitting in the one place `check:plan` does not look.

`check:counts` found **15 false counts across 6 documents** on its first run, against an audit
that predicted three.

### Green results that measure something other than their name

- `compile-smoke` never runs the pipeline (it drives the single-stage path) — so no suite could
  price a change to the pipeline's shape.
- `--suite eval/pipeline-smoke.json` reported **5/5 and 5 provider calls** for five cases that
  each describe an eleven-stage run.
- A projection reporting `demo_mode: false` on a degraded run made every degradation detector
  pass **vacuously** — they are conditional on that flag. *An instrument cannot also be what
  verifies itself.*

### Dead code shaped like a guard

Twice a mutation probe deleted a guard and **nothing failed**, because the guard was
unreachable (`method === "fixed"` in `reduceRouteOutcome`; `QUANTILES` exported for a test
never written). Both times the honest fix was to **delete it** and refuse the configuration
that would have needed it. Dead code shaped like a guard invites the belief that something is
protected and cannot fail visibly.

### Declared, and connected to nothing — the dominant pattern of 29 August

Five instances in one day, in code that had been reviewed and merged. Each is a mechanism that
reads as enforced and is not, which is strictly worse than an absent one:

| declared | what was missing |
|---|---|
| `admitRun` on the ELEVEN-STAGE path | called **zero times** by `application/src/pipeline.ts` — the only path the CLI wires a real provider into |
| `on_exceed: "truncate_suite"` | returned `admit: true` with a reduced `allowedCalls` that `eval.ts` referenced **zero times**, so it ran the whole suite |
| `--stage` on `nexusprompt run` | parsed, skipped over by the argument scanner, then discarded; `cmdRun` hardcoded `compile` |
| the `dangling-ref` promotion gate | `decidePromotion` accepted `contentRefs`/`refExists`, both optional, and the only caller passed neither |
| `input_ref` / `output_ref` | `buildRevision` took ref arguments no call site supplied, and no composition root built a `ContentStore` |
| `admitRun` on the SINGLE-STAGE path | `Orchestrator.run` dispatched three times and admitted zero, with no `budget` option a caller could supply (sweep twelve) |
| `delete(run_id, confirmation)` | named in `PRIVACY_AND_SECURITY.md` with a signature and a confirmation flow; exists in no port and no adapter (sweep thirteen) |
| the observability redaction check | `OBSERVABILITY.md` named `observability/sink.ts` as the enforcement point. That directory has never existed and no sink module was ever tracked, so the guarantee was the per-call convention the sentence disowned — and it was broken on the error path (sweep fourteen) |

### The sibling: enforced, but in the wrong place

Sweep twelve found a variant worth separating, because the usual tell does not catch it. The
mechanism **was** wired, tested, and enforcing — at build time, over a file, while the runtime
read a different number entirely.

`contracts/reliability-budget.json` caps gate-feedback rounds at 3 and `check:depth` fails the
build when the worst-case depth breaches the error budget at that cap. The file says so in its
own words: *"raising this cap fails the build unless the floor or the target moves."* But
`decideGateFeedback` took `ctx.topology.max_iterations` as the cap and consulted the budget
never, so `--reflexive 10` was simply granted: 10 rounds, **31 stage executions**, 85.6%
attainable against a 90% target — ten stages past the headroom `check:depth` prints.

Nothing was unwired. Nobody had to raise the cap. The guarantee was about a number the runtime
never read, and the fix was to make Core **import** the contract rather than restate it, so the
two cannot drift.

**Ask of any declared constant: who reads it at run time?** A checker reading it is not the
same as the code obeying it, and a build-time proof over a file says nothing about a process
that takes the value from somewhere else.

**The tell is an optional parameter with no production caller.** Every one of these type-checks,
tests green at the unit level, and is described in prose as working. Three of them shipped with
a CHANGELOG or usage line asserting the behaviour — and in the sharpest case the entry named the
pattern in its own next sentence, calling [AUDIT B-4] *"a guarantee written but not wired"* while
being exactly that.

Two habits catch it, and neither is code review at the diff:

- **Grep for the parameter, not the function.** `contentRefs` appearing only in a test file is
  the whole finding, available in one command.
- **Mutation-prove at the layer that ships.** Un-wiring the content store failed only the
  artifact-hash *checksum* until an end-to-end retention test existed — a checksum noticing that
  bytes moved is not a test noticing that behaviour changed.
- **Turn the finding into the question.** Sweep twelve fixed one unadmitted path and then
  installed the predicate that found it, derived from the source. Fixing the instance without
  installing the question leaves the third occurrence to be found by hand, which is exactly how
  the first two were found.

### Fixtures too uniform to discriminate

Eight occurrences. See `06-testing-and-quality.md`.

## Statistical gotchas worth carrying to any project

1. **Six discordant units is a hard floor at α = 0.05.** Fewer cannot reject under any
   arrangement. A suite below it must be *refused*, not called inconclusive.
2. **A p-value can be the design's own floor.** Phase δ reported `p = 0.25` for a
   three-discordant design — exactly `2·0.5³`, the smallest value that design could produce.
   The comparator was reporting the floor of its own range as a measurement.
3. **`n ≳ z²/(2Δ²)` hides three assumptions** — one-sided z, 50% power, 50% discordance.
   Honest figure at 2 pp is ≈9,800, not ≈3,400.
4. **Low discordance makes an anchor cheaper, not dearer**, for a fixed marginal delta: rare
   but consistent disagreement is a stronger signal per discordant pair.
5. **Nested comparisons are theatre.** A subset cannot beat its superset, so the null is known
   false before any case is scored.
6. **Exact p-values underflow a double to zero at 1,075 discordant units.** Zero claims
   impossibility; clamp to `Number.MIN_VALUE`.
7. **Multiplicity correction can push the required discordant count past the suite's size**,
   making a whole family unanswerable rather than merely stricter.
8. **Clustering is anticonservative in the dangerous direction.** Identical data: naive
   p ≈ 6e-5 (promote) vs clustered p = 0.25 (inconclusive).

## Engineering lessons

- **Every defect of consequence was found by a second, independently-authored checker** —
  never by making the first stricter. The SPB audit extends this: the second reader does not
  have to be a *checker*. A sibling lineage's bug list, cross-referenced by execution, found
  two defects a passing 2,720-verdict oracle could not see — because both implementations
  shared them.
- **A guard whose scope cannot express the true thing is not a strict guard, it is a broken
  one.** `gate_version` per module could not say "this gate changed and its file-mates did
  not". The fix is always to change the shape before changing the value.
- **Declaring a known exception must not cost an unrelated check.** The blanket
  `also_matches: ".*"` that would have documented the QUTM divergence would also have
  silenced the only detector for a rounding regression. When an exception is broader than
  the decision it records, widen the *mechanism*, not the exception.
- **Ship the check *with* the capability, never after.** The encoded fix for the
  "guarantee written but not wired" class.
- **Refuse rather than caveat.** A caveat beside a p-value gets the p-value quoted and the
  caveat dropped.
- **Derive, don't declare.** A guard the caller fills in is a guard the caller can satisfy.
- **No silent defaults where both options are defensible** — `Budget.on_exceed`,
  `--max-calls`, `Calibration.max_age_days`, `Baseline.lineage`.
- **Record the measurement, not the intention.** Deferred TS flags carry their error counts;
  the anchor carries its measured discordance rate.
- **Landing a schema before its producer works.** `Baseline.superseded_by` turned out to be
  unwritable — only discoverable by trying to write one, and free to fix a day before a
  producer existed.
- The **first mutation probe was broken and the control caught it.** Twice a probe instrument,
  not the code, was the thing that was wrong.

## Operational gotchas

| Gotcha | Consequence |
|---|---|
| **Never `git add -A` here** | Archives land in this directory unpredictably; once six archive dirs appeared between a `status` and a commit, sweeping 327 unintended files. Stage explicit paths |
| `systempromptbuilder/` carries its own `.git/` | `git add` records it as a gitlink producing a tree git cannot check out cleanly |
| Renaming workspace packages | Requires regenerating `package-lock.json`, or `npm ci` breaks |
| Writing code through shell heredocs | Backslash escapes (`\n`) get eaten, producing unterminated string literals that vitest tolerates and `tsc` catches later. Use a file-writing tool |
| `npm.cmd` in `execFileSync` | Does not resolve on Windows — run checkers under `process.execPath` |
| Probe backups keyed on basename | Two files are named `pipeline.ts`; key on full path |
| **Merging while `mergeable: UNKNOWN`** | GitHub squashes the branch *as it currently knows it*. A push it had not yet ingested was dropped from `#49` — the commit that only touched `package-lock.json` vanished, `build-hash.json` survived because both commits touched it, and master could not `npm ci`. **Check the PR's `headRefOid` equals the commit you pushed**, not merely that some run is green |
| **A push does not reliably trigger a CI run here** | More than once the newest commit had no run at all while `gh pr checks` showed the previous head's result. `gh workflow run verify.yml --ref <branch>` and then match the run's `headSha` |
| **Adding a workspace without `npm install`** | `adapters/content-local/package.json` matched the `adapters/*` glob but was absent from the lock file. `npm install` repairs that quietly; **`npm ci` refuses outright**, so every local command stayed green while CI could not install the project at all |
| Clearing `node_modules` on Windows | Workspace links are directory junctions and a recursive delete traverses them into the real source directories. It deleted 107 tracked files once. Recoverable only because they were committed |
| **Running a derived check before staging a new file** | `build:hash`, `check:truth` and most checkers here derive their file list from `git ls-files`, which does not list untracked files. A new file is therefore invisible exactly once — on the run before you stage it — and the local check passes on a number that is right about nothing. Stage, then check |
| **A stale PR head is not merely a hazard to your own merges** | Twice now GitHub's PR object lagged `origin/<branch>` and a merge dropped the newer commit. The second time the API disagreed for over five minutes and something else merged it before the refresh. When `headRefOid` disagrees with `git rev-parse origin/<branch>`, the PR is unsafe for ANYONE to merge; close and reopen forces the refresh |
