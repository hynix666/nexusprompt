import { buildApi } from "./app.js";
import { composeApi } from "./composition-root.js";

const host = process.env.NEXUSPROMPT_API_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.NEXUSPROMPT_API_PORT ?? "4317", 10);
const app = buildApi(composeApi());

try {
  await app.listen({ host, port });
  console.log(`NexusPrompt API listening on http://${host}:${port}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}