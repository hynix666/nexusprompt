# Commands and workflows

## The one command that matters

```bash
npm install && npm run verify
```

~24 s, offline, exit 0. Runs boundaries → types → frozen-source hashes → documentation counts
→ suite sizing → the generated matrix → every evaluation suite → the test suite → the
differential oracle.

## Every script

### Guards (each fails the build; none merely warns)

| Command | What it checks |
|---|---|
| `npm run check:hygiene` | The repository's shape: pinned `.gitignore` rules, a rule-count floor, nothing vendored in the index, no tracked file over 4 MB. **Runs first in `verify`** |
| `npm run lint:boundaries` | Core imports no effectful builtin, no adapter, no Application. 53 files, 160 imports |
| `npm run typecheck` | `tsc --noEmit`, strict + 3 extra flags |
| `npm run verify:sources` | Re-hashes 420 frozen files against `sources/MANIFEST.json` |
| `npm run check:counts` | Re-derives every pinned number in the docs from the tree. 42 occurrences of 37 pins, including 9 in this knowledge base |
| `npm run check:plan` | 16 machine-checked claims in `IMPLEMENTATION_PLAN.md` |
| `npm run check:citations` | Every catalog citation internally consistent (195 records) |
| `npm run check:catalog` | `import:catalog --check` — the committed catalog is what the importer produces |
| `npm run check:xsd` | Catalog against its XSD (libxml2-wasm) |
| `npm run check:depth` | Depth × per-stage reliability vs the end-to-end target |
| `npm run check:stages` | 11 stages derived from the frozen component |
| `npm run check:sizing` | What each suite can actually resolve; refuses an anchor that cannot certify |
| `npm run check:anchor` | The committed anchor is what the generator produces |
| `npm run check:matrix` | The committed capability matrix is what the repo produces |
| `npm run check:manifest-spec` | The committed manifest-shapes document is what `spec/manifest-shapes.json` produces |
| `npm run check:truth` | Re-derives the eight truth-boundary entries from the tree. Fails when a boundary moves — the first provider answer, a divergence retired, a known limit fixed |
| `npm run check:fingerprint` | Fails on provider model drift; reports **"not armed"** until a run reaches a provider |
| `npm run check:corpus` | Re-hashes 661 local PDFs. **Deliberately outside `verify`** |

### Evaluation

| Command | What it runs |
|---|---|
| `npm run eval` | `compile-smoke`, 14 cases, single-stage, pinned stubs |
| `npm run eval -- --compare` | baseline vs a degraded variant, through the comparator |
| `npm run eval -- --json` | emits the `EvalRun` |
| `npm run eval -- --suite <path>` | a different single-stage suite |
| `npm run eval -- --live --trials N --max-calls M` | **real provider.** Needs `ANTHROPIC_API_KEY` |
| `npm run eval:pipeline` | the eleven-stage pipeline against `pipeline-smoke` |
| `npm run eval:adversarial` | the adversarial corpus |
| `npm run eval:anchor` | the 4,906-case anchor through `compare()` |
| `npm run build:anchor` | regenerates `eval/gate-recall-anchor.json` from seed 1 |
| `npm run differential` | ported gates vs the frozen Python linter — 2,784 verdicts, 17 differing deliberately |
| `npm run differential -- --n 800 --seed 7` | a longer / different generated corpus |

### Tests, docs, CLI

```bash
npm test                 npm run test:core        npm run test:app
npm run docs:matrix          # regenerate CAPABILITY_MATRIX.md
npm run docs:manifest-spec   # regenerate MANIFEST_SHAPES.md from spec/manifest-shapes.json
npm run docs:truth           # regenerate TRUTH_BOUNDARY.md from spec/truth-boundary.json
npm run cli -- lint <file>
npm run cli -- pipeline <file> --stakes HIGH --reflexive 2
npm run cli -- gates
npm run cli -- evidence
```

---

## Workflows

### Adding a gate

1. Write it in `core/src/gates/`, pure. Register it.
2. Add must-fire **and** must-not-fire tests.
3. Add boundary fragments to `core/src/eval/generator.ts` — *on* the gate's thresholds, not in
   their middles. A probe once found six planted defects caught and **four surviving**, all in
   behaviours no generated input reached.
4. `npm run differential` — it must agree with the Python linter, or declare a divergence in
   `scripts/divergence-allowlist.json` with a reason and an ADR. Use `also_matches` when the
   difference is input-shaped and `only_when_options` when it is option-shaped; a blanket
   `.*` excuses more than the decision covers and will silence some other detector.
5. **Bump the gate's own version if behaviour changed**, and update the pinned table in
   `core/test/ported-gates.test.ts`. `gate_version` is persisted in every revision, so two
   results carrying one version claim to have come from one rule.
6. `npm run build:anchor` — the corpus changes when the registry does.
7. `npm run verify`.

### Changing a contract (ADR-0002 order — this is a rule, not an aspiration)

1. Edit the schema. Bump the `$id` version: **major** = a consumer breaks · **minor** =
   additive · **patch** = wording only.
