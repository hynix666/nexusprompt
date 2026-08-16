# PromptNexus Unified Platform
## Cross-Document Architecture Review

**Prepared by:** Manus AI  
**Review basis:** Twenty supplied Markdown documents  
**Assessment type:** Architecture consistency and implementation-readiness review  
**Date:** 15 August 2026

> **Overall conclusion.** The documentation articulates a thoughtful target architecture with unusually strong instincts around adapter isolation, provider-key custody, auditability, and model-output honesty. It is **not yet implementation-ready as a contract-first system**. Several central promises cannot simultaneously hold under the current wording: Core cannot be both pure/no-I/O and directly invoke a live injected generator; Shells cannot depend only on Contracts while directly invoking Core and embedding another Shell; and the five advertised contracts do not model the runtime and persistence behavior the rest of the documents require. The next implementation phase should therefore be a short **architecture-closure phase**, completed before provider, storage, or Shell code is built.

| Review result | Assessment |
|---|---|
| Architectural direction | Sound and worth retaining |
| Implementation readiness | Conditional; blocked by boundary and protocol closure |
| Most important action | Decide and document a real orchestration/composition boundary |
| Main systemic risk | Informal TypeScript interfaces and hidden runtime behavior erode the claimed language-neutral contract boundary |
| Security posture | Strong design intent, but tenancy, identity, retention, and observability metadata are not contractually closed |
| Confidence | High for document-level inconsistencies; limited for phase gates and source-code behavior not included in the review set |

## 1. Scope, method, and limitation

This review tested the supplied documentation for semantic alignment, protocol completeness, deployment practicality, traceability, testability, and security-boundary closure. It examined the architecture and ADRs, all declared contracts, provider and storage behavior, observability, testing and release operations, the capability matrix, catalog/gate references, contribution rules, and user guidance. The focus is **internal coherence of the proposed target state**, rather than an audit of a running implementation.

Several documents defer decisive claims to `IMPLEMENTATION_PLAN.md`—including phase exit gates, a risk register, and the full mapping of nineteen target properties—but that document was not supplied. The repository’s actual `contracts/`, `adr/`, source files, test suite, and CI configuration were also not supplied. References to those materials are consequently treated as **unverified dependencies**, not evidence that a mechanism exists or passes in practice.[1]

| Review criterion | Question applied |
|---|---|
| Boundary integrity | Does each runtime interaction conform to the declared dependency rule? |
| Contract sufficiency | Can every documented interaction be serialized, validated, versioned, and implemented by a non-TypeScript client? |
| Operational truth | Do retry, fallback, trace, revision, and release claims have required data and ownership? |
| Security closure | Are stated key-custody and tenant-isolation controls represented at enforceable interfaces? |
| Verification | Could the named CI tests objectively prove the stated requirement? |
| Documentation truthfulness | Is the reference material complete, generated where claimed, and clearly distinguished from target-state examples? |

## 2. What is strong and should be retained

The documents correctly identify the historical failure mode: overlapping implementations of linting and pipeline behavior drift when no structural boundary prevents them from doing so. The proposed separation of Shells, Contracts, Core, and deployment-specific Adapters is a sensible response, and the import restriction for Core is materially stronger than relying on code review alone.[2] The decision to provide both local-proxy and hosted-server provider paths is also coherent: each supports a distinct deployment shape while maintaining server-side provider-key custody.[3]

The verification design is particularly promising. Shared adapter contract tests, property tests for gates, an adversarial corpus, cross-shell `GateResult` parity, stale-result marking, build stamps, and redacted `run_id`-based traces form a strong intended assurance model when the underlying protocol is complete.[4] [5] Explicit demo mode, which requires a visibly labeled non-live placeholder rather than silently fabricating a model result, is an excellent model-honesty control and should remain non-negotiable.[3] [6]

| Strength | Why it is valuable | Condition for realizing the value |
|---|---|---|
| Pure deterministic gate/catalog/diff logic | Enables reliable fixtures, property tests, and parity checks | Keep all live effects outside the Core execution path |
| Dual provider adapters | Preserves simple local use and multi-tenant hosted use without browser-held keys | Define a complete transport/error/provenance protocol |
| Demo-mode labeling | Avoids false claims when a provider is unavailable | Make fallback state and reason part of a typed outcome |
| Revision invalidation | Prevents downstream output from looking current after upstream edits | Add lineage and freshness fields to the revision protocol |
| Generated capability matrix | Can make documented capability drift a build failure | Make it executable and distinguish producers from adapters |
| Redacted observability | Limits prompt exposure while retaining a trace path | Define event types, causal metadata, and hash/privacy policy |

