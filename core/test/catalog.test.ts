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
  it("holds 172 frozen records plus 8 added at import", () => {
    expect(TECHNIQUE_COUNT).toBe(180);
    expect(listTechniques()).toHaveLength(180);
  });

  it("is frozen — a caller cannot mutate the shared catalog", () => {
    expect(Object.isFrozen(listTechniques())).toBe(true);
  });

  it("records where the data came from and how many fixes were applied", () => {
    expect(CATALOG_PROVENANCE.source).toBe("sources/catalog/data/prompt_technique_catalog.json");
    expect(CATALOG_PROVENANCE.corrections_applied).toBe(8);
    expect(CATALOG_PROVENANCE.records_added).toBe(8);
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
    expect(checkable.length).toBe(137); // 130 frozen + 7 of the 8 added
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

describe("the ensembling coverage gap, closed at import", () => {
  /**
   * The Prompt Report §2.2.4 names ten ensembling techniques. The frozen catalog had
   * two. These are the other eight, each cited to a paper resolved against arXiv's own
   * metadata rather than from memory.
   */
  const added: Array<[string, string]> = [
    ["demonstration-ensembling", "2308.08780"],
    ["mixture-of-reasoning-experts", "2305.14628"],
    ["diverse-step-aware-verifier", "2206.02336"],
    ["max-mutual-information-template-selection", "2203.11364"],
    ["meta-reasoning-over-chains", "2304.13007"],
    ["consistency-based-self-adaptive-prompting", "2305.14106"],
    ["universal-self-adaptive-prompting", "2305.14926"],
    ["prompt-paraphrasing", "1911.12543"],
  ];

  it.each(added)("%s is present and cites arXiv %s", (id, arxiv) => {
    const record = getTechnique(id);
    expect(record).toBeDefined();
    expect(record!.primary_source.arxiv_id).toBe(arxiv);
    expect(record!.status).toBe("verified-external");
  });

  it("all ten of the survey's ensembling techniques now have a record", () => {
    const ten = [
      "self-consistency", "universal-self-consistency", // already present
      ...added.map(([id]) => id),
    ];
    expect(ten).toHaveLength(10);
    for (const id of ten) expect(getTechnique(id), `${id} missing`).toBeDefined();
  });

  it("added records are reachable by their short alias", () => {
    expect(getTechnique("COSP")?.id).toBe("consistency-based-self-adaptive-prompting");
    expect(getTechnique("DENSE")?.id).toBe("demonstration-ensembling");
    expect(getTechnique("MoRE")?.id).toBe("mixture-of-reasoning-experts");
    expect(getTechnique("USP")?.id).toBe("universal-self-adaptive-prompting");
  });

  it("marks its own audit level honestly", () => {
    // Descriptions were written from the papers' abstracts; pitfalls were not checked
    // against the papers. The catalog-wide value is "unverified" for both — these eight
    // say something different on purpose, and the difference should not be normalised.
    for (const [id] of added) {
      const r = getTechnique(id)!;
      expect(r.source_audit.description).toBe("abstract-verified");
      expect(r.source_audit.pitfalls).toBe("unverified");
    }
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
