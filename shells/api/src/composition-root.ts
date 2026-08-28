import { join } from "node:path";
import { Orchestrator } from "../../../application/src/orchestrator.js";
import { LocalProxyProvider } from "../../../adapters/provider-local-proxy/src/index.js";
import { LocalRevisionStore } from "../../../adapters/storage-local/src/index.js";
import type { EventSink } from "../../../contracts/index.js";
import type { ApiDependencies } from "./app.js";

export function composeApi(): ApiDependencies {
  const provider = new LocalProxyProvider();
  const sink: EventSink = { emit() {} };
  return {
    provider,
    orchestrator: new Orchestrator({
      provider,
      store: new LocalRevisionStore(join(process.cwd(), ".nexusprompt", "runs")),
      sink,
    }),
    coreBuildHash: "api",
  };
}