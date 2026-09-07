#!/usr/bin/env tsx
/**
 * Refuse a new function-typed parameter member reaching an exported Core function.
 *
 * ## Why this exists
 *
 * `core/src/release/promote.ts` once accepted `resolvedRefs` as a `(ref: string) => boolean`
 * callback — the only one Core ever took. It passed both purity guards: `check-boundaries.mjs`
 * reads imports, and `core/test/purity.setup.ts` traps globals; neither can see a function
 * arriving as an ordinary parameter. #151 fixed that one instance by turning the callback into
 * data (the caller now resolves refs and hands over the answer). Nothing stops a second one
 * from being added the same way, by hand, with no guard noticing.
 *
 * ## Why this is not "reject every function-typed member in core/src"
 *
 * `core/src/stages/pipeline.ts`'s `PipelineStage` union has `decide`, `reduce`, `run`,
 * `shouldSkip`, and `reduceSkipped` — all function-typed — and `decideGateFeedback` takes
 * `plan: readonly PipelineStage[]` as a parameter. That is not a caller-supplied callback: the
 * only values of that shape anywhere are the `PIPELINE` array literal in the same file, built
 * by Core, for Core. A checker that flagged every function-typed member would fail on this
 * legitimate internal registry pattern the day it was written.
 *
 * The actual distinguishing fact: does `core/src` ever CONSTRUCT a value of the parameter's
 * shape itself? If some object literal under `core/src` assigns a real function to a property
 * of the same name, that name is Core's own vocabulary — a registry entry, not a hook for an
 * outside effect. If nothing in `core/src` ever builds one, the only way a value can reach that
 * parameter is a caller constructing it — which is exactly the shape `resolvedRefs` was before
 * #151, and exactly the shape ADR-0005 says belongs in the Application layer instead.
 *
 * This is necessarily a heuristic, not a proof: a same-named property built for an unrelated
 * reason would exempt a genuinely new callback that happens to share a name. It catches the
 * shape that has actually occurred here, and does not require React or a build step the way a
 * full structural-assignability check across every parameter type would.
 *
 * A bare callback PARAMETER (not nested in an object) is deliberately never flagged, even
 * though it looks like the more obvious version of the same risk: `core/src/eval/generator.ts`'s
 * `generate(rand: () => number)` and `pick(rand, xs)` take the RNG itself as a parameter, which
 * is how Core avoids calling `Math.random()` while staying deterministic and testable. What
 * this checker targets is a function-typed MEMBER of an object parameter — the `resolvedRefs`
 * shape — not a parameter that is itself a function.
 *
 * ## Finding exports through the type checker, not by pattern-matching syntax
 *
 * An earlier version matched two AST shapes directly — `export function foo(...)` and
 * `export const foo = (...) => ...` — which made `export { foo }` (already used idiomatically
 * in `core/src/stages/compile.ts` for `DEMO_MARKER`) and any class method invisible: a function
 * re-exported that way, or a callback hidden as `class Foo { method(cb) {} }`, produced zero
 * violations regardless of what its parameters carried. `checker.getExportsOfModule` asks what
 * a module actually exports rather than which syntax produced it, which closes both gaps at
 * once and needs no third pattern the next syntax shape would require.
 *
 * ## Two more shapes the export-driven rewrite still missed
 *
 * Fixing the discovery mechanism did not fix everything reachable through it. Two more
 * fixture-verified gaps, both closed here:
 *
 * - A **setter** (`set opts(value: { onDone: (ref: string) => boolean }) {}`) was invisible:
 *   the member loop asked `getSignaturesOfType(memberType, Call)`, where `memberType` for an
 *   accessor is the VALUE'S type, not a function type, so it never has a call signature and the
 *   check silently passed. A setter's parameter is exactly a caller-supplied value — the same
 *   shape as a function parameter — so it is now checked the same way `functionMembersOf`
 *   checks a parameter, not via call-signature detection. A getter's return type is
 *   deliberately left unchecked, for the same reason function return types are: nothing a
 *   caller supplies flows out through a return value.
 * - An **exported plain object with methods** (`export const registry = { run(cb) {} }`, the
 *   "shared registry" pattern `core/src/stages/pipeline.ts`'s own internal use of object
 *   literals shows is idiomatic here) was invisible: the export loop only descended into a
 *   value's members when the value ITSELF was callable or a class. An object literal is
 *   neither, so its methods' parameters were never reached. The export loop now inspects any
 *   project-declared exported value's own members for a callable method or a setter,
 *   independent of whether the exported value itself is callable.
 *
 * Exit 0 no new callback-shaped parameter reaches Core · 1 one does.
 */

import ts from "typescript";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export interface Violation {
  file: string;
  functionName: string;
  paramName: string;
  memberName: string;
  detail: string;
}

