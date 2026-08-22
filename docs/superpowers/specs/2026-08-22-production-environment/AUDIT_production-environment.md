# Phase 3 — Adversarial audit

Attacks the artifact, then the skeleton, then the register, with equal force. Every defect carries the command that reproduces it. Cleared findings are reported too, because an audit with only hits has unknown calibration.

---

## Pass A — Run everything

| Command | Result |
|---|---|
| `npm run verify` | exit 0 |
| `npm test` | 437 passed / 437, 15 files |
| `npm run differential` | 2,720 verdicts, full agreement, 16/16 ported |
| `npm run check:plan` | 15 claims verified; `catalog 195/172 · CI none` |
| `npm run check:corpus` | **does not exist** |

Nothing fails. That is the finding: the suite is green while three documented counts are wrong, which places the defect outside every existing checker's scope.

---

## Pass B — Prose against data

### B-1 — The corpus size is stated three times and is wrong every time · **CONFIRMED**

```bash
find PDF -name "*.pdf" | wc -l                                                    # 661
find PDF -name "*.pdf" -exec md5sum {} \; | awk '{print $1}' | sort -u | wc -l    # 599
grep -c "673-paper" Documentation/0008-evaluation-first-environment.md            # 3 occurrences
```

`ADR-0008` states "673-paper corpus" three times; `PROMPT_ENGINEERING_ENVIRONMENT.md` states "~700 papers". The tree holds 661 files, of which 62 are byte-identical duplicates — **599 independent sources**. Duplicates verified identical by md5, so this is over-counting, not mislabelling.

Severity: moderate. No conclusion in either document depends on the difference between 599 and 673, but the number is the warrant for "reading ~700 papers against this system, the useful findings collapse into two statements," and a warrant nobody can reproduce is not one.

### B-2 — The catalog is 195 records; four documents say 180 · **CONFIRMED**

```bash
python -c "import json;d=json.load(open('core/src/catalog/techniques.json'));print(len(d if isinstance(d,list) else d.get('techniques')))"   # 195
grep -rn "180 " Documentation/*.md | wc -l                                          # 4 sites
```

`check:plan` already reports `catalog 195/172` — so the repository *knows*, and the ADRs simply are not read by the thing that knows.

### B-3 — The judge routing partition is stale in all four numbers · **CONFIRMED, and this one bites**

```bash
python -c "import json,collections;d=json.load(open('core/src/catalog/techniques.json'));print(collections.Counter(r['verification_status'] for r in d))"
# Counter({'verifier-checkable': 151, 'unverifiable-by-text': 34, 'judge-checkable': 10})
```

Documented: `verifier-checkable 137, judge-checkable 8, unverifiable-by-text 35` (total 180). Measured: **151 / 10 / 34** (total 195). ADR-0008 names this partition "the routing rule" for what may reach a judge. A stale routing rule is not a cosmetic count — it is the load-bearing number in Part 5, and `judge-checkable` grew by 25%.

### B-4 — `REVISIONS_AND_EXPORTS.md` documents fields that do not exist · **CONFIRMED**

```bash
grep -n "input_ref\|output_ref" contracts/index.ts   # no matches
grep -n "input_ref" Documentation/REVISIONS_AND_EXPORTS.md   # documented as a RevisionEntry field
```

Also: its `status` table lists four values; the contract has five (`SKIPPED` added 21 Aug). Same class as B-1–B-3.

### B-5 — Cleared: the stage and gate counts are accurate

`check:plan` verifies `gates 16/16 · stages 11/11 · schemas 13 · adapters 2 · shells 1`, and `check:stages` independently verifies the stage list, depth plan, templates and verbatim system prompts. Every count *inside* `check:plan`'s scope is right. The defect is exclusively at the boundary of that scope — which is what makes it one defect rather than four.

**Class: prose lagging measurement.** Four instances, one cause: `scripts/check-plan.mjs` reads a single file. Fixing four numbers leaves the fifth to drift. → Part 1.

---

## Pass C — Attack the skeleton

### C-1 — Part 7 was nearly specified as a new mechanism when one already exists · **corrected in place**