2. Add a `contracts/CHANGELOG.md` entry saying *why*.
3. Update the TypeScript binding in `contracts/index.ts`.
4. Add a conformance case validating a value the system **produced**.
5. *Then* write the code.

### Adding a checker

1. Export a pure `checkX(root)` returning `{ ok, failures, ... }` so it is testable against a
   fixture repo.
2. Add must-fire cases to `test/checkers.test.ts` — the real tree only gives you the
   must-not-fire half.
3. Register in `package.json` and insert into `verify` **in the right order**.
4. Add it to `IMPLEMENTATION_PLAN.md`'s `commands` block, or `check:plan` fails.

### Running a live evaluation

```bash
export ANTHROPIC_API_KEY='<your key>'
npm run eval -- --live --trials 100 --max-calls 1400
```

`--max-calls` is **required**, no default: `admitRun` admits everything when no budget is
declared, so without it the first real run would be the unbounded one. The plan prints
*before* the money moves:

```
  live run — 14 case(s) x 100 trial(s) = up to 1400 provider call(s)
    budget      1400 call(s), refuse on exceed
    destination api.anthropic.com (hard-coded, frozen allowlist)
```

Two open predictions to watch on a first live run: `check:fingerprint` should arm itself, and
`cache_read_tokens` should be non-zero on the second identical request. **If cache reads come
back zero, the caching claim is void — that is a real finding, not a failure to hide.**

### Committing

```bash
git add <explicit paths>     # NEVER -A or . — archives land here unpredictably
git commit
```

Messages state what was found, not only what changed. `npm run verify` before every commit.

### A mutation probe

```js
// scratch file, run with: node probe.mjs
const VITEST = at("node_modules/vitest/vitest.mjs");   // not npm.cmd
const run = (args) => { try { execFileSync(process.execPath, args, {cwd: ROOT, stdio:"pipe"});
                              return 0; } catch (e) { return e.status ?? -1; } };
const baseline = snapshot();          // BEFORE any mutation
for (const probe of probes) {
  try { probe.apply(); results.push(probe.measure() === probe.expect); }
  finally { restoreAll(); snapshots.clear(); }
}
const drifted = keys(after).filter(k => after[k] !== baseline[k]);   // not `=== 0`
```

Back up on **full path**. Control at **both ends**. Verdicts by **exit code only**.

---

## How to use this knowledge base in a new project

### 1. Copy the folder

```bash
cp -r project-knowledge/ /path/to/new-project/
```

Eleven files, ~100 KB of Markdown. Small enough to paste whole; complete enough to rebuild from.

### 2. Point a new Claude Code session at it

Add to the new project's `CLAUDE.md`:

```markdown
## Inherited context

`project-knowledge/` is a distilled record of NexusPrompt, a prompt-engineering evidence
system. Read `project-knowledge/00-index.md` first. The architectural invariants in `01`, the
statistical results in `04`, and the defect patterns in `08` are the parts most likely to
apply here.

Structural counts (gates, stages, contracts, ADRs, doc files, declared divergences) are
pinned to resolvers and re-derived by `npm run check:counts`, so they cannot drift silently
while the folder lives in this repository. Everything else — test counts, verdict counts,
line counts — was true at commit `3c0d440` (25 August 2026); verify before relying on one.

**Once you copy this folder elsewhere, all of it becomes a snapshot again**, because the
resolvers stay behind.
```

Or, in a session:

> Read everything in `project-knowledge/`, starting with `00-index.md`. Treat it as inherited
> context, not as a description of *this* repository.

### 3. What transfers, and what does not

| Transfers to almost any project | Specific to this one |
|---|---|
| `decide → invoke → reduce` and a pure core | the 16 gates and 11 stages |
| Derive guards; never let a caller supply one | the 195-record technique catalog |
| Refuse rather than caveat | the frozen `sources/` corpus |
| Mutation probes over coverage percentages | the differential oracle's Python counterpart |
| The whole of `08` — defect patterns and statistical gotchas | contract `$id` hosts and ADR-0009 |
| Ship the check *with* the capability | the anchor's gate-set comparison |
| No silent defaults where both options are defensible | |

### 4. Bootstrapping a similar system

Fastest honest path, in dependency order:

1. **Contracts first.** A schema, a version, a changelog entry — before any code.
2. **A pure core with an enforced boundary check.** Cheap on day one, near-impossible to
   retrofit.
3. **One checker that re-derives a documented number from the tree.** It will find more than
   you expect (15 across 6 documents here).
4. **A second, independently-authored oracle** for anything ported or duplicated — and
   remember its blind spot: parity cannot see a defect both implementations share. Budget for
   a periodic cross-reference against whatever sibling lineage exists, run by execution.
5. **Mutation probes from the first test**, with a control at both ends.
6. **Statistics before the first comparison anyone will cite** — the sizing rule, the exact
   floor, and the refusal paths in `04`. Retrofitting these means retracting published
   numbers.
