import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { checkMergeIntegrity } from "../scripts/check-merge-integrity.mjs";

/**
 * Offline tests for check-merge-integrity, using injected fetchImpl and git runner.
 *
 * The fixture covers all seven shapes from the design spec:
 *   1. Ordinary squash-merged PR → silent (must-not-fire half)
 *   2. #73-shaped: unreachable merge commit, all patches upstream → silent
 *   3. #93-shaped: unreachable merge commit, patches absent → finding
 *   4. Ledgered PR: absent patches, but explained by the ledger → explained
 *   5. Stale ledger: ledgered PR now reachable → stale_ledger
 *   6. Missing token → fatal exit 2
 *   7. Unfetchable head → unclassified (never silent)
 *
 * Each case doubles as a mutation proof: removing the stage 2 check causes case 2 to
 * move to findings; removing ledger subtraction causes case 4 to move to findings;
 * removing the token guard causes case 6 to exit 0; treating unfetchable heads as
 * landed causes case 7 to appear in silent.
 */

const temps: string[] = [];
const mkroot = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

const write = (root: string, rel: string, body: string) => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
};

// ── Fixture ─────────────────────────────────────────────────────────────────

const PR1 = { number: 1, title: "ordinary squash", merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: "sha1", base: { ref: "master" } };
const PR2 = { number: 2, title: "landed via base PR", merged_at: "2026-01-02T00:00:00Z", merge_commit_sha: "sha2", base: { ref: "restore-master-green" } };
const PR3 = { number: 3, title: "stranded merge", merged_at: "2026-01-03T00:00:00Z", merge_commit_sha: "sha3", base: { ref: "fix-counts" } };
const PR4 = { number: 4, title: "deliberate revert", merged_at: "2026-01-04T00:00:00Z", merge_commit_sha: "sha4", base: { ref: "master" } };
const PR5 = { number: 5, title: "previously reverted now restored", merged_at: "2026-01-05T00:00:00Z", merge_commit_sha: "sha5", base: { ref: "master" } };
const PR7 = { number: 7, title: "fork deleted", merged_at: "2026-01-07T00:00:00Z", merge_commit_sha: "sha7", base: { ref: "master" } };

const ALL_PRS = [PR1, PR2, PR3, PR4, PR5, PR7];

const ANCESTORS = new Set(["sha1", "sha5"]);
const FETCH_SUCCESS = new Set([2, 3, 4]);  // PR7 fails to fetch; PR1 and PR5 pass stage 1
const CHERRY_LINES: Map<number, string[]> = new Map([
  [2, ["- abc123 landed commit"]],                  // all -, landed via squash
  [3, ["+ def456 stranded commit"]],                // + present, genuinely absent
  [4, ["+ ghi789 reverted commit"]],                // + present, but in ledger
]);

type GitArgs = string[];
type GitResult = { status: number; stdout: string };

function makeGit(opts: {
  ancestors?: Set<string>;
  fetchSuccess?: Set<number>;
  cherryLines?: Map<number, string[]>;
} = {}): (args: GitArgs) => GitResult {
  const ancestors = opts.ancestors ?? ANCESTORS;
  const fetchSuccess = opts.fetchSuccess ?? FETCH_SUCCESS;
  const cherryLines = opts.cherryLines ?? CHERRY_LINES;

  return (args: GitArgs): GitResult => {
    if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
      return { status: 0, stdout: "false" };
    }
    if (args[0] === "remote" && args[1] === "get-url") {
      return { status: 0, stdout: "git@github.com:owner/repo.git" };
    }
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
      const sha = args[2];
      return { status: ancestors.has(sha) ? 0 : 1, stdout: "" };
    }
    if (args[0] === "fetch") {
      const match = args[2]?.match(/refs\/pull\/(\d+)\/head/);
      const n = match ? parseInt(match[1], 10) : -1;
      return { status: fetchSuccess.has(n) ? 0 : 1, stdout: "" };
    }
    if (args[0] === "cherry") {
      const match = args[2]?.match(/refs\/merge_check\/(\d+)/);
      const n = match ? parseInt(match[1], 10) : -1;
      const lines = cherryLines.get(n) ?? [];
      return { status: 0, stdout: lines.join("\n") };
    }
    return { status: 0, stdout: "" };
  };
}

function makeFetchImpl(prs: unknown[]): typeof fetch {
  return async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes("/pulls")) {
      return new Response(JSON.stringify(prs), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };
}

function makeRoot(ledgerEntries: unknown[] = []) {
  const root = mkroot("pnx-mi-");
  write(root, "scripts/merge-integrity-ledger.json", JSON.stringify({
    _comment: ["test ledger"],
    entries: ledgerEntries,
  }));
  return root;
}

const LEDGER_ENTRY_4 = { pr: 4, title: PR4.title, verdict: "deliberate", reason: "Reverted intentionally.", evidence: "sha4 absent by design" };
const LEDGER_ENTRY_5 = { pr: 5, title: PR5.title, verdict: "deliberate", reason: "Was reverted, now restored.", evidence: "sha5 was absent" };

// ── Tests ────────────────────────────────────────────────────────────────────