I drafted the clustering refusal as a new capability. It is not:

```bash
grep -n "probe_corpus_version" core/src/eval/compare.ts   # line 85: refuses when they differ
```

`compare()` already returns `refused` with a `refusal_reason` when two runs' recall was measured under different probe corpora, and `inconclusive` where a single run pair cannot support a claim. Part 7 therefore **extends an existing refusal path** rather than introducing one. The corrected framing is in SPEC §7 and matters: a reviewer can check the new refusal against a working precedent instead of a proposal.

### C-2 — "The judge is never the model under test" is written but not wired · **CONFIRMED**

```bash
grep -n "judge_id" contracts/judge-verdict.schema.json   # free string, minLength 1
grep -rn "judge" application/src/ | grep -v "^.*eval.ts:.*grader_id: null"   # no adapter, no check
```

ADR-0008 lists it under **Enforcement**. Nothing enforces it, because nothing judges yet. That is defensible today and becomes a defect the moment Part 5 lands — so the check must ship *with* the adapter, not after it. `judge_id` alone cannot express the constraint: no field carries model family.

### C-3 — `budget_exceeded` is a required field with no enforcement path · **CONFIRMED**

```bash
sed -n '189,196p' application/src/eval.ts
#   cost: { tokens_in: 0, tokens_out: 0, provider_calls: …, cache_hits: 0, usd: 0, budget_exceeded: false }
grep -rn "budget" application/src/ | grep -v schema   # eval.ts:195 literal false; eval.ts:218 budget: null
```

Every field is a literal. Today that is *honest* — the suites pin provider responses, so spend really is zero and no budget was declared. But ADR-0008 says "budget belongs in the request contract and is **enforced, not observed afterwards**," and there is no code path that could enforce it. `TOKEN_BUDGET` in Core is a different thing: it checks a compiled prompt's estimated size, not a run's spend.

Consequence for the plan: Part 3 must land enforcement **in the same change** as real provider calls. If real calls land first, `budget_exceeded: false` silently becomes a false claim rather than a true one — the exact "cost-driven degradation without an alert" failure the field exists to catch.

### C-4 — Keyed fingerprints are documented, unkeyed in code · **CONFIRMED**

```bash
grep -n "sha256" application/src/orchestrator.ts   # bare sha256, no key
grep -n "keyed" Documentation/PRIVACY_AND_SECURITY.md   # "Fingerprints in events are keyed, not bare digests"
```

`PRIVACY_AND_SECURITY.md` rule 4 gives the reason — an unkeyed hash of a short or templated prompt is dictionary-attackable by anyone holding the event stream. The code uses bare `sha256`. Out of scope for this specification's parts, in scope for its register: recorded in SPEC §7 with a closing condition.

### C-5 — Two of my own proposed parts failed the admission test and were cut

The test from I-1 is *what silence does this break?*

- **A technique recommender over the 195 catalog records.** Cut. It breaks no silence and I-2 says it would confidently recommend the losing side of an inversion. The catalog stays a hypothesis space.
- **An OTel `gen_ai.*` exporter as the primary event contract.** Cut to a pinned *mapping* only, per E-6. Adopting unstable names as the internal contract manufactures a new silent failure — a renamed attribute that stops populating without erroring.

Reporting these matters: a skeleton where nothing was excluded had a decorative admission test.

### C-6 — My exclusion of `PDF/RAG` was nearly wrong · **corrected in place**

I excluded 134 documents by directory name. Checking before committing to it:

```bash
grep -rn "RAG_SHIELD_GAP\|DELIMITER_ENTROPY\|QUTM_CEILING" core/src/gates/registry.ts   # all three present
```

Three shipped gates exist *because of* that literature, and `retrieval_config` is already a component of `Configuration`. The exclusion was narrowed to "excluded as a subsystem, retained as gate provenance." Exclusion by keyword similarity is a heuristic and this is what auditing one looks like.

### C-7 — Part 11 is excluded by an invariant I stated myself, and I nearly scheduled it

