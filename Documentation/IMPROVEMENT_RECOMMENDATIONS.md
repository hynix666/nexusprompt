# Improvement Recommendations

**Status:** Historical — an earlier improvement initiative, not the live plan.  
**Related:** [`IMPROVEMENT_PLAN.md`](./IMPROVEMENT_PLAN.md) (its companion), [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) (the live, machine-checked one), [`VERIFICATION_REPORT.md`](./VERIFICATION_REPORT.md)

> **Corrected 30 August 2026.** This header claimed *Document ID: ADR-0014 (proposed)* and
> *Created: 2024*. It is not an ADR and never entered the sequence; ADR-0014 is
> [`0014-malformed-response-is-not-demo-mode.md`](./0014-malformed-response-is-not-demo-mode.md),
> landed on 30 August 2026. A document claiming a number in a sequence it is not in is
> exactly what the ADR index exists to make checkable — and the link to
> `../IMPROVEMENT_PLAN.md` went dangling when that file moved into this directory.

---

## Executive Summary

This document consolidates 10 prioritized improvement recommendations for NexusPrompt, derived from comprehensive codebase analysis and verification results. The recommendations address structural gaps, validation requirements, and polish items to transition the platform from verified prototype to production-ready system.

**Key Findings:**
- ✅ Exceptional verification discipline (1,401 tests, 37 test files, 27 checks passing)
- ⚠️ **Critical Gap**: No live provider evaluation has ever been run—all figures from pinned stubs
- ⚠️ Missing adapters: `provider-hosted-server`, `storage-db` (documented but unbuilt)
- ⚠️ TypeScript strictness gaps: 25 + 208 errors from two stricter compiler flags
- ⚠️ Judge adapter implemented but never used for grading

**Implementation Timeline:** 16 weeks across 3 phases (detailed in [`/IMPROVEMENT_PLAN.md`](../IMPROVEMENT_PLAN.md))

---

## Recommendation #1: Complete Live Provider Integration

### Priority: 🔴 HIGH (Phase 1, Week 1-2)

### Problem Statement
The system has never called a real provider. All evaluations use stubs, meaning:
- Cache mechanisms unvalidated in production conditions
- Budget enforcement (`--max-calls`) untested with real API limits
- Provider failure classification theoretical only
- README explicitly states: "Nothing here has ever called a model" (line 152)

### Impact
Cannot validate real-world behavior, cache hit rates, cost controls, or error handling under actual API constraints.

### Proposed Solution
Run one 100-trial live evaluation with strict budget cap using `ANTHROPIC_API_KEY`:

```bash
export ANTHROPIC_API_KEY=<key>
npm run eval -- --live --trials 100 --max-calls 100 --verbose
```

### Validation Criteria
- [ ] Live evaluation completes without errors
- [ ] Cache tokens observed in ≥1 trial (`cache_read_tokens` present in results)
- [ ] Budget limit enforced (no more than specified calls made)
- [ ] All failures properly classified (timeout, rate-limit, auth-error, content-filter)
- [ ] README updated to reflect live validation completed

### Owner
Core Engineering

### Dependencies
None

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| API costs exceed budget | Medium | Low | Use strict `--max-calls` limit, start with 10 trials |
| Rate limiting disrupts test | High | Low | Implement exponential backoff, retry logic |
| Cache mechanism fails | Low | Medium | Log detailed cache state for debugging |

---

## Recommendation #2: Build Missing Adapters

### Priority: 🔴 HIGH (Phase 2, Week 5-10)

### Problem Statement
Two critical adapters documented in ADR-0006 and Implementation Plan remain unbuilt:
1. **`provider-hosted-server`**: Enables deployment as HTTP service, not just CLI
2. **`storage-db`**: PostgreSQL/SQLite adapter for production revision history

Current limitation: Only `storage-filesystem` exists, limiting to ~8 revision runs before manual cleanup required.

### Impact
- Limits deployment options to local-only usage
- Cannot support multi-user or production scenarios
- Revision history constrained by filesystem capacity

### Proposed Solution

#### 2.1 Storage-DB Adapter
Design as greenfield implementation (not a port):
- Contract-first: derive schema from `storage-filesystem` interface
- Migration-friendly: include version tracking and rollback capability
- Production-ready: indexes, constraints, audit fields

