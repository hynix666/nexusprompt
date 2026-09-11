# Phase 9 — Gate Precision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: DRAFT for review — three decisions below are the owner's, and Tasks 2–5 cannot start until they are made.** Task 1 needs none of them.

**Goal:** Measure how often the gates are wrong when they fire, and until that measurement exists, say that it does not.

**Architecture:** Precision = TP / (TP + FP) over **firings only**. That is what makes it tractable: nobody has to certify that a text is clean everywhere, only whether each FAIL/WARN a gate actually produced is a real defect. The corpus is produced by the pipeline itself against local models, committed, and then everything downstream runs offline and deterministically. The one new Core function is a pure interval computation.

**Tech Stack:** as Phase 8. The corpus builder additionally needs the Ollama daemon (`adapters/provider-ollama`), and therefore sits outside `verify`, like `build:judge-calibration`.

## Why this phase, and not the rest of the Phase 8 spec

`MINIMUM_CHANGE_REMEDIATION_STRATEGY_2026.md` §7, §8 and its optional exception normalization were deferred from Phase 8. On 11 September 2026 each was checked against `master` (`a7e964e`):

| Item | Finding | Consequence |
|---|---|---|
| §7 fallback containment | The only producer of `model_policy` is `core/src/stages/stage-kit.ts:318`, always one model. No Shell, Application or script accepts one from outside; no schema persists it. | The guard would reject an input nothing can produce. |
| §8 routing containment | Every `Configuration` is built in `scripts/` with `router_policy_ref: null`; no path admits an external one. | Same. |
| Exception normalization | All three first-party adapters return typed failures from every `catch`; the Application's transport wrappers (`cache.ts`, `pipeline-eval.ts`) do not throw, and `eval.ts`'s one throw is budget admission before any call. | Hardening against a hypothetical adapter. |

None of the three is built here. Each becomes an **entry condition** of the work that would make it reachable (an external `Configuration` admission path must reject a `router_policy_ref` it cannot execute, and so on).

Precision, by contrast, is a quantity every gate-backed figure already depends on, and nothing measures it:

- `IMPLEMENTATION_PLAN.md:241` lists it as open: *a detector with a moderate false-positive rate would pass everything here.*
- Nothing in `core/src/eval/`, `scripts/` or `spec/` computes it, and no entry in `Documentation/TRUTH_BOUNDARY.md` states that it is unmeasured.
- The rate is known to be non-zero: CLAUDE.md records a `CLAIM_DISCIPLINE` false positive that the frozen Python source shares, which is exactly why the differential oracle cannot see it.
- Which detectors it affects: of the eleven in `core/src/eval/detectors.ts`, only `no-gate-failures`, `no-gate-warnings` and `gate-verdict` inherit gate precision, and `no-fabrication-when-degraded` is a keyword heuristic. The rest are exact predicates whose precision is 1 by definition. **Scope is the sixteen gates plus that one heuristic.**

## Negative results that shaped the design

Recorded so nobody re-proposes them:

1. **The frozen fixtures are not a precision corpus.** `sources/v5/fixtures.json` has 40 cases (16 PASS, 16 GATE_FAIL, 8 DEGRADED), 35–198 characters each. The port is regression-tested against them, so a false-positive rate measured there is zero by construction.
2. **The catalog is not either.** Filling all 195 `usage_templates` with their variables' `example` values and running the registry gives 196 firings, **195 of them `GUARDRAIL_GAP` WARN, one per template**. The templates are technique fragments, not system prompts, so "no guardrail section" is true of every one of them. That measures a domain mismatch. (Separately, 153 of the 195 still contain `{{placeholders}}` after filling, because not every variable carries a string example.)
3. **Local run bundles are not either.** `.nexusprompt/runs/` is gitignored, stores output *references* rather than text, and the bundle inspected was a DEMO run. CI can never read it.

The gates are defined over **complete compiled system prompts**, and the repository contains no independent set of them. Producing one is therefore Task 2, not an assumption.

## Decisions required before Tasks 2–5