export interface CheckResult {
  ok: boolean;
  violations: Violation[];
  filesChecked: number;
  functionsChecked: number;
}

export interface CheckCoreCallbacksOptions {
  root?: string;
}

function collectCoreFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(join(root, dir));
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = `${dir}/${e}`;
      const abs = join(root, rel);
      if (statSync(abs).isDirectory()) {
        walk(rel);
        continue;
      }
      if (e.endsWith(".ts") && !e.endsWith(".test.ts")) out.push(rel);
    }
  };
  walk("core/src");
  return out;
}

/** Property names that some object literal under `core/src` assigns a real function to. */
function collectConstructedFunctionMembers(sourceFiles: readonly ts.SourceFile[]): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name)) {
          names.add(prop.name.text);
        } else if (ts.isPropertyAssignment(prop) && prop.name && ts.isIdentifier(prop.name)) {
          const init = prop.initializer;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) names.add(prop.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const sf of sourceFiles) visit(sf);
  return names;
}

function typeHasCallSignature(checker: ts.TypeChecker, type: ts.Type): boolean {
  const constituents = type.isUnion() ? type.types : [type];
  return constituents.some((t) => checker.getSignaturesOfType(t, ts.SignatureKind.Call).length > 0);
}

const PRIMITIVE_FLAGS =
  ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Void |
  ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Never |
  ts.TypeFlags.Unknown | ts.TypeFlags.Any;

/**
 * Is this a type the codebase actually declared — an interface, a type alias, or an inline
 * object-literal type — rather than a lib-declared shape like `Number`, `Date`, or `RegExp`?
 *
 * `getPropertiesOfType(number)` returns `Number.prototype`'s members (`toFixed`, `toString`,
 * ...), which are function-typed and would otherwise flag every numeric parameter in Core.
 * Those members are declared in `lib.es5.d.ts`, which ships inside the `typescript` package
 * under `node_modules` — checked directly rather than trusting the primitive type-flag alone,
 * since the same reasoning also excludes `Date`, `RegExp`, `Map`, and `Promise`.
 */
function isProjectType(type: ts.Type): boolean {
  if (type.flags & PRIMITIVE_FLAGS) return false;
  const symbol = type.getSymbol() ?? type.aliasSymbol;
  const decls = symbol?.getDeclarations() ?? [];
  if (decls.length === 0) return true; // anonymous type literal, declared inline in project code
  return decls.every((d) => !d.getSourceFile().fileName.includes("node_modules"));
}

/** Function-typed members reachable through unions and array/tuple element types. */
function functionMembersOf(
  checker: ts.TypeChecker,
  type: ts.Type,
  visited: Set<ts.Type>,
  report: (memberName: string) => void,
): void {
  if (visited.has(type) || !isProjectType(type)) return;
  visited.add(type);

  if (type.isUnion()) {
    for (const t of type.types) functionMembersOf(checker, t, visited, report);
    return;
  }
  const numIndex = checker.getIndexInfoOfType(type, ts.IndexKind.Number);
  if (numIndex) {
    functionMembersOf(checker, numIndex.type, visited, report);
    return;
  }
  for (const prop of checker.getPropertiesOfType(type)) {
    const propType = checker.getTypeOfSymbol(prop);
    if (typeHasCallSignature(checker, propType)) report(prop.name);
  }
}

/**
 * The whole check, as a pure function of a source tree on disk. `root` is injectable so a
 * test can point it at a fixture tree without touching the real `core/src`.
 */
