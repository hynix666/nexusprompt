# Examples

Documentation that runs. Every output in `expected/` is regenerated and diffed by
`npm run check:examples`, which is inside `npm run verify` — so when the system's behaviour
changes, these stop matching and the build says so.

None of this needs an API key. Every subprocess runs with `ANTHROPIC_API_KEY` deleted, so
the output is the same on a machine that has one.

## The three commands

```bash
npm run example:lint
```

Runs all four prompts in `prompts/` through the sixteen gates. Two of them trip a gate on
purpose — an examples directory where everything passes demonstrates nothing.

```bash
npm run example:pipeline
```

An eleven-stage run over `briefs/support-bot.md` with no provider. It **degrades**: it
produces an artifact, marks every stage that never reached a model, prints
`⟦WORKFLOW DEMO — no model⟧` where the output would be, and exits **3**.

```bash
npm run example:refuse
```

A live run with no key. It **refuses**: nothing is produced, nothing is spent, and it
exits **2**.

## Read the last two together

Degrading and refusing are different answers, and keeping them apart is most of what this
system is for.

|  | `example:pipeline` | `example:refuse` |
|---|---|---|
| Produces an artifact | yes, labelled | no |
| Spends anything | no | no |
| Exit | 3 | 2 |
| Says | "we could not see anything, and here is a placeholder that admits it" | "we will not start" |

A system that collapsed these would fail in the cheaper direction: presenting a placeholder
as an answer, or reporting a refusal as a result.

## The four prompts

| File | What it shows |
|---|---|
| `clean.md` | Everything passes. The must-not-fire case — a gate set that fires on everything gets ignored. |
| `leaking-secret.md` | `SECRET_LEAK_SCAN` finds a credential pasted into the prompt body. |
| `overclaiming.md` | `CLAIM_DISCIPLINE` finds "guarantees" and "100% accurate". |
| `secret-inside-a-fence.md` | The same credential as `leaking-secret.md`, inside a fence — and **no finding**. |

That last pair is the most useful thing here. The gates audit the prompt with documentation
spans stripped, so a secret inside a fence is not a finding. That is deliberate: a fence
marks text the model is being *shown* rather than *told*, and an example of what a
credential looks like belongs in a prompt where a live one does not. The gate cannot tell
those apart, so it defers to the fence.

Diff the two lint outputs in `expected/lint.txt`. If `SECRET_LEAK_SCAN` ever reports the
same verdict for both, one of them is wrong.

## Changing an example

There is no update flag on the check. Run `npm run docs:examples` and commit the diff —
accepting a behaviour change should be something somebody reads.
