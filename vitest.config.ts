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
    ],
  },
});