**Schema Design:**
```sql
CREATE TABLE substrates (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE revisions (
  id UUID PRIMARY KEY,
  substrate_id UUID NOT NULL REFERENCES substrates(id),
  revision_number INTEGER NOT NULL,
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB,
  UNIQUE(substrate_id, revision_number)
);

CREATE INDEX idx_revisions_substrate ON revisions(substrate_id, revision_number DESC);
CREATE INDEX idx_revisions_created ON revisions(created_at DESC);
```

**Migration Script Requirements:**
- Backup existing filesystem data
- Convert all revisions to database format
- Verify zero data loss
- Provide rollback option

#### 2.2 Provider-Hosted-Server Adapter
Map the 27-assertion proxy security suite for hosted provider:
- Authentication/authorization layer
- Rate limiting per tenant
- Request/response logging
- Health check endpoints

### Validation Criteria
- [ ] All 27 assertion proxy security tests pass
- [ ] Migration script converts existing filesystem data without loss
- [ ] Performance: ≥1000 reads/sec, ≥100 writes/sec on standard hardware
- [ ] Zero data loss in failover scenarios
- [ ] Connection pooling and retry logic functional

### Owner
Backend Engineering

### Dependencies
Recommendation #1 (live provider experience informs design)

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Data loss during migration | Low | High | Backup before migration, test on copy first, provide rollback |
| Schema design requires iteration | Medium | Medium | Design review with team, prototype with small dataset |
| Performance below target | Low | Medium | Benchmark early, add indexes iteratively |

---

## Recommendation #3: Address TypeScript Strictness Gaps

### Priority: 🟠 HIGH (Phase 1, Week 1-4)

### Problem Statement
Two stricter TypeScript compiler flags measured but not adopted:
- `exactOptionalPropertyTypes`: **25 errors**
- `noUncheckedIndexedAccess`: **208 errors**

Current `tsconfig.json` uses strict mode but excludes these flags, creating type safety gaps in production code.

### Impact
- Potential runtime errors from undefined array accesses
- Optional property misuse not caught at compile time
- Similar to `noUnusedLocals` issue previously caught defects

### Proposed Solution

**Phase 1: Enable `exactOptionalPropertyTypes` (25 errors)**
```bash
npx tsc --exactOptionalPropertyTypes --noEmit
# Fix all 25 errors incrementally
# Add to tsconfig.json permanently
```

**Phase 2: Begin `noUncheckedIndexedAccess` remediation (target: 50% of 208 errors)**
```bash
npx tsc --noUncheckedIndexedAccess --noEmit
# Group errors by file or error type
# Fix in batches with verification after each
# Target: ≤104 errors remaining by end of Phase 1
```

**Approach:**
1. Enable flag in `tsconfig.json`
2. Run `tsc --noEmit` to get complete error list
3. Categorize errors (by file, by pattern)
4. Fix incrementally with commits after each batch
5. Run full test suite after each fix batch
6. Add lint rule to prevent regression

### Validation Criteria
- [ ] `exactOptionalPropertyTypes`: 0 errors, flag enabled in `tsconfig.json`
- [ ] `noUncheckedIndexedAccess`: ≤104 errors remaining (50% reduction)
- [ ] No test failures from type changes
- [ ] Lint rule added to prevent regression

### Owner
Core Engineering

### Dependencies
None

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Type fixes break runtime behavior | Low | Medium | Comprehensive test suite catches regressions |
| Time estimate underestimated | Medium | Low | Prioritize high-impact fixes first |
| Team productivity dips during fix period | Medium | Low | Spread work over 2 weeks, not concentrated |

---

## Recommendation #4: Expand Test Coverage Beyond Deterministic Path

### Priority: 🟠 MEDIUM (Phase 2, Week 7-8)

### Problem Statement
Current evaluation measures recall thoroughly via `substrates: 0` catch-all, but:
- **False-positive rates unmeasured**—precision assumed, not validated
- Error paths (provider failures, timeouts, rate limits) lack coverage
- Cache miss scenarios not explicitly tested
- No chaos testing for random provider failures

