import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../scripts/doctor.js";

/**
 * `npm run doctor` — the first command a new contributor runs.
 *
 * Every check derives its expectation from the repository rather than restating it, so the
 * tests here are mostly must-FIRE cases: a check that cannot be made to fail is decoration,
 * and this command's whole value is that a green line means something.
 *
 * The failure cases are induced on planted roots. Other checks fail there too — a temp
 * directory has no frozen sources — so each case asserts the ONE finding it induced, by name.
 * Asserting the overall code would pass for the wrong reason.
 */

const temps: string[] = [];
afterEach(() => { while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true }); });

const mkroot = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pnx-doctor-"));
  temps.push(d);
  return d;
};

const findingIn = (root: string, name: string) => {
  const f = doctor(root).findings.find((x) => x.name === name);
  expect(f, `no finding named ${name}`).toBeDefined();
  return f!;
};

/** A root carrying only what one check reads. */
function plant(files: Record<string, string>): string {
  const root = mkroot();
  for (const [p, body] of Object.entries(files)) {
    const dir = join(root, p, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

describe("doctor — against this repository", () => {
  it("reports the offline system as usable", () => {
    // The must-not-fire half, and the one that matters: a fresh clone after `npm ci` must
    // reach exit 0. A doctor that cried wolf about a healthy checkout would be ignored.
    const { code, findings } = doctor(process.cwd());
    const failed = findings.filter((f) => f.status === "fail");
    expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
    expect(code).toBe(0);
  }, 30_000);

  it("treats a missing API key as a warning, never a failure", () => {
    // Without a key every run degrades to a labelled placeholder and says so. Reporting the
    // honesty guarantee as a fault is how a diagnostic teaches people to ignore it.
    const before = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const f = findingIn(process.cwd(), "live provider");
      expect(f.status).toBe("warn");
      expect(f.detail).toContain("degrades");
    } finally {
      if (before !== undefined) process.env.ANTHROPIC_API_KEY = before;
    }
  }, 30_000);

  it("derives the CLI's commands from the CLI", () => {
    // Not a list kept here. `gates` and `evidence` exist; if a command is added tomorrow this
    // picks it up, and if the CLI stops printing usage this fails rather than reporting stale.
    const f = findingIn(process.cwd(), "cli");
    expect(f.status).toBe("ok");
    for (const cmd of ["lint", "run", "pipeline", "gates", "evidence"]) {
      expect(f.detail, cmd).toContain(cmd);
    }
  }, 30_000);
});

describe("doctor — must fire", () => {
  it("catches a workspace on disk that is missing from the lockfile", () => {
    /**
     * The defect this check exists for, reproduced.
     *
     * `adapters/content-local` was added and the lockfile was not regenerated. `npm install`
     * repaired it silently; `npm ci` refused. So the tree was green locally and red in CI,
     * with an error naming neither the workspace nor the cause.
     */
    const root = plant({
      "package.json": JSON.stringify({ workspaces: ["adapters/*"] }),
      "package-lock.json": JSON.stringify({ packages: { "": {} } }),
      "adapters/brand-new/package.json": "{}",
    });
    const f = findingIn(root, "lockfile");
    expect(f.status).toBe("fail");
    expect(f.detail).toContain("adapters/brand-new");
    expect(f.note).toContain("npm ci");
  });

  it("passes when every workspace IS in the lockfile — the must-not-fire half", () => {
    // A check that fires on everything gets deleted by whoever it inconveniences first.
    const root = plant({
      "package.json": JSON.stringify({ workspaces: ["adapters/*"] }),
      "package-lock.json": JSON.stringify({ packages: { "": {}, "adapters/brand-new": {} } }),
      "adapters/brand-new/package.json": "{}",
    });
    expect(findingIn(root, "lockfile").status).toBe("ok");
  });

  it("catches a pnpm lockfile", () => {
    // pnpm is not installed and the workspace is defined with npm workspaces, but much of the
    // documentation still says pnpm — so this is a mistake someone will make by following it.
    const root = plant({
      "package.json": JSON.stringify({}),
      "package-lock.json": JSON.stringify({ packages: {} }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    const f = findingIn(root, "package manager");
    expect(f.status).toBe("fail");
    expect(f.detail).toContain("pnpm-lock.yaml");
  });

  it("catches dependencies that are not installed", () => {
    const root = plant({
      "package.json": JSON.stringify({ devDependencies: { typescript: "*", vitest: "*" } }),
      "package-lock.json": JSON.stringify({ packages: {} }),
    });
    const f = findingIn(root, "dependencies");
    expect(f.status).toBe("fail");
    expect(f.detail).toContain("typescript");
  });

  it("catches a Node older than the one CI uses", () => {
    // Derived from the workflow, not pinned here. Local green under an older major is not
    // evidence about CI, which is the whole reason the version is worth checking.
    const root = plant({
      "package.json": JSON.stringify({}),
      ".github/workflows/verify.yml": "jobs:\n  verify:\n    steps:\n      - with:\n          node-version: '99'\n",
    });
    const f = findingIn(root, "node");
    expect(f.status).toBe("fail");
    expect(f.note).toContain("99");
  });

  it("reports an unreadable CI workflow as unknown, not as agreement", () => {
    // Absence of evidence recorded as absence — the same rule the fingerprint watch applies.
    const root = plant({ "package.json": JSON.stringify({}) });
    expect(findingIn(root, "node").status).toBe("warn");
  });

  it("catches a corrupted frozen source tree", () => {
    const root = mkroot();
    cpSync(join(process.cwd(), "sources"), join(root, "sources"), { recursive: true });
    writeFileSync(join(root, "sources/v5/prompt_lint.py"), "# tampered\n");
    const f = findingIn(root, "frozen sources");
    expect(f.status).toBe("fail");
    // Regenerating the manifest is the tempting fix and the wrong one.
    expect(f.note).toContain("Restore it rather than regenerating");
  }, 30_000);
});

describe("doctor — the key", () => {
  it("never prints the value, on any of the three paths", () => {
    const fake = `sk-ant-api03-NOT-A-REAL-KEY-doctor-test-${"x".repeat(40)}`;
    const before = process.env.ANTHROPIC_API_KEY;
    try {
      for (const key of [fake, "<your key>", "sk-ant-tooshort"]) {
        process.env.ANTHROPIC_API_KEY = key;
        const f = findingIn(process.cwd(), "live provider");
        const printed = `${f.detail} ${f.note ?? ""}`;
        expect(printed, key.slice(0, 12)).not.toContain(key);
      }
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  }, 30_000);

  it("names the refusal a live run would actually hit", () => {
    // "Is a key set?" is nearly useless: three of the four ways a live run refuses are not
    // about presence. This asks `preflight` — the function that does the refusing — so the
    // answer cannot drift from what the operator will see.
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = `sk-ant-api03-NOT-A-REAL-KEY-${"x".repeat(40)}`;
    try {
      const f = findingIn(process.cwd(), "live provider");
      expect(f.status).toBe("ok");
      expect(f.note).toContain("budget_undeclared");
      expect(f.note).toContain("--dry-run");
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  }, 30_000);
});
