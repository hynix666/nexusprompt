/**
 * The truth boundary: for each thing this repository establishes, what it does NOT.
 *
 * ## Why this exists
 *
 * Every other checker here asks "is this number right?". This one asks the question that
 * kept going unasked: "right about WHAT?". The documentation set was written target-state
 * and in the present tense, so a reader met sentences like "the system implements sixteen
 * gates" and "a 673-paper corpus" with no way to tell which were built, which were planned,
 * and which were warrants nobody could reproduce. Ten such claims turned out false, and
 * `SOURCE_VERIFICATION.md` exists because of them.
 *
 * Fixing counts does not fix that. A true number attached to an overreaching claim is worse
 * than a wrong one, because it carries a checker's authority. `check:counts` will happily
 * confirm that the anchor holds 4,906 cases while a reader concludes the repository has
 * measured something about a language model. It has not. No run in this tree has ever
 * reached a provider.
 *
 * So each entry below states a scope in two halves — what the artifact establishes and what
 * it cannot — and pins the numbers that bound it. A probe re-derives those numbers from the
 * tree. Three things then have to agree: the declared scope, the derived reality, and the
 * generated document. Move any one and the build fails.
 *
 * ## Why the boundary is pinned rather than only derived
 *
 * A probe alone would report whatever is true today and never object. The point of a
 * boundary is that crossing it is an *event* — the first live provider call, the first
 * fingerprint pinned, a known limit fixed. Pinning the expected value turns each of those
 * into a failing build with a message naming what moved, which is the only moment anyone
 * will reliably re-read the claim attached to it.
 *
 * Two bijection rules, because a decorative entry is the failure mode this whole document
 * is aimed at:
 *
 *   - a `probe` named by an entry must exist — otherwise the entry asserts nothing;
 *   - a probe that exists must be named by an entry — otherwise it derives into a void.
 *
 * And an entry whose `expect` is empty fails: it would render as prose with a checkmark.
 *
 *   tsx scripts/check-truth-boundary.ts            write Documentation/TRUTH_BOUNDARY.md
 *   tsx scripts/check-truth-boundary.ts --check    fail on drift, in either direction
 *   tsx scripts/check-truth-boundary.ts --derive   print what the probes see, and stop
 *
 * Exit 0 boundary holds · 1 a boundary moved, or the document is stale · 2 the spec is
 *      unreadable.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { listGates, SOURCE_GATE_COUNT } from "../core/src/gates/registry.js";
import { floorDiscordant } from "../core/src/eval/sizing.js";
import { observe } from "./check-fingerprint.mjs";
import { isArtifactPath } from "./build-hash.mjs";
import { implausibleKeyReason } from "./run-eval.js";

const SPEC = "spec/truth-boundary.json";
const OUT = "Documentation/TRUTH_BOUNDARY.md";

/** The working tree is CRLF and only `sources/**` is pinned to LF. Normalise first. */
const readText = (root: string, p: string): string =>
  readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const readJson = (root: string, p: string): any => JSON.parse(readText(root, p));

