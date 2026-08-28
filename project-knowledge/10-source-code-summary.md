# Source code summary

~21,500 lines across `contracts/ core/ application/ adapters/ shells/ scripts/ test/`.
Comment density is high and deliberate: **comments record decisions, constraints, rejected
alternatives, and bugs a naive rewrite would reintroduce** — never what the code already says.

---

## Key modules

### Core (pure)

| Path | Exports | Notes |
|---|---|---|
| `core/src/gates/registry.ts` | `listGates`, `runGates`, `runGate`, `SOURCE_GATE_COUNT` | `runGate` throws on an unknown id; version is per **gate**, not per module |
| `core/src/gates/lint-primitives.ts` | `extractRuntimeManifest`, `extractSourceLedgerIds`, `halfUp2`, `estimateTokens` | the shared helpers; two carry the same fix for the same defect |
| `core/src/stages/pipeline.ts` | `planForContext`, `decideGateFeedback`, `formatGateCritique` | depth plan + the bounded feedback loop |
| `core/src/eval/compare.ts` | `compare`, `mcnemar`, `clusteredPaired`, `clusterOf`, `requiredAnchorSize` | every refusal path lives here |
| `core/src/eval/sizing.ts` | `floorDiscordant`, `minAttainableP`, `attainable`, `requiredPairedSize`, `resolvableDelta` | the corrected sizing rule |
| `core/src/eval/anchor.ts` | `buildAnchorCorpus`, `caught`, `scoreGateSet`, `discordanceRate`, `firingGates` | derived ground truth |
| `core/src/eval/generator.ts` | `rng`, `FRAGMENTS`, `generate`, `generateOptions` | shared by the oracle **and** the anchor |
| `core/src/eval/budget.ts` | `admitRun`, `cacheKey`, `plannedCalls`, `accrue`, `exceeds` | cost as a correctness constraint |
| `core/src/eval/judge-policy.ts` | `admitJudge`, `measuredBiases`, `unmeasuredBiases` | ordered refusals |
| `core/src/eval/perturbations.ts` | `expandCase` | seeded; writes `cluster_id` |
| `core/src/eval/probes.ts` | `PROBE_CORPUS`, `measureRecall`, `deadDetectors` | measures the instrument |
| `core/src/release/promote.ts` | `decidePromotion`, `rollbackOf` | 2 preconditions + 5 conditions |
| `core/src/routing/policy.ts` | `decideRoute`, `reduceRouteOutcome`, `admitCostJustification` | + validation refusals |

### Application (owns effects)

| Path | Role |
|---|---|
| `orchestrator.ts` | single-stage `decide → invoke → reduce` |
| `pipeline.ts` | eleven-stage runner; index loop so it can move **backwards** for feedback |
| `eval.ts` | `runSuite`, `configurationId`, `PinnedProvider`, `RecordingProvider` |
| `pipeline-eval.ts` | `runPipelineSuite`, `projectOutcome`, `isPipelineCase` |
| `cache.ts` | `MemoryCacheStore`, `CachingProvider` |
| `judge.ts` | `GuardedJudge`, `fenceCandidate`, `buildJudgePrompt` |
| `release.ts` | `promote`, `rollback`, `freezeBaseline`, `current` |
| `lint.ts` | `lint`, `worstVerdict` — precedence lives here so two Shells cannot disagree |

---

## Reusable patterns

### 1. Decide → invoke → reduce

```ts
// Core — pure. Returns a description of work, never performs it.
export function decide(input: CompileInput, run_id: string): GenerationRequest { … }
export function reduce(classified: GenerationResult | ProviderFailure): StageState { … }
```

```ts
// Application — owns the effect, classifies, hands the classified value back to Core.
const out = await provider.generate(stage.decide(input, run_id));
const next = stage.reduce(out);          // a failure reaches Core as a VALUE, not an event
```

Appears three times (provider loop, gate feedback, routing). If a proposed Core function needs
a callback to finish its job, it belongs one layer up.

### 2. Derive the guard; never let a caller supply it

```ts
// Weak — the guard is a field the caller fills in.
interface Comparison { equalization: { equalized: boolean } }

// Strong — computed from both runs' measured recall, and refuses when unmeasurable.
function deriveEqualization(input): { equalization: Equalization; refusal: string | null }
```

### 3. A refusal is a first-class verdict

```ts
verdict: "improved" | "regressed" | "inconclusive" | "refused"
```

Three distinct meanings that must never collapse: *the runs differ* · *we looked and saw
nothing* · *no evidence could have been produced*. Each refusal names what is missing.

### 4. No silent defaults where both options are defensible

```ts
on_exceed: "refuse" | "truncate_suite";   // required — no default
max_age_days: number;                     // required — a cadence nobody chose is the bug
lineage: "benchmark" | "development";     // required
```

### 5. The stale rule — an acknowledgment cannot outlive its defect

Used by `divergence-allowlist.json`, `catalog-known-defects.json`,
`pending-implementation.json`, `suite-sizing-acknowledgments.json`, `counted-claims.json`.

```
- an entry with no reason, or whose pinned count no longer matches, FAILS
- an entry for a condition that no longer holds is STALE and FAILS
```

So a "we know about this" note expires automatically when the thing it excuses is fixed.

### 6. Immutability by absence of a mutator

```ts
interface EvidenceStore {           // no update. no delete.
  put(record): Promise<void>;       // `wx` flag — a duplicate fails in the SYSCALL
  get(kind, id): Promise<EvidenceRecord | null>;
}
```

No read-modify-write means no cycle to interleave. Forces `supersedes` to point **forward**
and `current()` to be a **query**.

### 7. Generated artifacts with `--check`

