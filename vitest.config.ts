import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
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
    ],
  },
});