### Impact
Detector quality incompletely characterized. Unknown false-positive rate could flag clean outputs incorrectly.

### Proposed Solution

#### 4.1 Add Negative Control Test Cases
Create test cases with known-clean substrates that should pass all detectors:
- Simple arithmetic outputs (no templates, no citations)
- Plain text responses with no special formatting
- Outputs with British English spellings (sanitisation, colour, behaviour)
- Unicode edge cases that are valid but unusual

#### 4.2 Test Error Paths Explicitly
- Provider timeout scenarios
- Rate limit exceeded responses
- Authentication failures
- Network interruptions mid-call
- Malformed API responses

#### 4.3 Add Chaos Testing
Implement randomized failure injection:
- Random provider failures during evaluation (10% failure rate)
- Intermittent cache unavailability
- Budget exhaustion mid-run

### Validation Criteria
- [ ] Precision measured alongside recall for all detectors
- [ ] False-positive rate < 5% for all detectors
- [ ] Test suite expands by 10-15 negative control cases
- [ ] Code coverage for error paths ≥ 80%
- [ ] All provider failure modes have test coverage
- [ ] Chaos tests run in CI weekly

### Owner
QA/Testing

### Dependencies
Recommendation #1 (need live provider for realistic error simulation)

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| False positives higher than expected | Medium | Medium | Document and tune detectors, update allowlists |
| Chaos tests flaky in CI | High | Low | Make deterministic with seeded randomness |
| Error path coverage expensive to achieve | Low | Low | Prioritize most likely failure modes first |

---

## Recommendation #5: Complete Catalog Citation Verification

### Priority: 🟡 MEDIUM (Phase 3, Week 11-12)

### Problem Statement
From VERIFICATION_REPORT.md:
- 195 technique records in catalog
- 12 non-arXiv citations remain unverified
- arXiv title verification found 5% error rate
- Unknown error rate in non-arXiv sources (IEEE, ACM, Springer, etc.)

### Impact
Catalog credibility depends on citation accuracy. Unverified citations may contain errors affecting technique descriptions.

### Proposed Solution

#### 5.1 Integrate External APIs
- **Crossref API** (free for metadata): Query DOI-based citations
- **Publisher APIs**: IEEE Xplore, ACM Digital Library, SpringerLink (may require institutional access)
- **Semantic Scholar API**: Alternative source for validation

#### 5.2 Verification Process
For each of 12 non-arXiv citations:
1. Query external API by DOI/title/author
2. Compare retrieved metadata with catalog entry
3. Flag discrepancies for manual review
4. Update catalog if errors found
5. Document verification methodology and error rates

#### 5.3 Automated Verification Job
Create scheduled job to:
- Re-verify all citations monthly
- Alert on newly discovered discrepancies
- Track citation health over time

### Validation Criteria
- [ ] 100% of catalog citations verified (195/195)
- [ ] Automated verification runs weekly
- [ ] Error rate documented and < 2%
- [ ] Discrepancy resolution process documented

### Owner
Research/Documentation

### Dependencies
None

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Publisher APIs require paid access | Medium | Low | Use Crossref first, request institutional access for others |
| Citations unverifiable (dead links) | Low | Medium | Archive snapshot, mark as "historical reference" |
| High error rate found | Low | Medium | Prioritize corrections by technique importance |

---

## Recommendation #6: Add Judge Adapter

### Priority: 🟠 MEDIUM (Phase 2, Week 5-6)

### Problem Statement
From VERIFICATION_REPORT.md and codebase analysis:
- `judge-verdict` schema implemented in contracts
- **No judge has ever graded anything**
- Free-form outputs requiring semantic judgement cannot be evaluated
- Current evaluation limited to deterministic gate checks

### Impact
Cannot evaluate prompt quality beyond constraint violations. Semantic correctness, helpfulness, and task completion unmeasured.

### Proposed Solution

#### 6.1 Implement Judge Adapter
Follow contract-first design pattern:
```typescript
// packages/adapters/judge-verdict/src/schema.ts
interface JudgeVerdict {
  task_id: string;
  output_id: string;
  judge_id: string;
  verdict: 'pass' | 'fail' | 'uncertain';
  confidence: number;  // 0.0 - 1.0
  rationale: string;
  timestamp: string;
}
```

