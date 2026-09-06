# ADR-0018: API auth is opt-in, the rate limit is not, and neither adds a dependency

**Status:** Accepted — 6 September 2026 — **amended by [ADR-0019](./0019-api-refuses-non-loopback-without-a-token.md)**, which refuses a non-loopback bind with no token and adds an aggregate provider ceiling. Read ADR-0019 alongside this one; where the two disagree on the auth default, ADR-0019 governs.
**Related:** ADR-0012 (the API shell and the dependency boundary), ADR-0005 (the
Application/orchestration boundary — why this lives in the Shell).

## Context

`shells/api` shipped with no authentication, no rate limit, and no request budget. Any caller
who could reach the port could `POST /api/v1/compiler/compile` and drive a full compile
against a configured provider. The CLI has `--max-calls`; the HTTP surface had no equivalent.

Two things made it less alarming than it sounds and one made it worse. It binds `127.0.0.1`
by default, and `HOST` is environment-overridable — so the exposure is one variable away. And
`USER_GUIDE.md` described the shell as "read-only status routes" with "no route to run a
pipeline or lint a prompt over HTTP", which was wrong from the day the shell was adopted:
`/api/v1/compiler/lint` and `/api/v1/compiler/compile` both existed. A reader auditing the
exposure from the documentation would have concluded there was nothing to protect.

## Decision

### Hand-rolled, no new dependencies

ADR-0012 states as a load-bearing claim that `shells/api` has exactly two runtime
dependencies, `fastify` and `@fastify/sensible`, and that sentence is quoted across the
documentation set. `@fastify/bearer-auth` and `@fastify/rate-limit` are both good, and both
would have required amending it.

A token comparison and a fixed window are small enough to own — roughly forty lines in
`shells/api/src/security.ts`, against `node:crypto` and a `Map`. ADR-0012's claim stays true
as written.

### Both controls are one `onRequest` hook

Not per-route checks. A route added later is covered without its author remembering, which is
the same reasoning that made the observability redaction a sink wrap rather than a convention
for call sites — and the convention is what turned out to be broken there.

### Auth is opt-in; the rate limit is always on

Absent `NEXUSPROMPT_API_TOKEN`, every route except `/api/v1/health` stays open and the server
warns on stderr at startup, naming the variable and the provider-request ceiling. Set the
token and the same routes require `Authorization: Bearer <token>`, compared against a SHA-256
digest with `timingSafeEqual` so neither timing nor a thrown length mismatch distinguishes a
near-miss.

The rate limit has no opt-out. That asymmetry is the decision: a rate limit needs no secret to
configure, so there is no deployment it cannot protect, and it is the half that bounds what an
unauthenticated caller can spend. Provider-reaching routes get a separate, tighter ceiling —
one number cannot serve both, since generous enough for `/gates` is far too generous for work
that costs money.

An unparseable limit is **refused at startup** rather than replaced with the default. A
caller who wrote `NEXUSPROMPT_RATE_LIMIT=0` meant something, and silently substituting 120
would enforce a ceiling they believe they removed — the failure mode `naiveTokens || 400`
already demonstrated once.

## What this deliberately leaves open

The opt-in default was chosen over refusing to start without a token, and over refusing only
on a non-loopback bind. Recording it here so a later audit reads it as a decision rather than
an oversight, and so the residual is stated rather than discovered:

**A deployment that never sets the token is unauthenticated, and nothing stops it.** The
warning goes to stderr, where a process manager may or may not surface it. A warning is not a
control. The finding this ADR responds to is therefore *bounded* rather than closed: the rate
limit caps the damage, auth prevents it, and only one of the two is on by default.

**The window is per process and in memory.** Two instances behind a load balancer enforce the
ceiling twice, once each, rather than once between them. A shared store is an adapter, not
forty lines in a Shell.

**`trustProxy` is off, so the client key is the socket address.** Behind a reverse proxy every
caller looks like the proxy and the limit becomes effectively global. Honouring
`X-Forwarded-For` without knowing the proxy is real is worse — any caller could mint a fresh
identity per request, which is a rate limiter that cannot limit. Turning it on needs the
proxy's address and is a deployment decision.

**There is still no cost budget.** The rate limit bounds requests, not spend. The CLI's
`--max-calls` has no HTTP equivalent, and `Orchestrator` already accepts a `budget` the API
never sets.

## Alternatives rejected

**Refuse to start without a token.** Strictest and simplest to reason about. Rejected because
it breaks `npm start -w @nexusprompt/shell-api` for anyone who has not set the variable, and
turns a local development server into a configuration exercise.

**Refuse only a non-loopback bind without a token.** Would have matched the existing loopback
default and the repository's "refuse before you spend" posture — the budget admission check
does exactly this shape. Rejected in favour of the simpler rule; recorded because it remains
the cheapest way to close the residual above if the default is ever revisited.

**Rate-limit by token rather than by IP.** Better under a proxy and meaningless while auth is
opt-in, since the unauthenticated case is the one that needs limiting most.