## 3. Principal findings

The findings below are prioritized by their ability to invalidate the architecture’s stated invariants or create implementation rework. **Critical** items should block implementation beyond a proof of concept. **High** items should close before a hosted pilot. **Medium** items should close before a general-availability release reference is published.

| ID | Severity | Finding | Why it matters | Recommended disposition |
|---|---|---|---|---|
| F-01 | Critical | The Core purity claim conflicts with the stated request lifecycle. | A stage in Core invokes an injected asynchronous `generate()` function and all layers emit events. Injection prevents an import dependency, but a live invocation remains an effect; the current text cannot simultaneously guarantee a pure/no-I/O Core. | Introduce an orchestration boundary, or redefine Core precisely as effect-parameterized rather than pure. |
| F-02 | Critical | Shell interactions contradict the dependency rule. | Shells are said to depend only on Contracts and never on Core or other Shell internals. Yet the lifecycle has a Shell call a Core stage, and `toolkit-ui` delegates to a `pipeline-ui` component. | Specify a composition/application layer and legal UI composition boundary. |
| F-03 | Critical | The five-contract inventory is insufficient and is not consistently schema-first. | Two central “contracts” are TypeScript-style interfaces; persistence depends on an undeclared `RevisionStore`; request, response, failure, model, and context shapes are absent. | Replace the inventory with versioned, language-neutral protocol schemas and generated bindings. |
| F-04 | High | `RevisionEntry` cannot represent documented revision behavior. | The documents require stale marking, run lineage, configuration provenance, and Core hash exportability, but the schema lacks these fields. | Define revision IDs, parent/upstream links, freshness state, execution provenance, and schema/version fields. |
| F-05 | High | The local history capacity conflicts with a complete nine-stage run. | A run records one revision per stage, but local storage is bounded to eight entries per prompt lineage. A full fresh pipeline uses nine stage entries before retries or edits. | Retain at least one complete run, or redefine the cap as a number of run bundles rather than individual entries. |
| F-06 | High | Observability events cannot deliver the claimed causal diagnostics. | The event model lacks event type, operation, provider/model identity, attempt/retry, duration, causal parent, and structured failure. It cannot faithfully represent degrade/recover behavior or causal replay. | Publish an `ObservabilityEvent` protocol with a privacy-safe operational envelope. |
| F-07 | High | Reproducibility claims conflate deterministic builds with model-generated outputs. | A Core hash can identify gates/catalog, but it does not reproduce an output influenced by model/version, provider configuration, input resolution, retries, or non-determinism. | Separate build reproducibility, deterministic export reproducibility, and model-output provenance/replayability. |
| F-08 | High | Provider fallback behavior is not testable from `ProviderTransport` as defined. | Required retry/backoff, health behavior, cancellation, failure classification, model policy, and fallback triggers lack a normative error/result model. | Add typed request, result, error, health, capability, and cancellation semantics. |
| F-09 | Medium | The capability matrix is currently a template and uses inconsistent implementation language. | The “Implementing Adapters” column lists Core producers, while CI language requires an adapter per contract; rows are marked stable even though the file states generator tooling does not yet exist. | Keep it explicitly non-authoritative until generated; rename columns and introduce a machine-readable registry. |
| F-10 | Medium | The Shell inventory is inconsistent. | Architecture includes a `CI-bot`; ADR, capability matrix, and user guide enumerate only the three primary Shells. No ownership or contract registration is defined for the bot. | Decide whether it is a supported Shell, a future extension, or remove it from the target diagram. |
| F-11 | Medium | The reference for all 17 gates leaves two gates unnamed. | An audit-oriented gate reference cannot support stable IDs, version impact analysis, catalog linkage, or user interpretation when two gates are hidden behind an implementation directory. | Publish each gate ID, purpose, verdict semantics, catalog linkage, and versioning rule. |
| F-12 | Medium | Hosted tenancy and data governance are asserted but not contractual. | Per-user/org quotas, multi-user persistence, and isolation are promised, but tenant scope, authorization outcome, retention/deletion, and audit-access semantics are absent from the contracts. | Add a host-only `TenantContext`/authorization protocol and storage governance requirements. |
| F-13 | Medium | Contract versioning is ambiguous. | Documents describe `$id`, semver, changelogs, per-gate version, and per-record schema version, but do not identify canonical version authority or compatibility negotiation. | Adopt a single schema-version policy and separate schema, implementation, and artifact versions. |
| F-14 | Low | Foundational evidence is missing from the supplied review set. | Claims about implementation phases, risk controls, ADR coverage, and exit gates cannot be validated without the implementation plan, ADR directory, and repository. | Add a documentation manifest and publish the source-of-truth planning and ADR materials. |

