# Brief-pilot measurement — findings

**Date:** 3 September 2026
**Suite:** `eval/brief-pilot.json` (100 cases, seed 1)
**Models:** `phi4-mini:latest`, `lfm2.5-thinking:latest`
**Trials:** 3 each (single-trial runs with pre-warming; see below)
**Transport:** local (Ollama)

---

## Verdict: does not pay

The warm comparison is **inconclusive**: Δ = 0.4 pp, p = 0.5716, 28 discordant clusters of 100.
Both "does not pay" criteria from the design spec are met:

- **Constant fraction 72 %** — above the 58.3 % (7/12) threshold.
- **Implied size 137,356 cases** — far above the 341-case baseline.

phi4-mini and lfm2.5-thinking (warm) score equivalently on this suite (69.3 % vs 69.7 %,
spread 2–3 pp for each). Concentrating cases on the four dimensions sub-project 1 found
discriminating did not open a measurable gap for this pair.

Sub-project 2 (provider-facing anchor) is not being built from this result. The finding is
recorded in the truth boundary (`spec/truth-boundary.json`, entry
`model-comparisons-are-unresolvable-here`).

---

## Warm run summary

Six total runs: phi4-mini (standard sweep, 3 trials) and lfm2.5-thinking (3 separate
single-trial runs, each pre-warmed — see [Cold-start anomaly and workaround](#cold-start-anomaly-and-workaround)).

| Model | Trial | Seconds | Passed | Score | Tokens in / out |
|---|---|---|---|---|---|
| phi4-mini:latest | 1 | 1,274 | 70/100 | 0.700 | 90,804 / 64,596 |
| phi4-mini:latest | 2 | 1,259 | 70/100 | 0.700 | 90,804 / 63,300 |
| phi4-mini:latest | 3 | 1,220 | 68/100 | 0.680 | 90,804 / 61,866 |
| lfm2.5-thinking:latest | 1 (warm) | 641 | 68/100 | 0.680 | 101,367 / 188,496 |
| lfm2.5-thinking:latest | 2 (warm) | 686 | 71/100 | 0.710 | 101,367 / 185,126 |
| lfm2.5-thinking:latest | 3 (warm) | 684 | 70/100 | 0.700 | 101,367 / 192,021 |

All three warm lfm2.5 trials show 101,367 input tokens — confirming thinking-mode activation.

---

## Compare-models report (warm data)

### Score stability

```
phi4-mini:latest       0.700  0.700  0.680    mean 0.693  spread 0.020
lfm2.5-thinking        0.680  0.710  0.700    mean 0.697  spread 0.030
```

### Constant cases

72 of 100 (72 %) are constant across both models — they cannot distinguish the two.

| Dimension | phi4 rate | lfm rate | Discordant |
|---|---|---|---|
| secret (25 cases) | 88.0 % | 80.0 % | 8/25 (32 %) |
| unicode (25 cases) | 17.3 % | 6.7 % | 8/25 (32 %) |
| placeholder (25 cases) | 72.0 % | 72.0 % | 6/25 (24 %) |
| structure (25 cases) | 100.0 % | 100.0 % | 6/25 (24 %) |

### Pilot metrics

| Metric | Value |
|---|---|
| p_d (discordance rate) | 0.28 |
| Δ (mean gap) | 0.4 pp |
| McNemar p | 0.5716 (inconclusive) |
| Implied size at 80 % power | 137,356 cases |
| Constant fraction | 72 % |
| Verdict | does not pay |

---

## Cold-start anomaly and workaround

An earlier run (pre-warm) produced confounded data. The first lfm2.5-thinking trial after a
force-unload used only 31,388 input tokens (vs 101,367 in subsequent trials) — the thinking
context was not activated on the cold first call. That trial scored 23/100; the remaining two
scored 66/100 and 71/100.

The anomaly made the three-trial mean 53.3 % and the apparent Δ 16.0 pp (p = 0.0000 — a
pure artifact). Removing trial 1 collapsed the gap to 0.8 pp and p = 1.000.

**Fix:** pre-warm lfm2.5-thinking with a dummy API call before each trial to activate the
thinking context. Confirmation criterion: input token count equals ~101 K on trial 1.

The warm runs confirm the fix — all three warm trials show 101,367 input tokens and consistent
68–71 % scores, with spread matching phi4-mini's 2 pp spread.

The confounded data is not used in any reported figure and is not recorded in the truth
boundary. It is retained here as documentation of the measurement methodology.

### Confounded run summary (for reference only — do not cite)

| Model | Trial | Seconds | Passed | Score | Tokens in / out |
|---|---|---|---|---|---|
| lfm2.5-thinking:latest | 1 (cold) | 215 | 23/100 | 0.230 | **31,388 / 59,460** |
| lfm2.5-thinking:latest | 2 | 652 | 66/100 | 0.660 | 101,367 / 183,810 |
| lfm2.5-thinking:latest | 3 | 695 | 71/100 | 0.710 | 101,367 / 192,476 |

---

## What the suite design established

Despite the "does not pay" verdict, the design goal of the brief-pilot was achieved — the constant
fraction was reduced from 83 % (compile-smoke) to 72 %, and the discordant pairs are spread
across all four dimensions. The suite is a functioning instrument; the measured pair simply
does not have a detectable gap on it.

The four discriminating dimensions from sub-project 1 still hold their ordering:
- Structure cases are the easiest for both models (100 % vs 100 % on warm lfm2.5).
- Unicode cases are the hardest for both (17 % vs 7 % mean).
- Secret and placeholder are mid-range (80–88 % and 72 % for both models).

The brief-pilot design spec's prediction that concentrating on model-sensitive dimensions
"could go either way" proved correct: p_d rose (0.28 vs compile-smoke's 0.2778), but Δ
collapsed to 0.4 pp — smaller than the noise floor resolves, even at 341 cases.
