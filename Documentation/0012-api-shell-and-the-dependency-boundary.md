# ADR-0012: The API shell is adopted, and the zero-dependency property is scoped rather than lost

**Status:** Accepted — 29 August 2026
**Amends:** ADR-0004 (dual Shell strategy), as amended by ADR-0006 — the Shell inventory gains
a third member the earlier ADRs did not name.
**Related:** ADR-0001 (five-layer architecture), ADR-0005 (Application/orchestration boundary).

## Context

`shells/api` arrived on 27 August 2026 in commit `83890f1`, a Fastify REST shell nobody had
asked for, in the same commit that emptied `.gitignore` for the second time. It has never
compiled and has never been installable. For a week it sat excluded from `tsconfig.json` with
a comment saying exactly that, on the grounds that installing its dependencies was an
architecture decision rather than a build fix.

It then got worse rather than being resolved. Commit `2ba1b32` split the shell into `app.ts`
(routes) and `composition-root.ts` (wiring), landed both, and **truncated `src/index.ts` and
`package.json` to near-empty in the process**. A workspace with an unparseable `package.json`
cannot be resolved, so `npm ci` failed outright and CI could not install the project at all —
the shell's tests were not failing, they could never be collected. Master was red for reasons
that had nothing to do with any gate.

So the decision could not stay deferred. A directory that is neither owned nor deleted stops
being a question about architecture and becomes an outage.

## Decision

**Adopt it.** `shells/api` becomes the third Shell, and the repository's dependency property
is restated with a boundary instead of being quietly dropped.

### The dependency property, restated

The old claim was flat: *zero runtime dependencies*. That was true and load-bearing, and the
honest version after this change is not "we gave it up" but:

> **`contracts`, `core`, `application`, the adapters, and `shells/cli` have zero runtime
> dependencies. `shells/api` has two: `fastify` and `@fastify/sensible`.**

The property that actually mattered is preserved exactly. Nothing that computes a verdict, a
score, or a revision imports anything outside the standard library, so the differential
oracle, the anchor, and every gate remain reproducible from source with no registry involved.
What gained dependencies is an HTTP transport — the one place where writing your own is worse
engineering than depending on someone's, and the layer whose whole job is to be replaceable.

A flat claim over a repository with a web server in it would have to become false. A scoped
claim stays true and says more.

### What the declared dependencies were, and what they are

The shell declared four: `fastify`, `@fastify/cors`, `ajv`, `uuid`. It imports two:
`fastify` and `@fastify/sensible` — which it did **not** declare. Two of the four were never
imported at all, and the one dependency it genuinely needs was missing.

That is worth recording rather than quietly fixing, because it is diagnostic: the manifest was
written to look plausible rather than derived from the imports. The corrected manifest lists
the two the source actually uses, and `uuid` is not among them because `node:crypto`'s
`randomUUID` was already being used.

### The obsolete test is deleted, not rewritten

`test/api.test.ts` asserted sixteen endpoints — `/models/catalog`, `/projects`, `/settings`,
`/inference/generate`, `/compiler/optimize` — and response shapes (`status: "ok"`,
`version: "1.0.0"`, a five-element `layers` array) belonging to the 14.7 KB monolith that the
`2ba1b32` refactor replaced. The surviving `app.ts` implements six endpoints with different
shapes.

Two ways to make it pass, and both are wrong:

- **Implement the ten missing endpoints.** They exist in no contract, no ADR, and no user
  request; several would need a provider call. That is inventing a product surface from a
  generated test's assertions.
- **Rewrite the expectations to match `app.ts`.** This is writing the test from observed
  behaviour, which lets a wrong implementation define its own contract. It is the move
  `spec/manifest-shapes.json` exists to make impossible.

So it is deleted, and this ADR records the surface that remains. `test/app.test.ts` already
covers the routes through `inject()`; a new `test/index.test.ts` covers the socket seam that
`inject()` deliberately does not exercise.

### The API surface, as it now exists

| Method | Path | Returns |
|---|---|---|
| GET | `/api/v1/health` | `{ ok, service }` |
| GET | `/api/v1/system` | name, api version, core build hash, capabilities |
| GET | `/api/v1/hardware` | platform, arch, cpu count, rss |
| GET | `/api/v1/gates` | the ported gate list |
| GET | `/api/v1/provider/health` | the transport's health check, or 503 |
| POST | `/api/v1/compiler/lint` | a lint report and its worst verdict |
| POST | `/api/v1/compiler/compile` | one orchestrated run |

Six of these are pure reads over Core state. `compile` is the only one that can reach a
provider, and it goes through the Orchestrator like every other caller — the shell has no
path to a model that the CLI does not also have.

## Consequences

**Easier.** The shell compiles, is typechecked with everything else, and is tested. CI can
install the project again. `verify` covers a third Shell, which is what ADR-0004 wanted from
the inventory in the first place.

**Harder.** The repository now has a supply chain, small as it is. `fastify` and
`@fastify/sensible` pull a transitive tree that nothing here audits, and a dependency
advisory is now something that can affect this project. That is the real cost and it is not
zero.

**To revisit.** Whether the API shell should be able to reach a provider at all. Today
`compile` can, through the Orchestrator, and no run in this repository has ever reached one —
so the question is untested rather than answered. See `Documentation/TRUTH_BOUNDARY.md`.

## Alternatives rejected

**Delete the directory.** The shorter path, and it was the recommendation until a deployment
target turned out to be pointed at it. Deleting code someone is deploying is a decision for
whoever configured the deployment, not for whoever noticed the build was red.

**Keep excluding it from typecheck.** This is what the previous week did, and the exclusion
comment was honest about being a placeholder. It stopped working the moment the corrupt
manifest broke `npm ci`, because a tsconfig exclusion does not hide a workspace from npm.

**Vendor a minimal HTTP server instead.** Preserves the flat zero-dependency claim by writing
routing, parsing, and error handling by hand. It trades two audited dependencies for
several hundred lines of unaudited ones, in the layer least worth being clever in.