I-4's anchored-authority result requires the anchor to be outside the optimizer's write surface *and* sized. `requiredAnchorSize(0.02)` ≈ **3,400**; the largest suite here has **14 cases**. Part 11 cannot certify anything in this repository today. It is specified and explicitly unscheduled — see SPEC §6 entry criteria.

---

## Pass D — Weaken my own inferences

| Inference | Stated as | Should be |
|---|---|---|
| "Gate messages are sufficient reflective feedback for GEPA-style improvement" | licensed by E-2 | **Hypothesis.** GEPA's results are on QA and code benchmarks. The mechanism transfers; the effect size is unmeasured here. Part 4's DONE WHEN measures the sign rather than assuming it. |
| "Per-stage validation mitigates the depth cliff" | the purpose of the architecture | **Hypothesis, and the most valuable one available.** I-3 measured *unvalidated* chains. That validated chains behave differently is plausible and untested. This repository is unusually well placed to measure it once Part 3 exists — and if it is false, an eleven-stage pipeline is the wrong shape. |
| "Clustered SEs will be up to 3× larger here" | from E-4 | **Bounded, not predicted.** 3× is that paper's observed range, not a constant. Part 7's value does not depend on the magnitude — the refusal is correct at any magnitude above 1. |
| "599 is the independent-source count" | measured | Accurate as *distinct file contents*. It does not detect the same paper under two different filenames or a v1/v2 pair, so 599 is an **upper bound** on independent sources. Stated as such in SPEC §1. |
| "Prefix caching will hit because `COMPILER_SYSTEM` is frozen" | verified | Verified for the *system* segment only. Whether the full prefix (`tools → system → messages`) is stable per stage is untested — the first `cache_read_input_tokens` reading settles it, and Part 3's DONE WHEN requires a non-zero one. |

---

## Omissions — absent from both prior phases

1. **Threat model for the judge adapter.** A judge is a new provider call whose *input contains the model's own output*. That is an injection surface: output crafted to contain rubric-shaped text can steer its own grade. Mitigation belongs in Part 5 — delimiter discipline, and the existing `DELIMITER_ENTROPY` gate applied to the judge prompt, not only the compiled prompt. Neither phase mentioned it.
2. **Rollback.** `RELEASE_OPERATIONS.md` covers build reproducibility, not reverting a promotion. E-5 supplies the primitive: promotion is a label repoint, so rollback is a repoint. Added to Part 8.
3. **Interaction between the new checks.** `check:claims` (Part 1) will read documents that `check:corpus` (Part 0) writes counts into. Ordering matters: corpus manifest first, then claims, or claims will verify against a stale manifest. Recorded in SPEC §5 as an interaction, not left to script order.
4. **Who populates the new fields.** `cluster_id` is written by the perturbation expander, not by suite authors — otherwise every hand-written case invents its own clustering and the statistics become author-dependent. Recorded in SPEC §3, Part 6.
5. **Concurrency.** I-4's disjoint-ownership proposition warns that file-level locking serializes the write but not the read–compute–write cycle. `storage-local` does read-modify-write per append, 11× per run. Two concurrent runs are already a hazard, and Part 2's evidence plane must not repeat the shape.
6. **What makes the whole thing a success.** Added as SPEC §8.

---

## Defect classes

Three, as predicted, and each generalizes:

| Class | Instances | The one fix |
|---|---|---|
| **Prose lagging measurement** | B-1, B-2, B-3, B-4 | Part 1 — one checker over all documents, not four edits |
| **A guarantee written but not wired** | C-2 (judge ≠ model under test), C-3 (budget), C-4 (keyed fingerprints), `markStale` lineage, `input_ref`/`output_ref` | Ship the check *with* the capability, never after. Encoded as an entry criterion on every part in SPEC §6 |
| **A rule stated more broadly than implemented** | `check:plan`'s name vs its one-file scope; "storage adapters are the only place content persists" when none does | Probe each guard in *every place it is believed to cover*, measured by exit code |

**My own draft has the same classes, and one is already visible.** `check:claims` (Part 1) is a name broader than any implementation I can honestly promise: it will verify *numeric* claims resolvable to a command, not prose claims. Named that way in SPEC §3 — `check:counts` would be the honest name, and the specification uses it.
