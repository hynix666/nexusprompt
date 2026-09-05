/**
 * Cross-shell parity check.
 *
 * ADR-0006 states that the cross-shell parity test checks that two independent
 * Application consumers — cli and pipeline-ui — agree on GateResults for the
 * same input. This script runs both composition roots against the same brief,
 * using the demo path (no API key) so it works offline and in CI.
 *
 * What this proves: the two UI shells wire the Application protocol identically
 * and their composition roots name the same transport. Structural agreement,
 * not a model comparison.
 *
 * Exit 0 — results are identical
 * Exit 1 — results differ (wiring divergence)
 * Exit 2 — could not run
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { composePipeline as cliCompose } from "../shells/cli/src/composition-root.js";
import { composePipeline as pipelineUiCompose } from "../shells/pipeline-ui/src/composition-root.js";
import { runPipeline } from "../application/src/pipeline.js";
import type { GateResult } from "../contracts/index.js";

const BRIEF = "Write a system prompt for a customer service assistant.";

interface ParityRecord {
  shell: string;
  provider_id: string;
  gate_count: number;
  gate_keys: string;
  demo_mode: boolean;
}

function gateKey(r: GateResult): string {
  return `${r.gate_id}:${r.verdict}`;
}

async function runShell(
  name: string,
  opts: ReturnType<typeof cliCompose>,
): Promise<ParityRecord> {
  const run_id = randomUUID();
  const result = await runPipeline(
    {
      command_id: randomUUID(),
      run_id,
      stage_id: "deconstruct",
      input: { brief: BRIEF },
      context: { stakes: "LOW" },
    },
    opts,
  );

  const gateKeys = result.gate_results.map(gateKey).sort().join(",");

  return {
    shell: name,
    provider_id: opts.provider.provider_id,
    gate_count: result.gate_results.length,
    gate_keys: gateKeys,
    demo_mode: result.demo_mode,
  };
}

async function main(): Promise<number> {
  const sink = { emit: () => {} };

  let cliResult: ParityRecord;
  let uiResult: ParityRecord;

  try {
    cliResult = await runShell("cli", cliCompose({ sink }));
    uiResult = await runShell("pipeline-ui", pipelineUiCompose({ sink }));
  } catch (err) {
    console.error(
      `parity: could not run — ${err instanceof Error ? err.message : String(err)}`,
    );
    return 2;
  }

  const providerMatch = cliResult.provider_id === uiResult.provider_id;
  const demoMatch = cliResult.demo_mode === uiResult.demo_mode;
  const gatesMatch = cliResult.gate_keys === uiResult.gate_keys;

  if (providerMatch && demoMatch && gatesMatch) {
    console.log(
      `parity — OK. Both shells use provider="${cliResult.provider_id}", ` +
        `demo_mode=${cliResult.demo_mode}, ` +
        `${cliResult.gate_count} gate results agree.`,
    );
    return 0;
  }

  console.error("parity — DIVERGENCE detected:");
  if (!providerMatch) {
    console.error(
      `  provider_id: cli="${cliResult.provider_id}" pipeline-ui="${uiResult.provider_id}"`,
    );
  }
  if (!demoMatch) {
    console.error(
      `  demo_mode: cli=${cliResult.demo_mode} pipeline-ui=${uiResult.demo_mode}`,
    );
  }
  if (!gatesMatch) {
    console.error("  gate results differ:");
    console.error(`    cli:         ${cliResult.gate_keys}`);
    console.error(`    pipeline-ui: ${uiResult.gate_keys}`);
  }
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
