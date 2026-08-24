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
| `--reflexive [N]` | route a gate FAIL back to `refine`, at most N times (default 1) |

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

Both are gitignored. `.promptnexus/` is the pre-rename directory, still ignored.

**`evidence-local` writes with the `wx` flag** — a duplicate `(kind, id)` fails in the
syscall, not in a check. There is no read-modify-write, so there is no cycle to interleave.
(`storage-local` *does* read-modify-write per append, eleven times a run, and two concurrent
runs there already race.)

Ids reaching either store are validated against `^[A-Za-z0-9_-]{1,64}$` before being used as
a path component.

---

## Observability

`ObservabilityEvent` carries **keyed hashes only**. The sink *rejects* rather than truncates
if a prompt body appears. Fingerprints are keyed because bare digests of short prompts are
correlatable.

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
