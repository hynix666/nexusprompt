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

interface ExportedFn {
  name: string;
  parameters: readonly ts.ParameterDeclaration[];
}

/** `export function foo(...)`, `export const foo = (...) => ...`, `export const foo = function(...) {}`. */
function asExportedFunction(node: ts.Node): ExportedFn | null {
  const hasExportModifier = (n: ts.Node): boolean =>
    !!ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  if (ts.isFunctionDeclaration(node) && node.name && hasExportModifier(node)) {
    return { name: node.name.text, parameters: node.parameters };
  }
  if (ts.isVariableStatement(node) && hasExportModifier(node)) {
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const init = decl.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        return { name: decl.name.text, parameters: init.parameters };
      }
    }
  }
  return null;
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

  for (const sf of sourceFiles) {
    const rel = relative(root, sf.fileName).split(sep).join("/");

    const visit = (node: ts.Node) => {
      const fn = asExportedFunction(node);
      if (fn) {
        functionsChecked++;
        for (const param of fn.parameters) {
          const paramName = ts.isIdentifier(param.name) ? param.name.text : "<destructured>";
          const type = checker.getTypeAtLocation(param);
          const seen = new Set<ts.Type>();
          functionMembersOf(checker, type, seen, (memberName) => {
            if (constructed.has(memberName)) return;
            violations.push({
              file: rel,
              functionName: fn.name,
              paramName,
              memberName,
              detail:
                `${rel}: exported function "${fn.name}" parameter "${paramName}" carries a ` +
                `function-typed member "${memberName}". No object literal anywhere in core/src ` +
                `assigns a real function to "${memberName}", so every value reaching this parameter ` +
                `must be constructed by a caller outside Core — an effect-shaped hole that reaches ` +
                `neither check-boundaries.mjs (reads imports) nor purity.setup.ts (traps globals). ` +
                `Core must not take a callback (ADR-0005); pass data the Application already computed.`,
            });
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
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
