# Quality audit — System Prompt Builder · Pipeline

Audited: `v6.2.6-canonical`, then re-confirmed against `v6.2.7-canonical` and the
meta-history-stripped `SystemPromptBuilderPipeline.tsx`.
Every finding below was **reproduced by execution**, not by reading. Every fix is
pinned by a test.

**All 7 blocking defects and all 13 functional defects are present in v6.2.7 and in
the stripped variant.** v6.2.7's own changes (D4–D7, K1) are orthogonal to them and
are already satisfied by this rewrite.

---

## 1. Blocking defects — the pipeline could not reach a PASS verdict

A prompt that satisfies every substantive requirement of the blueprint was fed to
the linter. It returned **GATE_FAIL with four findings, all false positives**:

```
STATUS: GATE_FAIL
  FAIL RUNTIME_KEY_UNDECLARED  ISOLATION_NONCE, PLAYER_TIER   <- both ARE declared
  FAIL QUTM_CEILING            Cost ratio 5.6x exceeds 4x     <- unsatisfiable by short briefs
  FAIL ADVERSARIAL_RESILIENCE  Missing: ledger, source        <- prompt cites nothing
  FAIL JSON_SCHEMA_MALFORMED   unquoted keys; unescaped newline <- JSON.parse says valid
```

### B1 · Gate 2 could never see the manifest it audits
The scanner required `#` before `Runtime Variables`, but `BLUEPRINT` emits that line
as bare prose. `manifest` was always `""`, so **every correctly declared runtime key
read as undeclared**. Any prompt using `[[ISOLATION_NONCE]]` — which Gate 12 *requires* —
was unpassable.
**Fix:** `extractManifest()` accepts the heading with or without hashes, bounded by
the next heading or `BLOCK` marker. Same treatment for the source ledger.

### B2 · Gate 16 rejected all pretty-printed JSON
The unescaped-newline pattern matches across the gap between two adjacent string
literals, so `{\n "a": "x",\n "b": 2\n}` matched. Because heuristics ran **before**
`JSON.parse`, the parse never ran and valid JSON was reported malformed. A colon
inside a string value (`"a, b: c"`) separately triggered "unquoted keys".
Verified: heuristic flags `true`, `JSON.parse` says valid.
**Fix:** `diagnoseJsonBlock()` parses first and is authoritative; the patterns only
run on a block that already failed, to turn a terse engine message into a useful one.

### B3 · `fill()` aborted stages on ordinary model output
The unresolved-placeholder check ran on the **rendered** text. Deconstruct is
explicitly instructed to describe output schemas, so its output routinely contains
`{status, message}`. Reproduced: a realistic spec makes every downstream build stage
throw *"Template contains unresolved placeholders."*
**Fix:** `unknownTemplateVars()` validates the **template**, before substitution, and
names the offending token.

### B4 · Stakes escalation silently skipped stages
`stakesTouched` permanently froze the stage plan after any manual selection.
Reproduced: pick `LOW`, then write a brief mentioning "medical diagnosis" —
UI reports `depth: COMPREHENSIVE · escalated by triage`, but the plan stays `TINY`.
`lockedOn` rescues Harden and Critic; **Critique and Refine stay off**, so the
"never shortcut" guarantee is violated exactly where it matters.
**Fix:** re-plan keyed on the last applied *effective* depth. `stakesTouched` removed.
Pinned by a mounted-component test.

### B5 · Routing dropped the HIGH floor on short briefs
The `< 500 chars` shortcut was evaluated **before** the evidence-reconciliation branch,
making that branch unreachable for typical briefs. A 72-character brief asking to
reconcile conflicting cited sources returned `floor: null` instead of `HIGH`.
**Fix:** all floor-bearing branches now precede the length shortcut.

