/**
 * Perturbations: seeded, deterministic variants of a case.
 *
 * A suite of clean, well-formed inputs overstates every result it reports — optimizers
 * evaluated only on tidy inputs collapse under minor perturbation, so a suite without
 * perturbed variants is measuring the easy half of its own question.
 *
 * ── Two rules that make the variants usable as evidence ──────────────────────
 *
 * **Expectation preservation is declared, not assumed.** A perturbation that changes what a
 * correct answer *is* has not perturbed the case, it has written a different case with a
 * stale expectation attached. Only preserving perturbations may share a cluster with their
 * base, because the whole point of the cluster is that its members ask the same question.
 *
 * **`cluster_id` is written here and nowhere else.** If suite authors assigned clusters, the
 * statistics downstream would be author-dependent — two suites with the same cases could
 * report different confidence purely from how someone grouped them. The base case's own id
 * is the cluster id, so an unperturbed case is a cluster of one and needs no annotation.
 *
 * ── Purity ───────────────────────────────────────────────────────────────────
 *
 * No `Math.random`. Randomness comes from an explicit seed through a small LCG, so the same
 * (case, kind, seed) always yields the same variant — and the purity harness would fail the
 * suite if it did not, which is the point of these living in Core.
 */

import type { EvalCase } from "../../../contracts/index.js";

/** Numerical Recipes' LCG constants. Deterministic, seeded, and adequate for jitter. */
function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

export interface Perturbation {
  readonly id: string;
  /**
   * Whether the correct answer is unchanged. Only preserving perturbations may share a
   * cluster with their base case.
   */
  readonly expectation_preserving: boolean;
  readonly description: string;
  apply(text: string, seed: number): string;
}

/** Homoglyphs that render near-identically but are different code points. */
const HOMOGLYPHS: Record<string, string> = {
  a: "а", // CYRILLIC SMALL LETTER A
  e: "е", // CYRILLIC SMALL LETTER IE
  o: "о", // CYRILLIC SMALL LETTER O
  p: "р", // CYRILLIC SMALL LETTER ER
  c: "с", // CYRILLIC SMALL LETTER ES
};

const PERTURBATIONS: readonly Perturbation[] = Object.freeze([
  {
    id: "whitespace",
    expectation_preserving: true,
    description: "Collapses and re-expands spacing. Tests tolerance of formatting the user did not intend.",
    apply(text, seed) {
      const rand = rng(seed);
      return text.split(" ").map((w) => (rand() < 0.3 ? `${w}  ` : w)).join(" ").replace(/\n/g, "\n ");
    },
  },
  {
    id: "typo",
    expectation_preserving: true,
    description: "Transposes adjacent characters in a few words. The most common real-world corruption.",
    apply(text, seed) {
      const rand = rng(seed);
      return text.replace(/\b(\w{4,})\b/g, (w) => {
        if (rand() > 0.25) return w;
        const i = 1 + Math.floor(rand() * (w.length - 2));
        return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
      });
    },
  },
  {
    id: "casing",
    expectation_preserving: true,
    description: "Flips the case of whole words. Meaning is unchanged; tokenisation is not.",
    apply(text, seed) {
      const rand = rng(seed);
      return text.replace(/\b([a-z]{3,})\b/g, (w) => (rand() < 0.2 ? w.toUpperCase() : w));
    },
  },
  {
    id: "homoglyph",
    expectation_preserving: true,
    description:
      "Substitutes visually identical Cyrillic code points for Latin ones. A reader sees no " +
      "difference; every exact-match detector does. This is the perturbation most likely to " +
      "expose a detector that matches on surface form rather than meaning.",
    apply(text, seed) {
      const rand = rng(seed);
      return text.replace(/[aeopc]/g, (ch) => (rand() < 0.15 ? HOMOGLYPHS[ch] ?? ch : ch));
    },
  },
  {
    id: "truncate",
    expectation_preserving: false,
    description:
      "Cuts the input short. NOT expectation-preserving: a truncated brief asks a different " +
      "question, so its variant is a case in its own right and must not share a cluster — " +
      "clustering it would pool two different questions under one estimate.",
    apply(text) {
      return text.slice(0, Math.max(1, Math.floor(text.length * 0.6)));
    },
  },
]);

export function listPerturbations(): readonly Perturbation[] { return PERTURBATIONS; }
export function getPerturbation(id: string): Perturbation | undefined {
  return PERTURBATIONS.find((p) => p.id === id);
}

/** The cluster a case belongs to. An unperturbed case is a cluster of one, named for itself. */
export const clusterOf = (kase: Pick<EvalCase, "case_id" | "cluster_id">): string =>
  kase.cluster_id ?? kase.case_id;

export interface ExpandOptions {
  /** Which perturbations to apply. Unknown ids are an error, never a silent skip. */
  kinds: readonly string[];
  seed: number;
}

/**
 * Expand one case into itself plus one variant per perturbation.
 *
 * The base case is returned first and unchanged, so a suite that expands still contains
 * everything it contained before — expansion adds evidence, it never replaces it.
 */
export function expandCase(kase: EvalCase, opts: ExpandOptions): EvalCase[] {
  const out: EvalCase[] = [{ ...kase, cluster_id: kase.case_id }];

  for (const kind of opts.kinds) {
    const p = getPerturbation(kind);
    if (!p) {
      throw new Error(
        `Unknown perturbation "${kind}". Known: ${PERTURBATIONS.map((x) => x.id).join(", ")}. ` +
          `A suite that silently skipped an unknown perturbation would report coverage it does not have.`,
      );
    }
    out.push({
      ...kase,
      case_id: `${kase.case_id}::${p.id}`,
      input: { ...kase.input, brief: p.apply(kase.input.brief, opts.seed) },
      perturbation: { of_case_id: kase.case_id, kind: p.id, seed: opts.seed },
      /**
       * A non-preserving perturbation gets its OWN cluster. It asks a different question, so
       * pooling it with the base would put two different questions under one estimate — the
       * exact error clustering exists to avoid, committed while claiming to avoid it.
       */
      cluster_id: p.expectation_preserving ? kase.case_id : `${kase.case_id}::${p.id}`,
    });
  }

  return out;
}

/** Expand a whole suite's cases, preserving order. */
export function expandCases(cases: readonly EvalCase[], opts: ExpandOptions): EvalCase[] {
  return cases.flatMap((c) => expandCase(c, opts));
}

/**
 * How many independent units a set of cases actually contains.
 *
 * This is the number the statistics must use. A suite of 14 cases expanded by four
 * perturbations has 70 rows and still only 14 independent questions, and treating the 70 as
 * independent is what makes a p-value anticonservative.
 */
export function countClusters(cases: readonly Pick<EvalCase, "case_id" | "cluster_id">[]): number {
  return new Set(cases.map(clusterOf)).size;
}