describe("checkMergeIntegrity", () => {
  it("case 6: missing token exits with fatalCode 2, not 0", async () => {
    const root = makeRoot();
    const r = await checkMergeIntegrity({ root, token: undefined, fetchImpl: makeFetchImpl(ALL_PRS), git: makeGit() });
    expect(r.fatalCode).toBe(2);
    expect(r.fatal).toMatch(/no auth token/);
    // must-not-fire: a missing token must never read as a clean report
    expect(r.checked).toBe(0);
  });

  it("case 1: ordinary squash-merged PR is silent", async () => {
    const root = makeRoot();
    const r = await checkMergeIntegrity({ root, token: "tok", fetchImpl: makeFetchImpl([PR1]), git: makeGit() });
    expect(r.fatalCode).toBeNull();
    expect(r.silent).toBe(1);
    expect(r.findings).toHaveLength(0);
  });

  it("case 2: #73-shaped PR (unreachable, all patches upstream) is silent, not a finding", async () => {
    // Mutation proof for stage 2: removing the git-cherry check would put PR2 in findings.
    const root = makeRoot();
    const r = await checkMergeIntegrity({ root, token: "tok", fetchImpl: makeFetchImpl([PR2]), git: makeGit() });
    expect(r.silent).toBe(1);
    expect(r.findings.map((f) => f.pr)).not.toContain(2);
  });

  it("case 3: #93-shaped PR (unreachable, patches absent) is a finding", async () => {
    const root = makeRoot();
    const r = await checkMergeIntegrity({ root, token: "tok", fetchImpl: makeFetchImpl([PR3]), git: makeGit() });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].pr).toBe(3);
    expect(r.findings[0].absent_commits).toContain("def456 stranded commit");
    expect(r.silent).toBe(0);
  });

  it("case 4: ledgered PR appears in explained, not findings", async () => {
    // Mutation proof for ledger subtraction: removing the ledger check puts PR4 in findings.
    const root = makeRoot([LEDGER_ENTRY_4]);
    const r = await checkMergeIntegrity({ root, token: "tok", fetchImpl: makeFetchImpl([PR4]), git: makeGit() });
    expect(r.explained.map((e) => e.pr)).toContain(4);
    expect(r.findings.map((f) => f.pr)).not.toContain(4);
  });

  it("case 5: ledger entry whose PR is now reachable appears in stale_ledger, run exits 0", async () => {
    const root = makeRoot([LEDGER_ENTRY_5]);
    const r = await checkMergeIntegrity({ root, token: "tok", fetchImpl: makeFetchImpl([PR5]), git: makeGit() });
    expect(r.stale_ledger.map((e) => e.pr)).toContain(5);
    expect(r.findings.map((f) => f.pr)).not.toContain(5);
    expect(r.fatalCode).toBeNull(); // exit 0, not 2
  });

  it("case 7: unfetchable head lands in unclassified, never silent", async () => {
    // Mutation proof: treating an unfetchable head as landed would move PR7 to silent.
    const root = makeRoot();
    const r = await checkMergeIntegrity({ root, token: "tok", fetchImpl: makeFetchImpl([PR7]), git: makeGit() });
    expect(r.unclassified.map((u) => u.pr)).toContain(7);
    expect(r.silent).toBe(0);
    expect(r.findings.map((f) => f.pr)).not.toContain(7);
  });

  it("all seven shapes together: counts reconcile", async () => {
    const root = makeRoot([LEDGER_ENTRY_4]);
    const r = await checkMergeIntegrity({
      root, token: "tok",
      fetchImpl: makeFetchImpl(ALL_PRS),
      git: makeGit(),
    });
    expect(r.fatalCode).toBeNull();
    // PR1: silent (stage 1 pass), PR2: silent (stage 2 all -), PR5: silent (stage 1 pass, no ledger)
    expect(r.silent).toBe(3);
    // PR3: finding
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].pr).toBe(3);
    // PR4: explained
    expect(r.explained).toHaveLength(1);
    expect(r.explained[0].pr).toBe(4);
    // PR7: unclassified
    expect(r.unclassified).toHaveLength(1);
    expect(r.unclassified[0].pr).toBe(7);
    // total: 3 silent + 1 finding + 1 explained + 1 unclassified = 6
    expect(r.checked).toBe(6);
  });

  it("shallow clone is detected and exits with fatalCode 2", async () => {
    const root = makeRoot();
    const git = makeGit();
    const shallowGit = (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") return { status: 0, stdout: "true" };
      return git(args);
    };
    const r = await checkMergeIntegrity({ root, token: "tok", fetchImpl: makeFetchImpl(ALL_PRS), git: shallowGit });
    expect(r.fatalCode).toBe(2);
    expect(r.fatal).toMatch(/shallow/);
  });

  it("API error returns fatalCode 2", async () => {
    const root = makeRoot();
    const errorFetch = async () => new Response("forbidden", { status: 403 });
    const r = await checkMergeIntegrity({ root, token: "tok", fetchImpl: errorFetch as typeof fetch, git: makeGit() });
    expect(r.fatalCode).toBe(2);
    expect(r.fatal).toMatch(/403/);
  });

  it("missing ledger file returns fatalCode 2", async () => {
    const root = mkroot("pnx-mi-noledger-");
    const r = await checkMergeIntegrity({ root, token: "tok", fetchImpl: makeFetchImpl([PR1]), git: makeGit() });
    expect(r.fatalCode).toBe(2);
    expect(r.fatal).toMatch(/merge-integrity-ledger\.json/);
  });

  it("PR with no merge_commit_sha goes to unclassified", async () => {
    const root = makeRoot();
    const pr = { number: 99, title: "ghost", merged_at: "2026-01-09T00:00:00Z", merge_commit_sha: null, base: { ref: "master" } };
    const r = await checkMergeIntegrity({ root, token: "tok", fetchImpl: makeFetchImpl([pr]), git: makeGit() });
    expect(r.unclassified.map((u) => u.pr)).toContain(99);
  });

  it("findings do not fail the run (ok stays true, fatalCode stays null)", async () => {
    const root = makeRoot();
    const r = await checkMergeIntegrity({ root, token: "tok", fetchImpl: makeFetchImpl([PR3]), git: makeGit() });
    expect(r.fatalCode).toBeNull();
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(1);
  });
});
