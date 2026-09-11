/**
 * build:precision-corpus — the compiled prompts gate precision is measured on (Phase 9, Task 2).
 *
 *   npm run build:precision-corpus -- --model llama3.1:8b [--force]
 *
 * Precision is TP / firings, so it needs text the gates can fire on that nobody wrote to make
 * them fire. The repository had none: the frozen fixtures are the port's own regression set,
 * and the catalog templates are fragments. This asks a local model to compile briefs through
 * the same `compile` stage `eval --local` runs, and keeps what it wrote.
 *
 * Two slices of 100 briefs each. `pilot` is eval/brief-pilot.json, where half the briefs plant
 * a credential or a stand-in token. `clean` plants nothing: structure-shape briefs from the
 * same generator at seed 2, so a gate firing there is firing on an ordinary prompt.
 *
 * One file per model, so a model can be added later without regenerating the others, and
 * never overwritten without --force: a stochastic model writes a different corpus every time,
 * and adjudications made against one would silently stop describing the other.
 *
 * Needs an Ollama daemon, so it sits outside `verify`, like build:judge-calibration. What CI
 * checks is the committed file, never its reproducibility from a model.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runSuite, configurationId, type StubbedCase } from "../application/src/eval.js";
// Naming a concrete adapter is what a composition root is for.
import { OllamaProvider } from "../adapters/provider-ollama/src/index.js";
import { buildBriefCorpus, type BriefCase } from "../core/src/eval/brief-generator.js";
import type { Configuration, EvalSuite, ProviderTransport } from "../contracts/index.js";

type Slice = "pilot" | "clean";

export interface CorpusRecord {
  case_id: string;
  slice: Slice;
  model: string;
  provider_model_fingerprint: string | null;
  output_sha256: string;
  text: string;
}

export interface CorpusFile {
  _comment: string[];
  model: string;
  generated_at: string;
  decoding: { temperature: string; max_tokens: string };
  briefs: Record<Slice, string>;
  excluded: Array<{ case_id: string; slice: Slice; reason: string }>;
  records: CorpusRecord[];
}

const PILOT = "eval/brief-pilot.json";
const CLEAN_SEED = 2;
const SLICE_SIZE = 100;

/** Ollama proxies `:cloud` / `-cloud` tags to a hosted service. Refused: the briefs would leave this machine. */
export function cloudRefusal(model: string): string | null {
  return /[:-]cloud$/.test(model)
    ? `"${model}" is a cloud model: Ollama runs it off this machine, so the briefs would reach a ` +
      "third party and the run would stop being zero-spend. Name a model pulled locally."
    : null;
}

export const corpusPath = (model: string): string =>
  `eval/precision-corpus/${model.replace(/[:/\\]/g, "_")}.json`;