#### 6.2 Add Agreement Measurement
Implement inter-judge reliability metrics:
- Run multiple judges on same outputs
- Calculate Cohen's kappa or Fleiss' kappa
- Target agreement score ≥ 0.7

#### 6.3 Position Randomization
Detect and mitigate position bias:
- Randomize order of outputs presented to judge
- Compare grades across different orderings
- Flag systematic biases

#### 6.4 Judge Evaluation Suite
Create meta-evaluation:
- Judges grade judges
- Human calibration set for ground truth
- Continuous monitoring of judge drift

### Architecture
```
packages/adapters/judge-verdict/
├── src/
│   ├── index.ts          # Adapter entry point
│   ├── schema.ts         # Contract definition
│   ├── grader.ts         # Grading logic
│   └── agreement.ts      # Inter-judge agreement metrics
├── tests/
│   ├── judge.test.ts     # Unit tests
│   └── agreement.test.ts # Agreement measurement tests
└── README.md
```

### Validation Criteria
- [ ] Judge can grade free-form outputs
- [ ] Agreement score ≥ 0.7 between different judges on same task
- [ ] Position randomization shows no systematic bias
- [ ] 20+ unit tests covering edge cases
- [ ] Judge evaluation suite passes

### Owner
Core Engineering

### Dependencies
Recommendation #1 (live provider experience needed for judge prompts)

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Judge disagreement too high | Medium | Medium | Calibrate with human grading, adjust prompts |
| Judge costs escalate | Medium | Low | Cache judge decisions, use smaller models for simple tasks |
| Position bias detected | Low | Medium | Implement counterbalancing, document limitation |

---

## Recommendation #7: Complete Remaining Shells

### Priority: 🟢 LOW (Phase 3, Week 11-13)

### Problem Statement
From ADR-0006 (Dual Shell Strategy):
- `shells/cli/` ✅ Complete
- `shells/api/` ✅ Complete (7 endpoints, adopted 29 Aug)
- `pipeline-ui` ❌ Unbuilt
- `toolkit-ui` ❌ Unbuilt

Capability exists but presentation layer incomplete for non-CLI users.

### Impact
Limited adoption potential. Users uncomfortable with CLI cannot access platform capabilities.

### Proposed Solution

#### 7.1 Build Shared Presentation Package First
Create reusable component library:
```
packages/presentation/
├── components/       # Reusable UI components
│   ├── PipelineViewer.tsx
│   ├── StageEditor.tsx
│   ├── EvidenceTable.tsx
│   └── ...
├── hooks/           # React hooks for state management
│   ├── usePipeline.ts
│   ├── useEvidence.ts
│   └── ...
├── utils/           # Shared utilities
├── styles/          # Global styles, theme
└── index.ts         # Public API
```

#### 7.2 Implement Pipeline-UI Shell
Features:
- Visual pipeline stage progression
- Interactive brief editor
- Real-time revision comparison
- Evidence visualization

#### 7.3 Implement Toolkit-UI Shell
Features:
- Gate configuration interface
- Catalog browser
- Evaluation dashboard
- Settings management

#### 7.4 Accessibility & Performance
- WCAG 2.1 AA compliance
- Lighthouse score ≥ 90
- Bundle size < 500KB gzipped
- Cross-browser compatibility (Chrome, Firefox, Safari, Edge)

### Validation Criteria
- [ ] Both shells functional with all core features
- [ ] Lighthouse score ≥ 90 for performance, accessibility
- [ ] Bundle size < 500KB gzipped
- [ ] Cross-browser compatibility verified
- [ ] Accessibility audit passed (WCAG 2.1 AA)

### Owner
Frontend Engineering

### Dependencies
Recommendations #2 (storage-db), #6 (judge adapter)

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Scope creep in UI features | High | Medium | Stick to core feature parity with CLI |
| Bundle size exceeds target | Medium | Low | Lazy loading, code splitting |
| Accessibility compliance difficult | Medium | Medium | Engage accessibility consultant early |

---

## Recommendation #8: Document British English False Positive

