# NexusPrompt Improvement Implementation Plan

## Executive Summary

This plan addresses 10 prioritized improvement recommendations for NexusPrompt, organized into three phases over approximately 12-16 weeks. The focus is on transitioning from demo/stub mode to production-ready validation while maintaining the project's exceptional verification standards.

**Key Objectives:**
- Validate real-world provider integration with live API calls
- Complete missing architectural components (adapters, UI shells)
- Strengthen type safety and test coverage
- Document and resolve known gaps

---

## Phase 1: Foundation & Live Validation (Weeks 1-4)

### Goal: Prove the system works with real providers and establish baseline metrics

#### 1.1 Live Provider Integration (High Priority - Recommendation #1)
**Owner:** Core Engineering  
**Duration:** 1 week  
**Dependencies:** None  
**Deliverables:**
- [ ] Configure `ANTHROPIC_API_KEY` in CI/CD secrets
- [ ] Run 100-trial live evaluation with budget cap (`--max-calls 100`)
- [ ] Validate cache read mechanism (`cache_read_tokens` present in results)
- [ ] Confirm budget enforcement works (calls stop at limit)
- [ ] Document provider failure classification behavior
- [ ] Update README to reflect live validation completed

**Success Criteria:**
- Live evaluation completes without errors
- Cache tokens observed in ≥1 trial
- Budget limit enforced (no more than specified calls)
- All failures properly classified

**Commands:**
```bash
export ANTHROPIC_API_KEY=<key>
npm run eval -- --live --trials 100 --max-calls 100
```

#### 1.2 Add Precision Measurement to Evaluation (Medium Priority - Recommendation #9)
**Owner:** QA/Testing  
**Duration:** 1 week  
**Dependencies:** 1.1 (can run in parallel with stubs)  
**Deliverables:**
- [ ] Create negative control test cases (known-clean substrates)
- [ ] Add precision metric to evaluation output
- [ ] Measure false-positive rates for all detectors
- [ ] Update evaluation documentation with precision methodology

**Test Cases to Add:**
- Simple arithmetic outputs (no templates, no citations)
- Plain text responses with no special formatting
- Outputs with British English spellings (sanitisation, colour, etc.)

**Success Criteria:**
- Precision measured alongside recall
- False-positive rate < 5% for all detectors
- Test suite expands by 10-15 negative cases

#### 1.3 Address Critical TypeScript Strictness (High Priority - Recommendation #3)
**Owner:** Core Engineering  
**Duration:** 2 weeks  
**Dependencies:** None  
**Deliverables:**
- [ ] Enable `exactOptionalPropertyTypes` flag
- [ ] Fix all 25 errors from this flag
- [ ] Begin `noUncheckedIndexedAccess` remediation (target: 50% of 208 errors)
- [ ] Add lint rule to prevent regression

**Approach:**
1. Enable flag in `tsconfig.json`
2. Run `tsc --noEmit` to get error list
3. Fix errors by category (group by file or error type)
4. Commit incrementally with verification after each batch

**Success Criteria:**
- `exactOptionalPropertyTypes`: 0 errors
- `noUncheckedIndexedAccess`: ≤104 errors remaining
- No test failures from type changes

---

## Phase 2: Complete Missing Components (Weeks 5-10)

### Goal: Fill architectural gaps identified in ADR-0006 and Implementation Plan

#### 2.1 Build Judge Adapter (Medium Priority - Recommendation #6)
**Owner:** Core Engineering  
**Duration:** 2 weeks  
**Dependencies:** 1.1 (need live provider experience)  
**Deliverables:**
- [ ] Implement `judge-verdict` adapter following contract-first design
- [ ] Add agreement threshold measurement (inter-judge reliability)
- [ ] Implement position randomization to detect bias
- [ ] Create judge evaluation suite (judge grading judges)
- [ ] Document judge configuration options

**Architecture:**
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

**Success Criteria:**
- Judge can grade free-form outputs
- Agreement score ≥ 0.7 between different judges on same task
- Position randomization shows no systematic bias
- 20+ unit tests covering edge cases

#### 2.2 Build storage-db Adapter (High Priority - Recommendation #2)
**Owner:** Backend Engineering  
**Duration:** 3 weeks  
**Dependencies:** None (design as greenfield)  
**Deliverables:**
- [ ] Design revision schema with migration path from filesystem
- [ ] Implement database adapter (PostgreSQL first, SQLite optional)
- [ ] Create migration script from filesystem storage
- [ ] Add connection pooling and retry logic
- [ ] Performance benchmarks (reads/writes per second)
- [ ] Documentation for deployment

