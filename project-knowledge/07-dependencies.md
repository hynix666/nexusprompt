# Dependencies

**Eight dev dependencies. Zero runtime dependencies below the Shell layer.** `contracts`,
`core`, `application`, the adapters and `shells/cli` ship nothing in `dependencies`.
`shells/api` ships two — `fastify` and `@fastify/sensible` — which ADR-0012 records.
The property that mattered is intact: nothing that computes a verdict, a score or a
revision imports outside the standard library, so every gate, the oracle and the anchor
stay reproducible from source with no registry involved. What gained dependencies is an
HTTP transport, the one place writing your own is the worse engineering.

Historically: nothing shipped in `dependencies` at all — the
CLI runs from source via `tsx`, and Core is pure TypeScript with no imports outside `node:`
builtins (and not even those — the boundary checker forbids them there).

```json
"devDependencies": {
  "@types/node":   "^24.7.0",
  "ajv":           "^8.17.1",
  "ajv-formats":   "^3.0.1",
  "fast-check":    "^4.3.0",
  "libxml2-wasm":  "^0.7.1",
  "tsx":           "^4.23.12",
  "typescript":    "^5.9.3",
  "vitest":        "^3.2.4"
}
```

## Why each one is here

| Package | Why | Notes |
|---|---|---|
| **typescript** | The type system is the cheapest specification. `strict` + three extra flags | See `05-configuration-and-deployment.md` for the two deferred flags and their measured cost |
| **@types/node** | Node 24 builtins for the Application, adapters and scripts | Core does not use them — that is enforced |
| **vitest** | Test runner, five projects. Fast, ESM-native, project-scoped setup files | `purity.setup.ts` hooks the `core` project only |
| **tsx** | Runs `.ts` scripts directly — no build step for the CLI or the 8 TS checkers | Entry point for probes: `node_modules/tsx/dist/cli.mjs` |
| **ajv** + **ajv-formats** | Validates every produced value against its JSON Schema in `test/contract-conformance.test.ts` | **`ajv-formats` is not optional.** `format` is not a core JSON Schema assertion — without the plugin ajv silently ignores it and prints *"unknown format date-time ignored"*. Two schemas declared a constraint that validated nothing until it was registered |
| **fast-check** | Property tests for gates | Available; the requirement is a review convention, not enforced |
| **libxml2-wasm** | `check:xsd` validates the technique catalog against an XSD | WASM rather than a native binding — no compiler toolchain needed on any platform |

### `ajv-formats` interop note

It is CommonJS with a default export. Under `module: nodenext` the default import types as
the module namespace while the runtime interop hands back the callable — the types and the
execution disagree, and only the types are wrong. Fixed with **one cast at one call site**
rather than loosening the compiler for the repo:

```ts
const addFormats = addFormatsImport as unknown as (ajv: Ajv) => Ajv;
```

Surfaced only when `tsconfig.json` was widened to actually include `test/`.

## External tools (not npm)

| Tool | Used by | Required |
|---|---|---|
| **Python 3.12+** | `npm run differential` — shells out to `sources/v5/prompt_lint.py` | Yes, for `verify`. CI installs it explicitly because an oracle that silently skips is worse than none |
| **git** | everything | Yes |
| **gh** (GitHub CLI) | remote setup, CI inspection | Optional, developer-side only |

## Deliberately *not* dependencies

| Not used | Why |
|---|---|
| `onnxruntime-node` / `@xenova/transformers` | The local ONNX model cannot be driven as dropped (`genai_config.json` absent). Adding a ~200 MB native dependency for a model that would produce fluent garbage was refused — see `05-configuration-and-deployment.md` |
| Any HTTP framework | There is no server |
| Any ORM or database driver | There is no database. Storage is JSON files |
| `pnpm` | Not installed. The workspace is npm workspaces, though older documentation still says pnpm |
| A bundler | `tsx` runs source directly; nothing is published |
| A coverage tool | Coverage measures what executes, not whether the suite would fail if the code were wrong. Mutation probes answer the question that matters |

## Licence posture

**MIT** (`LICENSE`, `Copyright (c) 2026 hynix666`), declared on all eight workspace packages.

Scope stated explicitly in the README rather than left implied:

> MIT covers this repository's code, contracts, checks and documentation. It is **not** a
> relicensing of anything inherited. `sources/` holds frozen copies of prior artifacts, and
> the research corpus under `PDF/` is third-party papers whose canonical home is arXiv —
> gitignored and not distributed here precisely because it is not this project's to give away.

All eight npm dependencies are permissively licensed (MIT / Apache-2.0 / BSD family). None is
copyleft, and none ships in a distributed artifact regardless, since there is no runtime
dependency set.

## Supply-chain notes

- `npm ci` in CI, against a committed `package-lock.json`.
- The lockfile went stale once during the rename — `npm ls --workspaces` reported the old
  `@promptnexus/*` names as `extraneous`, and `npm ci` would have produced a broken tree.
  Regenerated with `npm install --package-lock-only`. **Renaming workspace packages requires
  regenerating the lockfile.**
- `esbuild`'s postinstall script is blocked locally by `allowScripts` and runs normally in CI.
