# Brief-pilot measurement — findings

**Date:** 3 September 2026 (updated)
**Suite:** `eval/brief-pilot.json` (100 cases, seed 1)
**Models:** `phi4-mini:latest`, `lfm2.5-thinking:latest`
**Trials:** 3 each (obtained in separate single-trial runs after daemon instability)
**Transport:** local (Ollama)

---

## Verdict: measurement confounded

All six runs reached a model and produced real output. The comparison is **not valid**: lfm2.5-thinking's first trial ran without activating its thinking tokens, which halved its input context (31 K tokens vs 101 K in trials 2–3) and dropped its score from 66–71 % to 23 %. That single anomalous trial drives the entire observed gap between models.

- **With trial 1 included:** Δ = 16.0 pp, p = 0.0000, significant. This is an artifact.
- **Without trial 1:** Δ = 0.8 pp, p = 1.000, inconclusive. The models are statistically indistinguishable.

A new truth-boundary entry requires verdict "does not pay". The verdict here is "measurement confounded" — the condition is not met. No entry is added until a valid comparison is run.

---

## Run summary

| Model | Trial | Seconds | Passed | Score | Tokens in / out |
|---|---|---|---|---|---|
| phi4-mini:latest | 1 | 1,274 | 70/100 | 0.700 | 90,804 / 64,596 |
| phi4-mini:latest | 2 | 1,259 | 70/100 | 0.700 | 90,804 / 63,300 |
| phi4-mini:latest | 3 | 1,220 | 68/100 | 0.680 | 90,804 / 61,866 |
| lfm2.5-thinking:latest | 1 | 215 | 23/100 | 0.230 | **31,388 / 59,460** |
| lfm2.5-thinking:latest | 2 | 652 | 66/100 | 0.660 | 101,367 / 183,810 |
| lfm2.5-thinking:latest | 3 | 695 | 71/100 | 0.710 | 101,367 / 192,476 |

---

## The cold-start anomaly

lfm2.5-thinking:latest trial 1 used **31,388 input tokens** across 100 cases (314 tokens/case). Trials 2 and 3 used **101,367 input tokens** (1,014 tokens/case) — 3.2× more — and the counts are identical across trials 2 and 3, confirming this is not noise. phi4-mini shows 90,804 input tokens in all three trials.

The pattern is consistent with lfm2.5 not activating its thinking context on the first (cold) load. The thinking model allocates a reasoning scratchpad in the system prompt or context that is absent until the model has been called once and has its full initialization in place. Trial 1 (force-unloaded, then re-loaded cold) ran in non-thinking mode; trials 2–3 ran with full thinking context.

Output token counts confirm this: 59,460 out in trial 1 (594 tokens/case) vs 183–192 K out in trials 2–3 (1,838–1,925 tokens/case). The model simply generated much less reasoning in trial 1.

Score consequence:

| Condition | phi4 mean | lfm mean | Δ | McNemar p |
|---|---|---|---|---|
| All 3 trials | 69.3 % | 53.3 % | 16.0 pp | 0.0000 (significant — **artifact**) |
| lfm trials 2–3 only | 69.3 % | 68.5 % | 0.8 pp | 1.000 (inconclusive) |

The significant result is entirely produced by trial 1. When lfm2.5-thinking uses its thinking tokens, it matches phi4-mini to within 0.8 pp on this suite.

---

## Compare-models report (all 3 trials — for reference only)

The full report is retained for completeness. It must not be read as evidence about model capability, because the comparison arms were not running the same model configuration.

### Score stability
```
phi4-mini:latest       0.700  0.700  0.680    mean 0.693  spread 0.020
lfm2.5-thinking        0.230  0.660  0.710    mean 0.533  spread 0.480
```

### Constant cases
42 of 100 (42 %) are constant across both models — they cannot distinguish the two.

| Dimension | phi4 rate | lfm rate | Discordant |
|---|---|---|---|
| secret (25 cases) | 88.0 % | 70.7 % | 13/25 (52 %) |
| unicode (25 cases) | 17.3 % | 6.7 % | 12/25 (48 %) |
| placeholder (25 cases) | 72.0 % | 60.0 % | 15/25 (60 %) |
| structure (25 cases) | 100.0 % | 76.0 % | 18/25 (72 %) |

Direction: phi4 wins 50 discordant pairs, lfm2.5 wins 8. When the anomalous trial 1 is removed, the direction reverses: lfm wins the majority of the 25 remaining discordant cases.

### Pilot metrics (as required by the design spec — for reference only)

| Metric | With trial 1 | Without trial 1 |
|---|---|---|
| p_d (discordance rate) | 0.58 | 0.25 |
| Δ (mean gap) | 16.0 pp | 0.8 pp |
| Implied size at 80 % power | 178 cases | > 30,000 cases |
| Constant fraction | 42 % | ~75 % (estimated) |

The "implied size 178" figure is based on an invalid comparison and must not be used to size sub-project 2.

"What 100 cases resolve at 80 % power" (from the comparator, using STATED_ASSUMPTIONS d = 0.5): **19.8 pp**.

---

## What the suite design established

Despite the confounded measurement, the suite's structure is informative:

- 42 % constant cases vs 83 % for compile-smoke — the brief-pilot has more discriminating cases by design. This is the intended improvement.
- Unicode cases are the hardest dimension for both models (phi4 17 %, lfm 7 % mean in thinking mode), consistent with sub-project 1's finding that `unicode-and-crlf-survive` varies the most across models.
- When lfm2.5-thinking runs in thinking mode, both models score 68–70 % on the brief-pilot suite — the suite is harder than compile-smoke (which both models score ~80 %) but does not strongly separate this specific pair.

---

## Why the daemon produced trial 1 anomalies across all lfm2.5 runs

Three separate single-trial sweep runs of lfm2.5 were needed because the daemon degraded (0 s, 0 tokens) for every trial after the first in any multi-trial run. This was diagnosed as GPU memory pressure: after a 215 s / 100-case trial at ~2 s/case, Ollama evicts the model mid-sweep. The cold-start anomaly is a consequence of the isolation workaround: each trial starts with a fresh model load, and that first load does not activate the thinking context.

Pre-warming the model with a dummy call before the sweep would likely avoid this, but has not been tested.

---

## Next steps

**To resolve the cold-start anomaly and get a valid measurement:**

1. Before starting the lfm2.5 sweep, pre-warm the model with a dummy prompt:
   ```
   ollama run lfm2.5-thinking:latest "ping"
   ```
   or verify the token count of the first real trial matches subsequent ones.
2. Run the sweep and confirm all trials show ~101 K input tokens for lfm2.5.
3. Run `compare:models` on the combined data.
4. Report the verdict.

Alternatively: if phi4-mini and lfm2.5-thinking score equivalently when lfm runs in thinking mode (~0.8 pp gap), the brief-pilot may not resolve any meaningful difference between this specific pair regardless of warm-start. In that case, the right next experiment is a pair where a larger gap is expected (e.g., phi4-mini vs gpt-oss:20b).

**Sub-project 2 sizing:** No anchor size can be derived from this measurement. The pilot metric that was supposed to set sub-project 2's size (implied size from observed Δ and p_d) is invalid. Sub-project 2 remains blocked on a clean measurement.