### 3.1 F-01 and F-02: the runtime boundary must be made real

The architecture calls Core “pure functions, no I/O, no framework,” with no dependency outside itself.[2] Its documented lifecycle then states that a Shell calls into a Core `PipelineStage` and that, if model work is needed, Core invokes an injected `generate()` function.[2] The provider document additionally assigns the Core-level stage the responsibility to degrade after provider failure.[3] This is an effective dependency-inversion intent, but it is not pure functional execution. The injected function has temporal behavior, may call a network, may time out, and may produce different values for identical inputs.

> **Architecture decision required:** Either preserve a genuinely pure Core by moving invocation, retries, events, persistence, and fallback orchestration out of Core; or keep port-injected effects in Core but explicitly call it an **effect-parameterized application core**, with test and determinism claims adjusted accordingly.

The review recommends retaining a **pure Core** because the documents repeatedly present purity as the foundation for testability, determinism, portability, and reproducibility. Add an Application/Orchestration boundary. It may be a package rather than a separately deployed service, but its placement and import rights must be explicit. Shells call the application protocol, not Core; the application composes Core decision logic with adapter effects; the composition root wires the actual provider, storage, and event sink. The toolkit may reuse a shared `pipeline-ui` **presentation package**, but not import another independently deployable Shell as an ungoverned internal dependency.

| Concern | Current wording | Closure required |
|---|---|---|
| Shell → Core call | Shell starts Core stage directly | Shell → Application API → Core decision function |
| Core → provider call | Core invokes injected live generator | Core produces a provider request/next action; application invokes provider adapter |
| Event emission | Every layer emits directly | Define event emission ownership and a non-blocking event port in orchestration |
| Fallback | Stage handles provider failure | Application classifies failure; Core deterministically maps classified failure to a labeled demo outcome/action |
| Toolkit reuse | One Shell delegates to another Shell’s component | Shared UI package, or a documented host/feature composition contract |

### 3.2 F-03, F-04, F-06, and F-08: turn “contracts” into an executable protocol

The current `GateResult` and `TechniqueRecord` examples resemble JSON data models, but `ProviderTransport` and `PipelineStage` are language-specific interfaces and reference undefined types such as `ProviderResult`, `ModelInfo`, `messages`, `config`, `input`, `context`, and `output`.[7] The revision and observability documents require further undeclared semantics—including a `RevisionStore`, freshness flags, sink events, health state, and causal replay.[5] [8] This prevents a Python, Rust, CLI, or remote adapter from implementing the same system merely by validating JSON Schema.

The contract-first claim can be made credible by publishing a small, coherent protocol package. Its schemas should define **wire-compatible data**, while language-specific interfaces are generated or hand-written bindings around those schemas. Provider adapters would then be tested against a specific protocol version, and shell/application integrations would consume the same versioned request and response envelopes.

| Required protocol element | Minimum contents | Primary users |
|---|---|---|
| `GateResult` | Stable gate ID, gate implementation version, verdict, message code, safe display text, input fingerprint, location representation | Core, Shells, exports |
| `TechniqueRecord` | Current catalog fields plus source/verification policy and immutable record version | Core catalog, toolkit, exports |
| `GenerationRequest` | Message parts, model selection policy, generation options, idempotency/correlation ID, tenant context reference | Application, provider adapters |
| `GenerationResult` | Content or structured output, provider/model/version identity, usage, finish reason, timings, request ID | Application, revision/export pipeline |
| `ProviderFailure` | Stable category, retriable flag, safe reason code, retry-after/attempt metadata, source ID | Application, demo-mode decision, events |
| `ProviderHealth` | Status, checked time, latency, failing dependency category, optional degradation state | Operations, application |
| `PipelineCommand` and `PipelineOutcome` | Stage ID, validated input/context, action plan or outcome, gate results, demo status, provenance pointer | Shells, Core, application |
| `RevisionEntry` and `RevisionStore` | Revision and run identifiers, parent/upstream relation, freshness, state, provenance, read/write/query/delete rules | Storage adapters, exports, Vault |
| `ObservabilityEvent` | Event ID/type/time/run ID, causal links, layer/component, safe attributes, timing, outcome/failure code | Sink adapters, trace viewer |
| `CapabilityRegistration` | Contract/version, provider/consumer role, implementation ID, compatibility range, test evidence | Matrix generator, CI |

