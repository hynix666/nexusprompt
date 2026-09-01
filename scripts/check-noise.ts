/**
 * The gate: a written model comparison may not claim a difference the instrument cannot see.
 *
 * Checks CLAIMS, not models. Both the floor and the prose it guards are committed files, so
 * this is file-vs-file consistency — no GPU, no daemon, no network. It runs in CI, where it
 * will report "not armed" forever, because CI can validate a measurement but never produce one.
 *
 * ## Two entry kinds, and they invert each other
 *
 *   bound      the captured number is a claimed difference in percentage points and must be
 *              >= what the suite resolves. Matching NOTHING is stale: the pin has outlived
 *              the prose it guarded, exactly as in `check-counts.mjs`.
 *   forbidden  an ordering with no magnitude. Matching ANYTHING fails; matching nothing is
 *              the satisfied state, NOT staleness — the entry guards against prose that
 *              should never appear, so its absence is success.
 *
 * `kind` is required rather than defaulted, because one rule cannot mean both directions and
 * a default would silently pick one.
 *
 * ## Why a bound rather than an equality
 *
 * `check-counts.mjs` asks "is this number the repository's number?". This asks "could the
 * instrument have seen a difference this small?". A claim of 6 pp on a suite that resolves
 * 39.5 pp is not a finding, however carefully it was measured.
 *
 * Exit 0 pass, or not armed · 1 a claim failed · 2 a broken input.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvableFor } from "./noise-floor.js";

const FLOOR = "eval/noise-floor.json";
const CLAIMS = "scripts/noise-claims.json";

interface Claim {
  kind: "bound" | "forbidden";
  document: string;
  pattern: string;
  reason: string;
}

export interface NoiseFailure {
  kind: "below-floor" | "stale" | "forbidden" | "unreadable" | "unparseable";
  document: string;
  detail: string;
}

export interface NoiseResult {
  ok: boolean;
  fatalCode: number | null;
  fatal: string | null;
  failures: NoiseFailure[];
  armed: boolean;
  claims: number;
}

export function checkNoise(root: string = process.cwd()): NoiseResult {
  const fail = (code: number, message: string): NoiseResult => ({
    ok: false, fatalCode: code, fatal: message, failures: [], armed: false, claims: 0,
  });

  let claims: Claim[];
  try {
    claims = JSON.parse(readFileSync(join(root, CLAIMS), "utf8")).claims;
  } catch (err) {
    return fail(2, `${CLAIMS} is unreadable: ${(err as Error).message}`);
  }
  if (!Array.isArray(claims)) return fail(2, `${CLAIMS} has no claims array.`);

  // Validated BEFORE the floor is read, so a malformed pin fails on a machine with no
  // measurement — which is every CI run — rather than waiting for someone's laptop.
  for (const c of claims) {
    if (c.kind !== "bound" && c.kind !== "forbidden") {
      return fail(2, `claim for ${c.document} has kind ${JSON.stringify(c.kind)}; expected "bound" or "forbidden".`);
    }
  }

  const floorPath = join(root, FLOOR);
  if (!existsSync(floorPath)) {
    return { ok: true, fatalCode: null, fatal: null, failures: [], armed: false, claims: claims.length };
  }

  let floor: { suite: { cases_scored: number }; discordance_rate: number };
  try {
    floor = JSON.parse(readFileSync(floorPath, "utf8"));
  } catch (err) {
    return fail(2, `${FLOOR} exists but is not valid JSON: ${(err as Error).message}. ` +
      "Absent and broken are different states.");
  }

  let resolvablePp: number;
  try {
    resolvablePp = resolvableFor(floor) * 100;
  } catch (err) {
    return fail(2, `${FLOOR} cannot yield a resolvable delta: ${(err as Error).message}`);
  }

  const failures: NoiseFailure[] = [];
  for (const c of claims) {
    let text: string;
    try {
      text = readFileSync(join(root, c.document), "utf8").replace(/\r\n/g, "\n");
    } catch {
      failures.push({ kind: "unreadable", document: c.document, detail: "pinned document does not exist" });
      continue;
    }
    const matches = [...text.matchAll(new RegExp(c.pattern, "g"))];

    if (c.kind === "forbidden") {
      for (const m of matches) {
        failures.push({
          kind: "forbidden", document: c.document,
          detail: `"${m[0]}" — an ordering with no magnitude. ${c.reason}`,
        });
      }
      continue;
    }

    if (matches.length === 0) {
      failures.push({
        kind: "stale", document: c.document,
        detail: `pattern ${c.pattern} matches nothing. The sentence it guarded is gone — ` +
          "delete the pin or restore the claim.",
      });
      continue;
    }
    // EVERY match, not just the first: one document can state the same comparison twice and
    // be wrong about only the second.
    for (const m of matches) {
      const claimed = Number(m[1]);
      if (!Number.isFinite(claimed)) {
        failures.push({
          kind: "unparseable", document: c.document,
          detail: `"${m[0]}" — the captured group is not a number.`,
        });
      } else if (claimed < resolvablePp) {
        failures.push({
          kind: "below-floor", document: c.document,
          detail: `claims ${claimed} pp; this suite resolves ${resolvablePp.toFixed(1)} pp. ${c.reason}`,
        });
      }
    }
  }

  return {
    ok: failures.length === 0, fatalCode: null, fatal: null,
    failures, armed: true, claims: claims.length,
  };
}

function main(): number {
  const { ok, fatal, fatalCode, failures, armed, claims } = checkNoise();

  if (fatal) {
    console.error(`check:noise: ${fatal}`);
    return fatalCode ?? 2;
  }
  if (!armed) {
    console.log(`check:noise — not armed. ${claims} claim(s) pinned, no ${FLOOR} to check them against.`);
    console.log("  A measurement needs a machine with models on it, which CI is not. The claims\n" +
                "  are still parsed, so a malformed pin fails here rather than on someone's laptop.");
    return 0;
  }
  if (ok) {
    console.log(`check:noise — OK. ${claims} claim(s) checked against ${FLOOR}.`);
    return 0;
  }

  console.error(`check:noise — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  ${f.kind.toUpperCase()} ${f.document}\n    ${f.detail}\n`);
  console.error("A difference smaller than the instrument can resolve is not a finding.");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