**Schema Design Principles:**
- Contract-first: derive from existing `storage-filesystem` interface
- Migration-friendly: include version tracking
- Production-ready: indexes, constraints, audit fields

**Tables:**
```sql
revisions (
  id UUID PRIMARY KEY,
  substrate_id UUID NOT NULL,
  revision_number INTEGER NOT NULL,
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB,
  UNIQUE(substrate_id, revision_number)
)

substrates (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
)
```

**Success Criteria:**
- All 27 assertion proxy security tests pass
- Migration script converts existing filesystem data without loss
- Performance: ≥1000 reads/sec, ≥100 writes/sec on standard hardware
- Zero data loss in failover scenarios

#### 2.3 Expand Test Coverage for Non-Deterministic Paths (Medium Priority - Recommendation #4)
**Owner:** QA/Testing  
**Duration:** 2 weeks  
**Dependencies:** 2.1 (judge needed for semantic evaluation)  
**Deliverables:**
- [ ] Add test cases for provider failures (timeout, rate limit, auth error)
- [ ] Test cache miss scenarios explicitly
- [ ] Verify budget enforcement edge cases (exactly at limit, one over)
- [ ] Add chaos testing (random provider failures during evaluation)
- [ ] Document coverage gaps and mitigation strategies

**Success Criteria:**
- Code coverage for error paths ≥ 80%
- All provider failure modes have test coverage
- Chaos tests run in CI weekly

---

## Phase 3: Polish, Documentation & UI (Weeks 11-16)

### Goal: Complete remaining shells and address polish items

#### 3.1 Complete Remaining Shells (Low Priority - Recommendation #7)
**Owner:** Frontend Engineering  
**Duration:** 3 weeks  
**Dependencies:** 2.1, 2.2 (need working adapters)  
**Deliverables:**
- [ ] Build shared presentation package (components, hooks, utilities)
- [ ] Implement `pipeline-ui` shell
- [ ] Implement `toolkit-ui` shell
- [ ] Add accessibility compliance (WCAG 2.1 AA)
- [ ] Performance optimization (bundle size, load time)

**Shared Package Structure:**
```
packages/presentation/
├── components/       # Reusable UI components
├── hooks/           # React hooks for state management
├── utils/           # Shared utilities
├── styles/          # Global styles, theme
└── index.ts         # Public API
```

**Success Criteria:**
- Both shells functional with all core features
- Lighthouse score ≥ 90 for performance, accessibility
- Bundle size < 500KB gzipped
- Cross-browser compatibility (Chrome, Firefox, Safari, Edge)

#### 3.2 Complete Catalog Citation Verification (Medium Priority - Recommendation #5)
**Owner:** Research/Documentation  
**Duration:** 2 weeks  
**Dependencies:** None  
**Deliverables:**
- [ ] Integrate Crossref API for non-arXiv citations
- [ ] Add publisher API connectors (IEEE, ACM, Springer if needed)
- [ ] Verify all 12 non-arXiv citations
- [ ] Create automated citation verification job
- [ ] Document verification methodology and error rates

**Success Criteria:**
- 100% of catalog citations verified
- Automated verification runs weekly
- Error rate documented and < 2%

#### 3.3 Document British English False Positive (Low Priority - Recommendation #8)
**Owner:** Documentation  
**Duration:** 2 days  
**Dependencies:** 1.2 (precision measurement)  
**Deliverables:**
- [ ] Audit `sanitiz` regex pattern in safety gate
- [ ] Test British spellings: sanitisation, colour, behaviour, etc.
- [ ] Decide: fix regex or add to divergence allowlist
- [ ] Document decision in SAFETY.md
- [ ] Add test case for chosen approach

**Decision Matrix:**
| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| Fix regex | More accurate | May break parity with reference | If parity not critical |
| Allowlist | Maintains parity | Documents known limitation | If parity required |

**Success Criteria:**
- Decision documented with rationale
- Test case added to prevent regression
- No new false positives introduced

#### 3.4 Strengthen Guard Probing (Low Priority - Recommendation #10)
**Owner:** QA/Security  
**Duration:** 1 week  
**Dependencies:** All previous phases  
**Deliverables:**
- [ ] Create probe coverage testing framework
- [ ] Test all guards against expanded attack surface
- [ ] Verify Purity harness blocks filesystem access
- [ ] Expand `typecheck` coverage to full codebase
- [ ] Fix cross-shell relative import detection
- [ ] Document guard limitations and assumptions

