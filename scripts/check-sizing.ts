#!/usr/bin/env tsx
/**
 * Check every suite against what it can actually resolve.
 *
 * ## Why this exists
 *
 * `eval/compile-smoke.json` has carried this sentence in its comment block since it was
 * written: *"resolving a difference takes six flips, not one."* Six is exactly right. Under
 * McNemar the statistic is binomial(d, 0.5) over the d discordant units, so the smallest
 * two-sided p-value any arrangement can reach is `2 · 0.5^d`; five units bottom out at
 * 0.0625 and stop. The number lived in a comment and no code knew it.
 *
 * `eval/pipeline-smoke.json` has five cases. No comparison run on it can ever be
 * significant — and before this check and the comparator's refusal, that reported as
 * `p=0.0625 does not clear alpha=0.05`, which is indistinguishable from a suite that looked
 * carefully and found nothing.
 *
 * ## What it enforces
 *
 * 1. **Granularity is not a claim about power.** `resolution.detectable_delta` is one case
 *    out of n. Every suite already sets it that way; nothing kept it there when a suite
 *    grew, so adding a fifteenth case to a fourteen-case suite would leave 1/14 behind.
 * 2. **An anchor must be able to certify.** A suite of kind `anchor` below the exact floor
 *    is not an anchor, whatever it is named.
 * 3. **A suite below the floor must say so, in a file that cannot outlive the fact.**
 *    `scripts/suite-sizing-acknowledgments.json` follows the discipline of
 *    `divergence-allowlist.json` and `catalog-known-defects.json`: an entry with no reason
 *    fails, and an entry for a suite that has since grown past the floor is **stale and
 *    fails**, so the acknowledgment cannot silently outlive the defect it records.
 *
 * The arithmetic is imported from `core/src/eval/sizing.ts` — the same module the comparator
 * enforces with. A checker carrying its own copy of a formula is the drift this repository
 * keeps finding.
 *
 * Exit 0 every suite is honest about its resolution · 1 one is not · 2 inputs unreadable.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  LEGACY_ASSUMPTIONS, STATED_ASSUMPTIONS, floorDiscordant, legacyAnchorSize, minAttainableP,
  requiredPairedSize, resolvableDelta,
} from "../core/src/eval/sizing.js";
import type { EvalSuite } from "../contracts/index.js";

const SUITE_DIR = "eval";
const ACK_FILE = "scripts/suite-sizing-acknowledgments.json";

interface Ack { suite_id: string; cases: number; reason: string }

const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

/** Is `declared` the same number as 1/n, allowing for the decimals the file actually wrote? */
function matchesGranularity(declared: number, n: number): boolean {
  const exact = 1 / n;
  // Tolerance is half a unit in the last place the declaration used, so 0.0714 satisfies
  // 1/14 = 0.0714285... while 0.08 does not.
  const decimals = (String(declared).split(".")[1] ?? "").length;
  const tolerance = decimals === 0 ? 0.5 : 0.5 * Math.pow(10, -decimals);
  return Math.abs(declared - exact) <= tolerance;
}

