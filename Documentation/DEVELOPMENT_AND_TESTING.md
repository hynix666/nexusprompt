# Development & Testing

## Local setup

```
git clone <repo>
npm install
npm run verify         # boundaries → typecheck → source freeze → tests → differential oracle
```

`npm`, not `pnpm`: pnpm is not installed here and the workspace is defined with npm workspaces. The documented layout still names packages that do not exist yet — built today are `contracts/`, `core/`, `application/`, `adapters/provider-local-proxy`, `adapters/storage-local`, `shells/cli`, `scripts/`, and `test/`. `packages/` (shared presentation) and `observability/` are target state.

`npm run verify` is the whole check and runs in about ten seconds. There is **no CI service** configured — no `.github/`, no pipeline. Everything below that says "CI" describes intent; the local command is what actually runs.

## Enforced boundaries

`npm run lint:boundaries` (`scripts/check-boundaries.mjs`) fails on any import that violates the dependency table in `ARCHITECTURE.md`.

This is a plain script rather than an ESLint rule, and it exists because the sentence that used to sit here — an ESLint `no-restricted-imports` rule, "checked in CI, not left to code review" — described nothing. There was no ESLint config, no CI, and the only Shell in the repository imported Core and two concrete adapters while its own header comment said it did not. An audit found it in about a minute; the rule that was supposed to catch it had never existed.

The checker reads every file under each layer, so it does not depend on a test exercising the line. Exemptions are declared in the script with a reason attached — `shells/cli/src/composition-root.ts` is the only one, because naming concrete adapters is precisely a composition root's job.

The rules that catch the most mistakes:

- `core/*` may not import `adapters/*`, `shells/*`, or `application/*`
- `shells/<a>/*` may not import `shells/<b>/*` — cross-Shell reuse goes through a shared presentation package ([ADR-0006](./0006-shell-composition-and-shared-ui.md))
- `shells/*` may not import `core/*` or `adapters/*` — Shells call the Application protocol

If you find yourself needing an Adapter capability inside Core, **passing it in as a parameter is not the fix.** An injected `generate()` is still a live effect, which is why Core no longer accepts one ([ADR-0005](./0005-application-orchestration-boundary.md)). The fix is to split the work: Core returns a deterministic decision — a `GenerationRequest`, or an action plan — and the Application layer performs the effect and calls Core again to reduce the result. A boundary test asserts that no callable performing I/O appears in Core's public surface.

## Test strategy by layer

| Layer | Test type | Requirement |
|---|---|---|
| `core/gates/` | Fixture + property tests | Every gate needs ≥1 property test asserting an invariant, not just an example input/output pair |
| `core/catalog/` | Schema validation + provenance completeness (reported) | Runs on every PR touching catalog data |
| `core/stages/` | Unit tests, no network | Stage functions are pure: decision functions take validated input and return a `GenerationRequest` or action plan; reduction functions take an *already-classified* provider outcome and return the next state. Tests pass values, never a provider or a fake `generate()` |
| `core/scorer/` | Adversarial corpus run | `npm run adversarial`, also run weekly against `main` and archived |
| `application/*` | Orchestration tests with fake adapters | Retry, backoff, timeout, cancellation, failure classification, and the demo-mode fallback ladder are asserted here — this is the layer that owns them |
| `adapters/*` | Contract tests | One test file run against **every** implementation of an interface (e.g., both provider adapters), asserting behavioral parity where the contract requires it. Covers success, timeout, cancellation, auth failure, rate limit, transient failure, unavailable provider, and health transitions |
| `shells/*` | Integration + a cross-shell parity test | The same prompt run through `pipeline-ui` and through `cli` must produce identical `GateResult`s for the same input |
| `core/gates/` | **Differential** against an independent implementation | Compare verdicts to a second implementation that was written separately, not ported from the same source |
| `packages/*` (shared presentation) | Component tests | Depends only on the Application protocol and contract types; a test asserts no Core or adapter import |

## Parity is not enough — the difference between parity and differential

Cross-shell parity asserts that two implementations agree. **It cannot detect a defect they share**, and this is not a theoretical concern: the inherited test corpus documents three shipped bugs that parity was blind to, in its own words.

| Defect | Why parity missed it |
|---|---|
| `naive_tokens if naive_tokens else 400` substituted the default for a caller-supplied `0` | *"Both implementations shared the bug, so the parity harness stayed silent — parity detects divergence, never a shared error."* |
| A citation inside an empty Source-ledger section declared itself, silencing **both** citation gates | *"Found by `tests/differential.mjs` against the independent v6 implementation; parity was blind because both v5 copies shared the defect."* |
| `[S1,S2]` extracted only the first id, silently unciting S2 | *"Both v5 copies shared it, so parity was blind."* |

The third one is the sharpest: a port inherits its source's bugs along with its behavior, so two implementations that agree perfectly can be wrong together — and the closer the port, the more reliably they agree on the error.

**The oracle is permanent, not migration scaffolding** — see [ADR-0007](./0007-permanent-differential-oracle.md). Deleting it when the port completes removes the check at exactly the moment the code looks most finished and gets the least scrutiny, which is when a shared defect is most dangerous.

Both checks are needed, and they answer different questions:

- **Parity** — do our implementations agree with each other? Catches divergence introduced during a port. Cheap, runs on every PR.
- **Differential** — do we agree with an implementation that was written independently? Catches defects inherited from the source. The oracle must not be a port of the same code, or it inherits the same blind spot.

This matters most for `core/gates/`, where the TypeScript port descends directly from `sources/v5/prompt_lint.py`. Everything that linter got wrong, the port will get wrong identically, and the parity suite will report green.

## Determinism: two decisions worth inheriting

The source linter records two fixes that exist purely to keep verdicts reproducible across languages and environments. Both apply directly to the Core purity invariant, and both are easy to reintroduce by accident.

**No ambient tokenizer.** An earlier version did `try: import tiktoken`, which made `TOKEN_BUDGET`, `QUTM_CEILING`, and `CONTEXT_LIMIT` depend on which optional packages happened to be installed — so the differential oracle could report a disagreement caused by the environment rather than the code. The contract is `chars/4` in every implementation. In the source's phrasing: *"Verdicts must not depend on which optional packages happen to be installed."* If exact tokenization is ever wanted, it arrives as an explicit flag, never an ambient import.

**No language-default rounding.** Python's `round()` is banker's rounding and diverges from JavaScript's `Math.round()` at `.005` boundaries. The linter uses `math.floor(x * 100 + 0.5) / 100` explicitly so both languages produce the same number — with a worked example: an estimate of 1 against a baseline of 200 yields `0.0` under Python's default and `0.01` under JavaScript's. **Any ported gate that does arithmetic needs the same treatment**; a rounding mode is a cross-language behavior difference that no amount of parity testing on identical inputs will surface, because both sides are internally consistent.

## Scaffolding new capability

```
npm run scaffold:gate -- --id MY_NEW_GATE
npm run scaffold:technique -- --source "<citation>"
```

**Neither generator exists yet.** They appear in no source archive, despite earlier drafts of this document and `CONTRIBUTING.md` instructing contributors to use them rather than hand-write files. They are worth building — pre-wiring the contract shape and a stub test is exactly how the property-test requirement stops being a review-time argument — but until then, write the files by hand.

**Nothing enforces the property-test requirement either.** This paragraph used to claim that "a gate without a property test fails the Core stage." There is no Core stage. *(CI arrived 23 August 2026 and runs `npm run verify`; it still does not check for property tests, so the sentence's point stands — the requirement is unenforced, not merely un-CI'd.)* Both ported gates do have property tests, and `CLAIM_DISCIPLINE` only got one after an audit noticed it had no test file at all while `GATES_REFERENCE.md` asserted every gate had both. Until something checks it, treat the requirement as a review convention.

What a new gate *is* checked against: `scripts/ported-gates.json` must list it, or `npm run differential` refuses to run — see [ADR-0007](./0007-permanent-differential-oracle.md).

## Purity instrumentation: what it covers, exactly

Core purity is enforced by **two** mechanisms that fail differently, and the distinction matters because for a while the documentation described one mechanism doing both jobs, and it was not doing the second.

| Concern | Mechanism | Why that one |
|---|---|---|
| Network via `fetch`, clock, randomness | `core/test/purity.setup.ts` | Globals are resolved at call time, so replacing them traps the call |
| Filesystem, sockets, subprocesses | `scripts/check-boundaries.mjs` | `core/src/**` may not import `node:fs` or any other effectful builtin at all |

The runtime harness **does not block the filesystem**, and three places — including its own header — said it did until an audit put `readFileSync` inside a Core gate and watched the suite pass. It cannot: Node builds the ESM facade for a builtin by copying the CJS exports when the module is first evaluated, which happens as the test file's import graph loads, before any setup hook runs. Measured on this repository:

```
import { readFileSync } from "node:fs"     → NOT interceptable
import * as fs from "node:fs"              → NOT interceptable
(await import("node:fs")).readFileSync     → NOT interceptable
require("fs").readFileSync                 → interceptable
```

Every Core module uses static ESM imports, so a runtime filesystem guard would have caught nothing while looking like it worked. The static check is stronger anyway: it reads every file under `core/src` whether or not a test runs it, which closes the coverage hole an earlier audit found — a Core module the harness never watched because no Core test imported it.

Neither mechanism subsumes the other. The static check cannot see an effect handed in at runtime; the harness cannot see a line no test reaches.

## Intended CI pipeline stages

**No CI service is configured.** These stages describe the intended pipeline; `npm run verify` runs stages 1, 2 and part of 3 locally today.

1. Lint (including import-boundary rule) + typecheck + contract schema validation
2. Core unit + property tests (no network) + Core purity instrumentation — see the table above for what that does and does not cover
3. Application orchestration tests against fake adapters
4. Adapter contract tests (against both implementations of each interface)
5. Shell integration tests + cross-shell parity check
6. Adversarial scorer run
7. Build-hash stamping + reproducibility check (see `RELEASE_OPERATIONS.md`)

Each stage must pass before the next runs; failures are attributed to the layer that owns them, not surfaced as a single opaque "CI failed."

## Debugging a run

Use `npm run trace:view -- --run-id <id>` (see `OBSERVABILITY.md`) to replay the event stream for any run without needing to reproduce it live.