```bash
node scripts/generate-capability-matrix.mjs           # write
node scripts/generate-capability-matrix.mjs --check   # fail if the committed file differs
```

Used by `docs:matrix`, `docs:manifest-spec`, `docs:truth`, `build:anchor`, `import:catalog`.
A document anyone can hand-edit asserts whatever its last editor believed.

Two refinements the later ones added:

- **Normalise line endings before comparing.** `check:catalog` was red on every Windows
  checkout for 195 byte-identical records because the committed file was CRLF and the
  rendered string LF. A generated-artifact check that fails for a reason unrelated to its
  subject trains people to ignore it.
- **Pin the expected value as well as deriving it.** `docs:truth` compares three things, not
  two: the declared scope, the derived reality, and the rendered document. A derivation alone
  reports whatever is true today and never objects, so nothing marks the moment a guarantee
  changed.

### 8. Widen the mechanism, not the exception

When a known exception has to be written broader than the decision it records, the exception
is not the thing to widen.

```jsonc
// Documents the divergence -- and also excuses a rounding regression on every input.
{ "also_matches": ".*" }

// Says what the decision actually covers.
{ "also_matches": ".*", "only_when_options": { "naiveTokens": { "lt": 120 } } }
```

An option a case does not carry is **not** satisfied; an unknown operator **fails** rather
than reading as true. Absence must never excuse by omission.

### 9. Pin a number in prose to a resolver

```jsonc
{ "document": "README.md", "pattern": "(\\d[\\d,]*) gates,",
  "resolver": "gates.ported", "reason": "…why being wrong here changes a decision…" }
```

Two rules: a pattern matching **nothing** fails as stale; **every** occurrence must agree.

> Gotcha: `([\d,]+)` also matches a bare comma, so `"gates, stages,"` captures `","`. Use
> `(\d[\d,]*)`. The checker caught this as *"captured no digits"*.

### 10. Errors that can be acted on

```ts
throw new RoutingPolicyInvalid(
  `max_escalations ${n} exceeds the ${tiers-1} escalation(s) ${tiers} tiers allow. ` +
  `A cap above what the ladder permits is a cap that never binds.`);
```

What failed · where · what was expected · why it matters.

### 11. Comments that earn their place

```ts
// Bounded on both ends deliberately. An open `+` here scanned quadratically against long
// non-matching runs — a 500 KB input hung for minutes. Real keys fit inside these caps
// comfortably; widening this reintroduces the hang.
const SECRET = /sk-[A-Za-z0-9]{20,128}/;
```

```ts
// The recorder sits INSIDE the cache deliberately. CachingProvider returns a hit without
// touching what it wraps, so a hit must not count as a provider call — outside,
// provider_calls would measure the suite's size rather than what it cost.
```

---

## Snippets worth lifting

**Exact two-sided binomial with log-space coefficients** (`compare.ts`) — the chi-square form
misbehaves exactly where a smoke suite lives:

```ts
const logAdd = (x, y) => x === -Infinity ? y : y === -Infinity ? x
  : Math.max(x, y) + Math.log1p(Math.exp(-Math.abs(x - y)));
// … sum the lower tail in logs so large n does not overflow the coefficients
const p = 2 * Math.exp(logSum + n * Math.log(0.5));
return p === 0 ? Number.MIN_VALUE : Math.min(1, p);   // 0 would claim impossibility
```

**Seeded PRNG (mulberry32)** — pure, so it can live in Core:

```ts
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

**Derived ground truth** (`anchor.ts`):

```ts
const before = firingGates(base, options);
const after  = firingGates(base + generate(rand), options);
const added  = [...after].filter(id => !before.has(id));
if (added.length !== 1) continue;        // exactly one, or the label means nothing
```

**Content-derived fence** (`judge.ts`) — the judge's input contains the model's own output, so
grading is prompt injection with the attacker already inside:

```ts
const nonce = sha256(candidate).slice(0, 16);
return `<<CANDIDATE ${nonce}>>\n${candidate}\n<<END CANDIDATE ${nonce}>>`;
```

**Boundary-aware generator fragments** — on thresholds, not in their middles:

```ts
() => `sk-ant-${"a".repeat(20)}`,   () => `sk-ant-${"a".repeat(19)}`,   // either side
() => "[ACK] ".repeat(8),           () => "[ACK] ".repeat(9),           // "more than 8"
() => `[INPUT_START_${"a".repeat(31)}]`, () => `[INPUT_START_${"a".repeat(32)}]`,
```

Every key-shaped string in this repository is a **synthetic fixture** used to test
`SECRET_LEAK_SCAN` — repeated-character bodies (`a`×20) and obvious digit runs behind the
real vendor prefixes. They are deliberately not reproduced here, so this file does not trip a
scanner in whatever repository it is pasted into.

All 66 commits then in history were scanned before the first push, and every commit since
has been reviewed the same way. No real credential has ever been committed, there is no
`.env` file, and no gitlink from the bundled `.git/` directory.

---

## Code conventions

- **ESM, `.js` extensions in imports** (NodeNext), relative paths across layers — never
  package names.
- **Named exports.** No default exports.
- Pure functions take plain data and return plain data; **injected clock and sleep** in the
  Application (`now: () => new Date(...)`, `sleep: async () => {}`) so runs are reproducible
  and fast.
- Classes only where identity or lifecycle matters (providers, stores, `GuardedJudge`).
- Errors are **named types** (`AnchorCorpusExhausted`, `RoutingPolicyInvalid`,
  `EvidenceMissing`, `JudgeRefused`), never bare `Error`.
- Section banners `/* ── name ─────── */` in longer files.
- Every module's header comment answers *why it exists* and *what would go wrong without it*.