function main(): void {
  let suites: Array<{ file: string; suite: EvalSuite }>;
  let acks: Ack[];
  try {
    suites = readdirSync(SUITE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ file: f, suite: read(join(SUITE_DIR, f)).suite as EvalSuite }))
      .filter((s) => s.suite && Array.isArray(s.suite.case_ids));
    acks = read(ACK_FILE).acknowledged as Ack[];
  } catch (err) {
    console.error(`check:sizing — cannot read inputs: ${(err as Error).message}`);
    process.exit(2);
  }

  const failures: string[] = [];
  const acked = new Map(acks.map((a) => [a.suite_id, a]));
  const seen = new Set<string>();

  console.log("check:sizing — what each suite can actually resolve\n");
  console.log("  suite                  kind         n   granularity   floor   min p    verdict");
  console.log("  " + "-".repeat(76));

  for (const { file, suite } of suites) {
    const n = suite.case_ids.length;
    const alpha = 1 - suite.resolution.confidence;
    const floor = floorDiscordant(alpha);
    const capable = n >= floor;
    seen.add(suite.suite_id);

    const verdict = capable ? "can reject" : "CANNOT EVER REJECT";
    console.log(
      `  ${suite.suite_id.padEnd(22)} ${suite.kind.padEnd(11)} ${String(n).padStart(2)}   ` +
      `${String(suite.resolution.detectable_delta).padEnd(11)}   ${String(floor).padStart(3)}   ` +
      `${minAttainableP(n).toFixed(4)}   ${verdict}`,
    );

    if (!matchesGranularity(suite.resolution.detectable_delta, n)) {
      failures.push(
        `${file}: resolution.detectable_delta is ${suite.resolution.detectable_delta} but the suite ` +
        `has ${n} cases, so its score granularity is ${(1 / n).toFixed(6)}. The field is granularity ` +
        `(eval-suite 2.0.1); it drifts whenever a suite grows and nothing pins it.`,
      );
    }

    if (suite.resolution.sized_for != null && n < suite.resolution.sized_for) {
      failures.push(
        `${file}: declares sized_for ${suite.resolution.sized_for} and holds ${n} cases.`,
      );
    }

    if (!capable && suite.kind === "anchor") {
      failures.push(
        `${file}: kind is "anchor" but ${n} case(s) are below the floor of ${floor}. An anchor ` +
        `exists to certify a promotion; one that cannot attain significance certifies nothing. ` +
        `This is not acknowledgeable — rename it or size it.`,
      );
    } else if (!capable) {
      const ack = acked.get(suite.suite_id);
      if (!ack) {
        failures.push(
          `${file}: ${n} case(s), below the floor of ${floor} — no comparison on this suite can ` +
          `ever be significant at alpha=${alpha.toFixed(4)}. Add an entry to ${ACK_FILE} saying so, ` +
          `or grow the suite. Leaving it unrecorded is how "inconclusive" comes to mean two ` +
          `different things in the same report.`,
        );
      } else if (ack.cases !== n) {
        failures.push(
          `${ACK_FILE}: entry for ${suite.suite_id} records ${ack.cases} case(s); the suite holds ` +
          `${n}. Pinning the count is what makes the entry expire when the suite changes.`,
        );
      } else if (!ack.reason || ack.reason.trim().length < 20) {
        failures.push(`${ACK_FILE}: entry for ${suite.suite_id} has no usable reason.`);
      }
    }
  }

  // The stale rule, in both directions.
  for (const ack of acks) {
    if (!seen.has(ack.suite_id)) {
      failures.push(`${ACK_FILE}: entry for ${ack.suite_id} names no suite under ${SUITE_DIR}/.`);
      continue;
    }
    const entry = suites.find((s) => s.suite.suite_id === ack.suite_id)!;
    const n = entry.suite.case_ids.length;
    const floor = floorDiscordant(1 - entry.suite.resolution.confidence);
    if (n >= floor) {
      failures.push(
        `${ACK_FILE}: entry for ${ack.suite_id} is STALE — the suite now holds ${n} case(s), at or ` +
        `above the floor of ${floor}, so it can attain significance and the acknowledgment is ` +
        `describing a defect that no longer exists. Remove it.`,
      );
    }
  }

  /**
   * The quoted anchor figure, and the three assumptions that produce it.
   *
   * `n >= z^2 / (2 d^2)` is not merely "the sizing rule". It is the conditional McNemar rule
   * with three parameters pinned and none of them written down:
   *
   *   - a ONE-SIDED z, used to size a test the comparator runs TWO-SIDED;
   *   - power at 50%, because the general form's `(z_a + z_b)^2` carries no z_b here;
   *   - discordance at 50%, the most favourable value it could have taken.
   *
   * Each is optimistic and they compound. The figure three documents quote is their product.
   */
  console.log("\n  Sizing an anchor at 2 pp, one assumption at a time:");
  const rows: Array<[string, number]> = [
    ["as quoted: one-sided z, 50% power, p_d=0.5", legacyAnchorSize(0.02)],
    ["two-sided z, as the test is actually run  ", requiredPairedSize(0.02, LEGACY_ASSUMPTIONS)],
    ["...and at 80% power                       ", requiredPairedSize(0.02, STATED_ASSUMPTIONS)],
  ];
  for (const [label, n] of rows) console.log(`    ${label}   ${String(n).padStart(6)} items`);
  console.log(`    Each line adds one assumption the old rule made silently; the last is ` +
              `${(rows[2][1] / rows[0][1]).toFixed(1)}x the first.`);
  console.log("\n  What the suites here resolve at 80% power:");
  for (const { suite } of suites) {
    const d = resolvableDelta(suite.case_ids.length, {
      ...STATED_ASSUMPTIONS, alpha: 1 - suite.resolution.confidence,
    });
    console.log(`    ${suite.suite_id.padEnd(22)} ${(100 * d).toFixed(1).padStart(5)} pp`);
  }

  if (failures.length > 0) {
    console.error(`\ncheck:sizing — FAILED, ${failures.length} problem(s):\n`);
    for (const f of failures) console.error(`  - ${f}\n`);
    process.exit(1);
  }
  console.log(`\ncheck:sizing — OK. ${suites.length} suite(s), ${acks.length} acknowledged below the floor.`);
}

main();