### 3.3 F-04 and F-05: repair the revision model before building storage adapters

The revision document says each stage execution produces a `RevisionEntry`, downstream entries become `stale: true` after an upstream edit, stale material is excluded by default from exports, and every export carries a Core version hash.[9] Yet the declared `RevisionEntry` contains only run/stage/timestamp, input/output hashes, gate results, and provider string.[7] It does not encode staleness, parentage, a precise execution configuration, stage attempt, model identity, Core/artifact hash, or export inclusion decision. Storage behavior is therefore not implementable without each adapter inventing its own fields.

There is also a literal capacity conflict. A nine-stage guided run is documented, while local storage allows eight entries per prompt lineage; a run that persists an entry after each stage has at least nine entries.[6] [9] The safe resolution is to treat a **run bundle**, not an entry, as the local retention unit. Local storage could retain the eight most recent completed run bundles while ensuring all stage revisions inside one retained run stay intact. This preserves the user-facing intention—bounded local history—without making a full successful run impossible.

| Revision addition | Purpose | Example decision it enables |
|---|---|---|
| `revision_id` and `parent_revision_ids` | Express linear and dependency lineage | Which downstream results must become stale? |
| `status` and `freshness` | Separate execution result from validity | Is this output exportable without warning? |
| `stage_attempt` and `executed_at` | Identify retries/reruns | Which output is the latest valid stage result? |
| `execution_provenance` | Capture Core build hash, contract versions, provider/model/config fingerprints | What exactly generated this result? |
| `input_ref` / `output_ref` | Support secure storage without embedding bodies in events | Where can an authorized user retrieve the retained content? |
| `retention_scope` | State local/db retention semantics | What does “eight history entries” mean? |

### 3.4 F-06 and F-07: distinguish traceability from reproducibility

The observability design correctly prohibits prompt bodies in logs and uses a single `run_id` threaded across stages, providers, and revisions.[5] The current event schema, however, cannot encode the stated degrade/recover events, causal order, or provider-call history because it includes no event type, operation name, causal parent, timing, retry, provider/model, or failure-code fields.[5] Add these fields as non-content metadata. A privacy review should also define the fingerprint algorithm, scope, and access policy; unkeyed hashes of short or predictable prompt templates can be correlatable or susceptible to dictionary matching. This does not require logging prompt text.

Release operations should separate three meanings that are currently blended: **reproducible build**, **byte-reproducible deterministic export**, and **model-output provenance/replayability**. A Core hash can support the first two when inputs and toolchain are pinned. It cannot by itself reproduce live model output because provider/model versions, settings, input normalization, retries, and model sampling affect outcomes.[10] The implementation should not promise byte reproduction of live model output unless it stores the provider response and all required inputs under an appropriate privacy/retention policy.

| Assurance claim | Defensible requirement | Do not claim unless |
|---|---|---|
| Reproducible build | Source commit, lockfile/toolchain, deterministic build, artifact hash | Same source can create the same artifact hash |
| Byte-reproducible catalog/PDF export | Canonical data order, renderer version, invariant rendering configuration | CI compares bytes from independent builds |
| Deterministic gate result | Canonical normalized input, gate version/config, no clock/randomness | Same normalized input returns same result |
| Model-output provenance | Provider/model/version ID, settings, input fingerprints, attempts, timestamp, response reference | Output can be explained and safely retrieved |
| Model-output replay | Request snapshot, adapter behavior, retained response or vendor replay guarantee | A replay policy and privacy retention policy exist |

### 3.5 F-09 through F-14: improve operational documentation truth

The capability matrix explicitly says it is a generated template/example until Phase 5 tooling exists, but its example rows are marked stable and its heading “Implementing Adapters” contains Core implementations such as gates, catalog, and stages.[11] A release-facing capability matrix should be generated from a declared registry and test evidence, not from prose. Until then, label it **Illustrative target-state matrix — not a capability assertion**, remove stable-status signals, and do not use it as a published operational reference.

