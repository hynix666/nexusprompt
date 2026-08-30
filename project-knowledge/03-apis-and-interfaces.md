# APIs and interfaces

There is **no HTTP server, no REST API, and no database**. The system's interfaces are: a
CLI, a set of TypeScript ports, one outbound HTTP call to Anthropic, and the filesystem.

---

## CLI — `shells/cli/src/index.ts`

```
nexusprompt lint <file>              run the registered gates
nexusprompt run --stage compile <f>  run one pipeline stage end to end
nexusprompt pipeline <file>          run the full pipeline over a brief
nexusprompt gates                    list registered gates
nexusprompt evidence                 what the evidence plane holds, and what is current
```

Invoked in-repo as `npm run cli -- <args>`.

### `pipeline` options

| Flag | Meaning |
|---|---|
| `--stakes LOW\|MEDIUM\|HIGH\|SAFETY-CRITICAL` | selects depth (default `MEDIUM`) |
| `--depth TINY\|MINIMAL\|STANDARD\|COMPREHENSIVE` | overrides the stakes mapping |
| `--test "<message>"` | the turn the `preview` stage tries |
| `--reflexive [N]` | route a gate FAIL back to `refine`, at most N times (default 1). **Refused above the declared `max_feedback_rounds`** — every round is two more stage executions against the error budget, and Core clamps as the backstop |

Stakes selects depth: `LOW` runs 6 of 11 stages, `SAFETY-CRITICAL` all 11. Each reflexive
round costs **two** more stage executions against the depth budget.

### Exit codes (shared convention, matching the source linter)

| Code | Meaning |
|---|---|
| `0` | clean |
| `1` | a gate FAILed, or a stage threw |
| `2` | inputs unreadable / refused before doing anything |
| `3` | degraded (demo mode), or gates warned |
| `4` | `--compare` did not reach the verdict it exists to demonstrate |

Precedence lives in the **Application** layer (`worstVerdict`) so two Shells cannot disagree.

### `nexusprompt evidence` — reports zero as zero

```
evidence plane

  eval-run        0
  comparison      0
  baseline        0
  promotion       0

  current: nothing has ever been promoted.

  The plane is empty. The release gate is built and tested; it has never been run
  against a real evaluation, because no run here has reached a provider.
```

That last paragraph is deliberate. A command that hid the zero behind an empty table would
repeat the mistake `CAPABILITY_MATRIX.md` made for months.

---

## The one external API

`adapters/provider-local-proxy/src/index.ts` → **Anthropic Messages API**.

| | |
|---|---|
| Endpoint | `POST https://api.anthropic.com/v1/messages` |
| Auth | header `x-api-key: <REDACTED — from process.env.ANTHROPIC_API_KEY>` |
| Version header | `anthropic-version: 2023-06-01` |
| Default model | `claude-opus-5` |
| Host allowlist | `["api.anthropic.com"]`, **frozen**; a caller cannot add to it |
| Max request | 2 MiB (`MAX_REQUEST_BYTES`) |
| Timeout | `AbortController`, configurable |

**The host is hard-coded and `ANTHROPIC_BASE_URL` is deliberately ignored**, so a live run
goes there and nowhere else. The key is read from `process.env` inside the adapter and is
never passed through a script, logged, or written into a run.

### Failure classification

The adapter never throws for expected conditions; it returns a typed `ProviderFailure`:

| Category | Example `reason_code` |
|---|---|
| `AUTH` | `no_api_key` |
| `UNAVAILABLE` | `connection_failed` |
| `INVALID_REQUEST` | `host_not_allowed`, `request_too_large` |
| `CONTENT_FILTER` | `refusal` |

Every one of these reaches Core **as a value, not an event** — which is what makes demo mode
testable without a provider.

---

## Application protocol (what a Shell may call)

```ts
// Single-stage
new Orchestrator({ provider, store, sink, now?, sleep?, coreBuildHash? })
  .run(command: PipelineCommand): Promise<PipelineOutcome>

// Full pipeline
runPipeline(command, { provider, store, sink, now?, sleep?, coreBuildHash? })
  : Promise<PipelineRunResult>

// Evaluation
runSuite({ suite, cases, configuration, trials?, cache?, rate?, provider?, variant?, sink? })
  : Promise<SuiteResult>
runPipelineSuite({ cases, coreBuildHash? }): Promise<{ perCase, passed }>

// Release
freezeBaseline(store, { baseline_id, run_id, lineage, frozen_at, supersedes? })
promote(store, { promotion_id, run_id, baseline_id, comparison_id,
                 promoted_at, promoted_by, suiteGranularity, judge?, justification? })
rollback(store, { promotion_id, reverses, promoted_at, promoted_by })
current(store): Promise<Promotion | null>     // computed, never stored

// Linting
lint(text): LintReport
```

### `runSuite`'s provider seam

```ts
provider?: ProviderTransport   // absent = pinned stubs. THE DEFAULT IS LOAD-BEARING.
```

An `EvalRun` is recomputable from stored artifacts **only while nothing in it reached the
network**. Supplying a provider is how a suite finally measures a model.
`provenance.provider` records which transport answered.

Layering is **transport → recorder → cache**, in that order. `CachingProvider` returns a hit
without touching what it wraps, so the recorder must sit *inside* it — outside, every cache
hit would count as a provider call and `provider_calls` would measure the suite's size rather
than what it cost, which is the number the budget is enforced against.

