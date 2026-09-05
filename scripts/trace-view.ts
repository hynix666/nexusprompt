/**
 * trace:view — render a stored run bundle as a human-readable, stage-by-stage trace.
 *
 * Phase 7's last unbuilt exit-gate clause. `LocalRevisionStore` already retains
 * everything a trace needs — one `RevisionEntry` per stage attempt, its gate verdicts,
 * and the `execution_provenance` that pins what produced it — but nothing before this
 * rendered it for a person. `getRun` and `listRecent` are read straight from the
 * contract; this file adds no new fact, only a view onto ones already persisted.
 *
 *   npm run trace:view                       list recent runs (up to 8 — storage-local's own bound)
 *   npm run trace:view -- <run_id>           show the full trace for one run
 *   npm run trace:view -- <run_id> --json    machine-readable: the raw RevisionEntry[]
 *   npm run trace:view -- --runs-dir <dir>   override the runs directory (default .nexusprompt/runs)
 *
 * Exit 0 — rendered (a list, or a run's trace)
 * Exit 1 — the named run has no entries
 * Exit 2 — the store could not be read (e.g. a mixed-lineage bundle)
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalRevisionStore } from "../adapters/storage-local/src/index.js";
import type { RevisionEntry } from "../contracts/index.js";

/** Flags that consume the argv entry after them — mirrors shells/cli's own convention. */
const VALUE_FLAGS = new Set(["--runs-dir"]);

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** The first argv entry that is neither a flag nor a flag's value. */
function positional(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

const short = (hash: string | null | undefined, len = 12): string =>
  hash ? hash.slice(0, len) : "(none)";

function renderEntry(e: RevisionEntry, index: number): string {
  const lines: string[] = [];
  const marker =
    e.status === "SUCCEEDED" ? "ok  " :
    e.status === "SKIPPED" ? "skip" :
    e.status === "DEMO" ? "demo" :
    e.status === "CANCELLED" ? "canc" : "FAIL";

  lines.push(
    `  [${index}] ${marker}  ${e.stage_id}` +
      (e.stage_attempt > 1 ? ` (attempt ${e.stage_attempt})` : "") +
      (e.feedback_round ? ` [feedback round ${e.feedback_round}]` : "") +
      (e.freshness === "STALE" ? "  STALE" : ""),
  );
  lines.push(`        revision ${short(e.revision_id, 8)} · ${e.timestamp}`);
  if (e.parent_revision_ids.length) {
    lines.push(`        parents: ${e.parent_revision_ids.map((p) => short(p, 8)).join(", ")}`);
  }
  lines.push(
    `        provider ${e.provider_used ?? "(none — demo)"} · ` +
      `input ${short(e.input_hash)} · output ${short(e.output_hash)} · ` +
      `content ${e.input_ref ? "retained" : "not retained"}/${e.output_ref ? "retained" : "not retained"}`,
  );
  for (const g of e.gate_results) {
    lines.push(`        ${g.verdict.padEnd(4)} ${g.gate_id}${g.verdict === "PASS" ? "" : ` — ${g.message}`}`);
  }
  const prov = e.execution_provenance;
  lines.push(
    `        core ${prov.core_build_hash}` +
      (prov.provider_model_fingerprint ? ` · model ${prov.provider_model_fingerprint}` : "") +
      (prov.config_fingerprint ? ` · config ${prov.config_fingerprint}` : ""),
  );
  return lines.join("\n");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const runsDir = flagValue(argv, "--runs-dir") ?? join(process.cwd(), ".nexusprompt", "runs");
  const asJson = argv.includes("--json");
  const runId = positional(argv);

  const store = new LocalRevisionStore(runsDir);

  if (!runId) {
    let runs;
    try {
      runs = await store.listRecent(8);
    } catch (err) {
      console.error(`trace:view — could not read ${runsDir}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
    if (asJson) {
      console.log(JSON.stringify(runs, null, 2));
      return 0;
    }
    if (runs.length === 0) {
      console.log(`trace:view — no runs found under ${runsDir}.`);
      return 0;
    }
    console.log(`trace:view — ${runs.length} recent run(s) under ${runsDir}:\n`);
    for (const r of runs) {
      console.log(`  ${r.run_id}   ${String(r.entries).padStart(2)} entries   ${r.first_timestamp} → ${r.last_timestamp}`);
    }
    console.log(`\nnpm run trace:view -- <run_id>   to see the full trace`);
    return 0;
  }

  let entries: RevisionEntry[];
  try {
    entries = await store.getRun(runId);
  } catch (err) {
    console.error(`trace:view — could not read run "${runId}": ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  if (entries.length === 0) {
    console.error(`trace:view — no entries for run "${runId}" under ${runsDir}.`);
    return 1;
  }

  if (asJson) {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  console.log(`trace:view — run ${runId}  (${entries.length} revision(s))\n`);
  entries.forEach((e, i) => {
    console.log(renderEntry(e, i));
    console.log("");
  });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`trace:view: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    });
}
