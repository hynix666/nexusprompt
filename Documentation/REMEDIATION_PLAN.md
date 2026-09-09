# NexusPrompt Remediation & Implementation Plan

Created: 2026-09-08
Repository: hynix666/nexusprompt

Purpose

This plan converts the audit findings (Documentation/AUDIT_REPORT.md) into an actionable sequence of tasks, priorities, owners, and timelines. It is intended to be lightweight, executable, and safe to run alongside normal development. Each item includes the suggested branch name, PR title, verification steps, and estimated effort.

Summary of priorities

1. Critical (hours): Patch known CVE (ajv ReDoS) — block other changes until merged.
2. High (1–3 days): Add automated dependency scanning and CI audit jobs; add secret scanning in CI.
3. High (1–3 days): Investigate and resolve the stranded-merge issue (issue #148).
4. Short (this sprint): Merge audit report and add SECURITY.md.
5. Medium (1–4 weeks): Operational improvements (engines field, HTTPS arXiv, periodic audit workflow).
6. Ongoing: Maintain regex performance tests, keep Actions pinned to SHAs, Dependabot/renovate maintenance.

Task list (detailed)

A. Patch Ajv (critical)
- Objective: upgrade ajv to a patched release (>= 8.18.0) and ensure verify passes.
- Branch: `audit/fix-ajv-2026-09-08`
- PR title: `chore(deps): upgrade ajv to ^8.18.0 to patch ReDoS advisory (CVE-2025-69873)`
- Steps:
  1. Create branch from default branch.
  2. Run: `npm install --save-dev ajv@^8.18.0` and `npm ci`.
  3. Run full verification: `npm run verify` locally.
  4. Fix any test regressions (if present) and document changes in the PR.
  5. Push branch and open PR requesting expedited review.
- Verification:
  - CI `verify` job passes.
  - Tests pass locally and in CI.
- Estimated effort: 1–4 hours.
- Optional: add a short note in the PR linking to the GHSA/CVE reference and the audit file.

B. Enable automated dependency updates (high)
- Objective: add Dependabot config to open weekly PRs and keep dependencies current.
- Branch: `ops/dependabot-config-2026-09`
- PR title: `chore(ci): add Dependabot config for npm weekly updates`
- File to add: `.github/dependabot.yml`
- Suggested config (example below).
- Verification: Dependabot will open PRs on schedule; monitor for rolling updates.
- Estimated effort: 30–60 minutes.

C. Add CI advisory and secret-scan steps (high)
- Objective: run `npm audit` and a secret-scanner on PRs to detect high/critical advisories and accidental secrets.
- Branch: `ci/add-audit-secret-scan-2026-09-08`
- PR title: `ci: add npm-audit and secret-scan checks (non-blocking -> optional blocking)`
- Steps:
  1. Add a workflow file under `.github/workflows/audit.yml` that runs on PRs and schedule:
     - `npm ci && npm audit --json` and fail on high/critical (or post a report).
  2. Add a secret-scan step with one of these options (choose one):
     - GitHub Advanced Security (if enabled) — configure enabling instructions in SECURITY.md.
     - detect-secrets (Yelp) CLI run in CI: `detect-secrets scan --update .secrets.baseline` (prefer non-blocking until tuned).
     - truffleHog / git-secrets action to produce a report/comment.
  3. Start with non-blocking (comment with findings) for 1 week, then consider blocking on high-confidence hits.
- Verification: workflow runs on PRs and posts results; false positives tuned away.
- Estimated effort: 1–2 days to configure and tune.

D. Investigate & resolve stranded merge (issue #148) (parallel)
- Objective: understand PRs #158 and #93 that `check:merge-integrity` reported as merged but content absent from master.
- Branch: `ops/merge-integrity-investigation-2026-09-08` (if a fix commit is needed)
- PR title (if fix): `fix: restore missing content from PR #158 and #93 or record exception in merge-integrity ledger`
- Steps:
  1. Inspect PR #158 and #93 merge commits and compare their merged commits to master.
  2. Determine if omission is intentional (cherry-pick/partial merge) or accidental.
  3. If intentional, add an entry to `scripts/merge-integrity-ledger.json` documenting the exception.
  4. If accidental, create a restore PR that reapplies the missing commits cleanly.
- Verification: `npm run check:merge-integrity` passes with no unexplained findings; issue #148 closed.
- Estimated effort: 2–8 hours depending on root cause.

E. Merge audit report PR (currently open #181)
- Objective: land the audit report into the repository's default branch after the ajv fix or concurrently with other protections.
- Consideration: since the report announces a critical vulnerability, the ajv fix PR should be referenced or otherwise prioritized.
- Branch: existing `audit/add-audit-report-2026-09-08` (PR #181)
- Steps:
  1. Optionally update PR description to reference ajv fix PR.
  2. Request reviewers and merge once CI is green and ajv fix is in progress or merged.
- Estimated effort: 30–60 minutes.

F. Add SECURITY.md (short-term)
- Objective: provide a security contact and disclosure process, and quick key-rotation guidance for operators.
- Branch: `docs/add-security-md-2026-09-08`
- PR title: `docs: add SECURITY.md — vulnerability reporting & key rotation guidance`
- Suggested content:
  - Contact email or security issue template (e.g., security@your-org.example) or instruct to use GitHub private vulnerability reporting.
  - Steps to rotate provider keys (Anthropic, Ollama): revoke old, add new env vars, restart services.
  - TL;DR: Do not commit keys; use secrets in CI; follow the project's guidance.
- Verification: file present in repository; link from README.
- Estimated effort: 1–2 hours.

G. Operational improvements (1–4 weeks)
- Tasks:
  1. Add `engines` field to root package.json: `"engines": {"node": ">=24"}`.
  2. Switch arXiv endpoint to HTTPS in `scripts/check-citations-online.mjs` if supported.
  3. Add scheduled audit workflow that runs monthly and posts a digest to maintainers.
  4. Add performance smoke tests for critical regexes (run a few large synthetic inputs and ensure scan completes within bounded time).
- Branch naming: `ops/engines-and-ops-2026-09-08`
- Estimated effort: 3–10 days spread across tasks, depending on test and tuning time.

H. Ongoing maintenance
- Tasks:
  - Keep GitHub Actions pinned to SHAs and resolve them periodically.
  - Tune Dependabot/renovate PR cadence and auto-merge policy for safe upgrades.
  - Enforce that any new regex additions include the bounded-quantifier invariant test and a performance check.

Owners & reviewers
- Suggested owners (replace with repo members):
  - Security lead / primary contact: @hynix666
  - CI / Ops: a maintainer experienced with GitHub Actions
  - Core code owner: reviewer(s) from `core/` package (list in CODEOWNERS if present)
  - DB / storage: reviewer(s) from `adapters/storage-db`

Labels & PR meta
- Use labels to help triage:
  - security, high-priority, chore(deps), ci, docs, ops
- Use branch naming convention: `type/scope-YYYY-MM-DD` (examples above).

Verification matrix (what must pass for each critical change)
- All PRs that change dependencies or CI must pass `npm run verify` in CI and locally where reproducible.
- Secret-scan initial rollout: run non-blocking for 7 days, fix false positives, then consider blocking on high-confidence hits.
- Merge-integrity: run `npm run check:merge-integrity` after fixes or ledger updates to ensure no unexplained stranded merges remain.

Communication & timeline
- Day 0 (now): open Ajv patch PR. Tag it with `security, fast-track` and request at least one reviewer.
- Day 1–3: land Ajv PR, add Dependabot PR, add CI audit PR (non-blocking), and investigate merge-integrity issue.
- Day 3–7: merge Dependabot config and CI audit workflow; tune secret-scan to reduce false positives.
- Week 1–2: add SECURITY.md, engines field, and schedule audits.

Optional: I can implement the highest-priority tasks for you
- If you want, I will:
  1. Create the Ajv fix branch, bump ajv, run `npm run verify`, and open PR.
  2. Add Dependabot config in a PR.
  3. Add initial CI audit + secret-scan workflow in a PR (non-blocking by default).

Confirm which of the optional steps you want me to do now.