### B6 · Gate 15 taxed every non-citing domain
It demanded the literal words `ledger` and `source` in any GUARDED+ prompt, regardless
of whether the prompt cites anything — an unclearable failure for a support agent.
**Fix:** ledger/source surfaces are required only when citations are actually present
(reusing Gate 4/5's detection). `input` and `anti-override` remain unconditional.

### B7 · Gate 13 was unsatisfiable for short briefs
The ratio compares compiled tokens to *brief* tokens; a system prompt is necessarily
many times longer than a one-line brief. Measured 5.6× against a 4× ceiling for a
correct prompt, and **318×** when the brief was empty.
**Fix:** the gate applies only above a meaningful baseline (120 brief tokens) and an
absolute floor (600 prompt tokens), so it still bites on genuinely bloated output.

---

## 2. Defects found by the new test suite

Two more surfaced only once tests existed — both present in all three input files.

### N1 · The `c++` domain branch was dead
The v6.2.6 header claims this was fixed. The *syntax error* was fixed; the branch
still never matched. `\b` after `+` requires a word character to follow, and `+` and
the following space are both non-word, so no boundary exists:

```
/\b(cod(?:e|ing)|build|c\+\+|…)\b/i.test("our c++ engine")  ->  false
```

**Fix:** `c++` gets its own leading-boundary branch. Verified across every alternative
in every pattern; this was the only genuinely unreachable one.

### N2 · Retrieval briefs matched zero retrieval techniques
`retrieved`, `documents`, `corpus` and `grounded` produced no *sharp* (tag/name) hit,
so `matchTechniques` returned nothing for retrieval-focused briefs — while
`DOMAIN_PATTERNS` and Gate 8 both handle them. Measured across seven representative
briefs, adding the inflections is a **pure gain: one brief 0 → 3 matches, six unchanged**.

---

## 3. Functional and quality defects

| # | Defect | Fix |
|---|---|---|
| F1 | `Btn` never accepted `title`; 4 tooltips silently dead. No `type="button"` | Props forwarded; `type` set |
| F2 | Banner said v6.2.7, UI said v6.2.5 (drift widened each release) | Single `APP_VERSION`, test-pinned |
| F3 | `pipelineRevision` write-only; 2 wasted renders per run | Removed (matches v6.2.7's K1) |
| F4 | "RERUN N STALE" ran a full reset, discarding valid upstream work | Real partial rerun from the first stale stage |
| F5 | Ctrl/Cmd+R hijacked browser reload, and `preventDefault` fired even when nothing would run | Ctrl/Cmd+Enter, guarded on the action being enabled |
| F6 | Vault on `window.storage`, history on `localStorage`; failures swallowed | One adapter, primary-then-fallback, reports write failure |
| F7 | A failed stage still archived the prompt and burned a revision | Revision committed only on success |
| F8 | SAVE enabled by `canSave` but `saveFinal` also needed `verdict` — click did nothing | Both conditions gate the button |
| F9 | Vault loaded from storage without shape validation | `sanitizeVaultEntries()` |
| F10 | `{v.brief}…` appended an ellipsis unconditionally | `truncateLabel()` |
| F11 | Markdown export emitted unclosed literal `<del>`/`<ins>` outside the code fence | Backticked |
| F12 | `fetchModels` had no race guard; a stale response could clear a newer error | Request-id guard |
| F13 | `prompt-inversion-analysis` (3 entries) unreachable by both matchers | Added to `COMPILE_CATEGORIES`; test asserts full reachability |

**Performance:** Gate 3's backreference scan measured 0.28 s / 100 KB and 0.56 s / 200 KB
on adversarial input, synchronously on the UI thread — bounded, but a visible freeze.
Now windowed to 20 KB (structural filler appears early or not at all); test asserts
< 150 ms on 200 KB. Diffs are memoised; template edits invalidate once per session
rather than per keystroke; in-flight requests abort on unmount.

**Accessibility:** provider chips, stakes chips, stage cards and enable toggles were
`div onClick` — unreachable by keyboard. Now real buttons with `radio`/`switch` roles
and labels; `<div>` no longer nests inside `<pre>`; overlays close on Escape.

**Types:** `@ts-nocheck` removed. The file now compiles clean under `strict` with
`noUnusedLocals` and `noUnusedParameters`. This is the structural answer to v6.2.7's
D6 — the return shapes of `withTimeout`, `withRetry` and `matchDomainPattern` are
now *types* rather than JSDoc prose, so they cannot drift out of sync again.

---

## 4. Verified correct — deliberately unchanged

Checked and left alone, to avoid changing working behaviour on suspicion:

- **Catalog integrity.** 195 entries, no duplicate ids or names, no malformed entries.
  Copied byte-for-byte and asserted identical to the input — D1 is the failure mode
  this rewrite most had to avoid.
- **Substring matching in `matchTechniques`.** It looks sloppy but supplies useful
  stemming; of 2,410 substring-only matches, most are singular/plural pairs
  ("thought"→"thoughts"). Word-boundary matching would be a regression. The IDF floor
  already bounds the false positives. **Not changed.**
- **`withTimeout` / `sleep` listener cleanup.** No leak on any path.
- **Abort vs. timeout classification** in `callProvider` — correct as written.
- **HTML comparison export** — every interpolation escaped; XSS-safe.
- **Import validation** in `importRevisionHistory` — already sound.
- **`canSave` operator precedence** — correct; parenthesised for readability only.
- **Plain closures over `useCallback`** — consistent with the lineage's D3 rejection;
  handlers are recreated per render and cannot capture stale state.

---

## 5. Verification performed

| | |
|---|---|
| Typecheck | `tsc --strict --noUnusedLocals --noUnusedParameters` — 0 errors (checker sanity-verified by injecting a deliberate error) |
| Tests | 92 passing: 75 logic + 17 mounted-component |
| Component | Mounts in jsdom; full 9-stage offline run reaches **SHIP** with the linter reporting *all gates green* |
| Catalog | Byte-identical to input; 195 entries |
| Regressions | Every defect above pinned by a `regression:` test |
| Reproducibility | Full pipeline re-run from a clean directory |

The logic tests import from `pipelineLogic.ts`, which `extract-logic.mjs` **derives from
the shipped component** and fails loudly if its anchors move — so the suite exercises
the real source, never a transcribed copy.

---

## 6. Worth your scrutiny

Three judgement calls, flagged rather than buried:

1. **Gate 13 and Gate 15 were re-scoped, not merely repaired.** They now fire in
   strictly fewer situations. If either was intended as a blunt style tax rather than
   a correctness check, revert those two blocks — the tests will tell you what breaks.
2. **`COMPILE_CATEGORIES` gained `prompt-inversion-analysis`.** Those three techniques
   were unreachable. If that was deliberate, drop it and relax the reachability test.
3. **The Ctrl+R shortcut moved to Ctrl/Cmd+Enter.** A behaviour change, chosen because
   overriding browser reload — and doing so even when nothing would run — is worse.
