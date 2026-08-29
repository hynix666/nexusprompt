/**
 * The composition root for the CLI.
 *
 * Wiring only, no logic — the one file in this Shell permitted to name a
 * concrete adapter, and the reason `scripts/check-boundaries.mjs` carries a
 * recorded exemption for exactly this path. Everything the CLI does with a
 * provider or a store goes through the Application protocol; only the two
 * constructor calls below know which implementations are in play.
 *
 * Keeping this separate is what makes the dependency rule checkable instead of
 * aspirational. When `index.ts` named the adapters itself, "Shells do not import
 * adapters" had no file it could be true of.
 */

import { join } from "node:path";
import { Orchestrator } from "../../../application/src/orchestrator.js";
import type { PipelineRunOptions } from "../../../application/src/pipeline.js";
import { LocalProxyProvider } from "../../../adapters/provider-local-proxy/src/index.js";
import { LocalRevisionStore } from "../../../adapters/storage-local/src/index.js";
import { LocalEvidenceStore } from "../../../adapters/evidence-local/src/index.js";
import { LocalContentStore } from "../../../adapters/content-local/src/index.js";
import type { EventSink } from "../../../contracts/index.js";

export interface CompositionOptions {
  sink: EventSink;
  /** Where run bundles are retained. Defaults to `.nexusprompt/runs` under cwd. */
  runsDir?: string;
  /** Where evidence is retained. Defaults to `.nexusprompt/evidence` under cwd. */
  evidenceDir?: string;
  /** Where stage bodies are retained. Defaults to `.nexusprompt/content` under cwd. */
  contentDir?: string;
}

const defaultRunsDir = (opts: CompositionOptions) =>
  opts.runsDir ?? join(process.cwd(), ".nexusprompt", "runs");

export function composeOrchestrator(opts: CompositionOptions): Orchestrator {
  return new Orchestrator({
    provider: new LocalProxyProvider(),
    store: new LocalRevisionStore(defaultRunsDir(opts)),
    sink: opts.sink,
  });
}

/**
 * The dependencies an eleven-stage run needs.
 *
 * `runPipeline` is a function rather than a class, so this hands back the wiring instead of
 * an instance. Same two adapters, same store — a pipeline run and a single-stage run write
 * into the same bundle directory and are read back by the same `getRun`.
 *
 * This is the first caller of `runPipeline` outside a test. Until now the pipeline existed
 * and nothing could reach it: the exit gate's "persists and reloads intact" rested entirely
 * on an in-memory store in the suite.
 */
export function composePipeline(opts: CompositionOptions): PipelineRunOptions {
  return {
    provider: new LocalProxyProvider(),
    store: new LocalRevisionStore(defaultRunsDir(opts)),
    /**
     * The content plane, wired.
     *
     * `revision-entry` 2.0.0's `input_ref`/`output_ref` and the `dangling-ref` promotion
     * precondition both landed before anything constructed a `ContentStore`, so every
     * revision recorded `null` and the gate had nothing to check. Naming the adapter here is
     * what turns those from a declared shape into a retained artifact.
     *
     * A separate directory from `runs/` and `evidence/`, for the reason the evidence store
     * already records: the three have different lifetimes. Run bundles evict at eight,
     * evidence is append-only, and content is shared BY HASH across runs — putting it under
     * a directory with a retention policy would delete an artifact a surviving run still
     * cites.
     */
    content: new LocalContentStore(opts.contentDir ?? join(process.cwd(), ".nexusprompt", "content")),
    sink: opts.sink,
  };
}

/**
 * The evidence plane.
 *
 * A separate directory from `runs/` because the two have different lifetimes on purpose:
 * `storage-local` keeps eight run bundles and evicts the ninth, while evidence is
 * append-only and never evicted. Pointing them at one directory would put a retention
 * policy in front of the records a promotion cites.
 */
export function composeEvidence(opts: CompositionOptions): LocalEvidenceStore {
  return new LocalEvidenceStore(
    opts.evidenceDir ?? join(process.cwd(), ".nexusprompt", "evidence"),
  );
}