The source inventory should be made mechanically auditable as well. The architecture diagram includes `CI-bot`, but the ADR, user guide, and matrix do not register it.[2] [6] [11] Similarly, the all-gates reference leaves two catalog-linked gates unnamed, which prevents stable public audit.[12] Both issues are low-cost documentation corrections that prevent later governance ambiguity. Finally, `IMPLEMENTATION_PLAN.md`, all referenced ADRs, and a manifest of generated versus authoritative documents should accompany the next documentation release.[1]

## 4. Recommended target architecture

The following refinement retains the valuable goals of the proposed architecture while making runtime effects, contracts, and UI composition honest. It adds an **Application/Orchestration** package and a **Composition Root**. These are logical boundaries, not necessarily separate services or network hops.

```text
Shells / shared UI features / CLI / CI integration
             │ consumes versioned application protocol
             ▼
Application / Orchestration
  validates commands · invokes adapters · classifies errors
  emits safe events · persists revisions · drives fallback
             │                 │
             ▼                 ▼
Pure Core                         Contract package (JSON Schema)
  gates · stage decision logic    protocol envelopes · version policy
  catalog · diff · scorer         bindings / compatibility rules
             ▲                 ▲
             │                 │
Composition Root ─────── Adapters
  deployment wiring       provider-local / provider-hosted
                          storage-local / storage-db / event sinks
```

Under this shape, a pure Core stage can prepare a `GenerationRequest` or a deterministic demo action from a validated pipeline state. The application invokes a provider adapter, classifies the result, calls Core again to reduce the result into a new pipeline state and `GateResult` set, persists a fully specified revision, and sends a redacted event. Shells see only validated application responses and do not need a forbidden Core or Adapter import. The composition root is the only location allowed to assemble a concrete deployment shape.

| Boundary | Permitted dependencies | Explicitly prohibited |
|---|---|---|
| Shell | Application protocol, shared presentation packages, contract-generated types | Core internals, adapters, another independently deployable Shell |
| Application/Orchestration | Core, contract protocol, abstract adapter ports | Adapter implementation internals except at composition wiring |
| Pure Core | Contract value types and deterministic utilities only | Network, filesystem, clock, randomness, event sink, provider invocation |
| Adapter | Contract protocol, provider/storage/sink implementation libraries | Shell internals; Core business-rule ownership |
| Composition root | All packages for dependency injection | Business logic and protocol transformation |

## 5. Prioritized remediation plan

The priority is to eliminate irreversible ambiguity before code multiplies. The plan deliberately begins with protocol and boundary decisions rather than a UI or adapter build, because those decisions govern every downstream module.

| Wave | Objective | Required outputs | Exit criteria |
|---|---|---|---|
| 0 — Architecture closure | Resolve the pure-Core, Shell, and orchestration contradictions | ADR for orchestration/composition; revised dependency diagram; ESLint import rules | All documented request-lifecycle arrows are legal under the diagram and import rules |
| 1 — Protocol closure | Publish a complete language-neutral contract package | JSON Schemas for provider, pipeline, revision/store, event, capability registry, errors; semver policy | Example JSON validates; bindings/tests run in TypeScript and at least one non-TS validator |
| 2 — Deterministic Core | Implement only pure gates, catalog, diff, and stage decision/reduction functions | Core fixtures, property tests, adversarial corpus, normalized-input policy | Core test suite has no network/clock/randomness and passes determinism tests |
| 3 — Adapter and storage proof | Prove two provider shapes and two storage shapes against the same protocol | Shared contract suites, tenancy tests for hosted path, local retention tests, event-sink tests | Both implementations pass behavior and security baseline; a full nine-stage run persists intact locally |
| 4 — Shell and release truth | Build UI/CLI consumers and turn documentation into generated evidence | Cross-shell tests, capability generator, trace viewer, export policy, release attestations | CLI and web parity passes; matrix is generated; release checklist distinguishes build/export/provenance guarantees |

The documentation should be updated **in the same pull request** as Waves 0 and 1. A target architecture that does not publish its actual protocol is likely to recreate the implicit-shape drift the merge is meant to eliminate.

## 6. Concrete document changes

