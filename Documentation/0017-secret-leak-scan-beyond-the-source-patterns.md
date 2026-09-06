# ADR-0017: SECRET_LEAK_SCAN carries four credential shapes the source does not

**Status:** Accepted — 6 September 2026
**Authorises:** entries 3–6 in `scripts/divergence-allowlist.json`.
**Related:** ADR-0007 (the differential oracle is permanent), ADR-0010 and ADR-0011 (the
prior divergences — both defect fixes, where these are an extension).

## Context

`SECRET_LEAK_SCAN` scans the compiled prompt's own text for credential and PII shapes and
emits **WARN** on a hit: "look here", not proof. The port carried the source's seven patterns
exactly:

```python
(r"sk-ant-[A-Za-z0-9_-]{20,128}", "anthropic_api_key"),
(r"sk-[A-Za-z0-9]{20,128}",       "generic_sk_key"),
(r"AKIA[0-9A-Z]{16}",             "aws_access_key_id"),
(r"ghp_[A-Za-z0-9]{30,128}",      "github_token"),
(r"xox[baprs]-[A-Za-z0-9-]{10,128}", "slack_token"),
(r"[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}", "pii_email"),
(r"\+[0-9][0-9 ().-]{8,20}[0-9]", "pii_phone_intl"),
```

Four credential shapes that routinely appear in prompts scan **clean** against that set:

| shape | why it reaches a prompt | source verdict |
|---|---|---|
| JWT / bearer token | pasted in as "context" for an API-calling assistant | PASS |
| PEM private key | pasted in to have the assistant "sign" something | PASS |
| `user:password@` in a URL | a `DATABASE_URL` copied into a prompt whole | PASS |
| Stripe `sk_live_…` | separator and body are underscores, so `sk-[A-Za-z0-9]` misses it | PASS |

The Stripe case is the sharpest, because the source *has* a generic `sk-` pattern and it
looks like it should cover Stripe. It does not: Stripe uses `sk_live_`/`sk_test_`, and both
the separator and the body underscores fall outside `sk-[A-Za-z0-9]{20,128}`.

A leak scanner returning clean is the one answer this gate must not get wrong. Every other
verdict it produces is advisory.

## Decision

Four patterns are added. `GATE_VERSION` goes to **1.2.0** — minor rather than patch, because
the gate now reports WARN on inputs it previously called clean, which changes lint outcomes
for callers even though no existing verdict was reversed.

```ts
[/eyJ[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{8,1024}/, "jwt"],
[/-----BEGIN [A-Z ]{0,32}PRIVATE KEY-----/, "private_key_block"],
[/[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,64}:[^\s:@/]{1,128}@/, "url_embedded_credentials"],
[/\bsk_(?:live|test)_[A-Za-z0-9]{16,128}/, "stripe_secret_key"],
```

The source's seven patterns are **untouched**, `generic_sk_key` included. This adds; it does
not edit.

Every quantifier stays bounded at both ends, and the `bounded-quantifier invariant` test
checks the structure of the list rather than trusting this paragraph. The `eyJ` and
`-----BEGIN ` prefixes also keep the scan linear the way `sk-ant-` does: retries only happen
at positions where the prefix occurs, so none of these can reproduce the quadratic case
`pii_email` demonstrates.

## The must-not-fire half is the load-bearing half

Widening a matcher buys detection with false positives, and a scanner that cries wolf gets
its WARN ignored — a false clean reached by a different road. The Stripe pattern is where
this stopped being theoretical.

The obvious repair for `sk_live_…` is one character of diff on the existing generic pattern:

```
sk-[A-Za-z0-9]{20,128}     →     sk[-_][A-Za-z0-9_]{20,128}
```

Measured, that fires on all of these:

| input | naive widening | shipped pattern |
|---|---|---|
| `task_manager_configuration_key` | **fires** | silent |
| `disk_usage_threshold_value_setting` | **fires** | silent |
| `risk_assessment_completion_status` | **fires** | silent |
| `sk_live_EXAMPLEONLYNOTREAL` | fires | fires |

`sk_` is a suffix of *ask*, *task*, *risk*, *desk*, *disk* and *mask*, and snake_case supplies
the rest. So the decision is a **specific** pattern with a leading `\b`, which cannot start
mid-identifier, rather than a looser generic one.

The same reasoning shapes the other three. `url_embedded_credentials` requires an actual
`user:password@` rather than a scheme, so a bare `postgres://localhost/db` — configuration,
not a secret — stays clean. `private_key_block` matches the header and not the base64 body,
and deliberately does not match `-----BEGIN CERTIFICATE-----`, which is public by
construction. Each pattern is probed in both directions in `core/test/secret-leak-scan.test.ts`.

## Consequences

**These are the first allowlist entries recording an extension rather than a defect fix.**
ADR-0007 built the mechanism for a port that deliberately *fixes* a source defect, and
ADR-0010 and ADR-0011 are both that shape: a false clean and an unclearable gate. The source
is not wrong about the shapes it carries — it simply does not carry these four. The entry
shape fits anyway, and the alternative is an undeclared difference, which is the outcome
ADR-0007 exists to prevent. The distinction is recorded in the allowlist's own comment block
so a later reader does not mistake these for bug reports against `prompt_lint.py`.

**No corpus case exercises any of the four**, so the oracle could not have raised them. The
entries' inline demonstrations are the only place the divergence is proven — precisely the
situation the inline-demonstration rule was built for, and the same one the `#Runtime
Variables` entry records.

**One demonstration is shaped by the source's own patterns.** The `url_embedded_credentials`
case uses `@localhost` rather than a dotted host: a dotted host also matches the source's
`pii_email`, the source would WARN too, and the entry would be demonstrating agreement rather
than divergence.

**The gate stays WARN.** A scanner with four more patterns and a FAIL verdict would block
runs on heuristics. The source's reasoning — a hit means look here, not proof — applies with
more force as the pattern set grows, not less.

**GitHub's push protection rejected the first version of this change**, and the rejection is
worth recording twice over. It is independent confirmation that the Stripe shape is right: a
scanner nobody here wrote read the test fixture as a live key. It is also a constraint on how
such a fixture may be written. The bodies in the allowlist demonstration, the table above and
the unit tests are kept under the 24 characters the partner pattern looks for; one test
assembles a full-length body at runtime so the pattern is still proven at real key length
without that string existing in the tree.

The move NOT taken was the offered one — following the unblock URL to allow the secret. A
repository that trains its own push protection to ignore `sk_live_…` has disarmed the control
to ship a test fixture, which is the same trade as deleting the oracle to make a build green.

## Alternatives rejected

**Widen `generic_sk_key` instead of adding a Stripe pattern.** Measured above; it fires on
ordinary snake_case identifiers. One character of diff, three false positives in the first
three strings tried.

**Add the patterns to `prompt_lint.py` too, keeping parity.** `sources/` is frozen and
SHA-256 verified against `MANIFEST.json`; `verify:sources` fails on any edit. That freeze is
what makes the oracle an oracle.

**Leave the gate faithful and document the gap.** A documented gap in a leak scanner is a
scanner that returns clean on a private key, with a footnote. The footnote does not reach
whoever reads the PASS.
