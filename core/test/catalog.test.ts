import { describe, it, expect } from "vitest";
import {
  listTechniques,
  getTechnique,
  techniquesInCategory,
  verifierCheckable,
  TECHNIQUE_COUNT,
  CATALOG_PROVENANCE,
} from "../src/catalog/registry.js";

/**
 * The catalog registry, and the eight corrections applied on the way in.
 *
 * The corrections are the point of these tests. `sources/` is hash-frozen and holds
 * eight wrong citation titles, verified against arXiv's own metadata. They are fixed
 * at the import boundary, and each fix is asserted here against a **literal** — not
 * against the corrections file, which would only prove the file agrees with itself.
 */

describe("catalog registry", () => {
  it("holds all 172 records", () => {
    expect(TECHNIQUE_COUNT).toBe(172);
    expect(listTechniques()).toHaveLength(172);
  });

  it("is frozen — a caller cannot mutate the shared catalog", () => {
    expect(Object.isFrozen(listTechniques())).toBe(true);
  });

  it("records where the data came from and how many fixes were applied", () => {
    expect(CATALOG_PROVENANCE.source).toBe("sources/catalog/data/prompt_technique_catalog.json");
    expect(CATALOG_PROVENANCE.corrections_applied).toBe(8);
    expect(String(CATALOG_PROVENANCE.source_sha256)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("looks up by id and by alias", () => {
    const cot = getTechnique("chain-of-thought");
    expect(cot?.name).toBeTruthy();
    const withAlias = listTechniques().find((t) => t.aliases.length > 0)!;
    expect(getTechnique(withAlias.aliases[0])?.id).toBe(withAlias.id);
  });

  it("returns undefined for an unknown id rather than throwing", () => {
    expect(getTechnique("no-such-technique")).toBeUndefined();
  });

  it("ids are unique", () => {
    const ids = listTechniques().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("filters by category and by verification status", () => {
    const reasoning = techniquesInCategory("reasoning-elicitation");
    expect(reasoning.length).toBeGreaterThan(0);
    for (const t of reasoning) expect(t.category).toBe("reasoning-elicitation");

    const checkable = verifierCheckable();
    expect(checkable.length).toBe(130); // the frozen distribution
    for (const t of checkable) expect(t.verification_status).toBe("verifier-checkable");
  });

  it("every record carries a primary source with a title", () => {
    // CONTRIBUTING.md makes this non-negotiable.
    for (const t of listTechniques()) {
      expect(t.primary_source?.title?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("the eight citation corrections applied at import", () => {
  const corrected: Array<[string, string]> = [
    ["grammar-constrained-decoding-efficiency",
      "Attention Meets Reachability: Structural Equivalence and Efficiency in Grammar-Constrained LLM Decoding"],
    ["reliable-constrained-diffusion-decoding",
      "Lookahead-then-Verify: Reliable Constrained Decoding for Diffusion LLMs under Context-Free Grammars"],
    ["modularization-of-thought-code-gen",
      "MoT: Modularization-of-Thought Prompting for Effective Code Generation"],
    ["adaptive-weighted-rejection-sampling",
      "Fast Controlled Generation from Language Models with Adaptive Weighted Rejection Sampling"],
    ["hackaprompt-taxonomy",
      "Ignore This Title and HackAPrompt: Exposing Systemic Vulnerabilities of LLMs through a Global Scale Prompt Hacking Competition"],
    ["prompt-matcher-schema-matching",
      "Prompt-Matcher: Leveraging Large Models to Reduce Uncertainty in Schema Matching Results"],
    ["prompting-llms-recommender-systems",
      "Tapping the Potential of Large Language Models as Recommender Systems: A Comprehensive Framework and Empirical Analysis"],
    ["soda-search-based-inversion",
      "GPT, But Backwards: Exactly Inverting Language Model Outputs"],
  ];

  it.each(corrected)("%s carries the title arXiv actually shows", (id, title) => {
    expect(getTechnique(id)?.primary_source.title).toBe(title);
  });

  it("corrects exactly eight records and no more", () => {
    expect(corrected).toHaveLength(8);
    expect(CATALOG_PROVENANCE.corrections_applied).toBe(corrected.length);
  });
});

describe("the three differences deliberately left alone", () => {
  /**
   * Adjudicated in LITERATURE_CORPUS.md. Pinned here because "we chose not to change
   * this" is exactly the decision a later reader would otherwise undo — and because an
   * earlier audit wrongly reported `chain-of-symbol` as a defect by comparing against
   * the PDF instead of arXiv.
   */
  it("chain-of-symbol keeps arXiv's own title, misspelling included", () => {
    expect(getTechnique("chain-of-symbol")?.primary_source.title)
      .toBe("Chain-of-Symbol Prompting Elicits Planning in Large Langauge Models");
  });

  it("knn-prompting keeps the de-LaTeXed rendering", () => {
    // arXiv renders "$k$NN Prompting"; stripping the markup is not an error.
    expect(getTechnique("knn-prompting")?.primary_source.title)
      .toBe("kNN Prompting: Beyond-Context Learning with Calibration-Free Nearest Neighbor Inference");
  });

  it("skeleton-of-thought keeps the title matching its cited venue", () => {
    // arXiv now shows the retitled version; the catalog cites ICLR 2024, where it was
    // published under this title. Stale against arXiv, correct against the venue.
    expect(getTechnique("skeleton-of-thought")?.primary_source.title)
      .toBe("Skeleton-of-Thought: Large Language Models Can Do Parallel Decoding");
  });
});