### Priority: 🟢 LOW (Phase 3, Week 14, 2 days)

### Problem Statement
Safety gate regex pattern `sanitiz` misses British spelling "sanitisation":
- American: `sanitize`, `sanitizing`, `sanitized`
- British: `sanitise`, `sanitising`, `sanitised`, `sanitisation`

This creates orthographic false negative in safety check—British English outputs may be incorrectly flagged.

### Impact
Minor user experience issue for British English users. Could flag legitimate content as suspicious.

### Proposed Solution

#### Option A: Fix Regex (Recommended if parity not critical)
Update pattern to match both variants:
```regex
/saniti[sz]e|saniti[sz]ing|saniti[sz]ed|sanitisat?ion/i
```

#### Option B: Add to Divergence Allowlist (Recommended if parity required)
Document known limitation in SAFETY.md:
```markdown
## Known Limitations

### Orthographic False Negatives

The safety gate uses American English spelling patterns. British English 
spellings (sanitisation, colour, behaviour) may trigger false positives.

This is a deliberate choice to maintain parity with the frozen Python 
reference implementation. See ADR-XXX for discussion.
```

### Decision Matrix

| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| Fix regex | More accurate, better UX | May break parity with reference | If parity not critical |
| Allowlist | Maintains parity, documents limitation | Perpetuates false positive | If parity required |

### Validation Criteria
- [ ] Decision documented with rationale in SAFETY.md
- [ ] Test case added to prevent regression
- [ ] No new false positives introduced
- [ ] If fixed: British spellings correctly handled
- [ ] If allowlisted: Clear documentation for users

### Owner
Documentation

### Dependencies
Recommendation #4 (precision measurement)

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Fix introduces new false positives | Low | Low | Add comprehensive test suite |
| Documentation overlooked | Low | Low | Add to contributor checklist |

---

## Recommendation #9: Add Precision Measurement to Evaluation

### Priority: 🟠 MEDIUM (Phase 1, Week 2-3)

### Problem Statement
Current evaluation suites measure recall thoroughly:
- `compile-smoke`: 14/14 cases, score 1.000
- `gate-recall-anchor`: 4,906 cases, recall 1.0000
- `compile-adversarial`: 3/11 caught, 8 evasions documented

**But precision is assumed, not measured.** False-positive rates unknown for all detectors.

### Impact
Cannot distinguish between:
- Detector catching all violations (good recall, good precision)
- Detector flagging everything (good recall, terrible precision)

### Proposed Solution

#### 9.1 Create Precision Test Suite
New evaluation suite measuring false-positive rate:
```typescript
// eval/precision-smoke.test.ts
describe('detector-precision@1.0.0', () => {
  it('clean-arithmetic-output-passes', () => {
    // Simple math, no templates, no citations
    // Should pass all gates
  });
  
  it('plain-text-response-passes', () => {
    // Natural language, no special formatting
    // Should pass all gates
  });
  
  it('british-english-spellings-pass', () => {
    // "sanitisation", "colour", "behaviour"
    // Should pass safety gate
  });
});
```

#### 9.2 Add Precision Metric to Output
Extend evaluation output format:
```json
{
  "suite": "detector-precision@1.0.0",
  "score": 0.95,
  "false_positive_rate": 0.05,
  "cases": [
    {"name": "clean-arithmetic", "expected": "pass", "actual": "pass"},
    {"name": "plain-text", "expected": "pass", "actual": "fail", "error": "safety gate"}
  ]
}
```

#### 9.3 Update Evaluation Documentation
Document precision methodology:
- How negative controls constructed
- What false-positive rate acceptable
- How precision trades off with recall

### Validation Criteria
- [ ] Precision measured alongside recall
- [ ] False-positive rate < 5% for all detectors
- [ ] Test suite expands by 10-15 negative cases
- [ ] Evaluation documentation updated with precision methodology

### Owner
QA/Testing

### Dependencies
Can run in parallel with Recommendation #1 (using stubs initially)

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| False-positive rate higher than expected | Medium | Medium | Tune detectors, update allowlists |
| Negative controls difficult to construct | Low | Low | Start with obvious cases, iterate |

---

## Recommendation #10: Strengthen Guard Probing

