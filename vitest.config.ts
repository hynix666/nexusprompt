import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Core runs under the purity harness: any network, filesystem, clock, or
        // randomness call during a Core test fails the suite.
        test: {
          name: "core",
          include: ["core/test/**/*.test.ts"],
          setupFiles: ["core/test/purity.setup.ts"],
        },
      },
      {
        // No purity harness here — this layer is *supposed* to have effects.
        test: { name: "application", include: ["application/test/**/*.test.ts"] },
      },
      {
        // Adapters are impure by definition; their tests inject fakes instead.
        test: { name: "adapters", include: ["adapters/*/test/**/*.test.ts"] },
      },
      {
        // Shells drive the real CLI in a subprocess. Slow by construction — each case is a
        // process spawn plus a full pipeline run — and the only place wiring bugs are
        // visible: a composition root naming the wrong adapter, a flag that never reaches
        // the runner, an exit code that contradicts what happened.
        test: { name: "shells", include: ["shells/*/test/**/*.test.ts"], testTimeout: 120_000 },
      },
      {
        // Contract conformance sits above every layer: it drives the real
        // orchestrator, store, and provider adapter to produce values, then
        // validates them against the JSON Schemas. No purity harness — producing a
        // real value is the point.
        test: { name: "contracts", include: ["test/**/*.test.ts"] },
      },
    ],
  },
});
