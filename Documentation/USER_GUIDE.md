# User Guide

Three guided ways to use the platform, plus one operational surface, all built on the same Core, so results are consistent regardless of which you choose.

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
promptnexus run --stage compile path/to/prompt.md
```
Use this to wire gate checks into another repo's pre-commit hooks. Because `cli` and the web Shells both call the same Core functions through the same contracts, a prompt linted via `cli` produces identical `GateResult`s to the same prompt linted in `toolkit-ui`.

## `api` — status routes, and two that do real work

Not one of the three guided ways above — a small Fastify HTTP server
(`npm start -w @nexusprompt/shell-api`).

Read-only status: `/api/v1/health`, `/api/v1/system`, `/api/v1/hardware`, `/api/v1/gates`,
`/api/v1/provider/health`.

Doing work: **`POST /api/v1/compiler/lint`** and **`POST /api/v1/compiler/compile`**. This
section said there was "no route to run a pipeline or lint a prompt over HTTP" until
6 September 2026; both have existed since the shell was adopted, and `compile` reaches a
provider. There is still no route that runs the eleven-stage pipeline — `compile` is the
single-stage Orchestrator path.

### Environment

| variable | default | what it does |
|---|---|---|
| `PORT` | `3000` | listening port |
| `HOST` | `127.0.0.1` | bind address. Loopback by default; anything else exposes the two working routes to the network |
| `NEXUSPROMPT_API_TOKEN` | *unset* | when set, every route except `/api/v1/health` requires `Authorization: Bearer <token>` |
| `NEXUSPROMPT_RATE_LIMIT` | `120` | requests per window per client IP, for routes that do no external work |
| `NEXUSPROMPT_PROVIDER_RATE_LIMIT` | `10` | requests per window per client IP, for the routes that reach a provider |
| `NEXUSPROMPT_GLOBAL_PROVIDER_LIMIT` | `50` | requests per window, summed across every client, for the routes that reach a provider |
| `NEXUSPROMPT_RATE_WINDOW_MS` | `60000` | the window |
| `NEXUSPROMPT_MAX_PROVIDER_CALLS` | *unset* | passed to the Orchestrator as a `Budget`. Below 3 (the retry ceiling) refuses every compile outright — see ADR-0019 for why this is a config assertion, not a spend control |

**Auth is opt-in on a loopback bind, and refused on anything else.** With no
`NEXUSPROMPT_API_TOKEN`, a `HOST` of `127.0.0.1`, `::1`, or `localhost` still starts and warns
on stderr, exactly as before — local development and `npm start` with no configuration are
unaffected. Any other `HOST` with no token set refuses to start, naming the variable, before
binding a socket. See ADR-0019 for why this changed from ADR-0018's original opt-in-everywhere
default.

The rate limit applies regardless of auth, because it needs no secret to configure and it is
what bounds provider spend — both the per-client ceiling and, since ADR-0019, the aggregate
one across every client. A rate-limit variable that is not a positive integer is refused at
startup rather than replaced with the default.

## Choosing a provider

Set in configuration, not per-request — see `PROVIDERS.md` for the local-proxy vs. hosted-server tradeoffs. Whichever is configured, the UI is identical; only the fallback ladder's trigger conditions differ (a local proxy failing usually means the proxy process isn't running; a hosted server failing usually means a rate limit or network issue).
