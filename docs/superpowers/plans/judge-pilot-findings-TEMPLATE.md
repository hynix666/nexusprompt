# Judge-scored provider comparison pilot — findings

> Copy this file to `docs/superpowers/plans/YYYY-MM-DD-judge-pilot-findings.md` (today's date)
> after running the pilot for real, fill in every `<TODO>`, and delete this header line and
> this blockquote. Do not commit this template itself with any `<TODO>` filled in — the
> template stays a template, and the findings doc is the copy that carries real numbers.

**Status:** <TODO: "Complete, real run" or "Blocked: <reason>">
**Sub-project:** 4 (judge-scored comparison pilot), an offshoot of 2 and 3
**Spec:** `docs/superpowers/specs/2026-09-04-judge-scored-comparison-pilot-design.md`
**Run date:** <TODO: date the live pilot actually ran>

## What ran

- Calibration: `<TODO: cohens_kappa value>` (threshold 0.6) — <TODO: pass/fail>, measured `<TODO: date>`
- Pilot: `<TODO: survived_n>` / 100 briefs survived pairing (`<TODO: N>` dropped — see the
  script's own `dropped` output for why, per brief)
- Comparison id: `<TODO: comparison_id>`, evidence record at `.nexusprompt-judge-pilot/evidence/`

## The measurement

- **Δ (mean paired score difference, 0-12 scale):** `<TODO>`
- **Bootstrap CI (95%):** `<TODO: [lo, hi]>`
- **Verdict:** `<TODO: improved / regressed / inconclusive / refused>`
- **Implied full-anchor size**, via `requiredPairedSizeContinuous(Δ, sd, {alpha: 0.05, power: 0.8})`
  where `sd` is the sample standard deviation of the survived paired differences: `<TODO>`
- **Constant-case fraction** (briefs where both models scored identically): `<TODO>` / `<TODO: survived_n>`

## Pays or does not pay

<TODO: state the verdict plainly, using the same two criteria sub-project 2's own findings doc
used — is the implied size materially below what sub-project 2 needed (341 cases at the
original discordance rate, or 137,356 at the measured brief-pilot Δ), and is the constant-case
fraction meaningfully lower than the binary pilot's 72%?>

## Direct comparison to sub-project 2

| | sub-project 2 (binary detectors) | sub-project 4 (judge, 0-12) |
|---|---|---|
| Δ | 0.4 pp | `<TODO>` |
| constant-case fraction | 72% | `<TODO>` |
| implied size | 137,356 | `<TODO>` |
| verdict | does not pay | `<TODO>` |

## What this does not establish

<TODO: copy the design spec's "What this does NOT establish" section verbatim — it does not
change based on the measurement's outcome.>

## How this was run

1. **Calibration** (skip if `eval/judge-calibration.json` already exists and
   `npm run check:judge` passes):

   ```bash
   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/build-judge-calibration.ts
   ```

   Confirm it printed a kappa >= 0.6 before continuing. If it did not, this pilot is blocked —
   `admitJudge` refuses every grading below threshold, so the pilot script's own guard would
   also refuse before spending anything on the pilot itself.

2. **Confirm the local models are pulled:**

   ```bash
   ollama list | grep -E "phi4-mini:latest|lfm2.5-thinking:latest"
   ```

   Pull whichever is missing (`ollama pull <name>`) before continuing.

3. **Run the pilot:**

   ```bash
   ANTHROPIC_API_KEY=sk-ant-... npm run judge:pilot
   ```

   This is the expensive, irreversible step — up to 600 calls to `claude-opus-5` and 200 local
   pipeline runs. It prints the verdict, delta, confidence interval, comparison id, and every
   dropped brief with its reason directly to stdout when it finishes.

4. **Copy this template** to `docs/superpowers/plans/<today>-judge-pilot-findings.md`, fill in
   every `<TODO>` from the script's printed output (and `sd`, computed by hand or with a short
   throwaway script over the survived paired differences — this repository has no committed
   tool for it, since it is a one-time number for one findings doc, not a reusable check).

5. **Commit the findings doc** (not this template — this template stays as it is, for the next
   time this pilot needs re-running with different models or a different judge).
