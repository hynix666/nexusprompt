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

## Open register — each with a closing condition

| Open | Closes when |
|---|---|
| **Nothing has ever called a provider.** The path exists (`npm run eval -- --live`) and has never run. `cache_read_tokens` is populated by nothing; no judge has graded anything; the release gate has never fired | A key exists, and one 100-trial run reports a non-zero cache read |
| **The anchor certifies detection, not quality.** No suite here measures a model | A key, then an anchor built over model outputs rather than gate verdicts |
| **Keyed fingerprints documented, bare `sha256` in code** | The event port holds a deployment-scoped key and `orchestrator.ts` uses it |
| **Does per-stage validation actually mitigate the depth cliff?** The strongest untested hypothesis here; the cited measurement is of *unvalidated* chains | A live run makes it measurable. If false, eleven stages is the wrong shape |
| **Is gate-message text sufficient reflective feedback?** The mechanism works and is capped; whether it *improves* anything is unmeasured | — |
| **`bootstrap-ci` is declared and refused.** Graded and free-form metrics need it | The first suite producing a non-binary metric |
| **599 is an upper bound**, not the independent-source count | Title/DOI-level dedup over extracted first pages |
| **`parent_revision_ids` records execution order, not true lineage.** `cost_estimate` names `preview` as its parent though it reads only `ctx.prompt`. The schema now says so rather than claiming lineage it does not have | Each stage declares which context keys it consumes, and parents are derived from the revisions that last wrote them |
| **`revision-entry` 1.3.1 was a patch, but `markStale` mis-answers a pre-1.3.1 bundle** — it stales the named revision and leaves descendants FRESH, because their `parent_revision_ids` are `[]`. No error, no validation failure | The store reads `execution_provenance.contract_versions` and refuses (or falls back to the positional cascade) for a bundle written before 1.3.1 — or the field's semantics are treated as a major bump |
| **The manifest reader is a heuristic, not a parser.** Five rounds, each finding new ambiguous Markdown shapes. Seven known-minor cases remain: sub-headings, indented closing fences, tilde dividers, emphasis and numbered headings | Either a real block-structure parse, or the accept-set is declared closed and everything outside it FAILs by design |
| **Two strict TS flags deferred** — `exactOptionalPropertyTypes` (25 errors), `noUncheckedIndexedAccess` (208) | Worked through, flag by flag |
| **Two Shells unbuilt** (`pipeline-ui`, `toolkit-ui`), plus hosted provider and `storage-db` adapters | Built; the shared presentation package is designed in ADR-0006 |
| **`storage-db` revision persistence is new work, not a port.** The inherited Drizzle schema (MySQL) has `users` and `promptAssets` and no revisions table | The revision schema is designed and lands as a reviewed migration |
| **Neither scaffolding generator exists** — `scripts/new-gate.ts`, `scripts/new-technique.py` | Built. Until then, do not tell contributors to use them |
| **The local ONNX model cannot be driven** — `genai_config.json` absent | The config lands, or parameters are recovered from graph tensor shapes with a known-answer test pinning one completion |

### Recently closed

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
