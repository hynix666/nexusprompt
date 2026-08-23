/**
 * The gate-recall anchor: a suite large enough to certify that one gate set detects more
 * than another.
 *
 * Pure. Text and verdicts only — no provider, no clock, no filesystem.
 *
 * ── Why this exists, and why it is not a suite of hand-written cases ─────────
 *
 * `application/src/eval.ts` says it outright: *"`variant_stubs` is how a second configuration
 * is expressed without a live provider."* Every outcome in the existing suites is therefore
 * chosen by whoever wrote the fixture. That is fine for fourteen smoke cases asserting
 * honesty properties, and it is fatal for an anchor: scaling authored outcomes to a few
 * thousand cases does not produce evidence, it produces a few thousand hand-placed
 * differences, and the resulting p-value measures the fixture author.
 *
 * So nothing here is authored. Inputs are generated from a seed, and the ground truth is
 * *derived* by construction rather than labelled.
 *
 * ── How a case gets its ground truth ────────────────────────────────────────
 *
 * 1. Generate a base text and a set of gate options from the seed.
 * 2. Run the full registry over it and record which gates are silent.
 * 3. Inject one more generated fragment.
 * 4. Run the full registry again. If exactly one previously-silent gate now fires, that gate
 *    is the case's `planted_gate` — discovered, not declared.
 * 5. If nothing newly fires, or several gates do, discard the candidate and draw again.
 *
 * Step 5 is what makes the label trustworthy. Labelling fragments by hand would have been
 * wrong in exactly the cases that matter: this corpus contains a citation that silences both
 * citation gates by declaring itself inside an empty ledger, and a secret that stops being a
 * finding once it sits inside a fence. Context decides, so context is what gets asked.
 *
 * Requiring *exactly one* new gate is deliberate. A fragment that trips three gates at once
 * is a case where "did this set catch the defect" has three different answers depending on
 * which gate you meant, and pooling them would let a set score a hit for catching something
 * other than the planted defect.
 *
 * ── What it certifies, and what it does not ─────────────────────────────────
 *
 * It certifies **relative detection**: over this generated input space, gate set A flags a
 * different proportion of planted defects than gate set B. Because `gate_set_ref` is a field
 * of `Configuration`, that is a configuration comparison and may certify a promotion.
 *
 * It says nothing about a model, about prompt quality, or about real user briefs. The
 * population it samples is "text this generator can produce", which is a stated limit rather
 * than a hidden one — and it is the same population the differential oracle validates the
 * gates against, deliberately, so the two instruments are not talking about different things.
 */

import { listGates, runGate } from "../gates/registry.js";
import { generate, generateOptions, rng, type CaseOptions } from "./generator.js";

export interface AnchorCase {
  case_id: string;
  text: string;
  options: CaseOptions;
  /**
   * The text before the defect was injected.
   *
   * Kept so the construction invariant can be RE-CHECKED rather than trusted. A mutation
   * probe deleted the "exactly one gate newly fires" rule and every test still passed,
   * because without the base there was nothing to compare against and the tests could only
   * ask the weaker question "does the planted gate fire at all". An invariant that cannot be
   * verified after the fact is an invariant you are taking on faith.
   */
  base_text: string;
  /**
   * The gate that went from silent to firing when the defect was injected. Discovered by
   * running the registry twice, never supplied by a caller — a ground truth someone can set
   * is a ground truth that can be set wrong.
   */
  planted_gate: string;
}

/** A gate set, as a `Configuration.gate_set_ref` would name it. */
export interface GateSet {
  gate_set_ref: string;
  gate_ids: readonly string[];
}

const fires = (verdict: string): boolean => verdict === "FAIL" || verdict === "WARN";

/** Gate ids that fire on this text, using the full registry. Exported so a test can re-derive
 * a case's construction invariant instead of trusting the label it carries. */
export function firingGates(text: string, options: CaseOptions): Set<string> {
  const out = new Set<string>();
  for (const g of listGates()) {
    if (fires(runGate(g.id, text, options).verdict)) out.add(g.id);
  }
  return out;
}

