/**
 * Version numbers written into a schema's own prose, pinned to the `$id` they were written under.
 *
 * `run-manifest`'s `manifest_version` description said "Deliberately still 1.0.0 while this
 * schema is at 2.0.0". True when written. #179 bumped the `$id` to 3.0.0 and updated the
 * `$comment` one line below it, leaving the description asserting a version that had stopped
 * being true — the same defect that PR existed to fix, one field over. Nothing caught it:
 * `check:contracts` verifies version citations in `CONTRACTS.md`, not prose inside a schema,
 * and `test/contract-conformance.test.ts`'s drift check walks the nine keys of
 * `CONTRACT_VERSIONS`, which `run-manifest` is correctly not one of.
 *
 * ## Why this does not read the English
 *
 * The obvious guard is "a schema may not name its own version in prose". Measured against the
 * tree, that fires on three correct sentences and the fix that motivated it:
 *
 *   eval-run @2.0.0       "Unconstrained until 2.0.0"   — permanently true
 *   judge-verdict @1.2.0  "Added in 1.2.0"              — permanently true
 *   comparison @2.3.0     "Null since 2.3.0"            — permanently true
 *   run-manifest @2.0.0   "this schema is at 2.0.0"     — rotted at the next bump
 *
 * At the moment each was written all four were identical to any matcher: a semver equal to the
 * then-current `$id`. They stay identical afterwards, too — both kinds keep their number while
 * the `$id` moves past it. The discriminator is tense, not arithmetic, so no rule over a
 * snapshot and no rule over history separates them. A matcher for the present-tense form would
 * be a hand-picked sentinel list, which is the sparse-matcher shape this repository has been
 * bitten by before.
 *
 * So this checks nothing about the sentences. It uses the one signal that is exact and always
 * coincides with the moment such a sentence can rot: the `$id` bump. A schema's version-bearing
 * prose is fingerprinted and pinned to the `$id` it was acknowledged under. Move the `$id`, or
 * edit any sentence carrying a version, and the check fails with those sentences printed for a
 * human to re-read. It never claims a sentence is wrong — it refuses to let one go unread
 * across the event that can falsify it.
 *
 * This is `divergence-allowlist.json`'s mechanism one plane over, and it is what
 * `run-manifest`'s own `$comment` already asks for in the `$ref` case: a bump should "force a
 * decision here rather than silently leaving this copy behind".
 *
 * ## Scope, stated plainly
 *
 * Derived, not enumerated: every `contracts/*.schema.json` is walked, so a new schema carrying
 * a version in its prose fails for lack of an entry rather than being invisible. What it does
 * not do: judge whether a sentence is correct today (the bootstrap acknowledgement is a claim
 * that a human read all of them, nothing more), or catch prose that goes stale for a reason
 * other than a bump.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LEDGER = "contracts/self-reference-ledger.json";
const SEMVER = /\b\d+\.\d+\.\d+\b/g;

/** Every `description` / `$comment` in a schema that carries a semver, with where it lives. */
export function versionBearingProse(schema) {
  const found = [];
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === "description" || key === "$comment") && typeof value === "string") {
        const versions = value.match(SEMVER);
        if (versions) found.push({ path: `${path || "root"}.${key}`, text: value, versions });
      } else if (value && typeof value === "object") {
        walk(value, path ? `${path}.${key}` : key);
      }
    }
  };
  walk(schema, "");
  // Sorted so the fingerprint does not depend on key order in the file.
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The fingerprint covers the full text, not just the versions in it.
 *
 * Rewording "Added in 1.2.0" into "is at 1.2.0" changes no version and turns a permanently
 * true sentence into one that rots at the next bump. Hashing the versions alone would let that
 * through, and the whole point here is that the two cannot be told apart by their numbers.
 */
export function fingerprint(prose) {
  const h = createHash("sha256");
  for (const p of prose) h.update(p.path).update(" ").update(p.text).update(" ");
  return h.digest("hex").slice(0, 16);
}

export function readSchemas(root = process.cwd()) {
  const dir = join(root, "contracts");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".schema.json"))
    .sort()
    .map((file) => {
      const schema = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const prose = versionBearingProse(schema);
      return {
        name: file.replace(".schema.json", ""),
        version: String(schema.$id).split("/").pop(),
        prose,
        fingerprint: fingerprint(prose),
        mentions: prose.flatMap((p) => p.versions).sort(),
      };
    });
}