**D1 — Who adjudicates.** Every firing needs a human-readable TRUE/FALSE label with a reason. Options:
- (a) The owner labels; Claude drafts a label and reason for each, and the file records both `drafted_by` and `adjudicated_by`. **Recommended.**
- (b) Claude labels alone. That is an LLM judge, which ADR-0008 and `judge-policy.ts` refuse without calibration. If chosen, the truth-boundary entry must say so explicitly.

**D2 — Corpus size and models.** Recommended: the 100 inputs of `eval/brief-pilot.json` × 3 of the pinned local models in `scripts/model-fingerprints.json`. `eval --local` took 69 s for 14 cases on one model, so this is roughly 25 minutes of local compute. The daemon is installed (`%LOCALAPPDATA%/Programs/Ollama`) and was **not running** on 11 September.

**D3 — Accept that the figure is corpus-relative.** `brief-pilot`'s briefs deliberately plant secrets, Unicode, placeholders and structure defects. That raises the true-positive share, and precision depends on it. The figure will be reported as *precision on this corpus*, with the corpus composition beside it, never as a property of the gate alone.

## Global constraints

- Everything Phase 8 required: `npm`, tests before code, `verify` after every commit with the exit code checked, no `Co-Authored-By`, and every new script added to `IMPLEMENTATION_PLAN.md`'s `commands` array.
- **The corpus is generated once and then frozen.** Re-generating it creates a different corpus. The builder refuses to overwrite without `--force`, and the check verifies the committed file's hash, not its reproducibility from a model.
- **Never report a point estimate without its interval and `n`.** `n = 0` (never fired) is reported as `null`, never as precision 1 or 0 — the same "two zeros" discipline as `recall: 0` vs `substrates: 0`.
- A new file under `core/src/` moves `artifact_files`: run `npm run build:hash` and update `spec/truth-boundary.json`'s count.

---

### Task 1: The repository states that gate precision is unmeasured

Needs no decision. Lands first, and alone it already retires an unstated gap.

**Files:** `scripts/check-truth-boundary.ts` (a probe beside `deliverySurface`), `spec/truth-boundary.json` (one entry), `Documentation/TRUTH_BOUNDARY.md` (regenerated), `test/truth-boundary.test.ts`.

- [x] **Step 1: Test first.** Assert that an entry `gate-precision-is-unmeasured` exists and that its `expect` keys are exactly `precision_corpus_exists` and `adjudicated_firings`. Run it and watch it fail.
- [x] **Step 2: Probe `precisionSurface(root)`.** It returns `{ precision_corpus_exists: existsSync("eval/precision-corpus.json"), adjudicated_firings: <count of entries in eval/precision-adjudications.json, or 0 when absent> }`.
- [x] **Step 3: Entry.** `expect: { precision_corpus_exists: false, adjudicated_firings: 0 }`. `does_not_establish` names the four facts above: the unmeasured status, `IMPLEMENTATION_PLAN.md:241`, the known `CLAIM_DISCIPLINE` false positive, and which detectors inherit it. It also cross-references `anchor-measures-its-own-registry`, whose text already concedes that a systematically wrong gate is wrong in its own ground truth. `crossed_when`: Task 5 lands.
- [x] **Step 4: Mutation proof.** Create an empty `eval/precision-corpus.json`; `check:truth` must fail naming the key. Remove it; exit 0.
- [x] **Step 5:** `npm run docs:truth`, then `verify`. Commit `docs: state that gate precision is unmeasured`.

