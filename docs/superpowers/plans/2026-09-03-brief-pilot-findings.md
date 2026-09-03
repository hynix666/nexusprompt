# Brief-pilot measurement — findings

**Date:** 3 September 2026
**Suite:** `eval/brief-pilot.json` (100 cases, seed 1)
**Models intended:** `phi4-mini:latest`, `lfm2.5-thinking:latest`
**Trials:** 3 each
**Transport:** local (Ollama)

---

## Verdict: measurement invalid

Only 1 of 6 scheduled runs reached a model. The Ollama daemon stopped responding after
`phi4-mini:latest` trial 1; the five remaining runs degraded immediately (0 seconds,
0 tokens, all cases scoring FAIL via the demo-mode placeholder). No comparison between
models is possible from this data.

The `compare-models` report nominally shows `significant` with `p = 0.0000` — this is an
artifact of the failure mode, not a finding about model behaviour. When one arm of a McNemar
comparison scores every case via demo mode, every case the other arm ever passed becomes a
discordant cluster, and the sign test finds them all going one direction. Thirty-two
discordant clusters out of one real trial vs. five degraded runs says nothing about which
model is better.

---

## Run summary

| Model | Trial | Seconds | Cases passed | Score | Tokens in / out |
|---|---|---|---|---|---|
| phi4-mini:latest | 1 | 524 | 32/100 | 0.320 | 38,072 / 26,804 |
| phi4-mini:latest | 2 | 0 | 0/100 | 0.000 | — degraded — |
| phi4-mini:latest | 3 | 0 | 0/100 | 0.000 | — degraded — |
| lfm2.5-thinking:latest | 1 | 0 | 0/100 | 0.000 | — degraded — |
| lfm2.5-thinking:latest | 2 | 0 | 0/100 | 0.000 | — degraded — |
| lfm2.5-thinking:latest | 3 | 0 | 0/100 | 0.000 | — degraded — |

---

## What we can say from phi4-mini trial 1

This is the sole valid data point in the sweep. It is one trial, not three, so no
within-model spread is measurable and no model comparison is possible.

**By dimension (25 cases each):**

| Shape | Passed | Rate |
|---|---|---|
| secret | 11/25 | 44% |
| unicode | 3/25 | 12% |
| placeholder | 8/25 | 32% |
| structure | 10/25 | 40% |

Unicode dimension performed worst by a large margin. The `unicode-and-crlf-survive`
detector requires the model to include the non-ASCII script token (e.g. `日本語`,
`한국어`) in its output; phi4-mini-3.8b failed to do this 22 of 25 times in trial 1.
This aligns with the sub-project 1 finding that this dimension had the widest spread
across models (0/3 to 3/3 across the twelve hand-written cases).

**Cost:** 524 seconds for 100 cases ≈ 5.2 s/case. That is consistent with a 3.8 B
parameter model running sequentially on local GPU. At 3 trials × 2 models = 6 runs, the
planned sweep would have taken roughly 52 minutes of GPU time — closer to one hour than
ninety minutes.

**Noise floor:** The armed floor says a 42.6 pp difference is needed to trust any
comparison result on this 100-case suite. Even if both models had run properly, only gaps
larger than 42.6 pp would be interpretable against that baseline. A 32% score from one
trial is a data point, not a measurement.

---

## What we cannot say

- Anything about `lfm2.5-thinking:latest`. It never reached the Ollama daemon.
- Whether phi4-mini's 32% score is stable. One trial cannot establish within-model spread;
  sub-project 1 found gpt-oss:20b varying 25 points across three trials of twelve cases.
- Whether `phi4-mini:latest` outperforms `lfm2.5-thinking:latest` or vice versa.
- Whether the brief-pilot suite "pays" relative to the compile-smoke baseline. The question
  the pilot was designed to answer — does a model-sensitive suite resolve a difference the
  static suite cannot? — cannot be answered without valid comparison data.

---

## Why the daemon stopped responding

The most likely cause is GPU memory exhaustion. After phi4-mini trial 1 consumed 524
seconds of GPU time processing 100 cases, the daemon either:

1. Hit an OOM condition and the model was unloaded without being reloaded correctly, or
2. Crashed and its subsequent restart failed, or
3. Was killed by the OS for memory pressure while the sweep was writing trial 1's results.

The `lfm2.5-thinking:latest` trials all degraded on first contact, which suggests the
daemon was already down when the sweep moved from phi4-mini to lfm2.5. The sweep runner
does not check daemon health between trials — it just spawns the eval runner, which
classifies a connection failure as a provider unavailable event and enters demo mode.

---

## What the suite itself established

The suite infrastructure is sound:

- `test/brief-pilot.test.ts` passed (100/100 with stub transport) at the time of PR #101.
- `check:brief-pilot` and `check:brief-pilot` (in the verify chain) fire correctly.
- The construction invariant held: every generated case satisfied its own stub expectation.
- The `writeGuard` in `compare-models --write` would have blocked a mislabel if the sweep
  had completed and someone attempted to write a floor from a different suite.

The failure was operational (daemon availability), not architectural.

---

## Next steps

**To complete the measurement:**

1. Verify the Ollama daemon is running and both models are loaded before starting the sweep:
   ```
   ollama ps
   ```
2. Run each model in a separate sweep invocation, leaving time between them for the daemon
   to stabilise:
   ```
   npm run sweep:models -- --models phi4-mini:latest --trials 3 \
     --suite eval/brief-pilot.json --out .sweep-brief-pilot-phi4
   npm run sweep:models -- --models lfm2.5-thinking:latest --trials 3 \
     --suite eval/brief-pilot.json --out .sweep-brief-pilot-lfm
   ```
3. Verify both output directories have 3 non-zero-second run lines before running
   `compare-models`.
4. If GPU OOM persists, reduce `--trials 3` to `--trials 1` as a diagnostic, or check
   available VRAM before loading the second model.

**On the truth-boundary:** The design spec conditions a new truth-boundary entry on the
verdict being "does not pay". The verdict here is "measurement invalid" — the condition is
not met. No entry will be added until a valid comparison is run and a verdict is reached.