### Priority: 🟢 LOW (Phase 3, Week 15-16)

### Problem Statement
During development, three guards found narrower than their names:

1. **Purity Harness**: Never blocked filesystem access in testing
2. **Typecheck**: Covered only 1/3 of codebase (not all TypeScript files)
3. **Cross-Shell Rule**: Missed relative imports between shells

Risk register R9 documents this gap.

### Impact
Security guarantees weaker than claimed. Attackers could exploit guard limitations.

### Proposed Solution

#### 10.1 Create Probe Coverage Framework
Systematic testing of guard boundaries:
```typescript
// tests/guards/probe-coverage.test.ts
describe('guard-probe-coverage@1.0.0', () => {
  describe('purity-harness', () => {
    it('blocks-fs-read', () => { /* test */ });
    it('blocks-fs-write', () => { /* test */ });
    it('blocks-network-call', () => { /* test */ });
    it('blocks-env-var-access', () => { /* test */ });
  });
  
  describe('typecheck', () => {
    it('covers-all-ts-files', () => { /* test */ });
    it('catches-implicit-any', () => { /* test */ });
    it('enforces-no-unused-vars', () => { /* test */ });
  });
  
  describe('cross-shell-rule', () => {
    it('blocks-relative-import-cli-to-api', () => { /* test */ });
    it('blocks-relative-import-api-to-cli', () => { /* test */ });
    it('allows-shared-package-imports', () => { /* test */ });
  });
});
```

#### 10.2 Expand Typecheck Coverage
Ensure all TypeScript files checked:
- Core: 100% ✅
- Application: 100% ✅
- Adapters: 100% ✅
- Shells: Currently ~33%, target 100%

#### 10.3 Fix Cross-Shell Import Detection
Update boundary linter to catch:
- Relative imports (`../`, `./`)
- Absolute imports crossing shell boundaries
- Indirect imports via shared packages

#### 10.4 Document Guard Limitations
For each guard, document:
- What it protects against
- What it does NOT protect against
- Assumptions made
- Known bypasses (if any)

### Probe Categories

| Guard Category | Test Vectors |
|---------------|--------------|
| **Purity** | Filesystem read/write, network calls, environment variables, child processes |
| **Type Safety** | All TypeScript files, implicit any, unused variables, type mismatches |
| **Import Rules** | Relative imports, absolute imports, cross-shell, external packages |

### Validation Criteria
- [ ] All guards pass expanded probe suite
- [ ] Coverage report generated for each guard
- [ ] Zero critical security gaps found
- [ ] Typecheck covers 100% of TypeScript files
- [ ] Cross-shell import detection comprehensive
- [ ] Guard limitations documented

### Owner
QA/Security

### Dependencies
All previous phases (need complete system to probe)

### Risks & Mitigation
| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Critical gaps found late | Medium | High | Start probing early, iterate |
| Probe suite becomes maintenance burden | Low | Low | Automate generation where possible |
| Guard fixes break existing functionality | Low | Medium | Comprehensive regression testing |

---

## Risk Register Updates

### Open Risks from Original Register

| Risk ID | Description | Status | Mitigation Plan | Owner |
|---------|-------------|--------|-----------------|-------|
| R3 | Storage adapter scalability | Open | Address in Phase 2.2 with proper schema design | Backend Eng |
| R6 | Live evaluation uncertainty | Open | Live validation in Phase 1.1 will provide data | Core Eng |
| R7 | Judge reliability unknown | Open | Judge adapter in Phase 2.1 enables measurement | Core Eng |

### New Risks Introduced by Recommendations

| Risk | Probability | Impact | Mitigation | Phase |
|------|-------------|--------|------------|-------|
| Live API costs exceed budget | Medium | Low | Use strict `--max-calls` limit, start with 10 trials | 1 |
| Database migration data loss | Low | High | Backup before migration, test on copy first | 2 |
| Judge disagreement too high | Medium | Medium | Calibrate with human grading, adjust prompts | 2 |
| TypeScript fixes break runtime | Low | Medium | Comprehensive test suite catches regressions | 1 |
| UI scope creep delays delivery | High | Medium | Stick to core feature parity with CLI | 3 |
| Citation verification reveals high error rate | Low | Medium | Prioritize corrections by technique importance | 3 |