| Document | Required change |
|---|---|
| `ARCHITECTURE.md` | Add Application/Orchestration and Composition Root; revise “five layers” terminology; make the legal runtime flow consistent with import rules; define effect ownership. |
| `0001-five-layer-architecture.md` | Amend the ADR or issue a superseding ADR explaining the added orchestration boundary and whether Core remains truly pure. |
| `0002-contract-first-design.md` and `CONTRACTS.md` | Replace language-specific interface examples with schema-backed protocol artifacts; add `RevisionStore`, provider request/result/failure, observability, and capability registration. |
| `0004-dual-shell-strategy.md` | Define shared UI package versus independent Shell boundary; clarify `CI-bot` status and registration. |
| `PROVIDERS.md` | Define transport errors, retry ownership, cancellation, timeouts, idempotency, model policy, health state, and safe fallback classification. |
| `OBSERVABILITY.md` | Add event type, causal metadata, timing, attempt, provider/model, safe failure code, schema version, fingerprint policy, and retention/access policy. |
| `REVISIONS_AND_EXPORTS.md` | Expand revision schema, correct local-retention semantics, split reproducibility claims, and state what is retained for provenance/replay. |
| `CAPABILITY_MATRIX.md` | Label current file as non-authoritative until generator exists; rename producer/adapter columns and generate from a capability registry with test evidence. |
| `GATES_REFERENCE.md` | Name and document every gate, including both catalog-linked gates, with IDs and version/governance semantics. |
| `PRIVACY_AND_SECURITY.md` | Add identity/tenant contract requirements, retention/deletion rules, authorization boundaries, and the observability fingerprint policy. |
| `README.md` | Link the implementation plan, authoritative ADR directory, generated-document manifest, and current implementation status per phase. |

## 7. Architecture-closure acceptance checklist

Before implementing the two provider adapters or any production Shell, the following statements should all be demonstrably true.

| Control | Required demonstration |
|---|---|
| **Pure Core claim** | Static import checks plus test instrumentation show no network, file, clock, randomness, provider, persistence, or event-sink effect occurs in Core. |
| **Shell isolation** | Each Shell calls a documented application endpoint/port; UI reuse occurs through a shared feature package, not a hidden Shell dependency. |
| **Contract-first interoperability** | Every cross-boundary request, response, failure, and event validates against a published schema with a canonical version policy. |
| **Provider parity** | Shared tests cover success, timeout, cancellation, auth failure, rate limit, transient failure, unavailable provider, health transitions, and safe demo fallback. |
| **Revision integrity** | A nine-stage run, rerun, upstream edit, stale cascade, and export selection behave identically across local and DB stores. |
| **Privacy-safe tracing** | Trace events contain no bodies or secrets, have approved fingerprinting/retention policy, and can represent complete causal operations. |
| **Truthful release claims** | Release documentation separately reports build reproducibility, deterministic export reproduction, and model-output provenance/replay capability. |
| **Generated capability evidence** | The published matrix is generated from registered implementations and CI test evidence, not maintained as a template. |

## 8. Final assessment

PromptNexus has a compelling architectural thesis: **centralize deterministic logic, make deployment effects swappable, do not place provider keys in the browser, and expose model limitations honestly**. Those choices should be preserved. The main task now is not expansion but precision. The documentation needs one explicit runtime orchestration boundary, a complete protocol catalog, and a corrected revision/observability model. Once these are closed, the proposed dual-provider and dual-Shell strategy becomes materially more credible and testable; without them, implementation will silently recreate the coupling and drift this architecture was designed to prevent.

## References

[1]: file:///home/ubuntu/upload/README.md "PromptNexus Unified Platform — Documentation"
[2]: file:///home/ubuntu/upload/ARCHITECTURE.md "Architecture"
[3]: file:///home/ubuntu/upload/0003-dual-provider-adapters.md "ADR-0003: Dual Provider Adapters"
[4]: file:///home/ubuntu/upload/DEVELOPMENT_AND_TESTING.md "Development & Testing"
[5]: file:///home/ubuntu/upload/OBSERVABILITY.md "Observability"
[6]: file:///home/ubuntu/upload/USER_GUIDE.md "User Guide"
[7]: file:///home/ubuntu/upload/CONTRACTS.md "Contracts"
[8]: file:///home/ubuntu/upload/PRIVACY_AND_SECURITY.md "Privacy & Security"
[9]: file:///home/ubuntu/upload/REVISIONS_AND_EXPORTS.md "Revisions & Exports"
[10]: file:///home/ubuntu/upload/RELEASE_OPERATIONS.md "Release Operations"
[11]: file:///home/ubuntu/upload/CAPABILITY_MATRIX.md "Capability Matrix"
[12]: file:///home/ubuntu/upload/GATES_REFERENCE.md "Lint Gates Reference"
