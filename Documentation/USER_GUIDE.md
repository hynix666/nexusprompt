# User Guide

Three ways to use the platform, all built on the same Core, so results are consistent regardless of which you choose.

## `pipeline-ui` — the guided flow

Best for: working through one prompt from scratch, stage by stage.

Eleven stages, run in order: **Deconstruct → Calibrate → Compile → Harden → Critique → Refine → Lint → Critic → Preview → Cost Estimate → Tone Check**. Each stage shows its `GateResult`s inline.

The last two are newer than the rest and are enabled by default: **Cost Estimate** projects token spend for the compiled prompt, and **Tone Check** evaluates register and voice against the spec. Earlier documentation described a nine-stage pipeline; the shipped component has eleven. If a stage falls back to demo mode (no live provider reachable), its output is labeled `⟦WORKFLOW DEMO — no model⟧` — this is not a bug, it's the system declining to fabricate output it can't actually produce.

Features carried forward from the source pipeline UI:
- Full export: TXT, JSON, MD+YAML, and side-by-side comparison as JSON/MD/HTML, plus print-to-PDF.
- Revision history with stale-result invalidation — changing an earlier stage's output marks every downstream stage's result as stale until rerun. Locally, history keeps your 8 most recent complete runs; a run is kept or dropped whole, so you never find half a run in your history.
- `Ctrl+R` reruns the current stage. Config changes (provider/model) abort any in-flight run rather than let it publish against a changed config.
- Clearing history requires typing a confirmation phrase (typed-DELETE guard) — this is deliberate friction against accidental data loss.

## `toolkit-ui` — the module view

Best for: browsing techniques, learning the framework, or working non-linearly.

Modules: **Learn**, **Templates**, **Lint**, **Build**, **Optimize**, **Pipeline** (renders the shared pipeline presentation package that `pipeline-ui` also hosts — one implementation, reused, not forked; see [ADR-0006](./0006-shell-composition-and-shared-ui.md)), **Catalog**, **Vault**.

- **Catalog** — browse and search the 172-technique reference (see `CATALOG.md`); each entry shows its provenance status.
- **Lint** — run the 16 gates against any prompt text standalone, outside a full pipeline run.
- **Vault** — save and retrieve prompts, backed by whichever `RevisionStore` adapter is configured (local or DB).

## `cli` — for automation

```
promptnexus lint path/to/prompt.md
promptnexus run --stage compile --input path/to/prompt.md
```
Use this to wire gate checks into another repo's pre-commit hooks. Because `cli` and the web Shells both call the same Core functions through the same contracts, a prompt linted via `cli` produces identical `GateResult`s to the same prompt linted in `toolkit-ui`.

## Choosing a provider

Set in configuration, not per-request — see `PROVIDERS.md` for the local-proxy vs. hosted-server tradeoffs. Whichever is configured, the UI is identical; only the fallback ladder's trigger conditions differ (a local proxy failing usually means the proxy process isn't running; a hosted server failing usually means a rate limit or network issue).