**Done — `bfe4dc4`.** Two deviations from the steps above: the entry also carries `title`, `establishes` and `evidence`, which every `TruthEntry` has and this plan omitted (the same gap Phase 8's Task 1 had); and the entry's text states only what was re-verified on 11 September, so the catalog figures in *Negative results* are not in it. A follow-on commit `8f79314` corrected and pinned the entry count, which seven current-state documents stated as eight or nine while the spec held eleven and now twelve.

### Task 2: Build the corpus (needs D2)

**Files:** create `scripts/build-precision-corpus.ts` (script `build:precision-corpus`) and its output `eval/precision-corpus.json`.

- [ ] **Step 1: Read before writing.** `scripts/run-eval.ts`'s `--local` composition (it imports `OllamaProvider` at line 42) is the pattern to reuse. Do not write a second transport path.
- [ ] **Step 2: Behaviour.** For each `brief-pilot` input × chosen model, run the same stage `eval --local` runs and keep the output text **only when `demo_mode` is false**. Degraded output is not a compiled prompt; it is counted and excluded, and the count is recorded. Each record is `{ case_id, model, provider_model_fingerprint, output_sha256, text }`, and the file header records the models, the date, the decoding options, and the excluded count.
- [ ] **Step 3: Refusals.** Refuse without a reachable daemon, and refuse to overwrite an existing corpus without `--force`. Test both with an injected provider; a test must not need the daemon.
- [ ] **Step 4:** Run it for real, commit the corpus, and state the kept/excluded counts in the commit message.

### Task 3: Firings and adjudications, checked on every build (needs D1)

**Files:** create `scripts/check-precision.ts` (`check:precision`, added to `verify`), `eval/precision-adjudications.json`, and `test/check-precision.test.ts`.

- [ ] **Step 1: Tests first**, one per rule below, each shown failing. The adjudication file is `{ corpus_sha256, adjudications: [...] }`: `precisionSurface` in `scripts/check-truth-boundary.ts` already counts `adjudications`, so a different key leaves the truth entry reading 0 after firings are adjudicated.
- [ ] **Step 2: Rules.** The check reruns the registry over every corpus text and derives the set of firings `(output_sha256, gate_id, verdict)`. It fails when:
  - a firing has no adjudication (a gate change that starts firing somewhere new must be looked at, not absorbed);
  - an adjudication has no firing (stale — the same rule `divergence-allowlist.json` enforces);
  - an adjudication lacks `label`, `reason` or `adjudicated_by`;
  - the corpus file's hash differs from the one pinned in the adjudication file.
- [ ] **Step 3: Draft, then adjudicate.** Claude drafts `label` and `reason` for every firing; per D1, the owner confirms or overturns each one. The recorded `adjudicated_by` must be truthful.

### Task 4: The interval, in Core

**Files:** create `core/src/eval/precision.ts` and `core/test/precision.test.ts`.

- [ ] Write a pure `precisionInterval(tp, n, confidence)` returning `{ tp, n, point, lower, upper } | null` (`null` when `n = 0`): an exact Clopper–Pearson interval by bisection on the binomial CDF. Nothing in Core exports one today; `compare.ts`'s `exactTwoSided` is private and answers a different question. Tests pin known values, including `tp = n` (the upper bound is 1, but the lower bound is not) and `tp = 0`.
- [ ] Run `build:hash`, update the truth-boundary artifact count, then `verify`.

### Task 5: Report, and flip the truth entry

- [ ] `check:precision` prints, per gate and for the heuristic, `n`, TP and the exact 95% interval, plus the corpus composition. It prints **"never fired on this corpus"** for `n = 0`.
- [ ] Rewrite `gate-precision-is-unmeasured` into a measured entry. Pin `n` and the bounds, not a rounded point estimate. `does_not_establish` states the result is corpus-relative (D3) and that recall and precision still come from different corpora.
- [ ] If a gate's upper bound sits below an obvious bar, that is a finding to report, not something to fix in this phase. Fixing a gate is a divergence-allowlist decision with its own ADR.

## Out of scope

- Changing any gate. This phase measures; it does not tune.
- Spec §7, §8 and exception normalization (see the table above).
- Live hosted models. Local models only, at zero spend.
- Model comparison. `model-comparisons-are-unresolvable-here` stands, and a larger live suite is the phase after this one, once its detectors have a measured precision.

## Self-review

- **Verified, not assumed:** every count above was measured on 11 September 2026 against `a7e964e`: the 40/16/16/8 fixtures, the 196/195 catalog firings, the 11 detectors, the 100 brief-pilot cases, the 69 s local run, and the daemon being down.
- **Open:** Tasks 2–3 describe behaviour, not code, because the pipeline's local composition was located but not read line by line. The implementer reads `scripts/run-eval.ts` first.
- **Risk:** if D2's corpus produces very few firings for most gates, most intervals will be wide. That is the honest result, and the plan reports it rather than growing the corpus until the numbers look better.
