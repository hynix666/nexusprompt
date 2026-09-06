import { join } from "node:path";
import { Orchestrator } from "../../../application/src/orchestrator.js";
import { LocalProxyProvider } from "../../../adapters/provider-local-proxy/src/index.js";
import { LocalRevisionStore } from "../../../adapters/storage-local/src/index.js";
import { providerCallBudgetFromEnv } from "./security.js";
import type { EventSink } from "../../../contracts/index.js";
import type { ApiDependencies } from "./app.js";

export function composeApi(): ApiDependencies {
  const provider = new LocalProxyProvider();
  // A no-op: nothing here reaches redactingSink, so this path emits no events at all rather
  // than emitting unredacted ones. Worth a comment because it looks incomplete otherwise.
  const sink: EventSink = { emit() {} };
  return {
    provider,
    orchestrator: new Orchestrator({
      provider,
      store: new LocalRevisionStore(join(process.cwd(), ".nexusprompt", "runs")),
      sink,
      // See providerCallBudgetFromEnv's own comment for what this can and cannot do.
      budget: providerCallBudgetFromEnv(),
    }),
    coreBuildHash: "api",
  };
}