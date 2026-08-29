import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileArg, flagValue, VALUE_FLAGS, OPTIONAL_NUMERIC_FLAGS } from "../src/index.js";

/**
 * Argument parsing, as a unit, plus the check that keeps its one hand-written list honest.
 *
 * `fileArg` replaced three different rules that disagreed with each other: `lint` read
 * `argv[1]` unconditionally and handed `--foo` to `readFile`, `pipeline` refused any argv[1]
 * beginning with `--` and printed usage instead of running, and `run` scanned for the first
 * non-flag while consulting a skip-list that named only its own flag. The same invocation
 * shape could therefore work, print usage, or die on ENOENT depending on the command word.
 *
 * `shells/cli/test/pipeline-command.test.ts` drives the real CLI in a subprocess and is where
 * the end-to-end behaviour is asserted. This file is the fast half: every branch of the
 * scanner, and the drift guard.
 */

const SRC = join(process.cwd(), "shells/cli/src/index.ts");

describe("fileArg", () => {
  it("finds a bare filename", () => {
    expect(fileArg(["lint", "brief.txt"])).toBe("brief.txt");
  });

  it("finds a filename AFTER a flag and its value — the pipeline bug", () => {
    // `pipeline --stakes HIGH brief.txt` used to exit 2 with the usage block.
    expect(fileArg(["pipeline", "--stakes", "HIGH", "brief.txt"])).toBe("brief.txt");
    expect(fileArg(["run", "--stage", "compile", "brief.txt"])).toBe("brief.txt");
  });

  it("finds a filename BEFORE flags", () => {
    expect(fileArg(["pipeline", "brief.txt", "--stakes", "HIGH"])).toBe("brief.txt");
  });

  it("never mistakes a flag for a filename — the lint bug", () => {
    // `lint --foo` used to reach readFile and die on ENOENT against a path named `--foo`.
    expect(fileArg(["lint", "--foo"])).toBeUndefined();
    expect(fileArg(["lint", "-f"])).toBeUndefined();
  });

  it("never mistakes a flag's VALUE for a filename — the run bug", () => {
    // `run --stage compile` with no file used to resolve the file as "compile".
    expect(fileArg(["run", "--stage", "compile"])).toBeUndefined();
    expect(fileArg(["pipeline", "--stakes", "HIGH"])).toBeUndefined();
  });

  it("returns undefined when there is nothing to find", () => {
    expect(fileArg(["run"])).toBeUndefined();
    expect(fileArg([])).toBeUndefined();
  });

  it("handles a value flag with no value at the end of argv", () => {
    // `i++` past the end must terminate rather than loop or throw.
    expect(fileArg(["run", "--stage"])).toBeUndefined();
  });

  it("treats `--flag=value` as one flag, so the file after it is still found", () => {
    expect(fileArg(["run", "--stage=compile", "brief.txt"])).toBe("brief.txt");
  });

  it("takes --reflexive's value only when it is a number", () => {
    // The flag is optional-valued: bare means one round. Consuming unconditionally would eat
    // the filename; never consuming would resolve the file as "3".
    expect(fileArg(["pipeline", "--reflexive", "brief.txt"])).toBe("brief.txt");
    expect(fileArg(["pipeline", "--reflexive", "3", "brief.txt"])).toBe("brief.txt");
    expect(fileArg(["pipeline", "--reflexive", "3"])).toBeUndefined();
  });

  it("takes the FIRST candidate when several could match", () => {
    expect(fileArg(["pipeline", "a.txt", "b.txt"])).toBe("a.txt");
  });
});

describe("flagValue", () => {
  it("reads the entry after the flag, or undefined", () => {
    expect(flagValue(["pipeline", "--stakes", "HIGH"], "--stakes")).toBe("HIGH");
    expect(flagValue(["pipeline", "brief.txt"], "--stakes")).toBeUndefined();
    expect(flagValue(["pipeline", "--stakes"], "--stakes")).toBeUndefined();
  });
});

describe("the value-flag list does not drift from the flags the code reads", () => {
  /**
   * The one thing `fileArg` cannot derive: only the code reading a flag knows whether it takes
   * a value. So the list is declared, and held to the source here.
   *
   * Without this, adding `--depth STANDARD` to a command and forgetting the list makes
   * `STANDARD` parse as the filename — the same confusing ENOENT the parser exists to prevent,
   * reintroduced by omission. It is the failure `check:hygiene`'s hand-picked sentinel list
   * produced one layer up, so it gets the same treatment: derive what can be derived, and put
   * a checker on what cannot.
   */
  const flagsRead = (): string[] => {
    // Comments are stripped first. The reader is about what the code READS, and the first
    // version matched a `flagValue(argv, "--x")` written inside a doc comment explaining the
    // list — an instrument reporting on its own documentation.
    const src = readFileSync(SRC, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    return [
      // flagValue(argv, "--x")
      ...[...src.matchAll(/flagValue\(\s*argv\s*,\s*"(--[\w-]+)"/g)].map((m) => m[1] as string),
      // the local `flag("x")` wrapper inside cmdPipeline, which prepends `--`
      ...[...src.matchAll(/\bflag\("([\w-]+)"\)/g)].map((m) => `--${m[1] as string}`),
    ];
  };

  it("the reader finds the flags — otherwise the check below is vacuous", () => {
    const found = new Set(flagsRead());
    expect(found.size).toBeGreaterThan(3);
    // Named explicitly: a regex that silently stopped matching would make every flag "declared".
    for (const expected of ["--stakes", "--depth", "--test", "--max-calls", "--stage"]) {
      expect([...found], `reader missed ${expected}`).toContain(expected);
    }
  });

  it("every flag the code reads a value from is declared as value-taking", () => {
    const declared = new Set([...VALUE_FLAGS, ...OPTIONAL_NUMERIC_FLAGS]);
    expect(flagsRead().filter((f) => !declared.has(f))).toEqual([]);
  });

  it("catches a flag that is read but not declared", () => {
    // The planted defect, in the shape it would really arrive: a new value-taking flag added
    // to a command while this list is left alone.
    const declared = new Set([...VALUE_FLAGS, ...OPTIONAL_NUMERIC_FLAGS]);
    expect(declared.has("--retries")).toBe(false);
    expect(["--stakes", "--retries"].filter((f) => !declared.has(f))).toEqual(["--retries"]);
  });

  it("no flag is declared in both sets — the two branches are exclusive", () => {
    expect([...VALUE_FLAGS].filter((f) => OPTIONAL_NUMERIC_FLAGS.has(f))).toEqual([]);
  });
});
