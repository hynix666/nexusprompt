# ADR-0019: The API refuses a non-loopback bind with no token, and gets an aggregate provider ceiling (amends ADR-0018)

## Status
Accepted — amends ADR-0018, which remains in force except where this ADR supersedes it.

## Context

ADR-0018 chose warn-and-start over refusing to start, on the grounds that refusing "breaks
`npm start -w @nexusprompt/shell-api` for anyone who has not set the variable, and turns a
local development server into a configuration exercise." It recorded the residual explicitly:
"a deployment that never sets the token is unauthenticated, and nothing stops it," and named
the cheaper alternative it had rejected — "refuse only a non-loopback bind without a token" —
as the thing to revisit if the default ever changed.

Separately, ADR-0018 named a second residual: "the rate limit bounds requests, not spend."
`providerLimit` caps what one client, identified by `request.ip`, can do in a window. It caps
nothing about what every client does *together*: N distinct source addresses, each staying
under its own ceiling, have no aggregate limit between them.

Both residuals are closed here.

## Decision

### Refuse a non-loopback bind with no token

`createApiServer` now throws, before touching a socket, when `security.token === null` and
`host` is not loopback. The check reuses `isLoopbackHost` — the same predicate `startupWarning`
already used — so the two can never silently disagree about what counts as safe.

This closes the gap ADR-0018 accepted while leaving the concern it raised genuinely
unaffected: the default `HOST` is loopback, so `npm start` with no environment configured at
all still starts, exactly as before. The refusal only fires once an operator has *already* set
a non-loopback `HOST` — at which point telling them the token is also required is a single
coherent configuration step, not a new one.

`startupWarning`'s non-loopback branch is left as written. It is unreachable from this shell's
own entry point now (the refusal fires first), but the function is exported and general —
useful to anyone who calls `buildApi` directly without going through `createApiServer`'s gate.

### An aggregate ceiling on provider-tier requests

`globalProviderLimit`, checked only for requests the per-client `providerLimit` already
admitted — so a client refused by its own ceiling never also spends a unit of the shared one,
which would let one hostile client exhaust the aggregate budget for every well-behaved client
too. It shares the existing `FixedWindow` instance and window duration; a second instance
would roll on its own schedule and the two ceilings could disagree about which window a
request fell in.

Default `50` per window — five times the per-client default, on the reasoning that it should
mostly be a safety net behind normal single-operator use, not a ceiling a legitimate workload
brushes.

### A `Budget` through to `Orchestrator`, and what it honestly is

`composeApi()` now passes `providerCallBudgetFromEnv()` to the `Orchestrator`, so `admitRun`
is armed on the one path that previously left it unarmed unconditionally.

**This is not the spend control, and the code says so.** `Orchestrator.run()` always attempts
`maxAttempts` (a constant, 3) provider calls for the single stage the API's compile route
runs. `admitRun` compares that constant against `max_provider_calls`, so this can only ever
admit every request or refuse every request — there is no request volume it modulates, because
nothing about a single request changes the number being compared. Setting it below 3 is a
real, intentional use ("disable this route without touching auth"), not a misconfiguration to
guard against. The aggregate ceiling above is the actual spend control; this exists only so
the API is not the one path where `admitRun` reports "no budget declared" by construction.

A true per-request cost control — one that counts actual provider calls including retries,
rather than a constant — would need `PipelineOutcome` to report how many calls a run actually
made, which it does not; only the persisted `RevisionEntry.stage_attempt` does. Threading that
through is a contract change with its own version bump, and is not done here.

## Consequences

**What is now genuinely closed:** an operator who sets `HOST` to something other than loopback
without also setting a token gets a refusal naming both, before anything binds. A single
client, or many, cannot together exceed the aggregate provider ceiling regardless of how they
distribute their requests across source addresses.

**What is still open, stated so a later audit reads it as tracked rather than found again:**

- The window is still per process and in memory (ADR-0018's residual, unchanged).
- `trustProxy` is still off, so behind a reverse proxy every caller shares one bucket
  (ADR-0018's residual, unchanged).
- The aggregate ceiling counts *requests*, not provider calls or dollars. A client whose
  requests retry internally spends more of the real budget than the counter reflects, by up to
  `maxAttempts`×. Closing this precisely needs the contract change named above.
- `NEXUSPROMPT_MAX_PROVIDER_CALLS` set below 3 disables the compile route entirely, with no
  distinct message from "budget exceeded" versus "misconfigured" — both read the same to a
  caller. Acceptable because the only value below 3 that is not "disable everything" does not
  exist; there is no partial setting to get subtly wrong.

## Alternatives rejected

**Always refuse without a token, regardless of host.** ADR-0018 already rejected this and
nothing here changes the reasoning: it would still turn `npm start` into a configuration
exercise for the common local case.

**Count actual provider calls (with retries) for the per-request `Budget`, not a constant.**
Correct in principle, and requires `PipelineOutcome` to expose the true attempt count, which
today only the persisted `RevisionEntry` carries. A contract change belongs in its own PR
under this repository's contract-first rule, not folded into a Shell-level change.

**A global cap on dollars rather than requests.** Would need pricing data this repository does
not have and a provider that reports cost, which `ProviderTransport` does not require. The
request-count ceiling is the number actually available.