const dirNames = (root: string, p: string): string[] =>
  readdirSync(join(root, p), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

export interface TruthEntry {
  readonly id: string;
  readonly title: string;
  readonly establishes: string;
  readonly does_not_establish: string;
  readonly probe: string;
  readonly expect: Record<string, unknown>;
  readonly evidence: readonly string[];
  readonly crossed_when: string;
}

export interface TruthSpec {
  readonly version: string;
  readonly entries: readonly TruthEntry[];
}

type Probe = (root: string) => Record<string, unknown>;

/**
 * Each probe returns the numbers that bound one claim. They read the tree, not each other —
 * a probe that consumed another's output would let one wrong derivation confirm itself.
 */
export const PROBES: Record<string, Probe> = {
  /**
   * Has anything here ever talked to a model?
   *
   * Deliberately reports no count that varies by machine. `.promptnexus/` is gitignored, so
   * a local tree can hold run bundles a clean checkout does not — pinning how many would
   * make this check pass or fail on where it ran, which is the one thing a boundary must
   * never do. What is pinned instead is invariant on every machine and flips exactly once,
   * at the event that matters: `any_fingerprint_observed` goes true the first time a
   * provider answers, and cannot be turned true by a degraded run, because a degraded run
   * records UNAVAILABLE rather than agreement.
   *
   * This tree does hold one persisted eleven-stage run. All eleven entries recorded a null
   * fingerprint — a full pipeline executed and no model was reached, which is demo mode
   * working exactly as designed.
   */
  providerReach(root) {
    const { observations } = observe(root);
    const pins = readJson(root, "scripts/model-fingerprints.json");
    return {
      any_fingerprint_observed: observations.length > 0,
      fingerprints_pinned: Object.keys(pins.watch ?? {}).length,
      run_bundles_are_gitignored: /^\.promptnexus\/?$/m.test(readText(root, ".gitignore")),
      // Not "does a key exist" — the guard's job is to refuse a shaped-wrong key up front
      // rather than spend a suite discovering it. Probed by asking it about the exact
      // placeholder that is still sitting in the user environment.
      placeholder_key_refused: implausibleKeyReason("<your key>") !== null,
      real_shaped_key_accepted: implausibleKeyReason("sk-ant-api03-" + "x".repeat(64)) === null,
      // Derived from the source, not by running the command, and the reason is worth stating.
      // A behavioural probe would have to invoke `--live` with a key — and if the guard it
      // tests were ever removed, the probe ITSELF would dispatch the run. A check that
      // generates network traffic exactly when it fails is worse than one that reads a line.
      // `--max-calls 0` is not a safe substitute either: flag validation rejects it before the
      // budget path is reached. Verified behaviourally once, by hand, 29 August 2026: a
      // well-shaped key with no `--max-calls` exits 2 with "no budget declared", no call made.
      // Unreadable source reads as NOT verified, never as fine. Same rule the fingerprint
      // watch applies to a null fingerprint: absence of evidence is recorded as absence.
      live_requires_declared_budget: (() => {
        try {
          return /LIVE && MAX_CALLS === undefined/.test(readText(root, "scripts/run-eval.ts"));
        } catch {
          return false;
        }
      })(),
    };
  },

  /**
   * The differential oracle proves the port agrees with the frozen linter. It cannot prove
   * either is right — they are two implementations of one opinion, and three places where
   * they deliberately differ are declared rather than reconciled.
   */
  oracleScope(root) {
    const ported = readJson(root, "scripts/ported-gates.json").ported as unknown[];
    const allow = readJson(root, "scripts/divergence-allowlist.json").entries as any[];
    return {
      gates_in_registry: listGates().length,
      gates_in_source_linter: SOURCE_GATE_COUNT,
      gates_compared: ported.length,
      declared_divergences: allow.length,
      divergence_adrs: [...new Set(allow.map((e) => e.adr))].sort(),
      // The oracle is only an oracle while it cannot be edited to agree. Checked against the
      // freeze manifest rather than against the file existing.
      oracle_is_frozen: readJson(root, "sources/MANIFEST.json").files.some(
        (f: any) => f.extracted_to === "sources/v5/prompt_lint.py",
      ),
    };
  },

  /**
   * The anchor's labels are produced by injecting a fragment and keeping the case only when
   * exactly one previously-silent gate starts firing. That makes it evidence about gate
   * recall over generated text — and about nothing else. It is not a benchmark, the cases
   * are not prompts anyone wrote, and the two arms partition the registry rather than nest.
   */
  anchorLabels(root) {
    const anchor = readJson(root, "eval/gate-recall-anchor.json");
    const base: string[] = anchor.comparison.baseline_gate_set.gate_ids;
    const cand: string[] = anchor.comparison.candidate_gate_set.gate_ids;
    const registry = listGates().map((g) => g.id).sort();
    const union = [...new Set([...base, ...cand])].sort();
    const overlap = base.filter((id) => cand.includes(id));
    return {
      cases: anchor.generator.case_count,
      seed: anchor.generator.seed,
      label_source: anchor.generator.module,
      arms_overlap: overlap.length,
      arms_cover_registry: union.length === registry.length && union.every((id, i) => id === registry[i]),
      baseline_gates: base.length,
      candidate_gates: cand.length,
      // Cases are stored as ids and regenerated, so the file is a claim about a generator
      // rather than a corpus. Worth stating: it means the anchor is reproducible and also
      // that nothing in it was reviewed by a person.
      cases_stored_inline: (anchor.suite.cases ?? []).length,
      case_ids_stored: (anchor.suite.case_ids ?? []).length,
    };
  },

  /**
   * What each suite can resolve. The three smoke suites are below the exact floor by an
   * order of magnitude — they are wiring checks, and a green one is not a measurement.
   */
  suiteResolution(root) {
    const anchor = readJson(root, "eval/gate-recall-anchor.json");
    const sizes: Record<string, number> = {};
    for (const f of readdirSync(join(root, "eval")).filter((n) => n.endsWith(".json"))) {
      const s = readJson(root, `eval/${f}`);
      if (Array.isArray(s.cases)) sizes[f.replace(/\.json$/, "")] = s.cases.length;
    }
    const floor = floorDiscordant(0.05);
    return {
      exact_floor_discordant_units: floor,
      anchor_cases: anchor.generator.case_count,
      anchor_detectable_delta: anchor.suite.resolution.detectable_delta,
      smoke_suite_sizes: sizes,
      // Deliberately not "suites that can attain significance". The floor is on DISCORDANT
      // units, and a suite's size is only an upper bound on those — n ≥ 6 is necessary and
      // nowhere near sufficient. Counting the other direction states exactly what is known:
      // a suite below the floor could not have resolved anything whatever the data said.
      smoke_suites_below_exact_floor: Object.values(sizes).filter((n) => n < floor).length,
    };
  },

  /**
   * One gate's reading of one shape, and the only place in this repository where behaviour
   * is specified rather than described. Four shapes are known to be read wrongly; exactly
   * one of those errs toward silence, which is the direction that matters.
   */
  manifestSpec(root) {
    const spec = readJson(root, "spec/manifest-shapes.json");
    const cases = spec.cases as any[];
    const limits = cases.filter((c) => c.status === "known-limit");
    return {
      cases: cases.length,
      specified: cases.length - limits.length,
      known_limits: limits.length,
      unsafe_limits: limits.filter((c) => c.wanted === "FAIL").length,
      gate: spec.gate,
    };
  },

  /**
   * The ratio the documentation set does not state anywhere: how much is described against
   * how much runs. Both halves derived from the tree, so neither can be talked up.
   */
  builtSurface(root) {
    const stages = readdirSync(join(root, "core/src/stages")).filter(
      (f) => f.endsWith(".ts") && !["pipeline.ts", "stage-kit.ts"].includes(f),
    );
    const tsconfig = readText(root, "tsconfig.json");
    return {
      documentation_markdown_files: readdirSync(join(root, "Documentation")).filter((f) => f.endsWith(".md")).length,
      gates_built: listGates().length,
      stages_built: stages.length,
      adapters_built: dirNames(root, "adapters"),
      adapters_target: 5,
      shells_present: dirNames(root, "shells"),
      shells_target: 3,
      // `shells/api` is present and does not compile. Stating it here rather than only in a
      // register entry, because "2 of 3 shells" reads as progress and one of the two is a
      // directory nobody owns.
      shells_excluded_from_typecheck: (tsconfig.match(/"shells\/api"/g) ?? []).length === 1,
    };
  },

  /**
   * The literature corpus is the stated warrant for the measured results the evaluation ADR
   * opens with. It is 2 GB of third-party PDFs, gitignored, so no clean checkout has ever
   * verified it and CI never has either. That does not make it false; it makes it a local
   * assertion, and the difference should be visible.
   */
  corpusWarrant(root) {
    const manifest = readJson(root, "scripts/corpus-manifest.json");
    const pkg = readJson(root, "package.json");
    const gitignore = readText(root, ".gitignore");
    return {
      files: manifest.files,
      unique_documents: manifest.unique_documents,
      byte_identical_duplicates: manifest.files - manifest.unique_documents,
      in_verify: pkg.scripts.verify.includes("check:corpus"),
      gitignored: /^PDF\/?$/m.test(gitignore),
      checkable_on_clean_checkout: false,
    };
  },

  /**
   * Three claims that all get called "reproducible", of three different strengths.
   *
   * Derived rather than asserted because the temptation here is to state the strong version:
   * "the build is reproducible" is a sentence this project cannot support — nothing is
   * compiled. What it can support is narrower and is pinned field by field, so the weakest of
   * the three cannot borrow the strongest's credibility by sitting in the same sentence.
   */
  reproducibility(root) {
    const hashFile = readJson(root, "build-hash.json");
    const hashSource = readText(root, "scripts/build-hash.mjs");
    const anchor = readJson(root, "eval/gate-recall-anchor.json");
    const pkg = readJson(root, "package.json");
    return {
      artifact_files: hashFile.files,
      // The property the whole claim rests on: a CRLF checkout and an LF checkout agree.
      hash_is_lf_normalised: /replace\(\/\\r\\n\/g, "\\n"\)/.test(hashSource),
      // Asked of the real predicate, not of its source text: what the hash covers is a
      // behaviour, and a comment claiming an exclusion is not one.
      hash_excludes_tests_and_tooling:
        !isArtifactPath("test/checkers.test.ts") &&
        !isArtifactPath("core/test/eval.test.ts") &&
        !isArtifactPath("scripts/check-counts.mjs"),
      hash_excludes_itself: !isArtifactPath("build-hash.json"),
      anchor_regenerates_from_seed: anchor.generator.seed,
      oracle_verdicts_agree: pkg.scripts.verify.includes("npm run differential"),
      // No bundler, no compile step, no emit. `tsc --noEmit` typechecks and produces nothing;
      // tsx transpiles at run time. Stated as a fact about the project, not a shortcoming.
      build_is_compiled: /"build"\s*:/.test(JSON.stringify(pkg.scripts)) || pkg.scripts.typecheck !== "tsc --noEmit",
    };
  },

  /**
   * Two guards, and the header of one of them claimed the other's coverage for months while
   * `readFileSync` ran green inside a Core gate. Derived from the sources rather than from
   * either header, so a trap added or removed reopens the question instead of quietly
   * widening what "Core is pure" is taken to mean.
   */
  purityGuards(root) {
    const harness = readText(root, "core/test/purity.setup.ts");
    const boundaries = readText(root, "scripts/check-boundaries.mjs");
    const traps = ["fetch()", "Math.random()", "Date.now()", "new Date()"].filter((t) =>
      harness.includes(`violation("${t}")`),
    );
    const builtins = boundaries.match(/const EFFECTFUL_BUILTINS = \[([\s\S]*?)\]/);
    return {
      runtime_traps: traps,
      runtime_blocks_filesystem: /violation\("(readFileSync|fs)/.test(harness),
      static_forbidden_builtins: builtins ? (builtins[1].match(/"[^"]+"/g) ?? []).length : -1,
      static_reads_every_core_file: boundaries.includes("core/src"),
      // Both are needed and neither subsumes the other: the harness is bounded by test
      // coverage, the static check cannot see an effect handed in at runtime.
      guards: 2,
    };
  },
};

// ── comparison ───────────────────────────────────────────────────────────────



/** Order-insensitive for objects, order-sensitive for arrays — an arm ordering is meaning. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (JSON.stringify(ka) !== JSON.stringify(kb)) return false;
    return ka.every((k) => sameValue((a as any)[k], (b as any)[k]));
  }
  return Object.is(a, b);
}

export interface Failure {
  readonly entry: string;
  readonly detail: string;
}

export interface Result {
  readonly ok: boolean;
  readonly fatalCode?: number;
  readonly fatal?: string;
  readonly failures: Failure[];
  readonly derived: Record<string, Record<string, unknown>>;
  readonly spec?: TruthSpec;
}

/**
 * `spec` and `probes` are injectable so the suite can plant each structural defect —
 * a missing probe, an empty pin, a probe nobody names — without a fixture tree deep
 * enough for the real probes to read. The must-not-fire case still loads from disk.
 */
export function checkTruthBoundary(
  root = process.cwd(),
  opts: { spec?: TruthSpec; probes?: Record<string, Probe> } = {},
): Result {
  const probes = opts.probes ?? PROBES;
  const fail = (code: number, message: string): Result => ({
    ok: false, fatalCode: code, fatal: message, failures: [], derived: {},
  });

  let spec: TruthSpec;
  try {
    spec = opts.spec ?? readJson(root, SPEC);
  } catch (err) {
    return fail(2, `cannot read ${SPEC}: ${(err as Error).message}`);
  }
  if (!Array.isArray(spec.entries) || spec.entries.length === 0) {
    return fail(2, `${SPEC} declares no entries. An empty boundary is not a modest claim; it is no claim.`);
  }

  const failures: Failure[] = [];
  const derived: Record<string, Record<string, unknown>> = {};

  const ids = spec.entries.map((e) => e.id);
  for (const dup of ids.filter((id, i) => ids.indexOf(id) !== i)) {
    failures.push({ entry: dup, detail: "duplicate entry id — one would silently shadow the other in the document." });
  }

  // Bijection, both directions. A named-but-missing probe means an entry asserts nothing;
  // an unnamed probe means a derivation nobody reads. Both have shipped here before.
  const named = new Set(spec.entries.map((e) => e.probe));
  for (const name of Object.keys(probes)) {
    if (!named.has(name)) {
      failures.push({
        entry: `(probe) ${name}`,
        detail: `implemented in ${SPEC.replace("spec", "scripts")} but named by no entry. Either declare what it bounds or delete it.`,
      });
    }
  }

  for (const entry of spec.entries) {
    const probe = probes[entry.probe];
    if (!probe) {
      failures.push({ entry: entry.id, detail: `names probe "${entry.probe}", which does not exist. The entry asserts nothing.` });
      continue;
    }
    if (!entry.expect || Object.keys(entry.expect).length === 0) {
      failures.push({ entry: entry.id, detail: "has an empty `expect`. A boundary with nothing pinned cannot be crossed." });
      continue;
    }

    let actual: Record<string, unknown>;
    try {
      actual = probe(root);
    } catch (err) {
      failures.push({ entry: entry.id, detail: `probe "${entry.probe}" threw: ${(err as Error).message}` });
      continue;
    }
    derived[entry.id] = actual;

    for (const [key, want] of Object.entries(entry.expect)) {
      if (!(key in actual)) {
        failures.push({ entry: entry.id, detail: `pins \`${key}\`, which probe "${entry.probe}" no longer derives.` });
        continue;
      }
      if (!sameValue(actual[key], want)) {
        failures.push({
          entry: entry.id,
          detail:
            `\`${key}\` — declared ${JSON.stringify(want)}, derived ${JSON.stringify(actual[key])}.\n` +
            `      ${entry.crossed_when}`,
        });
      }
    }
    // The other direction: a probe that grew a field nobody pinned is a boundary that moved
    // without anyone declaring where to. Reported, because the last four defects in this
    // repository were all found by checking the side the author had not just edited.
    for (const key of Object.keys(actual)) {
      if (!(key in entry.expect)) {
        failures.push({
          entry: entry.id,
          detail: `probe "${entry.probe}" derives \`${key}\`, which the entry does not pin. Pin it or stop deriving it.`,
        });
      }
    }
  }

  return { ok: failures.length === 0, failures, derived, spec };
}

// ── rendering ────────────────────────────────────────────────────────────────

const fence = (v: unknown): string => "```json\n" + JSON.stringify(v, null, 2) + "\n```";

export function render(spec: TruthSpec): string {
  const out: string[] = [];
  out.push("# The truth boundary");
  out.push("");
  out.push("**Generated from `spec/truth-boundary.json`. Do not edit.**");
  out.push("`npm run docs:truth` writes it; `npm run check:truth` re-derives every pinned number");
  out.push("from the repository and fails when one has moved. It runs inside `npm run verify`.");
  out.push("");
  out.push("Every other check in this repository asks whether a number is right. This one asks what");
  out.push("it is right *about*. A correct figure attached to an overreaching claim is the more");
  out.push("dangerous of the two, because a checker has already blessed it.");
  out.push("");
  out.push(`${spec.entries.length} entries · spec version ${spec.version}.`);
  out.push("");
  out.push("Each entry states a scope in two halves and pins the numbers that bound it. The");
  out.push("**Crossed when** line names the event that should make someone rewrite the claim —");
  out.push("that event is a failing build, not a note in a backlog.");
  out.push("");
  out.push("---");
  out.push("");

  for (const e of spec.entries) {
    out.push(`## ${e.title}`);
    out.push("");
    out.push(`\`${e.id}\` · probe \`${e.probe}\``);
    out.push("");
    out.push(`**Establishes.** ${e.establishes}`);
    out.push("");
    out.push(`**Does not establish.** ${e.does_not_establish}`);
    out.push("");
    out.push("**Pinned:**");
    out.push("");
    out.push(fence(e.expect));
    out.push("");
    out.push(`**Crossed when.** ${e.crossed_when}`);
    out.push("");
    out.push(`**Evidence:** ${e.evidence.map((p) => `\`${p}\``).join(" · ")}`);
    out.push("");
  }
  return out.join("\n");
}

// ── entry point ──────────────────────────────────────────────────────────────

function main(): number {
  const derive = process.argv.includes("--derive");
  const check = process.argv.includes("--check");
  const root = process.cwd();

  if (derive) {
    const out: Record<string, unknown> = {};
    for (const [name, probe] of Object.entries(PROBES)) out[name] = probe(root);
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  const result = checkTruthBoundary(root);
  if (result.fatal) {
    console.error(`check:truth — ${result.fatal}`);
    return result.fatalCode ?? 2;
  }
  if (!result.ok) {
    console.error(`check:truth — ${result.failures.length} boundary failure(s).\n`);
    for (const f of result.failures) console.error(`  ${f.entry}: ${f.detail}`);
    console.error(
      "\n  These numbers are not decoration. Each one bounds a claim someone will otherwise\n" +
      "  read as broader than it is. If the boundary genuinely moved, say so in the spec and\n" +
      "  rewrite the sentence it bounds — do not only update the number.",
    );
    return 1;
  }

  const rendered = render(result.spec!);
  if (!check) {
    writeFileSync(join(root, OUT), rendered);
    console.log(`docs:truth — wrote ${OUT} (${result.spec!.entries.length} entries).`);
    return 0;
  }

  let committed: string;
  try {
    committed = readText(root, OUT);
  } catch {
    console.error(`check:truth — ${OUT} is missing. Run \`npm run docs:truth\`.`);
    return 1;
  }
  if (committed.replace(/\r\n/g, "\n") !== rendered.replace(/\r\n/g, "\n")) {
    console.error(
      `check:truth — ${OUT} differs from what ${SPEC} produces.\n` +
      "  It is generated. Run `npm run docs:truth` and commit the result.",
    );
    return 1;
  }
  console.log(`check:truth — OK. ${result.spec!.entries.length} boundaries hold.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