export interface BuildOptions {
  seed: number;
  /** How many accepted cases to produce. Candidates that fail step 5 do not count. */
  count: number;
  /**
   * Cap on draws, so a generator that stops producing usable defects fails loudly instead of
   * looping. Reached means the corpus is smaller than asked for, which the caller must see.
   */
  maxDraws?: number;
}

export class AnchorCorpusExhausted extends Error {
  constructor(readonly produced: number, readonly wanted: number, readonly draws: number) {
    super(
      `anchor corpus exhausted: ${produced} of ${wanted} cases after ${draws} draws. The ` +
      `generator stopped producing single-gate defects — widen the fragment set or lower the ` +
      `count, but do not raise maxDraws to paper over it.`,
    );
    this.name = "AnchorCorpusExhausted";
  }
}

/**
 * Build the corpus. Deterministic in `seed`: same seed, same cases, byte for byte.
 *
 * The draw loop keeps the RNG advancing across rejected candidates rather than resetting it,
 * so a rejection changes the stream. Resetting would make a rejected draw silently reproduce
 * itself forever.
 */
export function buildAnchorCorpus(opts: BuildOptions): AnchorCase[] {
  const rand = rng(opts.seed);
  const maxDraws = opts.maxDraws ?? opts.count * 40;
  const cases: AnchorCase[] = [];
  let draws = 0;

  while (cases.length < opts.count && draws < maxDraws) {
    draws += 1;
    const options = generateOptions(rand);
    const base = generate(rand);
    const before = firingGates(base, options);

    const injected = base + generate(rand);
    const after = firingGates(injected, options);

    const added = [...after].filter((id) => !before.has(id));
    if (added.length !== 1) continue;

    cases.push({
      case_id: `anchor-${opts.seed}-${cases.length.toString().padStart(5, "0")}`,
      text: injected,
      base_text: base,
      options,
      planted_gate: added[0],
    });
  }

  if (cases.length < opts.count) {
    throw new AnchorCorpusExhausted(cases.length, opts.count, draws);
  }
  return cases;
}

/**
 * Did this gate set catch the planted defect?
 *
 * "Caught" means some gate IN THE SET fires on the text. A set without the planted gate can
 * still catch the case through an overlapping gate, and that overlap is the interesting part
 * of the measurement — it is the difference between a gate that adds coverage and one that
 * duplicates coverage already present.
 */
export function caught(kase: AnchorCase, set: GateSet): boolean {
  for (const id of set.gate_ids) {
    if (fires(runGate(id, kase.text, kase.options).verdict)) return true;
  }
  return false;
}

/** Per-case outcomes for one gate set, in corpus order, ready for the comparator. */
export function scoreGateSet(
  corpus: readonly AnchorCase[],
  set: GateSet,
): Array<{ case_id: string; passed: boolean }> {
  return corpus.map((k) => ({ case_id: k.case_id, passed: caught(k, set) }));
}

/**
 * The observed discordance rate between two sets — the fraction of cases where exactly one
 * of them caught the defect.
 *
 * This is the parameter `requiredPairedSize` needs and the one nobody can know in advance.
 * Measuring it on a pilot corpus and then sizing is the honest order; assuming 0.5 because
 * it is the value the old rule hid is how the anchor ends up the wrong size in either
 * direction.
 */
export function discordanceRate(
  corpus: readonly AnchorCase[],
  a: GateSet,
  b: GateSet,
): { discordant: number; n: number; rate: number } {
  let discordant = 0;
  for (const k of corpus) {
    if (caught(k, a) !== caught(k, b)) discordant += 1;
  }
  return {
    discordant,
    n: corpus.length,
    rate: corpus.length === 0 ? 0 : discordant / corpus.length,
  };
}

/** The full registry, as a gate set. The reference both candidates are drawn from. */
export const FULL_GATE_SET = (): GateSet => ({
  gate_set_ref: "full-16",
  gate_ids: listGates().map((g) => g.id),
});

/** The full set minus one gate — the realistic question: does this gate add coverage? */
export function withoutGate(id: string): GateSet {
  const all = listGates().map((g) => g.id);
  if (!all.includes(id)) {
    throw new Error(`Unknown gate "${id}". Registered: ${all.join(", ")}.`);
  }
  return { gate_set_ref: `full-16-minus-${id}`, gate_ids: all.filter((g) => g !== id) };
}