/** What the ledger should hold for the tree as it stands. */
export function renderLedger(schemas, reviewed) {
  const out = {};
  for (const s of schemas) {
    if (s.prose.length === 0) continue;
    out[s.name] = {
      acknowledged_at: s.version,
      fingerprint: s.fingerprint,
      mentions: s.mentions,
      reviewed,
    };
  }
  return out;
}

export function checkSchemaSelfReference(root = process.cwd()) {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(join(root, LEDGER), "utf8"));
  } catch (err) {
    return { ok: false, fatal: `cannot read ${LEDGER} — ${err.message}`, problems: [], schemas: [] };
  }

  const recorded = ledger.schemas ?? {};
  const schemas = readSchemas(root);
  const problems = [];

  for (const s of schemas) {
    const entry = recorded[s.name];

    if (s.prose.length === 0) {
      if (entry) {
        problems.push({
          schema: s.name,
          why: `no prose carries a version any more, but the ledger still has an entry — stale`,
          sentences: [],
        });
      }
      continue;
    }

    if (!entry) {
      problems.push({
        schema: s.name,
        why: `carries ${s.mentions.length} version mention(s) in prose and has no ledger entry`,
        sentences: s.prose,
      });
      continue;
    }

    if (entry.acknowledged_at !== s.version) {
      problems.push({
        schema: s.name,
        why: `$id is ${s.version}; these sentences were last read at ${entry.acknowledged_at}`,
        sentences: s.prose,
      });
      continue;
    }

    if (entry.fingerprint !== s.fingerprint) {
      problems.push({
        schema: s.name,
        why: `version-bearing prose changed since it was last read at ${entry.acknowledged_at}`,
        sentences: s.prose,
      });
    }
  }

  // An entry for a schema that no longer exists is stale in the other direction.
  const live = new Set(schemas.map((s) => s.name));
  for (const name of Object.keys(recorded)) {
    if (!live.has(name)) {
      problems.push({ schema: name, why: `no contracts/${name}.schema.json — stale entry`, sentences: [] });
    }
  }

  return { ok: problems.length === 0, fatal: null, problems, schemas };
}

function main() {
  const root = process.cwd();
  const write = process.argv.includes("--write");

  if (write) {
    const schemas = readSchemas(root);
    const existing = (() => {
      try {
        return JSON.parse(readFileSync(join(root, LEDGER), "utf8"));
      } catch {
        return {};
      }
    })();
    const reviewed = new Date().toISOString().slice(0, 10);
    const next = {
      _comment: existing._comment ?? [],
      schemas: renderLedger(schemas, reviewed),
    };
    writeFileSync(join(root, LEDGER), JSON.stringify(next, null, 2) + "\n", "utf8");
    const count = Object.values(next.schemas).reduce((n, e) => n + e.mentions.length, 0);
    console.log(`ack:schema-self-reference — wrote ${LEDGER}. ${Object.keys(next.schemas).length} schema(s), ${count} mention(s) acknowledged.`);
    console.log(`  This records that someone read them. It does not check that they are true.`);
    return 0;
  }

  const result = checkSchemaSelfReference(root);
  if (result.fatal) {
    console.error(`check:schema-self-reference — ${result.fatal}`);
    return 2;
  }

  if (!result.ok) {
    const lines = result.problems.map((p) => {
      const head = `  ${p.schema} — ${p.why}`;
      const body = p.sentences.map((s) => `      [${s.path}]\n      ${s.text.replace(/\s+/g, " ").slice(0, 300)}`);
      return body.length ? `${head}\n${body.join("\n\n")}` : head;
    });
    console.error(
      `check:schema-self-reference — ${result.problems.length} schema(s) need a look:\n\n` +
        lines.join("\n\n") +
        `\n\n  A version in a schema's prose is a claim about that schema. This does not decide\n` +
        `  whether the sentences above are right — it refuses to let them cross a $id bump\n` +
        `  unread, which is the one event that can turn a true one false. Re-read each, fix\n` +
        `  what is now wrong, then run \`npm run ack:schema-self-reference\`.\n`,
    );
    return 1;
  }

  const total = result.schemas.reduce((n, s) => n + s.mentions.length, 0);
  const carrying = result.schemas.filter((s) => s.prose.length > 0).length;
  console.log(
    `check:schema-self-reference — OK. ${total} version mention(s) across ${carrying} schema(s), ` +
      `each read at the $id it still carries.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