---

## Success Metrics by Phase

### Phase 1 Completion Criteria (Week 4)
- [ ] Live evaluation completed with ≥100 trials
- [ ] Precision and recall both measured
- [ ] TypeScript strictness errors reduced by 50% (≥117 errors fixed)
- [ ] Zero critical bugs from live testing

### Phase 2 Completion Criteria (Week 10)
- [ ] Judge adapter operational with agreement ≥ 0.7
- [ ] Database adapter passes all 27 security assertions
- [ ] Migration script tested with zero data loss
- [ ] Error path coverage ≥ 80%

### Phase 3 Completion Criteria (Week 16)
- [ ] Both UI shells functional and accessible
- [ ] 100% citation verification complete (195/195)
- [ ] All guards pass expanded probe suite
- [ ] Documentation updated for all changes

### Overall Project Success
- [ ] System validated with real providers (not just stubs)
- [ ] All high-priority recommendations addressed (1, 2, 3, 6)
- [ ] Type safety improved (both strict flags enabled or documented exceptions)
- [ ] Test coverage expanded to non-deterministic paths
- [ ] Production-ready deployment options available (database storage)

---

## Resource Requirements

### Personnel
- **Core Engineering**: 2 FTE (Phases 1-3)
- **Backend Engineering**: 1 FTE (Phase 2)
- **Frontend Engineering**: 1 FTE (Phase 3)
- **QA/Testing**: 1 FTE (Phases 1-2)
- **Documentation**: 0.5 FTE (Phase 3)

### Infrastructure
- **CI/CD**: Additional compute for live evaluations (estimated $50-100/month)
- **Database**: PostgreSQL instance for testing (can use free tier initially)
- **API Credits**: Anthropic API budget for live testing ($200 initial allocation)

### Tools & Services
- Crossref API access (free for metadata)
- Publisher APIs (may require institutional access)
- Performance testing tools (k6 or Artillery)
- Accessibility testing tools (axe-core, WAVE)

---

## Timeline Summary

| Phase | Duration | Key Deliverables | Exit Criteria |
|-------|----------|------------------|---------------|
| **Phase 1: Foundation & Live Validation** | Weeks 1-4 | Live validation, precision metrics, type fixes | Live eval complete, precision measured, 50% type errors fixed |
| **Phase 2: Complete Missing Components** | Weeks 5-10 | Judge adapter, DB adapter, expanded tests | All adapters built, error coverage ≥80%, judge agreement ≥0.7 |
| **Phase 3: Polish, Documentation & UI** | Weeks 11-16 | UI shells, citation verification, guard hardening | UIs functional, 100% citations verified, all guards probed |

**Total Duration:** 16 weeks (4 months)  
**Critical Path:** Phase 1 → Phase 2 → Phase 3 (sequential dependencies exist)

---

## Verification Checklist

Before marking any recommendation complete, verify:

- [ ] Code changes reviewed and merged
- [ ] Tests added/updated and passing
- [ ] Documentation updated
- [ ] Verification count incremented in relevant docs
- [ ] No regression in existing tests
- [ ] Performance benchmarks run (if applicable)
- [ ] Security implications reviewed (if applicable)
- [ ] Stakeholder sign-off obtained (for user-facing changes)

---

## Related Documents

- [`/IMPROVEMENT_PLAN.md`](../IMPROVEMENT_PLAN.md) - Detailed implementation plan with tasks and timelines
- [`VERIFICATION_REPORT.md`](./VERIFICATION_REPORT.md) - Current verification status and test results
- [`TRUTH_BOUNDARY.md`](./TRUTH_BOUNDARY.md) - What the system claims vs. what it knows
- [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) - Original implementation roadmap
- [ADR-0006](./0006-shell-composition-and-shared-ui.md) - Dual shell strategy
- [ADR-0002](./0002-contract-first-design.md) - Contract-first design principles

---

**Document Version:** 1.0  
**Created:** 2024  
**Next Review:** After Phase 1 completion  
**Owner:** Core Engineering  
**Approvers:** Technical Leadership Team
