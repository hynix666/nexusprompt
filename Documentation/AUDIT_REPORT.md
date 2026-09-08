# Security & Code Audit Report — nexusprompt

Generated: 2026-09-08
Repository: hynix666/nexusprompt

This document records the results of a full repository audit and CVE lookups performed against the workspace on 2026-09-08. It was created from an automated/manual review that inspected README, Documentation, workspace package.json files, scripts, adapters, core, shells, tests, and CI workflows. It includes prioritized findings, evidence (file paths and snippets where relevant), remediation steps, and recommended next actions. The audit also included a targeted CVE/advisory lookup for the repository devDependencies listed in the root package.json.

IMPORTANT: code-search results may be incomplete. See the repository search UI for more results: https://github.com/hynix666/nexusprompt/search

---

Executive summary

- Critical / Immediate: ajv@8.17.1 (devDependency) has a public ReDoS advisory (CVE-2025-69873 / GHSA-2g4f-4pwh-qvx6). Upgrade to a patched version (>= 8.18.0) as soon as possible.
- Good posture: The project contains many strong safeguards — loopback-only defaults for adapters and the API server if no token is set, offline/demo modes, extensive tests preventing leaking of provider keys, prepared SQL statements and careful SQLite transaction handling, and pinned actions in CI.
- Recommended: enable automated dependency scanning (Dependabot/Dependabot alerts/ Renovate / Snyk), add an automated secret scan in CI, and add an `engines` field to package.json to reduce local/CI node-version mismatches.

Findings (prioritized)

1) Critical — ajv ReDoS advisory
- Risk: Regular Expression Denial of Service (ReDoS) when Ajv `$data` option is in use. Can cause CI or tooling that validates attacker-controlled input to become unresponsive.
- Evidence: root package.json lists `"ajv": "^8.17.1"` in devDependencies.
  - File: package.json (root)
- Advisory / reference:
  - GHSA: https://github.com/advisories/GHSA-2g4f-4pwh-qvx6
  - NVD/CVE: https://nvd.nist.gov/vuln/detail/CVE-2025-69873
- Remediation:
  1. Upgrade ajv to a patched release (8.18.0 or later): `npm install --save-dev ajv@^8.18.0`.
  2. Run `npm run verify` in CI and locally to validate nothing regresses.
  3. If your code uses Ajv `$data`, review its use and sanitize input where practicable.
- Verification: run tests and the `verify` command in CI after bump.

2) High — Add automated dependency scanning and alerting
- Risk: New advisories may be missed without automated tooling.
- Evidence: No Dependabot/Dependabot config detected. Root package.json lists devDependencies which can drift.
- Remediation:
  - Add a Dependabot config (`.github/dependabot.yml`) or enable Renovate.
  - Optionally enable Snyk or GitHub Advanced Security alerts and set a policy for high/critical findings.
  - Add a CI job that runs `npm audit` or a Snyk scan and fails on high/critical severity.
- Benefit: Continuous monitoring and automatic PRs to update vulnerable packages.

3) High — Secret scanning and leakage prevention
- Risk: Secrets committed or printed to logs could be leaked; although tests assert the CLI never prints provider keys, human mistakes happen.
- Evidence:
  - core/src/gates/secret-leak-scan.ts — secret-detection regexes and commentary.
  - prompt_lint.py in sources includes SECRET_PATTERNS and bounded-quantifier notes.
  - test/dry-run.test.ts asserts the CLI never prints ANTHROPIC_API_KEY (and other keys) in outputs.
- Remediation:
  - Add GitHub secret scanning (if available) or a CI job running a secret scanner (git-secrets, truffleHog, detect-secrets) on PRs.
  - Add a pre-commit hook or CI check to quickly reject commits that include obvious token patterns.
  - Keep tests that assert keys aren't printed; expand them to other logging paths if necessary.

4) Medium — Network call configuration and proxy allowlists
- Risk: Misconfiguration could expose API tokens if API server binds to non-loopback addresses without auth.
- Evidence:
  - shells/api/src/index.ts prevents binding to non-loopback host unless NEXUSPROMPT_API_TOKEN is set.
  - adapters/provider-ollama/src/index.ts checks for loopback host and refuses otherwise.
  - Documentation/README and other docs describe offline/demo modes and how the allowlist works.
- Remediation:
  - Continue enforcing these runtime checks. Add operational documentation for deployments describing required environment variables and reverse-proxy placement.
  - Validate any new code paths that accept proxyUrl or build outbound URLs to ensure they validate/escape user input.

