/**
 * Composition root for the pipeline-ui shell.
 *
 * Wiring only, no logic — the one file in this Shell permitted to name a
 * concrete adapter. `scripts/check-boundaries.mjs` carries a recorded
 * exemption for this path for the same reason it does for shells/cli and
 * shells/api: the composition root exists to name adapters, and that is its
 * whole job.
 */

import { join } from "node:path";
import { Orchestrator } from "../../../application/src/orchestrator.js";
import type { PipelineRunOptions } from "../../../application/src/pipeline.js";
import { LocalProxyProvider } from "../../../adapters/provider-local-proxy/src/index.js";
import { LocalRevisionStore } from "../../../adapters/storage-local/src/index.js";
import { LocalContentStore } from "../../../adapters/content-local/src/index.js";
import type { EventSink } from "../../../contracts/index.js";

export interface UiCompositionOptions {
  sink: EventSink;
  runsDir?: string;
  contentDir?: string;
}

export function composeOrchestrator(opts: UiCompositionOptions): Orchestrator {
  return new Orchestrator({
    provider: new LocalProxyProvider(),
    store: new LocalRevisionStore(opts.runsDir ?? join(process.cwd(), ".nexusprompt", "runs")),
    sink: opts.sink,
  });
}

export function composePipeline(opts: UiCompositionOptions): PipelineRunOptions {
  return {
    provider: new LocalProxyProvider(),
    store: new LocalRevisionStore(opts.runsDir ?? join(process.cwd(), ".nexusprompt", "runs")),
    content: new LocalContentStore(
      opts.contentDir ?? join(process.cwd(), ".nexusprompt", "content"),
    ),
    sink: opts.sink,
  };
}