**Probe Categories:**
1. **Purity**: Filesystem, network, environment variables
2. **Type Safety**: All TypeScript files, not just subset
3. **Import Rules**: Relative, absolute, cross-shell, external

**Success Criteria:**
- All guards pass expanded probe suite
- Coverage report generated for each guard
- Zero critical security gaps found

---

## Risk Management

### Open Risks from Register

| Risk ID | Status | Mitigation Plan | Owner |
|---------|--------|-----------------|-------|
| R3 | Open | Address in Phase 2.2 with proper schema design | Backend Eng |
| R6 | Open | Live validation in Phase 1.1 will provide data | Core Eng |
| R7 | Open | Judge adapter in Phase 2.1 enables measurement | Core Eng |

### New Risks Introduced

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Live API costs exceed budget | Medium | Low | Use strict `--max-calls` limit, start with 10 trials |
| Database migration data loss | Low | High | Backup before migration, test on copy first |
| Judge disagreement too high | Medium | Medium | Calibrate with human grading, adjust prompts |
| TypeScript fixes break runtime | Low | Medium | Comprehensive test suite catches regressions |

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

---

## Success Metrics

### Phase 1 Completion Criteria
- [ ] Live evaluation completed with ≥100 trials
- [ ] Precision and recall both measured
- [ ] TypeScript strictness errors reduced by 50%
- [ ] Zero critical bugs from live testing

### Phase 2 Completion Criteria
- [ ] Judge adapter operational with agreement ≥ 0.7
- [ ] Database adapter passes all 27 security assertions
- [ ] Migration script tested with zero data loss
- [ ] Error path coverage ≥ 80%

### Phase 3 Completion Criteria
- [ ] Both UI shells functional and accessible
- [ ] 100% citation verification complete
- [ ] All guards pass expanded probe suite
- [ ] Documentation updated for all changes

### Overall Project Success
- [ ] System validated with real providers (not just stubs)
- [ ] All high-priority recommendations addressed
- [ ] Type safety improved (both strict flags enabled or documented exceptions)
- [ ] Test coverage expanded to non-deterministic paths
- [ ] Production-ready deployment options available (database storage)

---

## Timeline Summary

| Phase | Duration | Key Deliverables | Exit Criteria |
|-------|----------|------------------|---------------|
| **Phase 1** | Weeks 1-4 | Live validation, precision metrics, type fixes | Live eval complete, precision measured |
| **Phase 2** | Weeks 5-10 | Judge adapter, DB adapter, expanded tests | All adapters built, error coverage ≥80% |
| **Phase 3** | Weeks 11-16 | UI shells, citation verification, guard hardening | UIs functional, 100% citations verified |

**Total Duration:** 16 weeks (4 months)  
**Critical Path:** Phase 1 → Phase 2 → Phase 3 (sequential dependencies)

---

## Next Steps

1. **Immediate (This Week)**
   - Review and approve this plan
   - Allocate resources for Phase 1
   - Set up API key in CI/CD for live testing

2. **Week 1 Kickoff**
   - Begin live provider integration (1.1)
   - Start precision measurement test design (1.2)
   - Enable `exactOptionalPropertyTypes` flag (1.3)

3. **Weekly Checkpoints**
   - Monday: Sprint planning and goal setting
   - Wednesday: Mid-week progress review
   - Friday: Demo and retrospective

---

## Appendix A: Command Reference

### Live Evaluation
```bash
export ANTHROPIC_API_KEY=<your-key>
npm run eval -- --live --trials 100 --max-calls 100 --verbose
```

### TypeScript Strictness Check
```bash
# Enable exactOptionalPropertyTypes temporarily
npx tsc --exactOptionalPropertyTypes --noEmit

# Check noUncheckedIndexedAccess
npx tsc --noUncheckedIndexedAccess --noEmit
```

### Database Adapter Testing
```bash
# Run storage adapter tests
npm test -- packages/adapters/storage-db

# Performance benchmark
npm run bench -- storage-db --iterations 1000
```

### Judge Agreement Measurement
```bash
# Run judge vs judge comparison
npm run eval -- --judge-compare --trials 50
```

---

## Appendix B: Verification Checklist

Before marking any recommendation complete:

- [ ] Code changes reviewed and merged
- [ ] Tests added/updated and passing
- [ ] Documentation updated
- [ ] Verification count incremented in relevant docs
- [ ] No regression in existing tests
- [ ] Performance benchmarks run (if applicable)
- [ ] Security implications reviewed (if applicable)

---

*Document Version: 1.0*  
*Created: $(date)*  
*Next Review: After Phase 1 completion*