export function checkCoreCallbacks(opts: CheckCoreCallbacksOptions = {}): CheckResult {
  const root = opts.root ?? process.cwd();
  const relFiles = collectCoreFiles(root);
  const files = relFiles.map((f) => join(root, f));

  if (files.length === 0) {
    return { ok: true, violations: [], filesChecked: 0, functionsChecked: 0 };
  }

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };

  const program = ts.createProgram(files, compilerOptions);
  const checker = program.getTypeChecker();
  // `program.getSourceFile(name)` takes the same string used to create the program, so this
  // survives `ts.SourceFile.fileName` being forward-slash-normalized on Windows while `files`
  // holds `path.join` output — comparing the two directly silently matched nothing.
  const sourceFiles = files
    .map((f) => program.getSourceFile(f))
    .filter((sf): sf is ts.SourceFile => !!sf);

  const constructed = collectConstructedFunctionMembers(sourceFiles);
  const violations: Violation[] = [];
  let functionsChecked = 0;
  let rel = "";

  const flagParameter = (fnName: string, paramName: string, memberName: string) => {
    if (constructed.has(memberName)) return;
    violations.push({
      file: rel,
      functionName: fnName,
      paramName,
      memberName,
      detail:
        `${rel}: exported "${fnName}" parameter "${paramName}" carries a function-typed member ` +
        `"${memberName}". No object literal anywhere in core/src assigns a real function to ` +
        `"${memberName}", so every value reaching this parameter must be constructed by a caller ` +
        `outside Core — an effect-shaped hole that reaches neither check-boundaries.mjs (reads ` +
        `imports) nor purity.setup.ts (traps globals). Core must not take a callback (ADR-0005); ` +
        `pass data the Application already computed.`,
    });
  };

  const checkSignatures = (fnName: string, signatures: readonly ts.Signature[]) => {
    for (const sig of signatures) {
      for (const param of sig.parameters) {
        const paramType = checker.getTypeOfSymbol(param);
        functionMembersOf(checker, paramType, new Set(), (memberName) => {
          flagParameter(fnName, param.name, memberName);
        });
      }
    }
  };

  /**
   * One property of a class or a plain object, checked whichever way its shape calls for.
   * A setter's parameter is a caller-supplied value in exactly the sense a function parameter
   * is, so it goes through `functionMembersOf` directly rather than call-signature detection
   * (its own type IS the value type, not a function type — `getSignaturesOfType` would never
   * find anything). A getter alone, or a method, is checked as a call whose parameters matter;
   * a getter's return type is left unchecked for the same reason a function's return type is.
   * Returns whether this member was actually examined, so the caller can count it.
   */
  const checkMember = (labelPrefix: string, member: ts.Symbol): boolean => {
    const memberType = checker.getTypeOfSymbol(member);
    if (member.flags & ts.SymbolFlags.SetAccessor) {
      functionMembersOf(checker, memberType, new Set(), (memberName) => {
        flagParameter(`${labelPrefix}.${member.name} (setter)`, "value", memberName);
      });
      return true;
    }
    const signatures = checker.getSignaturesOfType(memberType, ts.SignatureKind.Call);
    if (signatures.length === 0) return false;
    checkSignatures(`${labelPrefix}.${member.name}`, signatures);
    return true;
  };

  /**
   * A class's constructor and every instance/static method, each checked the same way an
   * exported function is. `export { Foo }` and `class Foo { method(cb: () => void) {} }` were
   * both invisible to an earlier version of this checker that pattern-matched specific
   * declaration shapes (`export function`, `export const = () => ...`) instead of asking the
   * checker what a module actually exports.
   */
  const checkClass = (className: string, classSymbol: ts.Symbol) => {
    const staticType = checker.getTypeOfSymbol(classSymbol);
    checkSignatures(`${className} constructor`, checker.getSignaturesOfType(staticType, ts.SignatureKind.Construct));

    const instanceType = checker.getDeclaredTypeOfSymbol(classSymbol);
    for (const member of instanceType.getProperties()) checkMember(className, member);
    for (const member of staticType.getProperties()) {
      if (member.name === "prototype") continue;
      checkMember(`${className} (static)`, member);
    }
  };

  for (const sf of sourceFiles) {
    rel = relative(root, sf.fileName).split(sep).join("/");
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) continue;

    for (const exp of checker.getExportsOfModule(moduleSymbol)) {
      const resolved = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
      // A pure type/interface export (no value) has nothing a caller could hand a callback
      // through at runtime — there is no parameter to check.
      if (!resolved.valueDeclaration) continue;

      if (resolved.flags & ts.SymbolFlags.Class) {
        functionsChecked++;
        checkClass(exp.name, resolved);
        continue;
      }

      const type = checker.getTypeOfSymbol(resolved);
      let checked = false;

      const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
      if (signatures.length > 0) {
        checkSignatures(exp.name, signatures);
        checked = true;
      }

      // The exported value's OWN members, independent of whether the value itself is
      // callable — an object literal with methods (`export const registry = { run(cb) {} }`)
      // is not callable, so the check above alone would never reach `run`'s parameters.
      if (isProjectType(type)) {
        for (const member of checker.getPropertiesOfType(type)) {
          if (checkMember(exp.name, member)) checked = true;
        }
      }

      if (checked) functionsChecked++;
    }
  }

  return { ok: violations.length === 0, violations, filesChecked: files.length, functionsChecked };
}

function main(): void {
  const result = checkCoreCallbacks();

  if (result.ok) {
    console.log(
      `check:core-callbacks — OK. ${result.filesChecked} file(s), ${result.functionsChecked} ` +
      `exported function(s), 0 caller-supplied callback(s).`,
    );
    process.exit(0);
  }

  console.error(`check:core-callbacks — ${result.violations.length} problem(s):\n`);
  for (const v of result.violations) console.error(`  - ${v.detail}\n`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
