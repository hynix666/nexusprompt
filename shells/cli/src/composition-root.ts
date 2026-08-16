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
import { LocalProxyProvider } from "../../../adapters/provider-local-proxy/src/index.js";
import { LocalRevisionStore } from "../../../adapters/storage-local/src/index.js";
import type { EventSink } from "../../../contracts/index.js";

export interface CompositionOptions {
  sink: EventSink;
  /** Where run bundles are retained. Defaults to `.promptnexus/runs` under cwd. */
  runsDir?: string;
}

export function composeOrchestrator(opts: CompositionOptions): Orchestrator {
  return new Orchestrator({
    provider: new LocalProxyProvider(),
    store: new LocalRevisionStore(
      opts.runsDir ?? join(process.cwd(), ".promptnexus", "runs"),
    ),
    sink: opts.sink,
  });
}
