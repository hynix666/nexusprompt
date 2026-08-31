# ADR-0015: The local inference tier is Ollama over HTTP, with no JSON repair

**Status:** Accepted — 30 August 2026
**Authorises:** `adapters/provider-ollama`, and `--local` on the evaluation runner.
**Related:** ADR-0003 (dual provider adapters), ADR-0012 (dependency boundary), ADR-0014 (a malformed response is not demo mode).

## Context

Every figure this repository reports was produced by the pinned stub. `TRUTH_BOUNDARY.md`'s
opening entry said so plainly: *nothing here has ever talked to a model*. The hosted path
exists and refuses correctly, but using it needs a credential and money, so the gap between
"the accounting works" and "we know something about a model" stayed open.

> **Closed on 31 August 2026, and only halfway.** The tier this ADR specifies now runs:
> `nexusprompt pipeline --model <name>` reaches an Ollama daemon on loopback, and pipeline
> runs against 6 local models are persisted with real fingerprints, which are pinned. The
> first sentence above is still true, and that is the point — **every figure this repository
> reports still comes from the pinned stub.** What closed is the ability to reach a model at
> all without a credential; what did not close is any evaluation figure being about one.

Two proposal documents specify a local-inference tier to close it. They agree on the shape —
Ollama first, ONNX behind it, native bindings deferred — and both make one pairing
**mandatory**:

> `jsonrepair` + `STRUCTURED_OUTPUT_FAILURE` classification. Mandatory for all non-Ollama
> paths. Never assume valid JSON from local models without constraints.

## Decision

Build `adapters/provider-ollama` against the daemon's HTTP API using Node's global `fetch`,
restricted to loopback. Add `--local` as a third transport on the evaluation runner.

**Do not add `jsonrepair`, and do not add a repair step at all.**

## Why Ollama, and why over plain HTTP

Ollama is the shortest path to a model that answers: a daemon most machines can already run,
an OpenAI-shaped chat endpoint, and no credential. Its `/api/chat` takes the same message
array `GenerationRequest` carries, so the adapter is a translation of one field — `system`
becomes a turn — rather than a protocol layer.

No client package, and this is not preference. ADR-0012 scopes the zero-dependency property
rather than dropping it: `contracts`, `core`, `application`, **the adapters** and `shells/cli`
ship nothing in `dependencies`. An `ollama` npm package would end that for the layer whose job
is to be replaceable, in exchange for wrapping a JSON POST that `fetch` already does.

## Why no JSON repair

The proposals' reasoning is sound in general and does not apply here yet, for a reason that is
checkable rather than arguable: **no stage in this pipeline asks a model for JSON.**

All eleven stages consume prose — a spec, a calibration, a compiled prompt, a critique — and
`grep JSON.parse core/src/stages/` returns nothing. The JSON in this adapter is Ollama's
*transport envelope*, which the daemon writes and controls. That is not model output, and
repairing it would be repairing a bug in Ollama rather than compensating for a model.

There is a second reason, and it is the one that would still apply after a structured-output
stage exists. **The more a repairer can fix, the more it launders.** A step that turns
unparseable model output into a clean object, and hands it on with nothing recorded, is
indistinguishable downstream from a model that got it right — which is precisely the class of
failure this repository is built to prevent. If repair is ever added it must record that it
ran, and a run whose output was repaired must not be usable as a baseline without someone
looking at it.

So the decision is not "repair is wrong". It is **not yet, and not silently**.

## Loopback is a security boundary, not a default

An adapter whose host is caller-supplied is a server-side request forgery primitive wearing a
helpful name: point it at `169.254.169.254` and it will fetch whatever answers. The host must
match a literal local spelling, checked before any request leaves.

Not a DNS resolution. Resolving a name to decide whether it is local invites a rebinding race
in which the check and the request disagree about the same string — a fixed spelling cannot be
re-pointed between the two.

## Consequences

**Easier.** A measured run costs nothing and needs no credential, so the first real evidence
about model behaviour is available to anyone with a daemon. It arrived immediately: the
compile-smoke suite against `lfm2.5-thinking:latest` scored 10/14 in 82 seconds, and the two
failures are findings about the model — an unfilled `{{` left in output, and dropped `日本語`.

**Harder.** A third transport means the preconditions are no longer a boolean. `preflight`
took `live: boolean`, which could not express "needs a model named but neither key nor budget";
it takes a `Transport` now. Widening `live` to mean "not the stub" would have been the cheaper
edit and would have demanded a budget from a run that cannot spend anything.

**A model that answers is not a model that is right.** A local 0.7B model is weaker than a
frontier one, and its 0.714 on a fourteen-case smoke suite certifies nothing — that suite's
own resolution note says evidencing a difference takes six one-directional flips. Local models
are regression canaries, not oracles, and the anchor remains the instrument for anything
stronger.

**Still unarmed.** The evaluation path persists no revision entries, so `check:fingerprint`
reports no observation and the truth boundary's opening claim is unchanged. Running the
*pipeline* against a local model would change that, and it should be a deliberate act with the
boundary rewritten in the same commit — not a side effect of testing an adapter.

## Alternatives rejected

**Transformers.js.** Pure Node and no daemon, which is genuinely attractive, but it ships a
large dependency tree into a layer that has none and it is the path the proposals pair with
mandatory `jsonrepair`. Reconsider if the daemon requirement becomes the obstacle.

**A Python `onnxruntime-genai` sidecar.** Full sampling control, at the cost of a Python
runtime on every machine that wants a local run. Deferred until something needs control Ollama
cannot give.

**A default model name.** Rejected. Naming one this machine has not pulled produces a 404 that
reads like an outage; naming one it has pulled bakes a local accident into a shared adapter.
The adapter refuses with the command that lists what is available.

**Reviving `LLM/`.** The dropped ONNX export has no `genai_config.json`, and ADR-0014's
sibling concern applies: guessing architecture parameters produces fluent garbage, which is
the one failure demo mode exists to make impossible. It stays documented and unused.