---

## Filesystem interfaces

| Path | Written by | Shape |
|---|---|---|
| `.nexusprompt/runs/<run_id>.json` | `storage-local` | one bundle per run; 8 kept, evicted whole |
| `.nexusprompt/evidence/<kind>/<id>.json` | `evidence-local` | one file per record, immutable |
| `.nexusprompt/content/<2-hex>/<62-hex>.bin` | `content-local` | one file per body, content-addressed and sharded |

All three are gitignored. `.promptnexus/` is the pre-rename directory, still ignored.

**`evidence-local` writes with the `wx` flag** — a duplicate `(kind, id)` fails in the
syscall, not in a check. There is no read-modify-write, so there is no cycle to interleave.
(`storage-local` *does* read-modify-write per append, eleven times a run, and two concurrent
runs there already race.)

Ids reaching either store are validated against `^[A-Za-z0-9_-]{1,64}$` before being used as
a path component.

### `ContentStore` — the content plane (`put` / `get` / `has` / `sweep`)

Added with the artifact-reference lineage work. **No `update`, no `delete`** — a corrected
artifact is a new artifact. Three distinctions carry it:

- **Content is MATERIAL, evidence is EVENTS.** `evidence-local` *refuses* a duplicate
  `(kind, id)` because a record is a thing that happened once. `content-local` treats a second
  `put` of the same bytes as a **no-op success**, because the same bytes re-derived are the same
  material. Both use `wx`; they differ in what an `EEXIST` means.
- **A ref is a content address**, so `put` refuses bytes that do not hash to it. The grammar is
  `npx:<kind>:<sha256>:<scope_hint>`, enforced at the boundary because refs become path
  components. The hash is **unkeyed**, unlike the keyed observability fingerprints — content
  addressing has to be verifiable by anyone holding the artifact.
- **`sweep(live)` reclaims, it does not delete.** It removes every stored item no live ref
  names, and takes the live SET rather than a ref to remove — which is the guarantee, not an
  ergonomic choice. Content is addressed by hash, so one file backs many runs; a `delete(ref)`
  primitive cannot know whether another run still cites those bytes, and would either corrupt
  that run or leak. Recomputing the live set from surviving bundles is sharing-safe with no
  refcount to keep correct across crashes. It exists because bundle eviction reclaimed
  **nothing**: twelve runs left eight bundles and 20 of 60 content files orphaned.
- **The caller must prove its live set is complete before sweeping.** `listRecent` is a *recent*
  listing with a limit, not an authoritative enumeration, so a store that under-reports would
  send the sweep after content a surviving revision still cites. `runPipeline` checks that the
  run it just finished appears in the set it computed, and reclaims nothing when it does not.
  A test store answering `[]` deleted every file on disk before that guard existed.
- **`has` verifies, it does not stat.** It shipped as `existsSync` alone and therefore reported
  a tampered file as present — while `get` on the same file threw. `has` is the oracle behind
  the `dangling-ref` promotion gate, so the one caller it was written for was the one that could
  not see corruption. It now reads and hashes, and throws on a mismatch rather than returning
  false, because `decidePromotion` requires that a broken store cannot masquerade as
  "all content gone".

---

## Observability

`ObservabilityEvent` carries **hashes only**. Fingerprints are meant to be keyed because bare
digests of short prompts are correlatable.

**Corrected by sweep fourteen.** This paragraph used to say "the sink *rejects* rather than
truncates if a prompt body appears", following `OBSERVABILITY.md`, which named
`observability/sink.ts` as the enforcement point. That directory has never existed and no sink
module was ever tracked — every sink is an inline lambda — so the property was a per-call
convention, and the convention was broken: `failStage` copied `err.message` into
`DEGRADE.verdict`, so an adapter throwing a parse error that quoted its payload put the brief
into four events.

Two layers now, because the first is the discipline the old claim disowned:

- **Call sites forward an error's TYPE, never its message.** Bounded, and it routes a failure as
  well as a message does.
- **`application/src/redaction.ts` wraps the sink**, so no `emit` can bypass it. Every string
  field is compared against the bodies the run holds; one sharing a 32-character verbatim run is
  replaced by a marker containing none of it. The window sits *below* the 200-character slice
  `failStage` used — a truncated body is still a body.

It **substitutes rather than throws**, which is a deliberate departure from the old wording.
Rejecting the payload is right and still holds; rejecting by throwing killed the run, because
`failStage` emits from inside a catch — a quoted brief turned a gracefully degrading run into an
aborted one, losing the artifact to a logging concern. Fail closed on the body, not availability.

The guarantee is bounded and says so: it catches a body copied, sliced or embedded from *this*
run, not a paraphrase, a body from another run, or one shorter than the window.

> Known gap: keyed fingerprints are documented; the code still uses bare `sha256`. See
> `08-known-issues-and-decisions.md`.

---

## Auth summary

| Interface | Auth |
|---|---|
| CLI | none — local process |
| Anthropic API | `x-api-key` from `ANTHROPIC_API_KEY`; `--live` refuses up front when unset |
| Evidence / revision stores | filesystem permissions |
| GitHub (CI, `gh`) | user's own credentials, outside this repo |

No secret is ever read into application state beyond the adapter's request header, and
nothing in the repository stores, logs, or prints one.