/** 100 structure-shape briefs from seed 2, none repeated and none shared with brief-pilot. */
export function cleanSliceCases(pilotBriefs: ReadonlySet<string>): BriefCase[] {
  const seen = new Set(pilotBriefs);
  const out: BriefCase[] = [];
  for (const c of buildBriefCorpus({ seed: CLEAN_SEED, count: 1000 })) {
    if (!c.case_id.startsWith("brief-structure-") || seen.has(c.input.brief)) continue;
    seen.add(c.input.brief);
    out.push({ ...c, case_id: `clean-${out.length.toString().padStart(4, "0")}` });
    if (out.length === SLICE_SIZE) return out;
  }
  throw new Error(`cleanSliceCases: only ${out.length} distinct clean briefs at seed ${CLEAN_SEED}, need ${SLICE_SIZE}.`);
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function configurationFor(model: string): Configuration {
  const base = {
    prompt_template_ref: "core/src/stages/compile.ts",
    model_id: model,
    decoding: { temperature: null, seed: null },
    topology: { kind: "sequential" as const, stages: ["compile"], max_iterations: null },
    retrieval_config: null,
    tool_config: null,
    gate_set_ref: "scripts/ported-gates.json",
    router_policy_ref: null,
    budget: null,
  };
  return { configuration_id: configurationId(base), ...base };
}

export async function buildPrecisionCorpus(opts: {
  model: string;
  provider: ProviderTransport;
  generatedAt: string;
}): Promise<CorpusFile> {
  const pilot = JSON.parse(readFileSync(PILOT, "utf8")) as { suite: EvalSuite; cases: StubbedCase[] };
  const clean = cleanSliceCases(new Set(pilot.cases.map((c) => (c.input as { brief: string }).brief)));
  const slices: Array<[Slice, EvalSuite, StubbedCase[]]> = [
    ["pilot", pilot.suite, pilot.cases],
    ["clean", { ...pilot.suite, suite_id: "precision-clean", case_ids: clean.map((c) => c.case_id) }, clean],
  ];

  const configuration = configurationFor(opts.model);
  const records: CorpusRecord[] = [];
  const excluded: CorpusFile["excluded"] = [];
  for (const [slice, suite, cases] of slices) {
    const { outcomes } = await runSuite({ suite, cases, configuration, provider: opts.provider });
    outcomes.forEach((o, i) => {
      const case_id = suite.case_ids[i];
      // A demo placeholder is not a compiled prompt; keeping it would measure gates on text no
      // model wrote. Counted and named instead, so the corpus never looks more complete than it is.
      if (o.demo_mode) {
        excluded.push({ case_id, slice, reason: "demo_mode: the provider did not answer" });
        return;
      }
      records.push({
        case_id,
        slice,
        model: opts.model,
        provider_model_fingerprint: o.execution_provenance.provider_model_fingerprint,
        output_sha256: sha256(o.output.text),
        text: o.output.text,
      });
    });
  }

  return {
    _comment: [
      "Generated by scripts/build-precision-corpus.ts. Frozen once written: a stochastic model",
      "writes a different corpus every run, so this file is the corpus, not a cache of one.",
    ],
    model: opts.model,
    generated_at: opts.generatedAt,
    decoding: {
      temperature: "the model's own default; not pinned by provider-ollama",
      max_tokens: "MAX_TOKENS.generating in core/src/stages/stage-kit.ts, sent as num_predict",
    },
    briefs: {
      pilot: PILOT,
      clean: `buildBriefCorpus seed ${CLEAN_SEED}, structure shape only, deduplicated against itself and ${PILOT}`,
    },
    excluded,
    records,
  };
}

export interface MainDeps {
  makeProvider: (model: string) => ProviderTransport;
  fileExists: (path: string) => boolean;
  writeFile: (path: string, text: string) => void;
  log: (line: string) => void;
  now: () => string;
}

const realDeps: MainDeps = {
  // Ten minutes, not the adapter's 120 s: a 27B model is slow, and a timeout here would
  // silently shrink the corpus by turning a slow answer into an exclusion.
  makeProvider: (model) => new OllamaProvider({ model, timeoutMs: 600_000 }),
  fileExists: existsSync,
  writeFile: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  log: (line) => console.log(line),
  now: () => new Date().toISOString(),
};

export async function main(argv: string[], deps: MainDeps = realDeps): Promise<number> {
  const at = argv.indexOf("--model");
  const model = at >= 0 ? argv[at + 1] : undefined;
  if (!model || model.startsWith("--")) {
    deps.log("build:precision-corpus: name a local model with --model <name>. There is no default.");
    return 2;
  }
  const cloud = cloudRefusal(model);
  if (cloud) {
    deps.log(`build:precision-corpus: ${cloud}`);
    return 2;
  }
  const path = corpusPath(model);
  if (deps.fileExists(path) && !argv.includes("--force")) {
    deps.log(
      `build:precision-corpus: ${path} exists. Regenerating writes a different corpus and orphans\n` +
      "  every adjudication made against this one. Pass --force only if that is the intent.",
    );
    return 2;
  }
  const provider = deps.makeProvider(model);
  const health = await provider.healthCheck();
  if (!health.ok) {
    deps.log("build:precision-corpus: the Ollama daemon did not answer. Start it, then re-run. Nothing was asked.");
    return 2;
  }

  deps.log(`build:precision-corpus: ${model} — 2 × ${SLICE_SIZE} briefs through the compile stage.`);
  const file = await buildPrecisionCorpus({ model, provider, generatedAt: deps.now() });
  deps.writeFile(path, JSON.stringify(file, null, 2) + "\n");
  const kept = (s: Slice) => file.records.filter((r) => r.slice === s).length;
  deps.log(
    `build:precision-corpus: wrote ${path} — kept pilot ${kept("pilot")}, clean ${kept("clean")}; ` +
    `excluded ${file.excluded.length}.`,
  );
  return 0;
}

if (process.argv[1]?.endsWith("build-precision-corpus.ts")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