5) Medium — Regex performance & ReDoS guardrails
- Risk: New or modified regexes can reintroduce pathological cases leading to high CPU usage.
- Evidence:
  - core/src/gates/secret-leak-scan.ts comments and tests enforcing bounded quantifiers.
  - sources/v5/prompt_lint.py uses bounded patterns and documents timing behavior.
- Remediation:
  - Maintain the `bounded-quantifier` invariant tests; require performance tests for new regexes.
  - Add a lightweight CI smoke test for critical regex scans over large synthetic inputs if feasible.

6) Medium/low — CI and third-party actions
- Risk: Using mutable tags for actions can cause unintentional change. This repo pins actions to SHAs — good practice — but maintain a policy for updating them.
- Evidence: .github/workflows/verify.yml pins actions to SHAs for actions/checkout and setup-node.
- Remediation:
  - Keep pinning to SHAs. Add a periodic task to check action pin freshness and re-resolve pins deliberately.

7) Low — arXiv script uses HTTP
- Risk: scripts/check-citations-online.mjs calls `http://export.arxiv.org/api/query`. An HTTP endpoint can be susceptible to MITM; this script is intentionally offline/occasional.
- Evidence: scripts/check-citations-online.mjs uses ENDPOINT = "http://export.arxiv.org/api/query".
- Remediation:
  - If arXiv supports HTTPS, switch to `https://export.arxiv.org/api/query`.
  - Keep this script out of the `verify` offline pipeline (it already is), and run only in trusted environments.

8) Observations of good practices
- Prepared SQL statements and explicit transactions (adapters/storage-db) with BEGIN IMMEDIATE and correct rollback/commit semantics; concurrency tests exist that validate behaviour.
- API startup refuses to bind non-loopback without a token; adapters enforce loopback-only defaults for local daemons.
- Tests assert the CLI never prints provider keys; secrets scanning is present in the gate logic.
- README and Documentation explain the design and how `npm run verify` gates repository correctness. Contract-first policy is enforced by scripts.

Limitations and notes about the audit
- Code-search coverage may be incomplete (tooling limitation). For more targeted checks, run repository code search via the GitHub UI: https://github.com/hynix666/nexusprompt/search
- The CVE/advisory lookup targeted the devDependencies present in package.json. At the time of lookup, the only known advisory affecting the listed packages was the Ajv ReDoS advisory referenced above.

Concrete remediation steps (actionable)

Immediate
1. Upgrade Ajv to 8.18.0 or later in devDependencies.
   - Command: `npm install --save-dev ajv@^8.18.0`
   - Run: `npm ci && npm run verify` in local and CI.

Short term (1–7 days)
2. Add automated dependency scanning (Dependabot or Renovate). Example `.github/dependabot.yml` content:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
```

3. Add a CI job to run `npm audit --audit-level=moderate` or run Snyk and fail on high/critical.
4. Add a secret-scan step in CI (or enable GitHub's repository secret scanning if available). Tools: `detect-secrets`, `truffleHog`, `git-secrets`.

Medium term (1–4 weeks)
5. Add an `engines` field to package.json to declare supported Node versions (CI uses Node 24):

```json
"engines": {"node": ">=24"}
```

6. Consider swapping `http://export.arxiv.org` to HTTPS in `scripts/check-citations-online.mjs` if supported.
7. Add a scheduled task or workflow that runs an audit report and posts findings to maintainers.

Ongoing
8. Maintain regex performance tests and require them for contributions that add or modify regexes.
9. Keep GitHub Actions pinned to SHAs and update pins via deliberate PRs.
10. Maintain the project's existing tests that assert no key leaking — expand coverage where logging occurs.

Suggested follow-ups I can implement if you want
- Open a branch and PR that upgrades ajv and runs the test suite.
- Add `.github/dependabot.yml` and open a PR to enable Dependabot.
- Add a CI job that runs `npm audit` and/or a secret-scan action, and open a PR.
- Create an operational `SECURITY.md` describing how to report security issues and how to rotate keys if they leak.

Appendix — references
- GHSA advisory (Ajv ReDoS): https://github.com/advisories/GHSA-2g4f-4pwh-qvx6
- NVD / CVE-2025-69873: https://nvd.nist.gov/vuln/detail/CVE-2025-69873
- Repository: https://github.com/hynix666/nexusprompt

---

If you want, I can now:
- create a branch and open PRs implementing immediate fixes (ajv upgrade, Dependabot config, a CI audit job), or
- only add this audit file and leave code changes to you.

I added this file to the repository at Documentation/AUDIT_REPORT.md as requested.
