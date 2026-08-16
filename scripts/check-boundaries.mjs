#!/usr/bin/env node
/**
 * The import-boundary rule.
 *
 * `DEVELOPMENT_AND_TESTING.md` said this rule "fails any PR that violates the
 * dependency table" and that it "is checked in CI, not left to code review."
 * Neither was true: there is no ESLint config in this repository and no CI. The
 * one shell that exists violated the rule, and nothing noticed.
 *
 * This is the enforcement, written as a plain script so it has no lint-plugin
 * dependency and can run before anything else in `npm run verify`.
 *
 * ## Why this, and not only the runtime purity harness
 *
 * The purity harness in `core/test/purity.setup.ts` traps effects *performed
 * during a test*. That is bounded by test coverage — an earlier audit found a
 * Core module the harness never watched because no Core test imported it. This
 * check reads every file under the layer instead, so it is complete over the
 * import surface whether or not a test exercises the line. The two are
 * complementary: this one denies Core the *capability*, the harness catches an
 * effect that arrives some other way.
 *
 * Limitation, stated rather than hidden: this matches import specifiers with a
 * regex. It sees static `import`/`export … from` and dynamic `import("…")`. It
 * does not resolve re-exports transitively, and it cannot see an effect reached
 * through a value passed in at runtime — that is what ADR-0005 and the harness
 * are for.
 */

import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

/** Node builtins that perform an effect. `node:crypto` is deliberately absent — a
 *  digest is deterministic, which is the sense of "pure" that matters here. */
const EFFECTFUL_BUILTINS = [
  "fs", "fs/promises", "child_process", "net", "tls", "http", "https", "http2",
  "dns", "dgram", "cluster", "worker_threads", "readline", "repl", "inspector",
  "perf_hooks", "v8", "vm", "os", "process",
];

const isBuiltin = (spec, name) =>
  spec === name || spec === `node:${name}`;

/**
 * Each rule owns a directory and lists what files under it may not import.
 * `exempt` names files the rule deliberately does not apply to, each with a
 * reason — an unexplained exemption is how a rule quietly stops meaning anything.
 */
const RULES = [
  {
    layer: "core",
    dir: "core/src",
    forbid: [
      { test: (s) => EFFECTFUL_BUILTINS.some((b) => isBuiltin(s, b)),
        why: "Core is pure — no I/O, clock, or ambient state (ADR-0005). node:crypto is the one allowed builtin." },
      { test: (s) => /(^|\/)(application|adapters|shells)\//.test(s),
        why: "Core may not depend on the layers above it (ADR-0001)." },
    ],
    exempt: {},
  },
  {
    layer: "application",
    dir: "application/src",
    forbid: [
      { test: (s) => /(^|\/)adapters\//.test(s),
        why: "The Application depends on the port, never on a concrete adapter. Naming one is the composition root's job." },
      { test: (s) => /(^|\/)shells\//.test(s),
        why: "The Application may not depend on a Shell." },
    ],
    exempt: {},
  },
  {
    layer: "adapters",
    dir: "adapters",
    forbid: [
      { test: (s) => /(^|\/)(core|application|shells)\//.test(s),
        why: "An adapter implements a contract and knows nothing else about the system." },
    ],
    exempt: {},
  },
  {
    layer: "shells",
    dir: "shells",
    forbid: [
      { test: (s) => /(^|\/)adapters\//.test(s),
        why: "Shells call the Application protocol; only the composition root names a concrete adapter (ADR-0006)." },
      { test: (s) => /(^|\/)core\//.test(s),
        why: "Shells call the Application protocol, not Core directly (ADR-0001, amended by ADR-0005)." },
    ],
    exempt: {
      "shells/cli/src/composition-root.ts":
        "The composition root exists to name concrete adapters. That is its whole job; it contains wiring and no logic.",
    },
  },
  {
    layer: "contracts",
    dir: "contracts",
    forbid: [
      { test: (s) => /(^|\/)(core|application|adapters|shells)\//.test(s),
        why: "Contracts are the base of the dependency graph and depend on nothing in it." },
    ],
    exempt: {},
  },
];

/** Cross-shell imports are their own rule: shells/<a> may not import shells/<b>. */
function crossShell(file, spec) {
  const m = file.match(/^shells[\\/]([^\\/]+)[\\/]/);
  if (!m) return null;
  const other = spec.match(/shells\/([^/]+)\//);
  if (other && other[1] !== m[1]) {
    return `Shell "${m[1]}" imports shell "${other[1]}". Cross-shell reuse goes through a shared presentation package (ADR-0006).`;
  }
  return null;
}

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(join(ROOT, dir)); } catch { return out; }
  for (const e of entries) {
    const rel = `${dir}/${e}`;
    const abs = join(ROOT, rel);
    if (statSync(abs).isDirectory()) {
      if (e === "node_modules" || e === "test") continue;
      walk(rel, out);
    } else if (e.endsWith(".ts") || e.endsWith(".mjs") || e.endsWith(".js")) {
      out.push(rel);
    }
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

function specifiers(source) {
  const out = [];
  for (const m of source.matchAll(IMPORT_RE)) out.push(m[1] ?? m[2] ?? m[3]);
  return out.filter(Boolean);
}

const violations = [];
let filesChecked = 0;
let importsChecked = 0;

for (const rule of RULES) {
  for (const file of walk(rule.dir)) {
    const norm = file.split(sep).join("/");
    filesChecked++;
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const spec of specifiers(source)) {
      importsChecked++;
      const cross = crossShell(norm, spec);
      if (cross) violations.push({ file: norm, spec, why: cross });
      for (const f of rule.forbid) {
        if (!f.test(spec)) continue;
        const reason = rule.exempt[norm];
        if (reason) continue;
        violations.push({ file: norm, spec, why: f.why });
      }
    }
  }
}

const exemptions = RULES.flatMap((r) => Object.entries(r.exempt));

if (violations.length === 0) {
  console.log(`lint:boundaries — OK. ${filesChecked} files, ${importsChecked} imports, 0 violations.`);
  if (exemptions.length) {
    console.log(`  ${exemptions.length} recorded exemption(s):`);
    for (const [f, why] of exemptions) console.log(`    ${f}\n      ${why}`);
  }
  process.exit(0);
}

console.error(`lint:boundaries — ${violations.length} violation(s):\n`);
for (const v of violations) {
  console.error(`  ${v.file}`);
  console.error(`    imports "${v.spec}"`);
  console.error(`    ${v.why}\n`);
}
process.exit(1);
